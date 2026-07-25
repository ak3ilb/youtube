/**
 * Optional HTTP(S) proxy for YouTube fetches.
 *
 * Timedtext 429 "Sorry..." responses are an IP-reputation block. Changing egress
 * (VPN, residential proxy, mobile hotspot) is the only reliable unblock. Set:
 *
 *   YTUBE_PROXY=http://user:pass@host:port
 *   # or the standard HTTPS_PROXY / HTTP_PROXY
 *
 * When set, InnerTube + timedtext + media GETs go through undici's ProxyAgent.
 */
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

export type EngineFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

let cachedKey: string | undefined;
let cachedFetch: EngineFetch | undefined;

/** Resolve proxy URL from env. Empty string = direct. */
export function resolveProxyUrl(): string {
  for (const key of ["YTUBE_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const v = (process.env[key] ?? "").trim();
    if (v !== "") return v;
  }
  return "";
}

/**
 * Returns `fetch` — either the global one, or an undici fetch bound to
 * `YTUBE_PROXY` / `HTTPS_PROXY`. Safe to call repeatedly; recreates the agent
 * when the env value changes.
 */
export function getEngineFetch(): EngineFetch {
  const proxy = resolveProxyUrl();
  if (proxy === "") {
    cachedKey = "";
    cachedFetch = undefined;
    return globalThis.fetch.bind(globalThis);
  }
  if (cachedKey === proxy && cachedFetch) return cachedFetch;

  const agent = new ProxyAgent(proxy);
  const proxied: EngineFetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    // undici's fetch accepts `dispatcher`; the DOM lib typings do not.
    const opts = { ...init, dispatcher: agent } as UndiciRequestInit;
    return undiciFetch(url, opts) as unknown as Promise<Response>;
  };
  cachedKey = proxy;
  cachedFetch = proxied;
  return proxied;
}

/** True when a caption/timedtext body is YouTube's IP-block interstitial. */
export function isYouTubeSorryBlock(status: number, body: string): boolean {
  if (status !== 429 && status !== 503) return false;
  const head = body.slice(0, 800).toLowerCase();
  return (
    head.includes("<title>sorry...") ||
    head.includes("unusual traffic") ||
    head.includes("our systems have detected") ||
    (head.includes("sorry...") && head.includes("<html"))
  );
}
