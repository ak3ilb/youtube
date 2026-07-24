#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built MCP server over stdio with a real
 * MCP client and exercises every tool, including error paths.
 *
 * Requires: `npm run build:ts` first, network access, and either a prebuilt
 * binary in bin/ or a Go toolchain.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { statSync, rmSync } from "node:fs";

const VIDEO = "jNQXAC9IVRw"; // "Me at the zoo" — public, short, captioned
const results = [];

function record(name, passed, note) {
  results.push({ name, passed, note });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
}

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  return { isError: Boolean(res.isError), body: text ? JSON.parse(text) : null };
}

try {
  // 1. Tool listing
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ["download_media", "get_chapters", "get_thumbnails", "get_transcript", "get_video_info", "list_captions", "list_formats"];
  record("list_tools", JSON.stringify(names) === JSON.stringify(expected), names.join(","));

  // 2. get_video_info happy path
  let r = await call("get_video_info", { urlOrId: `https://www.youtube.com/watch?v=${VIDEO}` });
  record("get_video_info", !r.isError && r.body.title === "Me at the zoo" && r.body.durationSeconds === 19, r.body.title);

  // 3. get_transcript happy path
  r = await call("get_transcript", { urlOrId: VIDEO, lang: "en" });
  record(
    "get_transcript",
    !r.isError && r.body.segmentCount > 0 && r.body.text.toLowerCase().includes("elephant"),
    `segments=${r.body.segmentCount ?? "?"} lang=${r.body.languageCode ?? "?"}`,
  );

  // 4. list_captions
  r = await call("list_captions", { urlOrId: VIDEO });
  record("list_captions", !r.isError && r.body.count >= 1, `count=${r.body.count}`);

  // 5. get_chapters (this video has 00:00/00:05/00:17 in its description)
  r = await call("get_chapters", { urlOrId: VIDEO });
  record("get_chapters", !r.isError && r.body.hasChapters === true && r.body.count === 3, `count=${r.body.count}`);

  // 6. get_thumbnails
  r = await call("get_thumbnails", { urlOrId: VIDEO });
  record("get_thumbnails", !r.isError && r.body.thumbnails.length > 0, `count=${r.body.thumbnails.length}`);

  // 7. list_formats
  r = await call("list_formats", { urlOrId: VIDEO });
  const direct = (r.body.formats ?? []).filter((f) => f.directUrl);
  record("list_formats", !r.isError && r.body.count > 0, `count=${r.body.count} direct=${direct.length} client=${r.body.innertubeClient}`);

  // 8. download_media smallest direct audio-only format (keeps the test light)
  const audio = direct.filter((f) => f.hasAudio && !f.hasVideo).sort((a, b) => (a.contentLength ?? 0) - (b.contentLength ?? 0))[0];
  if (audio) {
    const out = `/tmp/ytube-smoke-${Date.now()}.media`;
    r = await call("download_media", { urlOrId: VIDEO, outputPath: out, itag: audio.itag });
    const size = r.isError ? 0 : statSync(out).size;
    record("download_media", !r.isError && size > 0 && size === r.body.bytesWritten, `itag=${audio.itag} bytes=${size}`);
    rmSync(out, { force: true });
  } else {
    record("download_media", false, "no direct audio format available to test");
  }

  // --- Error paths ---
  r = await call("get_video_info", { urlOrId: "https://vimeo.com/12345" });
  record("error: invalid URL", r.isError && r.body.error === "INVALID_VIDEO", r.body.error);

  r = await call("get_video_info", { urlOrId: "aaaaaaaaaaa" }); // valid shape, nonexistent
  record("error: nonexistent video", r.isError && ["VIDEO_UNAVAILABLE", "AUTH_REQUIRED"].includes(r.body.error), r.body.error);

  r = await call("get_transcript", { urlOrId: VIDEO, lang: "xx" });
  record("error: missing language", r.isError && r.body.error === "LANGUAGE_NOT_AVAILABLE", r.body.message);

  r = await call("download_media", { urlOrId: VIDEO, outputPath: "/tmp/x.mp4", itag: 99999 });
  record("error: bad itag", r.isError && r.body.error === "FORMAT_NOT_FOUND", r.body.error);
} finally {
  await client.close();
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
