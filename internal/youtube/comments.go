package youtube

import (
	"context"
	"encoding/json"
	"strings"
)

// Comment is one comment, with replies attached when they were requested.
type Comment struct {
	ID         string    `json:"id,omitempty"`
	Author     string    `json:"author"`
	Text       string    `json:"text"`
	LikeCount  string    `json:"likeCount,omitempty"`
	Published  string    `json:"published,omitempty"`
	IsPinned   bool      `json:"isPinned"`
	ReplyCount int       `json:"replyCount,omitempty"`
	Replies    []Comment `json:"replies,omitempty"`

	// replyToken is the continuation used to expand this thread's replies.
	replyToken string
}

// CommentsOptions controls comment paging, ordering, and reply expansion.
type CommentsOptions struct {
	Limit int
	Sort  string // top | newest
	// Cursor resumes from a previous call's nextCursor instead of re-reading page one.
	Cursor string
	// Replies caps how many threads get their replies fetched; each costs one request.
	Replies int
}

// Comments fetches top-level comments for a video.
func (c *Client) Comments(ctx context.Context, input string, limit int, sort string) (map[string]any, error) {
	return c.CommentsWithOptions(ctx, input, CommentsOptions{Limit: limit, Sort: sort})
}

// CommentsWithOptions fetches comments with ordering, paging, and replies.
func (c *Client) CommentsWithOptions(ctx context.Context, input string, opts CommentsOptions) (map[string]any, error) {
	id, err := ParseVideoID(input)
	if err != nil {
		return nil, err
	}
	if opts.Limit <= 0 {
		opts.Limit = 20
	}
	if opts.Limit > 100 {
		opts.Limit = 100
	}
	sort := sortOrDefault(opts.Sort)

	token := opts.Cursor
	if token == "" {
		data, err := c.call(ctx, "next", clientWEB, map[string]any{"videoId": id})
		if err != nil {
			return nil, err
		}
		var root map[string]any
		if err := json.Unmarshal(data, &root); err != nil {
			return nil, &ExtractError{Code: "INVALID_RESPONSE", Retryable: true,
				Message: "Malformed next response while looking for comments"}
		}
		token = findCommentsContinuation(root)
		if token == "" {
			return map[string]any{"videoId": id, "comments": []Comment{}, "count": 0,
				"sort": sort, "note": "YouTube returned no comment section for this video (comments may be disabled)"}, nil
		}
	}

	var comments []Comment
	seen := map[string]bool{}
	sortApplied := opts.Cursor != "" // a resumed cursor already carries its ordering
	nextToken := ""

	for token != "" && len(comments) < opts.Limit {
		page, err := c.call(ctx, "next", clientWEB, map[string]any{"continuation": token})
		if err != nil {
			if len(comments) == 0 {
				return nil, err
			}
			break
		}
		var pageRoot map[string]any
		if err := json.Unmarshal(page, &pageRoot); err != nil {
			break
		}

		// The sort menu only appears on the first comments page.
		if !sortApplied {
			sortApplied = true
			if sortToken := pickSortToken(pageRoot, sort); sortToken != "" && sortToken != token {
				token = sortToken
				continue
			}
		}

		batch, next := parseCommentPage(pageRoot)
		for _, cm := range batch {
			key := cm.ID
			if key == "" {
				key = cm.Author + "|" + cm.Text
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			comments = append(comments, cm)
			if len(comments) >= opts.Limit {
				break
			}
		}
		if next == "" || next == token {
			nextToken = ""
			break
		}
		nextToken = next
		token = next
	}

	repliesFetched := 0
	for i := range comments {
		if repliesFetched >= opts.Replies {
			break
		}
		if comments[i].replyToken == "" {
			continue
		}
		replies, err := c.fetchReplies(ctx, comments[i].replyToken)
		if err != nil {
			break
		}
		comments[i].Replies = replies
		repliesFetched++
	}

	out := map[string]any{
		"videoId": id, "comments": comments, "count": len(comments), "sort": sort,
	}
	if nextToken != "" && len(comments) >= opts.Limit {
		out["nextCursor"] = nextToken
		out["hasMore"] = true
	}
	return out, nil
}

func (c *Client) fetchReplies(ctx context.Context, token string) ([]Comment, error) {
	page, err := c.call(ctx, "next", clientWEB, map[string]any{"continuation": token})
	if err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(page, &root); err != nil {
		return nil, err
	}
	replies, _ := parseCommentPage(root)
	return replies, nil
}

func sortOrDefault(s string) string {
	if strings.EqualFold(s, "newest") {
		return "newest"
	}
	return "top"
}

// pickSortToken finds the continuation for the requested ordering in YouTube's
// comment sort menu. Item titles have shipped as both "Top"/"Newest" and
// "Top comments"/"Newest first", so match on the distinguishing word.
func pickSortToken(root map[string]any, sort string) string {
	want := "top"
	if sort == "newest" {
		want = "newest"
	}
	found := ""
	walkJSON(root, func(key string, val any) bool {
		if key != "sortFilterSubMenuRenderer" {
			return true
		}
		m, ok := val.(map[string]any)
		if !ok {
			return true
		}
		items, _ := m["subMenuItems"].([]any)
		for _, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			title := strings.ToLower(asString(item["title"]))
			if !strings.Contains(title, want) {
				continue
			}
			if selected, ok := item["selected"].(bool); ok && selected {
				return false // already ordered the way we want
			}
			if token := asString(nested(item, "serviceEndpoint", "continuationCommand", "token")); token != "" {
				found = token
			}
			return false
		}
		return true
	})
	return found
}

// findCommentsContinuation locates the comment section token in a next response.
func findCommentsContinuation(root map[string]any) string {
	var tokens []string
	walkJSON(root, func(key string, val any) bool {
		if key != "continuationEndpoint" && key != "nextContinuationData" && key != "continuationCommand" {
			return true
		}
		if m, ok := val.(map[string]any); ok {
			if t := asString(m["token"]); t != "" {
				tokens = append(tokens, t)
			}
			if cmd, ok := m["continuationCommand"].(map[string]any); ok {
				if t := asString(cmd["token"]); t != "" {
					tokens = append(tokens, t)
				}
			}
		}
		return true
	})
	if len(tokens) == 0 {
		return ""
	}
	for _, t := range tokens {
		if strings.Contains(t, "comments") || len(t) > 40 {
			return t
		}
	}
	return tokens[0]
}

// commentPayloads indexes the entity payloads that carry comment text in
// YouTube's current response shape, keyed by comment id.
func commentPayloads(root map[string]any) map[string]Comment {
	out := map[string]Comment{}
	walkJSON(root, func(key string, val any) bool {
		if key != "commentEntityPayload" {
			return true
		}
		m, ok := val.(map[string]any)
		if !ok {
			return true
		}
		id := asString(nested(m, "properties", "commentId"))
		text := asString(nested(m, "properties", "content", "content"))
		if id == "" || text == "" {
			return true
		}
		out[id] = Comment{
			ID:         id,
			Author:     asString(nested(m, "author", "displayName")),
			Text:       text,
			LikeCount:  asString(nested(m, "toolbar", "likeCountLiked")),
			Published:  asString(nested(m, "properties", "publishedTime")),
			ReplyCount: int(toInt64(asString(nested(m, "toolbar", "replyCount")))),
		}
		return true
	})
	return out
}

// parseCommentPage reads one continuation page. Threads are parsed individually
// so each comment keeps its own reply continuation token.
func parseCommentPage(root map[string]any) ([]Comment, string) {
	payloads := commentPayloads(root)
	var comments []Comment

	walkJSON(root, func(key string, val any) bool {
		if key != "commentThreadRenderer" {
			return true
		}
		thread, ok := val.(map[string]any)
		if !ok {
			return true
		}
		if cm, ok := commentFromThread(thread, payloads); ok {
			comments = append(comments, cm)
		}
		return true
	})

	if len(comments) == 0 {
		comments = flatComments(root, payloads)
	}
	return comments, findPageContinuation(root)
}

func commentFromThread(thread map[string]any, payloads map[string]Comment) (Comment, bool) {
	var cm Comment
	if id := asString(nested(thread, "commentViewModel", "commentViewModel", "commentId")); id != "" {
		cm = payloads[id]
		cm.ID = id
	} else if id := asString(nested(thread, "commentViewModel", "commentId")); id != "" {
		cm = payloads[id]
		cm.ID = id
	}
	if cm.Text == "" {
		if legacy, ok := nested(thread, "comment", "commentRenderer").(map[string]any); ok {
			cm = commentFromRenderer(legacy)
		}
	}
	if cm.Text == "" {
		return cm, false
	}
	cm.IsPinned = threadHasPinnedBadge(thread)
	cm.replyToken = threadReplyToken(thread)
	return cm, true
}

func threadHasPinnedBadge(thread map[string]any) bool {
	pinned := false
	walkJSON(thread, func(key string, val any) bool {
		if key == "pinnedCommentBadge" || key == "pinnedText" {
			pinned = true
		}
		return !pinned
	})
	return pinned
}

func threadReplyToken(thread map[string]any) string {
	replies, ok := thread["replies"].(map[string]any)
	if !ok {
		return ""
	}
	token := ""
	walkJSON(replies, func(key string, val any) bool {
		if key != "continuationItemRenderer" {
			return true
		}
		if m, ok := val.(map[string]any); ok && token == "" {
			token = asString(nested(m, "continuationEndpoint", "continuationCommand", "token"))
		}
		return token == ""
	})
	return token
}

func commentFromRenderer(m map[string]any) Comment {
	text := runsText(m["contentText"])
	author := asString(nested(m, "authorText", "simpleText"))
	if author == "" {
		author = runsText(m["authorText"])
	}
	return Comment{
		ID:         asString(m["commentId"]),
		Author:     author,
		Text:       text,
		LikeCount:  asString(nested(m, "voteCount", "simpleText")),
		Published:  runsText(m["publishedTimeText"]),
		IsPinned:   m["pinnedCommentBadge"] != nil,
		ReplyCount: int(toInt64(m["replyCount"])),
	}
}

// flatComments handles reply pages and older shapes where comments are not
// wrapped in thread renderers.
func flatComments(root map[string]any, payloads map[string]Comment) []Comment {
	var comments []Comment
	seen := map[string]bool{}
	walkJSON(root, func(key string, val any) bool {
		if key == "commentRenderer" {
			if m, ok := val.(map[string]any); ok {
				if cm := commentFromRenderer(m); cm.Text != "" && !seen[cm.Text] {
					seen[cm.Text] = true
					comments = append(comments, cm)
				}
			}
		}
		return true
	})
	if len(comments) > 0 {
		return comments
	}
	// Entity payloads only: preserve view-model order when available.
	var order []string
	walkJSON(root, func(key string, val any) bool {
		if key == "commentViewModel" {
			if m, ok := val.(map[string]any); ok {
				if id := asString(m["commentId"]); id != "" {
					order = append(order, id)
				}
			}
		}
		return true
	})
	for _, id := range order {
		if cm, ok := payloads[id]; ok && !seen[id] {
			seen[id] = true
			comments = append(comments, cm)
		}
	}
	if len(comments) == 0 {
		for _, cm := range payloads {
			comments = append(comments, cm)
		}
	}
	return comments
}

func findPageContinuation(root map[string]any) string {
	next := ""
	walkJSON(root, func(key string, val any) bool {
		if key != "continuationEndpoint" && key != "continuationCommand" {
			return true
		}
		if m, ok := val.(map[string]any); ok {
			if t := asString(m["token"]); t != "" {
				next = t
			}
			if cmd, ok := m["continuationCommand"].(map[string]any); ok {
				if t := asString(cmd["token"]); t != "" {
					next = t
				}
			}
		}
		return true
	})
	return next
}
