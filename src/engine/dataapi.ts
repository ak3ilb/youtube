/**
 * Optional YouTube Data API v3 paths, used when an API key is configured.
 * Ported from internal/youtube/dataapi.go.
 *
 * The official API is stable but quota-limited, so it is preferred for search
 * and channel metadata only, with InnerTube as the always-available fallback.
 */
import { asRecord, asString } from "./chapters.js";
import { ExtractError, classifyNetworkError } from "./errors.js";
import { parseChannelRef } from "./ids.js";
import { channel as channelInnerTube, playlist, search as searchInnerTube } from "./discovery.js";
import type { Engine } from "./transcript.js";
import type { PlaylistItem, SearchResult, SearchResults } from "./types.js";

/** `Search` result plus the provenance keys the Data API path adds. */
export interface SearchPreferResult extends SearchResults {
  source?: string;
  note?: string;
  cacheHit?: boolean;
}

/**
 * Channel result. Keys vary with the resolution path (Data API vs InnerTube vs
 * uploads playlist), exactly as in the Go implementation.
 */
export type ChannelPreferResult = Record<string, unknown>;

/** One entry of a channel's uploads playlist. */
export interface UploadItem {
  id: string;
  title: string;
  lengthText?: string;
  index: number;
}

const DATA_API_BASE = "https://www.googleapis.com/youtube/v3/";

/** Performs an official Data API v3 GET, billing it against the rate budget. */
export async function dataAPIGet(
  engine: Engine,
  path: string,
  query: URLSearchParams,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = engine.client.apiKey ?? "";
  if (apiKey === "") {
    throw new ExtractError({
      code: "API_KEY_REQUIRED",
      message:
        "This path needs an official YouTube Data API key. Set YOUTUBE_API_KEY or pass --api-key.",
    });
  }
  await engine.client.bill("dataapi:" + path);
  query.set("key", apiKey);
  query.sort();

  let response: { status: number; body: string };
  try {
    response = await engine.client.httpGet(DATA_API_BASE + path + "?" + query.toString(), {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    throw classifyNetworkError(err);
  }
  if (response.status !== 200) {
    const snippet =
      response.body.length > 300 ? response.body.slice(0, 300) : response.body;
    throw new ExtractError({
      code: "DATA_API_ERROR",
      message: `YouTube Data API returned HTTP ${response.status}`,
      retryable: response.status === 403 || response.status >= 500,
      details: { status: response.status, body: snippet },
    });
  }
  return response.body;
}

function apiKeyPresence(engine: Engine): string {
  return (engine.client.apiKey ?? "") === "" ? "none" : "api";
}

function parseJSONOrThrow(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ExtractError({
      code: "DATA_API_ERROR",
      message: "YouTube Data API returned malformed JSON",
      retryable: true,
      details: { cause: err instanceof Error ? err.message : String(err) },
    });
  }
  return asRecord(parsed) ?? {};
}

function items(raw: string): Record<string, unknown>[] {
  const list = parseJSONOrThrow(raw)["items"];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null);
}

/** Uses the Data API when a key is set, otherwise InnerTube search. */
export async function searchPreferAPI(
  engine: Engine,
  query: string,
  limit = 0,
  signal?: AbortSignal,
): Promise<SearchPreferResult> {
  const q = query.trim();
  if (q === "") {
    throw new ExtractError({ code: "USAGE", message: "search query must not be empty" });
  }
  let max = limit;
  if (max <= 0) {
    max = 20;
  }
  if (max > 50) {
    max = 50;
  }

  const cacheKey = q + "|" + String(max) + "|" + apiKeyPresence(engine);
  const cached = await engine.client.cache.get<SearchPreferResult>("search", cacheKey);
  if (cached !== undefined) {
    cached.cacheHit = true;
    return cached;
  }

  if ((engine.client.apiKey ?? "") !== "") {
    try {
      const out = await searchDataAPI(engine, q, max, signal);
      await engine.client.cache.set("search", cacheKey, out);
      return out;
    } catch {
      // Fall through to InnerTube on API failure.
    }
  }

  const out: SearchPreferResult = { ...(await searchInnerTube(engine, q, max, signal)) };
  out.source = "innertube";
  await engine.client.cache.set("search", cacheKey, out);
  return out;
}

async function searchDataAPI(
  engine: Engine,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchPreferResult> {
  const q = new URLSearchParams();
  q.set("part", "snippet");
  q.set("q", query);
  q.set("maxResults", String(limit));
  q.set("type", "video,channel,playlist");
  const raw = await dataAPIGet(engine, "search", q, signal);

  const results: SearchResult[] = [];
  for (const item of items(raw)) {
    const id = asRecord(item["id"]) ?? {};
    const snippet = asRecord(item["snippet"]) ?? {};
    const title = asString(snippet["title"]);
    const channelName = asString(snippet["channelTitle"]) || undefined;
    const videoId = asString(id["videoId"]);
    const channelId = asString(id["channelId"]);
    const playlistId = asString(id["playlistId"]);
    if (videoId !== "") {
      results.push({ type: "video", id: videoId, title, channelName });
    } else if (channelId !== "") {
      results.push({ type: "channel", id: channelId, title, channelName });
    } else if (playlistId !== "") {
      results.push({ type: "playlist", id: playlistId, title, channelName });
    }
  }
  return {
    query,
    results,
    count: results.length,
    source: "youtube_data_api_v3",
    note: "Official Data API result (stable). Set via YOUTUBE_API_KEY.",
  };
}

/** Resolves a channel via the uploads playlist (`UC…` → `UU…`) and optional Data API. */
export async function channelPreferAPI(
  engine: Engine,
  input: string,
  limit = 0,
  signal?: AbortSignal,
): Promise<ChannelPreferResult> {
  let max = limit;
  if (max <= 0) {
    max = 20;
  }
  const ref = parseChannelRef(input);
  let browseID = ref.browseId;
  const handle = ref.handle;

  const cacheKey = browseID + "|" + handle + "|" + String(max);
  const cached = await engine.client.cache.get<ChannelPreferResult>("channel", cacheKey);
  if (cached !== undefined) {
    cached.cacheHit = true;
    return cached;
  }

  // Resolve handle → channel ID if needed.
  if (browseID === "" && handle !== "") {
    if ((engine.client.apiKey ?? "") !== "") {
      const resolved = await resolveChannelDataAPI(engine, handle, signal).catch(() => null);
      if (resolved !== null) {
        browseID = resolved.id;
        const out: ChannelPreferResult = {
          id: browseID,
          handle,
          title: resolved.title,
          source: "youtube_data_api_v3",
        };
        const vids = await uploadsPlaylist(engine, browseID, max, signal).catch(() => null);
        if (vids !== null) {
          out.videos = vids;
          out.count = vids.length;
        }
        await engine.client.cache.set("channel", cacheKey, out);
        return out;
      }
    }
    // Fall back to the InnerTube channel path.
    const out: ChannelPreferResult = { ...(await channelInnerTube(engine, input, max, signal)) };
    // If videos came back empty, try the uploads playlist once the ID is known.
    const id = typeof out["id"] === "string" ? out["id"] : "";
    if (id !== "") {
      const vids = await uploadsPlaylist(engine, id, max, signal).catch(() => null);
      if (vids !== null && vids.length > 0) {
        out.videos = vids;
        out.count = vids.length;
        out.videosSource = "uploads_playlist";
      }
    }
    out.source = "innertube";
    await engine.client.cache.set("channel", cacheKey, out);
    return out;
  }

  const out: ChannelPreferResult = { id: browseID, handle };
  if ((engine.client.apiKey ?? "") !== "") {
    const meta = await channelMetaDataAPI(engine, browseID, signal).catch(() => null);
    if (meta !== null) {
      for (const [k, v] of Object.entries(meta)) {
        out[k] = v;
      }
      out.source = "youtube_data_api_v3";
    }
  }
  const vids = await uploadsPlaylist(engine, browseID, max, signal).catch(() => null);
  if (vids !== null) {
    out.videos = vids;
    out.count = vids.length;
    out.videosSource = "uploads_playlist";
  }
  if (out.source === undefined || out.source === null) {
    // Fill title via InnerTube browse if needed.
    const inner = await channelInnerTube(engine, browseID, max, signal).catch(() => null);
    if (inner !== null) {
      if (out.title === undefined || out.title === null) {
        out.title = inner.title;
      }
      if (out.description === undefined || out.description === null) {
        out.description = inner.description;
      }
      if (out.count === undefined || out.count === null || out.count === 0) {
        out.videos = inner.videos;
        out.count = inner.count;
      }
      out.source = "innertube";
    }
  }
  await engine.client.cache.set("channel", cacheKey, out);
  return out;
}

async function resolveChannelDataAPI(
  engine: Engine,
  handle: string,
  signal?: AbortSignal,
): Promise<{ id: string; title: string }> {
  const h = handle.replace(/^@/, "");
  const q = new URLSearchParams();
  q.set("part", "snippet");
  q.set("forHandle", h);

  let raw: string;
  try {
    raw = await dataAPIGet(engine, "channels", q, signal);
  } catch {
    // Older fallback: search for the channel by handle.
    const sq = new URLSearchParams();
    sq.set("part", "snippet");
    sq.set("q", handle);
    sq.set("type", "channel");
    sq.set("maxResults", "1");
    const searchRaw = await dataAPIGet(engine, "search", sq, signal);
    const first = items(searchRaw)[0];
    const channelId = asString(asRecord(first?.["id"])?.["channelId"]);
    if (first === undefined || channelId === "") {
      throw new ExtractError({
        code: "CHANNEL_NOT_FOUND",
        message: "Could not resolve handle via Data API",
      });
    }
    return {
      id: channelId,
      title: asString(asRecord(first["snippet"])?.["title"]),
    };
  }

  const first = items(raw)[0];
  if (first === undefined) {
    throw new ExtractError({
      code: "CHANNEL_NOT_FOUND",
      message: "Could not resolve handle via Data API",
    });
  }
  return {
    id: asString(first["id"]),
    title: asString(asRecord(first["snippet"])?.["title"]),
  };
}

async function channelMetaDataAPI(
  engine: Engine,
  id: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const q = new URLSearchParams();
  q.set("part", "snippet,statistics");
  q.set("id", id);
  const raw = await dataAPIGet(engine, "channels", q, signal);
  const first = items(raw)[0];
  if (first === undefined) {
    throw new ExtractError({
      code: "CHANNEL_NOT_FOUND",
      message: "Channel not found in Data API",
    });
  }
  const snippet = asRecord(first["snippet"]) ?? {};
  const statistics = asRecord(first["statistics"]) ?? {};
  return {
    title: asString(snippet["title"]),
    description: asString(snippet["description"]),
    handle: asString(snippet["customUrl"]),
    subscribers: asString(statistics["subscriberCount"]),
    videoCount: asString(statistics["videoCount"]),
  };
}

/** Fetches the channel uploads playlist (`UC…` → `UU…`). */
export async function uploadsPlaylist(
  engine: Engine,
  channelID: string,
  limit: number,
  signal?: AbortSignal,
): Promise<UploadItem[]> {
  if (!channelID.startsWith("UC") || channelID.length < 3) {
    throw new ExtractError({
      code: "INVALID_CHANNEL",
      message: "uploads playlist requires a UC… channel ID",
    });
  }
  const listID = "UU" + channelID.slice(2);
  const result = await playlist(engine, listID, limit, signal);
  return result.items.map((it: PlaylistItem) => ({
    id: it.id,
    title: it.title,
    lengthText: it.lengthText ?? "",
    index: it.index,
  }));
}
