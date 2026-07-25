/**
 * Stream formats and direct-URL downloads.
 * Ported from internal/youtube/formats.go.
 *
 * Formats behind YouTube's sig/nsig JavaScript challenge are listed with
 * `directUrl: false` and cannot be downloaded, exactly as in the Go engine.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ExtractError, classifyNetworkError, httpStatusError } from "./errors.js";
import { parseVideoId } from "./ids.js";
import { ANDROID_USER_AGENT, MAX_RETRIES } from "./innertube.js";
import type { Engine, PlayerResponse, RawFormat } from "./transcript.js";
import type { DownloadResult, Format } from "./types.js";

/** A format plus the signed stream URL, which is never serialized. */
export interface FormatWithStream extends Format {
  streamUrl: string;
}

export interface FormatsResult {
  formats: Format[];
  count: number;
  innertubeClient: string;
}

function parseUintOr0(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function formatsFromPlayer(p: PlayerResponse): FormatWithStream[] {
  const raw: RawFormat[] = [
    ...(p.streamingData?.formats ?? []),
    ...(p.streamingData?.adaptiveFormats ?? []),
  ];
  const formats = raw.map((f) => {
    const mime = (f.mimeType ?? "").toLowerCase();
    const contentLength = parseUintOr0(f.contentLength);
    return {
      itag: f.itag ?? 0,
      mimeType: f.mimeType ?? "",
      quality: f.quality || undefined,
      qualityLabel: f.qualityLabel || undefined,
      audioQuality: f.audioQuality || undefined,
      bitrate: f.bitrate || undefined,
      contentLength: contentLength || undefined,
      hasAudio: mime.startsWith("audio/") || Boolean(f.audioQuality),
      hasVideo: mime.startsWith("video/"),
      directUrl: Boolean(f.url),
      streamUrl: f.url ?? "",
    } satisfies FormatWithStream;
  });
  // Array.prototype.sort is stable, matching Go's sort.SliceStable.
  return formats.sort((a, b) => a.itag - b.itag);
}

/** Drops the signed stream URL so results are safe to serialize. */
export function toPublicFormat(f: FormatWithStream): Format {
  const { streamUrl, ...rest } = f;
  void streamUrl;
  return rest;
}

/** Lists stream formats and the InnerTube client that produced them. */
export async function listFormats(
  engine: Engine,
  input: string,
  signal?: AbortSignal,
): Promise<FormatsResult> {
  const { formats, clientName } = await listFormatsWithStreams(engine, input, signal);
  const publicFormats = formats.map(toPublicFormat);
  return { formats: publicFormats, count: publicFormats.length, innertubeClient: clientName };
}

async function listFormatsWithStreams(
  engine: Engine,
  input: string,
  signal?: AbortSignal,
): Promise<{ formats: FormatWithStream[]; clientName: string }> {
  const id = parseVideoId(input);
  const { player, clientName } = await engine.fetchPlayer(id, signal);
  return { formats: formatsFromPlayer(player), clientName };
}

export function pickFormat(formats: FormatWithStream[], itag: number): FormatWithStream {
  let chosen: FormatWithStream | null = null;
  if (itag > 0) {
    chosen = formats.find((f) => f.itag === itag) ?? null;
    if (chosen === null) {
      throw new ExtractError({
        code: "FORMAT_NOT_FOUND",
        message: `No format with itag ${itag} exists for this video; call formats to list available itags`,
        details: { itag },
      });
    }
  } else {
    for (const f of formats) {
      if (
        f.hasAudio &&
        f.hasVideo &&
        f.directUrl &&
        (chosen === null || (f.bitrate ?? 0) > (chosen.bitrate ?? 0))
      ) {
        chosen = f;
      }
    }
    if (chosen === null) {
      throw new ExtractError({
        code: "NO_MUXED_FORMAT",
        message:
          "No combined audio+video format with a direct URL is available; pick an itag from formats instead",
      });
    }
  }
  if (!chosen.directUrl) {
    throw new ExtractError({
      code: "SIGNATURE_REQUIRED",
      message: `Format ${chosen.itag} is protected by YouTube's sig/nsig JavaScript challenge, which this extractor does not solve; choose a format where directUrl is true`,
      details: { itag: chosen.itag },
    });
  }
  return chosen;
}

async function fileSize(path: string): Promise<number> {
  try {
    const st = await stat(path);
    return st.size;
  } catch {
    return 0;
  }
}

/**
 * Fetches one format (by itag, or the best muxed format when itag is 0) to
 * `outPath`, resuming from an existing `.part` file with an HTTP Range request.
 */
export async function downloadMedia(
  engine: Engine,
  input: string,
  itag: number,
  outPath: string,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const { formats } = await listFormatsWithStreams(engine, input, signal);
  const chosen = pickFormat(formats, itag);

  try {
    await mkdir(dirname(outPath), { recursive: true });
  } catch (err) {
    throw new ExtractError({
      code: "WRITE_ERROR",
      message: "Could not create the output directory: " + (err as Error).message,
    });
  }

  const partPath = outPath + ".part";
  let offset = await fileSize(partPath);
  let written = 0;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let done = false;
    let failure: unknown = null;
    try {
      const result = await downloadOnce(chosen, partPath, offset, signal);
      written = result.written;
      done = result.done;
    } catch (err) {
      failure = err;
      written = await fileSize(partPath);
    }
    if (failure === null && done) {
      try {
        await rename(partPath, outPath);
      } catch (err) {
        throw new ExtractError({
          code: "WRITE_ERROR",
          message: "Could not finalize download: " + (err as Error).message,
        });
      }
      return {
        path: outPath,
        itag: chosen.itag,
        mimeType: chosen.mimeType,
        bytesWritten: written,
      };
    }
    if (failure !== null && attempt === MAX_RETRIES - 1) {
      throw failure;
    }
    offset = await fileSize(partPath);
  }

  throw new ExtractError({
    code: "DOWNLOAD_INTERRUPTED",
    message: "The media download failed after retries",
    retryable: true,
    details: { bytesWritten: written },
  });
}

async function downloadOnce(
  chosen: FormatWithStream,
  partPath: string,
  offsetIn: number,
  signal?: AbortSignal,
): Promise<{ written: number; done: boolean }> {
  let offset = offsetIn;
  const headers: Record<string, string> = { "User-Agent": ANDROID_USER_AGENT };
  if (offset > 0) {
    headers["Range"] = `bytes=${offset}-`;
  }

  let response: Response;
  try {
    response = await fetch(chosen.streamUrl, { headers, signal, redirect: "follow" });
  } catch (err) {
    throw classifyNetworkError(err);
  }

  if (offset > 0 && response.status === 200) {
    // Server ignored Range; restart from scratch.
    offset = 0;
    await rm(partPath, { force: true });
  }
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel();
    throw httpStatusError(response.status);
  }

  let received = 0;
  const sink = createWriteStream(partPath, { flags: offset > 0 ? "a" : "w", mode: 0o644 });
  try {
    if (response.body === null) {
      sink.end();
    } else {
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      source.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      await pipeline(source, sink);
    }
  } catch (err) {
    const written = offset + received;
    throw new ExtractError({
      code: "DOWNLOAD_INTERRUPTED",
      message: "The media download was interrupted: " + (err as Error).message,
      retryable: true,
      details: { bytesWritten: written },
    });
  }

  const written = offset + received;
  const contentLength = chosen.contentLength ?? 0;
  if (contentLength > 0 && written < contentLength && response.status === 206) {
    throw new ExtractError({
      code: "INCOMPLETE_DOWNLOAD",
      message: `Downloaded ${written} of ${contentLength} bytes`,
      retryable: true,
      details: { bytesWritten: written, contentLength },
    });
  }
  return { written, done: true };
}
