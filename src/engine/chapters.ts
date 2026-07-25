/**
 * Chapter markers: description heuristics plus official InnerTube markers.
 * Ported from internal/youtube/chapters.go and the chaptersFromNext half of
 * internal/youtube/next.go.
 */
import { clientWEB } from "./innertube.js";
import { formatTimestamp, parseTimestamp } from "./timestamps.js";
import type { Chapter, ChapterSource, ChaptersResult } from "./types.js";
import type { Engine } from "./transcript.js";

export type { ChaptersResult } from "./types.js";

/**
 * Matches description lines containing a timestamp such as "0:00", "12:34" or
 * "1:02:03" followed (or preceded) by a chapter title.
 */
const TIMESTAMP_LINE_PATTERN = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/;

const TITLE_TRIM_CHARS = new Set([
  " ",
  "-",
  "\u2013",
  "\u2014",
  ":",
  "|",
  "\u2022",
  "[",
  "]",
  "(",
  ")",
  "\t",
]);

function trimTitle(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && TITLE_TRIM_CHARS.has(s[start]!)) {
    start++;
  }
  while (end > start && TITLE_TRIM_CHARS.has(s[end - 1]!)) {
    end--;
  }
  return s.slice(start, end);
}

function intOr0(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Extracts chapter markers from a video description using the same heuristic
 * YouTube applies: a list of ascending timestamps, the first of which is 0:00.
 * Returns an empty list when the description does not describe chapters.
 */
export function parseChapters(description: string, durationSeconds: number): Chapter[] {
  const chapters: Chapter[] = [];
  for (const line of description.split("\n")) {
    const match = TIMESTAMP_LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const hours = intOr0(match[1]);
    const minutes = intOr0(match[2]);
    const seconds = intOr0(match[3]);
    const start = hours * 3600 + minutes * 60 + seconds;
    if (durationSeconds > 0 && start > durationSeconds) {
      continue;
    }
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;
    let title = (line.slice(0, matchStart) + line.slice(matchEnd)).trim();
    title = trimTitle(title);
    if (title === "") {
      title = `Chapter at ${formatTimestamp(start)}`;
    }
    chapters.push({ title, startSeconds: start, timestamp: formatTimestamp(start) });
  }
  // YouTube requires chapters to start at 0:00 and be ascending.
  if (chapters.length < 2 || chapters[0]!.startSeconds !== 0) {
    return [];
  }
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i]!.startSeconds <= chapters[i - 1]!.startSeconds) {
      return [];
    }
  }
  return chapters;
}

/**
 * Fetches video info and resolves chapters, preferring official InnerTube
 * markers over the description heuristic.
 */
export async function chaptersFor(
  engine: Engine,
  input: string,
  signal?: AbortSignal,
): Promise<ChaptersResult> {
  const info = await engine.info(input, signal);
  let chapters = parseChapters(info.description, info.durationSeconds);
  let source: ChapterSource = chapters.length > 0 ? "description" : "none";

  try {
    const markers = await chaptersFromNext(engine, info.id, signal);
    if (markers.length > 0) {
      chapters = markers;
      source = "markers";
    }
  } catch {
    // Markers are an optimization; the description heuristic already ran.
  }

  return {
    videoId: info.id,
    title: info.title,
    chapters,
    count: chapters.length,
    hasChapters: chapters.length > 0,
    source,
  };
}

/** Reads official chapter markers from the `next` endpoint. */
export async function chaptersFromNext(
  engine: Engine,
  videoId: string,
  signal?: AbortSignal,
): Promise<Chapter[]> {
  const root = await engine.client.callJSON<unknown>("next", clientWEB, { videoId }, { signal });
  const chapters = extractMacroMarkers(root);
  if (chapters.length >= 2 && chapters[0]!.startSeconds === 0) {
    return chapters;
  }
  return [];
}

/** Collects `macroMarkersListItemRenderer` entries anywhere in a next response. */
export function extractMacroMarkers(node: unknown): Chapter[] {
  const out: Chapter[] = [];
  walkJson(node, (key, val) => {
    if (key !== "macroMarkersListItemRenderer") {
      return true;
    }
    const m = asRecord(val);
    if (m === null) {
      return true;
    }
    let title = runsText(m["title"]);
    if (title === "") {
      const t = asRecord(m["title"]);
      if (t !== null && typeof t["simpleText"] === "string") {
        title = t["simpleText"];
      }
    }
    let startMs = 0;
    const watchEndpoint = asRecord(nested(m, "onTap", "watchEndpoint"));
    if (watchEndpoint !== null) {
      startMs = toInt(watchEndpoint["startTimeSeconds"]) * 1000;
    }
    if (startMs === 0) {
      const timeDescription = asRecord(m["timeDescription"]);
      const simple = timeDescription?.["simpleText"];
      if (typeof simple === "string") {
        try {
          startMs = Math.trunc(parseTimestamp(simple) * 1000);
        } catch {
          startMs = 0;
        }
      }
    }
    const start = Math.trunc(startMs / 1000);
    out.push({ title, startSeconds: start, timestamp: formatTimestamp(start) });
    return true;
  });
  return out;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/**
 * Depth-first walk over a parsed JSON tree. `fn` receives every (key, value)
 * pair of every object; returning false stops the walk of the current object.
 */
export function walkJson(node: unknown, fn: (key: string, val: unknown) => boolean): void {
  if (Array.isArray(node)) {
    for (const v of node) {
      walkJson(v, fn);
    }
    return;
  }
  const record = asRecord(node);
  if (record === null) {
    return;
  }
  for (const [k, v] of Object.entries(record)) {
    if (!fn(k, v)) {
      return;
    }
    walkJson(v, fn);
  }
}

/** Flattens InnerTube's `{simpleText}` / `{runs:[{text}]}` text shapes. */
export function runsText(v: unknown): string {
  const m = asRecord(v);
  if (m === null) {
    return "";
  }
  if (typeof m["simpleText"] === "string") {
    return m["simpleText"];
  }
  const runs = m["runs"];
  if (!Array.isArray(runs)) {
    return "";
  }
  return runs.map((run) => asString(asRecord(run)?.["text"])).join("");
}

export function asString(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number") {
    return String(Math.trunc(v));
  }
  return "";
}

export function toInt(v: unknown): number {
  if (typeof v === "number") {
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Walks a chain of object keys, returning undefined at the first miss. */
export function nested(m: Record<string, unknown>, ...keys: string[]): unknown {
  let cur: unknown = m;
  for (const k of keys) {
    const record = asRecord(cur);
    if (record === null) {
      return undefined;
    }
    cur = record[k];
  }
  return cur;
}

/** `nested` for values that are not known to be objects yet. */
export function nestedIn(value: unknown, ...keys: string[]): unknown {
  const record = asRecord(value);
  return record === null ? undefined : nested(record, ...keys);
}

/** Go's `toFloat`: numbers pass through, numeric strings are parsed, else 0. */
export function toFloat(v: unknown): number {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : 0;
  }
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
