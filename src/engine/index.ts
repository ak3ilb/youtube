/**
 * Public surface of the pure-TypeScript extraction engine.
 *
 * `dispatch` mirrors the command switch in cmd/ytube/main.go: it takes the same
 * command names and flag keys the Go CLI accepts and returns the same `data`
 * payload the CLI prints, throwing `ExtractError` where the CLI would print
 * `{"ok":false,"error":…}`.
 */
import { parseGoDuration } from "./cache.js";
import { sortOrDefault } from "./comments.js";
import { ExtractError } from "./errors.js";
import { Client, type ClientOptions } from "./innertube.js";
import { pageTranscript } from "./paging.js";
import { parseTimestamp } from "./timestamps.js";
import { Engine, createEngine } from "./transcript.js";
import type {
  AskResult,
  BatchPack,
  ChaptersResult,
  CommentsResult,
  DownloadResult,
  HeatmapResult,
  ManifestsResult,
  PlaylistResult,
  SponsorSegment,
  StoryboardsResult,
  SubtitleExport,
  Thumbnail,
  Transcript,
  TranscriptDiagnosis,
  TranscriptOptions,
  TranscriptPage,
  TranscriptSearchResult,
  VideoInfo,
  VideoPack,
} from "./types.js";
import type { CaptionTrackSummary } from "./transcript.js";
import type { ChannelPreferResult, SearchPreferResult } from "./dataapi.js";
import type { FormatsResult } from "./media.js";
import type { RelatedResultWithCache } from "./extras.js";

export { Engine, createEngine } from "./transcript.js";

export * from "./ask.js";
export * from "./batch.js";
export * from "./cache.js";
export * from "./chapters.js";
export * from "./comments.js";
export * from "./cookies.js";
export * from "./dataapi.js";
export * from "./diagnose.js";
export * from "./discovery.js";
export * from "./errors.js";
export * from "./extras.js";
export * from "./ids.js";
export * from "./innertube.js";
export * from "./media.js";
export * from "./paging.js";
export * from "./proxy.js";
export * from "./rag.js";
export * from "./sponsorblock.js";
export * from "./subtitles.js";
export * from "./timedtext-gate.js";
export * from "./timestamps.js";
export * from "./types.js";

// `transcript.ts` and `chapters.ts` both re-export shared JSON helpers, so the
// engine's own exports are listed explicitly to keep the barrel unambiguous.
export {
  buildTranscript,
  captionsFromPlayer,
  classifyPlayabilityFailure,
  enrichSegments,
  errorText,
  groupSegmentsByChapters,
  infoFromPlayer,
  isRetryableExtract,
  langBase,
  mergeASRSegments,
  normalizeCaptionText,
  parseLangChain,
  parseTimedTextXML,
  pickCaptionTrack,
  sentenceEnd,
  soundTagOnly,
  sourceOf,
  stripSoundTagSegments,
  toCaptionTrackSummary,
  trackAltUrls,
  trackBaseUrl,
  transcriptCacheKey,
  captionsCacheKey,
  withFormat,
  withPOToken,
  withTranscriptLang,
  appendUniqueUrl,
  type CaptionTrackSummary,
  type PickCaptionResult,
  type PlayerResponse,
  type RawCaptionTrack,
  type RawFormat,
  type ResolvedCaptions,
  type ResolvedCaptionsResult,
} from "./transcript.js";

/** Every command the Go CLI understands, in the same order as its usage line. */
export const COMMANDS = [
  "info",
  "transcript",
  "transcript-clip",
  "transcript-search",
  "subtitles",
  "captions",
  "chapters",
  "formats",
  "thumbnails",
  "download",
  "related",
  "comments",
  "heatmap",
  "storyboards",
  "manifests",
  "playlist",
  "channel",
  "search",
  "videopack",
  "packbatch",
  "ask",
  "sponsors",
  "diagnose",
] as const;

export type Command = (typeof COMMANDS)[number];

/** Commands that cannot run without `--url`, mirroring Go's `needsURL` map. */
const NEEDS_URL: ReadonlySet<string> = new Set([
  "info",
  "transcript",
  "transcript-clip",
  "transcript-search",
  "captions",
  "chapters",
  "formats",
  "thumbnails",
  "download",
  "subtitles",
  "related",
  "comments",
  "heatmap",
  "storyboards",
  "manifests",
  "playlist",
  "channel",
  "videopack",
  "ask",
  "sponsors",
  "packbatch",
  "diagnose",
]);

/** Flag values arrive as the CLI's strings or as already-typed JS values. */
export type FlagValue = string | number | boolean | null | undefined;

/** The `--flag` keys of cmd/ytube, without the leading dashes. */
export type DispatchFlags = Record<string, FlagValue>;

export interface DispatchOptions {
  /** Reuse an engine (and its cookie jar / cache) across dispatches. */
  engine?: Engine;
  /** Per-request timeout; defaults to the `timeout` flag, else 30s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra `Client` options when `dispatch` builds the engine itself. */
  clientOptions?: ClientOptions;
}

/** Payload each command resolves to; identical to the Go CLI's `data` field. */
export interface DispatchResults {
  info: VideoInfo;
  transcript: TranscriptPage;
  "transcript-clip": Transcript;
  "transcript-search": TranscriptSearchResult;
  subtitles: SubtitleExport;
  captions: { tracks: CaptionTrackSummary[]; count: number };
  chapters: ChaptersResult;
  formats: FormatsResult;
  thumbnails: { videoId: string; thumbnails: Thumbnail[] };
  download: DownloadResult;
  related: RelatedResultWithCache;
  comments: CommentsResult;
  heatmap: HeatmapResult;
  storyboards: StoryboardsResult;
  manifests: ManifestsResult;
  playlist: PlaylistResult;
  channel: ChannelPreferResult;
  search: SearchPreferResult;
  videopack: VideoPack;
  packbatch: BatchPack;
  ask: AskResult;
  sponsors: { segments: SponsorSegment[]; count: number };
  diagnose: TranscriptDiagnosis;
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

function flagString(flags: DispatchFlags, key: string, fallback = ""): string {
  const raw = flags[key];
  if (raw === undefined || raw === null) {
    return fallback;
  }
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "boolean") {
    return raw ? "true" : "false";
  }
  return String(raw);
}

function flagInt(flags: DispatchFlags, key: string, fallback = 0): number {
  const raw = flags[key];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  }
  if (typeof raw === "boolean") {
    return raw ? 1 : 0;
  }
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function flagBool(flags: DispatchFlags, key: string, fallback = false): boolean {
  const raw = flags[key];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "number") {
    return raw !== 0;
  }
  const value = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(value)) {
    return true;
  }
  if (FALSE_WORDS.has(value)) {
    return false;
  }
  return fallback;
}

/** `--merge auto|true|false`: `undefined` keeps the per-track default. */
function mergeFlag(flags: DispatchFlags): boolean | undefined {
  const raw = flagString(flags, "merge", "auto").trim().toLowerCase();
  if (TRUE_WORDS.has(raw)) {
    return true;
  }
  if (FALSE_WORDS.has(raw)) {
    return false;
  }
  return undefined;
}

/**
 * Reads a numeric cursor. Non-numeric cursors belong to token-based commands
 * (comments) and are ignored here, exactly like Go's `intCursor`.
 */
export function intCursor(value: FlagValue): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  }
  const text = String(value ?? "").trim();
  if (!/^[+-]?\d+$/.test(text)) {
    return 0;
  }
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Accepts seconds (`91.5`) or a timestamp (`1:31`), like Go's `parseTimeArg`. */
export function parseTimeArg(value: string): number {
  if (value.includes(":")) {
    return parseTimestamp(value);
  }
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) {
    throw new ExtractError({
      code: "INVALID_TIMESTAMP",
      message: "Could not parse time value: " + value,
    });
  }
  return n;
}

function parseRange(startRaw: string, endRaw: string): { start: number; end: number } {
  return {
    start: startRaw === "" ? 0 : parseTimeArg(startRaw),
    end: endRaw === "" ? 0 : parseTimeArg(endRaw),
  };
}

function transcriptOptions(flags: DispatchFlags): TranscriptOptions {
  return {
    lang: flagString(flags, "lang") || undefined,
    merge: mergeFlag(flags),
    strict: flagBool(flags, "strict"),
    words: flagBool(flags, "words"),
    translateTo: flagString(flags, "translate-to") || undefined,
    stripSoundTags: flagBool(flags, "strip-sound-tags"),
    groupByChapters: flagBool(flags, "group-chapters"),
  };
}

function usage(): string {
  return "Usage: ytube <" + COMMANDS.join("|") + "> [options]";
}

function requireFlag(flags: DispatchFlags, key: string, command: string): string {
  const value = flagString(flags, key);
  if (value === "") {
    throw new ExtractError({
      code: "USAGE",
      message: `--${key} is required for ${command}`,
    });
  }
  return value;
}

/**
 * Builds an engine from the CLI-style flags: cookies from `--cookies` or
 * `YTUBE_COOKIES`, API key from `--api-key` or `YOUTUBE_API_KEY`.
 */
export async function createDispatchEngine(
  flags: DispatchFlags = {},
  options: DispatchOptions = {},
): Promise<Engine> {
  const cookies = flagString(flags, "cookies") || (process.env.YTUBE_COOKIES ?? "").trim();
  const apiKey = flagString(flags, "api-key") || (process.env.YOUTUBE_API_KEY ?? "").trim();
  const timeoutFlag = parseGoDuration(flagString(flags, "timeout"));
  const timeoutMs =
    options.timeoutMs ?? (timeoutFlag !== undefined && timeoutFlag > 0 ? timeoutFlag : undefined);

  const client = new Client({
    ...options.clientOptions,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(apiKey !== "" ? { apiKey } : {}),
  });
  if (cookies !== "") {
    await client.withCookies(cookies);
  }
  return createEngine(client);
}

/**
 * Runs one command and returns its data payload. Failures throw `ExtractError`
 * (aliased as `YtubeError`) carrying the same code/message/details the Go CLI
 * would have emitted.
 */
export async function dispatch<C extends keyof DispatchResults>(
  command: C,
  flags?: DispatchFlags,
  options?: DispatchOptions,
): Promise<DispatchResults[C]>;
export async function dispatch(
  command: string,
  flags?: DispatchFlags,
  options?: DispatchOptions,
): Promise<unknown>;
export async function dispatch(
  command: string,
  flags: DispatchFlags = {},
  options: DispatchOptions = {},
): Promise<unknown> {
  const url = flagString(flags, "url");
  if (NEEDS_URL.has(command) && url === "") {
    throw new ExtractError({
      code: "USAGE",
      message: "The --url flag is required for " + command,
    });
  }

  const engine = options.engine ?? (await createDispatchEngine(flags, options));
  const signal = options.signal;
  const lang = flagString(flags, "lang") || undefined;
  const limit = flagInt(flags, "limit", 0);

  switch (command) {
    case "info":
      return engine.info(url, signal);

    case "transcript": {
      const transcript = await engine.transcriptWithOptions(url, transcriptOptions(flags), signal);
      return pageTranscript(
        transcript,
        intCursor(flags["cursor"]),
        flagInt(flags, "max-chars", 0),
      );
    }

    case "transcript-clip": {
      const range = parseRange(flagString(flags, "start"), flagString(flags, "end"));
      return engine.transcriptClip(url, lang, range.start, range.end, signal);
    }

    case "transcript-search": {
      const query = requireFlag(flags, "query", "transcript-search");
      return engine.searchTranscript(url, lang, query, 1, signal);
    }

    case "subtitles":
      return engine.exportSubtitles(
        url,
        lang,
        flagString(flags, "format", "srt"),
        flagString(flags, "out"),
        signal,
      );

    case "captions": {
      const tracks = await engine.listCaptions(url, signal);
      return { tracks, count: tracks.length };
    }

    case "chapters":
      return engine.chapters(url, signal);

    case "formats":
      return engine.formats(url, signal);

    case "thumbnails":
      return engine.thumbnails(url, signal);

    case "download": {
      const out = flagString(flags, "out");
      if (out === "") {
        throw new ExtractError({
          code: "USAGE",
          message: "The --out flag is required for download",
        });
      }
      return engine.download(url, flagInt(flags, "itag", 0), out, signal);
    }

    case "related":
      return engine.related(url, signal);

    case "comments":
      return engine.comments(
        url,
        {
          limit,
          sort: sortOrDefault(flagString(flags, "sort", "top")),
          cursor: flagString(flags, "cursor"),
          replies: flagInt(flags, "replies", 0),
        },
        signal,
      );

    case "heatmap":
      return engine.heatmap(url, signal);

    case "storyboards":
      return engine.storyboards(url, signal);

    case "manifests":
      return engine.manifests(url, signal);

    case "playlist":
      return engine.playlist(url, limit, signal);

    case "channel":
      return engine.channelPreferAPI(url, limit, signal);

    case "search": {
      const query = requireFlag(flags, "query", "search");
      return engine.searchPreferAPI(query, limit, signal);
    }

    case "videopack":
      return engine.videoPack(
        url,
        {
          lang,
          chunkChars: flagInt(flags, "chunk-chars", 800),
          skipSponsors: flagBool(flags, "skip-sponsors"),
        },
        signal,
      );

    case "packbatch":
      return engine.batchPack(
        url,
        {
          lang,
          chunkChars: flagInt(flags, "chunk-chars", 800),
          limit,
          cursor: intCursor(flags["cursor"]),
          includeChunks: flagBool(flags, "include-chunks"),
          skipSponsors: flagBool(flags, "skip-sponsors"),
        },
        signal,
      );

    case "ask": {
      const query = requireFlag(flags, "query", "ask");
      return engine.askVideo(
        url,
        query,
        {
          lang,
          topK: flagInt(flags, "top-k", 5),
          chunkChars: flagInt(flags, "chunk-chars", 800),
        },
        signal,
      );
    }

    case "sponsors": {
      const segments = await engine.sponsorSegments(url, signal);
      return { segments, count: segments.length };
    }

    case "diagnose":
      return engine.diagnoseTranscript(url, lang, signal);

    default:
      throw new ExtractError({
        code: "USAGE",
        message: `Unknown command ${JSON.stringify(command)}. ${usage()}`,
      });
  }
}
