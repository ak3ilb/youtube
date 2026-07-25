/**
 * On-disk response cache plus the soft hourly rate budget that keeps a user's
 * IP from tripping YouTube's throttling.
 *
 * Ported from internal/youtube/cache.go. The on-disk format is byte-compatible
 * with the Go engine, so both implementations can share a cache directory:
 *   <dir>/<sha1(namespace + "|" + key)>.json  ->  {"savedAt":…,"payload":…}
 *   <dir>/rate-budget.json                    ->  {"times":[…]}
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { ExtractError } from "./errors.js";

export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — fewer repeat timedtext hits
export const DEFAULT_RATE_LIMIT = 60; // video-ish requests per hour
export const RATE_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const RATE_FILE = "rate-budget.json";

interface CacheEntry {
  savedAt?: string;
  payload?: unknown;
}

interface RateFile {
  times?: string[];
}

export interface StaleHit<T> {
  value: T;
  ageSeconds: number;
}

export interface DiskCacheOptions {
  dir?: string;
  ttlMs?: number;
  /** Max billable calls per hour; `0` disables budgeting entirely. */
  limit?: number;
  disabled?: boolean;
  maxStaleMs?: number;
}

/**
 * Go's `time.ParseDuration`: a signed decimal sequence with unit suffixes
 * (`ns`, `us`/`µs`, `ms`, `s`, `m`, `h`). Returns `undefined` when the string
 * is not a duration Go would accept, so callers fall back to their default.
 */
export function parseGoDuration(input: string): number | undefined {
  const text = input.trim();
  if (text === "") return undefined;

  let rest = text;
  let sign = 1;
  if (rest.startsWith("+") || rest.startsWith("-")) {
    if (rest.startsWith("-")) sign = -1;
    rest = rest.slice(1);
  }
  if (rest === "0") return 0;
  if (rest === "") return undefined;

  const unitMs: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    "µs": 1e-3,
    "μs": 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };

  let totalMs = 0;
  const pattern = /^(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/;
  while (rest !== "") {
    const match = pattern.exec(rest);
    if (!match) return undefined;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return undefined;
    totalMs += value * unitMs[match[2]!]!;
    rest = rest.slice(match[0].length);
  }
  return sign * totalMs;
}

function envDuration(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = parseGoDuration(raw);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

export function defaultCacheDir(): string {
  const configured = process.env.YTUBE_CACHE_DIR;
  if (configured) return configured;
  let home = "";
  try {
    home = homedir();
  } catch {
    home = "";
  }
  if (!home) return join(tmpdir(), "youtube-client-cache");
  return join(home, ".cache", "youtube-client");
}

function envRateLimit(): number | undefined {
  const raw = process.env.YTUBE_RATE_LIMIT;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  // 0 disables budgeting entirely; any other non-negative value raises or lowers it.
  return n >= 0 ? n : undefined;
}

function cacheDisabledByEnv(): boolean {
  const raw = process.env.YTUBE_CACHE;
  return raw === "0" || raw === "false";
}

export class DiskCache {
  dir: string;
  readonly ttlMs: number;
  readonly limit: number;
  readonly maxStaleMs: number;
  disabled: boolean;

  /** Serializes read-modify-write cycles on the rate budget file. */
  private rateLock: Promise<void> = Promise.resolve();

  constructor(options: DiskCacheOptions = {}) {
    this.dir = options.dir ?? defaultCacheDir();
    this.ttlMs = options.ttlMs ?? envDuration("YTUBE_CACHE_TTL") ?? DEFAULT_CACHE_TTL_MS;
    this.limit = options.limit ?? envRateLimit() ?? DEFAULT_RATE_LIMIT;
    this.maxStaleMs =
      options.maxStaleMs ?? envDuration("YTUBE_CACHE_MAX_STALE") ?? DEFAULT_MAX_STALE_MS;
    this.disabled = options.disabled ?? cacheDisabledByEnv();
  }

  keyPath(namespace: string, key: string): string {
    const sum = createHash("sha1").update(namespace + "|" + key).digest("hex");
    return join(this.dir, sum + ".json");
  }

  /** Returns a cached value only while it is within TTL. */
  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    const hit = await this.getWithAge<T>(namespace, key, false);
    return hit?.value;
  }

  /**
   * Reads checkpoint-like cache state without applying TTL expiration.
   * Intended for progressive manifests whose continuation must never regress.
   */
  async getPersistent<T>(namespace: string, key: string): Promise<T | undefined> {
    if (this.disabled) return undefined;
    try {
      const raw = await readFile(this.keyPath(namespace, key), "utf8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (entry === null || typeof entry !== "object" || entry.payload === undefined) {
        return undefined;
      }
      return entry.payload as T;
    } catch {
      return undefined;
    }
  }

  /**
   * Returns a cached value even past TTL, as long as it is within the max-stale
   * window (`YTUBE_CACHE_MAX_STALE`, default 7 days). Used as a last resort
   * when a live fetch fails with a retryable error.
   */
  getStale<T>(namespace: string, key: string): Promise<StaleHit<T> | undefined> {
    return this.getWithAge<T>(namespace, key, true);
  }

  private async getWithAge<T>(
    namespace: string,
    key: string,
    allowStale: boolean,
  ): Promise<StaleHit<T> | undefined> {
    if (this.disabled) return undefined;
    const path = this.keyPath(namespace, key);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return undefined;
    }

    const decoded = this.decode<T>(raw, allowStale);
    if (decoded.kind === "expired") {
      await rm(path, { force: true }).catch(() => undefined);
      return undefined;
    }
    return decoded.kind === "hit" ? decoded.hit : undefined;
  }

  /** Synchronous `get`, for call sites that cannot await a cache probe. */
  getSync<T>(namespace: string, key: string): T | undefined {
    return this.getWithAgeSync<T>(namespace, key, false)?.value;
  }

  /** Synchronous `getStale`. */
  getStaleSync<T>(namespace: string, key: string): StaleHit<T> | undefined {
    return this.getWithAgeSync<T>(namespace, key, true);
  }

  private getWithAgeSync<T>(
    namespace: string,
    key: string,
    allowStale: boolean,
  ): StaleHit<T> | undefined {
    if (this.disabled) return undefined;
    const path = this.keyPath(namespace, key);

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }

    const decoded = this.decode<T>(raw, allowStale);
    if (decoded.kind === "expired") {
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore
      }
      return undefined;
    }
    return decoded.kind === "hit" ? decoded.hit : undefined;
  }

  private decode<T>(
    raw: string,
    allowStale: boolean,
  ): { kind: "miss" } | { kind: "expired" } | { kind: "hit"; hit: StaleHit<T> } {
    let entry: CacheEntry;
    try {
      entry = JSON.parse(raw) as CacheEntry;
    } catch {
      return { kind: "miss" };
    }
    if (entry === null || typeof entry !== "object" || entry.payload === undefined) {
      return { kind: "miss" };
    }

    const savedAt = entry.savedAt ? Date.parse(entry.savedAt) : NaN;
    if (!Number.isFinite(savedAt)) return { kind: "miss" };

    let ageMs = Date.now() - savedAt;
    if (ageMs < 0) ageMs = 0;
    if (ageMs > this.ttlMs) {
      // Leave the file on disk so getStale can still rescue it.
      if (!allowStale) return { kind: "miss" };
      if (ageMs > this.maxStaleMs) return { kind: "expired" };
    }
    return {
      kind: "hit",
      hit: { value: entry.payload as T, ageSeconds: Math.floor(ageMs / 1000) },
    };
  }

  /** Best-effort write; cache failures never break an extraction. */
  async set(namespace: string, key: string, value: unknown): Promise<void> {
    if (this.disabled) return;
    const entry = this.encode(value);
    if (entry === undefined) return;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o755 });
      await writeFile(this.keyPath(namespace, key), entry, { mode: 0o644 });
    } catch {
      // ignore
    }
  }

  /** Synchronous `set`, so fire-and-forget call sites leave no dangling promise. */
  setSync(namespace: string, key: string, value: unknown): void {
    if (this.disabled) return;
    const entry = this.encode(value);
    if (entry === undefined) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o755 });
      writeFileSync(this.keyPath(namespace, key), entry, { mode: 0o644 });
    } catch {
      // ignore
    }
  }

  private encode(value: unknown): string | undefined {
    try {
      return JSON.stringify({ savedAt: new Date().toISOString(), payload: value });
    } catch {
      return undefined;
    }
  }

  /**
   * Records a billable network action. Throws `RATE_BUDGET_EXCEEDED` when the
   * hourly budget is spent. Cache hits never call this.
   */
  async bill(label: string): Promise<void> {
    if (this.limit <= 0) return;
    await this.withRateLock(async () => {
      const path = join(this.dir, RATE_FILE);
      await mkdir(this.dir, { recursive: true, mode: 0o755 }).catch(() => undefined);

      const now = Date.now();
      const kept = this.recentTimes(await this.readRateTimes(path), now);
      if (kept.length >= this.limit) {
        let retryAfterMs = kept[0]! + RATE_WINDOW_MS - now;
        if (retryAfterMs < 0) retryAfterMs = 60_000;
        throw new ExtractError({
          code: "RATE_BUDGET_EXCEEDED",
          message:
            "Local rate budget exceeded to protect your IP from YouTube throttling. Wait and retry, raise YTUBE_RATE_LIMIT, or set YTUBE_RATE_LIMIT=0 to disable.",
          retryable: true,
          details: {
            limit: this.limit,
            window: "1h",
            used: kept.length,
            action: label,
            retryAfterSec: Math.floor(retryAfterMs / 1000) + 1,
            suggestion:
              "Cache hits do not consume budget. Prefer get_video_pack / transcript for repeated analysis of the same video.",
          },
        });
      }

      kept.push(now);
      const payload: RateFile = { times: kept.map((t) => new Date(t).toISOString()) };
      await writeFile(path, JSON.stringify(payload), { mode: 0o644 }).catch(() => undefined);
    });
  }

  /**
   * How many billable calls are left in the current hour window. A negative
   * value means budgeting is disabled.
   */
  async remaining(): Promise<number> {
    if (this.limit <= 0) return -1;
    return this.withRateLock(async () => {
      const times = await this.readRateTimes(join(this.dir, RATE_FILE));
      const used = this.recentTimes(times, Date.now()).length;
      return Math.max(0, this.limit - used);
    });
  }

  /** Synchronous `remaining`, mirroring Go's `RateBudgetRemaining`. */
  remainingSync(): number {
    if (this.limit <= 0) return -1;
    let raw: string;
    try {
      raw = readFileSync(join(this.dir, RATE_FILE), "utf8");
    } catch {
      return this.limit;
    }
    const used = this.recentTimes(this.decodeRateTimes(raw), Date.now()).length;
    return Math.max(0, this.limit - used);
  }

  private async readRateTimes(path: string): Promise<number[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    return this.decodeRateTimes(raw);
  }

  private decodeRateTimes(raw: string): number[] {
    let parsed: RateFile;
    try {
      parsed = JSON.parse(raw) as RateFile;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed?.times)) return [];
    return parsed.times
      .map((t) => Date.parse(t))
      .filter((t): t is number => Number.isFinite(t));
  }

  private recentTimes(times: number[], now: number): number[] {
    const cutoff = now - RATE_WINDOW_MS;
    return times.filter((t) => t > cutoff).sort((a, b) => a - b);
  }

  private withRateLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.rateLock.then(fn, fn);
    // Keep the chain alive (and unrejected) for the next waiter.
    this.rateLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
