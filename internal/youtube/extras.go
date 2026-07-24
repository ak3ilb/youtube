package youtube

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// HeatmapPoint is one intensity sample of the most-replayed graph.
type HeatmapPoint struct {
	StartSeconds float64 `json:"startSeconds"`
	Timestamp    string  `json:"timestamp"`
	Value        float64 `json:"value"`
}

// Heatmap returns most-replayed intensity markers when YouTube provides them.
func (c *Client) Heatmap(ctx context.Context, input string) (map[string]any, error) {
	id, err := ParseVideoID(input)
	if err != nil {
		return nil, err
	}
	data, err := c.call(ctx, "next", clientWEB, map[string]any{"videoId": id})
	if err != nil {
		return map[string]any{"videoId": id, "points": []HeatmapPoint{}, "count": 0, "available": false}, nil
	}
	var root map[string]any
	_ = json.Unmarshal(data, &root)
	var points []HeatmapPoint
	walkJSON(root, func(key string, val any) bool {
		if key != "heatmap" && key != "heatMarkerRenderer" {
			return true
		}
		m, ok := val.(map[string]any)
		if !ok {
			return true
		}
		if key == "heatMarkerRenderer" {
			start := toFloat(nested(m, "heatMarkerStartTimeMillis")) / 1000
			val := toFloat(nested(m, "heatMarkerHeightNormalized"))
			points = append(points, HeatmapPoint{StartSeconds: start, Timestamp: FormatTimestamp(start), Value: val})
			return true
		}
		if markers, ok := nested(m, "heatmapMarkers").([]any); ok {
			for _, mk := range markers {
				mm := mustMap(mk)
				start := toFloat(nested(mm, "timeRangeStartMillis")) / 1000
				val := toFloat(nested(mm, "markerIntensityScoreNormalized"))
				if val == 0 {
					val = toFloat(nested(mm, "heatMarkerHeightNormalized"))
				}
				points = append(points, HeatmapPoint{StartSeconds: start, Timestamp: FormatTimestamp(start), Value: val})
			}
		}
		return true
	})
	return map[string]any{
		"videoId": id, "points": points, "count": len(points), "available": len(points) > 0,
	}, nil
}

// StoryboardLevel describes one resolution of preview tiles.
type StoryboardLevel struct {
	Width           int      `json:"width"`
	Height          int      `json:"height"`
	Columns         int      `json:"columns"`
	Rows            int      `json:"rows"`
	IntervalMs      int      `json:"intervalMs"`
	StoryboardCount int      `json:"storyboardCount"`
	TemplateURL     string   `json:"templateUrl"`
	URLs            []string `json:"urls"`
}

// Storyboards parses the player storyboard spec into concrete tile URLs.
func (c *Client) Storyboards(ctx context.Context, input string) (map[string]any, error) {
	id, err := ParseVideoID(input)
	if err != nil {
		return nil, err
	}
	p, _, err := c.fetchPlayer(ctx, id)
	if err != nil {
		return nil, err
	}
	spec := p.Storyboards.PlayerStoryboardSpecRenderer.Spec
	if spec == "" {
		// ANDROID often omits storyboards; try WEB explicitly.
		var webPlayer playerResponse
		if err := c.callJSON(ctx, "player", clientWEB, map[string]any{
			"videoId": id, "contentCheckOk": true, "racyCheckOk": true,
		}, &webPlayer); err == nil {
			spec = webPlayer.Storyboards.PlayerStoryboardSpecRenderer.Spec
		}
	}
	levels := parseStoryboardSpec(spec)
	return map[string]any{
		"videoId": id, "levels": levels, "count": len(levels), "available": len(levels) > 0,
	}, nil
}

func parseStoryboardSpec(spec string) []StoryboardLevel {
	if spec == "" {
		return nil
	}
	parts := strings.Split(spec, "|")
	if len(parts) < 2 {
		return nil
	}
	base := parts[0]
	var levels []StoryboardLevel
	for _, part := range parts[1:] {
		fields := strings.Split(part, "#")
		if len(fields) < 8 {
			continue
		}
		w, _ := strconv.Atoi(fields[0])
		h, _ := strconv.Atoi(fields[1])
		count, _ := strconv.Atoi(fields[2])
		cols, _ := strconv.Atoi(fields[3])
		rows, _ := strconv.Atoi(fields[4])
		interval, _ := strconv.Atoi(fields[5])
		sigh := fields[len(fields)-1]
		tmpl := strings.ReplaceAll(base, "$L", fmt.Sprintf("%d", len(levels)))
		tmpl = strings.ReplaceAll(tmpl, "$N", "M$M")
		tmpl += "&sigh=" + sigh
		urls := make([]string, 0, count)
		for i := 0; i < count; i++ {
			urls = append(urls, strings.ReplaceAll(tmpl, "$M", strconv.Itoa(i)))
		}
		levels = append(levels, StoryboardLevel{
			Width: w, Height: h, Columns: cols, Rows: rows,
			IntervalMs: interval, StoryboardCount: count,
			TemplateURL: tmpl, URLs: urls,
		})
	}
	return levels
}

// Manifests returns DASH/HLS URLs and live status from the player response.
func (c *Client) Manifests(ctx context.Context, input string) (map[string]any, error) {
	id, err := ParseVideoID(input)
	if err != nil {
		return nil, err
	}
	p, clientName, err := c.fetchPlayer(ctx, id)
	if err != nil {
		return nil, err
	}
	info := infoFromPlayer(id, p)
	result := map[string]any{
		"videoId":         id,
		"isLive":          info.IsLive,
		"dashManifestUrl": nullIfEmpty(p.StreamingData.DashManifestURL),
		"hlsManifestUrl":  nullIfEmpty(p.StreamingData.HlsManifestURL),
		"innertubeClient": clientName,
	}
	if info.IsLive {
		result["note"] = "Live fragment downloading is not supported; manifests are exposed for inspection only"
	}
	return result, nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func toFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		f, _ := strconv.ParseFloat(t, 64)
		return f
	case int:
		return float64(t)
	case int64:
		return float64(t)
	default:
		return 0
	}
}
