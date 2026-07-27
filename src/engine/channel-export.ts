/**
 * Checkpointed full-channel analysis export.
 *
 * Each completed video is appended as one JSONL record before the sidecar
 * checkpoint advances, so interrupted jobs resume without duplicating records.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { discoverChannelCatalog } from "./channel-catalog.js";
import { resolveChannelBrowseID } from "./discovery.js";
import { ExtractError, isExtractError } from "./errors.js";
import { withFileLock } from "./file-lock.js";
import { parseChannelRef } from "./ids.js";
import { videoPackWithTranscript } from "./rag.js";
import { errorText, type Engine } from "./transcript.js";
import type {
  BatchFailure,
  ChannelCatalogItem,
  ChannelExportOptions,
  ChannelExportProgress,
  ChannelExportProgressPhase,
  ChannelExportResult,
  ChannelExportStatus,
  ChannelItemContentType,
  Transcript,
  VideoPack,
} from "./types.js";
import { recoveryFromError } from "./caption-recovery.js";
import { closeBrowser } from "./browser-transcript.js";

export type {
  ChannelExportOptions,
  ChannelExportProgress,
  ChannelExportResult,
} from "./types.js";

const STATE_VERSION = 1;
const FATAL_EXPORT_CODES = new Set([
  "RATE_BUDGET_EXCEEDED",
  "RATE_LIMITED",
  "IP_BLOCKED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "ACCESS_DENIED",
]);
/** Codes we can often clear by switching to the browser path / waiting. */
const RETRYABLE_BLOCK_CODES = new Set([
  "IP_BLOCKED",
  "RATE_LIMITED",
  "RATE_BUDGET_EXCEEDED",
  // Transient anti-bot "sign in to confirm you're not a bot" waves — not real age gates.
  // Real age walls stay AUTH_REQUIRED and are not retried here.
]);
const exportLocks = new Map<string, Promise<void>>();

async function withExportLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prior = exportLocks.get(jobId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);
  exportLocks.set(jobId, queued);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (exportLocks.get(jobId) === queued) exportLocks.delete(jobId);
  }
}

interface ExportState {
  version: number;
  jobId: string;
  channelId: string;
  title: string;
  status: ChannelExportStatus;
  cursor: number;
  succeeded: number;
  failed: number;
  processedVideos: number;
  processedShorts: number;
  catalogVideos: number;
  catalogItems: ChannelCatalogItem[];
  catalogReady: boolean;
  dataPath: string;
  checkpointPath: string;
  optionsKey: string;
  createdAt: string;
  updatedAt: string;
  lastError?: BatchFailure;
}

interface SuccessRecord {
  type: "video";
  index: number;
  channelId: string;
  contentType: ChannelItemContentType;
  videoId: string;
  video: NonNullable<VideoPack["video"]>;
  transcript: Transcript;
  chapters: VideoPack["chapters"];
  chapterSource: string;
  language: string;
  chunks: VideoPack["chunks"];
  exportedAt: string;
}

interface FailureRecord {
  type: "failure";
  index: number;
  channelId: string;
  contentType: ChannelItemContentType;
  videoId: string;
  title?: string;
  error: BatchFailure;
  exportedAt: string;
}

function exportRoot(engine: Engine): string {
  const configured = (process.env["YTUBE_EXPORT_DIR"] ?? "").trim();
  return resolve(configured || join(engine.client.cache.dir, "exports"));
}

function optionsKey(opts: ChannelExportOptions): string {
  return JSON.stringify({
    contentType: opts.contentType ?? "all",
    lang: opts.lang ?? "",
    chunkChars: opts.chunkChars ?? 800,
    skipSponsors: opts.skipSponsors === true,
  });
}

function deterministicJobId(channelId: string, key: string): string {
  const suffix = createHash("sha256").update(channelId + "\n" + key).digest("hex").slice(0, 16);
  return `channel-${channelId}-${suffix}`;
}

function validJobId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,96}$/.test(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isExportState(value: unknown): value is ExportState {
  if (value === null || typeof value !== "object") return false;
  const state = value as Partial<ExportState>;
  return (
    state.version === STATE_VERSION &&
    typeof state.jobId === "string" &&
    typeof state.channelId === "string" &&
    typeof state.cursor === "number" &&
    typeof state.optionsKey === "string" &&
    typeof state.dataPath === "string" &&
    Array.isArray(state.catalogItems) &&
    typeof state.catalogReady === "boolean"
  );
}

async function readState(path: string): Promise<ExportState | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isExportState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeState(state: ExportState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const temp = state.checkpointPath + ".tmp";
  await writeFile(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o644 });
  await rename(temp, state.checkpointPath);
}

function failureFor(item: ChannelCatalogItem, err: unknown): BatchFailure {
  if (isExtractError(err)) {
    const recovery = err.details?.recovery;
    return {
      videoId: item.id,
      title: item.title || undefined,
      contentType: item.contentType,
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
    videoId: item.id,
    title: item.title || undefined,
    contentType: item.contentType,
    code: "INTERNAL_ERROR",
    message: errorText(err),
    retryable: false,
  };
}

function catalogFailure(err: unknown): BatchFailure {
  if (isExtractError(err)) {
    return {
      videoId: "",
      code: err.code,
      message: err.message,
      retryable: err.retryable,
    };
  }
  return {
    videoId: "",
    code: "CATALOG_ERROR",
    message: errorText(err),
    retryable: true,
  };
}

function resultFor(state: ExportState, extra?: { browserUsed?: boolean }): ChannelExportResult {
  return {
    jobId: state.jobId,
    channelId: state.channelId,
    title: state.title,
    status: state.status,
    dataPath: state.dataPath,
    checkpointPath: state.checkpointPath,
    catalogVideos: state.catalogVideos,
    cursor: state.cursor,
    nextCursor: state.status === "completed" ? undefined : state.cursor,
    succeeded: state.succeeded,
    failed: state.failed,
    processedVideos: state.processedVideos,
    processedShorts: state.processedShorts,
    lastError: state.lastError,
    browserUsed: extra?.browserUsed,
  };
}

function progressPercent(cursor: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((cursor / total) * 100));
}

function emitProgress(
  opts: ChannelExportOptions,
  state: ExportState,
  startedAt: number,
  phase: ChannelExportProgressPhase,
  message: string,
  extra: Partial<ChannelExportProgress> = {},
): void {
  const total = state.catalogVideos;
  const event: ChannelExportProgress = {
    phase,
    jobId: state.jobId,
    channelId: state.channelId,
    title: state.title || undefined,
    index: state.cursor,
    total,
    succeeded: state.succeeded,
    failed: state.failed,
    message,
    elapsedMs: Date.now() - startedAt,
    percent: progressPercent(state.cursor, total),
    ...extra,
  };
  try {
    opts.onProgress?.(event);
  } catch {
    // Progress handlers must never abort the export.
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExtractError({ code: "ABORTED", message: "aborted" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ExtractError({ code: "ABORTED", message: "aborted" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Default console progress logger for CLIs / scripts. */
export function defaultChannelExportLogger(event: ChannelExportProgress): void {
  const stamp = new Date().toISOString().slice(11, 19);
  const pos = event.total > 0 ? `[${Math.min(event.index + 1, event.total)}/${event.total}]` : "";
  const pct = `${event.percent}%`;
  const counts = `ok=${event.succeeded} fail=${event.failed}`;
  console.error(
    `${stamp} ${pct.padStart(4)} ${pos.padEnd(12)} ${event.phase.padEnd(16)} ${counts}  ${event.message}`,
  );
  if (event.recovery) {
    console.error(`         → ${event.recovery.kind}: ${event.recovery.summary}`);
    for (const action of event.recovery.actions.slice(0, 2)) {
      console.error(`           • ${action}`);
    }
  }
}


async function appendRecord(path: string, record: SuccessRecord | FailureRecord): Promise<void> {
  await appendFile(path, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o644 });
}

/** Recovers a record appended immediately before a process interruption. */
async function reconcileState(state: ExportState): Promise<void> {
  let raw = await readFile(state.dataPath, "utf8");
  if (raw !== "" && !raw.endsWith("\n")) {
    const lastNewline = raw.lastIndexOf("\n");
    const tail = raw.slice(lastNewline + 1);
    try {
      JSON.parse(tail);
    } catch {
      const validPrefix = raw.slice(0, lastNewline + 1);
      await truncate(state.dataPath, Buffer.byteLength(validPrefix, "utf8"));
      raw = validPrefix;
    }
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  let succeeded = 0;
  let failed = 0;
  let processedVideos = 0;
  let processedShorts = 0;
  for (let index = 0; index < lines.length; index++) {
    let record: { index?: unknown; type?: unknown; contentType?: unknown };
    try {
      record = JSON.parse(lines[index]!) as {
        index?: unknown;
        type?: unknown;
        contentType?: unknown;
      };
    } catch {
      throw new ExtractError({
        code: "EXPORT_CORRUPT",
        message: `Invalid JSONL record at line ${index + 1}`,
        details: { path: state.dataPath },
      });
    }
    if (record.index !== index || (record.type !== "video" && record.type !== "failure")) {
      throw new ExtractError({
        code: "EXPORT_CORRUPT",
        message: `Non-sequential JSONL record at line ${index + 1}`,
        details: { path: state.dataPath, expectedIndex: index, actualIndex: record.index },
      });
    }
    if (record.type === "video") succeeded++;
    else failed++;
    if (record.contentType === "short") processedShorts++;
    else processedVideos++;
  }
  if (lines.length < state.cursor) {
    throw new ExtractError({
      code: "EXPORT_CORRUPT",
      message: "Checkpoint is ahead of the JSONL dataset",
      details: { path: state.dataPath, checkpointCursor: state.cursor, records: lines.length },
    });
  }
  state.cursor = lines.length;
  state.succeeded = succeeded;
  state.failed = failed;
  state.processedVideos = processedVideos;
  state.processedShorts = processedShorts;
}

/**
 * Exports every requested channel item into a resumable JSONL dataset.
 *
 * By default, transient global failures (`IP_BLOCKED`, …) pause at the current
 * item so a later call retries it. Pass `untilDone: true` (and usually
 * `autoBrowser: true`) to retry blocked videos in-process, then continue until
 * the catalog is finished — with live `onProgress` events for CLI/status UIs.
 */
export async function exportChannelAnalysis(
  engine: Engine,
  input: string,
  opts: ChannelExportOptions = {},
  signal?: AbortSignal,
): Promise<ChannelExportResult> {
  const ref = parseChannelRef(input);
  const channelId =
    ref.browseId || await resolveChannelBrowseID(engine, ref.handle, signal);
  const key = optionsKey(opts);
  const jobId = opts.jobId?.trim() || deterministicJobId(channelId, key);
  if (!validJobId(jobId)) {
    throw new ExtractError({
      code: "INVALID_EXPORT_JOB",
      message: "Invalid channel export jobId",
      details: { jobId },
    });
  }

  const autoBrowser = opts.autoBrowser === true || opts.untilDone === true;
  const prevBrowser = process.env.YTUBE_BROWSER;
  let browserUsed = false;
  if (autoBrowser) {
    process.env.YTUBE_BROWSER = "1";
    browserUsed = true;
  }

  try {
    return await withExportLock(jobId, async () => {
      const dir = exportRoot(engine);
      await mkdir(dir, { recursive: true, mode: 0o755 });
      return withFileLock(join(dir, jobId + ".lock"), "EXPORT_BUSY", signal, async () => {
        try {
          const result = await runExportJob(engine, {
            channelId,
            key,
            jobId,
            dir,
            opts,
            signal,
          });
          return { ...result, browserUsed: browserUsed || result.browserUsed };
        } finally {
          // Free Chromium after this export slice (completed or paused).
          try {
            const { releaseBrowserIfEnabled } = await import("./browser-transcript.js");
            await releaseBrowserIfEnabled();
          } catch {
            // best-effort
          }
        }
      });
    });
  } finally {
    if (autoBrowser) {
      if (prevBrowser === undefined) delete process.env.YTUBE_BROWSER;
      else process.env.YTUBE_BROWSER = prevBrowser;
    }
  }
}

async function runExportJob(
  engine: Engine,
  args: {
    channelId: string;
    key: string;
    jobId: string;
    dir: string;
    opts: ChannelExportOptions;
    signal?: AbortSignal;
  },
): Promise<ChannelExportResult> {
  const { channelId, key, jobId, dir, opts, signal } = args;
  const dataPath = join(dir, jobId + ".jsonl");
  const checkpointPath = join(dir, jobId + ".state.json");
  const startedAt = Date.now();
  const untilDone = opts.untilDone === true;
  const maxRounds = Math.max(1, opts.maxRetryRounds ?? (untilDone ? 3 : 1));
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 5_000);
  let state = await readState(checkpointPath);

  if (state !== undefined) {
    if (state.channelId !== channelId || state.optionsKey !== key) {
      throw new ExtractError({
        code: "EXPORT_JOB_MISMATCH",
        message: "Channel export jobId belongs to different channel/options",
        details: { jobId },
      });
    }
    if (state.dataPath !== dataPath || state.checkpointPath !== checkpointPath) {
      throw new ExtractError({
        code: "EXPORT_CORRUPT",
        message: "Channel export checkpoint contains unexpected paths",
        details: { jobId },
      });
    }
    if (!(await exists(state.dataPath))) {
      throw new ExtractError({
        code: "EXPORT_DATA_MISSING",
        message: "Channel export data file is missing for existing checkpoint",
        details: { jobId, path: state.dataPath },
      });
    }
    await reconcileState(state);
  } else {
    if (await exists(dataPath)) {
      throw new ExtractError({
        code: "EXPORT_STATE_MISSING",
        message: "Channel export data exists without a valid checkpoint",
        details: { jobId, path: dataPath },
      });
    }
    const now = new Date().toISOString();
    state = {
      version: STATE_VERSION,
      jobId,
      channelId,
      title: "",
      status: "running",
      cursor: 0,
      succeeded: 0,
      failed: 0,
      processedVideos: 0,
      processedShorts: 0,
      catalogVideos: 0,
      catalogItems: [],
      catalogReady: false,
      dataPath,
      checkpointPath,
      optionsKey: key,
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(dataPath, "", { flag: "wx", mode: 0o644 });
    await writeState(state);
  }

  emitProgress(opts, state, startedAt, "starting", `Export job ${jobId} for ${channelId}`);

  if (!state.catalogReady) {
    emitProgress(opts, state, startedAt, "catalog", "Discovering Videos / Shorts catalog…");
    try {
      const catalog = await discoverChannelCatalog(
        engine,
        channelId,
        { contentType: opts.contentType ?? "all", ensure: 0 },
        signal,
      );
      state.title = catalog.title;
      state.catalogItems = catalog.items;
      state.catalogVideos = catalog.items.length;
      state.catalogReady = true;
      emitProgress(
        opts,
        state,
        startedAt,
        "catalog",
        `Catalog ready: ${catalog.items.length} items (${catalog.title || channelId})`,
      );
    } catch (err) {
      state.status = "paused";
      state.lastError = catalogFailure(err);
      await writeState(state);
      emitProgress(opts, state, startedAt, "paused", `Catalog failed: ${state.lastError.message}`, {
        error: state.lastError,
      });
      return resultFor(state);
    }
  }

  state.status = "running";
  const exportItems = state.catalogItems;
  state.catalogVideos = exportItems.length;
  state.lastError = undefined;
  await writeState(state);

  while (state.cursor < exportItems.length) {
    if (signal?.aborted) {
      state.status = "paused";
      await writeState(state);
      emitProgress(opts, state, startedAt, "paused", "Aborted — resume with the same jobId");
      return resultFor(state);
    }

    const item = exportItems[state.cursor]!;
    let lastFailure: BatchFailure | undefined;
    let packed = false;

    for (let attempt = 1; attempt <= maxRounds; attempt++) {
      emitProgress(opts, state, startedAt, "video_start", `${item.title || item.id}`, {
        videoId: item.id,
        videoTitle: item.title || undefined,
        contentType: item.contentType,
        attempt,
      });

      if (attempt > 1) {
        emitProgress(
          opts,
          state,
          startedAt,
          "browser_fallback",
          `Retry #${attempt} (browser/timedtext ladder) for ${item.id}`,
          { videoId: item.id, videoTitle: item.title || undefined, contentType: item.contentType, attempt },
        );
        process.env.YTUBE_BROWSER = "1";
      }

      try {
        const { pack, transcript } = await videoPackWithTranscript(
          engine,
          item.id,
          {
            lang: opts.lang,
            chunkChars: opts.chunkChars ?? 800,
            skipSponsors: opts.skipSponsors,
          },
          signal,
        );
        if (pack.video === null) {
          throw new Error("Video analysis pack has no metadata");
        }
        await appendRecord(dataPath, {
          type: "video",
          index: state.cursor,
          channelId: state.channelId,
          contentType: item.contentType,
          videoId: item.id,
          video: pack.video,
          transcript,
          chapters: pack.chapters,
          chapterSource: pack.chapterSource,
          language: pack.language,
          chunks: pack.chunks,
          exportedAt: new Date().toISOString(),
        });
        state.succeeded++;
        packed = true;
        emitProgress(opts, state, startedAt, "video_ok", `Packed ${item.id} (${transcript.segmentCount} segments)`, {
          videoId: item.id,
          videoTitle: item.title || pack.video.title || undefined,
          contentType: item.contentType,
          attempt,
        });
        break;
      } catch (err) {
        lastFailure = failureFor(item, err);
        const recovery = recoveryFromError(err, {
          tracksExist: true,
          timedtextBlocked: RETRYABLE_BLOCK_CODES.has(lastFailure.code),
          panelUnavailable: isExtractError(err) && err.details?.panelEmpty === true,
          browserConfigured: (process.env.YTUBE_BROWSER ?? "") !== "",
        });
        if (recovery) lastFailure = { ...lastFailure, recovery };

        const isBlock = RETRYABLE_BLOCK_CODES.has(lastFailure.code);
        const canRetry = untilDone && isBlock && attempt < maxRounds && !signal?.aborted;

        if (canRetry) {
          emitProgress(
            opts,
            state,
            startedAt,
            "retry_wait",
            `${lastFailure.code} on ${item.id} — waiting ${retryDelayMs}ms then retry (${attempt}/${maxRounds})`,
            {
              videoId: item.id,
              videoTitle: item.title || undefined,
              contentType: item.contentType,
              attempt,
              error: lastFailure,
              recovery,
            },
          );
          // Drop a polluted headless session (anti-bot interstitial cookies) before retry.
          try {
            await closeBrowser();
          } catch {
            // best-effort
          }
          try {
            await sleep(retryDelayMs, signal);
          } catch {
            state.status = "paused";
            state.lastError = lastFailure;
            await writeState(state);
            emitProgress(opts, state, startedAt, "paused", "Aborted during retry wait", {
              error: lastFailure,
              recovery,
            });
            return resultFor(state);
          }
          continue;
        }

        // Legacy / default: pause the whole job on fatal block so resume retries it.
        if (!untilDone && (FATAL_EXPORT_CODES.has(lastFailure.code) || signal?.aborted)) {
          state.status = "paused";
          state.lastError = lastFailure;
          await writeState(state);
          emitProgress(opts, state, startedAt, "paused", `${lastFailure.code}: ${lastFailure.message}`, {
            videoId: item.id,
            videoTitle: item.title || undefined,
            contentType: item.contentType,
            error: lastFailure,
            recovery,
          });
          return resultFor(state);
        }

        // untilDone exhausted retries, or non-fatal error: record failure and continue.
        await appendRecord(dataPath, {
          type: "failure",
          index: state.cursor,
          channelId: state.channelId,
          contentType: item.contentType,
          videoId: item.id,
          title: item.title || undefined,
          error: lastFailure,
          exportedAt: new Date().toISOString(),
        });
        state.failed++;
        emitProgress(opts, state, startedAt, "video_fail", `${lastFailure.code}: ${item.id}`, {
          videoId: item.id,
          videoTitle: item.title || undefined,
          contentType: item.contentType,
          attempt,
          error: lastFailure,
          recovery,
        });
        break;
      }
    }

    if (!packed && lastFailure === undefined) {
      // Should not happen; treat as internal failure so the cursor still advances.
      const failure: BatchFailure = {
        videoId: item.id,
        title: item.title || undefined,
        contentType: item.contentType,
        code: "INTERNAL_ERROR",
        message: "Export produced neither a pack nor a failure",
        retryable: false,
      };
      await appendRecord(dataPath, {
        type: "failure",
        index: state.cursor,
        channelId: state.channelId,
        contentType: item.contentType,
        videoId: item.id,
        title: item.title || undefined,
        error: failure,
        exportedAt: new Date().toISOString(),
      });
      state.failed++;
    }

    if (item.contentType === "short") state.processedShorts++;
    else state.processedVideos++;
    state.cursor++;
    await writeState(state);
  }

  state.status = "completed";
  await writeState(state);
  emitProgress(
    opts,
    state,
    startedAt,
    "completed",
    `Done — ${state.succeeded} packed, ${state.failed} failed of ${state.catalogVideos}`,
  );
  return resultFor(state);
}
