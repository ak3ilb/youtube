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
			title = fmt.Sprintf("Chapter at %s", formatTimestamp(start))
		}
		chapters = append(chapters, Chapter{Title: title, StartSeconds: start, Timestamp: formatTimestamp(start)})
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

func formatTimestamp(total int) string {
	h, m, s := total/3600, (total%3600)/60, total%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

// Chapters fetches video info and parses chapters from its description.
func (c *Client) Chapters(ctx context.Context, input string) ([]Chapter, *VideoInfo, error) {
	info, err := c.Info(ctx, input)
	if err != nil {
		return nil, nil, err
	}
	return ParseChapters(info.Description, info.DurationSeconds), info, nil
}
