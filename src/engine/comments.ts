/**
 * Comment threads via the `next` continuation protocol.
 * Ported from internal/youtube/comments.go.
 *
 * YouTube has shipped several comment shapes side by side (thread renderers,
 * view models with separate entity payloads, and the legacy comment renderer),
 * so each page is parsed through all of them and de-duplicated by comment id.
 */
import { asRecord, asString, nested, nestedIn, runsText, toInt, walkJson } from "./chapters.js";
import { parseVideoId } from "./ids.js";
import { clientWEB } from "./innertube.js";
import type { Engine } from "./transcript.js";
import type { Comment, CommentsOptions, CommentsResult, CommentSort } from "./types.js";

export type { Comment, CommentsOptions, CommentsResult } from "./types.js";

export const DEFAULT_COMMENT_LIMIT = 20;
export const MAX_COMMENT_LIMIT = 100;

/** A comment plus the continuation token that expands its replies. */
interface ParsedComment extends Comment {
  /** Never serialized, mirroring Go's unexported `replyToken` field. */
  replyToken?: string;
}

function emptyComment(): ParsedComment {
  return { author: "", text: "", isPinned: false };
}

/** Drops the internal reply token and normalizes Go's `omitempty` fields. */
function toComment(cm: ParsedComment): Comment {
  return {
    id: cm.id || undefined,
    author: cm.author,
    text: cm.text,
    likeCount: cm.likeCount || undefined,
    published: cm.published || undefined,
    isPinned: cm.isPinned,
    replyCount: cm.replyCount ? cm.replyCount : undefined,
    replies: cm.replies && cm.replies.length > 0 ? cm.replies : undefined,
  };
}

export function sortOrDefault(sort: string | undefined): CommentSort {
  return (sort ?? "").toLowerCase() === "newest" ? "newest" : "top";
}

/** Top-level comments for a video. */
export function comments(
  engine: Engine,
  input: string,
  limit = 0,
  sort?: string,
  signal?: AbortSignal,
): Promise<CommentsResult> {
  return commentsWithOptions(engine, input, { limit, sort: sortOrDefault(sort) }, signal);
}

/** Comments with ordering, paging, and reply expansion. */
export async function commentsWithOptions(
  engine: Engine,
  input: string,
  opts: CommentsOptions = {},
  signal?: AbortSignal,
): Promise<CommentsResult> {
  const id = parseVideoId(input);
  let limit = opts.limit ?? 0;
  if (limit <= 0) {
    limit = DEFAULT_COMMENT_LIMIT;
  }
  if (limit > MAX_COMMENT_LIMIT) {
    limit = MAX_COMMENT_LIMIT;
  }
  const sort = sortOrDefault(opts.sort);

  let token = opts.cursor ?? "";
  if (token === "") {
    const root = await engine.client.callJSON<unknown>(
      "next",
      clientWEB,
      { videoId: id },
      { signal },
    );
    token = findCommentsContinuation(root);
    if (token === "") {
      return {
        videoId: id,
        comments: [],
        count: 0,
        sort,
        note: "YouTube returned no comment section for this video (comments may be disabled)",
      };
    }
  }

  const collected: ParsedComment[] = [];
  const seen = new Set<string>();
  // A resumed cursor already carries its ordering.
  let sortApplied = (opts.cursor ?? "") !== "";
  let nextToken = "";

  while (token !== "" && collected.length < limit) {
    let pageRoot: unknown;
    try {
      pageRoot = await engine.client.callJSON<unknown>(
        "next",
        clientWEB,
        { continuation: token },
        { signal },
      );
    } catch (err) {
      if (collected.length === 0) {
        throw err;
      }
      break;
    }

    // The sort menu only appears on the first comments page.
    if (!sortApplied) {
      sortApplied = true;
      const sortToken = pickSortToken(pageRoot, sort);
      if (sortToken !== "" && sortToken !== token) {
        token = sortToken;
        continue;
      }
    }

    const page = parseCommentPage(pageRoot);
    for (const cm of page.comments) {
      const key = cm.id && cm.id !== "" ? cm.id : cm.author + "|" + cm.text;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      collected.push(cm);
      if (collected.length >= limit) {
        break;
      }
    }
    if (page.next === "" || page.next === token) {
      nextToken = "";
      break;
    }
    nextToken = page.next;
    token = page.next;
  }

  const maxReplies = opts.replies ?? 0;
  let repliesFetched = 0;
  for (const cm of collected) {
    if (repliesFetched >= maxReplies) {
      break;
    }
    if (cm.replyToken === undefined || cm.replyToken === "") {
      continue;
    }
    let replies: Comment[];
    try {
      replies = await fetchReplies(engine, cm.replyToken, signal);
    } catch {
      break;
    }
    if (replies.length > 0) {
      cm.replies = replies;
    }
    repliesFetched++;
  }

  const out: CommentsResult = {
    videoId: id,
    comments: collected.map(toComment),
    count: collected.length,
    sort,
  };
  if (nextToken !== "" && collected.length >= limit) {
    out.nextCursor = nextToken;
    out.hasMore = true;
  }
  return out;
}

async function fetchReplies(
  engine: Engine,
  token: string,
  signal?: AbortSignal,
): Promise<Comment[]> {
  const root = await engine.client.callJSON<unknown>(
    "next",
    clientWEB,
    { continuation: token },
    { signal },
  );
  return parseCommentPage(root).comments.map(toComment);
}

/**
 * Finds the continuation for the requested ordering in YouTube's comment sort
 * menu. Item titles have shipped as both "Top"/"Newest" and "Top comments"/
 * "Newest first", so this matches on the distinguishing word.
 */
export function pickSortToken(root: unknown, sort: string): string {
  const want = sort === "newest" ? "newest" : "top";
  let found = "";
  walkJson(root, (key, val) => {
    if (key !== "sortFilterSubMenuRenderer") {
      return true;
    }
    const m = asRecord(val);
    if (m === null) {
      return true;
    }
    const items = Array.isArray(m["subMenuItems"]) ? m["subMenuItems"] : [];
    for (const raw of items) {
      const item = asRecord(raw);
      if (item === null) {
        continue;
      }
      const title = asString(item["title"]).toLowerCase();
      if (!title.includes(want)) {
        continue;
      }
      if (item["selected"] === true) {
        return false; // already ordered the way we want
      }
      const token = asString(
        nested(item, "serviceEndpoint", "continuationCommand", "token"),
      );
      if (token !== "") {
        found = token;
      }
      return false;
    }
    return true;
  });
  return found;
}

/** Locates the comment-section token in a `next` response. */
export function findCommentsContinuation(root: unknown): string {
  const tokens: string[] = [];
  walkJson(root, (key, val) => {
    if (
      key !== "continuationEndpoint" &&
      key !== "nextContinuationData" &&
      key !== "continuationCommand"
    ) {
      return true;
    }
    const m = asRecord(val);
    if (m !== null) {
      const token = asString(m["token"]);
      if (token !== "") {
        tokens.push(token);
      }
      const command = asRecord(m["continuationCommand"]);
      if (command !== null) {
        const nestedToken = asString(command["token"]);
        if (nestedToken !== "") {
          tokens.push(nestedToken);
        }
      }
    }
    return true;
  });
  if (tokens.length === 0) {
    return "";
  }
  for (const t of tokens) {
    if (t.includes("comments") || t.length > 40) {
      return t;
    }
  }
  return tokens[0]!;
}

/**
 * Indexes the entity payloads that carry comment text in YouTube's current
 * response shape, keyed by comment id.
 */
export function commentPayloads(root: unknown): Map<string, ParsedComment> {
  const out = new Map<string, ParsedComment>();
  walkJson(root, (key, val) => {
    if (key !== "commentEntityPayload") {
      return true;
    }
    const m = asRecord(val);
    if (m === null) {
      return true;
    }
    const id = asString(nested(m, "properties", "commentId"));
    const text = asString(nested(m, "properties", "content", "content"));
    if (id === "" || text === "") {
      return true;
    }
    out.set(id, {
      id,
      author: asString(nested(m, "author", "displayName")),
      text,
      likeCount: asString(nested(m, "toolbar", "likeCountLiked")),
      published: asString(nested(m, "properties", "publishedTime")),
      isPinned: false,
      replyCount: toInt(asString(nested(m, "toolbar", "replyCount"))),
    });
    return true;
  });
  return out;
}

/**
 * Reads one continuation page. Threads are parsed individually so each comment
 * keeps its own reply continuation token.
 */
export function parseCommentPage(root: unknown): {
  comments: ParsedComment[];
  next: string;
} {
  const payloads = commentPayloads(root);
  let collected: ParsedComment[] = [];

  walkJson(root, (key, val) => {
    if (key !== "commentThreadRenderer") {
      return true;
    }
    const thread = asRecord(val);
    if (thread === null) {
      return true;
    }
    const cm = commentFromThread(thread, payloads);
    if (cm !== null) {
      collected.push(cm);
    }
    return true;
  });

  if (collected.length === 0) {
    collected = flatComments(root, payloads);
  }
  return { comments: collected, next: findPageContinuation(root) };
}

function commentFromThread(
  thread: Record<string, unknown>,
  payloads: Map<string, ParsedComment>,
): ParsedComment | null {
  let cm = emptyComment();
  const modelId = asString(nested(thread, "commentViewModel", "commentViewModel", "commentId"));
  if (modelId !== "") {
    cm = { ...(payloads.get(modelId) ?? emptyComment()), id: modelId };
  } else {
    const directId = asString(nested(thread, "commentViewModel", "commentId"));
    if (directId !== "") {
      cm = { ...(payloads.get(directId) ?? emptyComment()), id: directId };
    }
  }
  if (cm.text === "") {
    const legacy = asRecord(nested(thread, "comment", "commentRenderer"));
    if (legacy !== null) {
      cm = commentFromRenderer(legacy);
    }
  }
  if (cm.text === "") {
    return null;
  }
  cm.isPinned = threadHasPinnedBadge(thread);
  cm.replyToken = threadReplyToken(thread);
  return cm;
}

function threadHasPinnedBadge(thread: Record<string, unknown>): boolean {
  let pinned = false;
  walkJson(thread, (key) => {
    if (key === "pinnedCommentBadge" || key === "pinnedText") {
      pinned = true;
    }
    return !pinned;
  });
  return pinned;
}

function threadReplyToken(thread: Record<string, unknown>): string {
  const replies = asRecord(thread["replies"]);
  if (replies === null) {
    return "";
  }
  let token = "";
  walkJson(replies, (key, val) => {
    if (key !== "continuationItemRenderer") {
      return true;
    }
    const m = asRecord(val);
    if (m !== null && token === "") {
      token = asString(nested(m, "continuationEndpoint", "continuationCommand", "token"));
    }
    return token === "";
  });
  return token;
}

function commentFromRenderer(m: Record<string, unknown>): ParsedComment {
  let author = asString(nested(m, "authorText", "simpleText"));
  if (author === "") {
    author = runsText(m["authorText"]);
  }
  const pinnedBadge = m["pinnedCommentBadge"];
  return {
    id: asString(m["commentId"]),
    author,
    text: runsText(m["contentText"]),
    likeCount: asString(nested(m, "voteCount", "simpleText")),
    published: runsText(m["publishedTimeText"]),
    isPinned: pinnedBadge !== undefined && pinnedBadge !== null,
    replyCount: toInt(m["replyCount"]),
  };
}

/**
 * Handles reply pages and older shapes where comments are not wrapped in thread
 * renderers.
 */
function flatComments(
  root: unknown,
  payloads: Map<string, ParsedComment>,
): ParsedComment[] {
  const collected: ParsedComment[] = [];
  const seen = new Set<string>();
  walkJson(root, (key, val) => {
    if (key === "commentRenderer") {
      const m = asRecord(val);
      if (m !== null) {
        const cm = commentFromRenderer(m);
        if (cm.text !== "" && !seen.has(cm.text)) {
          seen.add(cm.text);
          collected.push(cm);
        }
      }
    }
    return true;
  });
  if (collected.length > 0) {
    return collected;
  }

  // Entity payloads only: preserve view-model order when available.
  const order: string[] = [];
  walkJson(root, (key, val) => {
    if (key === "commentViewModel") {
      const id = asString(nestedIn(val, "commentId"));
      if (id !== "") {
        order.push(id);
      }
    }
    return true;
  });
  for (const id of order) {
    const cm = payloads.get(id);
    if (cm !== undefined && !seen.has(id)) {
      seen.add(id);
      collected.push(cm);
    }
  }
  if (collected.length === 0) {
    for (const cm of payloads.values()) {
      collected.push(cm);
    }
  }
  return collected;
}

function findPageContinuation(root: unknown): string {
  let next = "";
  walkJson(root, (key, val) => {
    if (key !== "continuationEndpoint" && key !== "continuationCommand") {
      return true;
    }
    const m = asRecord(val);
    if (m !== null) {
      const token = asString(m["token"]);
      if (token !== "") {
        next = token;
      }
      const command = asRecord(m["continuationCommand"]);
      if (command !== null) {
        const nestedToken = asString(command["token"]);
        if (nestedToken !== "") {
          next = nestedToken;
        }
      }
    }
    return true;
  });
  return next;
}
