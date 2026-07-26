import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  browserTranscriptEnabled,
  fetchCaptionSegmentsViaBrowser,
  getBrowserJobStats,
  isBrowserTranscriptAvailable,
  resetBrowserJobStats,
} from "./browser-transcript.js";
import { ExtractError, isExtractError } from "./errors.js";
import { parseJSON3, parseTimedTextXML } from "./transcript.js";

describe("browserTranscriptEnabled", () => {
  const original = process.env.YTUBE_BROWSER;
  afterEach(() => {
    if (original === undefined) delete process.env.YTUBE_BROWSER;
    else process.env.YTUBE_BROWSER = original;
  });

  it("honors the explicit browser option", () => {
    delete process.env.YTUBE_BROWSER;
    assert.equal(browserTranscriptEnabled({ browser: true }), true);
    assert.equal(browserTranscriptEnabled({ browser: false }), false);
    assert.equal(browserTranscriptEnabled({}), false);
  });

  it("honors YTUBE_BROWSER truthy values", () => {
    for (const v of ["1", "true", "on", "yes", "TRUE"]) {
      process.env.YTUBE_BROWSER = v;
      assert.equal(browserTranscriptEnabled({}), true, `expected ${v} to enable`);
    }
    for (const v of ["0", "", "off", "false"]) {
      process.env.YTUBE_BROWSER = v;
      assert.equal(browserTranscriptEnabled({}), false, `expected ${v} to disable`);
    }
  });
});

describe("browser availability", () => {
  it("throws BROWSER_REQUIRED with an install hint when playwright is absent", async () => {
    // Playwright is an OPTIONAL peer dependency. In the default install it is
    // not present, so the fallback must fail loudly and actionably. When a
    // developer has opted in (installed playwright for live checks), skip — we
    // do not want to launch a real browser inside a unit test.
    if (await isBrowserTranscriptAvailable()) return;
    await assert.rejects(
      () => fetchCaptionSegmentsViaBrowser("dQw4w9WgXcQ", { lang: "en" }),
      (err: unknown) => {
        assert.ok(isExtractError(err));
        assert.equal((err as ExtractError).code, "BROWSER_REQUIRED");
        assert.match((err as ExtractError).message, /playwright install chromium/);
        return true;
      },
    );
  });
});

describe("browser job queue (batch lifecycle)", () => {
  const originalGap = process.env.YTUBE_BROWSER_GAP_MS;
  afterEach(() => {
    if (originalGap === undefined) delete process.env.YTUBE_BROWSER_GAP_MS;
    else process.env.YTUBE_BROWSER_GAP_MS = originalGap;
  });

  it("serializes overlapping jobs and drains the job slots", async () => {
    // Needs the no-Playwright path so nothing real launches; when a developer
    // has installed Playwright for live checks, the live harness covers this.
    if (await isBrowserTranscriptAvailable()) return;
    process.env.YTUBE_BROWSER_GAP_MS = "0";
    resetBrowserJobStats();

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        fetchCaptionSegmentsViaBrowser(`video${i}`, { lang: "en" }),
      ),
    );
    assert.equal(results.length, 30);
    assert.ok(results.every((r) => r.status === "rejected"));

    const stats = getBrowserJobStats();
    // A 30-video batch must never run two jobs (or two tabs) at once.
    assert.equal(stats.peakActiveJobs, 1);
    assert.equal(stats.activeJobs, 0);
    assert.equal(stats.openPages, 0);
    assert.equal(stats.completedJobs, 30);
    assert.equal(stats.hasContext, false);
  });
});

describe("shared caption parsers (browser body path)", () => {
  it("parses a json3 body the browser fetches same-origin", () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "hello" }, { utf8: " world" }] },
        { tStartMs: 1500, dDurationMs: 1000, aAppend: 1, segs: [{ utf8: "\n" }] },
        { tStartMs: 2500, dDurationMs: 1200, segs: [{ utf8: "second line" }] },
      ],
    });
    const segs = parseJSON3(body, false);
    assert.equal(segs.length, 2);
    assert.equal(segs[0]!.text, "hello world");
    assert.equal(segs[0]!.start, 0);
    assert.equal(segs[1]!.text, "second line");
    assert.equal(segs[1]!.start, 2.5);
  });

  it("keeps word timings when requested", () => {
    const body = JSON.stringify({
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 900,
          segs: [
            { utf8: "quick", tOffsetMs: 0 },
            { utf8: " brown", tOffsetMs: 300 },
          ],
        },
      ],
    });
    const segs = parseJSON3(body, true);
    assert.equal(segs.length, 1);
    assert.ok(segs[0]!.words && segs[0]!.words.length === 2);
    assert.equal(segs[0]!.words![0]!.text, "quick");
    assert.equal(segs[0]!.words![1]!.start, 1.3);
  });

  it("parses an srv1 xml body the browser fetches same-origin", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><transcript>' +
      '<text start="0" dur="1.5">Hello &amp; welcome</text>' +
      '<text start="1.5" dur="2">line two</text>' +
      "</transcript>";
    const segs = parseTimedTextXML(xml);
    assert.equal(segs.length, 2);
    assert.equal(segs[0]!.text, "Hello & welcome");
    assert.equal(segs[0]!.start, 0);
    assert.equal(segs[1]!.start, 1.5);
  });
});

describe("parsePanelJson (get_panel / Show transcript)", () => {
  it("parses modern transcriptSegmentViewModel cues", async () => {
    const { parsePanelJson } = await import("./browser-transcript.js");
    const body = JSON.stringify({
      content: {
        engagementPanelSectionListRenderer: {
          content: {
            sectionListRenderer: {
              contents: [
                {
                  itemSectionRenderer: {
                    contents: [
                      {
                        macroMarkersPanelItemViewModel: {
                          item: {
                            timelineItemViewModel: {
                              contentItems: [
                                {
                                  transcriptSegmentViewModel: {
                                    simpleText: "We're no strangers to love",
                                    timestamp: "0:18",
                                  },
                                },
                                {
                                  transcriptSegmentViewModel: {
                                    simpleText: "Never gonna give you up",
                                    timestamp: "0:43",
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });
    const segs = parsePanelJson(body);
    assert.equal(segs.length, 2);
    assert.equal(segs[0]!.text, "We're no strangers to love");
    assert.equal(segs[0]!.start, 18);
    assert.equal(segs[1]!.text, "Never gonna give you up");
    assert.equal(segs[1]!.start, 43);
  });
});
