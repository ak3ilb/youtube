package youtube

import (
	"context"
	"fmt"
	"strings"
)

// RAGChunk is one citation-ready transcript window for embedding / retrieval.
type RAGChunk struct {
	ID           string  `json:"id"`
	Text         string  `json:"text"`
	Citation     string  `json:"citation"` // e.g. [1:07:12]
	URL          string  `json:"url"`      // deep link that opens the video at Start
	Start        float64 `json:"start"`
	End          float64 `json:"end"`
	Timestamp    string  `json:"timestamp"`
	TimestampEnd string  `json:"timestampEnd"`
	CharCount    int     `json:"charCount"`
}

// VideoPack is an agent-oriented briefing for one video: metadata, chapters,
// citation chunks, and a markdown document ready for RAG or chat context.
type VideoPack struct {
	Video           *VideoInfo       `json:"video"`
	Chapters        []Chapter        `json:"chapters"`
	ChapterSource   string           `json:"chapterSource"`
	Language        string           `json:"language"`
	MergedASR       bool             `json:"mergedAsr"`
	ChunkCount      int              `json:"chunkCount"`
	Chunks          []RAGChunk       `json:"chunks"`
	Markdown        string           `json:"markdown"`
	HowToCite       string           `json:"howToCite"`
	SponsorSegments []SponsorSegment `json:"sponsorSegments,omitempty"`
	RemovedSeconds  float64          `json:"removedSeconds,omitempty"`
	CacheHit        bool             `json:"cacheHit,omitempty"`
}

// PackOptions controls how a video pack is assembled.
type PackOptions struct {
	Lang       string
	ChunkChars int
	// SkipSponsors removes SponsorBlock-flagged ranges from the chunked text.
	// Requires community data to be enabled (see sponsorBlockEnabled).
	SkipSponsors bool
}

// BuildRAGChunks groups transcript segments into ~targetChars windows that
// never break a segment, each tagged with a YouTube-style citation timestamp.
func BuildRAGChunks(videoID string, segments []TranscriptSegment, targetChars int) []RAGChunk {
	if targetChars <= 0 {
		targetChars = 800
	}
	var chunks []RAGChunk
	var buf []TranscriptSegment
	var chars int
	flush := func() {
		if len(buf) == 0 {
			return
		}
		var b strings.Builder
		for i, s := range buf {
			if i > 0 {
				b.WriteByte(' ')
			}
			b.WriteString(s.Text)
		}
		start, end := buf[0].Start, buf[len(buf)-1].End
		cite := FormatTimestamp(start)
		id := fmt.Sprintf("%s_%d", videoID, int(start*1000))
		text := b.String()
		chunks = append(chunks, RAGChunk{
			ID: id, Text: text, Citation: "[" + cite + "]",
			URL:   WatchURLAt(videoID, start),
			Start: start, End: end,
			Timestamp: FormatTimestamp(start), TimestampEnd: FormatTimestamp(end),
			CharCount: len([]rune(text)),
		})
		buf = nil
		chars = 0
	}
	for _, s := range segments {
		segChars := len([]rune(s.Text))
		if chars > 0 && chars+segChars > targetChars {
			flush()
		}
		buf = append(buf, s)
		chars += segChars + 1
	}
	flush()
	return chunks
}

func renderPackMarkdown(info *VideoInfo, chapters []Chapter, chunks []RAGChunk, lang string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", info.Title)
	fmt.Fprintf(&b, "- URL: %s\n", info.URL)
	fmt.Fprintf(&b, "- Channel: %s\n", info.ChannelName)
	fmt.Fprintf(&b, "- Duration: %s\n", FormatTimestamp(float64(info.DurationSeconds)))
	if lang != "" {
		fmt.Fprintf(&b, "- Transcript language: %s\n", lang)
	}
	b.WriteString("\n## How to cite\n\n")
	b.WriteString("When quoting this video, include the timestamp citation like `[1:07:12]` so readers can jump to that moment.\n")
	if len(chapters) > 0 {
		b.WriteString("\n## Chapters\n\n")
		for _, ch := range chapters {
			fmt.Fprintf(&b, "- [%s] %s\n", ch.Timestamp, ch.Title)
		}
	}
	b.WriteString("\n## Transcript chunks\n\n")
	for _, c := range chunks {
		fmt.Fprintf(&b, "### %s\n\n%s\n\n", c.Citation, c.Text)
	}
	return b.String()
}

// VideoPack builds a citation-ready analysis pack for agents (RAG / briefing).
func (c *Client) VideoPack(ctx context.Context, input, lang string, chunkChars int) (*VideoPack, error) {
	return c.VideoPackWithOptions(ctx, input, PackOptions{Lang: lang, ChunkChars: chunkChars})
}

// VideoPackWithOptions is VideoPack with sponsor-skipping and chunk sizing.
func (c *Client) VideoPackWithOptions(ctx context.Context, input string, opts PackOptions) (*VideoPack, error) {
	id, err := ParseVideoID(input)
	if err != nil {
		return nil, err
	}
	cacheKey := fmt.Sprintf("%s|%s|%d|%v", id, opts.Lang, opts.ChunkChars, opts.SkipSponsors)
	var cached VideoPack
	if c.cacheGet("videopack2", cacheKey, &cached) {
		cached.CacheHit = true
		return &cached, nil
	}

	info, err := c.Info(ctx, input)
	if err != nil {
		return nil, err
	}
	chRes, err := c.Chapters(ctx, input)
	if err != nil {
		return nil, err
	}
	tr, err := c.Transcript(ctx, input, opts.Lang)
	if err != nil {
		return nil, err
	}

	segments := tr.Segments
	var sponsors []SponsorSegment
	var removed float64
	if opts.SkipSponsors {
		sponsors, err = c.SponsorSegments(ctx, id)
		if err != nil {
			return nil, err
		}
		segments, removed = removeSponsorSegments(segments, sponsors)
	}

	chunks := BuildRAGChunks(id, segments, opts.ChunkChars)
	pack := &VideoPack{
		Video: info, Chapters: chRes.Chapters, ChapterSource: chRes.Source,
		Language: tr.LanguageCode, MergedASR: tr.Merged,
		ChunkCount: len(chunks), Chunks: chunks,
		Markdown:        renderPackMarkdown(info, chRes.Chapters, chunks, tr.LanguageCode),
		HowToCite:       "Cite claims with timestamps like [1:07:12] matching chunk.citation, and link chunk.url to jump there.",
		SponsorSegments: sponsors,
		RemovedSeconds:  removed,
	}
	c.cacheSet("videopack2", cacheKey, pack)
	return pack, nil
}
