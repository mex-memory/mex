/**
 * Finds the native mex-hook binary for this machine and proves it runs.
 * When it can't, callers use the Node fallback (dist/hook.js) instead.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const SUPPORTED: ReadonlySet<string> = new Set([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
]);

const SELF_TEST_TIMEOUT_MS = 3_000;

/** The npm package that carries the binary for a platform, or null if there is none. */
export function platformPackageName(platform: string = process.platform, arch: string = process.arch): string | null {
  const key = `${platform}-${arch}`;
  return SUPPORTED.has(key) ? `mex-agent-hook-${key}` : null;
}

export function binaryFileName(platform: string = process.platform): string {
  return platform === "win32" ? "mex-hook.exe" : "mex-hook";
}

export interface FindBinaryOptions {
  platform?: string;
  arch?: string;
  /** Resolves a package specifier to a file path; defaults to Node's resolver. */
  resolve?: (specifier: string) => string;
}

/** Path to the installed binary, or null when its package or file is missing. */
export function findNativeBinary(options: FindBinaryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const pkg = platformPackageName(platform, options.arch ?? process.arch);
  if (!pkg) return null;
  const resolve = options.resolve ?? createRequire(import.meta.url).resolve;
  let manifest: string;
  try {
    manifest = resolve(`${pkg}/package.json`);
  } catch {
    return null;
  }
  const bin = join(dirname(manifest), "bin", binaryFileName(platform));
  return existsSync(bin) ? bin : null;
}

export interface SelfTestResult {
  ok: boolean;
  version?: string;
  error?: string;
}

/** Runs `<binary> --self-test` and checks it reported ok. */
export function selfTestBinary(path: string, timeoutMs = SELF_TEST_TIMEOUT_MS): SelfTestResult {
  const res = spawnSync(path, ["--self-test"], {
    input: "",
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, MEX_BACKGROUND: "1" },
  });
  if (res.error) return { ok: false, error: res.error.message };
  if (res.status !== 0) return { ok: false, error: `exit code ${res.status ?? res.signal}` };
  try {
    const parsed = JSON.parse(res.stdout) as { ok?: unknown; version?: unknown; error?: unknown };
    if (parsed.ok === true) return { ok: true, version: String(parsed.version ?? "") };
    return { ok: false, error: typeof parsed.error === "string" ? parsed.error : "self-test did not report ok" };
  } catch {
    return { ok: false, error: "self-test output is not JSON" };
  }
}

export type HookRunner =
  | { kind: "native"; path: string; version: string }
  | { kind: "node"; reason: string };

export interface ResolveRunnerOptions extends FindBinaryOptions {
  /** Use this binary instead of looking one up (tests, and a binary already copied to ~/.mex/bin). */
  binary?: string;
  selfTest?: (path: string) => SelfTestResult;
}

/** Picks the native binary when it is present and passes its self-test, else the Node path. */
export function resolveHookRunner(options: ResolveRunnerOptions = {}): HookRunner {
  const path = options.binary ?? findNativeBinary(options);
  if (!path) return { kind: "node", reason: "no native binary for this platform" };
  if (!existsSync(path)) return { kind: "node", reason: `binary missing: ${path}` };
  const result = (options.selfTest ?? selfTestBinary)(path);
  if (!result.ok) return { kind: "node", reason: `self-test failed: ${result.error ?? "unknown"}` };
  return { kind: "native", path, version: result.version ?? "" };
}
