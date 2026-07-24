package youtube

import (
	"strings"
	"testing"
)

func askChunks() []RAGChunk {
	segments := enrichSegments([]TranscriptSegment{
		{Text: "Today we install the dependencies with npm and pnpm.", Start: 0, Duration: 5},
		{Text: "Next we configure the vector database index for retrieval.", Start: 5, Duration: 5},
		{Text: "Finally we deploy the vector database to production on Friday.", Start: 10, Duration: 5},
	})
	return BuildRAGChunks("dQw4w9WgXcQ", segments, 60)
}

func TestRankPassagesPrefersTermMatches(t *testing.T) {
	passages := RankPassages(askChunks(), "how do I install dependencies?", 2)
	if len(passages) == 0 {
		t.Fatal("expected at least one passage")
	}
	if !strings.Contains(passages[0].Chunk.Text, "install the dependencies") {
		t.Fatalf("top passage was %q", passages[0].Chunk.Text)
	}
	for i := 1; i < len(passages); i++ {
		if passages[i].Score > passages[i-1].Score {
			t.Fatal("passages are not sorted by descending score")
		}
	}
}

func TestRankPassagesRespectsTopK(t *testing.T) {
	passages := RankPassages(askChunks(), "vector database", 1)
	if len(passages) != 1 {
		t.Fatalf("topK=1 returned %d passages", len(passages))
	}
	if passages[0].Chunk.URL == "" || !strings.Contains(passages[0].Chunk.URL, "watch?v=") {
		t.Fatalf("passage is missing a jump link: %q", passages[0].Chunk.URL)
	}
}

func TestRankPassagesIgnoresStopWordOnlyQuestions(t *testing.T) {
	if passages := RankPassages(askChunks(), "what is that?", 5); len(passages) != 0 {
		t.Fatalf("expected no matches for a stop-word question, got %d", len(passages))
	}
}

func TestWatchURLAt(t *testing.T) {
	if got := WatchURLAt("dQw4w9WgXcQ", 0); got != "https://www.youtube.com/watch?v=dQw4w9WgXcQ" {
		t.Fatalf("unexpected url for zero offset: %s", got)
	}
	if got := WatchURLAt("dQw4w9WgXcQ", 91.7); got != "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=91s" {
		t.Fatalf("unexpected url for offset: %s", got)
	}
}
