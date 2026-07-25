/**
 * Timestamp formatting/parsing, ported from internal/youtube/timestamps.go and
 * `WatchURLAt` in internal/youtube/extractor.go.
 */
import { ExtractError } from "./errors.js";

/** Converts seconds to YouTube-style `M:SS` or `H:MM:SS`. */
export function formatTimestamp(seconds: number): string {
  let value = seconds;
  if (!Number.isFinite(value) || value < 0) value = 0;
  const total = Math.floor(value + 0.5);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/** Go's `strconv.Atoi`: no surrounding whitespace, no decimals, optional sign. */
function atoi(input: string): number | undefined {
  if (!/^[+-]?\d+$/.test(input)) return undefined;
  const n = Number(input);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Parses `M:SS`, `MM:SS`, or `H:MM:SS` into seconds. */
export function parseTimestamp(input: string): number {
  const trimmed = input.trim();
  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new ExtractError({
      code: "INVALID_TIMESTAMP",
      message: `Expected a timestamp like 1:30 or 1:02:03, got "${trimmed}"`,
    });
  }

  let h = 0;
  let m: number | undefined;
  let sec: number | undefined;
  if (parts.length === 2) {
    m = atoi(parts[0]!);
    if (m === undefined) {
      throw new ExtractError({
        code: "INVALID_TIMESTAMP",
        message: "Invalid minutes in timestamp: " + trimmed,
      });
    }
    sec = atoi(parts[1]!);
  } else {
    const hours = atoi(parts[0]!);
    if (hours === undefined) {
      throw new ExtractError({
        code: "INVALID_TIMESTAMP",
        message: "Invalid hours in timestamp: " + trimmed,
      });
    }
    h = hours;
    m = atoi(parts[1]!);
    if (m === undefined) {
      throw new ExtractError({
        code: "INVALID_TIMESTAMP",
        message: "Invalid minutes in timestamp: " + trimmed,
      });
    }
    sec = atoi(parts[2]!);
  }

  if (sec === undefined || sec < 0 || sec > 59 || m < 0 || m > 59 || h < 0) {
    throw new ExtractError({
      code: "INVALID_TIMESTAMP",
      message: "Invalid timestamp value: " + trimmed,
    });
  }
  return h * 3600 + m * 60 + sec;
}

/**
 * Builds a deep link that opens the video at a given moment, which is what
 * agents need when they cite a transcript timestamp.
 */
export function watchURLAt(videoID: string, seconds: number): string {
  const base = "https://www.youtube.com/watch?v=" + videoID;
  if (!Number.isFinite(seconds) || seconds <= 0) return base;
  return `${base}&t=${Math.trunc(seconds)}s`;
}
