package youtube

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// dataAPIGet performs an official YouTube Data API v3 GET when an API key is configured.
func (c *Client) dataAPIGet(ctx context.Context, path string, query url.Values) ([]byte, error) {
	if c.apiKey == "" {
		return nil, &ExtractError{Code: "API_KEY_REQUIRED",
			Message: "This path needs an official YouTube Data API key. Set YOUTUBE_API_KEY or pass --api-key."}
	}
	if err := c.bill("dataapi:" + path); err != nil {
		return nil, err
	}
	query.Set("key", c.apiKey)
	endpoint := "https://www.googleapis.com/youtube/v3/" + path + "?" + query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, classifyNetworkError(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		snippet := string(body)
		if len(snippet) > 300 {
			snippet = snippet[:300]
		}
		return nil, &ExtractError{Code: "DATA_API_ERROR",
			Message:   fmt.Sprintf("YouTube Data API returned HTTP %d", resp.StatusCode),
			Retryable: resp.StatusCode == 403 || resp.StatusCode >= 500,
			Details:   map[string]any{"status": resp.StatusCode, "body": snippet}}
	}
	return body, nil
}

// SearchPreferAPI uses Data API when a key is set, otherwise InnerTube search.
func (c *Client) SearchPreferAPI(ctx context.Context, query string, limit int) (map[string]any, error) {
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
	cacheKey := query + "|" + strconv.Itoa(limit) + "|" + c.apiKeyPresence()
	var cached map[string]any
	if c.cacheGet("search", cacheKey, &cached) {
		cached["cacheHit"] = true
		return cached, nil
	}
	if c.apiKey != "" {
		out, err := c.searchDataAPI(ctx, query, limit)
		if err == nil {
			c.cacheSet("search", cacheKey, out)
			return out, nil
		}
		// Fall through to InnerTube on API failure.
	}
	out, err := c.Search(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	out["source"] = "innertube"
	c.cacheSet("search", cacheKey, out)
	return out, nil
}

func (c *Client) apiKeyPresence() string {
	if c.apiKey == "" {
		return "none"
	}
	return "api"
}

func (c *Client) searchDataAPI(ctx context.Context, query string, limit int) (map[string]any, error) {
	q := url.Values{}
	q.Set("part", "snippet")
	q.Set("q", query)
	q.Set("maxResults", strconv.Itoa(limit))
	q.Set("type", "video,channel,playlist")
	raw, err := c.dataAPIGet(ctx, "search", q)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Items []struct {
			ID struct {
				Kind       string `json:"kind"`
				VideoID    string `json:"videoId"`
				ChannelID  string `json:"channelId"`
				PlaylistID string `json:"playlistId"`
			} `json:"id"`
			Snippet struct {
				Title        string `json:"title"`
				ChannelTitle string `json:"channelTitle"`
			} `json:"snippet"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	var results []SearchResult
	for _, it := range resp.Items {
		r := SearchResult{Title: it.Snippet.Title, ChannelName: it.Snippet.ChannelTitle}
		switch {
		case it.ID.VideoID != "":
			r.Type, r.ID = "video", it.ID.VideoID
		case it.ID.ChannelID != "":
			r.Type, r.ID = "channel", it.ID.ChannelID
		case it.ID.PlaylistID != "":
			r.Type, r.ID = "playlist", it.ID.PlaylistID
		default:
			continue
		}
		results = append(results, r)
	}
	return map[string]any{
		"query": query, "results": results, "count": len(results),
		"source": "youtube_data_api_v3",
		"note":   "Official Data API result (stable). Set via YOUTUBE_API_KEY.",
	}, nil
}

// ChannelPreferAPI resolves channel via uploads playlist (UU…) and optional Data API.
func (c *Client) ChannelPreferAPI(ctx context.Context, input string, limit int) (map[string]any, error) {
	if limit <= 0 {
		limit = 20
	}
	browseID, handle, err := ParseChannelRef(input)
	if err != nil {
		return nil, err
	}
	cacheKey := browseID + "|" + handle + "|" + strconv.Itoa(limit)
	var cached map[string]any
	if c.cacheGet("channel", cacheKey, &cached) {
		cached["cacheHit"] = true
		return cached, nil
	}

	// Resolve handle → channel ID if needed.
	if browseID == "" && handle != "" {
		if c.apiKey != "" {
			if id, title, err := c.resolveChannelDataAPI(ctx, handle); err == nil {
				browseID = id
				out := map[string]any{"id": browseID, "handle": handle, "title": title, "source": "youtube_data_api_v3"}
				if vids, err := c.uploadsPlaylist(ctx, browseID, limit); err == nil {
					out["videos"] = vids
					out["count"] = len(vids)
				}
				c.cacheSet("channel", cacheKey, out)
				return out, nil
			}
		}
		// Fall back to existing InnerTube channel path.
		out, err := c.Channel(ctx, input, limit)
		if err != nil {
			return nil, err
		}
		// If videos empty, try uploads playlist once ID known.
		if id, _ := out["id"].(string); id != "" {
			if vids, err := c.uploadsPlaylist(ctx, id, limit); err == nil && len(vids) > 0 {
				out["videos"] = vids
				out["count"] = len(vids)
				out["videosSource"] = "uploads_playlist"
			}
		}
		out["source"] = "innertube"
		c.cacheSet("channel", cacheKey, out)
		return out, nil
	}

	out := map[string]any{"id": browseID, "handle": handle}
	if c.apiKey != "" {
		if meta, err := c.channelMetaDataAPI(ctx, browseID); err == nil {
			for k, v := range meta {
				out[k] = v
			}
			out["source"] = "youtube_data_api_v3"
		}
	}
	if vids, err := c.uploadsPlaylist(ctx, browseID, limit); err == nil {
		out["videos"] = vids
		out["count"] = len(vids)
		out["videosSource"] = "uploads_playlist"
	}
	if out["source"] == nil {
		// Fill title via InnerTube browse if needed.
		if inner, err := c.Channel(ctx, browseID, limit); err == nil {
			if out["title"] == nil {
				out["title"] = inner["title"]
			}
			if out["description"] == nil {
				out["description"] = inner["description"]
			}
			if out["count"] == nil || out["count"] == 0 {
				out["videos"] = inner["videos"]
				out["count"] = inner["count"]
			}
			out["source"] = "innertube"
		}
	}
	c.cacheSet("channel", cacheKey, out)
	return out, nil
}

func (c *Client) resolveChannelDataAPI(ctx context.Context, handle string) (id, title string, err error) {
	h := strings.TrimPrefix(handle, "@")
	q := url.Values{}
	q.Set("part", "snippet")
	q.Set("forHandle", h)
	raw, err := c.dataAPIGet(ctx, "channels", q)
	if err != nil {
		// older fallback: search
		sq := url.Values{}
		sq.Set("part", "snippet")
		sq.Set("q", handle)
		sq.Set("type", "channel")
		sq.Set("maxResults", "1")
		raw, err = c.dataAPIGet(ctx, "search", sq)
		if err != nil {
			return "", "", err
		}
		var sr struct {
			Items []struct {
				ID struct {
					ChannelID string `json:"channelId"`
				} `json:"id"`
				Snippet struct {
					Title string `json:"title"`
				} `json:"snippet"`
			} `json:"items"`
		}
		if err := json.Unmarshal(raw, &sr); err != nil || len(sr.Items) == 0 {
			return "", "", &ExtractError{Code: "CHANNEL_NOT_FOUND", Message: "Could not resolve handle via Data API"}
		}
		return sr.Items[0].ID.ChannelID, sr.Items[0].Snippet.Title, nil
	}
	var cr struct {
		Items []struct {
			ID      string `json:"id"`
			Snippet struct {
				Title string `json:"title"`
			} `json:"snippet"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &cr); err != nil || len(cr.Items) == 0 {
		return "", "", &ExtractError{Code: "CHANNEL_NOT_FOUND", Message: "Could not resolve handle via Data API"}
	}
	return cr.Items[0].ID, cr.Items[0].Snippet.Title, nil
}

func (c *Client) channelMetaDataAPI(ctx context.Context, id string) (map[string]any, error) {
	q := url.Values{}
	q.Set("part", "snippet,statistics")
	q.Set("id", id)
	raw, err := c.dataAPIGet(ctx, "channels", q)
	if err != nil {
		return nil, err
	}
	var cr struct {
		Items []struct {
			Snippet struct {
				Title       string `json:"title"`
				Description string `json:"description"`
				CustomURL   string `json:"customUrl"`
			} `json:"snippet"`
			Statistics struct {
				SubscriberCount string `json:"subscriberCount"`
				VideoCount      string `json:"videoCount"`
			} `json:"statistics"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &cr); err != nil || len(cr.Items) == 0 {
		return nil, &ExtractError{Code: "CHANNEL_NOT_FOUND", Message: "Channel not found in Data API"}
	}
	it := cr.Items[0]
	return map[string]any{
		"title": it.Snippet.Title, "description": it.Snippet.Description,
		"handle": it.Snippet.CustomURL, "subscribers": it.Statistics.SubscriberCount,
		"videoCount": it.Statistics.VideoCount,
	}, nil
}

// uploadsPlaylist fetches the channel uploads playlist (UC… → UU…).
func (c *Client) uploadsPlaylist(ctx context.Context, channelID string, limit int) ([]map[string]any, error) {
	if !strings.HasPrefix(channelID, "UC") || len(channelID) < 3 {
		return nil, &ExtractError{Code: "INVALID_CHANNEL", Message: "uploads playlist requires a UC… channel ID"}
	}
	listID := "UU" + channelID[2:]
	pl, err := c.Playlist(ctx, listID, limit)
	if err != nil {
		return nil, err
	}
	items, _ := pl["items"].([]PlaylistItem)
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		out = append(out, map[string]any{
			"id": it.ID, "title": it.Title, "lengthText": it.LengthText, "index": it.Index,
		})
	}
	return out, nil
}
