/**
 * Input parsing for video, playlist, and channel references.
 *
 * Ported from `ParseVideoID` (internal/youtube/extractor.go) plus
 * `ParsePlaylistID` / `ParseChannelRef` (internal/youtube/discovery.go).
 */
import { ExtractError } from "./errors.js";

// `WatchURLAt` lives beside `ParseVideoID` in extractor.go; re-exported here so
// callers get the same grouping.
export { watchURLAt, watchURLAt as watchUrlAt } from "./timestamps.js";

export const videoIDPattern = /^[A-Za-z0-9_-]{11}$/;
export const playlistIDPattern = /^[A-Za-z0-9_-]{10,}$/;
export const channelIDPattern = /^UC[A-Za-z0-9_-]{22}$/;

const PLAYLIST_PREFIXES = ["PL", "UU", "LL", "FL", "OL"] as const;

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * RFC 3986 authority test, matching Go's `url.Parse`. The WHATWG parser used by
 * `new URL` collapses runs of slashes after a scheme, so `https:////host/x`
 * would otherwise resolve to a host that Go reports as empty.
 */
function hasAuthority(input: string): boolean {
  const scheme = SCHEME_PATTERN.exec(input);
  const rest = scheme ? input.slice(scheme[0].length) : input;
  if (!rest.startsWith("//")) return false;
  const authority = rest.slice(2).split(/[/?#]/, 1)[0] ?? "";
  return authority !== "";
}

/**
 * Mirrors Go's `url.Parse` + non-empty-host check: anything without a host
 * (relative paths, bare IDs, `mailto:`…) is reported as unusable.
 */
function parseAbsoluteURL(input: string): URL | undefined {
  if (!hasAuthority(input)) return undefined;
  try {
    // Scheme-relative URLs keep their host in Go, so give `new URL` a base.
    const url = SCHEME_PATTERN.test(input)
      ? new URL(input)
      : new URL(input, "https://scheme-relative.invalid");
    return url.host === "" ? undefined : url;
  } catch {
    return undefined;
  }
}

/** Go's `strings.Trim(path, "/")` followed by `strings.Split(_, "/")`. */
function pathSegments(pathname: string): string[] {
  return pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
}

function invalidVideoError(input: string): ExtractError {
  return new ExtractError({
    code: "INVALID_VIDEO",
    message:
      "Expected an 11-character YouTube video ID or a supported YouTube URL (watch, youtu.be, shorts, embed, live)",
    details: { input },
  });
}

/**
 * Accepts a bare 11-character ID or any common YouTube URL shape (watch,
 * youtu.be, shorts, embed, live, music) and returns the video ID.
 */
export function parseVideoID(rawInput: string): string {
  let input = rawInput.trim();
  if (videoIDPattern.test(input)) return input;
  if (!input.includes("://") && input.includes("youtu")) {
    input = "https://" + input;
  }
  const url = parseAbsoluteURL(input);
  if (!url) throw invalidVideoError(input);

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let candidate = "";
  switch (host) {
    case "youtu.be":
      candidate = pathSegments(url.pathname)[0] ?? "";
      break;
    case "youtube.com":
    case "m.youtube.com":
    case "music.youtube.com":
    case "youtube-nocookie.com": {
      candidate = url.searchParams.get("v") ?? "";
      if (candidate === "") {
        const parts = pathSegments(url.pathname);
        if (parts.length >= 2) {
          switch (parts[0]) {
            case "shorts":
            case "embed":
            case "live":
            case "v":
              candidate = parts[1]!;
              break;
          }
        }
      }
      break;
    }
    default:
      throw invalidVideoError(input);
  }

  if (!videoIDPattern.test(candidate)) throw invalidVideoError(input);
  return candidate;
}

/** Extracts a playlist ID from a URL or bare ID. */
export function parsePlaylistID(rawInput: string): string {
  const input = rawInput.trim();
  if (
    playlistIDPattern.test(input) &&
    PLAYLIST_PREFIXES.some((prefix) => input.startsWith(prefix))
  ) {
    return input;
  }

  const url = parseAbsoluteURL(input);
  if (!url) {
    if (!input.includes("://") && input.includes("list=")) {
      return parsePlaylistID(
        "https://www.youtube.com/playlist?" + input.replace(/^\?/, ""),
      );
    }
    throw new ExtractError({
      code: "INVALID_PLAYLIST",
      message: "Expected a playlist ID or youtube.com/playlist?list=... URL",
      details: { input },
    });
  }

  const list = url.searchParams.get("list") ?? "";
  if (list === "") {
    throw new ExtractError({
      code: "INVALID_PLAYLIST",
      message: "URL does not contain a list= playlist ID",
      details: { input },
    });
  }
  return list;
}

export interface ChannelRef {
  /** A `UC…` browse ID when the input carried one, otherwise empty. */
  browseId: string;
  /** An `@handle` or legacy username that still needs resolving, otherwise empty. */
  handle: string;
}

/** Resolves `/@handle`, `/channel/UC…`, `/c/`, `/user/`, or a bare `UC…` ID. */
export function parseChannelRef(rawInput: string): ChannelRef {
  let input = rawInput.trim();
  if (channelIDPattern.test(input)) return { browseId: input, handle: "" };
  if (input.startsWith("@")) return { browseId: "", handle: input };

  if (
    !input.includes("://") &&
    (input.startsWith("youtube.com") || input.startsWith("www.youtube.com"))
  ) {
    input = "https://" + input;
  }

  const url = parseAbsoluteURL(input);
  if (!url) {
    throw new ExtractError({
      code: "INVALID_CHANNEL",
      message:
        "Expected a channel ID (UC...), @handle, or youtube.com/@handle /channel/ /c/ URL",
      details: { input },
    });
  }

  const parts = pathSegments(url.pathname);
  const first = parts[0] ?? "";
  if (first === "") {
    throw new ExtractError({
      code: "INVALID_CHANNEL",
      message: "Could not parse channel from URL",
    });
  }
  if (first.startsWith("@")) return { browseId: "", handle: first };
  if (first === "channel" && parts.length >= 2) {
    return { browseId: parts[1]!, handle: "" };
  }
  if (first === "c" && parts.length >= 2) {
    return { browseId: "", handle: "@" + parts[1]! };
  }
  if (first === "user" && parts.length >= 2) {
    return { browseId: "", handle: parts[1]! };
  }
  throw new ExtractError({
    code: "INVALID_CHANNEL",
    message: "Unrecognized channel URL shape",
    details: { input },
  });
}

export { parseVideoID as parseVideoId, parsePlaylistID as parsePlaylistId };
