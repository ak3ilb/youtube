#!/usr/bin/env node
/**
 * youtube-video-mcp — a standalone MCP server for single-video YouTube
 * operations, backed by a native Go extraction engine (no yt-dlp, no Python).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runEngine, YtubeError } from "./go-bridge.js";

const server = new McpServer({ name: "youtube-video-mcp", version: "1.0.0" });

const urlOrId = z
  .string()
  .min(1)
  .describe("A YouTube video URL (watch, youtu.be, shorts, embed, live) or a bare 11-character video ID");

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
    title: "Get transcript",
    description:
      "Download the transcript (captions) of a YouTube video as timed segments plus a joined plain-text body. Prefers manually-created captions over auto-generated ones. Optionally pass a BCP-47 language code such as 'en' or 'es'.",
    inputSchema: {
      urlOrId,
      lang: z
        .string()
        .optional()
        .describe("Preferred caption language code (e.g. 'en'). Omit for the best available track."),
    },
  },
  async ({ urlOrId, lang }) => handle(() => runEngine("transcript", { url: urlOrId, lang })),
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
      "Extract chapter markers (timestamp + title) from a YouTube video's description, using the same rules YouTube applies: the list must start at 0:00 and be ascending. Returns hasChapters=false when the video has none.",
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
      "List downloadable stream formats for a YouTube video (itag, mime type, quality, bitrate, audio/video flags). Formats with directUrl=true can be downloaded with download_media; the rest are protected by YouTube's signature challenge.",
    inputSchema: { urlOrId },
  },
  async ({ urlOrId }) => handle(() => runEngine("formats", { url: urlOrId })),
);

server.registerTool(
  "download_media",
  {
    title: "Download media",
    description:
      "Download one media format of a YouTube video to a local file path. Pass an itag from list_formats, or omit it to get the best combined audio+video format. Only formats with a direct URL are supported.",
    inputSchema: {
      urlOrId,
      outputPath: z.string().min(1).describe("Absolute path for the downloaded file (e.g. /tmp/video.mp4)"),
      itag: z.number().int().positive().optional().describe("Format itag from list_formats; omit for best muxed format"),
    },
  },
  async ({ urlOrId, outputPath, itag }) =>
    handle(() =>
      runEngine("download", { url: urlOrId, out: outputPath, itag }, { timeoutMs: 30 * 60 * 1000 }),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("youtube-video-mcp server running on stdio");
