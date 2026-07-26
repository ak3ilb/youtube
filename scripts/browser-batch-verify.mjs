#!/usr/bin/env node
/**
 * Live stress check for the headless-browser transcript fallback across a
 * 20-30 video pack — the size real agents ask for.
 *
 * Proves three things at batch scale:
 *   1. success rate stays high when every video has to go through the browser,
 *   2. only one watch tab is ever open (no tab pile-up across 30 videos),
 *   3. Chromium and the job counter are clean when the run ends.
 *
 * Requires the optional Playwright peer dependency:
 *   npm i playwright && npx playwright install chromium
 *
 * Env:
 *   VERIFY_SOURCE / VERIFY_PLAYLIST — playlist or channel URL/ID to pack
 *   VERIFY_IDS       — comma list of video ids instead of a playlist
 *   VERIFY_LIMIT     — videos in this run (default 30)
 *   VERIFY_FORCE     — "cooldown" (default) arms the timedtext breaker so the
 *                      browser path runs for every video; "none" relies on
 *                      whatever the live network does
 *   VERIFY_MIN_RATE  — required success rate, 0-1 (default 0.9)
 *   VERIFY_CACHE_DIR — isolated cache dir (default .cache/browser-batch-verify)
 *   YTUBE_BROWSER_GAP_MS — pacing between browser jobs (default 750)
 *   YTUBE_PROXY      — optional clean egress
 *
 * Exit codes: 0 = pass, 2 = fail, 3 = Playwright not installed (skipped).
 */
// Always isolate from the developer's everyday cache (and from a leftover
// YTUBE_CACHE_DIR in the shell). Override with VERIFY_CACHE_DIR if needed.
process.env.YTUBE_CACHE_DIR =
  process.env.VERIFY_CACHE_DIR?.trim() ||
  new URL("../.cache/browser-batch-verify", import.meta.url).pathname;
// A 30-video analysis pack costs hundreds of requests; the default budget of 60
// would abort the run long before the browser path is stressed.
process.env.YTUBE_RATE_LIMIT = process.env.YTUBE_RATE_LIMIT ?? "0";
process.env.YTUBE_BROWSER = "1";

// Default source is a stable channel whose catalog is old enough to still serve
// the classic searchable transcript panel. Videos in YouTube's newer transcript
// UI reject the panel request in headless Chromium (400 "Precondition check
// failed"), which would measure YouTube's rollout instead of this batch path.
const SOURCE =
  process.env.VERIFY_IDS?.trim() ||
  process.env.VERIFY_SOURCE?.trim() ||
  process.env.VERIFY_PLAYLIST?.trim() ||
  "https://www.youtube.com/@RickAstleyYT/videos";
const LIMIT = Number.parseInt(process.env.VERIFY_LIMIT || "30", 10);
const FORCE = (process.env.VERIFY_FORCE || "cooldown").toLowerCase();
const MIN_RATE = Number.parseFloat(process.env.VERIFY_MIN_RATE || "0.9");

const {
  isBrowserTranscriptAvailable,
  getBrowserJobStats,
  resetBrowserJobStats,
  closeBrowser,
} = await import("../dist/engine/browser-transcript.js");
const { markTimedtextRateLimited, clearTimedtextCooldown } = await import(
  "../dist/engine/timedtext-gate.js"
);
const { YouTubeClient, YtubeError } = await import("../dist/client.js");

let failures = 0;
function fail(msg) {
  console.log(`FAIL  ${msg}`);
  failures++;
  process.exitCode = 2;
}
function pass(msg) {
  console.log(`PASS  ${msg}`);
}
function info(msg) {
  console.log(`      ${msg}`);
}
const mb = (bytes) => Math.round(bytes / 1024 / 1024);

console.log(
  `=== Browser batch verify limit=${LIMIT} force=${FORCE} source=${SOURCE} ===\n`,
);

if (!(await isBrowserTranscriptAvailable())) {
  console.log(
    "SKIP  Playwright is not installed.\n" +
      "      Run: npm i playwright && npx playwright install chromium",
  );
  process.exit(3);
}

if (FORCE === "cooldown") {
  // Arm the timedtext breaker in this isolated cache dir so the Node caption
  // ladder is skipped and every video exercises the browser path.
  markTimedtextRateLimited();
  info("timedtext breaker armed — browser path forced for every video");
} else {
  clearTimedtextCooldown();
  info("no forcing — Node ladder runs first, browser only on live failures");
}

/**
 * Samples browser lifecycle counters during the run: per-job durations plus the
 * peak tab/job/RSS numbers the assertions below need.
 */
resetBrowserJobStats();
const jobMs = [];
let peakJobs = 0;
let peakTabs = 0;
let peakRss = process.memoryUsage().rss;
let seenJobs = 0;
const sampler = setInterval(() => {
  const s = getBrowserJobStats();
  if (s.activeJobs > peakJobs) peakJobs = s.activeJobs;
  if (s.openPages > peakTabs) peakTabs = s.openPages;
  if (s.completedJobs > seenJobs) {
    seenJobs = s.completedJobs;
    jobMs.push(s.lastJobMs);
  }
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
}, 200);
sampler.unref?.();

const startedAt = Date.now();
let pack = null;
try {
  const yt = new YouTubeClient({ timeoutMs: 60 * 60 * 1000 });
  pack = await yt.getBatchPack(SOURCE, {
    limit: LIMIT,
    detail: "analysis",
    includeChunks: false,
    contentType: "videos",
  });
} catch (err) {
  const code = err instanceof YtubeError ? err.info.code : "UNEXPECTED";
  fail(`pack threw ${code}: ${err instanceof Error ? err.message : String(err)}`);
  // Every video failed. Keep the rows so the report still explains why.
  const details = err instanceof YtubeError ? err.info.details : undefined;
  if (Array.isArray(details?.failures)) pack = { videos: [], failures: details.failures };
} finally {
  clearInterval(sampler);
}
const wallMs = Date.now() - startedAt;

if (pack !== null) {
  const items = pack.videos ?? [];
  const failed = pack.failures ?? [];
  const attempted = items.length + failed.length;
  const rate = attempted === 0 ? 0 : items.length / attempted;

  // Path breakdown: browser jobs are the ones carrying the fallback warning.
  let browserPath = 0;
  let cachePath = 0;
  let nodePath = 0;
  let emptyTranscripts = 0;
  for (const item of items) {
    const warnings = item.transcript?.warnings ?? [];
    if (item.cacheHit === true) cachePath++;
    else if (warnings.includes("browser_fallback")) browserPath++;
    else nodePath++;
    const segs = item.transcript?.segmentCount ?? item.chunkCount ?? 0;
    if (!(segs > 0)) emptyTranscripts++;
  }

  console.log("");
  info(`attempted=${attempted} packed=${items.length} failed=${failed.length}`);
  info(`paths — browser=${browserPath} cache=${cachePath} node=${nodePath}`);
  info(
    `browser jobs=${jobMs.length} median=${median(jobMs)}ms max=${
      jobMs.length > 0 ? Math.max(...jobMs) : 0
    }ms`,
  );
  info(
    `wall=${(wallMs / 1000).toFixed(1)}s (${
      attempted > 0 ? Math.round(wallMs / attempted) : 0
    }ms/video) peakRSS=${mb(peakRss)}MB`,
  );
  if (failed.length > 0) {
    const byCode = new Map();
    for (const f of failed) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
    info(
      "failure codes — " +
        [...byCode].map(([code, n]) => `${code}×${n}`).join(", "),
    );
  }
  console.log("");

  if (attempted < Math.min(LIMIT, 20)) {
    fail(`only ${attempted} videos attempted; need at least ${Math.min(LIMIT, 20)}`);
  } else {
    pass(`attempted ${attempted} videos in one pack (max limit now 50)`);
  }

  // IP_BLOCKED / RATE_LIMITED after the browser also failed means this egress is
  // Sorry-blocked end to end — retryable, not a defect in the batch path.
  const blocked = failed.filter(
    (f) => f.code === "IP_BLOCKED" || f.code === "RATE_LIMITED",
  ).length;
  if (rate >= MIN_RATE) {
    pass(`success rate ${(rate * 100).toFixed(0)}% ≥ ${(MIN_RATE * 100).toFixed(0)}%`);
  } else if (blocked === failed.length && blocked > 0) {
    info(
      `SOFT  success rate ${(rate * 100).toFixed(0)}% — all ${blocked} failures are ` +
        "IP_BLOCKED/RATE_LIMITED (egress blocked end to end); retry from a clean IP or set YTUBE_PROXY",
    );
  } else {
    fail(`success rate ${(rate * 100).toFixed(0)}% < ${(MIN_RATE * 100).toFixed(0)}%`);
  }

  if (emptyTranscripts > 0) fail(`${emptyTranscripts} packed videos have no segments`);
  else if (items.length > 0) pass("every packed video has transcript segments");

  if (FORCE === "cooldown" && items.length > 0 && browserPath + cachePath === 0) {
    fail("browser path never ran despite the armed breaker");
  }
}

// Browser hygiene — the whole point of the one-tab queue.
if (peakTabs > 1) fail(`opened ${peakTabs} watch tabs at once; expected 1`);
else pass(`never more than ${Math.max(peakTabs, 1)} watch tab open at a time`);

if (peakJobs > 1) fail(`${peakJobs} browser jobs ran concurrently; expected serialized`);
else pass("browser jobs stayed serialized");

const afterPack = getBrowserJobStats();
if (afterPack.activeJobs !== 0) fail(`activeJobs=${afterPack.activeJobs} after pack`);
else pass("activeJobs back to 0 after pack");
if (afterPack.hasContext) {
  info("Chromium intentionally left warm after the pack (idle shutdown handles it)");
}

await closeBrowser();
const afterClose = getBrowserJobStats();
if (afterClose.hasContext || afterClose.openPages !== 0) {
  fail(
    `Chromium not fully torn down (hasContext=${afterClose.hasContext} openPages=${afterClose.openPages})`,
  );
} else {
  pass("Chromium closed cleanly");
}

if (FORCE === "cooldown") clearTimedtextCooldown();

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

console.log(
  failures > 0
    ? "\n=== Browser batch verify FAILED ==="
    : "\n=== Browser batch verify PASSED ===",
);
