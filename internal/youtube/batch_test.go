package youtube

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestExplicitVideoList(t *testing.T) {
	ids, ok := explicitVideoList("dQw4w9WgXcQ, https://youtu.be/aqz-KE-bpKQ")
	if !ok {
		t.Fatal("expected a video list to be recognized")
	}
	if len(ids) != 2 || ids[0] != "dQw4w9WgXcQ" || ids[1] != "aqz-KE-bpKQ" {
		t.Fatalf("unexpected ids: %v", ids)
	}
	if _, ok := explicitVideoList("dQw4w9WgXcQ"); ok {
		t.Fatal("a single video should not be treated as a list")
	}
	if _, ok := explicitVideoList("dQw4w9WgXcQ, https://example.com/video"); ok {
		t.Fatal("a list with an invalid entry should be rejected")
	}
}

func TestCollectVideoRefsAcceptsTypedAndCachedShapes(t *testing.T) {
	typed := []PlaylistItem{{ID: "dQw4w9WgXcQ", Title: "First"}, {ID: "aqz-KE-bpKQ", Title: "Second"}}
	ids, names := collectVideoRefs(typed)
	if len(ids) != 2 || names["dQw4w9WgXcQ"] != "First" {
		t.Fatalf("typed playlist items not read: %v %v", ids, names)
	}

	// Cached results round-trip through JSON and arrive as []any of maps.
	raw, err := json.Marshal(typed)
	if err != nil {
		t.Fatal(err)
	}
	var generic []any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	ids, names = collectVideoRefs(generic)
	if len(ids) != 2 || names["aqz-KE-bpKQ"] != "Second" {
		t.Fatalf("cached playlist items not read: %v %v", ids, names)
	}
}

func TestCollectVideoRefsDeduplicatesAndKeepsOrder(t *testing.T) {
	items := []map[string]any{
		{"id": "dQw4w9WgXcQ", "title": ""},
		{"id": "dQw4w9WgXcQ", "title": "duplicate"},
		{"id": "aqz-KE-bpKQ", "title": "second"},
		{"title": "missing id"},
	}
	ids, _ := collectVideoRefs(items)
	if len(ids) != 2 || ids[0] != "dQw4w9WgXcQ" || ids[1] != "aqz-KE-bpKQ" {
		t.Fatalf("unexpected ids: %v", ids)
	}
}

func TestIsFatalBatchError(t *testing.T) {
	if !isFatalBatchError(&ExtractError{Code: "RATE_BUDGET_EXCEEDED"}) {
		t.Fatal("budget exhaustion should stop a batch")
	}
	if isFatalBatchError(&ExtractError{Code: "NO_CAPTIONS"}) {
		t.Fatal("a captionless video should not stop a batch")
	}
	if isFatalBatchError(errors.New("boom")) {
		t.Fatal("unknown errors should not stop a batch")
	}
}

func TestBatchFailureCarriesErrorCode(t *testing.T) {
	f := batchFailure("dQw4w9WgXcQ", "Some video", &ExtractError{Code: "NO_CAPTIONS", Message: "no tracks", Retryable: false})
	if f.Code != "NO_CAPTIONS" || f.Title != "Some video" || f.Retryable {
		t.Fatalf("unexpected failure: %+v", f)
	}
	f = batchFailure("dQw4w9WgXcQ", "", errors.New("boom"))
	if f.Code != "INTERNAL_ERROR" || f.Message != "boom" {
		t.Fatalf("unexpected failure: %+v", f)
	}
}
