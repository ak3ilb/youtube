#!/usr/bin/env node
/**
 * End-to-end smoke test for YouTube Client.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync, statSync } from "node:fs";

const VIDEO = "jNQXAC9IVRw";
const results = [];

function record(name, passed, note) {
  results.push({ name, passed, note });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
}

const client = new Client({ name: "smoke", version: "1.0.0" });
// The SDK filters the child environment, so forward the engine's own settings
// (cache dir, rate budget, cookies, API key) explicitly.
const engineEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith("YTUBE_") || key === "YOUTUBE_API_KEY"),
);
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...engineEnv },
  }),
);

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  return { isError: Boolean(res.isError), body: text ? JSON.parse(text) : null };
}

try {
  const { tools } = await client.listTools();
  record("list_tools", tools.length >= 23, `count=${tools.length}`);

  let r = await call("get_video_info", { urlOrId: `https://www.youtube.com/watch?v=${VIDEO}` });
  record("get_video_info", !r.isError && r.body.title === "Me at the zoo", r.body.title);

  r = await call("get_transcript", { urlOrId: VIDEO, lang: "en" });
  const seg0 = r.body.segments?.[0];
  record(
    "get_transcript_timestamps",
    !r.isError && seg0?.timestamp && Array.isArray(r.body.lines) && r.body.lines[0]?.startsWith("["),
    `ts=${seg0?.timestamp} lines=${r.body.lines?.length}`,
  );

  r = await call("get_transcript", { urlOrId: VIDEO, lang: "en", maxChars: 40 });
  const firstPage = r.body;
  record(
    "get_transcript_paging",
    !r.isError && firstPage.hasMore === true && firstPage.nextCursor > 0 && firstPage.totalChars > firstPage.pageChars,
    `page=${firstPage.pageChars}/${firstPage.totalChars} next=${firstPage.nextCursor}`,
  );

  r = await call("get_transcript", { urlOrId: VIDEO, lang: "en", maxChars: 40, cursor: firstPage.nextCursor });
  record(
    "get_transcript_paging_resume",
    !r.isError && r.body.cursor === firstPage.nextCursor && r.body.segments?.[0]?.text !== firstPage.segments?.[0]?.text,
    `cursor=${r.body.cursor} segs=${r.body.segmentCount}`,
  );

  r = await call("get_transcript_clip", { urlOrId: VIDEO, lang: "en", start: "0:00", end: "0:10" });
  record("get_transcript_clip", !r.isError && r.body.segmentCount >= 1, `segs=${r.body.segmentCount}`);

  r = await call("search_transcript", { urlOrId: VIDEO, lang: "en", query: "elephant" });
  record("search_transcript", !r.isError && r.body.matchCount >= 1, `hits=${r.body.matchCount}`);

  r = await call("export_subtitles", { urlOrId: VIDEO, lang: "en", format: "srt" });
  record("export_subtitles", !r.isError && String(r.body.content).includes("-->"), `format=${r.body.format}`);

  r = await call("list_captions", { urlOrId: VIDEO });
  record("list_captions", !r.isError && r.body.count >= 1, `count=${r.body.count}`);

  r = await call("get_chapters", { urlOrId: VIDEO });
  record("get_chapters", !r.isError && r.body.hasChapters === true, `source=${r.body.source} count=${r.body.count}`);

  r = await call("get_thumbnails", { urlOrId: VIDEO });
  record("get_thumbnails", !r.isError && r.body.thumbnails.length > 0, `count=${r.body.thumbnails.length}`);

  r = await call("list_formats", { urlOrId: VIDEO });
  const direct = (r.body.formats ?? []).filter((f) => f.directUrl);
  record("list_formats", !r.isError && r.body.count > 0, `count=${r.body.count} direct=${direct.length}`);

  const audio = direct.filter((f) => f.hasAudio && !f.hasVideo).sort((a, b) => (a.contentLength ?? 0) - (b.contentLength ?? 0))[0];
  if (audio) {
    const out = `/tmp/ytube-smoke-${Date.now()}.media`;
    r = await call("download_media", { urlOrId: VIDEO, outputPath: out, itag: audio.itag });
    const size = r.isError ? 0 : statSync(out).size;
    record("download_media", !r.isError && size > 0, `itag=${audio.itag} bytes=${size}`);
    rmSync(out, { force: true });
    rmSync(out + ".part", { force: true });
  } else {
    record("download_media", false, "no direct audio format");
  }

  r = await call("search_youtube", { query: "me at the zoo", limit: 3 });
  record("search_youtube", !r.isError && r.body.count === 3, `count=${r.body.count}`);

  r = await call("get_video_pack", { urlOrId: VIDEO, chunkChars: 200 });
  record(
    "get_video_pack",
    !r.isError && r.body.chunkCount >= 1 && r.body.markdown?.includes("Me at the zoo") && r.body.chunks?.[0]?.citation,
    `chunks=${r.body.chunkCount} cite=${r.body.chunks?.[0]?.citation}`,
  );

  r = await call("get_video_pack", { urlOrId: VIDEO, chunkChars: 200 });
  record("get_video_pack_cache", !r.isError && r.body.cacheHit === true, `cacheHit=${r.body.cacheHit}`);

  r = await call("ask_video", { urlOrId: VIDEO, lang: "en", question: "what is cool about the elephants?", topK: 2 });
  const passage = r.body.passages?.[0];
  record(
    "ask_video",
    !r.isError && r.body.matched >= 1 && Boolean(passage?.chunk?.citation) && String(passage?.chunk?.url).includes("watch?v="),
    `matched=${r.body.matched} cite=${passage?.chunk?.citation}`,
  );

  // The batch engine also accepts an explicit video list, which keeps this
  // check independent of any third-party playlist staying public.
  r = await call("get_playlist_pack", { urlOrId: `${VIDEO},dQw4w9WgXcQ`, limit: 2, chunkChars: 400 });
  record(
    "get_playlist_pack",
    !r.isError && r.body.videos?.length >= 1 && r.body.totalChunks >= 1 && typeof r.body.markdown === "string",
    `packed=${r.body.videos?.length} chunks=${r.body.totalChunks} failures=${r.body.failures?.length ?? 0}`,
  );

  r = await call("get_related", { urlOrId: VIDEO });
  record("get_related", !r.isError, `count=${r.body.count}`);

  r = await call("get_comments", { urlOrId: VIDEO, limit: 5 });
  record("get_comments", !r.isError, `count=${r.body.count}`);

  r = await call("get_comments", { urlOrId: VIDEO, limit: 3, sort: "newest" });
  record("get_comments_sort", !r.isError && r.body.sort === "newest", `sort=${r.body.sort} count=${r.body.count}`);

  r = await call("get_heatmap", { urlOrId: VIDEO });
  record("get_heatmap", !r.isError, `available=${r.body.available}`);

  r = await call("get_storyboards", { urlOrId: VIDEO });
  record("get_storyboards", !r.isError, `count=${r.body.count}`);

  r = await call("get_manifests", { urlOrId: VIDEO });
  record("get_manifests", !r.isError && r.body.videoId === VIDEO, `live=${r.body.isLive}`);

  // Error paths
  r = await call("get_video_info", { urlOrId: "https://vimeo.com/12345" });
  record("error: invalid URL", r.isError && r.body.error === "INVALID_VIDEO", r.body.error);

  r = await call("get_transcript", { urlOrId: VIDEO, lang: "xx" });
  record(
    "error: missing language",
    r.isError && ["LANGUAGE_NOT_AVAILABLE", "TRANSLATION_UNAVAILABLE", "RATE_LIMITED", "EMPTY_TRANSCRIPT", "YOUTUBE_HTTP_ERROR", "RATE_BUDGET_EXCEEDED"].includes(r.body.error),
    r.body.error,
  );

  r = await call("download_media", { urlOrId: VIDEO, outputPath: "/tmp/x.mp4", itag: 99999 });
  record("error: bad itag", r.isError && r.body.error === "FORMAT_NOT_FOUND", r.body.error);

  // SponsorBlock is opt-in, so the default install must refuse it clearly.
  r = await call("get_sponsor_segments", { urlOrId: VIDEO });
  const sponsorOptIn = r.isError && r.body.error === "SPONSORBLOCK_DISABLED";
  const sponsorEnabled = !r.isError && Array.isArray(r.body.segments);
  record("get_sponsor_segments", sponsorOptIn || sponsorEnabled, r.isError ? r.body.error : `count=${r.body.count}`);
} finally {
  await client.close();
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
