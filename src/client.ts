/**
 * YouTube Client — programmatic Node.js API (no MCP process required).
 *
 * Library entry (does not start MCP):
 *   import { YouTubeClient, YtubeError } from "youtube-client-mcp";
 *
 * MCP server: `npx youtube-client-mcp` or the `youtube-client` binary.
 */
export { runEngine, resolveEngine, YtubeError } from "./go-bridge.js";
export type { EngineError, RunOptions } from "./go-bridge.js";
export { createEngine, Engine, dispatch } from "./engine/index.js";

import { runEngine, type RunOptions } from "./go-bridge.js";

export type SubtitleFormat = "srt" | "vtt" | "ass" | "json" | "text" | "chapters";
export type CommentSort = "top" | "newest";
export type ChannelContentType = "all" | "videos" | "shorts";
export type BatchDetail = "summary" | "analysis";

export interface YouTubeClientOptions extends RunOptions {
  /** Default caption language (e.g. "en" or preference chain "hi,en"). */
  lang?: string;
}

export interface TranscriptOptions {
  /** Language code or comma preference chain, e.g. "hi,en". */
  lang?: string;
  /** Merge mid-phrase ASR cues into sentences (default true for auto captions). */
  merge?: boolean;
  /** Segment index to start from; use the previous page's `nextCursor`. */
  cursor?: number;
  /** Characters per page; omit to return the whole transcript at once. */
  maxChars?: number;
  /** Hard-fail when the requested language is missing (default: best-effort). */
  strict?: boolean;
  /** Include word-level timings from json3 captions. */
  words?: boolean;
  /** Force YouTube auto-translate to this language. */
  translateTo?: string;
  /** Drop [Music] / [Applause] style sound-tag cues. */
  stripSoundTags?: boolean;
  /** Attach chapter-bucketed transcript sections. */
  groupByChapters?: boolean;
}

export interface PackOptions {
  lang?: string;
  chunkChars?: number;
  /** Drop SponsorBlock-flagged ranges (needs `YTUBE_SPONSORBLOCK=1`). */
  skipSponsors?: boolean;
}

export interface BatchPackOptions extends PackOptions {
  /** Videos to process in this call (default 5, max 25). */
  limit?: number;
  /** Resume index from a previous call's `nextCursor`. */
  cursor?: number;
  /** Embed full chunk text; omit for a cheap table of contents. */
  includeChunks?: boolean;
  /** For channel sources, include both tabs, long-form videos, or Shorts. */
  contentType?: ChannelContentType;
  /** `analysis` embeds metadata, transcripts, chapters, and chunks. */
  detail?: BatchDetail;
}

export interface ChannelCatalogOptions {
  contentType?: ChannelContentType;
  /** Catalog items returned in this call (default 50, max 200). */
  limit?: number;
  /** Resume index from a previous page's `nextCursor`. */
  cursor?: number;
  /** Start a fresh channel snapshot; only valid with cursor 0. */
  refresh?: boolean;
}

export interface ChannelExportOptions extends PackOptions {
  contentType?: ChannelContentType;
  /** Resume a prior checkpointed export. */
  jobId?: string;
}

export interface AskOptions {
  lang?: string;
  /** Passages to return (default 5). */
  topK?: number;
  chunkChars?: number;
}

export interface CommentsOptions {
  limit?: number;
  sort?: CommentSort;
  /** Resume token from a previous call's `nextCursor`. */
  cursor?: string;
  /** Expand replies for up to N threads; each costs one extra request. */
  replies?: number;
}

/**
 * High-level TypeScript wrapper around the pure Node.js extraction engine.
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
  getVideoPack(urlOrId: string, opts?: PackOptions) {
    return runEngine(
      "videopack",
      {
        url: urlOrId,
        lang: opts?.lang ?? this.options.lang,
        "chunk-chars": opts?.chunkChars ?? 800,
        "skip-sponsors": opts?.skipSponsors,
      },
      this.opts({ timeoutMs: this.options.timeoutMs ?? 180_000 }),
    );
  }

  /**
   * Pack every video in a playlist, a creator's Videos/Shorts catalog, or an
   * explicit list. Videos that fail (captions disabled, private, …) are
   * reported in `failures`; follow `nextCursor` for the rest.
   */
  getBatchPack(source: string, opts?: BatchPackOptions) {
    return runEngine(
      "packbatch",
      {
        url: source,
        lang: opts?.lang ?? this.options.lang,
        "chunk-chars": opts?.chunkChars ?? 800,
        limit: opts?.limit,
        cursor: opts?.cursor,
        "include-chunks": opts?.includeChunks,
        "skip-sponsors": opts?.skipSponsors,
        "content-type": opts?.contentType,
        detail: opts?.detail,
      },
      this.opts({ timeoutMs: this.options.timeoutMs ?? 15 * 60 * 1000 }),
    );
  }

  /** `getBatchPack` for a playlist URL or list= ID. */
  getPlaylistPack(playlist: string, opts?: BatchPackOptions) {
    return this.getBatchPack(playlist, opts);
  }

  /** `getBatchPack` for a channel URL, UC… ID, or @handle. */
  getChannelPack(channel: string, opts?: BatchPackOptions) {
    return this.getBatchPack(channel, opts);
  }

  /** Progressively list every long-form upload and Short from a creator channel. */
  getChannelCatalog(channel: string, opts?: ChannelCatalogOptions) {
    return runEngine(
      "channelcatalog",
      {
        url: channel,
        "content-type": opts?.contentType,
        limit: opts?.limit,
        cursor: opts?.cursor,
        refresh: opts?.refresh,
      },
      this.opts(),
    );
  }

  /** Export full channel analyses to a resumable local JSONL dataset. */
  exportChannelAnalysis(channel: string, opts?: ChannelExportOptions) {
    return runEngine(
      "channelpackall",
      {
        url: channel,
        lang: opts?.lang ?? this.options.lang,
        "chunk-chars": opts?.chunkChars ?? 800,
        "skip-sponsors": opts?.skipSponsors,
        "content-type": opts?.contentType,
        "job-id": opts?.jobId,
      },
      this.opts({ timeoutMs: this.options.timeoutMs ?? 15 * 60 * 1000 }),
    );
  }

  /**
   * Answer a question from one video without loading the whole transcript:
   * returns the highest-scoring passages with citation timestamps and links.
   */
  askVideo(urlOrId: string, question: string, opts?: AskOptions) {
    return runEngine(
      "ask",
      {
        url: urlOrId,
        query: question,
        lang: opts?.lang ?? this.options.lang,
        "top-k": opts?.topK,
        "chunk-chars": opts?.chunkChars,
      },
      this.opts({ timeoutMs: this.options.timeoutMs ?? 180_000 }),
    );
  }

  /**
   * Community-flagged sponsor/intro/outro ranges. Requires the opt-in
   * `YTUBE_SPONSORBLOCK=1` because it queries a third-party service.
   */
  getSponsorSegments(urlOrId: string) {
    return runEngine("sponsors", { url: urlOrId }, this.opts());
  }

  getTranscript(urlOrId: string, opts?: TranscriptOptions) {
    const merge = opts?.merge;
    return runEngine(
      "transcript",
      {
        url: urlOrId,
        lang: opts?.lang ?? this.options.lang,
        merge: merge === undefined ? undefined : merge ? "true" : "false",
        cursor: opts?.cursor,
        "max-chars": opts?.maxChars,
        strict: opts?.strict,
        words: opts?.words,
        "translate-to": opts?.translateTo,
        "strip-sound-tags": opts?.stripSoundTags,
        "group-chapters": opts?.groupByChapters,
      },
      this.opts(),
    );
  }

  /**
   * Run the caption resolution ladder and report each stage (clients, tracks,
   * body bytes, cache, rate budget). Use when a transcript call fails.
   */
  diagnoseTranscript(urlOrId: string, opts?: { lang?: string }) {
    return runEngine(
      "diagnose",
      { url: urlOrId, lang: opts?.lang ?? this.options.lang },
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

  getComments(urlOrId: string, opts?: CommentsOptions) {
    return runEngine(
      "comments",
      {
        url: urlOrId,
        limit: opts?.limit,
        sort: opts?.sort ?? "top",
        cursor: opts?.cursor,
        replies: opts?.replies,
      },
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
