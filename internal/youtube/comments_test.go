package youtube

import (
	"encoding/json"
	"testing"
)

// commentPageFixture mirrors YouTube's current shape: thread renderers point at
// entity payloads that hold the text, and replies hang off a continuation.
const commentPageFixture = `{
  "frameworkUpdates": {
    "entityBatchUpdate": {
      "mutations": [
        {"payload": {"commentEntityPayload": {
          "properties": {"commentId": "c1", "content": {"content": "First comment"}, "publishedTime": "2 days ago"},
          "author": {"displayName": "@alice"},
          "toolbar": {"likeCountLiked": "12", "replyCount": "2"}
        }}},
        {"payload": {"commentEntityPayload": {
          "properties": {"commentId": "c2", "content": {"content": "Second comment"}, "publishedTime": "1 day ago"},
          "author": {"displayName": "@bob"},
          "toolbar": {"likeCountLiked": "3"}
        }}}
      ]
    }
  },
  "contents": {"items": [
    {"commentThreadRenderer": {
      "commentViewModel": {"commentViewModel": {"commentId": "c1"}},
      "replies": {"commentRepliesRenderer": {"contents": [
        {"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": "reply-token-c1"}}}}
      ]}}
    }},
    {"commentThreadRenderer": {
      "commentViewModel": {"commentViewModel": {"commentId": "c2"}}
    }},
    {"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": "next-page-token"}}}}
  ]}
}`

// YouTube has shipped both "Top"/"Newest" and "Top comments"/"Newest first".
const sortMenuFixture = `{"header": {"commentsHeaderRenderer": {"sortMenu": {"sortFilterSubMenuRenderer": {
  "subMenuItems": [
    {"title": "Top", "selected": true, "serviceEndpoint": {"continuationCommand": {"token": "top-token"}}},
    {"title": "Newest", "selected": false, "serviceEndpoint": {"continuationCommand": {"token": "newest-token"}}}
  ]
}}}}}`

const verboseSortMenuFixture = `{"sortMenu": {"sortFilterSubMenuRenderer": {
  "subMenuItems": [
    {"title": "Top comments", "selected": false, "serviceEndpoint": {"continuationCommand": {"token": "top-token"}}},
    {"title": "Newest first", "selected": true, "serviceEndpoint": {"continuationCommand": {"token": "newest-token"}}}
  ]
}}}`

func parseFixture(t *testing.T, raw string) map[string]any {
	t.Helper()
	var root map[string]any
	if err := json.Unmarshal([]byte(raw), &root); err != nil {
		t.Fatalf("bad fixture: %v", err)
	}
	return root
}

func TestParseCommentPageReadsThreadsAndReplyTokens(t *testing.T) {
	comments, next := parseCommentPage(parseFixture(t, commentPageFixture))
	if len(comments) != 2 {
		t.Fatalf("expected 2 comments, got %d", len(comments))
	}

	byID := map[string]Comment{}
	for _, c := range comments {
		byID[c.ID] = c
	}
	first, ok := byID["c1"]
	if !ok {
		t.Fatal("comment c1 missing")
	}
	if first.Text != "First comment" || first.Author != "@alice" || first.LikeCount != "12" || first.ReplyCount != 2 {
		t.Fatalf("comment c1 not fully parsed: %+v", first)
	}
	if first.replyToken != "reply-token-c1" {
		t.Fatalf("reply token = %q", first.replyToken)
	}
	if byID["c2"].replyToken != "" {
		t.Fatal("a thread without replies should not carry a reply token")
	}
	if next == "" {
		t.Fatal("expected a next-page continuation token")
	}
}

func TestPickSortTokenOnlySwitchesWhenNeeded(t *testing.T) {
	root := parseFixture(t, sortMenuFixture)
	if got := pickSortToken(root, "newest"); got != "newest-token" {
		t.Fatalf("newest token = %q", got)
	}
	if got := pickSortToken(root, "top"); got != "" {
		t.Fatalf("already-selected sort should need no switch, got %q", got)
	}

	verbose := parseFixture(t, verboseSortMenuFixture)
	if got := pickSortToken(verbose, "top"); got != "top-token" {
		t.Fatalf("verbose menu top token = %q", got)
	}
	if got := pickSortToken(verbose, "newest"); got != "" {
		t.Fatalf("verbose menu already sorted by newest, got %q", got)
	}
}

func TestSortOrDefault(t *testing.T) {
	for input, want := range map[string]string{"": "top", "top": "top", "NEWEST": "newest", "junk": "top"} {
		if got := sortOrDefault(input); got != want {
			t.Fatalf("sortOrDefault(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestFlatCommentsHandlesLegacyRenderers(t *testing.T) {
	root := parseFixture(t, `{"items": [
      {"commentRenderer": {"commentId": "old1", "contentText": {"runs": [{"text": "Legacy "}, {"text": "comment"}]},
        "authorText": {"simpleText": "@carol"}, "voteCount": {"simpleText": "7"},
        "publishedTimeText": {"runs": [{"text": "3 hours ago"}]}}}
    ]}`)
	comments, _ := parseCommentPage(root)
	if len(comments) != 1 {
		t.Fatalf("expected 1 legacy comment, got %d", len(comments))
	}
	got := comments[0]
	if got.Text != "Legacy comment" || got.Author != "@carol" || got.LikeCount != "7" || got.Published != "3 hours ago" {
		t.Fatalf("legacy comment not parsed: %+v", got)
	}
}
