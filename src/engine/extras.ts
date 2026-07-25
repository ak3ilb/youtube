/**
 * Secondary player/next data: related videos, the most-replayed heatmap,
 * storyboard tiles, and DASH/HLS manifests.
 *
 * Ported from the Related/walk helpers in internal/youtube/next.go and from
 * internal/youtube/extras.go.
 */
import {
  asRecord,
  asString,
  nested,
  nestedIn,
  runsText,
  toFloat,
  walkJson,
} from "./chapters.js";
import { ExtractError } from "./errors.js";
import { parseVideoId, videoIDPattern } from "./ids.js";
import { clientWEB } from "./innertube.js";
import { formatTimestamp } from "./timestamps.js";
import { infoFromPlayer, type Engine, type PlayerResponse } from "./transcript.js";
import type {
  HeatmapPoint,
  HeatmapResult,
  ManifestsResult,
  RelatedResult,
  RelatedVideo,
  StoryboardLevel,
  StoryboardsResult,
} from "./types.js";

export type {
  HeatmapPoint,
  HeatmapResult,
  ManifestsResult,
  RelatedResult,
  RelatedVideo,
  StoryboardLevel,
  StoryboardsResult,
} from "./types.js";

/** `Related` plus the cache marker the Go engine adds on a cache hit. */
export interface RelatedResultWithCache extends RelatedResult {
  cacheHit?: boolean;
}

/** Videos YouTube suggests alongside the given one. */
export async function related(
  engine: Engine,
  input: string,
  signal?: AbortSignal,
): Promise<RelatedResultWithCache> {
  const id = parseVideoId(input);
  const cached = await engine.client.cache.get<RelatedResultWithCache>("related", id);
  if (cached !== undefined) {
    cached.cacheHit = true;
    return cached;
  }
  let root: unknown;
  try {
    root = await engine.client.callJSON<unknown>("next", clientWEB, { videoId: id }, { signal });
  } catch (err) {
    if (err instanceof ExtractError && err.code === "INVALID_RESPONSE") {
      throw new ExtractError({
        code: "INVALID_RESPONSE",
        message: "Malformed next response",
        retryable: true,
      });
    }
    throw err;
  }
  const videos = extractRelatedVideos(root, id);
  const out: RelatedResultWithCache = { videoId: id, related: videos, count: videos.length };
  await engine.client.cache.set("related", id, out);
  return out;
}

/**
 * Harvests every renderer shape that carries a sibling video, then sweeps bare
 * `watchEndpoint` nodes so a shape YouTube has not shipped yet still yields IDs.
 */
export function extractRelatedVideos(root: unknown, selfID: string): RelatedVideo[] {
  const videos: RelatedVideo[] = [];
  walkJson(root, (key, val) => {
    const m = asRecord(val);
    if (m === null) {
      return true;
    }
    switch (key) {
      case "compactVideoRenderer":
      case "videoRenderer":
      case "reelItemRenderer":
      case "playlistVideoRenderer": {
        const v = relatedFromRenderer(m, selfID);
        if (v !== null) {
          videos.push(v);
        }
        break;
      }
      case "lockupViewModel": {
        const v = relatedFromLockup(m, selfID);
        if (v !== null) {
          videos.push(v);
        }
        break;
      }
    }
    return true;
  });

  walkJson(root, (key, val) => {
    if (key !== "watchEndpoint") {
      return true;
    }
    const m = asRecord(val);
    if (m === null) {
      return true;
    }
    const vid = asString(m["videoId"]);
    if (vid === "" || vid === selfID) {
      return true;
    }
    if (videos.some((existing) => existing.id === vid)) {
      return true;
    }
    videos.push({ id: vid, title: "" });
    return true;
  });

  const seen = new Set<string>();
  const out: RelatedVideo[] = [];
  for (const v of videos) {
    if (v.id === "" || v.id === selfID || seen.has(v.id)) {
      continue;
    }
    seen.add(v.id);
    out.push({
      ...v,
      title: v.title === "" ? "https://www.youtube.com/watch?v=" + v.id : v.title,
    });
  }
  return out;
}

function relatedFromRenderer(
  m: Record<string, unknown>,
  selfID: string,
): RelatedVideo | null {
  let vid = asString(m["videoId"]);
  if (vid === "") {
    vid = asString(nested(m, "navigationEndpoint", "watchEndpoint", "videoId"));
  }
  if (vid === "" || vid === selfID) {
    return null;
  }
  let title = runsText(m["title"]);
  if (title === "") {
    title = asString(nested(m, "title", "simpleText"));
  }
  if (title === "") {
    title = asString(nested(m, "headline", "content"));
  }
  if (title === "") {
    title = runsText(m["accessibility"]);
  }
  return {
    id: vid,
    title,
    channelName: runsText(m["shortBylineText"]) || undefined,
    viewCount: runsText(m["viewCountText"]) || undefined,
    lengthText: asString(nested(m, "lengthText", "simpleText")) || undefined,
  };
}

function relatedFromLockup(m: Record<string, unknown>, selfID: string): RelatedVideo | null {
  let vid = asString(m["contentId"]);
  if (vid === "") {
    vid = asString(
      nested(
        m,
        "rendererContext",
        "commandContext",
        "onTap",
        "innertubeCommand",
        "watchEndpoint",
        "videoId",
      ),
    );
  }
  if (vid === "") {
    walkJson(m, (k, v) => {
      if (k === "watchEndpoint" && vid === "") {
        vid = asString(nestedIn(v, "videoId"));
      }
      return vid === "";
    });
  }
  if (!videoIDPattern.test(vid) || vid === selfID) {
    return null;
  }
  let title = asString(nested(m, "metadata", "lockupMetadataViewModel", "title", "content"));
  if (title === "") {
    walkJson(m, (k, v) => {
      if (k === "accessibilityText" && title === "") {
        title = asString(v);
      }
      return title === "";
    });
  }
  return { id: vid, title };
}

/** Most-replayed intensity markers, when YouTube provides them. */
export async function heatmap(
  engine: Engine,
  input: string,
  signal?: AbortSignal,
): Promise<HeatmapResult> {
  const id = parseVideoId(input);
  let root: unknown;
  try {
    root = await engine.client.callJSON<unknown>("next", clientWEB, { videoId: id }, { signal });
  } catch {
    // The heatmap is decoration; report it as unavailable rather than failing.
    return { videoId: id, points: [], count: 0, available: false };
  }

  const points: HeatmapPoint[] = [];
  walkJson(root, (key, val) => {
    if (key !== "heatmap" && key !== "heatMarkerRenderer") {
      return true;
    }
    const m = asRecord(val);
    if (m === null) {
      return true;
    }
    if (key === "heatMarkerRenderer") {
      const start = toFloat(m["heatMarkerStartTimeMillis"]) / 1000;
      points.push({
        startSeconds: start,
        timestamp: formatTimestamp(start),
        value: toFloat(m["heatMarkerHeightNormalized"]),
      });
      return true;
    }
    const markers = m["heatmapMarkers"];
    if (Array.isArray(markers)) {
      for (const marker of markers) {
        const mm = asRecord(marker) ?? {};
        const start = toFloat(mm["timeRangeStartMillis"]) / 1000;
        let value = toFloat(mm["markerIntensityScoreNormalized"]);
        if (value === 0) {
          value = toFloat(mm["heatMarkerHeightNormalized"]);
        }
        points.push({ startSeconds: start, timestamp: formatTimestamp(start), value });
      }
    }
    return true;
  });

  return { videoId: id, points, count: points.length, available: points.length > 0 };
}

/** Parses the player storyboard spec into concrete tile URLs. */
export async function storyboards(
  engine: Engine,
  input: string,
  signal?: AbortSignal,
): Promise<StoryboardsResult> {
  const id = parseVideoId(input);
  const { player } = await engine.fetchPlayer(id, signal);
  let spec = player.storyboards?.playerStoryboardSpecRenderer?.spec ?? "";
  if (spec === "") {
    // ANDROID often omits storyboards; try WEB explicitly.
    try {
      const webPlayer = await engine.client.callJSON<PlayerResponse>(
        "player",
        clientWEB,
        { videoId: id, contentCheckOk: true, racyCheckOk: true },
        { signal },
      );
      spec = webPlayer.storyboards?.playerStoryboardSpecRenderer?.spec ?? "";
    } catch {
      // Leave the spec empty; the result reports available: false.
    }
  }
  const levels = parseStoryboardSpec(spec);
  return { videoId: id, levels, count: levels.length, available: levels.length > 0 };
}

function atoiOr0(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Expands YouTube's compact storyboard spec
 * (`baseUrl|w#h#count#cols#rows#interval#…#sigh`) into per-level tile URLs.
 */
export function parseStoryboardSpec(spec: string): StoryboardLevel[] {
  if (spec === "") {
    return [];
  }
  const parts = spec.split("|");
  if (parts.length < 2) {
    return [];
  }
  const base = parts[0]!;
  const levels: StoryboardLevel[] = [];
  for (const part of parts.slice(1)) {
    const fields = part.split("#");
    if (fields.length < 8) {
      continue;
    }
    const width = atoiOr0(fields[0]);
    const height = atoiOr0(fields[1]);
    const count = atoiOr0(fields[2]);
    const columns = atoiOr0(fields[3]);
    const rows = atoiOr0(fields[4]);
    const intervalMs = atoiOr0(fields[5]);
    const sigh = fields[fields.length - 1]!;
    let template = base.split("$L").join(String(levels.length));
    template = template.split("$N").join("M$M");
    template += "&sigh=" + sigh;
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
      urls.push(template.split("$M").join(String(i)));
    }
    levels.push({
      width,
      height,
      columns,
      rows,
      intervalMs,
      storyboardCount: count,
      templateUrl: template,
      urls,
    });
  }
  return levels;
}

/** DASH/HLS manifest URLs and live status from the player response. */
export async function manifests(
  engine: Engine,
  input: string,
  signal?: AbortSignal,
): Promise<ManifestsResult> {
  const id = parseVideoId(input);
  const { player, clientName } = await engine.fetchPlayer(id, signal);
  const info = infoFromPlayer(id, player);
  const result: ManifestsResult = {
    videoId: id,
    isLive: info.isLive,
    dashManifestUrl: player.streamingData?.dashManifestUrl || null,
    hlsManifestUrl: player.streamingData?.hlsManifestUrl || null,
    innertubeClient: clientName,
  };
  if (info.isLive) {
    result.note =
      "Live fragment downloading is not supported; manifests are exposed for inspection only";
  }
  return result;
}
