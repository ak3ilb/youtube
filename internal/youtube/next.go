package youtube

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

// chaptersFromNext tries to read official chapter markers from the next endpoint.
func (c *Client) chaptersFromNext(ctx context.Context, videoID string) ([]Chapter, error) {
	data, err := c.call(ctx, "next", clientWEB, map[string]any{"videoId": videoID})
	if err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	chapters := extractMacroMarkers(root)
	if len(chapters) >= 2 && chapters[0].StartSeconds == 0 {
		return chapters, nil
	}
	return nil, nil
}

func extractMacroMarkers(node any) []Chapter {
	var out []Chapter
	walkJSON(node, func(key string, val any) bool {
		if key != "macroMarkersListItemRenderer" {
			return true
		}
		m, ok := val.(map[string]any)
		if !ok {
			return true
		}
		title := runsText(m["title"])
		if title == "" {
			if t, ok := m["title"].(map[string]any); ok {
				if s, ok := t["simpleText"].(string); ok {
					title = s
				}
			}
		}
		startMs := int64(0)
		if om, ok := m["onTap"].(map[string]any); ok {
			if we, ok := om["watchEndpoint"].(map[string]any); ok {
				startMs = toInt64(we["startTimeSeconds"]) * 1000
			}
		}
		if startMs == 0 {
			if tr, ok := m["timeDescription"].(map[string]any); ok {
				if s, ok := tr["simpleText"].(string); ok {
					if sec, err := ParseTimestamp(s); err == nil {
						startMs = int64(sec * 1000)
					}
				}
			}
		}
		start := int(startMs / 1000)
		out = append(out, Chapter{Title: title, StartSeconds: start, Timestamp: FormatTimestamp(float64(start))})
		return true
	})
	return out
}

// RelatedVideo is a video suggested alongside the current one.
type RelatedVideo struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	ChannelName string `json:"channelName,omitempty"`
	ViewCount   string `json:"viewCount,omitempty"`
	LengthText  string `json:"lengthText,omitempty"`
}

// Related returns videos related to the given video.
func (c *Client) Related(ctx context.Context, input string) (map[string]any, error) {
	id, err := ParseVideoID(input)
	if err != nil {
		return nil, err
	}
	var cached map[string]any
	if c.cacheGet("related", id, &cached) {
		cached["cacheHit"] = true
		return cached, nil
	}
	data, err := c.call(ctx, "next", clientWEB, map[string]any{"videoId": id})
	if err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, &ExtractError{Code: "INVALID_RESPONSE", Message: "Malformed next response", Retryable: true}
	}
	videos := extractRelatedVideos(root, id)
	out := map[string]any{"videoId": id, "related": videos, "count": len(videos)}
	c.cacheSet("related", id, out)
	return out, nil
}

func extractRelatedVideos(root map[string]any, selfID string) []RelatedVideo {
	var videos []RelatedVideo
	walkJSON(root, func(key string, val any) bool {
		m, ok := val.(map[string]any)
		if !ok {
			return true
		}
		switch key {
		case "compactVideoRenderer", "videoRenderer", "reelItemRenderer", "playlistVideoRenderer":
			if v := relatedFromRenderer(m, selfID); v != nil {
				videos = append(videos, *v)
			}
		case "lockupViewModel":
			if v := relatedFromLockup(m, selfID); v != nil {
				videos = append(videos, *v)
			}
		case "watchEndpoint":
			// Last-resort: capture bare watch endpoints with a sibling title if present later.
		}
		return true
	})
	// Also harvest watchEndpoint videoIds paired with accessibility labels / titles nearby.
	walkJSON(root, func(key string, val any) bool {
		if key != "watchEndpoint" {
			return true
		}
		m, ok := val.(map[string]any)
		if !ok {
			return true
		}
		vid := asString(m["videoId"])
		if vid == "" || vid == selfID {
			return true
		}
		for _, existing := range videos {
			if existing.ID == vid {
				return true
			}
		}
		videos = append(videos, RelatedVideo{ID: vid, Title: ""})
		return true
	})
	seen := map[string]bool{}
	out := make([]RelatedVideo, 0, len(videos))
	for _, v := range videos {
		if v.ID == "" || v.ID == selfID || seen[v.ID] {
			continue
		}
		seen[v.ID] = true
		if v.Title == "" {
			v.Title = "https://www.youtube.com/watch?v=" + v.ID
		}
		out = append(out, v)
	}
	return out
}

func relatedFromRenderer(m map[string]any, selfID string) *RelatedVideo {
	vid := asString(m["videoId"])
	if vid == "" {
		if we, ok := nested(m, "navigationEndpoint", "watchEndpoint").(map[string]any); ok {
			vid = asString(we["videoId"])
		}
	}
	if vid == "" || vid == selfID {
		return nil
	}
	title := runsText(m["title"])
	if title == "" {
		title = asString(nested(m, "title", "simpleText"))
	}
	if title == "" {
		title = asString(nested(m, "headline", "content"))
	}
	if title == "" {
		title = runsText(m["accessibility"])
	}
	return &RelatedVideo{
		ID: vid, Title: title,
		ChannelName: runsText(m["shortBylineText"]),
		ViewCount:   runsText(m["viewCountText"]),
		LengthText:  asString(nested(m, "lengthText", "simpleText")),
	}
}

func relatedFromLockup(m map[string]any, selfID string) *RelatedVideo {
	vid := asString(m["contentId"])
	if vid == "" {
		if we, ok := nested(m, "rendererContext", "commandContext", "onTap", "innertubeCommand", "watchEndpoint").(map[string]any); ok {
			vid = asString(we["videoId"])
		}
	}
	if vid == "" {
		walkJSON(m, func(k string, v any) bool {
			if k == "watchEndpoint" {
				if mm, ok := v.(map[string]any); ok && vid == "" {
					vid = asString(mm["videoId"])
				}
			}
			return vid == ""
		})
	}
	if !videoIDPattern.MatchString(vid) || vid == selfID {
		return nil
	}
	title := asString(nested(m, "metadata", "lockupMetadataViewModel", "title", "content"))
	if title == "" {
		walkJSON(m, func(k string, v any) bool {
			if k == "accessibilityText" && title == "" {
				title = asString(v)
			}
			return title == ""
		})
	}
	return &RelatedVideo{ID: vid, Title: title}
}

func walkJSON(node any, fn func(key string, val any) bool) {
	switch n := node.(type) {
	case map[string]any:
		for k, v := range n {
			if !fn(k, v) {
				return
			}
			walkJSON(v, fn)
		}
	case []any:
		for _, v := range n {
			walkJSON(v, fn)
		}
	}
}

func runsText(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	if s, ok := m["simpleText"].(string); ok {
		return s
	}
	runs, ok := m["runs"].([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, r := range runs {
		if rm, ok := r.(map[string]any); ok {
			b.WriteString(asString(rm["text"]))
		}
	}
	return b.String()
}

func asString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	default:
		return ""
	}
}

func toInt64(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case string:
		n, _ := strconv.ParseInt(t, 10, 64)
		return n
	case int:
		return int64(t)
	case int64:
		return t
	default:
		return 0
	}
}

func nested(m map[string]any, keys ...string) any {
	var cur any = m
	for _, k := range keys {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = mm[k]
	}
	return cur
}
