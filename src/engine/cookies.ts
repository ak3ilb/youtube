/**
 * Netscape cookies.txt support and the SAPISIDHASH authorization scheme that
 * YouTube expects on logged-in InnerTube calls.
 *
 * Ported from internal/youtube/cookies.go. Go relies on `net/http/cookiejar`;
 * here the jar is a small explicit implementation because the only consumer is
 * the `Cookie` request header for youtube.com.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { ExtractError } from "./errors.js";

export const YOUTUBE_ORIGIN = "https://www.youtube.com";

export interface Cookie {
  name: string;
  value: string;
  /** Host or parent domain, stored without a leading dot. */
  domain: string;
  path: string;
  secure: boolean;
  /** Unix seconds; `undefined` for session cookies. */
  expires?: number;
}

function domainMatches(host: string, domain: string): boolean {
  if (domain === "") return true;
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^\./, "");
  return h === d || h.endsWith("." + d);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  const p = cookiePath === "" ? "/" : cookiePath;
  if (p === "/") return true;
  if (requestPath === p) return true;
  if (requestPath.startsWith(p)) {
    return p.endsWith("/") || requestPath[p.length] === "/";
  }
  return false;
}

/** An ordered cookie store scoped to whatever the cookies.txt file contained. */
export class CookieJar {
  private readonly cookies: Cookie[] = [];

  constructor(cookies: Iterable<Cookie> = []) {
    for (const cookie of cookies) this.add(cookie);
  }

  get size(): number {
    return this.cookies.length;
  }

  /** Adds a cookie, replacing any earlier one with the same name/domain/path. */
  add(cookie: Cookie): void {
    const index = this.cookies.findIndex(
      (c) =>
        c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path,
    );
    if (index >= 0) this.cookies[index] = cookie;
    else this.cookies.push(cookie);
  }

  /** Unexpired cookies whose domain, path, and secure flag match `target`. */
  cookiesFor(target: string | URL = YOUTUBE_ORIGIN): Cookie[] {
    const url = typeof target === "string" ? new URL(target) : target;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const isSecure = url.protocol === "https:";
    return this.cookies.filter((cookie) => {
      if (cookie.expires !== undefined && cookie.expires > 0 && cookie.expires <= nowSeconds) {
        return false;
      }
      if (cookie.secure && !isSecure) return false;
      if (!domainMatches(url.hostname, cookie.domain)) return false;
      return pathMatches(url.pathname || "/", cookie.path);
    });
  }

  /** `name=value; name2=value2`, or an empty string when nothing applies. */
  header(target: string | URL = YOUTUBE_ORIGIN): string {
    return this.cookiesFor(target)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  toMap(target: string | URL = YOUTUBE_ORIGIN): Map<string, string> {
    const map = new Map<string, string>();
    for (const cookie of this.cookiesFor(target)) {
      if (!map.has(cookie.name)) map.set(cookie.name, cookie.value);
    }
    return map;
  }

  get(name: string, target: string | URL = YOUTUBE_ORIGIN): string | undefined {
    return this.toMap(target).get(name);
  }

  toArray(): Cookie[] {
    return [...this.cookies];
  }
}

/** Parses the body of a Netscape cookies.txt file. */
export function parseNetscapeCookies(text: string): Cookie[] {
  const cookies: Cookie[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      // Netscape httpOnly marker: #HttpOnly_.youtube.com ...
      if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
      else continue;
    }
    const fields = line.split("\t");
    if (fields.length < 7) continue;

    const expiresRaw = fields[4]!.trim();
    const expires = /^[+-]?\d+$/.test(expiresRaw) ? Number(expiresRaw) : 0;
    const cookie: Cookie = {
      name: fields[5]!,
      value: fields[6]!,
      domain: fields[0]!.replace(/^\./, ""),
      path: fields[2]!,
      secure: fields[3]!.toUpperCase() === "TRUE",
    };
    if (expires > 0) cookie.expires = expires;
    cookies.push(cookie);
  }
  return cookies;
}

/** Loads a Netscape cookies.txt file into a jar. */
export async function loadNetscapeCookies(path: string): Promise<CookieJar> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ExtractError({
      code: "COOKIES_INVALID",
      message:
        "Could not open cookies file: " + (err instanceof Error ? err.message : String(err)),
      details: { path },
    });
  }

  const cookies = parseNetscapeCookies(text);
  if (cookies.length === 0) {
    throw new ExtractError({
      code: "COOKIES_INVALID",
      message: "No cookies found in file; export a Netscape cookies.txt from your browser",
      details: { path },
    });
  }
  return new CookieJar(cookies);
}

/**
 * Builds the Authorization header YouTube expects for logged-in InnerTube
 * calls: `SAPISIDHASH <timestamp>_<sha1(timestamp + " " + SAPISID + " " + origin)>`.
 * Returns an empty string when no session cookie is present.
 */
export function sapisidHash(
  jar: CookieJar | undefined | null,
  origin: string = YOUTUBE_ORIGIN,
): string {
  if (!jar) return "";
  let sapisid = "";
  for (const cookie of jar.cookiesFor(origin)) {
    if (cookie.name === "SAPISID" || cookie.name === "__Secure-3PAPISID") {
      sapisid = cookie.value;
      break;
    }
  }
  if (sapisid === "") return "";

  const ts = String(Math.floor(Date.now() / 1000));
  const sum = createHash("sha1").update(`${ts} ${sapisid} ${origin}`).digest("hex");
  return `SAPISIDHASH ${ts}_${sum}`;
}
