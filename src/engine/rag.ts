/**
 * Citation-ready chunking and the agent-facing video pack.
 * Ported from internal/youtube/rag.go.
 *
 * Chunks never split a transcript segment, so every chunk keeps a timestamp an
 * agent can cite and a deep link a reader can open.
 */
import { parseVideoId } from "./ids.js";
import { removeSponsorSegments, sponsorSegments } from "./sponsorblock.js";
import { formatTimestamp, watchURLAt } from "./timestamps.js";
import type { Engine } from "./transcript.js";
import type {
  Chapter,
  PackOptions,
  RAGChunk,
  SponsorSegment,
  TranscriptSegment,
  VideoInfo,
  VideoPack,
} from "./types.js";

export type { PackOptions, RAGChunk, VideoPack } from "./types.js";

export const DEFAULT_CHUNK_CHARS = 800;

export const HOW_TO_CITE_PACK =
  "Cite claims with timestamps like [1:07:12] matching chunk.citation, and link chunk.url to jump there.";

function runeLength(text: string): number {
  return [...text].length;
}

/**
 * Groups transcript segments into ~`targetChars` windows that never break a
 * segment, each tagged with a YouTube-style citation timestamp.
 */
export function buildRAGChunks(
  videoID: string,
  segments: TranscriptSegment[],
  targetChars = 0,
): RAGChunk[] {
  const target = targetChars <= 0 ? DEFAULT_CHUNK_CHARS : targetChars;
  const chunks: RAGChunk[] = [];
  let buf: TranscriptSegment[] = [];
  let chars = 0;

  const flush = (): void => {
    if (buf.length === 0) {
      return;
    }
    const text = buf.map((s) => s.text).join(" ");
    const start = buf[0]!.start;
    const end = buf[buf.length - 1]!.end;
    chunks.push({
      id: `${videoID}_${Math.trunc(start * 1000)}`,
      text,
      citation: "[" + formatTimestamp(start) + "]",
      url: watchURLAt(videoID, start),
      start,
      end,
      timestamp: formatTimestamp(start),
      timestampEnd: formatTimestamp(end),
      charCount: runeLength(text),
    });
    buf = [];
    chars = 0;
  };

  for (const s of segments) {
    const segChars = runeLength(s.text);
    if (chars > 0 && chars + segChars > target) {
      flush();
    }
    buf.push(s);
    chars += segChars + 1;
  }
  flush();
  return chunks;
}

/** Renders a pack as a markdown briefing an agent can paste into context. */
export function renderPackMarkdown(
  info: VideoInfo,
  chapters: Chapter[],
  chunks: RAGChunk[],
  lang: string,
): string {
  let b = `# ${info.title}\n\n`;
  b += `- URL: ${info.url}\n`;
  b += `- Channel: ${info.channelName}\n`;
  b += `- Duration: ${formatTimestamp(info.durationSeconds)}\n`;
  if (lang !== "") {
    b += `- Transcript language: ${lang}\n`;
  }
  b += "\n## How to cite\n\n";
  b +=
    "When quoting this video, include the timestamp citation like `[1:07:12]` so readers can jump to that moment.\n";
  if (chapters.length > 0) {
    b += "\n## Chapters\n\n";
    for (const ch of chapters) {
      b += `- [${ch.timestamp}] ${ch.title}\n`;
    }
  }
  b += "\n## Transcript chunks\n\n";
  for (const c of chunks) {
    b += `### ${c.citation}\n\n${c.text}\n\n`;
  }
  return b;
}

/** Builds a citation-ready analysis pack for agents (RAG / briefing). */
export function videoPack(
  engine: Engine,
  input: string,
  lang?: string,
  chunkChars = 0,
  signal?: AbortSignal,
): Promise<VideoPack> {
  return videoPackWithOptions(engine, input, { lang, chunkChars }, signal);
}

/** `videoPack` with sponsor-skipping and chunk sizing. */
export async function videoPackWithOptions(
  engine: Engine,
  input: string,
  opts: PackOptions = {},
  signal?: AbortSignal,
): Promise<VideoPack> {
  const id = parseVideoId(input);
  const cacheKey = `${id}|${opts.lang ?? ""}|${opts.chunkChars ?? 0}|${opts.skipSponsors === true}`;
  const cached = await engine.client.cache.get<VideoPack>("videopack2", cacheKey);
  if (cached !== undefined) {
    cached.cacheHit = true;
    return cached;
  }

  const info = await engine.info(input, signal);
  const chapterResult = await engine.chapters(input, signal);
  const transcript = await engine.transcript(input, opts.lang, signal);

  let segments = transcript.segments;
  let sponsors: SponsorSegment[] = [];
  let removed = 0;
  if (opts.skipSponsors === true) {
    sponsors = await sponsorSegments(engine, id, signal);
    const stripped = removeSponsorSegments(segments, sponsors);
    segments = stripped.segments;
    removed = stripped.removedSeconds;
  }

  const chunks = buildRAGChunks(id, segments, opts.chunkChars ?? 0);
  // Key order mirrors the Go struct so serialized packs are byte-comparable.
  const pack: VideoPack = {
    video: info,
    chapters: chapterResult.chapters,
    chapterSource: chapterResult.source,
    language: transcript.languageCode,
    mergedAsr: transcript.merged,
    chunkCount: chunks.length,
    chunks,
    markdown: renderPackMarkdown(info, chapterResult.chapters, chunks, transcript.languageCode),
    howToCite: HOW_TO_CITE_PACK,
    sponsorSegments: sponsors.length > 0 ? sponsors : undefined,
    removedSeconds: removed !== 0 ? removed : undefined,
  };
  await engine.client.cache.set("videopack2", cacheKey, pack);
  return pack;
}
