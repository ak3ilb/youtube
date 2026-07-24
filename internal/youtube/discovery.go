package youtube

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
)

var (
	playlistIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{10,}$`)
	channelIDPattern  = regexp.MustCompile(`^UC[A-Za-z0-9_-]{22}$`)
)

// ParsePlaylistID extracts a playlist ID from a URL or bare ID.
func ParsePlaylistID(input string) (string, error) {
	input = strings.TrimSpace(input)
	if playlistIDPattern.MatchString(input) && (strings.HasPrefix(input, "PL") || strings.HasPrefix(input, "UU") ||
		strings.HasPrefix(input, "LL") || strings.HasPrefix(input, "FL") || strings.HasPrefix(input, "OL")) {
		return input, nil
	}
	u, err := url.Parse(input)
	if err != nil || u.Host == "" {
		if !strings.Contains(input, "://") && strings.Contains(input, "list=") {
			return ParsePlaylistID("https://www.youtube.com/playlist?" + strings.TrimPrefix(input, "?"))
		}
		return "", &ExtractError{Code: "INVALID_PLAYLIST", Message: "Expected a playlist ID or youtube.com/playlist?list=... URL",
			Details: map[string]any{"input": input}}
	}
	list := u.Query().Get("list")
	if list == "" {
		return "", &ExtractError{Code: "INVALID_PLAYLIST", Message: "URL does not contain a list= playlist ID",
			Details: map[string]any{"input": input}}
	}
	return list, nil
}

// PlaylistItem is one video in a playlist.
type PlaylistItem struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	ChannelName string `json:"channelName,omitempty"`
	Index       int    `json:"index"`
	LengthText  string `json:"lengthText,omitempty"`
}

// Playlist returns playlist metadata and a limited list of items.
func (c *Client) Playlist(ctx context.Context, input string, limit int) (map[string]any, error) {
	listID, err := ParsePlaylistID(input)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	browseID := listID
	if !strings.HasPrefix(browseID, "VL") {
		browseID = "VL" + listID
	}
	data, err := c.call(ctx, "browse", clientWEB, map[string]any{"browseId": browseID})
	if err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	title := ""
	owner := ""
	walkJSON(root, func(key string, val any) bool {
		if key == "playlistSidebarPrimaryInfoRenderer" {
			if m, ok := val.(map[string]any); ok && title == "" {
				title = runsText(m["title"])
			}
		}
		if key == "playlistSidebarSecondaryInfoRenderer" {
			if m, ok := val.(map[string]any); ok && owner == "" {
				if vom, ok := nested(m, "videoOwner", "videoOwnerRenderer").(map[string]any); ok {
					owner = runsText(vom["title"])
				}
			}
		}
		return true
	})
	items := parsePlaylistVideos(root, limit)
	return map[string]any{
		"id": listID, "title": title, "owner": owner,
		"items": items, "count": len(items),
	}, nil
}

func parsePlaylistVideos(root map[string]any, limit int) []PlaylistItem {
	var items []PlaylistItem
	walkJSON(root, func(key string, val any) bool {
		if len(items) >= limit {
			return true
		}
		m, ok := val.(map[string]any)
		if !ok {
			return true
		}
		switch key {
		case "playlistVideoRenderer":
			vid := asString(m["videoId"])
			if vid == "" {
				return true
			}
			idx := int(toInt64(asString(nested(m, "index", "simpleText"))))
			items = append(items, PlaylistItem{
				ID: vid, Title: runsText(m["title"]), Index: idx,
				ChannelName: runsText(m["shortBylineText"]),
				LengthText:  asString(nested(m, "lengthText", "simpleText")),
			})
		case "lockupViewModel":
			vid := asString(m["contentId"])
			if !videoIDPattern.MatchString(vid) {
				return true
			}
			title := asString(nested(m, "metadata", "lockupMetadataViewModel", "title", "content"))
			if title == "" {
				title = asString(nested(m, "metadata", "lockupMetadataViewModel", "title", "runs", "0", "text"))
			}
			items = append(items, PlaylistItem{
				ID: vid, Title: title, Index: len(items) + 1,
			})
		}
		return true
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items
}

// ParseChannelRef resolves /@handle, /channel/UC..., /c/, /user/ or a bare UC ID.
func ParseChannelRef(input string) (browseID string, handle string, err error) {
	input = strings.TrimSpace(input)
	if channelIDPattern.MatchString(input) {
		return input, "", nil
	}
	if strings.HasPrefix(input, "@") {
		return "", input, nil
	}
	if !strings.Contains(input, "://") && (strings.HasPrefix(input, "youtube.com") || strings.HasPrefix(input, "www.youtube.com")) {
		input = "https://" + input
	}
	u, err := url.Parse(input)
	if err != nil || u.Host == "" {
		return "", "", &ExtractError{Code: "INVALID_CHANNEL",
			Message: "Expected a channel ID (UC...), @handle, or youtube.com/@handle /channel/ /c/ URL",
			Details: map[string]any{"input": input}}
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", "", &ExtractError{Code: "INVALID_CHANNEL", Message: "Could not parse channel from URL"}
	}
	switch {
	case strings.HasPrefix(parts[0], "@"):
		return "", parts[0], nil
	case parts[0] == "channel" && len(parts) >= 2:
		return parts[1], "", nil
	case parts[0] == "c" && len(parts) >= 2:
		return "", "@" + parts[1], nil
	case parts[0] == "user" && len(parts) >= 2:
		return "", parts[1], nil
	default:
		return "", "", &ExtractError{Code: "INVALID_CHANNEL", Message: "Unrecognized channel URL shape",
			Details: map[string]any{"input": input}}
	}
}

// resolveChannelBrowseID turns an @handle or legacy username into a UC… id.
// InnerTube's navigation/resolve_url is authoritative; channel search is only a
// fallback because it can return a similarly named channel.
func (c *Client) resolveChannelBrowseID(ctx context.Context, handle string) (string, error) {
	if handle == "" {
		return "", &ExtractError{Code: "INVALID_CHANNEL", Message: "No channel handle to resolve"}
	}
	var cached string
	if c.cacheGet("channel-handle", handle, &cached) && cached != "" {
		return cached, nil
	}

	path := strings.TrimPrefix(handle, "/")
	if !strings.HasPrefix(path, "@") {
		path = "@" + path
	}
	if data, err := c.call(ctx, "navigation/resolve_url", clientWEB,
		map[string]any{"url": "https://www.youtube.com/" + path}); err == nil {
		var root map[string]any
		if json.Unmarshal(data, &root) == nil {
			id := ""
			walkJSON(root, func(key string, val any) bool {
				if key == "browseEndpoint" {
					if m, ok := val.(map[string]any); ok && id == "" {
						if candidate := asString(m["browseId"]); channelIDPattern.MatchString(candidate) {
							id = candidate
						}
					}
				}
				return id == ""
			})
			if id != "" {
				c.cacheSet("channel-handle", handle, id)
				return id, nil
			}
		}
	}

	data, err := c.call(ctx, "search", clientWEB, map[string]any{
		"query": handle, "params": "EgIQAg%3D%3D", // channels filter
	})
	if err != nil {
		return "", err
	}
	var root map[string]any
	_ = json.Unmarshal(data, &root)
	id := ""
	walkJSON(root, func(key string, val any) bool {
		if key == "channelRenderer" {
			if m, ok := val.(map[string]any); ok && id == "" {
				id = asString(m["channelId"])
			}
		}
		return id == ""
	})
	if id == "" {
		return "", &ExtractError{Code: "CHANNEL_NOT_FOUND",
			Message: "Could not resolve channel handle " + handle,
			Details: map[string]any{"handle": handle}}
	}
	c.cacheSet("channel-handle", handle, id)
	return id, nil
}

// Channel returns channel metadata and a sample of recent videos.
func (c *Client) Channel(ctx context.Context, input string, limit int) (map[string]any, error) {
	browseID, handle, err := ParseChannelRef(input)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 20
	}
	payload := map[string]any{}
	if browseID == "" {
		browseID, err = c.resolveChannelBrowseID(ctx, handle)
		if err != nil {
			return nil, err
		}
	}
	payload["browseId"] = browseID
	data, err := c.call(ctx, "browse", clientWEB, payload)
	if err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	title, description, subscribers := "", "", ""
	walkJSON(root, func(key string, val any) bool {
		if key == "channelMetadataRenderer" {
			if m, ok := val.(map[string]any); ok {
				title = asString(m["title"])
				description = asString(m["description"])
			}
		}
		if key == "subscriberCountText" && subscribers == "" {
			subscribers = runsText(val)
			if subscribers == "" {
				subscribers = asString(nested(mustMap(val), "simpleText"))
			}
		}
		return true
	})
	var videos []map[string]any
	walkJSON(root, func(key string, val any) bool {
		if key != "richItemRenderer" && key != "gridVideoRenderer" && key != "videoRenderer" {
			return true
		}
		m := mustMap(val)
		if key == "richItemRenderer" {
			m = mustMap(nested(m, "content", "videoRenderer"))
			if m == nil {
				m = mustMap(nested(mustMap(val), "content", "lockupViewModel"))
			}
		}
		if m == nil {
			return true
		}
		vid := asString(m["videoId"])
		if vid == "" {
			return true
		}
		videos = append(videos, map[string]any{
			"id": vid, "title": runsText(m["title"]),
			"lengthText": asString(nested(m, "lengthText", "simpleText")),
		})
		return len(videos) < limit
	})
	return map[string]any{
		"id": browseID, "handle": handle, "title": title,
		"description": description, "subscribers": subscribers,
		"videos": videos, "count": len(videos),
	}, nil
}

func mustMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// SearchResult is one search hit.
type SearchResult struct {
	Type        string `json:"type"` // video | channel | playlist
	ID          string `json:"id"`
	Title       string `json:"title"`
	ChannelName string `json:"channelName,omitempty"`
	LengthText  string `json:"lengthText,omitempty"`
	ViewCount   string `json:"viewCount,omitempty"`
}

// Search queries YouTube and returns mixed results.
func (c *Client) Search(ctx context.Context, query string, limit int) (map[string]any, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, &ExtractError{Code: "USAGE", Message: "search query must not be empty"}
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	data, err := c.call(ctx, "search", clientWEB, map[string]any{"query": query})
	if err != nil {
		return nil, err
	}
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	var results []SearchResult
	walkJSON(root, func(key string, val any) bool {
		if len(results) >= limit {
			return true
		}
		m, ok := val.(map[string]any)
		if !ok {
			return true
		}
		switch key {
		case "videoRenderer":
			results = append(results, SearchResult{
				Type: "video", ID: asString(m["videoId"]), Title: runsText(m["title"]),
				ChannelName: runsText(m["ownerText"]),
				LengthText:  asString(nested(m, "lengthText", "simpleText")),
				ViewCount:   runsText(m["viewCountText"]),
			})
		case "channelRenderer":
			results = append(results, SearchResult{
				Type: "channel", ID: asString(m["channelId"]), Title: runsText(m["title"]),
			})
		case "playlistRenderer":
			results = append(results, SearchResult{
				Type: "playlist", ID: asString(m["playlistId"]), Title: runsText(m["title"]),
				ChannelName: runsText(m["longBylineText"]),
			})
		}
		return true
	})
	if len(results) > limit {
		results = results[:limit]
	}
	return map[string]any{"query": query, "results": results, "count": len(results)}, nil
}
