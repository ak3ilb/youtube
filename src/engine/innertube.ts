/**
 * InnerTube transport: the low-level HTTP client every extraction path uses.
 *
 * Ported from internal/youtube/innertube.go. Client identities mirror yt-dlp's
 * INNERTUBE_CLIENTS table; ANDROID/IOS are preferred for player calls because
 * they return direct stream URLs without the sig/nsig JavaScript challenges the
 * WEB client enforces.
 */
import { DiskCache, type StaleHit } from "./cache.js";
import {
  CookieJar,
  loadNetscapeCookies,
  sapisidHash,
  YOUTUBE_ORIGIN,
} from "./cookies.js";
import { classifyNetworkError, ExtractError, httpStatusError } from "./errors.js";
import { getEngineFetch, type EngineFetch } from "./proxy.js";

export const INNERTUBE_BASE = "https://www.youtube.com/youtubei/v1/";
export const ANDROID_USER_AGENT =
  "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
export const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
export const MAX_RETRIES = 3;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Matches Go's `io.LimitReader(resp.Body, 32<<20)`. */
const MAX_RESPONSE_BYTES = 32 << 20;

export interface InnertubeProfile {
  name: string;
  version: string;
  /** `X-YouTube-Client-Name` value. */
  numericId: string;
  userAgent: string;
  osName?: string;
  osVersion?: string;
  sdkInt?: number;
}

export type InnerTubeClientProfile = InnertubeProfile;

export const clientANDROID: InnertubeProfile = {
  name: "ANDROID",
  version: "20.10.38",
  numericId: "3",
  userAgent: ANDROID_USER_AGENT,
  osName: "Android",
  osVersion: "14",
  sdkInt: 34,
};

export const clientIOS: InnertubeProfile = {
  name: "IOS",
  version: "20.10.4",
  numericId: "5",
  userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
  osName: "iOS",
  osVersion: "18.3.2.22D82",
};

export const clientWEB: InnertubeProfile = {
  name: "WEB",
  version: "2.20250312.04.00",
  numericId: "1",
  userAgent: WEB_USER_AGENT,
};

export const clientTVEmbed: InnertubeProfile = {
  name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
  version: "2.0",
  numericId: "85",
  userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
};

/** All known client identities, keyed by InnerTube client name. */
export const innertubeProfiles = {
  ANDROID: clientANDROID,
  IOS: clientIOS,
  WEB: clientWEB,
  TVHTML5_SIMPLY_EMBEDDED_PLAYER: clientTVEmbed,
} as const satisfies Record<string, InnertubeProfile>;

/** Player clients prefer ANDROID/IOS for direct stream URLs; WEB/TV for next/browse. */
export const playerClients: InnertubeProfile[] = [
  clientANDROID,
  clientIOS,
  clientWEB,
  clientTVEmbed,
];

export const webClients: InnertubeProfile[] = [clientWEB];

/**
 * Order used when collecting caption tracks. IOS first: its signed timedtext
 * URLs are currently the least PO-token gated; ANDROID/WEB follow as fallbacks.
 */
export const captionClients: InnertubeProfile[] = [clientIOS, clientANDROID, clientWEB];

export type FetchLike = typeof globalThis.fetch;

export interface ClientOptions {
  /** Per-request timeout; defaults to 30s like Go's `NewClient`. */
  timeoutMs?: number;
  /** Netscape cookies.txt to load lazily on the first call. */
  cookiesPath?: string;
  /** Optional YouTube Data API v3 key for search/channel fallbacks. */
  apiKey?: string;
  cache?: DiskCache;
  /** Injectable transport, mainly for tests. */
  fetch?: FetchLike;
  /** Overrides `YTUBE_HL` / `YTUBE_GL`. */
  hl?: string;
  gl?: string;
  /** Overrides `YTUBE_VISITOR_DATA` / `YTUBE_PO_TOKEN`. */
  visitorData?: string;
  poToken?: string;
}

export interface CallOptions {
  /** Caller-supplied cancellation, combined with the per-attempt timeout. */
  signal?: AbortSignal;
}

/** A bare `AbortSignal` is accepted wherever `CallOptions` is. */
export type CallControls = AbortSignal | CallOptions | undefined;

export interface HttpGetOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type InnertubePayload = Record<string, unknown>;

function toCallOptions(controls: CallControls): CallOptions {
  if (controls === undefined) return {};
  if (controls instanceof AbortSignal) return { signal: controls };
  return controls;
}

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; release: () => void } {
  if (signals.length === 1) return { signal: signals[0]!, release: () => undefined };
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const release = () => {
    for (const remove of listeners) remove();
    listeners.length = 0;
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => {
      controller.abort(signal.reason);
      release();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    listeners.push(() => signal.removeEventListener("abort", onAbort));
  }
  return { signal: controller.signal, release };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(classifyNetworkError(signal.reason ?? new Error("request aborted")));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(classifyNetworkError(signal?.reason ?? new Error("request aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Go's `200*(1<<attempt) + rand.Intn(200)` milliseconds. */
function backoffMs(attempt: number): number {
  return 200 * (1 << attempt) + Math.floor(Math.random() * 200);
}

async function readLimited(response: Response): Promise<string> {
  const buffer = new Uint8Array(await response.arrayBuffer());
  const limited =
    buffer.byteLength > MAX_RESPONSE_BYTES ? buffer.subarray(0, MAX_RESPONSE_BYTES) : buffer;
  return new TextDecoder().decode(limited);
}

/**
 * Performs InnerTube requests with a shared cookie jar, the local rate budget,
 * and retry on 429/5xx.
 */
export class Client {
  /** Client identities available to `call`. */
  static readonly profiles = innertubeProfiles;

  readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly options: ClientOptions;
  private jar: CookieJar | undefined;
  private cookiesLoaded = false;
  private cacheInstance: DiskCache | undefined;
  private apiKeyValue: string | undefined;

  constructor(options: ClientOptions = {}) {
    this.options = options;
    this.timeoutMs =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? (getEngineFetch() as FetchLike);
    this.cacheInstance = options.cache;
    this.apiKeyValue = options.apiKey;
  }

  /** Disk cache and rate budget, created on first use like Go's `initCache`. */
  get cache(): DiskCache {
    if (!this.cacheInstance) this.cacheInstance = new DiskCache();
    return this.cacheInstance;
  }

  get apiKey(): string | undefined {
    return this.apiKeyValue;
  }

  /** Enables the optional official Data API v3 path for search/channel. */
  withAPIKey(key: string): this {
    this.apiKeyValue = key === "" ? undefined : key;
    return this;
  }

  /** Overrides the on-disk cache location. */
  setCacheDir(dir: string): this {
    if (dir !== "") this.cache.dir = dir;
    return this;
  }

  /** Loads a Netscape cookies.txt file into the client's jar. */
  async withCookies(path: string): Promise<this> {
    if (path === "") return this;
    this.jar = await loadNetscapeCookies(path);
    this.cookiesLoaded = true;
    return this;
  }

  setCookieJar(jar: CookieJar | undefined): this {
    this.jar = jar;
    this.cookiesLoaded = true;
    return this;
  }

  get cookieJar(): CookieJar | undefined {
    return this.jar;
  }

  /** `Cookie` request header for youtube.com, or an empty string. */
  cookieHeader(target: string | URL = YOUTUBE_ORIGIN): string {
    return this.jar?.header(target) ?? "";
  }

  /** Records a billable network action against the hourly budget. */
  bill(label: string): Promise<void> {
    return this.cache.bill(label);
  }

  /** Billable calls left this hour; negative means budgeting is disabled. */
  rateBudgetRemaining(): number {
    return this.cache.remainingSync();
  }

  /** Async twin of `rateBudgetRemaining`. */
  rateBudgetRemainingAsync(): Promise<number> {
    return this.cache.remaining();
  }

  private async ensureCookies(): Promise<void> {
    if (this.cookiesLoaded) return;
    this.cookiesLoaded = true;
    const path = this.options.cookiesPath;
    if (!path) return;
    this.jar = await loadNetscapeCookies(path);
  }

  private buildBody(
    endpoint: string,
    profile: InnertubeProfile,
    payload: InnertubePayload,
  ): Record<string, unknown> {
    const clientCtx: Record<string, unknown> = {
      clientName: profile.name,
      clientVersion: profile.version,
      hl: this.options.hl ?? envValue("YTUBE_HL") ?? "en",
      gl: this.options.gl ?? envValue("YTUBE_GL") ?? "US",
    };
    if (profile.osName) {
      clientCtx.osName = profile.osName;
      clientCtx.osVersion = profile.osVersion ?? "";
    }
    if (profile.sdkInt !== undefined && profile.sdkInt > 0) {
      clientCtx.androidSdkVersion = profile.sdkInt;
    }
    const visitorData = this.options.visitorData ?? process.env.YTUBE_VISITOR_DATA;
    if (visitorData) clientCtx.visitorData = visitorData;

    const body: Record<string, unknown> = { context: { client: clientCtx } };
    // A PO token minted by the user's browser unblocks streams and captions that
    // YouTube now gates on BotGuard attestation.
    const poToken = this.options.poToken ?? process.env.YTUBE_PO_TOKEN;
    if (poToken && endpoint === "player") {
      body.serviceIntegrityDimensions = { poToken };
    }
    return Object.assign(body, payload);
  }

  /** Cached value within TTL, probed synchronously. */
  cacheGet<T>(namespace: string, key: string): T | undefined {
    return this.cache.getSync<T>(namespace, key);
  }

  /** Cached value past TTL but within the max-stale window. */
  cacheGetStale<T>(namespace: string, key: string): StaleHit<T> | undefined {
    return this.cache.getStaleSync<T>(namespace, key);
  }

  /** Best-effort cache write. */
  cacheSet(namespace: string, key: string, value: unknown): void {
    this.cache.setSync(namespace, key, value);
  }

  /**
   * Plain GET through the same jar and body limit as InnerTube calls, used for
   * timedtext captions and other non-InnerTube endpoints. Not billed: only
   * InnerTube calls consume the rate budget.
   */
  async httpGet(url: string, options: HttpGetOptions = {}): Promise<HttpResponse> {
    await this.ensureCookies();
    const headers: Record<string, string> = {
      "User-Agent": ANDROID_USER_AGENT,
      ...options.headers,
    };
    const cookie = this.cookieHeader(url);
    if (cookie !== "" && headers.Cookie === undefined) headers.Cookie = cookie;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const { signal, release } = combineSignals(
      options.signal ? [timeout, options.signal] : [timeout],
    );
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal,
        redirect: "follow",
      });
      return { status: response.status, body: await readLimited(response) };
    } finally {
      release();
    }
  }

  /** POSTs to an InnerTube endpoint and returns the raw response body. */
  async call(
    endpoint: string,
    profile: InnertubeProfile,
    payload: InnertubePayload = {},
    controls: CallControls = {},
  ): Promise<string> {
    const options = toCallOptions(controls);
    await this.bill("innertube:" + endpoint);
    await this.ensureCookies();

    const raw = JSON.stringify(this.buildBody(endpoint, profile, payload));
    const url = INNERTUBE_BASE + endpoint + "?prettyPrint=false";

    let lastError: ExtractError | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await delay(backoffMs(attempt), options.signal);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": profile.userAgent,
        "X-YouTube-Client-Name": profile.numericId,
        "X-YouTube-Client-Version": profile.version,
        Origin: YOUTUBE_ORIGIN,
      };
      const cookie = this.cookieHeader();
      if (cookie !== "") headers.Cookie = cookie;
      const auth = sapisidHash(this.jar);
      if (auth !== "") {
        headers.Authorization = auth;
        headers["X-Origin"] = YOUTUBE_ORIGIN;
      }

      const timeout = AbortSignal.timeout(this.timeoutMs);
      const { signal, release } = combineSignals(
        options.signal ? [timeout, options.signal] : [timeout],
      );

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: raw,
          signal,
          redirect: "follow",
        });
      } catch (err) {
        release();
        lastError = classifyNetworkError(err);
        continue;
      }

      let data: string;
      try {
        data = await readLimited(response);
      } catch (err) {
        lastError = classifyNetworkError(err);
        continue;
      } finally {
        release();
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = httpStatusError(response.status);
        continue;
      }
      if (response.status !== 200) {
        throw httpStatusError(response.status);
      }
      return data;
    }

    throw (
      lastError ??
      new ExtractError({
        code: "RATE_LIMITED",
        message: "YouTube rate-limited the request after retries",
        retryable: true,
      })
    );
  }

  /** `call` plus JSON parsing. */
  async callJSON<T>(
    endpoint: string,
    profile: InnertubeProfile,
    payload: InnertubePayload = {},
    controls: CallControls = {},
  ): Promise<T> {
    const data = await this.call(endpoint, profile, payload, controls);
    try {
      return JSON.parse(data) as T;
    } catch (err) {
      throw new ExtractError({
        code: "INVALID_RESPONSE",
        message: "YouTube returned malformed JSON",
        retryable: true,
        details: {
          cause: err instanceof Error ? err.message : String(err),
          endpoint,
        },
      });
    }
  }
}
