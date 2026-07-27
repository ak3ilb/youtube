/**
 * Structured "what to do next" guidance when caption download fails.
 *
 * Tracks can exist while timedtext is IP-blocked; some videos also refuse the
 * Show transcript panel (FAILED_PRECONDITION / CC unavailable). Agents need a
 * stable `kind` so they show the right fix instead of busy-retrying.
 */
import type { CaptionRecovery } from "./types.js";
import { ExtractError, isExtractError } from "./errors.js";

export type { CaptionRecovery };

export interface RecoveryContext {
  /** Caption tracks were discovered via InnerTube. */
  tracksExist?: boolean;
  /** timedtext returned HTTP 429 Sorry… */
  timedtextBlocked?: boolean;
  /** Show transcript / get_transcript did not return cues for this video. */
  panelUnavailable?: boolean;
  /** Local timedtext cooldown is armed. */
  cooldown?: boolean;
  cooldownSec?: number;
  browserConfigured?: boolean;
  browserAvailable?: boolean;
}

/** Build recovery guidance from what the ladder / browser already observed. */
export function buildCaptionRecovery(ctx: RecoveryContext): CaptionRecovery {
  const tracksExist = ctx.tracksExist === true;
  const timedtextBlocked = ctx.timedtextBlocked === true;
  const panelUnavailable = ctx.panelUnavailable === true;
  const browserOn = ctx.browserConfigured === true;
  const browserReady = ctx.browserAvailable !== false;

  if (timedtextBlocked && panelUnavailable) {
    return {
      kind: "proxy_required",
      summary:
        "Captions exist, but timedtext is IP-blocked and this video's Show transcript panel is unavailable. A clean proxy (or different network) is required — the browser fallback alone will not help.",
      actions: [
        "Set YTUBE_PROXY (or HTTPS_PROXY) to a clean residential egress and retry",
        "Or switch network / VPN / phone hotspot and retry",
        "Do not busy-retry on the same IP for the full timedtext cooldown",
      ],
      tracksExist,
      timedtextBlocked: true,
      panelUnavailable: true,
    };
  }

  if (timedtextBlocked || ctx.cooldown) {
    const actions: string[] = [];
    if (!browserOn) {
      actions.push(
        "Enable YTUBE_BROWSER=1 and install Playwright (`npm i playwright && npx playwright install chromium`)",
      );
    } else if (ctx.browserAvailable === false) {
      actions.push("Install Playwright: npm i playwright && npx playwright install chromium");
    } else {
      actions.push("Retry with browser fallback enabled (already configured)");
    }
    actions.push("Or set YTUBE_PROXY / HTTPS_PROXY to a clean residential egress");
    actions.push("Or wait for the timedtext cooldown / IP block to clear, then retry");
    if (ctx.cooldown && (ctx.cooldownSec ?? 0) > 0) {
      actions.push(`Local timedtext cooldown has ~${ctx.cooldownSec}s remaining`);
    }
    return {
      kind: browserOn && browserReady ? "wait_or_proxy" : "browser_or_proxy",
      summary: tracksExist
        ? "Caption tracks were found, but YouTube blocked the caption body download from this IP (HTTP 429 Sorry page)."
        : "YouTube blocked caption downloads from this IP (HTTP 429 Sorry page).",
      actions,
      tracksExist: tracksExist || undefined,
      timedtextBlocked: true,
    };
  }

  if (ctx.browserConfigured === true && ctx.browserAvailable === false) {
    return {
      kind: "install_playwright",
      summary: "Browser fallback is enabled but Playwright is not installed.",
      actions: ["Run: npm i playwright && npx playwright install chromium"],
    };
  }

  return {
    kind: "other",
    summary: "Caption fetch failed — see the error code and message.",
    actions: [
      "Call diagnoseTranscript for a per-stage report",
      "Retry later if the error is retryable",
    ],
    tracksExist: tracksExist || undefined,
  };
}

/** Attach a `recovery` object onto an ExtractError's details (in place). */
export function withCaptionRecovery(err: ExtractError, ctx: RecoveryContext): ExtractError {
  const recovery = buildCaptionRecovery(ctx);
  err.details = {
    ...(err.details ?? {}),
    recovery,
    hint: recovery.actions[0],
  };
  return err;
}

/** Best-effort recovery from an already-thrown error's details. */
export function recoveryFromError(
  err: unknown,
  extras: RecoveryContext = {},
): CaptionRecovery | undefined {
  if (!isExtractError(err)) return undefined;
  const existing = err.details?.recovery;
  if (existing && typeof existing === "object") {
    return existing as CaptionRecovery;
  }
  if (err.code !== "IP_BLOCKED" && err.code !== "RATE_LIMITED" && err.code !== "BROWSER_REQUIRED") {
    return undefined;
  }
  return buildCaptionRecovery({
    timedtextBlocked: err.code === "IP_BLOCKED" || extras.timedtextBlocked === true,
    cooldown: err.details?.cooldown === true || extras.cooldown === true,
    cooldownSec:
      typeof err.details?.retryAfterSec === "number"
        ? (err.details.retryAfterSec as number)
        : extras.cooldownSec,
    panelUnavailable: err.details?.panelEmpty === true || extras.panelUnavailable === true,
    tracksExist: extras.tracksExist,
    browserConfigured: extras.browserConfigured,
    browserAvailable: extras.browserAvailable,
  });
}
