package youtube

import (
	"strings"
	"testing"
)

func TestMergeASRSegments(t *testing.T) {
	raw := []TranscriptSegment{
		{Text: "देयर इज़ अ बिलीफ दैट अल्ट्रा रिच पीपल। उन", Start: 0, Duration: 4.16},
		{Text: "लोगों के पास ना कुछ सॉर्ट ऑफ़ इनसाइडर", Start: 2.48, Duration: 3.279},
		{Text: "इनफार्मेशन होती है। इज दैट ट्रू?", Start: 4.16, Duration: 4.16},
		{Text: "Next sentence starts here.", Start: 10, Duration: 2},
	}
	merged := MergeASRSegments(raw)
	if len(merged) != 2 {
		t.Fatalf("expected 2 merged sentences, got %d: %+v", len(merged), merged)
	}
	if !strings.Contains(merged[0].Text, "उन लोगों के पास") {
		t.Errorf("expected mid-phrase join, got %q", merged[0].Text)
	}
	if !strings.Contains(merged[0].Text, "इज दैट ट्रू?") {
		t.Errorf("expected sentence completion, got %q", merged[0].Text)
	}
	if merged[1].Text != "Next sentence starts here." {
		t.Errorf("unexpected second segment %q", merged[1].Text)
	}
}

func TestFormatAndParseTimestamp(t *testing.T) {
	if got := FormatTimestamp(12.4); got != "0:12" {
		t.Errorf("FormatTimestamp(12.4)=%q", got)
	}
	if got := FormatTimestamp(3723); got != "1:02:03" {
		t.Errorf("FormatTimestamp(3723)=%q", got)
	}
	sec, err := ParseTimestamp("1:02:03")
	if err != nil || sec != 3723 {
		t.Errorf("ParseTimestamp = %v, %v", sec, err)
	}
	if _, err := ParseTimestamp("bad"); err == nil {
		t.Error("expected error for bad timestamp")
	}
}

func TestEnrichAndSRT(t *testing.T) {
	segs := enrichSegments([]TranscriptSegment{{Text: "hi", Start: 1.5, Duration: 2}})
	if segs[0].Timestamp != "0:02" || segs[0].TimestampEnd != "0:04" || segs[0].End != 3.5 {
		t.Errorf("enrich = %+v", segs[0])
	}
	srt := toSRT(segs)
	if !strings.Contains(srt, "00:00:01,500 --> 00:00:03,500") || !strings.Contains(srt, "hi") {
		t.Errorf("srt = %q", srt)
	}
	vtt := toVTT(segs)
	if !strings.HasPrefix(vtt, "WEBVTT") || !strings.Contains(vtt, "00:00:01.500") {
		t.Errorf("vtt = %q", vtt)
	}
}

func TestBuildRAGChunks(t *testing.T) {
	segs := enrichSegments([]TranscriptSegment{
		{Text: "First window A.", Start: 0, Duration: 2},
		{Text: "First window B.", Start: 2, Duration: 2},
		{Text: "Second window only.", Start: 10, Duration: 3},
	})
	chunks := BuildRAGChunks("abc", segs, 30)
	if len(chunks) < 2 {
		t.Fatalf("expected at least 2 chunks, got %d: %+v", len(chunks), chunks)
	}
	if chunks[0].Citation != "[0:00]" {
		t.Errorf("citation = %q", chunks[0].Citation)
	}
	if !strings.Contains(chunks[0].Text, "First window A.") {
		t.Errorf("chunk0 text = %q", chunks[0].Text)
	}
	if chunks[0].ID != "abc_0" {
		t.Errorf("id = %q", chunks[0].ID)
	}
	if chunks[len(chunks)-1].Citation != "[0:10]" {
		t.Errorf("last citation = %q", chunks[len(chunks)-1].Citation)
	}
}

func TestParsePlaylistAndChannel(t *testing.T) {
	id, err := ParsePlaylistID("https://www.youtube.com/playlist?list=PLtest123456")
	if err != nil || id != "PLtest123456" {
		t.Errorf("playlist = %q %v", id, err)
	}
	browse, handle, err := ParseChannelRef("@Google")
	if err != nil || handle != "@Google" || browse != "" {
		t.Errorf("channel handle = %q %q %v", browse, handle, err)
	}
	browse, handle, err = ParseChannelRef("UCuAXFkgsw1L7xaCfnd5JJOw")
	if err != nil || browse != "UCuAXFkgsw1L7xaCfnd5JJOw" {
		t.Errorf("channel id = %q %q %v", browse, handle, err)
	}
}
