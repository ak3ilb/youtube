package youtube

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	defaultCacheTTL  = 30 * time.Minute
	defaultRateLimit = 60 // video-ish requests per hour
	rateWindow       = time.Hour
)

// CacheConfig controls disk cache and soft rate budgeting.
type CacheConfig struct {
	Dir       string
	TTL       time.Duration
	RateLimit int // max billable calls per hour; 0 disables
	Disable   bool
}

func defaultCacheDir() string {
	if d := os.Getenv("YTUBE_CACHE_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(os.TempDir(), "youtube-client-cache")
	}
	return filepath.Join(home, ".cache", "youtube-client")
}

func (c *Client) initCache() {
	if c.cache != nil {
		return
	}
	ttl := defaultCacheTTL
	if v := os.Getenv("YTUBE_CACHE_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			ttl = d
		}
	}
	limit := defaultRateLimit
	if v := os.Getenv("YTUBE_RATE_LIMIT"); v == "0" {
		limit = 0
	}
	c.cache = &diskCache{
		dir:   defaultCacheDir(),
		ttl:   ttl,
		limit: limit,
		mu:    &sync.Mutex{},
	}
	if os.Getenv("YTUBE_CACHE") == "0" || os.Getenv("YTUBE_CACHE") == "false" {
		c.cache.disabled = true
	}
}

// WithAPIKey enables optional official YouTube Data API v3 for search/channel.
func (c *Client) WithAPIKey(key string) *Client {
	c.apiKey = key
	return c
}

// SetCacheDir overrides the on-disk cache location.
func (c *Client) SetCacheDir(dir string) *Client {
	c.initCache()
	if dir != "" {
		c.cache.dir = dir
	}
	return c
}

type diskCache struct {
	dir      string
	ttl      time.Duration
	limit    int
	disabled bool
	mu       *sync.Mutex
}

type cacheEntry struct {
	SavedAt time.Time       `json:"savedAt"`
	Payload json.RawMessage `json:"payload"`
}

type rateFile struct {
	Times []time.Time `json:"times"`
}

func (d *diskCache) keyPath(namespace, key string) string {
	sum := sha1.Sum([]byte(namespace + "|" + key))
	return filepath.Join(d.dir, hex.EncodeToString(sum[:])+".json")
}

func (d *diskCache) get(namespace, key string, dest any) bool {
	if d == nil || d.disabled {
		return false
	}
	path := d.keyPath(namespace, key)
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var entry cacheEntry
	if err := json.Unmarshal(raw, &entry); err != nil {
		return false
	}
	if time.Since(entry.SavedAt) > d.ttl {
		_ = os.Remove(path)
		return false
	}
	return json.Unmarshal(entry.Payload, dest) == nil
}

func (d *diskCache) set(namespace, key string, value any) {
	if d == nil || d.disabled {
		return
	}
	_ = os.MkdirAll(d.dir, 0o755)
	payload, err := json.Marshal(value)
	if err != nil {
		return
	}
	entry, _ := json.Marshal(cacheEntry{SavedAt: time.Now().UTC(), Payload: payload})
	_ = os.WriteFile(d.keyPath(namespace, key), entry, 0o644)
}

// consumeRate records a billable network action; returns RATE_BUDGET_EXCEEDED when over limit.
func (d *diskCache) consumeRate(label string) error {
	if d == nil || d.limit <= 0 {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = os.MkdirAll(d.dir, 0o755)
	path := filepath.Join(d.dir, "rate-budget.json")
	var rf rateFile
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &rf)
	}
	now := time.Now().UTC()
	cutoff := now.Add(-rateWindow)
	kept := rf.Times[:0]
	for _, t := range rf.Times {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= d.limit {
		retryAfter := kept[0].Add(rateWindow).Sub(now)
		if retryAfter < 0 {
			retryAfter = time.Minute
		}
		return &ExtractError{
			Code:      "RATE_BUDGET_EXCEEDED",
			Message:   "Local rate budget exceeded to protect your IP from YouTube throttling. Wait and retry, raise YTUBE_RATE_LIMIT, or set YTUBE_RATE_LIMIT=0 to disable.",
			Retryable: true,
			Details: map[string]any{
				"limit":         d.limit,
				"window":        "1h",
				"used":          len(kept),
				"action":        label,
				"retryAfterSec": int(retryAfter.Seconds()) + 1,
				"suggestion":    "Cache hits do not consume budget. Prefer get_video_pack / transcript for repeated analysis of the same video.",
			},
		}
	}
	kept = append(kept, now)
	rf.Times = kept
	raw, _ := json.Marshal(rf)
	_ = os.WriteFile(path, raw, 0o644)
	return nil
}

func (c *Client) bill(label string) error {
	c.initCache()
	return c.cache.consumeRate(label)
}

func (c *Client) cacheGet(ns, key string, dest any) bool {
	c.initCache()
	return c.cache.get(ns, key, dest)
}

func (c *Client) cacheSet(ns, key string, value any) {
	c.initCache()
	c.cache.set(ns, key, value)
}
