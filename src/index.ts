#!/usr/bin/env node
/**
 * YouTube Client — a standalone MCP server for YouTube operations,
 * backed by a native Go extraction engine (no yt-dlp, no Python).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runEngine, YtubeError } from "./go-bridge.js";

const server = new McpServer({ name: "YouTube Client", version: "1.0.0" });

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
      "Download the full transcript with timestamps. Auto-generated captions are sentence-merged by default (YouTube ASR chops mid-phrase into 2–4s cues; merging restores readable continuous text covering the whole video). Each segment includes start/end and [M:SS] timestamps. Optional lang; if missing, tries YouTube auto-translate.",
    inputSchema: {
      urlOrId,
      lang,
      merge: z
        .boolean()
        .optional()
        .describe("Merge mid-phrase ASR cues into sentences (default true for auto-generated tracks)"),
    },
  },
  async ({ urlOrId, lang, merge }) =>
    handle(() =>
      runEngine("transcript", {
        url: urlOrId,
        lang,
        merge: merge === undefined ? undefined : merge ? "true" : "false",
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
      "Build an agent-ready briefing for one video: metadata, chapters, citation-tagged transcript chunks (e.g. [1:07:12]), and a markdown document for RAG/chat context. Uses disk cache so repeat analysis does not re-hit YouTube.",
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
    },
  },
  async ({ urlOrId, lang, chunkChars }) =>
    handle(() =>
      runEngine("videopack", { url: urlOrId, lang, "chunk-chars": chunkChars ?? 800 }, { timeoutMs: 180_000 }),
    ),
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
    description: "Fetch top-level comments for a video (author, text, likes, published). Optional limit and sort (top|newest).",
    inputSchema: {
      urlOrId,
      limit: z.number().int().positive().max(100).optional().describe("Max comments to return (default 20)"),
      sort: z.enum(["top", "newest"]).optional().describe("Comment sort order"),
    },
  },
  async ({ urlOrId, limit, sort }) =>
    handle(() => runEngine("comments", { url: urlOrId, limit, sort: sort ?? "top" })),
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
