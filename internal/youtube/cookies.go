package youtube

import (
	"bufio"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// loadNetscapeCookies parses a Netscape cookies.txt file into jar.
func loadNetscapeCookies(jar http.CookieJar, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return &ExtractError{Code: "COOKIES_INVALID",
			Message: "Could not open cookies file: " + err.Error(),
			Details: map[string]any{"path": path}}
	}
	defer f.Close()

	var cookies []*http.Cookie
	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			// Netscape httpOnly marker: #HttpOnly_.youtube.com ...
			if strings.HasPrefix(line, "#HttpOnly_") {
				line = strings.TrimPrefix(line, "#HttpOnly_")
			} else {
				continue
			}
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 7 {
			continue
		}
		domain := fields[0]
		secure := strings.EqualFold(fields[3], "TRUE")
		expires, _ := strconv.ParseInt(fields[4], 10, 64)
		name, value := fields[5], fields[6]
		c := &http.Cookie{Name: name, Value: value, Path: fields[2], Domain: strings.TrimPrefix(domain, "."), Secure: secure}
		if expires > 0 {
			c.Expires = time.Unix(expires, 0)
		}
		cookies = append(cookies, c)
	}
	if err := scanner.Err(); err != nil {
		return &ExtractError{Code: "COOKIES_INVALID", Message: "Failed reading cookies file: " + err.Error()}
	}
	if len(cookies) == 0 {
		return &ExtractError{Code: "COOKIES_INVALID",
			Message: "No cookies found in file; export a Netscape cookies.txt from your browser",
			Details: map[string]any{"path": path}}
	}
	u, _ := url.Parse("https://www.youtube.com")
	jar.SetCookies(u, cookies)
	return nil
}

// sapisidHash builds the Authorization header YouTube expects for logged-in
// InnerTube calls: SAPISIDHASH timestamp_hex(sha1(timestamp + " " + SAPISID + " " + origin)).
func sapisidHash(jar http.CookieJar) string {
	if jar == nil {
		return ""
	}
	u, _ := url.Parse("https://www.youtube.com")
	var sapisid string
	for _, c := range jar.Cookies(u) {
		if c.Name == "SAPISID" || c.Name == "__Secure-3PAPISID" {
			sapisid = c.Value
			break
		}
	}
	if sapisid == "" {
		return ""
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	origin := "https://www.youtube.com"
	sum := sha1.Sum([]byte(ts + " " + sapisid + " " + origin))
	return fmt.Sprintf("SAPISIDHASH %s_%s", ts, hex.EncodeToString(sum[:]))
}
