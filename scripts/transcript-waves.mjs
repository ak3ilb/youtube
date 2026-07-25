#!/usr/bin/env node
/**
 * Multi-video, multi-wave transcript stress test.
 * Waves wait between rounds so a temporary YouTube 429 can clear.
 *
 * Env:
 *   WAVES          — number of rounds (default 4)
 *   WAVE_WAIT_SEC  — seconds between waves (default 120)
 *   FRESH_CACHE    — if 1, use a temp cache dir (no prior seeds)
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YouTubeClient, YtubeError } from "../dist/client.js";
import {
  clearTimedtextCooldown,
  isTimedtextCoolingDown,
  timedtextCooldownRemainingSec,
} from "../dist/engine/timedtext-gate.js";

const WAVES = Number(process.env.WAVES ?? 4);
const WAVE_WAIT_SEC = Number(process.env.WAVE_WAIT_SEC ?? 120);
const FRESH = process.env.FRESH_CACHE === "1";

const VIDEOS = [
  { id: "jNQXAC9IVRw", label: "Me at the zoo (short classic)", expect: /elephant|trunk|cool/i },
  { id: "dQw4w9WgXcQ", label: "Never Gonna Give You Up (long music)", expect: /never|gonna|give|up|hurt/i },
  { id: "aqz-KE-bpKQ", label: "Big Buck Bunny (long)", expect: /./ },
  { id: "kJQP7kiw5Fk", label: "Despacito (long music)", expect: /./ },
  { id: "9bZkp7q19f0", label: "Gangnam Style (long music)", expect: /./ },
  { id: "LXb3EKWsInQ", label: "Costa Rica 4K (long scenic)", expect: /./ },
  // Shorts-style / short IDs often used in the wild
  { id: "jNQXAC9IVRw", label: "zoo again (cache path)", expect: /elephant|trunk|cool|Alright/i },
];

if (FRESH) {
  const dir = join(tmpdir(), `yt-transcript-wave-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.YTUBE_CACHE_DIR = dir;
  console.log("FRESH_CACHE", dir);
} else {
  process.env.YTUBE_CACHE_DIR ??= join(process.cwd(), ".cache");
}

process.env.YTUBE_RATE_LIMIT ??= "0";
process.env.YTUBE_TIMEDTEXT_COOLDOWN ??= "5m";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yt = new YouTubeClient({ timeoutMs: 120_000 });

const summary = [];

async function testOne(video, wave) {
  const started = Date.now();
  const row = { wave, id: video.id, label: video.label, ok: false, mode: "?", detail: "" };
  try {
    clearTimedtextCooldown(); // allow a live attempt each video in a wave
    const tr = await yt.getTranscript(video.id, { lang: "en" });
    const text = tr.text || (tr.segments ?? []).map((s) => s.text).join(" ");
    const hasTs = Boolean(tr.segments?.[0]?.timestamp);
    const segs = tr.segmentCount ?? tr.segments?.length ?? 0;
    const matched = video.expect.test(text);
    row.ok = segs > 0 && hasTs && (matched || video.expect.source === "/./");
    row.mode = tr.stale ? "stale" : "live/cache";
    row.detail = `segs=${segs} source=${tr.source ?? "-"} lang=${tr.languageCode} stale=${!!tr.stale} ms=${Date.now() - started} sample="${text.slice(0, 60).replace(/\s+/g, " ")}"`;
    if (!hasTs) row.ok = false;
    if (segs < 1) row.ok = false;
  } catch (err) {
    const code = err instanceof YtubeError ? err.info.code : "UNEXPECTED";
    const msg = err instanceof Error ? err.message : String(err);
    row.ok = false;
    row.mode = "error";
    row.detail = `${code}: ${msg} ms=${Date.now() - started}`;
  }
  summary.push(row);
  console.log(`${row.ok ? "PASS" : "FAIL"}  [w${wave}] ${video.id} ${row.mode} — ${row.detail}`);
  await sleep(2500); // pace between videos
  return row;
}

async function advancedChecks(wave) {
  const id = "jNQXAC9IVRw";
  const checks = [];
  const run = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
      console.log(`PASS  [w${wave}:adv] ${name} — ${detail}`);
    } catch (e) {
      const detail = e instanceof YtubeError ? `${e.info.code}: ${e.info.message}` : String(e);
      checks.push({ name, ok: false, detail });
      console.log(`FAIL  [w${wave}:adv] ${name} — ${detail}`);
    }
    await sleep(1500);
  };

  await run("lang_chain", async () => {
    const tr = await yt.getTranscript(id, { lang: "xx,en" });
    if (!tr.segmentCount) throw new Error("empty");
    return `resolved=${tr.resolvedLang ?? tr.languageCode} segs=${tr.segmentCount}`;
  });
  await run("paging", async () => {
    const p = await yt.getTranscript(id, { lang: "en", maxChars: 80 });
    return `segs=${p.segmentCount} hasMore=${p.hasMore} next=${p.nextCursor}`;
  });
  await run("clip", async () => {
    const c = await yt.getTranscriptClip(id, "0:00", { end: "0:15", lang: "en" });
    if (!c.segmentCount) throw new Error("empty clip");
    return `segs=${c.segmentCount}`;
  });
  await run("search", async () => {
    const s = await yt.searchTranscript(id, "elephant", { lang: "en" });
    const n = s.matchCount ?? s.matches?.length ?? 0;
    return `hits=${n}`;
  });
  await run("words", async () => {
    const tr = await yt.getTranscript(id, { lang: "en", words: true });
    const n = (tr.segments ?? []).filter((s) => s.words?.length).length;
    return `segmentsWithWords=${n} segs=${tr.segmentCount}`;
  });
  await run("srt", async () => {
    const sub = await yt.exportSubtitles(id, { lang: "en", format: "srt" });
    if (!sub.content?.includes("-->")) throw new Error("bad srt");
    return `bytes=${sub.content.length}`;
  });
  await run("videopack", async () => {
    const pack = await yt.getVideoPack(id, { chunkChars: 200, lang: "en" });
    if (!pack.chunks?.length) throw new Error("no chunks");
    return `chunks=${pack.chunkCount}`;
  });
  await run("ask", async () => {
    const a = await yt.askVideo(id, "elephants trunks", { lang: "en", topK: 2 });
    return `matched=${a.matched}`;
  });
  await run("shorts_url", async () => {
    const tr = await yt.getTranscript(`https://www.youtube.com/shorts/${id}`, { lang: "en" });
    return `segs=${tr.segmentCount}`;
  });
  await run("youtu_be_url", async () => {
    const tr = await yt.getTranscript(`https://youtu.be/${id}`, { lang: "en" });
    return `segs=${tr.segmentCount}`;
  });

  return checks;
}

console.log(`=== Transcript multi-wave test waves=${WAVES} wait=${WAVE_WAIT_SEC}s cache=${process.env.YTUBE_CACHE_DIR} ===\n`);

for (let wave = 1; wave <= WAVES; wave++) {
  console.log(`\n--- Wave ${wave}/${WAVES} at ${new Date().toISOString()} cooldown=${isTimedtextCoolingDown()} rem=${timedtextCooldownRemainingSec()}s ---\n`);
  clearTimedtextCooldown();

  const unique = [];
  const seen = new Set();
  for (const v of VIDEOS) {
    if (seen.has(v.id) && v.label.includes("again")) {
      unique.push(v); // keep intentional cache re-hit
      continue;
    }
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    unique.push(v);
  }
  // Always include the "again" pass at end of unique list if present
  for (const v of VIDEOS.filter((x) => x.label.includes("again"))) unique.push(v);

  for (const v of unique) {
    await testOne(v, wave);
  }
  const adv = await advancedChecks(wave);
  summary.push(...adv.map((c) => ({ wave, id: "advanced", label: c.name, ok: c.ok, mode: "adv", detail: c.detail })));

  if (wave < WAVES) {
    console.log(`\n… waiting ${WAVE_WAIT_SEC}s before next wave …\n`);
    await sleep(WAVE_WAIT_SEC * 1000);
  }
}

console.log("\n=== Summary ===");
const passed = summary.filter((r) => r.ok).length;
const failed = summary.filter((r) => !r.ok);
console.log(`${passed}/${summary.length} passed`);
const byMode = {};
for (const r of summary) {
  byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
}
console.log("modes:", byMode);
if (failed.length) {
  console.log("failures:");
  for (const f of failed) console.log(`  - [w${f.wave}] ${f.label}: ${f.detail}`);
}

if (FRESH && process.env.YTUBE_CACHE_DIR?.includes("yt-transcript-wave-")) {
  try {
    rmSync(process.env.YTUBE_CACHE_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

process.exit(failed.length ? 1 : 0);
