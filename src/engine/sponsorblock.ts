/**
 * Opt-in SponsorBlock support: community-flagged ranges to skip.
 * Ported from internal/youtube/sponsorblock.go.
 *
 * Disabled by default because it sends the video ID to the third-party
 * sponsor.ajay.app database; `YTUBE_SPONSORBLOCK=1` turns it on.
 */
import { ExtractError, classifyNetworkError } from "./errors.js";
import { parseVideoId } from "./ids.js";
import { formatTimestamp } from "./timestamps.js";
import type { Engine } from "./transcript.js";
import type { SponsorSegment, TranscriptSegment } from "./types.js";

export const SPONSORBLOCK_API = "https://sponsor.ajay.app/api/skipSegments";

const DEFAULT_CATEGORIES = [
  "sponsor",
  "selfpromo",
  "interaction",
  "intro",
  "outro",
  "preview",
  "music_offtopic",
];

/** Reports whether the user opted into the third-party SponsorBlock database. */
export function sponsorBlockEnabled(): boolean {
  switch ((process.env.YTUBE_SPONSORBLOCK ?? "").trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

/** Categories requested from SponsorBlock (`YTUBE_SPONSORBLOCK_CATEGORIES`). */
export function sponsorCategories(): string[] {
  const raw = (process.env.YTUBE_SPONSORBLOCK_CATEGORIES ?? "").trim();
  if (raw === "") {
    return [...DEFAULT_CATEGORIES];
  }
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (p !== "") {
      out.push(p);
    }
  }
  return out;
}

interface RawSegment {
  category?: string;
  segment?: number[];
}

/**
 * Fetches skip ranges for a video. Reports an actionable error when the feature
 * has not been enabled, so agents can tell the user why.
 */
export async function sponsorSegments(
  engine: Engine,
  input: string,
  signal?: AbortSignal,
): Promise<SponsorSegment[]> {
  const id = parseVideoId(input);
  if (!sponsorBlockEnabled()) {
    throw new ExtractError({
      code: "SPONSORBLOCK_DISABLED",
      message:
        "SponsorBlock is off by default because it sends the video ID to the third-party sponsor.ajay.app database. " +
        "Set YTUBE_SPONSORBLOCK=1 to enable it.",
      details: { videoId: id, enableWith: "YTUBE_SPONSORBLOCK=1" },
    });
  }

  const cached = await engine.client.cache.get<SponsorSegment[]>("sponsorblock", id);
  if (cached !== undefined) {
    return cached;
  }
  await engine.client.bill("sponsorblock");

  const query = new URLSearchParams();
  query.set("videoID", id);
  query.set("categories", JSON.stringify(sponsorCategories()));
  query.sort();

  let response: { status: number; body: string };
  try {
    response = await engine.client.httpGet(SPONSORBLOCK_API + "?" + query.toString(), {
      headers: { "User-Agent": "youtube-client-mcp" },
      signal,
    });
  } catch (err) {
    throw classifyNetworkError(err);
  }

  if (response.status === 404) {
    // SponsorBlock uses 404 for "no segments submitted".
    await engine.client.cache.set("sponsorblock", id, []);
    return [];
  }
  if (response.status !== 200) {
    throw new ExtractError({
      code: "SPONSORBLOCK_ERROR",
      message: "SponsorBlock returned an unexpected status",
      retryable: response.status >= 500,
      details: { status: response.status },
    });
  }

  let raw: RawSegment[];
  try {
    raw = JSON.parse(response.body) as RawSegment[];
  } catch {
    throw new ExtractError({
      code: "SPONSORBLOCK_ERROR",
      message: "Could not parse SponsorBlock response",
    });
  }
  if (!Array.isArray(raw)) {
    throw new ExtractError({
      code: "SPONSORBLOCK_ERROR",
      message: "Could not parse SponsorBlock response",
    });
  }

  const segments: SponsorSegment[] = [];
  for (const r of raw) {
    const range = r?.segment;
    if (!Array.isArray(range) || range.length !== 2) {
      continue;
    }
    const start = range[0]!;
    const end = range[1]!;
    if (end <= start) {
      continue;
    }
    segments.push({
      category: r.category ?? "",
      start,
      end,
      timestamp: formatTimestamp(start),
      timestampEnd: formatTimestamp(end),
    });
  }
  await engine.client.cache.set("sponsorblock", id, segments);
  return segments;
}

/**
 * Drops transcript segments whose midpoint falls inside a flagged range and
 * reports how many seconds of content were removed.
 */
export function removeSponsorSegments(
  segments: TranscriptSegment[],
  sponsors: SponsorSegment[],
): { segments: TranscriptSegment[]; removedSeconds: number } {
  if (sponsors.length === 0) {
    return { segments, removedSeconds: 0 };
  }
  const kept: TranscriptSegment[] = [];
  let removed = 0;
  for (const s of segments) {
    const mid = s.start + (s.end - s.start) / 2;
    const inSponsor = sponsors.some((sp) => mid >= sp.start && mid <= sp.end);
    if (inSponsor) {
      removed += s.end - s.start;
      continue;
    }
    kept.push(s);
  }
  return { segments: kept, removedSeconds: removed };
}
