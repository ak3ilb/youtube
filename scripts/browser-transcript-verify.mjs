#!/usr/bin/env node
/**
 * Live verification for the headless-browser transcript fallback.
 *
 * Proves that a captioned video yields a real transcript through the browser
 * path *without failing*, even when Node's timedtext egress is IP-blocked.
 *
 * Requires the optional Playwright peer dependency:
 *   npm i playwright && npx playwright install chromium
 *
 * Env:
 *   VERIFY_VIDEO    — video id (default: dQw4w9WgXcQ, known English captions)
 *   YTUBE_CACHE_DIR — cache dir (default: ./.cache)
 *   YTUBE_PROXY     — optional clean egress if your own IP is also blocked
 *
 * Exit codes: 0 = pass, 2 = fail, 3 = Playwright not installed (skipped).
 */
process.env.YTUBE_CACHE_DIR ??= new URL("../.cache", import.meta.url).pathname;
process.env.YTUBE_RATE_LIMIT ??= "0";
process.env.YTUBE_BROWSER = "1";

const VIDEO = process.env.VERIFY_VIDEO || "dQw4w9WgXcQ";

const {
  fetchCaptionSegmentsViaBrowser,
  isBrowserTranscriptAvailable,
  closeBrowser,
} = await import("../dist/engine/browser-transcript.js");
const { YouTubeClient, YtubeError } = await import("../dist/client.js");

function fail(msg) {
  console.log(`FAIL  ${msg}`);
  process.exitCode = 2;
}

console.log(`=== Browser transcript verify video=${VIDEO} ===\n`);

if (!(await isBrowserTranscriptAvailable())) {
  console.log(
    "SKIP  Playwright is not installed.\n" +
      "      Run: npm i playwright && npx playwright install chromium",
  );
  process.exit(3);
}

try {
  // 1. Direct browser path — independent of Node timedtext. This is the
  //    acceptance bar: captions must come back even if the Node ladder is blocked.
  const started = Date.now();
  const res = await fetchCaptionSegmentsViaBrowser(VIDEO, { lang: "en" });
  const text = res.segments.map((s) => s.text).join(" ");
  console.log(
    `PASS  browser fetch — ${res.segments.length} segments, lang=${res.resolvedLang}, ` +
      `source=${res.source} (${Date.now() - started}ms)`,
  );

  if (res.segments.length === 0) fail("browser returned zero segments");
  if (!(res.segments[0]?.start >= 0)) fail("first segment missing start time");
  if (text.length <= 100) fail(`transcript text too short (${text.length} chars)`);
  if (!res.warnings.includes("browser_fallback")) fail("missing browser_fallback warning");

  // 2. End-to-end client path with { browser: true }, then a cache hit.
  const yt = new YouTubeClient({ timeoutMs: 180_000 });
  const t1 = await yt.getTranscript(VIDEO, { lang: "en", browser: true });
  if (!(t1.segmentCount > 0)) fail("client getTranscript returned empty");
  console.log(`PASS  client transcript — ${t1.segmentCount} segments, source=${t1.source}`);

  const before = Date.now();
  const t2 = await yt.getTranscript(VIDEO, { lang: "en", browser: true });
  const cachedMs = Date.now() - before;
  if (t2.segmentCount !== t1.segmentCount) fail("second call disagreed with first");
  console.log(`PASS  cache hit — ${t2.segmentCount} segments in ${cachedMs}ms (no relaunch)`);
} catch (err) {
  const code = err instanceof YtubeError ? err.info.code : "UNEXPECTED";
  const msg = err instanceof Error ? err.message : String(err);
  fail(`${code}: ${msg}`);
} finally {
  await closeBrowser();
}

if (process.exitCode === 2) {
  console.log("\n=== Browser transcript verify FAILED ===");
} else {
  console.log("\n=== Browser transcript verify PASSED ===");
}
