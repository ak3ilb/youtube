package youtube

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestRemoveSponsorSegments(t *testing.T) {
	segments := enrichSegments([]TranscriptSegment{
		{Text: "intro talk", Start: 0, Duration: 4},
		{Text: "sponsor read", Start: 4, Duration: 6},
		{Text: "actual content", Start: 10, Duration: 5},
	})
	sponsors := []SponsorSegment{{Category: "sponsor", Start: 3.5, End: 9.9}}

	kept, removed := removeSponsorSegments(segments, sponsors)
	if len(kept) != 2 {
		t.Fatalf("expected 2 segments to survive, got %d", len(kept))
	}
	if kept[0].Text != "intro talk" || kept[1].Text != "actual content" {
		t.Fatalf("wrong segments kept: %q, %q", kept[0].Text, kept[1].Text)
	}
	if removed != 6 {
		t.Fatalf("removedSeconds = %v, want 6", removed)
	}
}

func TestRemoveSponsorSegmentsWithoutSegmentsIsANoop(t *testing.T) {
	segments := enrichSegments([]TranscriptSegment{{Text: "only line", Start: 0, Duration: 2}})
	kept, removed := removeSponsorSegments(segments, nil)
	if len(kept) != 1 || removed != 0 {
		t.Fatalf("unexpected result: %d segments, %v removed", len(kept), removed)
	}
}

func TestSponsorSegmentsRequiresOptIn(t *testing.T) {
	t.Setenv("YTUBE_SPONSORBLOCK", "")
	client := NewClient(0)
	_, err := client.SponsorSegments(context.Background(), "dQw4w9WgXcQ")
	if err == nil {
		t.Fatal("expected an opt-in error")
	}
	var ee *ExtractError
	if !errors.As(err, &ee) || ee.Code != "SPONSORBLOCK_DISABLED" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSponsorCategoriesFromEnv(t *testing.T) {
	t.Setenv("YTUBE_SPONSORBLOCK_CATEGORIES", "sponsor, intro ,")
	got := sponsorCategories()
	if len(got) != 2 || got[0] != "sponsor" || got[1] != "intro" {
		t.Fatalf("unexpected categories: %v", got)
	}
	raw, _ := json.Marshal(got)
	if string(raw) != `["sponsor","intro"]` {
		t.Fatalf("unexpected encoded categories: %s", raw)
	}
}
