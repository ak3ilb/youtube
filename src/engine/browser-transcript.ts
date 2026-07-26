/**
 * Optional browser-backed transcript fallback.
 *
 * When Node's `/api/timedtext` GETs are IP-blocked (HTTP 429 "Sorry..." pages),
 * a real browser can still read captions because the request is issued
 * *same-origin from inside the watch page* — it inherits the browser's cookies,
 * visitor data, PoToken binding, and residential IP instead of the datacenter
 * egress that YouTube throttled.
 *
 * This module mirrors that flow with Playwright:
 *   1. open https://www.youtube.com/watch?v=ID (always headless, tiny footprint),
 *   2. read `ytInitialPlayerResponse` for the same caption tracks InnerTube sees,
 *   3. `fetch(baseUrl)` for the caption body from *inside the page*,
 *   4. hand the raw json3 / srv1 / srv3 body back to the shared parsers.
 *
 * Playwright is an OPTIONAL peer dependency. If it is not installed the caller
 * gets a clear `BROWSER_REQUIRED` error instead of a crash. The default
 * install of `youtube-client-mcp` stays light — nothing here loads unless the
 * fallback is actually triggered.
 */
import { join } from "node:path";

import { ExtractError } from "./errors.js";
import { resolveProxyUrl } from "./proxy.js";
import { defaultCacheDir } from "./cache.js";
import type { CaptionTrack, TranscriptSegment, TranscriptSource } from "./types.js";

// These helpers are pure (no network) and safe to import despite the
// transcript.ts <-> browser-transcript.ts cycle: they are only called at
// runtime, never at module load.
import {
  captionsFromPlayer,
  parseJSON3,
  parseTimedTextXML,
  pickCaptionTrack,
  trackBaseUrl,
  withFormat,
  withTranscriptLang,
  type PlayerResponse,
} from "./transcript.js";

/** Minimal structural typing over the parts of Playwright we use. */
interface PWContext {
  newPage(): Promise<PWPage>;
  pages?(): PWPage[];
  addCookies(cookies: PWCookie[]): Promise<void>;
  addInitScript(script: () => void): Promise<void>;
  route(url: string, handler: (route: PWRoute) => void): Promise<void>;
  close(): Promise<void>;
}
interface PWPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: (arg: unknown) => T | Promise<T>, arg?: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
  on(event: "response", handler: (res: PWResponse) => void): void;
  off?(event: "response", handler: (res: PWResponse) => void): void;
  getByRole?(
    role: string,
    opts?: { name?: RegExp | string },
  ): { first(): { click(opts?: { timeout?: number }): Promise<void>; count(): Promise<number> }; count(): Promise<number> };
  locator?(
    selector: string,
  ): { first(): { click(opts?: { timeout?: number }): Promise<void>; count(): Promise<number> } };
}
interface PWResponse {
  url(): string;
  status(): number;
  text(): Promise<string>;
}
interface PWRoute {
  request(): { resourceType(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}
interface PWCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}
interface PlaywrightModule {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      opts: Record<string, unknown>,
    ): Promise<PWContext>;
  };
}

/** Result of a successful browser caption fetch, ready for `buildTranscript`. */
export interface BrowserCaptionResult {
  segments: TranscriptSegment[];
  track: CaptionTrack;
  translatedFrom: string;
  source: TranscriptSource;
  resolvedLang: string;
  warnings: string[];
}

/** Subset of transcript options the browser path understands. */
export interface BrowserTranscriptOptions {
  lang?: string;
  strict?: boolean;
  words?: boolean;
  translateTo?: string;
}

const WATCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PLAYER_WAIT_MS = 20_000;
const IDLE_SHUTDOWN_MS = 60_000;
/** Default pause between browser jobs so a 30-video batch does not look bursty. */
const DEFAULT_GAP_MS = 750;

let cachedModule: PlaywrightModule | null | undefined;
let contextPromise: Promise<PWContext> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** In-flight browser transcript jobs — idle shutdown only when this hits 0. */
let activeJobs = 0;
/** Highest simultaneous job count seen; batch tests assert this stays at 1. */
let peakActiveJobs = 0;
/** Finished browser jobs this process (success or failure), for stress reporting. */
let completedJobs = 0;
/** Wall-clock ms of the last finished job, for stress reporting. */
let lastJobMs = 0;
/**
 * Serializes page work so a playlist/channel batch never opens many tabs at
 * once (one watch page at a time, closed before the next video starts).
 */
let pageQueue: Promise<unknown> = Promise.resolve();
/** Timestamp the previous job finished, used to pace successive navigations. */
let lastJobFinishedAt = 0;

/** Pause between browser jobs; `YTUBE_BROWSER_GAP_MS=0` disables pacing. */
function browserGapMs(): number {
  const raw = (process.env.YTUBE_BROWSER_GAP_MS ?? "").trim();
  if (raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_GAP_MS;
}

/**
 * Waits out the remainder of the configured gap since the previous job so back
 * to back watch/get_panel loads in a large batch stay spaced apart.
 */
async function pacePreviousJob(signal?: AbortSignal): Promise<void> {
  const gap = browserGapMs();
  if (gap <= 0 || lastJobFinishedAt === 0) return;
  const wait = gap - (Date.now() - lastJobFinishedAt);
  if (wait <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, wait);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Live browser lifecycle counters — used by batch stress verification. */
export interface BrowserJobStats {
  activeJobs: number;
  peakActiveJobs: number;
  completedJobs: number;
  lastJobMs: number;
  hasContext: boolean;
  openPages: number;
}

/** Snapshot of browser job/tab state. Safe to call when Playwright is absent. */
export function getBrowserJobStats(): BrowserJobStats {
  return {
    activeJobs,
    peakActiveJobs,
    completedJobs,
    lastJobMs,
    hasContext: contextPromise !== null,
    openPages: openPageCount,
  };
}

/** Resets the counters (not the browser) so a test run starts from zero. */
export function resetBrowserJobStats(): void {
  peakActiveJobs = activeJobs;
  completedJobs = 0;
  lastJobMs = 0;
}

/** Tabs this module currently has open; asserted to never exceed 1. */
let openPageCount = 0;
/** Highest simultaneous tab count seen this process. */
let peakOpenPages = 0;

/** Peak number of watch tabs open at once. */
export function getPeakOpenPages(): number {
  return peakOpenPages;
}

/** Reports whether `YTUBE_BROWSER=1` or an explicit `browser: true` opt is set. */
export function browserTranscriptEnabled(opts: { browser?: boolean }): boolean {
  if (opts.browser === true) return true;
  const env = (process.env.YTUBE_BROWSER ?? "").trim().toLowerCase();
  return env === "1" || env === "true" || env === "on" || env === "yes";
}

/** True when Playwright can be imported in this environment. */
export async function isBrowserTranscriptAvailable(): Promise<boolean> {
  return (await loadPlaywright(false)) !== null;
}

async function loadPlaywright(strict: boolean): Promise<PlaywrightModule | null> {
  if (cachedModule !== undefined) {
    if (cachedModule === null && strict) throw browserRequired();
    return cachedModule;
  }
  try {
    // Non-literal specifier keeps `tsc` from resolving the optional dependency
    // at build time (Playwright may not be installed).
    const specifier = "playwright";
    const mod = (await import(specifier)) as PlaywrightModule;
    cachedModule = mod && mod.chromium ? mod : null;
  } catch {
    cachedModule = null;
  }
  if (cachedModule === null && strict) throw browserRequired();
  return cachedModule;
}

function browserRequired(): ExtractError {
  return new ExtractError({
    code: "BROWSER_REQUIRED",
    message:
      "Browser transcript fallback needs Playwright, which is not installed. " +
      "Run: npm i playwright && npx playwright install chromium " +
      "(Playwright is an optional peer dependency; the fallback only runs when YTUBE_BROWSER=1 or { browser: true }).",
    retryable: false,
    details: { install: "npm i playwright && npx playwright install chromium" },
  });
}

function profileDir(): string {
  return join(defaultCacheDir(), "browser-profile");
}

function cancelIdleClose(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleClose(): void {
  // Never shut down while a batch video (or any job) is still using the browser.
  if (activeJobs > 0) return;
  cancelIdleClose();
  idleTimer = setTimeout(() => {
    if (activeJobs > 0) return;
    void closeBrowser();
  }, IDLE_SHUTDOWN_MS);
  // Do not keep the Node process alive just for the idle timer.
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

/** Close leftover tabs (persistent contexts often start with an about:blank). */
async function closeExtraPages(ctx: PWContext, keep?: PWPage): Promise<void> {
  if (typeof ctx.pages !== "function") return;
  for (const p of ctx.pages()) {
    if (keep && p === keep) continue;
    try {
      await p.close();
    } catch {
      // ignore
    }
  }
}

/** Launches (or reuses) one always-headless, small-footprint Chromium context. */
async function getContext(): Promise<PWContext> {
  cancelIdleClose();
  const pw = await loadPlaywright(true);
  if (pw === null) throw browserRequired();
  if (contextPromise !== null) return contextPromise;

  const launch = (async (): Promise<PWContext> => {
    const proxy = resolveProxyUrl();
    const args = [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      // Reduce headless fingerprints — Cursor's full browser can load the
      // transcript panel on IPs where bare headless Chromium cannot.
      "--disable-blink-features=AutomationControlled",
    ];
    const opts: Record<string, unknown> = {
      headless: true, // always headless — never open a visible window
      args,
      // Match a real watch-page layout so the engagement / transcript panel mounts.
      viewport: { width: 1280, height: 900 },
      userAgent: WATCH_UA,
      locale: "en-US",
      ...(proxy !== "" ? { proxy: { server: proxy } } : {}),
    };
    const ctx = await pw.chromium.launchPersistentContext(profileDir(), opts);
    // Bypass the EU consent interstitial so navigation lands on the watch page.
    await ctx.addCookies([
      { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/" },
      { name: "CONSENT", value: "YES+1", domain: ".youtube.com", path: "/" },
    ]);
    // Soften Playwright's default automation markers before any page loads.
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    // Keep footprint small: skip images/media/fonts. Keep stylesheets — YouTube's
    // Polymer transcript panel does not populate without CSS (verified against
    // Cursor's browser, where Show transcript works and returns full cues).
    await ctx.route("**/*", (route: PWRoute) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") {
        void route.abort();
      } else {
        void route.continue();
      }
    });
    // Persistent contexts often open with a blank starter tab — drop it.
    await closeExtraPages(ctx);
    return ctx;
  })();

  contextPromise = launch.catch((err) => {
    contextPromise = null;
    throw err;
  });
  return contextPromise;
}

/**
 * Closes the shared browser context and cancels the idle timer.
 * Safe to call after a batch/export finishes to free RAM immediately.
 */
export async function closeBrowser(): Promise<void> {
  cancelIdleClose();
  const pending = contextPromise;
  contextPromise = null;
  if (pending === null) return;
  try {
    const ctx = await pending;
    await closeExtraPages(ctx);
    await ctx.close();
  } catch {
    // best-effort teardown
  }
}

/** Close Chromium when the browser fallback is enabled (batch/export cleanup). */
export async function releaseBrowserIfEnabled(): Promise<void> {
  if (!browserTranscriptEnabled({})) return;
  await closeBrowser();
}

interface RawPlayer {
  videoId?: string;
  status?: string;
  reason?: string;
  player?: PlayerResponse;
}

/** Polls for `ytInitialPlayerResponse`, falling back to an HTML regex scrape. */
async function readPlayerResponse(page: PWPage, videoId: string): Promise<RawPlayer> {
  const deadline = Date.now() + PLAYER_WAIT_MS;
  while (Date.now() < deadline) {
    const raw = await page.evaluate<RawPlayer | null>(() => {
      const w = window as unknown as { ytInitialPlayerResponse?: PlayerResponse };
      const pr = w.ytInitialPlayerResponse;
      if (!pr) return null;
      return {
        videoId: pr.videoDetails?.videoId,
        status: pr.playabilityStatus?.status,
        reason: pr.playabilityStatus?.reason,
        player: pr,
      };
    });
    if (raw && raw.player) return raw;
    await page.waitForTimeout(500);
  }
  // Fallback: some responses embed the JSON in the HTML before hydration.
  const html = await page.content();
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script>)/s);
  if (match && match[1]) {
    try {
      const pr = JSON.parse(match[1]) as PlayerResponse;
      return {
        videoId: pr.videoDetails?.videoId,
        status: pr.playabilityStatus?.status,
        reason: pr.playabilityStatus?.reason,
        player: pr,
      };
    } catch {
      // fall through to the not-found error below
    }
  }
  throw new ExtractError({
    code: "BROWSER_PLAYER_TIMEOUT",
    message: `The watch page did not expose a player response for ${videoId} within ${PLAYER_WAIT_MS / 1000}s`,
    retryable: true,
  });
}

/** Runs a same-origin `fetch` inside the page and returns the raw body. */
async function pageFetch(page: PWPage, url: string): Promise<{ status: number; body: string }> {
  return page.evaluate<{ status: number; body: string }>(async (u) => {
    try {
      const res = await fetch(u as string, { credentials: "include" });
      const body = await res.text();
      return { status: res.status, body };
    } catch {
      return { status: 0, body: "" };
    }
  }, url);
}

type FetchVerdict = "ok" | "blocked" | "empty";

function classifyFetch(status: number, body: string): FetchVerdict {
  if (status === 429 || status === 503) return "blocked";
  const head = body.slice(0, 400).toLowerCase();
  if (head.includes("<title>sorry") || head.includes("unusual traffic")) return "blocked";
  if (status !== 200) return "empty";
  if (body.length === 0) return "empty";
  if (head.startsWith("<html") || head.startsWith("<!doctype")) return "blocked";
  return "ok";
}

/**
 * Fetches caption segments for `videoId` through a real headless browser.
 * Independent of Node's timedtext egress — this is the IP-block escape hatch.
 *
 * Batch-safe: jobs are serialized (one tab at a time), each tab is closed in
 * `finally`, and Chromium only idles-shuts-down when no jobs remain.
 */
export async function fetchCaptionSegmentsViaBrowser(
  videoId: string,
  opts: BrowserTranscriptOptions,
  signal?: AbortSignal,
): Promise<BrowserCaptionResult> {
  const run = async (): Promise<BrowserCaptionResult> => {
    activeJobs++;
    if (activeJobs > peakActiveJobs) peakActiveJobs = activeJobs;
    cancelIdleClose();
    const startedAt = Date.now();
    try {
      await pacePreviousJob(signal);
      const ctx = await getContext();
      const page = await ctx.newPage();
      openPageCount++;
      if (openPageCount > peakOpenPages) peakOpenPages = openPageCount;
      try {
        return await fetchCaptionSegmentsViaBrowserOnPage(ctx, page, videoId, opts, signal);
      } finally {
        try {
          await page.close();
        } catch {
          // ignore
        }
        openPageCount = Math.max(0, openPageCount - 1);
        // Drop any stray tabs left by Playwright (about:blank, popups).
        await closeExtraPages(ctx);
      }
    } finally {
      // Outside the page try/finally so a launch failure still releases the
      // job slot — otherwise idle shutdown would never fire again.
      activeJobs = Math.max(0, activeJobs - 1);
      completedJobs++;
      lastJobMs = Date.now() - startedAt;
      lastJobFinishedAt = Date.now();
      scheduleIdleClose();
    }
  };

  // Serialize so playlist/channel batches never pile up watch tabs.
  const done = pageQueue.then(run, run);
  pageQueue = done.then(
    () => undefined,
    () => undefined,
  );
  return done;
}

async function fetchCaptionSegmentsViaBrowserOnPage(
  _ctx: PWContext,
  page: PWPage,
  videoId: string,
  opts: BrowserTranscriptOptions,
  signal?: AbortSignal,
): Promise<BrowserCaptionResult> {
  if (signal?.aborted) throw new ExtractError({ code: "ABORTED", message: "aborted" });
  await page.goto(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    waitUntil: "domcontentloaded",
    timeout: PLAYER_WAIT_MS,
  });

  const raw = await readPlayerResponse(page, videoId);
  const status = (raw.status ?? "").toUpperCase();
  if (status === "LOGIN_REQUIRED" || status === "AGE_CHECK_REQUIRED" || status === "CONTENT_CHECK_REQUIRED") {
    throw new ExtractError({
      code: "AUTH_REQUIRED",
      message: `This video requires sign-in or age verification (${status})`,
      details: { reason: raw.reason },
    });
  }
  if (status === "ERROR" || status === "UNPLAYABLE") {
    throw new ExtractError({
      code: "VIDEO_UNAVAILABLE",
      message: raw.reason || "YouTube reported this video is unavailable",
      details: { reason: raw.reason },
    });
  }
  if (raw.videoId && raw.videoId !== videoId) {
    throw new ExtractError({
      code: "BROWSER_VIDEO_MISMATCH",
      message: `Watch page loaded ${raw.videoId} instead of ${videoId}`,
      retryable: true,
    });
  }

  const tracks = captionsFromPlayer(raw.player!);
  if (tracks.length === 0) {
    throw new ExtractError({
      code: "NO_CAPTIONS",
      message: "This video has no caption tracks (the uploader disabled them or none were generated)",
    });
  }

  // Resolve the track + timedtext URL exactly like the network path.
  let baseUrl: string;
  let picked: CaptionTrack;
  let translatedFrom = "";
  let source: TranscriptSource;
  let resolvedLang: string;
  const warnings: string[] = ["browser_fallback"];

  if (opts.translateTo) {
    const base = tracks.find((t) => t.isTranslatable) ?? tracks[0]!;
    if (!base.isTranslatable) {
      throw new ExtractError({
        code: "TRANSLATION_UNAVAILABLE",
        message: "No translatable caption track available for this video",
      });
    }
    baseUrl = withTranscriptLang(trackBaseUrl(base), opts.translateTo);
    picked = { ...base, languageCode: opts.translateTo, isAutoGenerated: true };
    translatedFrom = base.languageCode;
    source = "translated";
    resolvedLang = opts.translateTo;
  } else {
    const result = pickCaptionTrack(tracks, opts.lang, opts.strict === true);
    picked = result.track;
    baseUrl = result.captionUrl;
    translatedFrom = result.translatedFrom;
    source = result.source;
    resolvedLang = result.resolvedLang;
    warnings.push(...result.warnings);
  }

  // Stage D: same-origin timedtext fetch (fast, keeps word timings).
  // Stage E: Show transcript panel — Cursor browser verified this succeeds
  // even when timedtext returns HTTP 429 "Sorry..." on the same IP.
  const body = await fetchTrackBody(page, baseUrl, opts.words === true);
  if (body.segments.length > 0) {
    return { segments: body.segments, track: picked, translatedFrom, source, resolvedLang, warnings };
  }

  const panel = await scrapeTranscriptPanel(page);
  if (panel.length > 0) {
    return {
      segments: panel,
      track: picked,
      translatedFrom,
      source,
      resolvedLang,
      warnings: [...warnings, "browser_panel_fallback"],
    };
  }

  // Nothing worked. If timedtext was Sorry-blocked and the panel never
  // populated, set a clean proxy (the headless browser honors YTUBE_PROXY).
  if (body.blocked) {
    throw new ExtractError({
      code: "IP_BLOCKED",
      message:
        "YouTube blocked timedtext from this IP (HTTP 429 Sorry page) and the Show transcript " +
        "panel did not populate in headless mode. Set YTUBE_PROXY / HTTPS_PROXY to a clean " +
        "(residential) egress — the headless browser routes through it. " +
        "Note: a full Cursor/Chrome session can still show the panel when get_transcript works.",
      retryable: true,
      details: { hint: "YTUBE_PROXY=http://user:pass@host:port" },
    });
  }
  throw new ExtractError({
    code: "EMPTY_TRANSCRIPT",
    message: "The browser reached the caption track but it contained no cues",
    retryable: true,
  });
}

/** json3 first, then srv1/srv3 — mirrors `fetchCaptionSegments`, all in-page. */
async function fetchTrackBody(
  page: PWPage,
  baseUrl: string,
  wantWords: boolean,
): Promise<{ segments: TranscriptSegment[]; blocked: boolean }> {
  let blocked = false;

  const json3 = await pageFetch(page, withFormat(baseUrl, "json3"));
  const json3Verdict = classifyFetch(json3.status, json3.body);
  if (json3Verdict === "blocked") blocked = true;
  if (json3Verdict === "ok") {
    try {
      const segs = parseJSON3(json3.body, wantWords);
      if (segs.length > 0) return { segments: segs, blocked };
    } catch {
      // fall through to the XML formats
    }
  }

  for (const format of ["srv1", "srv3"]) {
    const xml = await pageFetch(page, withFormat(baseUrl, format));
    const verdict = classifyFetch(xml.status, xml.body);
    if (verdict === "blocked") blocked = true;
    if (verdict !== "ok") continue;
    try {
      const segs = parseTimedTextXML(xml.body);
      if (segs.length > 0) return { segments: segs, blocked };
    } catch {
      // try the next format
    }
  }

  return { segments: [], blocked };
}

const PANEL_WAIT_MS = 20_000;

/**
 * Opens "Show transcript" and harvests cues from the `get_panel` /
 * `get_transcript` network response (Cursor browser verified path).
 *
 * Modern YouTube returns cues as `transcriptSegmentViewModel` inside
 * `youtubei/v1/get_panel`. The Polymer DOM may stay empty in headless
 * Chromium even when that JSON already has every lyric — so we parse the
 * network body first, then fall back to DOM / aria-label scrape.
 */
async function scrapeTranscriptPanel(page: PWPage): Promise<TranscriptSegment[]> {
  const capturedBodies: string[] = [];
  /** Panel requests YouTube itself rejected (400 "Precondition check failed", 429, …). */
  let rejected = 0;
  const onResponse = (res: PWResponse): void => {
    const u = res.url();
    if (!u.includes("get_panel") && !u.includes("get_transcript")) return;
    void res
      .text()
      .then((text) => {
        if (text.length === 0) return;
        if (isPanelErrorBody(text)) rejected++;
        else capturedBodies.push(text);
      })
      .catch(() => {
        // ignore body read failures
      });
  };
  page.on("response", onResponse);

  try {
    await page.evaluate(() => {
      window.scrollTo(0, 600);
    });
    await page.waitForTimeout(600);

    if (page.locator) {
      try {
        await page.locator("#expand").first().click({ timeout: 3000 });
      } catch {
        // description already expanded
      }
    } else {
      await page.evaluate(() => {
        const expand = document.querySelector("#expand") as HTMLElement | null;
        if (expand) expand.click();
      });
    }
    await page.waitForTimeout(500);

    const deadline = Date.now() + PANEL_WAIT_MS;
    // Two attempts: YouTube sometimes serves the panel on a reopen, but when it
    // rejects the panel request outright a third click will not change that.
    for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
      if (attempt > 0) {
        rejected = 0;
        await closeTranscriptPanel(page);
        await page.waitForTimeout(800);
      }
      if (!(await clickShowTranscript(page))) return [];

      while (Date.now() < deadline) {
        for (const body of capturedBodies) {
          const segs = parsePanelJson(body);
          if (segs.length > 0) return segs;
        }
        const domRows = await page.evaluate<Array<{ ts: string; tx: string }>>(() => {
          const classic = Array.from(document.querySelectorAll("ytd-transcript-segment-renderer")).map(
            (n) => ({
              ts: (n.querySelector(".segment-timestamp")?.textContent ?? "").trim(),
              tx: (n.querySelector(".segment-text")?.textContent ?? "").replace(/\s+/g, " ").trim(),
            }),
          );
          if (classic.some((r) => r.tx !== "")) return classic;
          return [];
        });
        if (domRows.length > 0) return panelRowsToSegments(domRows);
        // Stop waiting the full window on a rejected panel request — in a
        // 30-video batch those stalls cost more than the batch itself.
        if (rejected > 0) break;
        await page.waitForTimeout(400);
      }
    }
  } catch {
    // Panel scraping is best-effort; fall back to the caller's error.
  } finally {
    page.off?.("response", onResponse);
  }
  return [];
}

/** True when a panel response is an InnerTube error envelope instead of cues. */
function isPanelErrorBody(text: string): boolean {
  if (text.includes("transcriptSegment")) return false;
  if (!text.includes('"error"')) return false;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: number } };
    return typeof parsed.error?.code === "number";
  } catch {
    return false;
  }
}

/** Clicks "Show transcript" via the accessibility tree, then via raw DOM. */
async function clickShowTranscript(page: PWPage): Promise<boolean> {
  if (page.getByRole) {
    try {
      const show = page.getByRole("button", { name: /show transcript/i });
      if ((await show.count()) > 0) {
        await show.first().click({ timeout: 5000 });
        return true;
      }
    } catch {
      // fall through to the DOM click
    }
  }
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("button, tp-yt-paper-button, ytd-button-renderer, yt-button-shape"),
    ) as HTMLElement[];
    const btn = nodes.find((b) => {
      const label = `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`;
      return /show transcript/i.test(label);
    });
    if (!btn) return false;
    (btn.closest("button") ?? btn).click();
    return true;
  });
}

/** Best-effort panel close so the next click re-requests the transcript. */
async function closeTranscriptPanel(page: PWPage): Promise<void> {
  try {
    await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("button, tp-yt-paper-button, ytd-button-renderer, yt-button-shape"),
      ) as HTMLElement[];
      const btn = nodes.find((b) =>
        /close transcript/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`),
      );
      if (btn) (btn.closest("button") ?? btn).click();
    });
  } catch {
    // ignore
  }
}

/** Walks a get_panel / get_transcript JSON body for modern or classic cue nodes. */
export function parsePanelJson(raw: string): TranscriptSegment[] {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows: Array<{ ts: string; tx: string }> = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const obj = node as Record<string, unknown>;

    // Modern UI: transcriptSegmentViewModel { simpleText, timestamp }
    const modern = obj.transcriptSegmentViewModel as
      | { simpleText?: string; timestamp?: string }
      | undefined;
    if (modern && typeof modern.simpleText === "string" && modern.simpleText.trim() !== "") {
      rows.push({
        ts: typeof modern.timestamp === "string" ? modern.timestamp : "0:00",
        tx: modern.simpleText.replace(/\s+/g, " ").trim(),
      });
    }

    // Classic UI: transcriptSegmentRenderer { snippet.runs[], startMs / startTimeText }
    const classic = obj.transcriptSegmentRenderer as
      | {
          snippet?: { runs?: Array<{ text?: string }> };
          startMs?: string;
          startTimeText?: { simpleText?: string };
        }
      | undefined;
    if (classic) {
      const tx = (classic.snippet?.runs ?? [])
        .map((r) => r.text ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (tx !== "") {
        let ts = classic.startTimeText?.simpleText ?? "";
        if (!ts && classic.startMs) {
          const ms = Number.parseInt(classic.startMs, 10);
          if (Number.isFinite(ms)) {
            const sec = Math.floor(ms / 1000);
            ts = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
          }
        }
        rows.push({ ts: ts || "0:00", tx });
      }
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  // DFS visit order is not timeline order — sort by timestamp.
  rows.sort((a, b) => parsePanelTimestamp(a.ts) - parsePanelTimestamp(b.ts));
  return panelRowsToSegments(rows);
}

/** Converts scraped `[timestamp, text]` rows into timed transcript segments. */
function panelRowsToSegments(rows: Array<{ ts: string; tx: string }>): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const row of rows) {
    if (row.tx === "") continue;
    const start = parsePanelTimestamp(row.ts);
    segments.push({
      text: row.tx,
      start,
      duration: 0,
      end: 0,
      timestamp: "",
      timestampEnd: "",
    });
  }
  // Infer each cue's duration from the next cue's start (last cue gets 2s).
  for (let i = 0; i < segments.length; i++) {
    const next = segments[i + 1];
    const cur = segments[i]!;
    cur.duration = next ? Math.max(next.start - cur.start, 0) : 2;
  }
  return segments;
}

/** Parses "M:SS" / "H:MM:SS" panel timestamps into seconds. */
function parsePanelTimestamp(ts: string): number {
  const parts = ts.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}
