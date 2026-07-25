#!/usr/bin/env node
/**
 * Transcript quality harness across many captioned videos + time waves.
 */
import { YouTubeClient, YtubeError } from "../dist/client.js";
import {
  clearTimedtextCooldown,
  isTimedtextCoolingDown,
  timedtextCooldownRemainingSec,
  markTimedtextRateLimited,
} from "../dist/engine/timedtext-gate.js";
import { join } from "node:path";

process.env.YTUBE_CACHE_DIR ??= join(process.cwd(), ".cache");
process.env.YTUBE_RATE_LIMIT ??= "0";
// Short cooldown so waves can retry; we still avoid hammering inside a wave.
process.env.YTUBE_TIMEDTEXT_COOLDOWN ??= "90s";

const WAVES = Number(process.env.WAVES ?? 3);
const WAVE_WAIT_SEC = Number(process.env.WAVE_WAIT_SEC ?? 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Videos known to ship English captions / ASR in practice. */
const VIDEOS = [
  { id: "jNQXAC9IVRw", label: "Me at the zoo (19s)", needle: /elephant|trunk/i },
  { id: "dQw4w9WgXcQ", label: "Rick Astley (3:33)", needle: /never|strangers|love|rules/i },
  { id: "kJQP7kiw5Fk", label: "Despacito", needle: /despacito|quiero|bailar|fuego|suave/i },
  { id: "9bZkp7q19f0", label: "Gangnam Style", needle: /oppan|gangnam|style|eh|sexy/i },
  { id: "fJ9rUzIMcZQ", label: "Bohemian Rhapsody", needle: /mama|galileo|queen|thunderbolt|easy/i },
  { id: "e-ORhEE9VVg", label: "Blank Space", needle: /blank|space|got|list|nightmare|smile/i },
  { id: "RgKAFK5djSk", label: "See You Again", needle: /see|again|friend|road|fast/i },
  { id: "OPf0YbXqDm0", label: "Uptown Funk", needle: /uptown|funk|don|hater|smoother/i },
  { id: "hT_nvWreIhg", label: "Counting Stars", needle: /counting|stars|soul|older|dream/i },
  { id: "YQHsXMglC9A", label: "Hello Adele", needle: /hello|from|other|side|million/i },
];

const yt = new YouTubeClient({ timeoutMs: 180_000 });
const rows = [];

async function listTracks(id) {
  try {
    const caps = await yt.listCaptions(id);
    return caps.count ?? caps.tracks?.length ?? 0;
  } catch {
    return -1;
  }
}

async function fetchTranscript(id, opts = {}) {
  clearTimedtextCooldown();
  return yt.getTranscript(id, { lang: "en", ...opts });
}

async function testVideo(video, wave) {
  const t0 = Date.now();
  const row = { wave, id: video.id, label: video.label, ok: false, detail: "" };
  try {
    const tracks = await listTracks(video.id);
    await sleep(800);
    if (tracks === 0) {
      row.detail = "NO_CAPTIONS (0 tracks)";
      rows.push(row);
      console.log(`SKIP  [w${wave}] ${video.id} — ${row.detail}`);
      return row;
    }
    const tr = await fetchTranscript(video.id);
    const text = tr.text || (tr.segments ?? []).map((s) => s.text).join(" ");
    const segs = tr.segmentCount ?? 0;
    const hasTs = Boolean(tr.segments?.[0]?.timestamp);
    const needleOk = !video.needle || video.needle.test(text);
    row.ok = segs >= 1 && hasTs && needleOk;
    row.detail = `tracks=${tracks} segs=${segs} source=${tr.source ?? "-"} stale=${!!tr.stale} needle=${needleOk} ms=${Date.now() - t0} sample="${text.slice(0, 70).replace(/\s+/g, " ")}"`;
  } catch (err) {
    const code = err instanceof YtubeError ? err.info.code : "UNEXPECTED";
    row.detail = `${code}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)} ms=${Date.now() - t0}`;
    if (code === "RATE_LIMITED") markTimedtextRateLimited(90);
  }
  rows.push(row);
  console.log(`${row.ok ? "PASS" : "FAIL"}  [w${wave}] ${video.id} — ${row.detail}`);
  await sleep(3000);
  return row;
}

async function featureBattery(wave) {
  const id = "jNQXAC9IVRw";
  const cases = [
    ["watch_url", () => yt.getTranscript(`https://www.youtube.com/watch?v=${id}`, { lang: "en" })],
    ["shorts_url", () => yt.getTranscript(`https://www.youtube.com/shorts/${id}`, { lang: "en" })],
    ["youtu_be", () => yt.getTranscript(`https://youtu.be/${id}`, { lang: "en" })],
    ["lang_chain", () => yt.getTranscript(id, { lang: "hi,en" })],
    ["words", () => yt.getTranscript(id, { lang: "en", words: true })],
    ["page", () => yt.getTranscript(id, { lang: "en", maxChars: 100 })],
    ["clip", () => yt.getTranscriptClip(id, "0:00", { end: "0:12", lang: "en" })],
    ["search", () => yt.searchTranscript(id, "elephant", { lang: "en" })],
    ["srt", () => yt.exportSubtitles(id, { lang: "en", format: "srt" })],
    ["vtt", () => yt.exportSubtitles(id, { lang: "en", format: "vtt" })],
    ["text", () => yt.exportSubtitles(id, { lang: "en", format: "text" })],
    ["pack", () => yt.getVideoPack(id, { lang: "en", chunkChars: 180 })],
    ["ask", () => yt.askVideo(id, "what about the elephants?", { lang: "en", topK: 2 })],
  ];
  for (const [name, fn] of cases) {
    const t0 = Date.now();
    try {
      const out = await fn();
      let detail = `ms=${Date.now() - t0}`;
      if (out.segmentCount != null) detail = `segs=${out.segmentCount} ` + detail;
      if (out.matchCount != null) detail = `hits=${out.matchCount} ` + detail;
      if (out.chunkCount != null) detail = `chunks=${out.chunkCount} ` + detail;
      if (out.matched != null) detail = `matched=${out.matched} ` + detail;
      if (out.format) detail = `format=${out.format} bytes=${out.content?.length ?? 0} ` + detail;
      if (out.words || (out.segments ?? []).some((s) => s.words?.length)) {
        const n = (out.segments ?? []).filter((s) => s.words?.length).length;
        detail = `wordSegs=${n} ` + detail;
      }
      const ok =
        (out.segmentCount ?? 0) > 0 ||
        (out.matchCount ?? 0) > 0 ||
        (out.chunkCount ?? 0) > 0 ||
        (out.matched ?? 0) > 0 ||
        (out.content?.length ?? 0) > 10;
      rows.push({ wave, id: "feature", label: name, ok, detail });
      console.log(`${ok ? "PASS" : "FAIL"}  [w${wave}:feat] ${name} — ${detail}`);
    } catch (err) {
      const detail = err instanceof YtubeError ? `${err.info.code}: ${err.info.message}` : String(err);
      rows.push({ wave, id: "feature", label: name, ok: false, detail });
      console.log(`FAIL  [w${wave}:feat] ${name} — ${detail}`);
    }
    await sleep(1200);
  }
}

console.log(`=== Transcript waves=${WAVES} wait=${WAVE_WAIT_SEC}s ===\n`);

for (let wave = 1; wave <= WAVES; wave++) {
  console.log(
    `\n--- Wave ${wave}/${WAVES} ${new Date().toISOString()} cooldown=${isTimedtextCoolingDown()} rem=${timedtextCooldownRemainingSec()}s ---\n`,
  );
  clearTimedtextCooldown();
  for (const v of VIDEOS) await testVideo(v, wave);
  await featureBattery(wave);
  if (wave < WAVES) {
    console.log(`\n… sleeping ${WAVE_WAIT_SEC}s …\n`);
    await sleep(WAVE_WAIT_SEC * 1000);
  }
}

const videoRows = rows.filter((r) => r.id !== "feature");
const featRows = rows.filter((r) => r.id === "feature");
const vPass = videoRows.filter((r) => r.ok).length;
const fPass = featRows.filter((r) => r.ok).length;
console.log("\n=== Summary ===");
console.log(`videos: ${vPass}/${videoRows.length}`);
console.log(`features: ${fPass}/${featRows.length}`);
const fails = rows.filter((r) => !r.ok);
if (fails.length) {
  console.log("failures:");
  for (const f of fails) console.log(`  - [w${f.wave}] ${f.label}: ${f.detail}`);
}
// Success criteria: at least 2 distinct videos OK in latest wave + all zoo feature battery
const lastWave = rows.filter((r) => r.wave === WAVES && r.id !== "feature");
const lastFeat = rows.filter((r) => r.wave === WAVES && r.id === "feature");
const videosOk = lastWave.filter((r) => r.ok).length;
const featsOk = lastFeat.filter((r) => r.ok).length;
const goodEnough = videosOk >= 2 && featsOk === lastFeat.length;
console.log(`latest wave: videosOk=${videosOk} featsOk=${featsOk}/${lastFeat.length} goodEnough=${goodEnough}`);
process.exit(goodEnough ? 0 : 1);
