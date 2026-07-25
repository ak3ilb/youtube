/**
 * Playlist, channel, and search discovery over InnerTube.
 * Ported from internal/youtube/discovery.go.
 *
 * These endpoints return deeply nested renderer trees whose shapes YouTube
 * rotates, so every parser walks the whole response looking for the renderers
 * it understands instead of following a fixed path.
 */
import { asRecord, asString, nested, nestedIn, runsText, toInt, walkJson } from "./chapters.js";
import { ExtractError } from "./errors.js";
import { channelIDPattern, parseChannelRef, parsePlaylistID, videoIDPattern } from "./ids.js";
import { clientWEB } from "./innertube.js";
import type { Engine } from "./transcript.js";
import type {
  ChannelResult,
  ChannelVideo,
  PlaylistItem,
  PlaylistResult,
  SearchResult,
  SearchResults,
} from "./types.js";

export type { ChannelResult, PlaylistItem, PlaylistResult, SearchResult, SearchResults } from "./types.js";

/** Playlist metadata plus a limited list of items. */
export async function playlist(
  engine: Engine,
  input: string,
  limit = 0,
  signal?: AbortSignal,
): Promise<PlaylistResult> {
  const listID = parsePlaylistID(input);
  let max = limit;
  if (max <= 0) {
    max = 50;
  }
  if (max > 200) {
    max = 200;
  }
  let browseID = listID;
  if (!browseID.startsWith("VL")) {
    browseID = "VL" + listID;
  }
  const root = await engine.client.callJSON<unknown>(
    "browse",
    clientWEB,
    { browseId: browseID },
    { signal },
  );

  let title = "";
  let owner = "";
  walkJson(root, (key, val) => {
    if (key === "playlistSidebarPrimaryInfoRenderer") {
      const m = asRecord(val);
      if (m !== null && title === "") {
        title = runsText(m["title"]);
      }
    }
    if (key === "playlistSidebarSecondaryInfoRenderer") {
      const m = asRecord(val);
      if (m !== null && owner === "") {
        const videoOwner = asRecord(nested(m, "videoOwner", "videoOwnerRenderer"));
        if (videoOwner !== null) {
          owner = runsText(videoOwner["title"]);
        }
      }
    }
    return true;
  });

  const items = parsePlaylistVideos(root, max);
  return { id: listID, title, owner, items, count: items.length };
}

/** Collects `playlistVideoRenderer` / `lockupViewModel` entries, in order. */
export function parsePlaylistVideos(root: unknown, limit: number): PlaylistItem[] {
  const items: PlaylistItem[] = [];
  walkJson(root, (key, val) => {
    if (items.length >= limit) {
      return true;
    }
    const m = asRecord(val);
    if (m === null) {
      return true;
    }
    switch (key) {
      case "playlistVideoRenderer": {
        const vid = asString(m["videoId"]);
        if (vid === "") {
          return true;
        }
        const index = toInt(asString(nested(m, "index", "simpleText")));
        items.push({
          id: vid,
          title: runsText(m["title"]),
          channelName: runsText(m["shortBylineText"]) || undefined,
          index,
          lengthText: asString(nested(m, "lengthText", "simpleText")) || undefined,
        });
        break;
      }
      case "lockupViewModel": {
        const vid = asString(m["contentId"]);
        if (!videoIDPattern.test(vid)) {
          return true;
        }
        let title = asString(
          nested(m, "metadata", "lockupMetadataViewModel", "title", "content"),
        );
        if (title === "") {
          title = asString(
            nested(m, "metadata", "lockupMetadataViewModel", "title", "runs", "0", "text"),
          );
        }
        items.push({ id: vid, title, index: items.length + 1 });
        break;
      }
    }
    return true;
  });
  return items.length > limit ? items.slice(0, limit) : items;
}

/**
 * Turns an `@handle` or legacy username into a `UC…` id.
 * `navigation/resolve_url` is authoritative; channel search is only a fallback
 * because it can return a similarly named channel.
 */
export async function resolveChannelBrowseID(
  engine: Engine,
  handle: string,
  signal?: AbortSignal,
): Promise<string> {
  if (handle === "") {
    throw new ExtractError({
      code: "INVALID_CHANNEL",
      message: "No channel handle to resolve",
    });
  }
  const cached = await engine.client.cache.get<string>("channel-handle", handle);
  if (typeof cached === "string" && cached !== "") {
    return cached;
  }

  let path = handle.replace(/^\//, "");
  if (!path.startsWith("@")) {
    path = "@" + path;
  }
  try {
    const root = await engine.client.callJSON<unknown>(
      "navigation/resolve_url",
      clientWEB,
      { url: "https://www.youtube.com/" + path },
      { signal },
    );
    let id = "";
    walkJson(root, (key, val) => {
      if (key === "browseEndpoint") {
        const m = asRecord(val);
        if (m !== null && id === "") {
          const candidate = asString(m["browseId"]);
          if (channelIDPattern.test(candidate)) {
            id = candidate;
          }
        }
      }
      return id === "";
    });
    if (id !== "") {
      await engine.client.cache.set("channel-handle", handle, id);
      return id;
    }
  } catch {
    // Fall through to the channel-search fallback below.
  }

  const root = await engine.client.callJSON<unknown>(
    "search",
    clientWEB,
    { query: handle, params: "EgIQAg%3D%3D" }, // channels filter
    { signal },
  );
  let id = "";
  walkJson(root, (key, val) => {
    if (key === "channelRenderer") {
      const m = asRecord(val);
      if (m !== null && id === "") {
        id = asString(m["channelId"]);
      }
    }
    return id === "";
  });
  if (id === "") {
    throw new ExtractError({
      code: "CHANNEL_NOT_FOUND",
      message: "Could not resolve channel handle " + handle,
      details: { handle },
    });
  }
  await engine.client.cache.set("channel-handle", handle, id);
  return id;
}

/** Channel metadata and a sample of recent videos, straight from InnerTube. */
export async function channel(
  engine: Engine,
  input: string,
  limit = 0,
  signal?: AbortSignal,
): Promise<ChannelResult> {
  const ref = parseChannelRef(input);
  let max = limit;
  if (max <= 0) {
    max = 20;
  }
  let browseID = ref.browseId;
  if (browseID === "") {
    browseID = await resolveChannelBrowseID(engine, ref.handle, signal);
  }
  const root = await engine.client.callJSON<unknown>(
    "browse",
    clientWEB,
    { browseId: browseID },
    { signal },
  );

  let title = "";
  let description = "";
  let subscribers = "";
  walkJson(root, (key, val) => {
    if (key === "channelMetadataRenderer") {
      const m = asRecord(val);
      if (m !== null) {
        title = asString(m["title"]);
        description = asString(m["description"]);
      }
    }
    if (key === "subscriberCountText" && subscribers === "") {
      subscribers = runsText(val);
      if (subscribers === "") {
        subscribers = asString(nestedIn(val, "simpleText"));
      }
    }
    return true;
  });

  const videos: ChannelVideo[] = [];
  walkJson(root, (key, val) => {
    if (key !== "richItemRenderer" && key !== "gridVideoRenderer" && key !== "videoRenderer") {
      return true;
    }
    let m = asRecord(val);
    if (key === "richItemRenderer") {
      m = asRecord(nestedIn(val, "content", "videoRenderer"));
      if (m === null) {
        m = asRecord(nestedIn(val, "content", "lockupViewModel"));
      }
    }
    if (m === null) {
      return true;
    }
    const vid = asString(m["videoId"]);
    if (vid === "") {
      return true;
    }
    videos.push({
      id: vid,
      title: runsText(m["title"]),
      lengthText: asString(nested(m, "lengthText", "simpleText")),
    });
    return videos.length < max;
  });

  return {
    id: browseID,
    handle: ref.handle,
    title,
    description,
    subscribers,
    videos,
    count: videos.length,
  };
}

/** Queries YouTube and returns mixed video/channel/playlist results. */
export async function search(
  engine: Engine,
  query: string,
  limit = 0,
  signal?: AbortSignal,
): Promise<SearchResults> {
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
  const root = await engine.client.callJSON<unknown>(
    "search",
    clientWEB,
    { query: q },
    { signal },
  );

  const results: SearchResult[] = [];
  walkJson(root, (key, val) => {
    if (results.length >= max) {
      return true;
    }
    const m = asRecord(val);
    if (m === null) {
      return true;
    }
    switch (key) {
      case "videoRenderer":
        results.push({
          type: "video",
          id: asString(m["videoId"]),
          title: runsText(m["title"]),
          channelName: runsText(m["ownerText"]) || undefined,
          lengthText: asString(nested(m, "lengthText", "simpleText")) || undefined,
          viewCount: runsText(m["viewCountText"]) || undefined,
        });
        break;
      case "channelRenderer":
        results.push({
          type: "channel",
          id: asString(m["channelId"]),
          title: runsText(m["title"]),
        });
        break;
      case "playlistRenderer":
        results.push({
          type: "playlist",
          id: asString(m["playlistId"]),
          title: runsText(m["title"]),
          channelName: runsText(m["longBylineText"]) || undefined,
        });
        break;
    }
    return true;
  });

  const trimmed = results.length > max ? results.slice(0, max) : results;
  return { query: q, results: trimmed, count: trimmed.length };
}
