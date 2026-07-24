# YouTube Client

Node.js library and [MCP](https://modelcontextprotocol.io) server for YouTube analysis: transcripts with citations, RAG packs, chapters, captions, search, playlists, and channels.

Powered by a native Go extraction engine. No yt-dlp. No Python.

```bash
npm install youtube-client-mcp
```

```ts
import { YouTubeClient } from "youtube-client-mcp";

const yt = new YouTubeClient();
const pack = await yt.getVideoPack("https://www.youtube.com/watch?v=jNQXAC9IVRw");
```

---

## Features

- Transcripts with `[M:SS]` citations; ASR cues sentence-merged by default
- `getVideoPack` — metadata, chapters, and RAG-ready chunks in one call
- Chapters, captions, related videos, comments, playlists, channels, search
- Local disk cache and hourly rate budget
- Same API as a TypeScript library or MCP tools (Cursor / Claude)
- Cross-platform Go binaries included in the npm package

---

## Install

```bash
npm install youtube-client-mcp
```

Requires Node.js 20+. Prebuilt `ytube` binaries ship for macOS, Linux, and Windows. From a git checkout, run `npm run build` (Go toolchain required once).

---

## Use as a Node.js library

Importing the package does **not** start the MCP server.

![Library usage — getVideoPack in TypeScript](docs/library-usage.jpg)

```ts
import { YouTubeClient, YtubeError, youtube } from "youtube-client-mcp";

const client = new YouTubeClient({ timeoutMs: 120_000 });

try {
  const pack = await client.getVideoPack("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
    chunkChars: 800,
  });

  console.log(pack.video.title);
  console.log(pack.chunks[0].citation, pack.chunks[0].text);

  const transcript = await client.getTranscript("jNQXAC9IVRw", { lang: "en" });
  const hits = await client.searchTranscript("jNQXAC9IVRw", "elephant");
  const chapters = await client.getChapters("jNQXAC9IVRw");
  const results = await client.search("me at the zoo", { limit: 5 });
} catch (err) {
  if (err instanceof YtubeError) {
    console.error(err.info.code, err.info.message);
  }
  throw err;
}

// Convenience singleton
const info = await youtube.getVideoInfo("jNQXAC9IVRw");
```

### API

| Method | Description |
| --- | --- |
| `getVideoPack(url, opts?)` | Metadata + chapters + citation chunks + markdown (primary for RAG) |
| `getVideoInfo(url)` | Title, channel, duration, views, thumbnails |
| `getTranscript(url, opts?)` | Full transcript with timestamps |
| `getTranscriptClip(url, start, opts?)` | Transcript for a time range |
| `searchTranscript(url, query, opts?)` | Keyword hits with timestamps |
| `exportSubtitles(url, opts?)` | Export as `srt` / `vtt` / `ass` / `json` / `text` |
| `listCaptions(url)` | Available caption tracks |
| `getChapters(url)` | Chapter markers |
| `getThumbnails(url)` | Thumbnail URLs |
| `listFormats(url)` | Stream formats (`directUrl` when downloadable) |
| `downloadMedia(url, path, opts?)` | Best-effort download with resume |
| `getRelated(url)` | Related videos |
| `getComments(url, opts?)` | Top-level comments |
| `getHeatmap(url)` | Most-replayed points (when available) |
| `getStoryboards(url)` | Scrub preview tiles |
| `getManifests(url)` | DASH / HLS URLs |
| `getPlaylist(url, opts?)` | Playlist items |
| `getChannel(url, opts?)` | Channel metadata and uploads |
| `search(query, opts?)` | Search videos, channels, playlists |

Low-level helpers: `runEngine(command, flags)`, `resolveEngine()`.

Environment variables below apply to both library and MCP usage.

### `getVideoPack` response

| Field | Description |
| --- | --- |
| `video` | Title, channel, duration, URL |
| `chapters` | Chapter list when available |
| `chunks[]` | `{ citation, text, start, end }` for RAG and quotes |
| `markdown` | Combined document for agent context |
| `howToCite` | Citation guidance |
| `cacheHit` | `true` when served from disk cache |

---

## Use as MCP (Cursor / Claude)

Server name: **YouTube Client**. Tools mirror the library methods above (`get_video_pack`, `get_transcript`, …).

![MCP usage — YouTube Client tools in an agent chat](docs/mcp-usage.jpg)

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "npx",
      "args": ["-y", "youtube-client-mcp"],
      "env": {
        "YTUBE_CACHE_DIR": "/absolute/path/to/.cache/youtube-client",
        "YTUBE_RATE_LIMIT": "60"
      }
    }
  }
}
```

From a local checkout:

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

Restart Cursor after saving.

### Claude Desktop

Same `mcpServers` block in Claude’s config  
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`).

### CLI

```bash
npx youtube-client-mcp
# after global install:
npm install -g youtube-client-mcp
youtube-client
```

Example prompt:

> Use YouTube Client `get_video_pack` on this URL and summarize with timestamp citations.

---

## Configuration

| Variable | Description |
| --- | --- |
| `YTUBE_CACHE_DIR` | Disk cache directory (default `~/.cache/youtube-client`) |
| `YTUBE_CACHE_TTL` | Cache lifetime (default `30m`) |
| `YTUBE_CACHE` | Set `0` to disable cache |
| `YTUBE_RATE_LIMIT` | Max billable YouTube calls per hour (default `60`; `0` disables) |
| `YTUBE_COOKIES` | Path to Netscape `cookies.txt` for age-gated videos you can access |
| `YOUTUBE_API_KEY` | Optional [YouTube Data API v3](https://developers.google.com/youtube/v3) key for more stable search/channel |

Use your own cookies and API key. Respect rate limits. This package does not bypass DRM, paywalls, or BotGuard.

---

## Architecture

```
Your app / Cursor / Claude
        │
        ├─ import YouTubeClient     (library)
        └─ stdio MCP                (agents)
                │
                ▼
        TypeScript package
                │
                ▼
        Go engine (ytube)
          · InnerTube player / next / browse / search
          · timedtext captions (json3, srv1, srv3)
          · disk cache + rate budget
          · optional Data API v3
```

### Go CLI (optional)

```bash
./bin/ytube-darwin-arm64 videopack --url jNQXAC9IVRw --chunk-chars 800
./bin/ytube-darwin-arm64 transcript --url jNQXAC9IVRw
./bin/ytube-darwin-arm64 search --query "me at the zoo" --limit 5
```

Each invocation prints one JSON object: `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { ... } }`.

---

## Error codes

| Code | Meaning |
| --- | --- |
| `RATE_BUDGET_EXCEEDED` | Local hourly budget reached — wait or raise `YTUBE_RATE_LIMIT` |
| `RATE_LIMITED` | YouTube returned HTTP 429 — back off |
| `NO_CAPTIONS` | No caption tracks on this video |
| `LANGUAGE_NOT_AVAILABLE` | Requested language not available |
| `AUTH_REQUIRED` | Sign-in / age gate — set `YTUBE_COOKIES` |
| `SIGNATURE_REQUIRED` | Format needs a JS challenge — use a `directUrl: true` format |
| `API_KEY_REQUIRED` | Data API path used without `YOUTUBE_API_KEY` |

---

## Limitations

- InnerTube responses can change; parsers are maintained in this repo
- No PO-token / BotGuard or sig/nsig solving
- No ffmpeg muxing (video + audio as separate streams when needed)
- Live fragment download is not supported (manifests only)
- Heatmap, related, and storyboards depend on what YouTube returns for the video

---

## Development

```bash
git clone https://github.com/ak3ilb/youtube.git
cd youtube
npm install
npm run build
npm test
npm run smoke
```

---

## Links

- [npm — youtube-client-mcp](https://www.npmjs.com/package/youtube-client-mcp)
- [GitHub](https://github.com/ak3ilb/youtube)
- [Issues](https://github.com/ak3ilb/youtube/issues)

## License

[MIT](LICENSE)
