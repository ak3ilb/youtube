#!/usr/bin/env node
/**
 * YouTube Client — a standalone MCP server for YouTube operations.
 * Pure Node.js / TypeScript engine (no Go, no yt-dlp, no Python).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runEngine, YtubeError } from "./go-bridge.js";

const server = new McpServer({ name: "YouTube Client", version: "2.0.0" });

const urlOrId = z
  .string()
  .min(1)
  .describe("A YouTube video URL (watch, youtu.be, shorts, embed, live) or a bare 11-character video ID");

const lang = z
  .string()
  .optional()
  .describe("Preferred caption language code (e.g. 'en'). Omit for the best available track.");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function toolError(error: unknown): ToolResult {
  const payload =
    error instanceof YtubeError
      ? { error: error.info.code, message: error.info.message, retryable: error.info.retryable, details: error.info.details }
      : { error: "UNEXPECTED_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

async function handle(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return toolError(error);
  }
}

server.registerTool(
  "get_video_info",
  {
    title: "Get video info",
    description:
      "Fetch metadata for a single YouTube video: title, description, channel, duration, view count, publish date, category, keywords and thumbnails.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("info", { url: urlOrId })),
);

server.registerTool(
  "get_transcript",
  {
    title: "Get transcript with timestamps",
    description:
      "Download the transcript with timestamps. Works for Shorts and long videos. Auto-generated captions are sentence-merged by default. lang accepts a preference chain like 'hi,en' (best-effort by default; set strict=true to hard-fail). Falls back through ANDROID/IOS caption clients, retries empty bodies, and serves a stale cache copy if YouTube is temporarily unreachable. Set maxChars to page long videos via nextCursor. Optional words, translateTo, stripSoundTags, groupByChapters. Set browser=true (needs the optional playwright peer dep, or YTUBE_BROWSER=1) to fetch captions through a headless browser when timedtext is IP-blocked.",
    inputSchema: {
      urlOrId,
      lang: z
        .string()
        .optional()
        .describe("Language code or comma preference chain, e.g. 'en' or 'hi,en'"),
      merge: z
        .boolean()
        .optional()
        .describe("Merge mid-phrase ASR cues into sentences (default true for auto-generated tracks)"),
      maxChars: z
        .number()
        .int()
        .positive()
        .max(200_000)
        .optional()
        .describe("Max transcript characters per page; omit to return the whole transcript"),
      cursor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Segment index to resume from (use nextCursor from the previous page)"),
      strict: z
        .boolean()
        .optional()
        .describe("Hard-fail when the requested language is missing (default: best-effort fallback)"),
      words: z
        .boolean()
        .optional()
        .describe("Include word-level timings from json3 captions"),
      translateTo: z
        .string()
        .optional()
        .describe("Force YouTube auto-translate to this language code"),
      stripSoundTags: z
        .boolean()
        .optional()
        .describe("Drop [Music]/[Applause] style sound-tag cues"),
      groupByChapters: z
        .boolean()
        .optional()
        .describe("Attach chapter-bucketed transcript sections with jump URLs"),
      browser: z
        .boolean()
        .optional()
        .describe(
          "Fetch captions through a headless browser when timedtext is IP-blocked (needs optional playwright peer dep; also set by YTUBE_BROWSER=1)",
        ),
    },
  },
  async ({ urlOrId, lang, merge, maxChars, cursor, strict, words, translateTo, stripSoundTags, groupByChapters, browser }) =>
    handle(() =>
      runEngine("transcript", {
        url: urlOrId,
        lang,
        merge: merge === undefined ? undefined : merge ? "true" : "false",
        "max-chars": maxChars,
        cursor,
        strict,
        words,
        "translate-to": translateTo,
        "strip-sound-tags": stripSoundTags,
        "group-chapters": groupByChapters,
        browser,
      }),
    ),
);

server.registerTool(
  "get_transcript_clip",
  {
    title: "Get transcript clip",
    description:
      "Return only transcript segments overlapping a time range. Pass start/end as seconds or timestamps like '1:30' / '2:45'.",
    inputSchema: {
      urlOrId,
      lang,
      start: z.string().describe("Range start as seconds or M:SS / H:MM:SS"),
      end: z.string().optional().describe("Range end as seconds or M:SS / H:MM:SS; omit for end of video"),
    },
  },
  async ({ urlOrId, lang, start, end }) =>
    handle(() => runEngine("transcript-clip", { url: urlOrId, lang, start, end })),
);

server.registerTool(
  "search_transcript",
  {
    title: "Search transcript",
    description: "Find keyword/phrase matches in a video transcript and return hits with timestamps and context lines.",
    inputSchema: {
      urlOrId,
      lang,
      query: z.string().min(1).describe("Case-insensitive keyword or phrase to find"),
    },
  },
  async ({ urlOrId, lang, query }) =>
    handle(() => runEngine("transcript-search", { url: urlOrId, lang, query })),
);

server.registerTool(
  "export_subtitles",
  {
    title: "Export subtitles",
    description: "Export captions as srt, vtt, ass, json, or text (with [timestamp] prefixes). Optionally write to outputPath.",
    inputSchema: {
      urlOrId,
      lang,
      format: z.enum(["srt", "vtt", "ass", "json", "text"]).optional().describe("Output format (default srt)"),
      outputPath: z.string().optional().describe("Optional file path to write the subtitle content"),
    },
  },
  async ({ urlOrId, lang, format, outputPath }) =>
    handle(() => runEngine("subtitles", { url: urlOrId, lang, format: format ?? "srt", out: outputPath })),
);

server.registerTool(
  "list_captions",
  {
    title: "List caption tracks",
    description:
      "List every caption/subtitle track available on a YouTube video, including language codes, display names and whether each track is auto-generated (ASR) or manually created.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("captions", { url: urlOrId })),
);

server.registerTool(
  "get_chapters",
  {
    title: "Get chapters",
    description:
      "Extract chapter markers. Prefers official InnerTube markers, falls back to description timestamps. Returns source: markers|description|none.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("chapters", { url: urlOrId })),
);

server.registerTool(
  "get_thumbnails",
  {
    title: "Get thumbnails",
    description: "Return every thumbnail rendition (URL, width, height) for a YouTube video.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("thumbnails", { url: urlOrId })),
);

server.registerTool(
  "list_formats",
  {
    title: "List media formats",
    description:
      "List downloadable stream formats (itag, mime, quality, bitrate, directUrl). Formats with directUrl=true can be downloaded with download_media.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("formats", { url: urlOrId })),
);

server.registerTool(
  "download_media",
  {
    title: "Download media",
    description:
      "Download one media format to a local path. Supports resume via .part files. Pass an itag from list_formats, or omit for best muxed format.",
    inputSchema: {
      urlOrId,
      outputPath: z.string().min(1).describe("Absolute path for the downloaded file"),
      itag: z.number().int().positive().optional().describe("Format itag; omit for best muxed format"),
    },
  },
  async ({ urlOrId, outputPath, itag }) =>
    handle(() =>
      runEngine("download", { url: urlOrId, out: outputPath, itag }, { timeoutMs: 30 * 60 * 1000 }),
    ),
);

server.registerTool(
  "get_video_pack",
  {
    title: "Get video analysis pack (RAG)",
    description:
      "Build an agent-ready briefing for one video: metadata, chapters, citation-tagged transcript chunks (each with a [1:07:12] citation and a url that opens the video at that moment), and a markdown document for RAG/chat context. Uses disk cache so repeat analysis does not re-hit YouTube.",
    inputSchema: {
      urlOrId,
      lang,
      chunkChars: z
        .number()
        .int()
        .positive()
        .max(4000)
        .optional()
        .describe("Target characters per RAG chunk (default 800)"),
      skipSponsors: z
        .boolean()
        .optional()
        .describe("Remove SponsorBlock-flagged ranges; requires YTUBE_SPONSORBLOCK=1"),
    },
  },
  async ({ urlOrId, lang, chunkChars, skipSponsors }) =>
    handle(() =>
      runEngine(
        "videopack",
        { url: urlOrId, lang, "chunk-chars": chunkChars ?? 800, "skip-sponsors": skipSponsors },
        { timeoutMs: 180_000 },
      ),
    ),
);

const batchPackInput = {
  lang,
  chunkChars: z
    .number()
    .int()
    .positive()
    .max(4000)
    .optional()
    .describe("Target characters per RAG chunk (default 800)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Videos to process in this call (default 5, max 50). Each video costs several YouTube requests."),
  cursor: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Resume index from the previous call's nextCursor"),
  includeChunks: z
    .boolean()
    .optional()
    .describe("Embed full chunk text; omit for a cheap table of contents"),
  skipSponsors: z.boolean().optional().describe("Remove SponsorBlock ranges; requires YTUBE_SPONSORBLOCK=1"),
  contentType: z
    .enum(["all", "videos", "shorts"])
    .optional()
    .describe("For channel sources: include both tabs, long-form videos, or Shorts"),
  detail: z
    .enum(["summary", "analysis"])
    .optional()
    .describe("analysis embeds metadata, transcript, chapters, and RAG chunks"),
};

type BatchPackArgs = {
  lang?: string;
  chunkChars?: number;
  limit?: number;
  cursor?: number;
  includeChunks?: boolean;
  skipSponsors?: boolean;
  contentType?: "all" | "videos" | "shorts";
  detail?: "summary" | "analysis";
};

function runBatchPack(source: string, args: BatchPackArgs) {
  return runEngine(
    "packbatch",
    {
      url: source,
      lang: args.lang,
      "chunk-chars": args.chunkChars,
      limit: args.limit,
      cursor: args.cursor,
      "include-chunks": args.includeChunks,
      "skip-sponsors": args.skipSponsors,
      "content-type": args.contentType,
      detail: args.detail,
    },
    { timeoutMs: 15 * 60 * 1000 },
  );
}

server.registerTool(
  "get_playlist_pack",
  {
    title: "Get playlist analysis pack (RAG)",
    description:
      "Build citation-ready packs for every video in a playlist. Videos without captions are reported in `failures` instead of failing the batch. Processes `limit` videos per call (default 5, max 50) and returns nextCursor/hasMore so you can resume without redoing work (cached videos are free).",
    inputSchema: {
      urlOrId: z.string().min(1).describe("Playlist URL or list= ID (PL…, UU…, …)"),
      ...batchPackInput,
    },
  },
  async ({ urlOrId, ...args }) => handle(() => runBatchPack(urlOrId, args)),
);

server.registerTool(
  "get_channel_pack",
  {
    title: "Get channel analysis pack (RAG)",
    description:
      "Progressively discover and pack every long-form upload and Short from a channel. Accepts a channel URL, UC… ID, or @handle. Use contentType to filter and detail=analysis for metadata + transcript + chapters + RAG chunks. Processes `limit` videos per call (default 5, max 50). Videos without captions are reported in failures; follow nextCursor until hasMore is false.",
    inputSchema: {
      urlOrId: z.string().min(1).describe("Channel URL, UC… ID, or @handle"),
      ...batchPackInput,
    },
  },
  async ({ urlOrId, ...args }) => handle(() => runBatchPack(urlOrId, args)),
);

server.registerTool(
  "get_channel_catalog",
  {
    title: "List every channel video and Short",
    description:
      "Progressively enumerate a creator's Videos and Shorts tabs with continuation paging and deduplication. Follow nextCursor until hasMore is false; complete then confirms exhaustive discovery.",
    inputSchema: {
      urlOrId: z.string().min(1).describe("Channel URL, UC… ID, or @handle"),
      contentType: z.enum(["all", "videos", "shorts"]).optional().describe("Catalog subset (default all)"),
      limit: z.number().int().positive().max(200).optional().describe("Items in this page (default 50)"),
      cursor: z.number().int().nonnegative().optional().describe("Resume index from nextCursor"),
      refresh: z
        .boolean()
        .optional()
        .describe("Start a fresh snapshot; use only with cursor 0 because previous cursors become invalid"),
    },
  },
  async ({ urlOrId, contentType, limit, cursor, refresh }) =>
    handle(() =>
      runEngine(
        "channelcatalog",
        { url: urlOrId, "content-type": contentType, limit, cursor, refresh },
        { timeoutMs: 15 * 60 * 1000 },
      ),
    ),
);

server.registerTool(
  "export_channel_analysis",
  {
    title: "Export complete channel analysis",
    description:
      "Discover every requested long-form upload and Short, then write metadata, transcript, chapters, and RAG chunks as resumable JSONL. Returns local dataset/checkpoint paths and progress. Reuse jobId to resume a paused export. Set untilDone=true (and autoBrowser=true) to retry IP_BLOCKED videos via the headless browser and keep going until the catalog is finished instead of pausing.",
    inputSchema: {
      urlOrId: z.string().min(1).describe("Channel URL, UC… ID, or @handle"),
      contentType: z.enum(["all", "videos", "shorts"]).optional().describe("Export subset (default all)"),
      lang,
      chunkChars: z.number().int().positive().max(4000).optional().describe("RAG chunk size (default 800)"),
      skipSponsors: z.boolean().optional().describe("Remove SponsorBlock ranges; requires YTUBE_SPONSORBLOCK=1"),
      jobId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,96}$/)
        .optional()
        .describe("Job ID returned by a paused export; omit to use the deterministic channel/options job"),
      autoBrowser: z
        .boolean()
        .optional()
        .describe("Enable Playwright browser fallback for this run when timedtext is IP-blocked"),
      untilDone: z
        .boolean()
        .optional()
        .describe(
          "Retry blocked videos (with browser) and continue until every catalog item is packed or permanently failed — does not pause the whole job on IP_BLOCKED",
        ),
      maxRetryRounds: z
        .number()
        .int()
        .positive()
        .max(10)
        .optional()
        .describe("Retries per video when blocked (default 3 with untilDone)"),
      retryDelayMs: z
        .number()
        .int()
        .nonnegative()
        .max(600_000)
        .optional()
        .describe("Wait between blocked retries in ms (default 5000)"),
    },
  },
  async ({
    urlOrId,
    contentType,
    lang: language,
    chunkChars,
    skipSponsors,
    jobId,
    autoBrowser,
    untilDone,
    maxRetryRounds,
    retryDelayMs,
  }) =>
    handle(() =>
      runEngine(
        "channelpackall",
        {
          url: urlOrId,
          "content-type": contentType,
          lang: language,
          "chunk-chars": chunkChars,
          "skip-sponsors": skipSponsors,
          "job-id": jobId,
          "auto-browser": autoBrowser,
          "until-done": untilDone,
          "max-retry-rounds": maxRetryRounds,
          "retry-delay-ms": retryDelayMs,
        },
        { timeoutMs: untilDone ? 24 * 60 * 60 * 1000 : 15 * 60 * 1000 },
      ),
    ),
);

server.registerTool(
  "ask_video",
  {
    title: "Ask a question about a video",
    description:
      "Answer a question from one video without loading its whole transcript. Ranks the transcript's citation chunks against the question and returns only the best passages, each with a [M:SS] citation and a url that jumps to that moment, plus a ready-to-use markdown context block. Use this instead of get_transcript for long videos.",
    inputSchema: {
      urlOrId,
      lang,
      question: z.string().min(1).describe("The question to answer from the video"),
      topK: z.number().int().positive().max(20).optional().describe("Passages to return (default 5)"),
      chunkChars: z
        .number()
        .int()
        .positive()
        .max(4000)
        .optional()
        .describe("Passage size in characters (default 600)"),
    },
  },
  async ({ urlOrId, lang, question, topK, chunkChars }) =>
    handle(() =>
      runEngine(
        "ask",
        { url: urlOrId, query: question, lang, "top-k": topK, "chunk-chars": chunkChars },
        { timeoutMs: 180_000 },
      ),
    ),
);

server.registerTool(
  "get_sponsor_segments",
  {
    title: "Get sponsor segments",
    description:
      "List community-flagged sponsor, intro, outro, and self-promo ranges for a video. Off by default: set YTUBE_SPONSORBLOCK=1 to enable, because it sends the video ID to the third-party SponsorBlock database.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("sponsors", { url: urlOrId })),
);

server.registerTool(
  "diagnose_transcript",
  {
    title: "Diagnose transcript extraction",
    description:
      "Run the caption resolution ladder and report each stage: InnerTube client playability, track counts, selected language/source, caption body bytes/format, cache hit/stale availability, and remaining rate budget. Use when get_transcript fails or returns empty.",
    inputSchema: {
      urlOrId,
      lang: z.string().optional().describe("Language preference chain to evaluate, e.g. 'hi,en'"),
    },
  },
  async ({ urlOrId, lang }) => handle(() => runEngine("diagnose", { url: urlOrId, lang })),
);

server.registerTool(
  "get_related",
  {
    title: "Get related videos",
    description: "List videos related / suggested alongside the given video.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("related", { url: urlOrId })),
);

server.registerTool(
  "get_comments",
  {
    title: "Get comments",
    description:
      "Fetch top-level comments for a video (author, text, likes, published, reply count). Sort by top or newest, expand replies for the first N threads, and page further with the returned nextCursor.",
    inputSchema: {
      urlOrId,
      limit: z.number().int().positive().max(100).optional().describe("Max comments to return (default 20)"),
      sort: z.enum(["top", "newest"]).optional().describe("Comment sort order"),
      cursor: z.string().optional().describe("Continuation token from a previous call's nextCursor"),
      replies: z
        .number()
        .int()
        .nonnegative()
        .max(20)
        .optional()
        .describe("Fetch replies for up to N threads (default 0; each costs one request)"),
    },
  },
  async ({ urlOrId, limit, sort, cursor, replies }) =>
    handle(() => runEngine("comments", { url: urlOrId, limit, sort: sort ?? "top", cursor, replies })),
);

server.registerTool(
  "get_heatmap",
  {
    title: "Get most-replayed heatmap",
    description: "Return YouTube's most-replayed intensity points over time when available.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("heatmap", { url: urlOrId })),
);

server.registerTool(
  "get_storyboards",
  {
    title: "Get storyboards",
    description: "Parse storyboard (scrubbing preview) tile URLs at each resolution level.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("storyboards", { url: urlOrId })),
);

server.registerTool(
  "get_manifests",
  {
    title: "Get DASH/HLS manifests",
    description: "Expose dashManifestUrl / hlsManifestUrl and live status from the player response.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("manifests", { url: urlOrId })),
);

server.registerTool(
  "get_playlist",
  {
    title: "Get playlist",
    description: "Fetch a playlist's title, owner, and video items. Pass a playlist URL or list= ID.",
    inputSchema: {
      urlOrId: z.string().min(1).describe("Playlist URL or ID (PL..., UU..., etc.)"),
      limit: z.number().int().positive().max(200).optional().describe("Max items (default 50)"),
    },
  },
  async ({ urlOrId, limit }) => handle(() => runEngine("playlist", { url: urlOrId, limit })),
);

server.registerTool(
  "get_channel",
  {
    title: "Get channel",
    description: "Fetch channel metadata and recent videos. Pass a channel URL, UC... ID, or @handle.",
    inputSchema: {
      urlOrId: z.string().min(1).describe("Channel URL, UC... ID, or @handle"),
      limit: z.number().int().positive().max(50).optional().describe("Max recent videos (default 20)"),
    },
  },
  async ({ urlOrId, limit }) => handle(() => runEngine("channel", { url: urlOrId, limit })),
);

server.registerTool(
  "search_youtube",
  {
    title: "Search YouTube",
    description: "Search YouTube for videos, channels, and playlists matching a query.",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      limit: z.number().int().positive().max(50).optional().describe("Max results (default 20)"),
    },
  },
  async ({ query, limit }) => handle(() => runEngine("search", { query, limit })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("YouTube Client running on stdio");
