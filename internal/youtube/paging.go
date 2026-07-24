package youtube

import "strings"

// TranscriptPage is a bounded window over a transcript. Agents with limited
// context ask for maxChars at a time and follow nextCursor until hasMore is false.
type TranscriptPage struct {
	Transcript
	Cursor        int  `json:"cursor"`
	NextCursor    int  `json:"nextCursor,omitempty"`
	HasMore       bool `json:"hasMore"`
	TotalSegments int  `json:"totalSegments"`
	TotalChars    int  `json:"totalChars"`
	PageChars     int  `json:"pageChars"`
}

// PageTranscript slices tr starting at segment index cursor, stopping once the
// page would exceed maxChars. A segment is never split, so a single oversized
// segment is still returned whole.
func PageTranscript(tr *Transcript, cursor, maxChars int) *TranscriptPage {
	if cursor < 0 {
		cursor = 0
	}
	if cursor > len(tr.Segments) {
		cursor = len(tr.Segments)
	}
	totalChars := 0
	for _, s := range tr.Segments {
		totalChars += len([]rune(s.Text))
	}

	end := len(tr.Segments)
	pageChars := 0
	if maxChars > 0 {
		end = cursor
		for end < len(tr.Segments) {
			segChars := len([]rune(tr.Segments[end].Text))
			if pageChars > 0 && pageChars+segChars > maxChars {
				break
			}
			pageChars += segChars
			end++
		}
	} else {
		for _, s := range tr.Segments[cursor:] {
			pageChars += len([]rune(s.Text))
		}
	}

	segments := tr.Segments[cursor:end]
	lines := make([]string, len(segments))
	var text strings.Builder
	var duration float64
	for i, s := range segments {
		lines[i] = "[" + s.Timestamp + "] " + s.Text
		if i > 0 {
			text.WriteByte(' ')
		}
		text.WriteString(s.Text)
		if s.End > duration {
			duration = s.End
		}
	}

	page := &TranscriptPage{
		Transcript:    *tr,
		Cursor:        cursor,
		HasMore:       end < len(tr.Segments),
		TotalSegments: len(tr.Segments),
		TotalChars:    totalChars,
		PageChars:     pageChars,
	}
	page.Segments = segments
	page.Lines = lines
	page.Text = text.String()
	page.SegmentCount = len(segments)
	page.DurationSeconds = duration
	if page.HasMore {
		page.NextCursor = end
	}
	return page
}
