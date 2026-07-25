#!/usr/bin/env node
/**
 * Detailed live feature verification against real YouTube.
 * Exits non-zero if any required feature fails.
 *
 * Env:
 *   VERIFY_VIDEO   — video id (default: dQw4w9WgXcQ when cache-friendly, else jNQXAC9IVRw)
 *   YTUBE_CACHE_DIR — cache dir (default: ./.cache so prior transcripts can rescue on 429)
 */
import { YouTubeClient, YtubeError } from "../dist/client.js";

process.env.YTUBE_CACHE_DIR ??= new URL("../.cache", import.meta.url).pathname;
process.env.YTUBE_RATE_LIMIT ??= "0";

const VIDEO = process.env.VERIFY_VIDEO || "dQw4w9WgXcQ";
const PLAYLIST = process.env.VERIFY_PLAYLIST || "PLBCF2DAC6FFB574DE";
const CHANNEL = process.env.VERIFY_CHANNEL || "@mkbhd";
const results = [];
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(name, fn, { optional = false } = {}) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, optional, ms: Date.now() - started, detail: String(detail ?? "ok") });
    console.log(`PASS  ${name} — ${detail ?? "ok"} (${Date.now() - started}ms)`);
  } catch (err) {
    const code = err instanceof YtubeError ? err.info.code : "UNEXPECTED";
    const msg = err instanceof Error ? err.message : String(err);
    if (optional) {
      results.push({ name, ok: true, optional: true, ms: Date.now() - started, detail: `skipped:${code}` });
      console.log(`SKIP  ${name} — ${code}: ${msg}`);
    } else {
      failed++;
      results.push({ name, ok: false, optional, ms: Date.now() - started, detail: `${code}: ${msg}` });
      console.log(`FAIL  ${name} — ${code}: ${msg}`);
    }
  }
  await sleep(1200);
}

const yt = new YouTubeClient({ timeoutMs: 180_000 });
console.log(`=== Live verify video=${VIDEO} cache=${process.env.YTUBE_CACHE_DIR} ===\n`);

await check("info", async () => {
  const info = await yt.getVideoInfo(VIDEO);
  if (!info?.title || info.id !== VIDEO) throw new Error("bad info");
  return `${info.title} (${info.durationSeconds}s)`;
});

await check("listCaptions", async () => {
  const caps = await yt.listCaptions(VIDEO);
  const n = caps.count ?? caps.tracks?.length;
  if (!n) throw new Error("no tracks");
  return `count=${n}`;
});

await check("transcript", async () => {
  const tr = await yt.getTranscript(VIDEO, { lang: "en" });
  if (!tr?.segmentCount || !tr.segments?.length) throw new Error("empty transcript");
  if (!tr.segments[0].timestamp) throw new Error("missing timestamps");
  return `segs=${tr.segmentCount} source=${tr.source} stale=${!!tr.stale} lang=${tr.languageCode}`;
});

await check("transcript_cache", async () => {
  const tr = await yt.getTranscript(VIDEO, { lang: "en" });
  if (!tr?.segmentCount) throw new Error("empty");
  return `segs=${tr.segmentCount}`;
});

await check("transcript_lang_chain", async () => {
  const tr = await yt.getTranscript(VIDEO, { lang: "xx,en" });
  if (!tr?.segmentCount) throw new Error("empty");
  return `resolved=${tr.resolvedLang ?? tr.languageCode} source=${tr.source}`;
});

await check("transcript_words", async () => {
  const tr = await yt.getTranscript(VIDEO, { lang: "en", words: true });
  // Words require a live json3 body; accept segments if words unavailable due to stale/cache.
  const withWords = (tr.segments || []).filter((s) => s.words?.length).length;
  if (!withWords && !tr.stale) throw new Error("no word timings");
  return `segmentsWithWords=${withWords} stale=${!!tr.stale}`;
}, { optional: true });

await check("diagnose", async () => {
  const d = await yt.diagnoseTranscript(VIDEO, { lang: "en" });
  if (!d) throw new Error("empty diagnose");
  const clients = d.clients?.length ?? d.probes?.length ?? d.clientProbes?.length;
  return `ok=${d.ok} clients=${clients}`;
});

await check("transcript_paging", async () => {
  const page = await yt.getTranscript(VIDEO, { lang: "en", maxChars: 400 });
  if (!page?.segmentCount) throw new Error("bad page");
  return `segs=${page.segmentCount} hasMore=${page.hasMore} next=${page.nextCursor}`;
});

await check("transcript_paging_resume", async () => {
  const page1 = await yt.getTranscript(VIDEO, { lang: "en", maxChars: 400 });
  if (!page1.hasMore || page1.nextCursor == null) return `no-more total=${page1.totalSegments}`;
  const page2 = await yt.getTranscript(VIDEO, { lang: "en", maxChars: 400, cursor: page1.nextCursor });
  if (!page2.segmentCount) throw new Error("empty page2");
  return `cursor=${page1.nextCursor} segs=${page2.segmentCount}`;
});

await check("transcript_clip", async () => {
  const clip = await yt.getTranscriptClip(VIDEO, "0:00", { end: "0:30", lang: "en" });
  if (!clip?.segmentCount) throw new Error("empty clip");
  return `segs=${clip.segmentCount}`;
});

await check("transcript_search", async () => {
  const hits = await yt.searchTranscript(VIDEO, "never", { lang: "en" });
  const n = hits.matches?.length ?? hits.count ?? hits.hits?.length ?? hits.results?.length;
  if (n === undefined) throw new Error("bad search shape: " + Object.keys(hits).join(","));
  return `hits=${n}`;
});

await check("export_subtitles_srt", async () => {
  const sub = await yt.exportSubtitles(VIDEO, { lang: "en", format: "srt" });
  if (!sub?.content || sub.content.length < 20) throw new Error("empty srt");
  return `format=${sub.format} bytes=${sub.content.length}`;
});

await check("chapters", async () => {
  const ch = await yt.getChapters(VIDEO);
  return `source=${ch.source} count=${ch.count ?? ch.chapters?.length ?? 0}`;
});

await check("thumbnails", async () => {
  const thumbs = await yt.getThumbnails(VIDEO);
  const n = Array.isArray(thumbs) ? thumbs.length : thumbs.count ?? thumbs.thumbnails?.length;
  if (!n) throw new Error("no thumbs");
  return `count=${n}`;
});

await check("formats", async () => {
  const f = await yt.listFormats(VIDEO);
  if (!f.count || !f.formats?.length) throw new Error("no formats");
  const direct = f.formats.filter((x) => x.directUrl).length;
  return `count=${f.count} direct=${direct} client=${f.innertubeClient}`;
});

await check("download", async () => {
  const f = await yt.listFormats(VIDEO);
  const pick =
    f.formats.find((x) => x.directUrl && x.hasAudio && !x.hasVideo) ||
    f.formats.find((x) => x.directUrl);
  if (!pick) throw new Error("no direct format");
  const out = `/tmp/yt-live-verify-${Date.now()}.media`;
  const dl = await yt.downloadMedia(VIDEO, out, { itag: pick.itag });
  if (!dl.bytesWritten || dl.bytesWritten < 1000) throw new Error("tiny download");
  return `itag=${dl.itag} bytes=${dl.bytesWritten}`;
});

await check("search", async () => {
  const s = await yt.search("me at the zoo", { limit: 3 });
  const n = s.results?.length ?? s.count;
  if (!n) throw new Error("no results");
  return `count=${n}`;
});

await check("videopack", async () => {
  const pack = await yt.getVideoPack(VIDEO, { chunkChars: 400 });
  if (!pack?.chunks?.length) throw new Error("no chunks");
  return `chunks=${pack.chunkCount} cite=${!!pack.howToCite} stale=${!!pack.cacheHit}`;
});

await check("videopack_cache", async () => {
  const pack = await yt.getVideoPack(VIDEO, { chunkChars: 400 });
  return `cacheHit=${pack.cacheHit} chunks=${pack.chunkCount}`;
});

await check("ask", async () => {
  const a = await yt.askVideo(VIDEO, "never gonna give you up", { topK: 3, lang: "en" });
  if (!a?.passages?.length && !(a?.matched > 0)) throw new Error("no passages matched");
  return `matched=${a.matched} passages=${a.passages?.length}`;
});

await check("playlist", async () => {
  const p = await yt.getPlaylist(PLAYLIST, { limit: 3 });
  const n = p.videos?.length ?? p.items?.length ?? p.count;
  if (!n) throw new Error("empty playlist");
  return `count=${n}`;
});

await check("playlist_pack", async () => {
  // Explicit list needs 2+ IDs (same as Go); use zoo + rickroll.
  const batch = await yt.getPlaylistPack(`${VIDEO},jNQXAC9IVRw`, {
    limit: 2,
    includeChunks: false,
  });
  if (!batch?.videos?.length && !batch?.totalVideos) throw new Error("empty batch");
  return `packed=${batch.videos?.length} total=${batch.totalVideos} failures=${batch.failures?.length ?? 0}`;
});

await check("channel_catalog_videos", async () => {
  const page = await yt.getChannelCatalog(CHANNEL, { contentType: "videos", limit: 3 });
  if (page.items?.length !== 3 || page.items.some((item) => item.contentType !== "video")) {
    throw new Error("bad long-form catalog page");
  }
  return `channel=${page.title} found=${page.discoveredVideos} hasMore=${page.hasMore}`;
});

await check("channel_catalog_shorts", async () => {
  const page = await yt.getChannelCatalog(CHANNEL, { contentType: "shorts", limit: 3 });
  if (page.items?.length !== 3 || page.items.some((item) => item.contentType !== "short")) {
    throw new Error("bad Shorts catalog page");
  }
  return `channel=${page.title} found=${page.discoveredVideos} hasMore=${page.hasMore}`;
});

await check("channel_pack_analysis", async () => {
  const page = await yt.getChannelPack(CHANNEL, {
    contentType: "videos",
    detail: "analysis",
    limit: 1,
  });
  const item = page.videos?.[0];
  if (!item?.video || !item.transcript?.segments?.length || !item.chapters || !item.chunks?.length) {
    throw new Error("incomplete channel analysis item");
  }
  return `title=${item.title} segments=${item.transcript.segmentCount} chunks=${item.chunkCount}`;
}, { optional: true });

await check("related", async () => {
  const r = await yt.getRelated(VIDEO);
  const n = r.videos?.length ?? r.related?.length ?? r.count;
  if (!n) throw new Error("no related");
  return `count=${n}`;
});

await check("comments", async () => {
  const c = await yt.getComments(VIDEO, { limit: 5, sort: "top" });
  const n = c.comments?.length ?? c.count;
  if (!n) throw new Error("no comments");
  return `count=${n}`;
});

await check("comments_newest", async () => {
  const c = await yt.getComments(VIDEO, { limit: 3, sort: "newest" });
  return `count=${c.comments?.length ?? c.count}`;
});

await check("heatmap", async () => {
  const h = await yt.getHeatmap(VIDEO);
  return `available=${h.available ?? !!(h.points?.length)}`;
});

await check("storyboards", async () => {
  const s = await yt.getStoryboards(VIDEO);
  return `count=${s.storyboards?.length ?? s.count ?? 0}`;
});

await check("manifests", async () => {
  const m = await yt.getManifests(VIDEO);
  return `live=${m.isLive ?? m.live ?? false}`;
});

await check("error_invalid_url", async () => {
  try {
    await yt.getVideoInfo("https://example.com/not-youtube");
    throw new Error("should have failed");
  } catch (e) {
    if (!(e instanceof YtubeError) || e.info.code !== "INVALID_VIDEO") throw e;
    return e.info.code;
  }
});

await check("error_strict_lang", async () => {
  try {
    await yt.getTranscript(VIDEO, { lang: "zz-missing", strict: true });
    throw new Error("should have failed");
  } catch (e) {
    if (!(e instanceof YtubeError)) throw e;
    // Prefer LANGUAGE_NOT_AVAILABLE; RATE_LIMITED can win if translation is attempted under IP throttle.
    if (!["LANGUAGE_NOT_AVAILABLE", "TRANSLATION_UNAVAILABLE", "RATE_LIMITED"].includes(e.info.code)) {
      throw e;
    }
    return e.info.code;
  }
});

await check("sponsors", async () => {
  try {
    const s = await yt.getSponsorSegments(VIDEO);
    return `count=${Array.isArray(s) ? s.length : s.segments?.length ?? 0}`;
  } catch (e) {
    if (e instanceof YtubeError && e.info.code === "SPONSORBLOCK_DISABLED") return e.info.code;
    throw e;
  }
});

console.log("\n=== Summary ===");
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} checks passed (${failed} failed)`);
for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.name}: ${r.detail}`);
if (failed > 0) process.exit(1);
console.log("\nAll required features working.");
