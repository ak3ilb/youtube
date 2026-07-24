package youtube

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// timestampLinePattern matches description lines that contain a timestamp such
// as "0:00", "12:34" or "1:02:03" followed (or preceded) by a chapter title.
var timestampLinePattern = regexp.MustCompile(`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})`)

// ParseChapters extracts chapter markers from a video description, using the
// same heuristic YouTube itself applies: a list of ascending timestamps, the
// first of which must be 0:00.
func ParseChapters(description string, durationSeconds int) []Chapter {
	var chapters []Chapter
	for _, line := range strings.Split(description, "\n") {
		loc := timestampLinePattern.FindStringSubmatchIndex(line)
		if loc == nil {
			continue
		}
		match := timestampLinePattern.FindStringSubmatch(line)
		hours := 0
		if match[1] != "" {
			hours, _ = strconv.Atoi(match[1])
		}
		minutes, _ := strconv.Atoi(match[2])
		seconds, _ := strconv.Atoi(match[3])
		start := hours*3600 + minutes*60 + seconds
		if durationSeconds > 0 && start > durationSeconds {
			continue
		}
		title := strings.TrimSpace(line[:loc[0]] + line[loc[1]:])
		title = strings.Trim(title, " -–—:|•[]()\t")
		if title == "" {
			title = fmt.Sprintf("Chapter at %s", FormatTimestamp(float64(start)))
		}
		chapters = append(chapters, Chapter{Title: title, StartSeconds: start, Timestamp: FormatTimestamp(float64(start))})
	}
	// YouTube requires chapters to start at 0:00 and be ascending.
	if len(chapters) < 2 || chapters[0].StartSeconds != 0 {
		return nil
	}
	for i := 1; i < len(chapters); i++ {
		if chapters[i].StartSeconds <= chapters[i-1].StartSeconds {
			return nil
		}
	}
	return chapters
}

// ChaptersResult wraps chapters with their source.
type ChaptersResult struct {
	VideoID     string    `json:"videoId"`
	Title       string    `json:"title"`
	Chapters    []Chapter `json:"chapters"`
	Count       int       `json:"count"`
	HasChapters bool      `json:"hasChapters"`
	Source      string    `json:"source"` // "markers" | "description" | "none"
}

// Chapters fetches video info and parses chapters from description (and later InnerTube markers).
func (c *Client) Chapters(ctx context.Context, input string) (*ChaptersResult, error) {
	info, err := c.Info(ctx, input)
	if err != nil {
		return nil, err
	}
	chapters := ParseChapters(info.Description, info.DurationSeconds)
	source := "none"
	if len(chapters) > 0 {
		source = "description"
	}
	// Prefer InnerTube markers when available via next endpoint.
	if markers, err := c.chaptersFromNext(ctx, info.ID); err == nil && len(markers) > 0 {
		chapters = markers
		source = "markers"
	}
	return &ChaptersResult{
		VideoID: info.ID, Title: info.Title, Chapters: chapters,
		Count: len(chapters), HasChapters: len(chapters) > 0, Source: source,
	}, nil
}
