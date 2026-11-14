import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A hang guard, not a performance promise for a particular repository.
const DETECT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface DriftDetectionProcessOptions {
  entrypoint?: string;
  timeoutMs?: number;
}

/** Bundled code uses the sibling file; source-based tests and dev use the build. */
export function privateEntrypoint(name: "drift-detect" | "drift-alert"): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = [resolve(here, `${name}.js`), resolve(here, `../../dist/${name}.js`)].find(existsSync);
  if (!entry) throw new Error(`The ${name} worker is missing. Run npm run build from source or reinstall MEX.`);
  return entry;
}

/**
 * The drift check reads files and runs Git synchronously, and takes tens of
 * seconds on a large repository with a stale graph. A private process keeps
 * the Hub's event loop serving requests meanwhile. Resolves with the parsed
 * output; the caller validates it.
 */
export function runDriftDetectionProcess(
  projectRoot: string,
  options: DriftDetectionProcessOptions = {},
): Promise<unknown> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [options.entrypoint ?? privateEntrypoint("drift-detect"), projectRoot], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, MEX_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill();
    };
    const timer = setTimeout(() => stop(new Error("The drift detector timed out.")), options.timeoutMs ?? DETECT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop(new Error("The drift detector returned too much output."));
      else chunks.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`The drift detector exited with code ${code}.`));
      try {
        accept(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("The drift detector returned unreadable output."));
      }
    });
  });
}
