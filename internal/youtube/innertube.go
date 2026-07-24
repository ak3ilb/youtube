package youtube

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/cookiejar"
	"os"
	"time"
)

const (
	innertubeBase    = "https://www.youtube.com/youtubei/v1/"
	androidUserAgent = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip"
	webUserAgent     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
	maxRetries       = 3
)

type innertubeClient struct {
	Name      string
	Version   string
	NumericID string
	UserAgent string
	OSName    string
	OSVersion string
	SDKInt    int
}

// Client identities mirror yt-dlp's INNERTUBE_CLIENTS table.
var (
	clientANDROID = innertubeClient{Name: "ANDROID", Version: "20.10.38", NumericID: "3", UserAgent: androidUserAgent, OSName: "Android", OSVersion: "14", SDKInt: 34}
	clientIOS     = innertubeClient{Name: "IOS", Version: "20.10.4", NumericID: "5", UserAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", OSName: "iOS", OSVersion: "18.3.2.22D82"}
	clientWEB     = innertubeClient{Name: "WEB", Version: "2.20250312.04.00", NumericID: "1", UserAgent: webUserAgent}
	clientTVEmbed = innertubeClient{Name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", Version: "2.0", NumericID: "85", UserAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"}
)

// Player clients prefer ANDROID/IOS for direct stream URLs; WEB/TV for next/browse.
var playerClients = []innertubeClient{clientANDROID, clientIOS, clientWEB, clientTVEmbed}
var webClients = []innertubeClient{clientWEB}

// Client performs extraction with a shared HTTP client and optional cookies.
type Client struct {
	http        *http.Client
	cookiesPath string
	apiKey      string
	cache       *diskCache
}

// NewClient builds a Client with the given timeout (default 30s).
func NewClient(timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	jar, _ := cookiejar.New(nil)
	return &Client{http: &http.Client{Timeout: timeout, Jar: jar}}
}

// WithCookies loads a Netscape cookies.txt file into the client's jar.
func (c *Client) WithCookies(path string) error {
	if path == "" {
		return nil
	}
	if err := loadNetscapeCookies(c.http.Jar, path); err != nil {
		return err
	}
	c.cookiesPath = path
	return nil
}

// call posts to an InnerTube endpoint with retry on 429/5xx.
func (c *Client) call(ctx context.Context, endpoint string, profile innertubeClient, payload map[string]any) ([]byte, error) {
	if err := c.bill("innertube:" + endpoint); err != nil {
		return nil, err
	}
	clientCtx := map[string]any{
		"clientName":    profile.Name,
		"clientVersion": profile.Version,
		"hl":            "en",
		"gl":            "US",
	}
	if profile.OSName != "" {
		clientCtx["osName"] = profile.OSName
		clientCtx["osVersion"] = profile.OSVersion
	}
	if profile.SDKInt > 0 {
		clientCtx["androidSdkVersion"] = profile.SDKInt
	}
	if visitorData := os.Getenv("YTUBE_VISITOR_DATA"); visitorData != "" {
		clientCtx["visitorData"] = visitorData
	}
	body := map[string]any{"context": map[string]any{"client": clientCtx}}
	// A PO token minted by the user's browser unblocks streams and captions that
	// YouTube now gates on BotGuard attestation.
	if poToken := os.Getenv("YTUBE_PO_TOKEN"); poToken != "" && endpoint == "player" {
		body["serviceIntegrityDimensions"] = map[string]any{"poToken": poToken}
	}
	for k, v := range payload {
		body[k] = v
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	url := innertubeBase + endpoint + "?prettyPrint=false"
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(200*(1<<attempt)+rand.Intn(200)) * time.Millisecond
			select {
			case <-ctx.Done():
				return nil, classifyNetworkError(ctx.Err())
			case <-time.After(backoff):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", profile.UserAgent)
		req.Header.Set("X-YouTube-Client-Name", profile.NumericID)
		req.Header.Set("X-YouTube-Client-Version", profile.Version)
		req.Header.Set("Origin", "https://www.youtube.com")
		if auth := sapisidHash(c.http.Jar); auth != "" {
			req.Header.Set("Authorization", auth)
			req.Header.Set("X-Origin", "https://www.youtube.com")
		}
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = classifyNetworkError(err)
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		if readErr != nil {
			lastErr = classifyNetworkError(readErr)
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			lastErr = httpStatusError(resp.StatusCode)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			return nil, httpStatusError(resp.StatusCode)
		}
		return data, nil
	}
	if lastErr == nil {
		lastErr = &ExtractError{Code: "RATE_LIMITED", Message: "YouTube rate-limited the request after retries", Retryable: true}
	}
	return nil, lastErr
}

// callJSON is call() plus JSON unmarshal into dest.
func (c *Client) callJSON(ctx context.Context, endpoint string, profile innertubeClient, payload map[string]any, dest any) error {
	data, err := c.call(ctx, endpoint, profile, payload)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, dest); err != nil {
		return &ExtractError{Code: "INVALID_RESPONSE", Retryable: true,
			Message: "YouTube returned malformed JSON", Details: map[string]any{"cause": err.Error(), "endpoint": endpoint}}
	}
	return nil
}

func classifyNetworkError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return &ExtractError{Code: "TIMEOUT", Message: "The YouTube request timed out", Retryable: true,
			Details: map[string]any{"cause": err.Error()}}
	}
	return &ExtractError{Code: "NETWORK_ERROR", Message: "Could not connect to YouTube (check your internet connection or proxy)",
		Retryable: true, Details: map[string]any{"cause": err.Error()}}
}

func httpStatusError(status int) *ExtractError {
	switch status {
	case http.StatusTooManyRequests:
		return &ExtractError{Code: "RATE_LIMITED", Message: "YouTube rate-limited the request (HTTP 429); wait and retry", Retryable: true,
			Details: map[string]any{"status": status}}
	case http.StatusForbidden:
		return &ExtractError{Code: "ACCESS_DENIED", Message: "YouTube denied the request (HTTP 403); this client may now require a PO token",
			Details: map[string]any{"status": status}}
	default:
		return &ExtractError{Code: "YOUTUBE_HTTP_ERROR", Message: fmt.Sprintf("YouTube returned HTTP %d", status),
			Retryable: status >= 500, Details: map[string]any{"status": status}}
	}
}
