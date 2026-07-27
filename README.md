<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ak3ilb/youtube/main/docs/logo-dark.svg">
    <img src="https://raw.githubusercontent.com/ak3ilb/youtube/main/docs/logo.svg" alt="YouTube Client" width="420">
  </picture>
</p>

# YouTube Client

Node.js library and [MCP](https://modelcontextprotocol.io) server for YouTube analysis: transcripts with citations, RAG packs, chapters, captions, search, playlists, and channels.

Pure TypeScript / Node.js engine. No Go. No yt-dlp. No Python.

```bash
npm install youtube-client-mcp
```

```ts
import { YouTubeClient } from "youtube-client-mcp";

const yt = new YouTubeClient();
const pack = await yt.getVideoPack("https://www.youtube.com/watch?v=jNQXAC9IVRw");
```

---

## Disclaimer

This project was created to **help people build and learn** — for education,
experimentation, and legitimate product/agent workflows around public YouTube
content.

**Wrong or abusive use is not supported.** That includes (and is not limited to)
using this package, its MCP tools, or prompts around it to:

- Harass, stalk, dox, or harm people
- Infringe copyright or redistribute content you do not have rights to use
- Circumvent paywalls, DRM, age gates, or access controls you are not entitled to
- Scrape, spam, or overwhelm YouTube beyond normal personal/agent use and rate limits
- Run phishing, malware, fraud, or other illegal activity
- Jailbreak, trick, or prompt an agent into doing any of the above

You are responsible for how you use this software. Follow [YouTube's Terms of
Service](https://www.youtube.com/t/terms), applicable copyright and privacy laws,
and the rules of any platform or employer you run it under. The authors do not
endorse misuse, do not provide support for harmful prompting or bypasses, and
accept no liability for damage or claims arising from improper use.

This package does **not** bypass DRM, paywalls, or BotGuard. Prefer the official
[YouTube Data API](https://developers.google.com/youtube/v3) when you need
guarantees backed by Google.

---

## Features

- Reliable transcripts for Shorts and long videos — multi-client fallback (ANDROID → IOS → WEB), caption retry ladder, stable disk cache, stale-cache rescue
- Optional headless-browser fallback (`YTUBE_BROWSER=1`) that fetches captions same-origin when timedtext is IP-blocked
- Language preference chains (`hi,en`) with best-effort fallback; `strict` opt-in for hard fails
- Word-level timings, chapter-grouped transcripts, sound-tag stripping, forced `translateTo`
- `diagnoseTranscript` — see exactly which ladder stage failed
- Transcripts with `[M:SS]` citations and jump links; ASR cues sentence-merged by default
- `getVideoPack` — metadata, chapters, and RAG-ready chunks in one call
- `askVideo` — answer a question from the best passages instead of the whole transcript
- `getChannelCatalog` — exhaustively page a creator's Videos and Shorts tabs
- `getPlaylistPack` / `getChannelPack` — batch many videos, resume with a cursor, skip failures
- `exportChannelAnalysis` — checkpointed full-channel JSONL export with live progress, auto browser on IP block, and `untilDone` retries
- Paged transcripts (`maxChars` + `nextCursor`) for context-limited agents
- Chapters, captions, related videos, comments (sort, replies, paging), playlists, channels, search
- Local disk cache and hourly rate budget
- Same API as a TypeScript library or MCP tools (Cursor / Claude)
- Pure Node.js — `npm install` is the only dependency for users and contributors

---

## How YouTube Client compares

Category comparison, not a ranking of specific projects. Every row describes what
is shipped in the published version.

| Capability | YouTube Client | Transcript-only MCPs | YouTube Data API clients | yt-dlp | Hosted transcript APIs |
| --- | --- | --- | --- | --- | --- |
| Node library **and** MCP server | Both | Usually MCP only | Library only | CLI / Python | HTTP API |
| Timestamped transcript | Yes | Usually | No captions for arbitrary videos | Yes | Usually |
| RAG citation pack | [Built in](#getvideopack-response) | Usually raw or paginated text | No | No | Sometimes |
| Question answering over one video | [`ask_video`](#ask-a-question-about-one-video) | No | No | No | Sometimes |
| Playlist / channel batch packs | [Built in](#batch-a-playlist-or-channel) | Rare | Manual, quota-metered | Per-video extraction | Per-request billing |
| Chapters, comments, related, heatmap | [Built in](#api) | Limited | Metadata and comments cost quota | Extraction-oriented | Varies |
| API key required | No | Usually no | Yes | No | Yes |
| Local cache and rate budget | [Built in](#configuration) | Varies | Developer-managed | Developer-managed | Provider-managed |
| Runtime | Pure Node.js / TypeScript | Often Python / yt-dlp | SDK | Python executable | Remote service |
| High-quality media download | Limited today | No | No | Best-in-class | No |

Where other tools are the better choice:

- **yt-dlp** remains the right tool for downloading and muxing media. It solves
  sig/nsig challenges, merges adaptive streams with ffmpeg, and supports far more
  formats and sites. YouTube Client only downloads formats YouTube hands back as
  direct URLs.
- **YouTube Data API v3** is the authority for owner-scoped and analytics data,
  and for guarantees backed by Google's terms. Set `YOUTUBE_API_KEY` to let this
  package use it for search and channel lookups.
- **Hosted transcript APIs** absorb the operational burden of YouTube changes; this
  package puts that burden on your own IP and this repo's parsers.

Current limits: no PO-token/BotGuard attestation minting, no sig/nsig solver, no
ffmpeg muxing, and no live-fragment downloads. See [Limitations](#limitations).

### Why transcripts return `IP_BLOCKED` / 429

YouTube's `/api/timedtext` endpoint sometimes answers with a small HTML
**"Sorry..."** page and HTTP 429. That is an **IP reputation block**, not a
parser bug — InnerTube player calls can still succeed (tracks are listed) while
caption body GETs fail. Competing libraries from the same IP fail the same way.

Errors and `diagnoseTranscript` now include a `recovery` object so agents can
show the right next step instead of busy-retrying:

| `recovery.kind` | Meaning | What to do |
| --- | --- | --- |
| `browser_or_proxy` | Tracks exist; timedtext blocked; panel may still work | Enable `YTUBE_BROWSER=1`, or set `YTUBE_PROXY` |
| `proxy_required` | Tracks exist; timedtext blocked **and** Show transcript / `get_transcript` is unusable for this video (FAILED_PRECONDITION / CC unavailable) | **Proxy or new network only** — browser alone will not help |
| `wait_or_proxy` | Browser already configured; still blocked | Wait for cooldown, or change egress |

**Fixes that work:**

1. Wait (often hours) until the block cools down — this package already stops
   hammering timedtext for `YTUBE_TIMEDTEXT_COOLDOWN` and serves stale cache.
2. Switch network (phone hotspot / VPN) and retry.
3. Set a clean egress proxy: `YTUBE_PROXY=http://user:pass@host:port`
   (or `HTTPS_PROXY`). Residential egress works best; datacenter IPs are often
   blocked faster.
4. Enable the [headless browser fallback](#advanced-transcripts-headless-browser-fallback)
   (`YTUBE_BROWSER=1`) — helps when the watch-page panel still loads cues.
   It does **not** help for `recovery.kind = proxy_required` videos.

---

## Install

```bash
npm install youtube-client-mcp
```

**That is the only install step.** You need Node.js 20+. You do **not** need Go, Python, yt-dlp, ffmpeg, or any native toolchain.

From a git checkout: `npm install && npm run build` (TypeScript only).

---

## Use as a Node.js library

Importing the package does **not** start the MCP server.

<p align="center">
  <img src="docs/library-usage.jpg" alt="Library usage — getVideoPack in TypeScript" width="800" style="border-radius: 8px; border: 1px solid #8b949e;">
</p>

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
| `askVideo(url, question, opts?)` | Best-matching passages with citations and jump links |
| `getPlaylistPack(url, opts?)` | Batch packs for a playlist, resumable via `nextCursor` |
| `getChannelPack(url, opts?)` | Resumable analysis pages across all channel Videos and Shorts |
| `getChannelCatalog(url, opts?)` | Exhaustive Videos/Shorts catalog with content filtering and cursors |
| `exportChannelAnalysis(url, opts?)` | Checkpointed full-channel metadata + transcript + chapters + RAG JSONL |
| `getVideoInfo(url)` | Title, channel, duration, views, likes, category, publish date, thumbnails |
| `getTranscript(url, opts?)` | Reliable transcript (Shorts + long); lang chains, paging, words, chapters |
| `diagnoseTranscript(url, opts?)` | Caption ladder diagnostics (clients, tracks, body, cache, budget) |
| `getTranscriptClip(url, start, opts?)` | Transcript for a time range |
| `searchTranscript(url, query, opts?)` | Keyword hits with timestamps |
| `exportSubtitles(url, opts?)` | Export as `srt` / `vtt` / `ass` / `json` / `text` / `chapters` |
| `listCaptions(url)` | Available caption tracks |
| `getChapters(url)` | Chapter markers |
| `getThumbnails(url)` | Thumbnail URLs |
| `listFormats(url)` | Stream formats (`directUrl` when downloadable) |
| `downloadMedia(url, path, opts?)` | Best-effort download with resume |
| `getRelated(url)` | Related videos |
| `getComments(url, opts?)` | Comments with `sort`, `replies`, and `cursor` paging |
| `getSponsorSegments(url)` | Community-flagged sponsor ranges (opt-in) |
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
| `video` | Title, channel, duration, views, likes, category, publish date, URL |
| `chapters` | Chapter list when available |
| `chunks[]` | `{ citation, url, text, start, end }` for RAG and quotes |
| `markdown` | Combined document for agent context |
| `howToCite` | Citation guidance |
| `sponsorSegments` | Ranges removed when `skipSponsors` is used |
| `cacheHit` | `true` when served from disk cache |

Each chunk's `url` opens the video at that moment, so a citation stays clickable
wherever your agent renders it.

### Ask a question about one video

Ranks the video's citation chunks against the question and returns only the best
passages, which keeps long videos inside a model's context window.

```ts
const answer = await client.askVideo("jNQXAC9IVRw", "what is cool about the elephants?", {
  topK: 3,
});

for (const { chunk, score } of answer.passages) {
  console.log(chunk.citation, chunk.url, score.toFixed(2), chunk.text);
}

// `answer.context` is a markdown block you can paste straight into a prompt.
```

### Page a long transcript

```ts
let cursor = 0;
for (;;) {
  const page = await client.getTranscript(url, { maxChars: 8000, cursor });
  process(page.text); // page.cursor … page.nextCursor of page.totalSegments
  if (!page.hasMore) break;
  cursor = page.nextCursor;
}
```

### Reliable transcripts (Shorts and long videos)

```ts
// Preference chain: try Hindi, then English. Best-effort by default.
const tr = await client.getTranscript(url, {
  lang: "hi,en",
  words: true,            // word-level timings when json3 provides them
  stripSoundTags: true,   // drop [Music] / [Applause]
  groupByChapters: true,  // bucket segments under chapter markers
});

console.log(tr.source, tr.resolvedLang, tr.warnings);

// Hard-fail if the exact language is missing:
await client.getTranscript(url, { lang: "fr", strict: true });

// See why a video failed:
const diag = await client.diagnoseTranscript(url, { lang: "en" });
console.log(diag.ok, diag.clients, diag.formatUsed, diag.rateBudgetRemaining);
```

Transcript calls use a stable disk cache (signed caption URLs are never part of
the key), escalate across ANDROID → IOS → WEB caption clients, retry empty
bodies with fresh signatures / optional `YTUBE_PO_TOKEN`, and serve a stale
cached copy when YouTube is temporarily unreachable.

### Advanced transcripts: headless browser fallback

When Node's `/api/timedtext` GETs are IP-blocked (the HTTP 429 "Sorry..." page),
a real browser session can still obtain captions. Verified in Cursor's browser
on `dQw4w9WgXcQ`: same-origin timedtext still returned 429, but **Show
transcript** loaded the full cue list. The optional Playwright fallback
reproduces that flow headlessly:

1. Open the watch page and read caption tracks from `ytInitialPlayerResponse`
2. Try a same-origin timedtext fetch (`json3` → `srv1` → `srv3`)
3. If that is blocked/empty, open **Show transcript** and scrape the panel cues

**Resolution flow** (browser is the last live path — cache and the Node ladder run first):

```mermaid
flowchart TD
  start[getTranscript] --> cache{fresh or stale cache?}
  cache -->|hit| done[return Transcript]
  cache -->|miss| ladder[InnerTube plus Node timedtext]
  ladder -->|ok| done
  ladder -->|IP_BLOCKED empty RATE_LIMITED| enabled{browser enabled?}
  enabled -->|no| err[throw IP_BLOCKED plus enable YTUBE_BROWSER hint]
  enabled -->|yes| nav[Headless Chromium open watch page]
  nav --> ready[Wait ytInitialPlayerResponse videoId match]
  ready --> tracks[Pick caption track via lang chain]
  tracks --> same[Same-origin fetch fmt json3]
  same -->|empty or blocked| fmt[Retry srv1 then srv3 in page]
  fmt -->|still fail| panel[Show transcript click plus get_panel JSON]
  same -->|segments| parse[Parse and cache Transcript]
  fmt -->|segments| parse
  panel -->|transcriptSegmentViewModel cues| parse
  parse --> done
```

**Install** (optional — not pulled in by default):

```bash
npm i playwright
npx playwright install chromium
```

**Enable** it per call or globally:

```ts
// Per call:
const tr = await client.getTranscript(url, { lang: "en", browser: true });

// Or globally for every transcript in the process:
//   YTUBE_BROWSER=1
```

The result is cached like any transcript, so the browser only launches on the
first miss; subsequent calls are served from disk. Successful browser-backed
transcripts carry `browser_fallback` (and `browser_panel_fallback` when the
Show transcript UI was used) in `warnings`.

**Footprint:** the browser is **always headless** (no visible window). It runs a
single shared Chromium with images/media/fonts blocked (stylesheets kept so the
transcript panel can mount). For batches: **one watch tab at a time**, each tab
is closed when that video finishes, leftover blank tabs are swept, and browser
jobs are spaced by `YTUBE_BROWSER_GAP_MS` (default 750ms) so a 30-video pack does
not hammer the watch/`get_panel` endpoints. Chromium stays warm between pack
pages — agents usually walk a playlist with `nextCursor`, and relaunching per
page costs more than the ~60s idle shutdown. A channel **export** closes it as
soon as the slice completes or pauses; call `closeBrowser()` yourself to free RAM
immediately. If both timedtext and the panel fail from your IP, set `YTUBE_PROXY`
to a clean residential egress.

**Large browser batches (20–30 videos):** a pack page takes up to 50 videos.
Because every video that falls back to the browser costs ~5–15s, plan for
multi-minute runs and raise or disable the request budget — `YTUBE_RATE_LIMIT=0`
(or a few hundred) — otherwise the default budget of 60 aborts mid-batch. To
verify the browser path at that scale on your own network:

```bash
npm i playwright && npx playwright install chromium
VERIFY_LIMIT=30 npm run verify:browser-batch
```

The harness arms the timedtext breaker so every video goes through the browser,
then checks success rate, that only one watch tab is ever open, that the job
counter drains, and that Chromium tears down cleanly. Point it at your own
source with `VERIFY_SOURCE` (playlist/channel) or `VERIFY_IDS`. A 30-video run
from a fully timedtext-blocked IP packed 30 of 31 videos (the miss had no
captions at all) in ~110s — median 4.2s per browser job, one tab throughout,
peak RSS ~210MB.

**Known limit:** on videos served YouTube's newer transcript panel, the panel
request is rejected in headless Chromium (HTTP 400 "Precondition check failed")
no matter how it is opened, so those videos fall back to `IP_BLOCKED` when
timedtext is also blocked. Such videos are reported per video in `failures`
rather than ending the batch, and a pack now tolerates a short streak of
block-style failures before stopping — use `YTUBE_PROXY` for a clean egress when
you hit them.

### Batch a playlist or creator channel

Each video costs several YouTube requests, so batches process a small slice per
call — `limit` defaults to 5 and is capped at 50 per page. Videos that cannot be
packed (captions disabled, private, region-blocked) land in `failures` instead of
failing the run, and already-packed videos come from cache for free when you
resume.

```ts
let cursor = 0;
do {
  const batch = await client.getPlaylistPack(playlistUrl, {
    limit: 5,
    cursor,
    includeChunks: true,
  });

  console.log(`${batch.videos.length} packed, ${batch.failures?.length ?? 0} skipped`);
  cursor = batch.nextCursor;
} while (cursor);
```

`getChannelPack` accepts a channel URL (including `/videos` or `/shorts`), `UC…`
ID, or `@handle`. Channel discovery follows both tab continuation chains instead
of stopping at the first page. Use `contentType` to select `"all"`, `"videos"`,
or `"shorts"` and `detail: "analysis"` to embed full metadata, transcript
segments, chapters, and RAG chunks:

```ts
let cursor = 0;
do {
  const page = await client.getChannelPack("https://youtube.com/@mkbhd", {
    contentType: "all",
    detail: "analysis",
    limit: 10,
    cursor,
  });

  for (const item of page.videos) {
    console.log(item.contentType, item.video?.title, item.transcript?.segmentCount);
  }
  cursor = page.nextCursor;
} while (cursor !== undefined);
```

To list the complete catalog without downloading transcripts:

```ts
const first = await client.getChannelCatalog("@mkbhd", {
  contentType: "shorts",
  limit: 100,
  refresh: true,
});
console.log(first.items, first.nextCursor, first.complete);
```

Catalog cursors belong to a stable cached snapshot so long jobs never shift
under newly uploaded videos. Start again with `refresh: true` and `cursor: 0`
when you want a fresh snapshot; old cursors are intentionally invalidated.

For a large creator, export analysis records to disk instead of returning every
transcript in one response. Prefer `untilDone` + `autoBrowser` + `onProgress` so
the run lists the full catalog, retries IP-blocked videos via the headless
browser, and keeps going until every item is packed or permanently failed:

```ts
import { YouTubeClient, defaultChannelExportLogger } from "youtube-client-mcp";

const client = new YouTubeClient({ timeoutMs: 24 * 60 * 60 * 1000 });

const job = await client.exportChannelAnalysis("@mkbhd", {
  contentType: "all", // or "videos" | "shorts"
  lang: "en",
  autoBrowser: true,  // YTUBE_BROWSER=1 for this run
  untilDone: true,    // retry blocks, then continue (do not pause the whole job)
  maxRetryRounds: 3,
  retryDelayMs: 5_000,
  onProgress: defaultChannelExportLogger, // stderr: percent, phase, recovery hints
});

console.log(job.status, job.succeeded, job.failed, job.dataPath);
```

CLI (same behavior, progress on stderr, JSON summary on stdout):

```bash
npm run channel:export -- @mkbhd
CONTENT_TYPE=shorts MAX_RETRY=5 npm run channel:export -- @handle
```

Without `untilDone`, global failures such as `IP_BLOCKED` still **pause** before
advancing the current video so a later call with the same `jobId` retries it:

```ts
const paused = await client.exportChannelAnalysis("@mkbhd", { contentType: "all" });
const resumed = await client.exportChannelAnalysis("@mkbhd", {
  contentType: "all",
  jobId: paused.jobId,
});
```

Progress events (`phase`) include: `starting`, `catalog`, `video_start`,
`video_ok`, `video_fail`, `browser_fallback`, `retry_wait`, `paused`, `completed`.
Blocked failures carry `recovery.kind` (`browser_or_proxy` / `proxy_required`).

The JSONL file contains one record per discovered item. Successful records carry
`video`, `transcript`, `chapters`, and `chunks`; unavailable/private/captionless
videos produce structured `failure` records.

---

## Use as MCP (Cursor / Claude)

Server name: **YouTube Client**. The 26 tools mirror the library methods above,
including `get_video_pack`, `ask_video`, `get_playlist_pack`, `get_channel_pack`,
`get_channel_catalog`, `export_channel_analysis`, `get_transcript` (with
`maxChars` / `cursor` paging), and `get_comments`.

<p align="center">
  <img src="docs/mcp-usage.jpg" alt="MCP usage — YouTube Client tools in an agent chat" width="800" style="border-radius: 8px; border: 1px solid #8b949e;">
</p>

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
| `YTUBE_EXPORT_DIR` | Full-channel JSONL/checkpoint directory (default: `<YTUBE_CACHE_DIR>/exports`) |
| `YTUBE_CACHE_TTL` | Fresh cache lifetime (default `6h`) |
| `YTUBE_CACHE_MAX_STALE` | Max age for stale-cache rescue on retryable failures (default `168h`) |
| `YTUBE_CACHE` | Set `0` to disable cache |
| `YTUBE_PROXY` | HTTP(S) proxy for YouTube egress (`http://user:pass@host:port`). Also honors `HTTPS_PROXY` / `HTTP_PROXY`. Use this when timedtext returns **IP_BLOCKED** (429 Sorry page) |
| `YTUBE_BROWSER` | Set `1` to enable the [headless browser transcript fallback](#advanced-transcripts-headless-browser-fallback) when timedtext is IP-blocked (needs the optional `playwright` peer dependency) |
| `YTUBE_BROWSER_GAP_MS` | Pause between headless-browser caption jobs so large batches stay paced (default `750`; `0` disables) |
| `YTUBE_TIMEDTEXT_COOLDOWN` | After a caption HTTP 429/IP block, skip live timedtext for this long and prefer stale cache (default `15m`; `0` disables) |
| `YTUBE_RATE_LIMIT` | Max billable YouTube calls per hour (default `60`; `0` disables) |
| `YTUBE_COOKIES` | Path to Netscape `cookies.txt` for age-gated videos you can access |
| `YOUTUBE_API_KEY` | Optional [YouTube Data API v3](https://developers.google.com/youtube/v3) key for more stable search/channel |
| `YTUBE_RICH_METADATA` | Set `0` to skip the extra request that fills category, likes, and publish date |
| `YTUBE_PO_TOKEN` | PO token from your own browser session (player + caption URLs) |
| `YTUBE_VISITOR_DATA` | Visitor data to pair with your PO token |
| `YTUBE_HL` / `YTUBE_GL` | Interface language / country for InnerTube (default `en` / `US`) |
| `YTUBE_DEBUG` | Set `1` to attach caption attempt logs on transcript responses |
| `YTUBE_SPONSORBLOCK` | Set `1` to enable [SponsorBlock](https://sponsor.ajay.app) lookups (off by default) |
| `YTUBE_SPONSORBLOCK_CATEGORIES` | Comma-separated categories (default sponsor, selfpromo, interaction, intro, outro, preview, music_offtopic) |

Use your own cookies and API key. Respect rate limits. This package does not
bypass DRM, paywalls, or BotGuard. See the [Disclaimer](#disclaimer) — learning
and legitimate use only; wrong usage and harmful prompting are not supported.

SponsorBlock is opt-in because enabling it sends the video ID to a third-party
service. With `YTUBE_SPONSORBLOCK=1`, `getSponsorSegments` lists the flagged
ranges and `skipSponsors: true` removes them from a pack's chunks.

---

## Architecture

```
Your app / Cursor / Claude
        │
        ├─ import YouTubeClient     (library)
        └─ stdio MCP                (agents)
                │
                ▼
        Pure TypeScript package (src/engine)
          · InnerTube player / next / browse / search / resolve_url
          · timedtext captions (json3, srv1, srv3)
          · chunking, BM25 passage ranking, batch packs
          · disk cache + rate budget
          · optional Data API v3, optional SponsorBlock
```

---

## Error codes

| Code | Meaning |
| --- | --- |
| `RATE_BUDGET_EXCEEDED` | Local hourly budget reached — wait or raise `YTUBE_RATE_LIMIT` |
| `RATE_LIMITED` | YouTube returned HTTP 429 — back off |
| `IP_BLOCKED` | Caption GETs hit YouTube's "Sorry..." IP block. Check `error.details.recovery` — `browser_or_proxy` vs `proxy_required` (panel also dead for that video) |
| `BROWSER_REQUIRED` | Browser fallback was requested but Playwright is not installed — `npm i playwright && npx playwright install chromium` |
| `NO_CAPTIONS` | No caption tracks on this video |
| `LANGUAGE_NOT_AVAILABLE` | Requested language not available |
| `AUTH_REQUIRED` | Sign-in / age gate — set `YTUBE_COOKIES` |
| `SIGNATURE_REQUIRED` | Format needs a JS challenge — use a `directUrl: true` format |
| `API_KEY_REQUIRED` | Data API path used without `YOUTUBE_API_KEY` |
| `SPONSORBLOCK_DISABLED` | Sponsor lookups need `YTUBE_SPONSORBLOCK=1` |
| `INVALID_BATCH_SOURCE` | Batch input was not a playlist, channel, or video list |
| `CHANNEL_NOT_FOUND` | Handle could not be resolved to a channel |

---

## Limitations

- InnerTube responses can change; parsers are maintained in this repo
- No PO-token / BotGuard minting or sig/nsig solving (you can supply your own token via `YTUBE_PO_TOKEN`)
- No ffmpeg muxing (video + audio as separate streams when needed)
- Live fragment download is not supported (manifests only)
- Heatmap, related, and storyboards depend on what YouTube returns for the video
- Paged batch packs process at most 50 videos per call, by design, to protect your IP
- Full-channel export is sequential and checkpointed; caption availability still depends on each video and YouTube's IP/rate limits
- `askVideo` ranks passages lexically (BM25); it retrieves context rather than generating an answer
- Videos without captions cannot be transcribed; there is no speech-to-text fallback

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

By using this software you acknowledge the [Disclaimer](#disclaimer): it is
intended for learning and legitimate use; the authors do not support wrong
usages, harmful prompting, or ToS/copyright abuse.
