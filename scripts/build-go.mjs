#!/usr/bin/env node
/**
 * Cross-compile the Go extraction engine into bin/ for every supported
 * platform. Requires a Go toolchain (https://go.dev/dl/).
 *
 *   node scripts/build-go.mjs          # build all targets
 *   node scripts/build-go.mjs --host   # build only the current platform
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "bin");
mkdirSync(binDir, { recursive: true });

const allTargets = [
  { goos: "darwin", goarch: "arm64" },
  { goos: "darwin", goarch: "amd64" },
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
  { goos: "windows", goarch: "amd64" },
];

const nodePlatform = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
const nodeArch = { arm64: "arm64", x64: "amd64" }[process.arch];
const hostOnly = process.argv.includes("--host");
const targets = hostOnly
  ? allTargets.filter((t) => t.goos === nodePlatform && t.goarch === nodeArch)
  : allTargets;

try {
  execFileSync("go", ["version"], { stdio: "pipe" });
} catch {
  console.error("error: the Go toolchain is required to build the extraction engine. Install it from https://go.dev/dl/");
  process.exit(1);
}

for (const { goos, goarch } of targets) {
  // Node's process.platform/arch naming so go-bridge.ts can resolve directly.
  const platformName = goos === "windows" ? "win32" : goos;
  const archName = goarch === "amd64" ? "x64" : goarch;
  const suffix = goos === "windows" ? ".exe" : "";
  const output = join(binDir, `ytube-${platformName}-${archName}${suffix}`);
  console.log(`building ${output}`);
  execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "./cmd/ytube"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
  });
}
console.log("done");
