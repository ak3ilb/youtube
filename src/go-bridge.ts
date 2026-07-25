/**
 * Bridge between the TypeScript MCP/library layer and the in-process engine.
 *
 * Historically this shelled out to a Go `ytube` binary. The engine is now pure
 * TypeScript under `./engine/` — `runEngine` just calls `dispatch`.
 */
export type { EngineError } from "./engine/errors.js";
export { ExtractError as YtubeError, isExtractError } from "./engine/errors.js";

import { dispatch, type DispatchFlags } from "./engine/index.js";
import { asEngineError, ExtractError } from "./engine/errors.js";

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * @deprecated No native binary remains. Kept for API compatibility — returns a
 * sentinel describing the in-process engine.
 */
export function resolveEngine(): { command: string; prefixArgs: string[] } {
  return { command: "in-process", prefixArgs: [] };
}

/** Run one engine command and return its data payload. */
export async function runEngine<T>(
  command: string,
  flags: Record<string, string | number | boolean | undefined | null> = {},
  options: RunOptions = {},
): Promise<T> {
  try {
    const cleaned: DispatchFlags = {};
    for (const [key, value] of Object.entries(flags)) {
      if (value === undefined || value === null || value === "" || value === false) continue;
      cleaned[key] = value;
    }
    return (await dispatch(command, cleaned, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })) as T;
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw asEngineError(err);
  }
}
