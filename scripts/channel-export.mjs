#!/usr/bin/env node
/**
 * Full creator-channel crawl with live progress.
 *
 * Discovers every Videos / Shorts item, packs each one (metadata + transcript +
 * chapters + RAG chunks) into a resumable JSONL dataset, auto-enables the
 * headless browser when timedtext is IP-blocked, retries blocked videos, and
 * keeps going until the catalog is finished.
 *
 * Usage:
 *   node scripts/channel-export.mjs @mkbhd
 *   node scripts/channel-export.mjs https://www.youtube.com/@TED/videos --shorts
 *   CONTENT_TYPE=videos MAX_RETRY=5 node scripts/channel-export.mjs @handle
 *
 * Env:
 *   CONTENT_TYPE   all | videos | shorts (default all)
 *   LANG           caption lang chain (default en)
 *   JOB_ID         resume a prior export
 *   MAX_RETRY      retries per blocked video (default 3)
 *   RETRY_DELAY_MS wait between retries (default 5000)
 *   YTUBE_PROXY    clean egress when panel+timedtext are both blocked
 *   YTUBE_CACHE_DIR / YTUBE_EXPORT_DIR
 *
 * Progress lines go to stderr; the final JSON summary goes to stdout.
 */
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Prefer built dist; fall back to tsx source for local hackery.
let clientMod;
try {
  clientMod = await import(pathToFileURL(resolve(root, "dist/client.js")).href);
} catch {
  console.error("Build first: npm run build");
  process.exit(1);
}

const { YouTubeClient, defaultChannelExportLogger, YtubeError } = clientMod;

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const channel = args[0] || process.env.CHANNEL || "";
if (!channel) {
  console.error("Usage: node scripts/channel-export.mjs <@handle|channel-url|UC…>");
  process.exit(2);
}

let contentType = (process.env.CONTENT_TYPE || "all").toLowerCase();
if (flags.has("--shorts")) contentType = "shorts";
if (flags.has("--videos")) contentType = "videos";
if (flags.has("--all")) contentType = "all";
if (!["all", "videos", "shorts"].includes(contentType)) contentType = "all";

const maxRetry = Number.parseInt(process.env.MAX_RETRY || "3", 10);
const retryDelayMs = Number.parseInt(process.env.RETRY_DELAY_MS || "5000", 10);
const lang = process.env.LANG || "en";
const jobId = process.env.JOB_ID || undefined;

console.error(`=== Channel export ${channel} contentType=${contentType} untilDone autoBrowser ===\n`);

const yt = new YouTubeClient({ timeoutMs: 24 * 60 * 60 * 1000, lang });
try {
  const result = await yt.exportChannelAnalysis(channel, {
    contentType,
    lang,
    jobId,
    autoBrowser: true,
    untilDone: true,
    maxRetryRounds: Number.isFinite(maxRetry) && maxRetry > 0 ? maxRetry : 3,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 5000,
    onProgress: defaultChannelExportLogger,
  });

  console.error("");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "completed" ? 0 : 2);
} catch (err) {
  if (err instanceof YtubeError) {
    console.error(`FAIL  ${err.info.code}: ${err.info.message}`);
    if (err.info.details?.recovery) {
      console.error(JSON.stringify(err.info.details.recovery, null, 2));
    }
  } else {
    console.error("FAIL ", err instanceof Error ? err.message : err);
  }
  process.exit(1);
}
