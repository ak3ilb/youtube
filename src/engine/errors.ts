/**
 * Structured errors for the pure-TypeScript extraction engine.
 *
 * Port of `ExtractError` in internal/youtube/extractor.go. Every failure path
 * produces one of these so callers (MCP tools, the Node client, the CLI) can
 * surface a stable machine-readable `code` alongside a human message.
 */

/** Wire shape of an engine error: identical to Go's `ExtractError` JSON. */
export interface EngineError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export interface ExtractErrorInit {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

const BRAND = "__ytubeExtractError";

export class ExtractError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  /** Mutable like Go's struct field: call sites enrich details as they unwind. */
  details?: Record<string, unknown>;

  /** Duck-typing brand so instances survive module duplication and structuredClone. */
  readonly [BRAND] = true as const;

  constructor(init: ExtractErrorInit) {
    super(init.message);
    this.name = "ExtractError";
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    if (init.details !== undefined) this.details = init.details;
  }

  /** Matches Go's `(*ExtractError).Error()`. */
  override toString(): string {
    return `${this.code}: ${this.message}`;
  }

  /** Plain payload, ready for `{"ok":false,"error":…}` responses. */
  get info(): EngineError {
    return this.toJSON();
  }

  toJSON(): EngineError {
    const out: EngineError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/**
 * Alias kept for parity with the Go-bridge error name that the published
 * library already exposes.
 */
export const YtubeError = ExtractError;
export type YtubeError = ExtractError;

export function isExtractError(value: unknown): value is ExtractError {
  if (value instanceof ExtractError) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate[BRAND] === true &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string"
  );
}

function causeMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalize any thrown value into an `ExtractError`. Values that already carry
 * an engine error shape (including ones deserialized from the Go engine) are
 * preserved verbatim.
 */
export function asEngineError(
  value: unknown,
  fallback: Partial<ExtractErrorInit> = {},
): ExtractError {
  if (value instanceof ExtractError) return value;

  if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return new ExtractError({
        code: candidate.code,
        message: candidate.message,
        details:
          typeof candidate.details === "object" && candidate.details !== null
            ? (candidate.details as Record<string, unknown>)
            : undefined,
        retryable: candidate.retryable === true,
      });
    }
  }

  const cause = causeMessage(value);
  return new ExtractError({
    code: fallback.code ?? "UNKNOWN_ERROR",
    message: fallback.message ?? cause ?? "The extraction engine failed without details",
    retryable: fallback.retryable ?? false,
    details: { ...fallback.details, cause },
  });
}

function isAbortLike(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  if (value.name === "AbortError" || value.name === "TimeoutError") return true;
  const code = (value as NodeJS.ErrnoException).code;
  return code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT";
}

/** Port of Go's `classifyNetworkError`. */
export function classifyNetworkError(value: unknown): ExtractError {
  if (isExtractError(value)) return asEngineError(value);
  const cause = causeMessage(value);
  if (isAbortLike(value)) {
    return new ExtractError({
      code: "TIMEOUT",
      message: "The YouTube request timed out",
      retryable: true,
      details: { cause },
    });
  }
  return new ExtractError({
    code: "NETWORK_ERROR",
    message: "Could not connect to YouTube (check your internet connection or proxy)",
    retryable: true,
    details: { cause },
  });
}

/** Port of Go's `httpStatusError`. */
export function httpStatusError(status: number, body = ""): ExtractError {
  if (
    (status === 429 || status === 503) &&
    /sorry\.\.\.|unusual traffic|detected unusual/i.test(body.slice(0, 800))
  ) {
    return new ExtractError({
      code: "IP_BLOCKED",
      message:
        "YouTube blocked caption downloads from this IP (HTTP 429 Sorry page). " +
        "Wait, switch network/VPN, or set YTUBE_PROXY / HTTPS_PROXY to a clean egress. " +
        "This is IP reputation — not a missing parser.",
      retryable: true,
      details: {
        status,
        hint: "YTUBE_PROXY=http://user:pass@host:port",
        docs: "https://github.com/ak3ilb/youtube#configuration",
      },
    });
  }
  switch (status) {
    case 429:
      return new ExtractError({
        code: "RATE_LIMITED",
        message: "YouTube rate-limited the request (HTTP 429); wait and retry",
        retryable: true,
        details: { status },
      });
    case 403:
      return new ExtractError({
        code: "ACCESS_DENIED",
        message:
          "YouTube denied the request (HTTP 403); this client may now require a PO token",
        details: { status },
      });
    default:
      return new ExtractError({
        code: "YOUTUBE_HTTP_ERROR",
        message: `YouTube returned HTTP ${status}`,
        retryable: status >= 500,
        details: { status },
      });
  }
}
