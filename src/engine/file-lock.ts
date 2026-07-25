/** Minimal cross-process lock for progressive manifests and export datasets. */
import { open, readFile, rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { ExtractError } from "./errors.js";

interface LockPayload {
  pid: number;
  createdAt: string;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function staleLock(path: string): Promise<boolean> {
  try {
    const payload = JSON.parse(await readFile(path, "utf8")) as Partial<LockPayload>;
    if (typeof payload.pid === "number") return !processAlive(payload.pid);
  } catch {
    // Fall back to age for an interrupted/partial lock-file write.
  }
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs > 5 * 60 * 1000;
  } catch {
    return true;
  }
}

export async function withFileLock<T>(
  path: string,
  code: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let handle;
  while (handle === undefined) {
    if (signal?.aborted) {
      throw new ExtractError({ code: "TIMEOUT", message: "Operation aborted while waiting for lock" });
    }
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await staleLock(path)) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ExtractError({
          code,
          message: "Another process is already updating this channel job",
          retryable: true,
          details: { lockPath: path },
        });
      }
      await sleep(100, undefined, { signal }).catch(() => undefined);
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
  }
}
