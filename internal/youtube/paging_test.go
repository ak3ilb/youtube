package youtube

import "testing"

func testTranscript() *Transcript {
	segments := enrichSegments([]TranscriptSegment{
		{Text: "first segment", Start: 0, Duration: 2},
		{Text: "second segment", Start: 2, Duration: 2},
		{Text: "third segment", Start: 4, Duration: 2},
	})
	track := &CaptionTrack{LanguageCode: "en", Name: "English"}
	return buildTranscript("dQw4w9WgXcQ", track, segments, false, "")
}

func TestPageTranscriptWalksEveryPage(t *testing.T) {
	tr := testTranscript()
	var seen int
	cursor := 0
	for {
		page := PageTranscript(tr, cursor, 20)
		if page.SegmentCount == 0 {
			t.Fatalf("page at cursor %d returned no segments", cursor)
		}
		if page.TotalSegments != 3 {
			t.Fatalf("totalSegments = %d, want 3", page.TotalSegments)
		}
		seen += page.SegmentCount
		if !page.HasMore {
			if page.NextCursor != 0 {
				t.Fatalf("last page should not advertise a cursor, got %d", page.NextCursor)
			}
			break
		}
		if page.NextCursor <= cursor {
			t.Fatalf("cursor did not advance: %d -> %d", cursor, page.NextCursor)
		}
		cursor = page.NextCursor
	}
	if seen != 3 {
		t.Fatalf("walked %d segments, want 3", seen)
	}
}

func TestPageTranscriptWithoutLimitReturnsEverything(t *testing.T) {
	tr := testTranscript()
	page := PageTranscript(tr, 0, 0)
	if page.HasMore || page.SegmentCount != 3 {
		t.Fatalf("expected a single complete page, got hasMore=%v count=%d", page.HasMore, page.SegmentCount)
	}
	if page.Text != tr.Text {
		t.Fatalf("page text %q != transcript text %q", page.Text, tr.Text)
	}
	if page.TotalChars != page.PageChars {
		t.Fatalf("totalChars %d != pageChars %d", page.TotalChars, page.PageChars)
	}
}

func TestPageTranscriptReturnsOversizedSegmentWhole(t *testing.T) {
	tr := testTranscript()
	page := PageTranscript(tr, 0, 1)
	if page.SegmentCount != 1 {
		t.Fatalf("expected one oversized segment, got %d", page.SegmentCount)
	}
	if !page.HasMore || page.NextCursor != 1 {
		t.Fatalf("expected more pages from cursor 1, got hasMore=%v next=%d", page.HasMore, page.NextCursor)
	}
}

func TestPageTranscriptClampsOutOfRangeCursor(t *testing.T) {
	tr := testTranscript()
	page := PageTranscript(tr, 99, 100)
	if page.SegmentCount != 0 || page.HasMore {
		t.Fatalf("cursor past the end should return an empty final page, got count=%d hasMore=%v",
			page.SegmentCount, page.HasMore)
	}
}
