import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCaptionRecovery } from "./caption-recovery.js";

describe("caption recovery guidance", () => {
  it("marks proxy_required when timedtext is blocked and the panel is dead", () => {
    const r = buildCaptionRecovery({
      tracksExist: true,
      timedtextBlocked: true,
      panelUnavailable: true,
      browserConfigured: true,
    });
    assert.equal(r.kind, "proxy_required");
    assert.match(r.summary, /browser fallback alone will not help/i);
    assert.ok(r.actions.some((a) => /YTUBE_PROXY/i.test(a)));
    assert.equal(r.panelUnavailable, true);
  });

  it("suggests browser_or_proxy when only timedtext is blocked", () => {
    const r = buildCaptionRecovery({
      tracksExist: true,
      timedtextBlocked: true,
      browserConfigured: false,
    });
    assert.equal(r.kind, "browser_or_proxy");
    assert.ok(r.actions.some((a) => /YTUBE_BROWSER=1/.test(a)));
  });

  it("suggests wait_or_proxy when browser is already on", () => {
    const r = buildCaptionRecovery({
      tracksExist: true,
      timedtextBlocked: true,
      browserConfigured: true,
      browserAvailable: true,
    });
    assert.equal(r.kind, "wait_or_proxy");
  });
});
