package youtube

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// BatchItem is one successfully packed video inside a batch.
type BatchItem struct {
	VideoID         string     `json:"videoId"`
	Title           string     `json:"title"`
	URL             string     `json:"url"`
	DurationSeconds int        `json:"durationSeconds"`
	Language        string     `json:"language,omitempty"`
	ChunkCount      int        `json:"chunkCount"`
	Chunks          []RAGChunk `json:"chunks,omitempty"`
	CacheHit        bool       `json:"cacheHit,omitempty"`
}

// BatchFailure explains why one video could not be packed. Batches keep going
// so a single captions-disabled video never fails the whole job.
type BatchFailure struct {
	VideoID   string `json:"videoId"`
	Title     string `json:"title,omitempty"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// BatchPack is a citation-ready briefing for a playlist, channel, or explicit
// list of videos. Cursor/NextCursor let an agent walk long sources in slices
// without re-fetching what it already has.
type BatchPack struct {
	Source      string         `json:"source"` // playlist | channel | videos
	SourceID    string         `json:"sourceId,omitempty"`
	Title       string         `json:"title,omitempty"`
	TotalVideos int            `json:"totalVideos"`
	Cursor      int            `json:"cursor"`
	NextCursor  int            `json:"nextCursor,omitempty"`
	HasMore     bool           `json:"hasMore"`
	Videos      []BatchItem    `json:"videos"`
	Failures    []BatchFailure `json:"failures,omitempty"`
	TotalChunks int            `json:"totalChunks"`
	Markdown    string         `json:"markdown"`
	HowToCite   string         `json:"howToCite"`
}

// BatchOptions controls batch pack sizing and resume position.
type BatchOptions struct {
	Lang       string
	ChunkChars int
	// Videos processed in this call. Kept small by default because each video
	// costs several YouTube requests against the local rate budget.
	Limit int
	// Cursor is an index into the resolved source list (from NextCursor).
	Cursor int
	// IncludeChunks embeds full chunk text; disable for a cheap table of contents.
	IncludeChunks bool
	SkipSponsors  bool
}

type batchSource struct {
	kind  string
	id    string
	title string
	ids   []string
	names map[string]string
}

// resolveBatchSource turns a playlist URL, channel reference, or comma/space
// separated video list into an ordered set of video IDs.
func (c *Client) resolveBatchSource(ctx context.Context, input string, lookahead int) (*batchSource, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return nil, &ExtractError{Code: "USAGE", Message: "a playlist URL, channel reference, or video list is required"}
	}

	if ids, ok := explicitVideoList(input); ok {
		return &batchSource{kind: "videos", ids: ids, names: map[string]string{}}, nil
	}

	if listID, err := ParsePlaylistID(input); err == nil {
		result, err := c.Playlist(ctx, listID, lookahead)
		if err != nil {
			return nil, err
		}
		src := &batchSource{kind: "playlist", id: listID, names: map[string]string{}}
		src.title, _ = result["title"].(string)
		src.ids, src.names = collectVideoRefs(result["items"])
		return src, nil
	}

	if _, _, err := ParseChannelRef(input); err == nil {
		result, err := c.ChannelPreferAPI(ctx, input, lookahead)
		if err != nil {
			return nil, err
		}
		src := &batchSource{kind: "channel", names: map[string]string{}}
		src.id, _ = result["id"].(string)
		src.title, _ = result["title"].(string)
		src.ids, src.names = collectVideoRefs(result["videos"])
		return src, nil
	}

	return nil, &ExtractError{Code: "INVALID_BATCH_SOURCE",
		Message: "Expected a playlist URL/ID, a channel URL/@handle/UC id, or a comma-separated list of video IDs",
		Details: map[string]any{"input": input}}
}

// collectVideoRefs reads video ids/titles from playlist or channel results,
// which arrive as typed structs when fresh and as generic maps from the cache.
func collectVideoRefs(value any) ([]string, map[string]string) {
	ids := []string{}
	names := map[string]string{}
	seen := map[string]bool{}
	add := func(id, title string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		ids = append(ids, id)
		names[id] = title
	}
	switch items := value.(type) {
	case []PlaylistItem:
		for _, it := range items {
			add(it.ID, it.Title)
		}
	case []map[string]any:
		for _, it := range items {
			add(asString(it["id"]), asString(it["title"]))
		}
	case []any:
		for _, raw := range items {
			if m, ok := raw.(map[string]any); ok {
				add(asString(m["id"]), asString(m["title"]))
			}
		}
	}
	return ids, names
}

// explicitVideoList detects a comma/whitespace separated list of videos.
func explicitVideoList(input string) ([]string, bool) {
	fields := strings.FieldsFunc(input, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	})
	if len(fields) < 2 {
		return nil, false
	}
	ids := make([]string, 0, len(fields))
	for _, f := range fields {
		id, err := ParseVideoID(strings.TrimSpace(f))
		if err != nil {
			return nil, false
		}
		ids = append(ids, id)
	}
	return ids, true
}

// BatchPackFor builds packs for many videos at once, skipping and reporting the
// ones YouTube will not give us captions for.
func (c *Client) BatchPackFor(ctx context.Context, input string, opts BatchOptions) (*BatchPack, error) {
	if opts.Limit <= 0 {
		opts.Limit = 5
	}
	if opts.Limit > 25 {
		opts.Limit = 25
	}
	if opts.Cursor < 0 {
		opts.Cursor = 0
	}
	if opts.ChunkChars <= 0 {
		opts.ChunkChars = 800
	}

	src, err := c.resolveBatchSource(ctx, input, opts.Cursor+opts.Limit+25)
	if err != nil {
		return nil, err
	}
	if len(src.ids) == 0 {
		return nil, &ExtractError{Code: "EMPTY_BATCH_SOURCE",
			Message: "No videos were found for this playlist, channel, or list"}
	}

	pack := &BatchPack{
		Source: src.kind, SourceID: src.id, Title: src.title,
		TotalVideos: len(src.ids), Cursor: opts.Cursor,
		HowToCite: "Every chunk carries its own video citation and url; cite the video title plus [M:SS].",
	}

	index := opts.Cursor
	for index < len(src.ids) && len(pack.Videos) < opts.Limit {
		id := src.ids[index]
		index++

		videoPack, err := c.VideoPackWithOptions(ctx, id, PackOptions{
			Lang: opts.Lang, ChunkChars: opts.ChunkChars, SkipSponsors: opts.SkipSponsors,
		})
		if err != nil {
			pack.Failures = append(pack.Failures, batchFailure(id, src.names[id], err))
			// A budget or connectivity failure will hit every remaining video too.
			if isFatalBatchError(err) {
				break
			}
			continue
		}
		item := BatchItem{
			VideoID: videoPack.Video.ID, Title: videoPack.Video.Title, URL: videoPack.Video.URL,
			DurationSeconds: videoPack.Video.DurationSeconds, Language: videoPack.Language,
			ChunkCount: videoPack.ChunkCount, CacheHit: videoPack.CacheHit,
		}
		if opts.IncludeChunks {
			item.Chunks = videoPack.Chunks
		}
		pack.TotalChunks += videoPack.ChunkCount
		pack.Videos = append(pack.Videos, item)
	}

	pack.HasMore = index < len(src.ids)
	if pack.HasMore {
		pack.NextCursor = index
	}
	pack.Markdown = renderBatchMarkdown(pack)
	if len(pack.Videos) == 0 && len(pack.Failures) > 0 {
		first := pack.Failures[0]
		return nil, &ExtractError{Code: first.Code, Retryable: first.Retryable,
			Message: "No videos in this batch could be packed: " + first.Message,
			Details: map[string]any{"failures": pack.Failures}}
	}
	return pack, nil
}

func batchFailure(id, title string, err error) BatchFailure {
	var ee *ExtractError
	if errors.As(err, &ee) {
		return BatchFailure{VideoID: id, Title: title, Code: ee.Code, Message: ee.Message, Retryable: ee.Retryable}
	}
	return BatchFailure{VideoID: id, Title: title, Code: "INTERNAL_ERROR", Message: err.Error()}
}

func isFatalBatchError(err error) bool {
	var ee *ExtractError
	if !errors.As(err, &ee) {
		return false
	}
	switch ee.Code {
	case "RATE_BUDGET_EXCEEDED", "RATE_LIMITED", "NETWORK_ERROR", "TIMEOUT", "ACCESS_DENIED":
		return true
	default:
		return false
	}
}

func renderBatchMarkdown(pack *BatchPack) string {
	var b strings.Builder
	title := pack.Title
	if title == "" {
		title = "YouTube batch pack"
	}
	fmt.Fprintf(&b, "# %s\n\n", title)
	fmt.Fprintf(&b, "- Source: %s\n", pack.Source)
	if pack.SourceID != "" {
		fmt.Fprintf(&b, "- Source ID: %s\n", pack.SourceID)
	}
	fmt.Fprintf(&b, "- Videos packed: %d of %d\n", len(pack.Videos), pack.TotalVideos)
	fmt.Fprintf(&b, "- Chunks: %d\n", pack.TotalChunks)
	if pack.HasMore {
		fmt.Fprintf(&b, "- Resume with cursor: %d\n", pack.NextCursor)
	}
	b.WriteString("\n## Videos\n\n")
	for _, v := range pack.Videos {
		fmt.Fprintf(&b, "- [%s] %s (%s, %d chunks)\n",
			FormatTimestamp(float64(v.DurationSeconds)), v.Title, v.URL, v.ChunkCount)
	}
	if len(pack.Failures) > 0 {
		b.WriteString("\n## Skipped\n\n")
		for _, f := range pack.Failures {
			fmt.Fprintf(&b, "- %s: %s (%s)\n", f.VideoID, f.Code, f.Message)
		}
	}
	for _, v := range pack.Videos {
		if len(v.Chunks) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n## %s\n\n", v.Title)
		for _, ch := range v.Chunks {
			fmt.Fprintf(&b, "### %s\n\n%s\n\n", ch.Citation, ch.Text)
		}
	}
	return b.String()
}
