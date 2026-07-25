/**
 * Bounded windows over a transcript, for agents with limited context.
 * Ported from internal/youtube/paging.go.
 */
import type { Transcript, TranscriptPage } from "./types.js";

export type { TranscriptPage } from "./types.js";

function runeLength(text: string): number {
  return [...text].length;
}

/**
 * Slices `tr` starting at segment index `cursor`, stopping once the page would
 * exceed `maxChars`. A segment is never split, so a single oversized segment is
 * still returned whole. `maxChars <= 0` returns everything from the cursor on.
 */
export function pageTranscript(tr: Transcript, cursor: number, maxChars: number): TranscriptPage {
  const all = tr.segments;
  let start = cursor;
  if (start < 0) {
    start = 0;
  }
  if (start > all.length) {
    start = all.length;
  }

  let totalChars = 0;
  for (const s of all) {
    totalChars += runeLength(s.text);
  }

  let end = all.length;
  let pageChars = 0;
  if (maxChars > 0) {
    end = start;
    while (end < all.length) {
      const segChars = runeLength(all[end]!.text);
      if (pageChars > 0 && pageChars + segChars > maxChars) {
        break;
      }
      pageChars += segChars;
      end++;
    }
  } else {
    for (const s of all.slice(start)) {
      pageChars += runeLength(s.text);
    }
  }

  const segments = all.slice(start, end);
  const lines: string[] = [];
  const textParts: string[] = [];
  let duration = 0;
  for (const s of segments) {
    lines.push("[" + s.timestamp + "] " + s.text);
    textParts.push(s.text);
    if (s.end > duration) {
      duration = s.end;
    }
  }

  const hasMore = end < all.length;
  return {
    ...tr,
    segmentCount: segments.length,
    durationSeconds: duration,
    segments,
    lines,
    text: textParts.join(" "),
    cursor: start,
    nextCursor: hasMore ? end : undefined,
    hasMore,
    totalSegments: all.length,
    totalChars,
    pageChars,
  };
}
