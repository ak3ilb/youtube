# youtube-video-mcp

A standalone MCP (Model Context Protocol) server for single-video YouTube operations, written in **TypeScript** with a native **Go** extraction engine.

- **No yt-dlp. No Python. No third-party YouTube libraries.** The extraction engine reimplements the approach yt-dlp uses — YouTube's internal InnerTube API with mobile client identities (ANDROID / IOS / WEB fallback) — directly in Go.
- **Platform independent.** The Go engine cross-compiles to a static binary for macOS, Linux, and Windows (arm64 + x64).
- **Structured errors everywhere.** Every failure returns a machine-readable code (`NO_CAPTIONS`, `RATE_LIMITED`, `AUTH_REQUIRED`, ...), a human message, details, and a `retryable` flag.

## Tools

All tools accept `urlOrId`: a watch / youtu.be / shorts / embed / live URL, or a bare 11-character video ID.

| Tool | What it does |
| --- | --- |
| `get_video_info` | Title, description, channel, duration, views, publish date, category, keywords, thumbnails |
| `get_transcript` | Timed caption segments + joined plain text; optional `lang`; prefers manual over auto-generated |
| `list_captions` | All caption tracks with language codes and ASR/manual flags |
| `get_chapters` | Chapters parsed from the description (YouTube's own rules: starts at 0:00, ascending) |
| `get_thumbnails` | Every thumbnail rendition with dimensions |
| `list_formats` | Stream formats: itag, mime, quality, bitrate, `directUrl` flag |
| `download_media` | Download a format by itag (or best muxed) to a local path |

## Install & use with Cursor / Claude

```bash
git clone https://github.com/ak3ilb/youtube.git
cd youtube
npm install
npm run build          # tsc + cross-compiles the Go engine into bin/
```

Then add to your MCP config (e.g. `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["/absolute/path/to/youtube/dist/index.js"]
    }
  }
}
```

Building the engine requires the [Go toolchain](https://go.dev/dl/) once; after that the prebuilt binary in `bin/` is used. Without a binary the server falls back to `go run` in development.

## How the engine works (yt-dlp's approach, reimplemented)

1. **Parse** the URL/ID (`internal/youtube/extractor.go`).
2. **POST** to `youtubei/v1/player` impersonating the **ANDROID** app; fall back to **IOS**, then **WEB** — the same client-cascade strategy yt-dlp uses, because mobile clients avoid the WEB client's sig/nsig JavaScript challenges and PO-token gating.
3. **Metadata** comes from `videoDetails` + `microformat`; **captions** from `captions.playerCaptionsTracklistRenderer` (fetched as `json3`, falling back to legacy `srv1` XML); **formats** from `streamingData`.
4. **Chapters** are parsed from the description with YouTube's own rules (first timestamp must be 0:00, ascending order).

The CLI contract is one JSON object on stdout per invocation:

```bash
./bin/ytube-darwin-arm64 transcript --url dQw4w9WgXcQ --lang en
# {"ok":true,"data":{...}} or {"ok":false,"error":{"code":...,"message":...}}
```

## Testing

```bash
go test ./...        # unit tests (URL parsing, caption selection, chapters, error classification)
npm run build        # compile both layers
npm run smoke        # end-to-end: real MCP client -> stdio server -> Go engine -> live YouTube
```

The smoke test exercises every tool plus four error paths (invalid URL, nonexistent video, missing caption language, bad itag).

## Error codes

| Code | Meaning | Retryable |
| --- | --- | --- |
| `INVALID_VIDEO` | Input is not a recognizable YouTube URL/ID | no |
| `VIDEO_UNAVAILABLE` | Deleted, region-blocked, or nonexistent | no |
| `PRIVATE_VIDEO` | Video is private | no |
| `AUTH_REQUIRED` | Sign-in / age verification required | no |
| `NO_CAPTIONS` | Video has no caption tracks | no |
| `LANGUAGE_NOT_AVAILABLE` | Requested language missing (lists available ones) | no |
| `EMPTY_TRANSCRIPT` | YouTube returned an empty caption body (PO-token gating) | yes |
| `RATE_LIMITED` | HTTP 429 / rate limiting | yes |
| `ACCESS_DENIED` | HTTP 403; client may need a PO token | no |
| `SIGNATURE_REQUIRED` | Format needs sig/nsig JS-challenge solving | no |
| `FORMAT_NOT_FOUND` / `NO_MUXED_FORMAT` | Bad or missing itag choice | no |
| `TIMEOUT` / `NETWORK_ERROR` | Connectivity problems | yes |
| `ENGINE_NOT_FOUND` / `ENGINE_CRASH` / `ENGINE_TIMEOUT` | Local engine problems | varies |

## Known limitations

- **Unofficial API.** InnerTube is undocumented; YouTube can change it at any time. Owning the extractor means we can patch quickly, but breakage risk is inherent (this is equally true of yt-dlp itself).
- **No sig/nsig solving.** Formats whose URLs are signature-ciphered (`directUrl: false`) cannot be downloaded. In practice the ANDROID client returns direct URLs for all formats today, but that can change; yt-dlp solves this with an embedded JavaScript AST solver (`yt-dlp-ejs`), which is explicitly out of scope here.
- **No PO tokens / BotGuard.** Heavily bot-flagged IPs (data centers, some VPNs) may see `ACCESS_DENIED` or `EMPTY_TRANSCRIPT`.
- **No authentication.** Private, members-only, and age-restricted videos return `AUTH_REQUIRED` / `PRIVATE_VIDEO` instead of content. Cookie support is a possible future addition.
- **No live streams.** HLS/DASH manifest handling is not implemented; live content fails with a structured error.
- **Caption translation** (`tlang`) is not exposed: YouTube frequently returns empty bodies for translated tracks on mobile-client URLs.
- **Rate limits.** Guest sessions are limited to roughly 300 videos/hour; heavy use will trigger `RATE_LIMITED`.
- **Single video scope.** Playlists, channels, search, and comments are out of scope for v1.

## License

MIT
