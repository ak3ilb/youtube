# @ak3il/youtube-client — YouTube Client for Agents

**Free MIT** [Model Context Protocol](https://modelcontextprotocol.io) server **and** Node.js library for YouTube: **transcripts with timestamps**, **RAG citation packs**, chapters, captions, search, playlists, and channels.

Built for **Cursor**, **Claude Desktop**, and custom AI agents. Native **Go** extraction engine — **no yt-dlp**, **no Python**.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-YouTube%20Client-blue)](https://modelcontextprotocol.io)

| Use as | Install / run |
| --- | --- |
| **MCP** (Cursor / Claude) | `npx @ak3il/youtube-client` or `youtube-client` after install |
| **Library** (Node scripts / apps) | `import { YouTubeClient } from "@ak3il/youtube-client"` |

> Focus is **agent understanding** (summarize, cite, RAG) — not bulk piracy. Download is best-effort when YouTube returns direct stream URLs. Optional Google Data API key is free from Google; this package itself never charges.

---

## Why @ak3il/youtube-client?

- **YouTube transcript MCP** — full captions with `[M:SS]` citations
- **RAG-ready `get_video_pack`** — metadata + chapters + chunked text for embeddings
- **YouTube chapters, search, related, comments** in one toolset
- **Local disk cache + rate budget** — safer for shared agent IPs
- **TypeScript library API** — same engine without spawning an MCP process
- **Cross-platform Go binary** — no Python / yt-dlp dependency

---

## Install

```bash
npm install @ak3il/youtube-client
```

From source (needs [Go](https://go.dev/dl/) once to build the engine):

```bash
git clone https://github.com/ak3ilb/youtube.git
cd youtube
npm install
npm run build
```

Published packages ship a prebuilt `bin/ytube-*` for your platform when available; otherwise run `npm run build:go` after install.

---

## Use as MCP (Cursor / Claude)

Server identity: **YouTube Client**.

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "youtube": {
      "command": "npx",
      "args": ["-y", "@ak3il/youtube-client"],
      "env": {
        "YTUBE_CACHE_DIR": "/absolute/path/to/.cache/youtube-client",
        "YTUBE_RATE_LIMIT": "60"
      }
    }
  }
}
```

Local checkout instead of npx:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["/absolute/path/to/youtube/dist/index.js"],
      "env": {
        "YTUBE_CACHE_DIR": "/absolute/path/to/youtube/.cache",
        "YTUBE_RATE_LIMIT": "60"
      }
    }
  }
}
```

### Claude Desktop

Same config under `mcpServers` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`).

### CLI binary

```bash
npm install -g @ak3il/youtube-client
youtube-client
# or: npx @ak3il/youtube-client
```

Restart the host app after editing MCP config.

### Ask the agent

> Use YouTube Client `get_video_pack` on https://www.youtube.com/watch?v=GnCdluU-EIs and summarize with timestamp citations.

---

## Use as a Node.js library

Import the client — **does not** start the MCP stdio server:

```ts
import { YouTubeClient, YtubeError, youtube } from "@ak3il/youtube-client";

const client = new YouTubeClient({ timeoutMs: 120_000 });

try {
  const pack = await client.getVideoPack("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
    chunkChars: 800,
  });
  console.log(pack.video.title, pack.chunkCount, pack.chunks[0].citation);

  const tr = await client.getTranscript("jNQXAC9IVRw", { lang: "en" });
  const hits = await client.searchTranscript("jNQXAC9IVRw", "elephant");
  const chapters = await client.getChapters("jNQXAC9IVRw");
  const results = await client.search("me at the zoo", { limit: 5 });
} catch (e) {
  if (e instanceof YtubeError) {
    console.error(e.info.code, e.info.message, e.info.retryable);
  }
  throw e;
}

// One-liner helper
const info = await youtube.getVideoInfo("jNQXAC9IVRw");
```

### Library API (mirrors MCP tools)

| Method | MCP tool |
| --- | --- |
| `getVideoPack(url, opts?)` | `get_video_pack` |
| `getVideoInfo(url)` | `get_video_info` |
| `getTranscript(url, opts?)` | `get_transcript` |
| `getTranscriptClip(url, start, opts?)` | `get_transcript_clip` |
| `searchTranscript(url, query, opts?)` | `search_transcript` |
| `exportSubtitles(url, opts?)` | `export_subtitles` |
| `listCaptions(url)` | `list_captions` |
| `getChapters(url)` | `get_chapters` |
| `getThumbnails(url)` | `get_thumbnails` |
| `listFormats(url)` | `list_formats` |
| `downloadMedia(url, path, opts?)` | `download_media` |
| `getRelated(url)` | `get_related` |
| `getComments(url, opts?)` | `get_comments` |
| `getHeatmap(url)` | `get_heatmap` |
| `getStoryboards(url)` | `get_storyboards` |
| `getManifests(url)` | `get_manifests` |
| `getPlaylist(url, opts?)` | `get_playlist` |
| `getChannel(url, opts?)` | `get_channel` |
| `search(query, opts?)` | `search_youtube` |

Low-level escape hatch: `runEngine(command, flags)` and `resolveEngine()` from the same package.

Env vars (`YTUBE_CACHE_DIR`, `YTUBE_RATE_LIMIT`, …) apply to both MCP and library calls.

---

## MCP tools

| Tool | Purpose |
| --- | --- |
| `get_video_pack` | **Primary.** Metadata + chapters + citation chunks + markdown for RAG |
| `get_video_info` | Title, description, channel, duration, views, keywords, thumbnails |
| `get_transcript` | Full transcript; ASR cues sentence-merged by default |
| `get_transcript_clip` | Transcript for a time range (`1:30`–`2:45`) |
| `search_transcript` | Keyword hits with timestamps |
| `export_subtitles` | `srt` / `vtt` / `ass` / `json` / `text` |
| `list_captions` | Available caption tracks |
| `get_chapters` | Chapters from InnerTube markers or description |
| `get_thumbnails` | Thumbnail URLs |
| `list_formats` | Stream formats (`directUrl` flag) |
| `download_media` | Best-effort download with `.part` resume |
| `get_related` | Related video IDs |
| `get_comments` | Top-level comments |
| `get_heatmap` | Most-replayed points when available |
| `get_storyboards` | Scrub preview tiles |
| `get_manifests` | DASH/HLS URLs + live flag |
| `get_playlist` | Playlist items |
| `get_channel` | Channel metadata + uploads |
| `search_youtube` | Search videos / channels / playlists |

### `get_video_pack` fields

| Field | Use |
| --- | --- |
| `video` | Title, channel, duration, URL |
| `chapters` | Jump points when available |
| `chunks[]` | `{ citation, text, start, end }` for RAG / quotes |
| `markdown` | Single document for agent context |
| `howToCite` | Keep `[m:ss]` citations in answers |
| `cacheHit` | `true` when served from local disk cache |

---

## Environment variables

| Variable | Purpose |
| --- | --- |
| `YTUBE_COOKIES` | Netscape `cookies.txt` for age-gated videos **you** can access |
| `YOUTUBE_API_KEY` | **Optional.** Free key from [Google YouTube Data API v3](https://developers.google.com/youtube/v3) — improves search/channel stability. Not required; InnerTube works without it. Not a paid feature of this package. |
| `YTUBE_CACHE_DIR` | Disk cache directory (default `~/.cache/youtube-client`) |
| `YTUBE_CACHE_TTL` | Cache lifetime (default `30m`) |
| `YTUBE_CACHE` | Set `0` to disable cache |
| `YTUBE_RATE_LIMIT` | Max billable YouTube calls per hour (default `60`). `0` disables |

**Legal / ToS:** Use your own cookies and API key. Do not share cookies. Respect rate limits. This tool does not circumvent DRM, paywalls, or BotGuard PO tokens.

---

## Go CLI (debug / scripts)

```bash
./bin/ytube-darwin-arm64 videopack --url GnCdluU-EIs --chunk-chars 800
./bin/ytube-darwin-arm64 transcript --url GnCdluU-EIs
./bin/ytube-darwin-arm64 search --query "me at the zoo" --limit 5
```

Each command prints one JSON object: `{"ok":true,"data":...}` or `{"ok":false,"error":{code,message,retryable,details}}`.

---

## @ak3il/youtube-client vs yt-dlp

| | yt-dlp | @ak3il/youtube-client (YouTube Client) |
| --- | --- | --- |
| Audience | Human CLI / scripts | AI agents (MCP) + Node library |
| Strength | Formats & download | Transcript, citations, RAG packs |
| Errors | Log lines | Structured codes + retry hints |
| Rate safety | Manual | Local budget + cache |
| Official API | No | Optional free Google Data API key |

---

## Architecture

```
Cursor / Claude / your Node app
    │  MCP stdio          OR         import YouTubeClient
    ▼                                ▼
TypeScript (@ak3il/youtube-client)
    │ spawns JSON CLI
    ▼
Go engine (ytube)
    ├─ InnerTube player/next/browse/search
    ├─ timedtext captions (json3 / srv1 / srv3)
    ├─ disk cache + hourly rate budget
    └─ optional YouTube Data API v3
```

---

## Error codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `RATE_BUDGET_EXCEEDED` | Local hourly budget hit | Wait, or raise `YTUBE_RATE_LIMIT` |
| `RATE_LIMITED` | YouTube HTTP 429 | Back off several minutes |
| `NO_CAPTIONS` | No caption tracks | Try another video |
| `LANGUAGE_NOT_AVAILABLE` | No track for that lang | Omit `lang` or try another code |
| `AUTH_REQUIRED` | Age/sign-in wall | Set `YTUBE_COOKIES` |
| `SIGNATURE_REQUIRED` | Format needs JS challenge | Pick `directUrl: true` format |
| `API_KEY_REQUIRED` | Data API path without key | Set free `YOUTUBE_API_KEY` or use InnerTube-only flows |

---

## Testing

```bash
npm test
npm run build
npm run smoke
```

---

## Limitations

- Unofficial InnerTube can change; we own the parser so we can fix it.
- No PO-token / BotGuard generation and no sig/nsig solver (by design).
- No video+audio muxing (no ffmpeg dependency).
- Live stream fragment download not supported (manifests only).
- Heatmap / related / storyboards depend on what YouTube returns.
- Guest IPs can be throttled; use cache, budget, cookies, or optional Data API key.

---

## Links

- **npm:** [`@ak3il/youtube-client`](https://www.npmjs.com/package/@ak3il/youtube-client)
- **GitHub:** [ak3ilb/youtube](https://github.com/ak3ilb/youtube)
- **Issues:** [github.com/ak3ilb/youtube/issues](https://github.com/ak3ilb/youtube/issues)

## License

MIT — free for personal and commercial use.
