/**
 * Multi-video packs for a playlist, channel, or explicit video list.
 * Ported from internal/youtube/batch.go.
 *
 * A batch never fails as a whole: videos YouTube will not give captions for are
 * reported in `failures`, and only budget/connectivity errors stop the run early
 * because those would hit every remaining video too.
 */
import { browserTranscriptEnabled } from "./browser-transcript.js";
import { asRecord, asString } from "./chapters.js";
import { discoverChannelCatalog } from "./channel-catalog.js";
import { playlist } from "./discovery.js";
import { ExtractError, isExtractError } from "./errors.js";
import { parseChannelRef, parsePlaylistID, parseVideoId } from "./ids.js";
import { videoPackWithOptions, videoPackWithTranscript } from "./rag.js";
import { formatTimestamp } from "./timestamps.js";
import { errorText, type Engine } from "./transcript.js";
import type {
  BatchFailure,
  BatchItem,
  BatchOptions,
  BatchPack,
  BatchSourceKind,
  ChannelCatalogContentFilter,
  ChannelItemContentType,
} from "./types.js";

export type { BatchFailure, BatchItem, BatchOptions, BatchPack } from "./types.js";

export const DEFAULT_BATCH_LIMIT = 5;
/**
 * Ceiling for one pack page. Agents routinely ask for 20-30 videos per call,
 * so the cap leaves headroom above that while still bounding a single response.
 */
export const MAX_BATCH_LIMIT = 50;

/**
 * Videos to process in one pack page: absent/non-positive falls back to the
 * cheap default, and anything above the ceiling is clamped instead of rejected
 * so an over-eager agent still gets a usable page.
 */
export function clampBatchLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_BATCH_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_BATCH_LIMIT);
}

export const HOW_TO_CITE_BATCH =
  "Every chunk carries its own video citation and url; cite the video title plus [M:SS].";

/** Codes that will hit every remaining video, so the batch stops early. */
const FATAL_BATCH_CODES = new Set([
  "RATE_BUDGET_EXCEEDED",
  "RATE_LIMITED",
  "IP_BLOCKED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "ACCESS_DENIED",
]);

interface BatchSource {
  kind: BatchSourceKind;
  id: string;
  title: string;
  ids: string[];
  names: Map<string, string>;
  contentTypes?: Map<string, ChannelItemContentType>;
  catalogComplete?: boolean;
  videoCount?: number;
  shortCount?: number;
}

/**
 * Turns a playlist URL, channel reference, or comma/space separated video list
 * into an ordered set of video IDs.
 */
export async function resolveBatchSource(
  engine: Engine,
  input: string,
  lookahead: number,
  contentType: ChannelCatalogContentFilter = "all",
  signal?: AbortSignal,
): Promise<BatchSource> {
  const source = input.trim();
  if (source === "") {
    throw new ExtractError({
      code: "USAGE",
      message: "a playlist URL, channel reference, or video list is required",
    });
  }

  const explicit = explicitVideoList(source);
  if (explicit !== null) {
    return { kind: "videos", id: "", title: "", ids: explicit, names: new Map() };
  }

  let listID: string | null = null;
  try {
    listID = parsePlaylistID(source);
  } catch {
    listID = null;
  }
  if (listID !== null) {
    const result = await playlist(engine, listID, lookahead, signal);
    const refs = collectVideoRefs(result.items);
    return {
      kind: "playlist",
      id: listID,
      title: result.title,
      ids: refs.ids,
      names: refs.names,
    };
  }

  let isChannel = false;
  try {
    parseChannelRef(source);
    isChannel = true;
  } catch {
    isChannel = false;
  }
  if (isChannel) {
    const result = await discoverChannelCatalog(
      engine,
      source,
      { contentType, ensure: lookahead },
      signal,
    );
    const refs = collectVideoRefs(result.items);
    const contentTypes = new Map<string, ChannelItemContentType>();
    for (const item of result.items) {
      contentTypes.set(item.id, item.contentType);
    }
    return {
      kind: "channel",
      id: result.id,
      title: result.title,
      ids: refs.ids,
      names: refs.names,
      contentTypes,
      catalogComplete: result.complete,
      videoCount: result.videoCount,
      shortCount: result.shortCount,
    };
  }

  throw new ExtractError({
    code: "INVALID_BATCH_SOURCE",
    message:
      "Expected a playlist URL/ID, a channel URL/@handle/UC id, or a comma-separated list of video IDs",
    details: { input: source },
  });
}

/** Reads video ids/titles out of playlist or channel results. */
export function collectVideoRefs(value: unknown): {
  ids: string[];
  names: Map<string, string>;
} {
  const ids: string[] = [];
  const names = new Map<string, string>();
  if (!Array.isArray(value)) {
    return { ids, names };
  }
  for (const raw of value) {
    const item = asRecord(raw);
    if (item === null) {
      continue;
    }
    const id = asString(item["id"]);
    if (id === "" || names.has(id)) {
      continue;
    }
    ids.push(id);
    names.set(id, asString(item["title"]));
  }
  return { ids, names };
}

/** Detects a comma/whitespace separated list of two or more video references. */
export function explicitVideoList(input: string): string[] | null {
  const fields = input.split(/[,\n\t ]+/).filter((f) => f !== "");
  if (fields.length < 2) {
    return null;
  }
  const ids: string[] = [];
  for (const field of fields) {
    try {
      ids.push(parseVideoId(field.trim()));
    } catch {
      return null;
    }
  }
  return ids;
}

/**
 * Builds packs for many videos at once, skipping and reporting the ones YouTube
 * will not give us captions for.
 */
export async function batchPackFor(
  engine: Engine,
  input: string,
  opts: BatchOptions = {},
  signal?: AbortSignal,
): Promise<BatchPack> {
  const limit = clampBatchLimit(opts.limit);
  let cursor = opts.cursor ?? 0;
  if (cursor < 0) {
    cursor = 0;
  }
  let chunkChars = opts.chunkChars ?? 0;
  if (chunkChars <= 0) {
    chunkChars = 800;
  }

  const src = await resolveBatchSource(
    engine,
    input,
    cursor + limit + 25,
    opts.contentType ?? "all",
    signal,
  );
  if (src.ids.length === 0) {
    throw new ExtractError({
      code: "EMPTY_BATCH_SOURCE",
      message: "No videos were found for this playlist, channel, or list",
    });
  }

  const videos: BatchItem[] = [];
  const failures: BatchFailure[] = [];
  let totalChunks = 0;
  let consecutiveBlocked = 0;

  let index = cursor;
  while (index < src.ids.length && videos.length < limit) {
    const id = src.ids[index]!;
    index++;

    let pack;
    let transcript;
    try {
      const packOpts = { lang: opts.lang, chunkChars, skipSponsors: opts.skipSponsors };
      if (opts.detail === "analysis") {
        const analysis = await videoPackWithTranscript(engine, id, packOpts, signal);
        pack = analysis.pack;
        transcript = analysis.transcript;
      } else {
        pack = await videoPackWithOptions(engine, id, packOpts, signal);
      }
    } catch (err) {
      failures.push(batchFailure(id, src.names.get(id) ?? "", err, src.contentTypes?.get(id)));
      if (isFatalBatchError(err)) {
        // With the browser fallback on, a block/rate-limit is per video (some
        // panels simply refuse to load), so one bad video must not sink a
        // 30-video pack. Bail only once several in a row fail that way.
        if (!browserRecoverable(err) || ++consecutiveBlocked >= BLOCKED_STREAK_LIMIT) {
          break;
        }
      }
      continue;
    }
    consecutiveBlocked = 0;
    const video = pack.video;
    const item: BatchItem = {
      videoId: video?.id ?? id,
      title: video?.title ?? "",
      url: video?.url ?? "",
      durationSeconds: video?.durationSeconds ?? 0,
      contentType: src.contentTypes?.get(id),
      language: pack.language || undefined,
      chunkCount: pack.chunkCount,
      chunks: opts.includeChunks === true || opts.detail === "analysis" ? pack.chunks : undefined,
      video: opts.detail === "analysis" ? video ?? undefined : undefined,
      transcript: opts.detail === "analysis" ? transcript : undefined,
      chapters: opts.detail === "analysis" ? pack.chapters : undefined,
      chapterSource: opts.detail === "analysis" ? pack.chapterSource : undefined,
      cacheHit: pack.cacheHit === true ? true : undefined,
    };
    totalChunks += pack.chunkCount;
    videos.push(item);
  }

  const hasMore = index < src.ids.length || src.catalogComplete === false;
  const pack: BatchPack = {
    source: src.kind,
    sourceId: src.id || undefined,
    title: src.title || undefined,
    totalVideos: src.ids.length,
    catalogComplete: src.kind === "channel" ? src.catalogComplete : undefined,
    discoveredVideos: src.kind === "channel" ? src.ids.length : undefined,
    videoCount: src.kind === "channel" ? src.videoCount : undefined,
    shortCount: src.kind === "channel" ? src.shortCount : undefined,
    cursor,
    nextCursor: hasMore ? index : undefined,
    hasMore,
    videos,
    failures: failures.length > 0 ? failures : undefined,
    totalChunks,
    markdown: "",
    howToCite: HOW_TO_CITE_BATCH,
  };
  pack.markdown = renderBatchMarkdown(pack);

  if (videos.length === 0 && failures.length > 0) {
    const first = failures[0]!;
    throw new ExtractError({
      code: first.code,
      retryable: first.retryable,
      message: "No videos in this batch could be packed: " + first.message,
      details: { failures },
    });
  }
  // Chromium is left warm on purpose: agents usually page through a playlist
  // with nextCursor, and relaunching per page costs more than the idle timer.
  return pack;
}

function batchFailure(
  id: string,
  title: string,
  err: unknown,
  contentType?: ChannelItemContentType,
): BatchFailure {
  if (isExtractError(err)) {
    const recovery = err.details?.recovery;
    return {
      videoId: id,
      title: title || undefined,
      contentType,
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      recovery:
        recovery && typeof recovery === "object"
          ? (recovery as BatchFailure["recovery"])
          : undefined,
    };
  }
  return {
    videoId: id,
    title: title || undefined,
    contentType,
    code: "INTERNAL_ERROR",
    message: errorText(err),
    retryable: false,
  };
}

function isFatalBatchError(err: unknown): boolean {
  return isExtractError(err) && FATAL_BATCH_CODES.has(err.code);
}

/**
 * Codes the headless-browser fallback can get past on the *next* video even
 * though it failed on this one — the browser has its own egress and each watch
 * page mounts its own transcript panel.
 */
const BROWSER_RECOVERABLE_CODES = new Set(["IP_BLOCKED", "RATE_LIMITED"]);
/**
 * Consecutive browser-recoverable failures tolerated before giving up. Enough
 * that a run of unlucky videos does not end a 30-video pack, few enough that a
 * genuinely dead egress stops within ~30s instead of grinding through the page.
 */
const BLOCKED_STREAK_LIMIT = 5;

function browserRecoverable(err: unknown): boolean {
  if (!isExtractError(err) || !BROWSER_RECOVERABLE_CODES.has(err.code)) return false;
  // Packs resolve transcripts through the engine, so only the env switch applies.
  return browserTranscriptEnabled({});
}

/** Renders the batch as a markdown table of contents plus optional chunk text. */
export function renderBatchMarkdown(pack: BatchPack): string {
  const title = pack.title && pack.title !== "" ? pack.title : "YouTube batch pack";
  let b = `# ${title}\n\n`;
  b += `- Source: ${pack.source}\n`;
  if (pack.sourceId !== undefined && pack.sourceId !== "") {
    b += `- Source ID: ${pack.sourceId}\n`;
  }
  b += `- Videos packed: ${pack.videos.length} of ${pack.totalVideos}\n`;
  b += `- Chunks: ${pack.totalChunks}\n`;
  if (pack.hasMore) {
    b += `- Resume with cursor: ${pack.nextCursor ?? 0}\n`;
  }
  b += "\n## Videos\n\n";
  for (const v of pack.videos) {
    b += `- [${formatTimestamp(v.durationSeconds)}] ${v.title} (${v.url}, ${v.chunkCount} chunks)\n`;
  }
  const failures = pack.failures ?? [];
  if (failures.length > 0) {
    b += "\n## Skipped\n\n";
    for (const f of failures) {
      b += `- ${f.videoId}: ${f.code} (${f.message})\n`;
    }
  }
  for (const v of pack.videos) {
    const chunks = v.chunks ?? [];
    if (chunks.length === 0) {
      continue;
    }
    b += `\n## ${v.title}\n\n`;
    for (const ch of chunks) {
      b += `### ${ch.citation}\n\n${ch.text}\n\n`;
    }
  }
  return b;
}
