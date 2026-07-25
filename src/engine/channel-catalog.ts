/**
 * Exhaustive creator-channel catalog discovery over InnerTube.
 *
 * Resolves any `parseChannelRef`-supported input to a `UC…` browse id, loads
 * the Videos and Shorts tab endpoints, follows continuation tokens, and merges
 * results with Shorts-tab provenance winning on duplicate ids. Classification
 * is tab-based — never duration-based.
 */
import { mkdir } from "node:fs/promises";

import { asRecord, asString, nested, nestedIn, runsText, walkJson } from "./chapters.js";
import { resolveChannelBrowseID } from "./discovery.js";
import { ExtractError } from "./errors.js";
import { withFileLock } from "./file-lock.js";
import { parseChannelRef, videoIDPattern } from "./ids.js";
import { clientWEB } from "./innertube.js";
import type { Engine } from "./transcript.js";
import type {
  ChannelCatalog,
  ChannelCatalogContentFilter,
  ChannelCatalogItem,
  ChannelCatalogOptions,
  ChannelCatalogPage,
  ChannelCatalogPageOptions,
  ChannelItemContentType,
} from "./types.js";

export type {
  ChannelCatalog,
  ChannelCatalogContentFilter,
  ChannelCatalogItem,
  ChannelCatalogOptions,
  ChannelCatalogPage,
  ChannelCatalogPageOptions,
  ChannelItemContentType,
} from "./types.js";

const CACHE_NS = "channel-catalog";
const catalogLocks = new Map<string, Promise<void>>();

async function withCatalogLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prior = catalogLocks.get(channelId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);
  catalogLocks.set(channelId, queued);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (catalogLocks.get(channelId) === queued) catalogLocks.delete(channelId);
  }
}

/** Browse endpoint for a channel tab (Videos / Shorts). */
export interface ChannelTabEndpoint {
  title: string;
  browseId: string;
  params: string;
  /** Kind inferred from the tab title / encoded params. */
  kind: "videos" | "shorts";
}

/** Cached continuation/completion state for one channel tab. */
export interface ChannelTabState {
  available: boolean;
  title?: string;
  browseId?: string;
  params?: string;
  /** Next continuation token; empty when complete or not yet started. */
  continuation: string;
  /** True once the tab has been browsed at least once (or marked unavailable). */
  started: boolean;
  complete: boolean;
}

/** On-disk progressive catalog manifest under the `channel-catalog` namespace. */
export interface ChannelCatalogManifest {
  channelId: string;
  handle: string;
  title: string;
  description: string;
  subscribers: string;
  items: ChannelCatalogItem[];
  videosTab: ChannelTabState;
  shortsTab: ChannelTabState;
}

interface ParsedCatalogEntry {
  id: string;
  title: string;
  lengthText?: string;
}

function emptyTabState(): ChannelTabState {
  return {
    available: false,
    continuation: "",
    started: false,
    complete: false,
  };
}

function normalizeFilter(raw: string | undefined): "all" | "videos" | "shorts" {
  const v = (raw ?? "all").trim().toLowerCase();
  if (v === "videos" || v === "video") return "videos";
  if (v === "shorts" || v === "short") return "shorts";
  return "all";
}

function decodeParamsHint(params: string): string {
  if (params === "") return "";
  try {
    const decoded = decodeURIComponent(params).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(decoded, "base64").toString("utf8").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Classifies a channel tab as Videos or Shorts from its title and/or the
 * base64-encoded browse `params` payload YouTube embeds in the endpoint.
 */
export function classifyChannelTab(
  title: string,
  params = "",
): "videos" | "shorts" | null {
  const t = title.trim().toLowerCase();
  if (t === "videos" || t === "video") return "videos";
  if (t === "shorts" || t === "short") return "shorts";

  const hint = decodeParamsHint(params);
  if (hint.includes("short")) return "shorts";
  if (hint.includes("video")) return "videos";
  return null;
}

/** Pulls Videos / Shorts browse endpoints out of a channel browse response. */
export function parseChannelTabEndpoints(root: unknown): ChannelTabEndpoint[] {
  const found = new Map<"videos" | "shorts", ChannelTabEndpoint>();

  walkJson(root, (key, val) => {
    if (key !== "tabRenderer" && key !== "expandableTabRenderer") {
      return true;
    }
    const m = asRecord(val);
    if (m === null) return true;

    const title = asString(m["title"]) || runsText(m["title"]);
    const browseId = asString(nested(m, "endpoint", "browseEndpoint", "browseId"));
    const params = asString(nested(m, "endpoint", "browseEndpoint", "params"));
    const kind = classifyChannelTab(title, params);
    if (kind === null || browseId === "" || found.has(kind)) {
      return true;
    }
    found.set(kind, { title: title || kind, browseId, params, kind });
    return true;
  });

  const out: ChannelTabEndpoint[] = [];
  const videos = found.get("videos");
  const shorts = found.get("shorts");
  if (videos) out.push(videos);
  if (shorts) out.push(shorts);
  return out;
}

function lengthTextFrom(m: Record<string, unknown>): string {
  let text = asString(nested(m, "lengthText", "simpleText"));
  if (text !== "") return text;
  text = runsText(m["lengthText"]);
  if (text !== "") return text;
  text = asString(
    nested(m, "thumbnailOverlays", "0", "thumbnailOverlayTimeStatusRenderer", "text", "simpleText"),
  );
  if (text !== "") return text;
  return runsText(
    nested(m, "thumbnailOverlays", "0", "thumbnailOverlayTimeStatusRenderer", "text"),
  );
}

function titleFromLockup(m: Record<string, unknown>): string {
  let title = asString(nested(m, "metadata", "lockupMetadataViewModel", "title", "content"));
  if (title !== "") return title;
  title = asString(
    nested(m, "metadata", "lockupMetadataViewModel", "title", "runs", "0", "text"),
  );
  if (title !== "") return title;
  return runsText(m["title"]);
}

function titleFromShortsLockup(m: Record<string, unknown>): string {
  let title = asString(nested(m, "overlayMetadata", "primaryText", "content"));
  if (title !== "") return title;
  title = runsText(nested(m, "overlayMetadata", "primaryText"));
  if (title !== "") return title;
  title = asString(m["accessibilityText"]);
  if (title !== "") {
    // Accessibility strings are often "Title · 1.2M views" — keep the title side.
    const cut = title.split(/\s+[·|]\s+/)[0]?.trim();
    if (cut) return cut;
  }
  return "";
}

/**
 * Extracts an 11-char video id from a known channel-grid / Shorts renderer.
 * Returns `""` when the node is not a video entry.
 */
export function videoIdFromCatalogRenderer(
  key: string,
  val: unknown,
): string {
  const m = asRecord(val);
  if (m === null) return "";

  switch (key) {
    case "videoRenderer":
    case "gridVideoRenderer":
    case "reelItemRenderer": {
      const id = asString(m["videoId"]);
      return videoIDPattern.test(id) ? id : "";
    }
    case "lockupViewModel": {
      const id = asString(m["contentId"]);
      return videoIDPattern.test(id) ? id : "";
    }
    case "shortsLockupViewModel": {
      const fromTap =
        asString(nested(m, "onTap", "innertubeCommand", "reelWatchEndpoint", "videoId")) ||
        asString(
          nested(
            m,
            "rendererContext",
            "commandContext",
            "onTap",
            "innertubeCommand",
            "reelWatchEndpoint",
            "videoId",
          ),
        ) ||
        asString(nested(m, "onTap", "innertubeCommand", "watchEndpoint", "videoId"));
      if (videoIDPattern.test(fromTap)) return fromTap;

      const entity = asString(m["entityId"]);
      const match = /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{11})$/.exec(entity);
      if (match && videoIDPattern.test(match[1]!)) return match[1]!;
      return "";
    }
    case "richItemRenderer": {
      const content = asRecord(m["content"]);
      if (content === null) return "";
      for (const [innerKey, innerVal] of Object.entries(content)) {
        const id = videoIdFromCatalogRenderer(innerKey, innerVal);
        if (id !== "") return id;
      }
      return "";
    }
    default:
      return "";
  }
}

function entryFromRenderer(key: string, val: unknown): ParsedCatalogEntry | null {
  const m = asRecord(val);
  if (m === null) return null;

  if (key === "richItemRenderer") {
    const content = asRecord(m["content"]);
    if (content === null) return null;
    for (const [innerKey, innerVal] of Object.entries(content)) {
      const entry = entryFromRenderer(innerKey, innerVal);
      if (entry !== null) return entry;
    }
    return null;
  }

  const id = videoIdFromCatalogRenderer(key, val);
  if (id === "") return null;

  let title = "";
  let lengthText = "";
  switch (key) {
    case "videoRenderer":
    case "gridVideoRenderer":
    case "reelItemRenderer":
      title = runsText(m["title"]);
      if (title === "") title = asString(nested(m, "headline", "simpleText"));
      lengthText = lengthTextFrom(m);
      break;
    case "lockupViewModel":
      title = titleFromLockup(m);
      lengthText = asString(
        nested(m, "contentImage", "thumbnailViewModel", "overlays", "0", "thumbnailBottomOverlayViewModel", "badge", "thumbnailBadgeViewModel", "text"),
      );
      break;
    case "shortsLockupViewModel":
      title = titleFromShortsLockup(m);
      break;
  }

  const entry: ParsedCatalogEntry = { id, title };
  if (lengthText !== "") entry.lengthText = lengthText;
  return entry;
}

const CATALOG_RENDERER_KEYS = new Set([
  "videoRenderer",
  "gridVideoRenderer",
  "reelItemRenderer",
  "shortsLockupViewModel",
  "lockupViewModel",
  "richItemRenderer",
]);

/**
 * Collects catalog entries from a Videos/Shorts browse or continuation page.
 * Deduplicates within the page while preserving first-seen order. When `scope`
 * is provided, only that subtree is walked (typically the selected tab).
 */
export function parseChannelCatalogItems(
  root: unknown,
  scope?: unknown,
): ParsedCatalogEntry[] {
  const target = scope ?? root;
  const items: ParsedCatalogEntry[] = [];
  const seen = new Set<string>();

  walkJson(target, (key, val) => {
    if (!CATALOG_RENDERER_KEYS.has(key)) return true;

    // Prefer leaf renderers; still accept richItemRenderer unwraps for shapes
    // where the leaf key is unexpected, but skip re-entering leaves already
    // covered by walking into richItem content.
    if (key === "richItemRenderer") {
      const entry = entryFromRenderer(key, val);
      if (entry !== null && !seen.has(entry.id)) {
        // Only keep if the inner content is NOT one of the known leaf keys —
        // those will be collected when the walk descends.
        const content = asRecord(asRecord(val)?.["content"]);
        const innerKeys = content ? Object.keys(content) : [];
        const hasKnownLeaf = innerKeys.some((k) => CATALOG_RENDERER_KEYS.has(k) && k !== "richItemRenderer");
        if (!hasKnownLeaf) {
          seen.add(entry.id);
          items.push(entry);
        }
      }
      return true;
    }

    const entry = entryFromRenderer(key, val);
    if (entry !== null && !seen.has(entry.id)) {
      seen.add(entry.id);
      items.push(entry);
    }
    return true;
  });

  return items;
}

/**
 * Finds the next browse continuation token. Prefers tokens inside
 * `continuationItemRenderer` nodes (the grid pager) over unrelated tokens.
 */
export function findBrowseContinuation(root: unknown): string {
  let fromItem = "";
  const fallback: string[] = [];

  walkJson(root, (key, val) => {
    if (key === "continuationItemRenderer") {
      const m = asRecord(val);
      if (m !== null && fromItem === "") {
        fromItem = asString(
          nested(m, "continuationEndpoint", "continuationCommand", "token"),
        );
        if (fromItem === "") {
          fromItem = asString(nested(m, "continuationEndpoint", "token"));
        }
      }
      return true;
    }
    if (
      key === "continuationCommand" ||
      key === "nextContinuationData" ||
      key === "continuationEndpoint"
    ) {
      const m = asRecord(val);
      if (m !== null) {
        const token = asString(m["token"]);
        if (token !== "") fallback.push(token);
        const nestedToken = asString(nested(m, "continuationCommand", "token"));
        if (nestedToken !== "") fallback.push(nestedToken);
      }
    }
    return true;
  });

  if (fromItem !== "") return fromItem;
  return fallback[0] ?? "";
}

/** Returns the content object of the selected channel tab, when present. */
export function selectedTabContent(root: unknown): unknown {
  let content: unknown;
  walkJson(root, (key, val) => {
    if (key !== "tabRenderer" && key !== "expandableTabRenderer") return true;
    const m = asRecord(val);
    if (m !== null && m["selected"] === true && m["content"] !== undefined) {
      content = m["content"];
      return false;
    }
    return true;
  });
  return content;
}

function extractChannelMeta(root: unknown): {
  title: string;
  description: string;
  subscribers: string;
} {
  let title = "";
  let description = "";
  let subscribers = "";
  walkJson(root, (key, val) => {
    if (key === "channelMetadataRenderer") {
      const m = asRecord(val);
      if (m !== null) {
        if (title === "") title = asString(m["title"]);
        if (description === "") description = asString(m["description"]);
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
  return { title, description, subscribers };
}

function mergeEntries(
  items: ChannelCatalogItem[],
  indexById: Map<string, number>,
  entries: ParsedCatalogEntry[],
  contentType: ChannelItemContentType,
): void {
  for (const entry of entries) {
    const existingIdx = indexById.get(entry.id);
    if (existingIdx === undefined) {
      indexById.set(entry.id, items.length);
      const item: ChannelCatalogItem = {
        id: entry.id,
        title: entry.title,
        contentType,
      };
      if (entry.lengthText) item.lengthText = entry.lengthText;
      items.push(item);
      continue;
    }

    const prev = items[existingIdx]!;
    // Shorts-tab provenance wins; keep stable first-seen position.
    if (prev.contentType === "video" && contentType === "short") {
      prev.contentType = "short";
    }
    if (!prev.title && entry.title) prev.title = entry.title;
    if (!prev.lengthText && entry.lengthText) prev.lengthText = entry.lengthText;
  }
}

function rebuildIndex(items: ChannelCatalogItem[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    index.set(items[i]!.id, i);
  }
  return index;
}

function tabForKind(
  manifest: ChannelCatalogManifest,
  kind: "videos" | "shorts",
): ChannelTabState {
  return kind === "videos" ? manifest.videosTab : manifest.shortsTab;
}

function applyEndpoint(tab: ChannelTabState, endpoint: ChannelTabEndpoint | undefined): void {
  if (!endpoint) {
    tab.available = false;
    tab.started = true;
    tab.complete = true;
    tab.continuation = "";
    return;
  }
  tab.available = true;
  tab.title = endpoint.title;
  tab.browseId = endpoint.browseId;
  tab.params = endpoint.params;
  // Preserve in-progress continuation/complete when re-reading home tabs.
  if (!tab.started && !tab.complete) {
    tab.continuation = "";
  }
}

function filteredItems(
  items: ChannelCatalogItem[],
  filter: "all" | "videos" | "shorts",
): ChannelCatalogItem[] {
  if (filter === "all") return items.slice();
  if (filter === "videos") return items.filter((i) => i.contentType === "video");
  return items.filter((i) => i.contentType === "short");
}

function tabsComplete(
  manifest: ChannelCatalogManifest,
  filter: "all" | "videos" | "shorts",
): boolean {
  if (filter === "videos") return manifest.videosTab.complete;
  if (filter === "shorts") return manifest.shortsTab.complete;
  return manifest.videosTab.complete && manifest.shortsTab.complete;
}

function toCatalog(
  manifest: ChannelCatalogManifest,
  filter: "all" | "videos" | "shorts",
): ChannelCatalog {
  const items = filteredItems(manifest.items, filter);
  let videoCount = 0;
  let shortCount = 0;
  for (const item of items) {
    if (item.contentType === "short") shortCount++;
    else videoCount++;
  }
  return {
    id: manifest.channelId,
    handle: manifest.handle,
    title: manifest.title,
    description: manifest.description,
    subscribers: manifest.subscribers,
    items,
    count: items.length,
    videoCount,
    shortCount,
    complete: tabsComplete(manifest, filter),
  };
}

async function browseJSON(
  engine: Engine,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return engine.client.callJSON<unknown>("browse", clientWEB, body, { signal });
}

function parsePageItems(root: unknown): { items: ParsedCatalogEntry[]; continuation: string } {
  const selected = selectedTabContent(root);
  // Prefer the selected tab subtree so Home shelf Shorts don't leak into Videos.
  const items = parseChannelCatalogItems(root, selected ?? root);
  // Continuations for the grid live inside the selected tab (or the
  // appendContinuationItemsAction payload on later pages).
  const continuation = findBrowseContinuation(selected ?? root);
  return { items, continuation };
}

async function startTab(
  engine: Engine,
  manifest: ChannelCatalogManifest,
  kind: "videos" | "shorts",
  signal?: AbortSignal,
): Promise<void> {
  const tab = tabForKind(manifest, kind);
  if (!tab.available || tab.started) return;

  const browseId = tab.browseId || manifest.channelId;
  const body: Record<string, unknown> = { browseId };
  if (tab.params) body.params = tab.params;

  try {
    const root = await browseJSON(engine, body, signal);
    const { items, continuation } = parsePageItems(root);
    mergeEntries(
      manifest.items,
      rebuildIndex(manifest.items),
      items,
      kind === "shorts" ? "short" : "video",
    );
    tab.started = true;
    tab.continuation = continuation;
    tab.complete = continuation === "";
  } catch (err) {
    // One missing/unavailable tab must not sink the other.
    tab.available = false;
    tab.started = true;
    tab.complete = true;
    tab.continuation = "";
    if (!manifest.videosTab.available && !manifest.shortsTab.available) {
      throw err;
    }
  }
}

async function continueTab(
  engine: Engine,
  manifest: ChannelCatalogManifest,
  kind: "videos" | "shorts",
  signal?: AbortSignal,
): Promise<boolean> {
  const tab = tabForKind(manifest, kind);
  if (!tab.available || tab.complete) return false;
  if (!tab.started) {
    await startTab(engine, manifest, kind, signal);
    return true;
  }
  if (tab.continuation === "") {
    tab.complete = true;
    return false;
  }

  const token = tab.continuation;
  const root = await browseJSON(engine, { continuation: token }, signal);
  const { items, continuation } = parsePageItems(root);
  const before = manifest.items.length;
  mergeEntries(
    manifest.items,
    rebuildIndex(manifest.items),
    items,
    kind === "shorts" ? "short" : "video",
  );
  // On failure the caller persists the prior continuation for resume.
  tab.continuation = continuation;
  tab.complete =
    continuation === "" ||
    (continuation === token && manifest.items.length === before);
  return true;
}

async function saveManifest(engine: Engine, manifest: ChannelCatalogManifest): Promise<void> {
  await engine.client.cache.set(CACHE_NS, manifest.channelId, manifest);
}

function isManifest(value: unknown): value is ChannelCatalogManifest {
  const m = asRecord(value);
  if (m === null) return false;
  return (
    typeof m["channelId"] === "string" &&
    Array.isArray(m["items"]) &&
    asRecord(m["videosTab"]) !== null &&
    asRecord(m["shortsTab"]) !== null
  );
}

async function loadOrInitManifest(
  engine: Engine,
  browseID: string,
  handle: string,
  refresh: boolean,
  signal?: AbortSignal,
): Promise<ChannelCatalogManifest> {
  const cached = refresh
    ? undefined
    : await engine.client.cache.getPersistent<unknown>(CACHE_NS, browseID);
  if (isManifest(cached) && cached.channelId === browseID) {
    if (handle && !cached.handle) cached.handle = handle;
    return cached;
  }

  const root = await browseJSON(engine, { browseId: browseID }, signal);
  const meta = extractChannelMeta(root);
  const endpoints = parseChannelTabEndpoints(root);
  const videosEp = endpoints.find((e) => e.kind === "videos");
  const shortsEp = endpoints.find((e) => e.kind === "shorts");

  const manifest: ChannelCatalogManifest = {
    channelId: browseID,
    handle,
    title: meta.title,
    description: meta.description,
    subscribers: meta.subscribers,
    items: [],
    videosTab: emptyTabState(),
    shortsTab: emptyTabState(),
  };
  applyEndpoint(manifest.videosTab, videosEp);
  applyEndpoint(manifest.shortsTab, shortsEp);

  if (!manifest.videosTab.available && !manifest.shortsTab.available) {
    throw new ExtractError({
      code: "CHANNEL_NOT_FOUND",
      message: "Channel has no Videos or Shorts tab to catalog",
      details: { channelId: browseID },
    });
  }

  // If the home response already selected Videos/Shorts, seed from that page
  // without an extra round-trip.
  const selected = selectedTabContent(root);
  if (selected !== undefined) {
    let selectedKind: "videos" | "shorts" | null = null;
    walkJson(root, (key, val) => {
      if (key !== "tabRenderer" && key !== "expandableTabRenderer") return true;
      const m = asRecord(val);
      if (m !== null && m["selected"] === true) {
        const title = asString(m["title"]) || runsText(m["title"]);
        const params = asString(nested(m, "endpoint", "browseEndpoint", "params"));
        selectedKind = classifyChannelTab(title, params);
        return false;
      }
      return true;
    });
    if (selectedKind === "videos" || selectedKind === "shorts") {
      const tab = tabForKind(manifest, selectedKind);
      if (tab.available && !tab.started) {
        const { items, continuation } = parsePageItems(root);
        mergeEntries(
          manifest.items,
          rebuildIndex(manifest.items),
          items,
          selectedKind === "shorts" ? "short" : "video",
        );
        tab.started = true;
        tab.continuation = continuation;
        tab.complete = continuation === "";
      }
    }
  }

  await saveManifest(engine, manifest);
  return manifest;
}

/**
 * Discovers the creator's Videos and/or Shorts catalog, resuming from a
 * progressive disk-cache manifest when present.
 *
 * - `contentType`: `"all"` (default), `"videos"`, or `"shorts"`.
 * - `ensure`: minimum filtered items to return; `0` means discover until every
 *   requested tab is complete (or unavailable).
 */
export async function discoverChannelCatalog(
  engine: Engine,
  input: string,
  opts: ChannelCatalogOptions = {},
  signal?: AbortSignal,
): Promise<ChannelCatalog> {
  const ref = parseChannelRef(input);
  let browseID = ref.browseId;
  if (browseID === "") {
    browseID = await resolveChannelBrowseID(engine, ref.handle, signal);
  }
  await mkdir(engine.client.cache.dir, { recursive: true, mode: 0o755 });

  return withCatalogLock(browseID, () =>
    withFileLock(
      engine.client.cache.keyPath(CACHE_NS, browseID) + ".lock",
      "CHANNEL_CATALOG_BUSY",
      signal,
      async () => {
    const filter = normalizeFilter(opts.contentType);
    const ensure = opts.ensure ?? 0;
    const wantComplete = ensure <= 0;

    const manifest = await loadOrInitManifest(
      engine,
      browseID,
      ref.handle,
      opts.refresh === true,
      signal,
    );

    const kinds: Array<"videos" | "shorts"> =
      filter === "videos" ? ["videos"] : filter === "shorts" ? ["shorts"] : ["videos", "shorts"];

    const needsMore = (): boolean => {
      const have = filteredItems(manifest.items, filter).length;
      if (wantComplete) return !tabsComplete(manifest, filter);
      if (have >= ensure) return false;
      return !tabsComplete(manifest, filter);
    };

    // For a new all-content manifest, advance Videos before Shorts. Existing
    // first-seen order remains append-only so numeric cursors never regress.
    while (needsMore()) {
      let progressed = false;
      for (const kind of kinds) {
        if (!needsMore()) break;
        const tab = tabForKind(manifest, kind);
        if (tab.complete) continue;
        if (filter === "all" && kind === "shorts" && !manifest.videosTab.complete) {
          continue;
        }
        try {
          const moved = await continueTab(engine, manifest, kind, signal);
          if (moved) {
            progressed = true;
            await saveManifest(engine, manifest);
          }
        } catch (err) {
          await saveManifest(engine, manifest);
          // If we already satisfy ensure, return partial; otherwise surface.
          if (!wantComplete && filteredItems(manifest.items, filter).length >= ensure) {
            return toCatalog(manifest, filter);
          }
          throw err;
        }
      }
      if (!progressed) break;
    }

    await saveManifest(engine, manifest);
        return toCatalog(manifest, filter);
      },
    ),
  );
}

/** Returns a bounded, cursor-resumable page over progressive catalog discovery. */
export async function channelCatalogPage(
  engine: Engine,
  input: string,
  opts: ChannelCatalogPageOptions = {},
  signal?: AbortSignal,
): Promise<ChannelCatalogPage> {
  const cursor = Math.max(0, Math.trunc(opts.cursor ?? 0));
  const requestedLimit = Math.trunc(opts.limit ?? 0);
  const limit = requestedLimit <= 0 ? 50 : Math.min(200, requestedLimit);
  const catalog = await discoverChannelCatalog(
    engine,
    input,
    {
      contentType: opts.contentType ?? "all",
      ensure: cursor + limit + 25,
      refresh: opts.refresh === true && cursor === 0,
    },
    signal,
  );
  const end = Math.min(catalog.items.length, cursor + limit);
  const items = catalog.items.slice(cursor, end);
  const hasMore = end < catalog.items.length || !catalog.complete;
  return {
    ...catalog,
    items,
    cursor,
    nextCursor: hasMore ? end : undefined,
    hasMore,
    discoveredVideos: catalog.count,
  };
}
