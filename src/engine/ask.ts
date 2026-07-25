/**
 * Question answering over one video's transcript chunks.
 * Ported from internal/youtube/ask.go.
 *
 * Retrieval is BM25 over the pack's citation chunks, which keeps an agent inside
 * its context window: it receives a handful of cited passages instead of a
 * whole transcript.
 */
import { ExtractError } from "./errors.js";
import { videoPackWithOptions } from "./rag.js";
import type { Engine } from "./transcript.js";
import type { AskOptions, AskResult, Passage, RAGChunk, VideoInfo } from "./types.js";

export type { AskOptions, AskResult, Passage } from "./types.js";

export const DEFAULT_TOP_K = 5;
export const DEFAULT_ASK_CHUNK_CHARS = 600;

export const HOW_TO_CITE_ASK =
  "Quote passages with their citation timestamp and link chunk.url so readers can jump to that moment.";

/** BM25 term-frequency saturation and length-normalization constants. */
const K1 = 1.5;
const B = 0.75;

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not",
  "you", "your", "with", "that", "this", "was",
  "what", "who", "how", "why", "when", "does",
  "did", "can", "about", "from", "they", "them",
  "has", "have", "were", "into", "there", "their",
]);

/**
 * Splits on anything that is not a letter or digit, dropping stop words and
 * one-byte tokens. Length is measured in UTF-8 bytes to match Go's `len`, so
 * single CJK/Devanagari characters survive while stray ASCII letters do not.
 */
export function tokenize(s: string): string[] {
  const fields = s.toLowerCase().match(/[\p{L}\p{Nd}]+/gu) ?? [];
  return fields.filter((f) => Buffer.byteLength(f, "utf8") > 1 && !STOP_WORDS.has(f));
}

/**
 * Scores chunks against a question with BM25 plus a 1.5x bonus for exact phrase
 * hits, then returns the best `topK`.
 */
export function rankPassages(chunks: RAGChunk[], question: string, topK = 0): Passage[] {
  const terms = tokenize(question);
  if (terms.length === 0 || chunks.length === 0) {
    return [];
  }
  const k = topK <= 0 ? DEFAULT_TOP_K : topK;

  const docTokens: string[][] = [];
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    docTokens.push(tokens);
    totalLen += tokens.length;
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }
  }
  let avgLen = totalLen / chunks.length;
  if (avgLen === 0) {
    avgLen = 1;
  }
  const phrase = question.trim().toLowerCase();

  const scored: Passage[] = [];
  chunks.forEach((chunk, i) => {
    const tokens = docTokens[i]!;
    const termFreq = new Map<string, number>();
    for (const t of tokens) {
      termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    }
    let score = 0;
    for (const term of terms) {
      const tf = termFreq.get(term) ?? 0;
      if (tf === 0) {
        continue;
      }
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
      const docLen = tokens.length;
      score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * docLen) / avgLen));
    }
    if (score > 0 && chunk.text.toLowerCase().includes(phrase)) {
      score *= 1.5;
    }
    if (score > 0) {
      scored.push({ chunk, score });
    }
  });

  scored.sort((a, b) => (a.score === b.score ? a.chunk.start - b.chunk.start : b.score - a.score));
  return scored.length > k ? scored.slice(0, k) : scored;
}

/** Renders retrieved passages as a markdown context block. */
export function renderPassageContext(info: VideoInfo, passages: Passage[]): string {
  let b = `# ${info.title}\n\n${info.url}\n\n`;
  if (passages.length === 0) {
    return b + "No transcript passages matched the question.\n";
  }
  b += "## Relevant passages\n\n";
  for (const p of passages) {
    b += `### ${p.chunk.citation} (${p.chunk.url})\n\n${p.chunk.text}\n\n`;
  }
  return b;
}

/** Retrieves the transcript passages most relevant to a question. */
export async function askVideo(
  engine: Engine,
  input: string,
  question: string,
  opts: AskOptions = {},
  signal?: AbortSignal,
): Promise<AskResult> {
  const q = question.trim();
  if (q === "") {
    throw new ExtractError({ code: "USAGE", message: "a question is required for ask" });
  }
  const chunkChars =
    opts.chunkChars === undefined || opts.chunkChars <= 0
      ? DEFAULT_ASK_CHUNK_CHARS
      : opts.chunkChars;
  const pack = await videoPackWithOptions(
    engine,
    input,
    { lang: opts.lang, chunkChars },
    signal,
  );
  const video = pack.video;
  if (video === null) {
    throw new ExtractError({
      code: "INTERNAL_ERROR",
      message: "The video pack carried no video metadata",
    });
  }
  const passages = rankPassages(pack.chunks, q, opts.topK ?? 0);
  return {
    videoId: video.id,
    title: video.title,
    url: video.url,
    question: q,
    language: pack.language || undefined,
    matched: passages.length,
    passages,
    context: renderPassageContext(video, passages),
    howToCite: HOW_TO_CITE_ASK,
  };
}
