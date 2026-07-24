package youtube

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

const sponsorBlockAPI = "https://sponsor.ajay.app/api/skipSegments"

// SponsorSegment is one community-flagged range to skip (sponsor, intro, ...).
type SponsorSegment struct {
	Category     string  `json:"category"`
	Start        float64 `json:"start"`
	End          float64 `json:"end"`
	Timestamp    string  `json:"timestamp"`
	TimestampEnd string  `json:"timestampEnd"`
}

// sponsorBlockEnabled reports whether the user opted into the third-party
// SponsorBlock community database. It is off by default because it sends the
// video ID to sponsor.ajay.app.
func sponsorBlockEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("YTUBE_SPONSORBLOCK"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func sponsorCategories() []string {
	raw := strings.TrimSpace(os.Getenv("YTUBE_SPONSORBLOCK_CATEGORIES"))
	if raw == "" {
		return []string{"sponsor", "selfpromo", "interaction", "intro", "outro", "preview", "music_offtopic"}
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// SponsorSegments fetches skip ranges for a video. It returns an actionable
// error when the feature has not been enabled, so agents can tell the user why.
func (c *Client) SponsorSegments(ctx context.Context, input string) ([]SponsorSegment, error) {
	id, err := ParseVideoID(input)
	if err != nil {
		return nil, err
	}
	if !sponsorBlockEnabled() {
		return nil, &ExtractError{
			Code: "SPONSORBLOCK_DISABLED",
			Message: "SponsorBlock is off by default because it sends the video ID to the third-party sponsor.ajay.app database. " +
				"Set YTUBE_SPONSORBLOCK=1 to enable it.",
			Details: map[string]any{"videoId": id, "enableWith": "YTUBE_SPONSORBLOCK=1"},
		}
	}
	var cached []SponsorSegment
	if c.cacheGet("sponsorblock", id, &cached) {
		return cached, nil
	}
	if err := c.bill("sponsorblock"); err != nil {
		return nil, err
	}

	categories, _ := json.Marshal(sponsorCategories())
	query := url.Values{}
	query.Set("videoID", id)
	query.Set("categories", string(categories))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sponsorBlockAPI+"?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "youtube-client-mcp")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, classifyNetworkError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		// SponsorBlock uses 404 for "no segments submitted".
		c.cacheSet("sponsorblock", id, []SponsorSegment{})
		return []SponsorSegment{}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &ExtractError{Code: "SPONSORBLOCK_ERROR", Retryable: resp.StatusCode >= 500,
			Message: "SponsorBlock returned an unexpected status", Details: map[string]any{"status": resp.StatusCode}}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, classifyNetworkError(err)
	}
	var raw []struct {
		Category string    `json:"category"`
		Segment  []float64 `json:"segment"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, &ExtractError{Code: "SPONSORBLOCK_ERROR", Message: "Could not parse SponsorBlock response"}
	}
	segments := make([]SponsorSegment, 0, len(raw))
	for _, r := range raw {
		if len(r.Segment) != 2 || r.Segment[1] <= r.Segment[0] {
			continue
		}
		segments = append(segments, SponsorSegment{
			Category: r.Category, Start: r.Segment[0], End: r.Segment[1],
			Timestamp: FormatTimestamp(r.Segment[0]), TimestampEnd: FormatTimestamp(r.Segment[1]),
		})
	}
	c.cacheSet("sponsorblock", id, segments)
	return segments, nil
}

// removeSponsorSegments drops transcript segments whose midpoint falls inside a
// flagged range, and reports how many seconds of content were removed.
func removeSponsorSegments(segments []TranscriptSegment, sponsors []SponsorSegment) ([]TranscriptSegment, float64) {
	if len(sponsors) == 0 {
		return segments, 0
	}
	kept := make([]TranscriptSegment, 0, len(segments))
	var removed float64
	for _, s := range segments {
		mid := s.Start + (s.End-s.Start)/2
		inSponsor := false
		for _, sp := range sponsors {
			if mid >= sp.Start && mid <= sp.End {
				inSponsor = true
				break
			}
		}
		if inSponsor {
			removed += s.End - s.Start
			continue
		}
		kept = append(kept, s)
	}
	return kept, removed
}
