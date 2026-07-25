/**
 * Disk-backed circuit breaker for YouTube's `/api/timedtext` endpoint.
 *
 * Aggressive diagnose/smoke runs can trip an IP-level HTTP 429 that then poisons
 * every subsequent caption body GET for minutes. After the first 429 we stop
 * hitting timedtext for a cooldown window and prefer stale transcript cache
 * instead — that is what keeps agents productive instead of burning the ban.
 *
 * Override with `YTUBE_TIMEDTEXT_COOLDOWN` (Go duration, default `15m`).
 * Set to `0` to disable the breaker.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseGoDuration } from "./cache.js";
import { ExtractError } from "./errors.js";

const FILE = "timedtext-cooldown.json";

interface CooldownFile {
  until?: string;
  reason?: string;
}

function cacheDir(): string {
  const override = (process.env.YTUBE_CACHE_DIR ?? "").trim();
  if (override !== "") return override;
  return join(homedir(), ".cache", "youtube-client");
}

function cooldownMs(): number {
  const raw = (process.env.YTUBE_TIMEDTEXT_COOLDOWN ?? "").trim();
  if (raw === "0" || raw.toLowerCase() === "off" || raw.toLowerCase() === "false") {
    return 0;
  }
  if (raw !== "") {
    const parsed = parseGoDuration(raw);
    if (parsed !== undefined && parsed >= 0) return parsed;
  }
  return 15 * 60 * 1000;
}

function readUntil(): number {
  try {
    const raw = readFileSync(join(cacheDir(), FILE), "utf8");
    const parsed = JSON.parse(raw) as CooldownFile;
    const until = parsed.until ? Date.parse(parsed.until) : NaN;
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}

/** True while live timedtext GETs should be skipped. */
export function isTimedtextCoolingDown(): boolean {
  if (cooldownMs() <= 0) return false;
  return Date.now() < readUntil();
}

/** Seconds remaining on the timedtext cooldown (0 when clear). */
export function timedtextCooldownRemainingSec(): number {
  if (cooldownMs() <= 0) return 0;
  const left = Math.ceil((readUntil() - Date.now()) / 1000);
  return left > 0 ? left : 0;
}

/**
 * Record a timedtext HTTP 429 and arm the cooldown. Honors `Retry-After` when
 * present; otherwise uses `YTUBE_TIMEDTEXT_COOLDOWN`.
 */
export function markTimedtextRateLimited(retryAfterSec?: number): void {
  const configured = cooldownMs();
  if (configured <= 0) return;

  let waitMs = configured;
  if (typeof retryAfterSec === "number" && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    waitMs = Math.max(waitMs, Math.floor(retryAfterSec * 1000));
  }
  // Cap at 2h so a bad Retry-After cannot lock captions all day.
  waitMs = Math.min(waitMs, 2 * 60 * 60 * 1000);

  const dir = cacheDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const until = new Date(Date.now() + waitMs).toISOString();
    writeFileSync(
      join(dir, FILE),
      JSON.stringify({ until, reason: "RATE_LIMITED" }, null, 0),
      { mode: 0o644 },
    );
  } catch {
    // ignore — breaker is best-effort
  }
}

/** Clear the breaker (tests / manual recovery). */
export function clearTimedtextCooldown(): void {
  try {
    writeFileSync(join(cacheDir(), FILE), JSON.stringify({ until: new Date(0).toISOString() }), {
      mode: 0o644,
    });
  } catch {
    // ignore
  }
}

/**
 * Throw a retryable RATE_LIMITED error when the breaker is open, so callers
 * fall through to stale-cache rescue without another timedtext GET.
 */
export function assertTimedtextAllowed(): void {
  const left = timedtextCooldownRemainingSec();
  if (left <= 0) return;
  throw new ExtractError({
    code: "RATE_LIMITED",
    message: `YouTube timedtext is in cooldown after HTTP 429; retry in ~${left}s (or serve stale cache)`,
    details: { retryAfterSec: left, cooldown: true },
    retryable: true,
  });
}
