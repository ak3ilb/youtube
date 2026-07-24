/**
 * YouTube Client — programmatic Node.js API (no MCP process required).
 *
 * Prefer this module when embedding extraction in your own app/scripts:
 *   import { YouTubeClient, YtubeError } from "@ak3il/youtube-client";
 *
 * For Cursor / Claude agents, run the MCP binary instead (`npx @ak3il/youtube-client` / `youtube-client`).
 */
export { runEngine, resolveEngine, YtubeError } from "./go-bridge.js";
export type { EngineError, RunOptions } from "./go-bridge.js";

import { runEngine, type RunOptions } from "./go-bridge.js";

export type SubtitleFormat = "srt" | "vtt" | "ass" | "json" | "text";
export type CommentSort = "top" | "newest";

export interface YouTubeClientOptions extends RunOptions {
  /** Default caption language (e.g. "en"). */
  lang?: string;
}

/**
 * High-level TypeScript wrapper around the native Go `ytube` engine.
 * Same capabilities as the MCP tools, usable from any Node 20+ script.
 */
export class YouTubeClient {
  constructor(private readonly options: YouTubeClientOptions = {}) {}

  private opts(extra?: RunOptions): RunOptions {
    return { timeoutMs: this.options.timeoutMs, ...extra };
  }

  /** Video metadata: title, channel, duration, views, thumbnails, … */
  getVideoInfo(urlOrId: string) {
    return runEngine("info", { url: urlOrId }, this.opts());
  }

  /**
   * Agent-ready briefing: metadata + chapters + citation chunks + markdown.
   * Primary entry for RAG / summarization workflows.
   */
  getVideoPack(urlOrId: string, opts?: { lang?: string; chunkChars?: number }) {
    return runEngine(
      "videopack",
      {
        url: urlOrId,
        lang: opts?.lang ?? this.options.lang,
        "chunk-chars": opts?.chunkChars ?? 800,
      },
      this.opts({ timeoutMs: this.options.timeoutMs ?? 180_000 }),
    );
  }

  getTranscript(urlOrId: string, opts?: { lang?: string; merge?: boolean }) {
    const merge = opts?.merge;
    return runEngine(
      "transcript",
      {
        url: urlOrId,
        lang: opts?.lang ?? this.options.lang,
        merge: merge === undefined ? undefined : merge ? "true" : "false",
      },
      this.opts(),
    );
  }

  getTranscriptClip(
    urlOrId: string,
    start: string,
    opts?: { end?: string; lang?: string },
  ) {
    return runEngine(
      "transcript-clip",
      {
        url: urlOrId,
        start,
        end: opts?.end,
        lang: opts?.lang ?? this.options.lang,
      },
      this.opts(),
    );
  }

  searchTranscript(urlOrId: string, query: string, opts?: { lang?: string }) {
    return runEngine(
      "transcript-search",
      { url: urlOrId, query, lang: opts?.lang ?? this.options.lang },
      this.opts(),
    );
  }

  exportSubtitles(
    urlOrId: string,
    opts?: { lang?: string; format?: SubtitleFormat; outputPath?: string },
  ) {
    return runEngine(
      "subtitles",
      {
        url: urlOrId,
        lang: opts?.lang ?? this.options.lang,
        format: opts?.format ?? "srt",
        out: opts?.outputPath,
      },
      this.opts(),
    );
  }

  listCaptions(urlOrId: string) {
    return runEngine("captions", { url: urlOrId }, this.opts());
  }

  getChapters(urlOrId: string) {
    return runEngine("chapters", { url: urlOrId }, this.opts());
  }

  getThumbnails(urlOrId: string) {
    return runEngine("thumbnails", { url: urlOrId }, this.opts());
  }

  listFormats(urlOrId: string) {
    return runEngine("formats", { url: urlOrId }, this.opts());
  }

  downloadMedia(urlOrId: string, outputPath: string, opts?: { itag?: number }) {
    return runEngine(
      "download",
      { url: urlOrId, out: outputPath, itag: opts?.itag },
      this.opts({ timeoutMs: this.options.timeoutMs ?? 30 * 60 * 1000 }),
    );
  }

  getRelated(urlOrId: string) {
    return runEngine("related", { url: urlOrId }, this.opts());
  }

  getComments(urlOrId: string, opts?: { limit?: number; sort?: CommentSort }) {
    return runEngine(
      "comments",
      { url: urlOrId, limit: opts?.limit, sort: opts?.sort ?? "top" },
      this.opts(),
    );
  }

  getHeatmap(urlOrId: string) {
    return runEngine("heatmap", { url: urlOrId }, this.opts());
  }

  getStoryboards(urlOrId: string) {
    return runEngine("storyboards", { url: urlOrId }, this.opts());
  }

  getManifests(urlOrId: string) {
    return runEngine("manifests", { url: urlOrId }, this.opts());
  }

  getPlaylist(urlOrId: string, opts?: { limit?: number }) {
    return runEngine("playlist", { url: urlOrId, limit: opts?.limit }, this.opts());
  }

  getChannel(urlOrId: string, opts?: { limit?: number }) {
    return runEngine("channel", { url: urlOrId, limit: opts?.limit }, this.opts());
  }

  search(query: string, opts?: { limit?: number }) {
    return runEngine("search", { query, limit: opts?.limit }, this.opts());
  }
}

/** Convenience singleton for one-off scripts. */
export const youtube = new YouTubeClient();
