/**
 * Bridge between the TypeScript MCP layer and the Go extraction engine.
 *
 * The Go binary (`ytube`) prints exactly one JSON object per invocation:
 *   {"ok":true,"data":...} or {"ok":false,"error":{code,message,details,retryable}}
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EngineError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export class YtubeError extends Error {
  constructor(public readonly info: EngineError) {
    super(info.message);
    this.name = "YtubeError";
  }
}

// Compiled location is <root>/dist/go-bridge.js, so the package root is one level up.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/** Resolve the platform-specific prebuilt binary, or fall back to `go run` in dev. */
export function resolveEngine(): { command: string; prefixArgs: string[] } {
  const exe = process.platform === "win32" ? ".exe" : "";
  const binaryName = `ytube-${process.platform}-${process.arch}${exe}`;
  const candidates = [
    join(repoRoot, "bin", binaryName),
    join(repoRoot, "bin", `ytube${exe}`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: candidate, prefixArgs: [] };
  }
  // Development fallback: requires a Go toolchain.
  return { command: "go", prefixArgs: ["run", "./cmd/ytube"] };
}

export interface RunOptions {
  timeoutMs?: number;
}

/** Invoke a ytube command and return its parsed `data` payload. */
export async function runEngine<T>(
  command: string,
  flags: Record<string, string | number | undefined | null>,
  options: RunOptions = {},
): Promise<T> {
  const { command: bin, prefixArgs } = resolveEngine();
  const args = [...prefixArgs, command];
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined && value !== null && value !== "") {
      args.push(`--${key}`, String(value));
    }
  }

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd: repoRoot,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, out, stderr) => {
        // The engine exits non-zero on extraction errors but still prints
        // a structured JSON error on stdout, which takes priority.
        if (out.trim().length > 0) return resolve(out);
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return reject(
              new YtubeError({
                code: "ENGINE_NOT_FOUND",
                message:
                  "The ytube extraction binary was not found and no Go toolchain is available. Run `npm run build:go` or install Go.",
                retryable: false,
              }),
            );
          }
          if (error.killed) {
            return reject(
              new YtubeError({
                code: "ENGINE_TIMEOUT",
                message: `The extraction engine did not respond within ${options.timeoutMs ?? 120_000}ms.`,
                retryable: true,
              }),
            );
          }
          return reject(
            new YtubeError({
              code: "ENGINE_CRASH",
              message: `The extraction engine failed: ${stderr || error.message}`,
              retryable: false,
            }),
          );
        }
        resolve(out);
      },
    );
  });

  let parsed: { ok: boolean; data?: T; error?: EngineError };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new YtubeError({
      code: "ENGINE_PROTOCOL_ERROR",
      message: `The extraction engine returned unparseable output: ${stdout.slice(0, 300)}`,
      retryable: false,
    });
  }
  if (!parsed.ok || parsed.data === undefined) {
    throw new YtubeError(
      parsed.error ?? {
        code: "UNKNOWN_ERROR",
        message: "The extraction engine reported failure without details.",
        retryable: false,
      },
    );
  }
  return parsed.data;
}
