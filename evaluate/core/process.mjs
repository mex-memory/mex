import { spawn, spawnSync } from "node:child_process";
import crossSpawn from "cross-spawn";

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function outputLimitError(stream, maxOutputBytes) {
  const error = new Error(`${stream} exceeded ${maxOutputBytes} bytes`);
  error.code = "EVAL_OUTPUT_LIMIT";
  return error;
}

/** Run a process with bounded output and complete failure telemetry. */
export function runProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const child = (options.resolveShims ? crossSpawn : spawn)(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: options.killProcessTree && process.platform !== "win32",
    });
    const kill = (signal) => {
      if (!options.killProcessTree || !child.pid) { child.kill(signal); return; }
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; } }
    };
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let outputError = null;
    let timer;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxOutputBytes) {
        outputError ??= outputLimitError("stdout", maxOutputBytes);
        kill("SIGTERM");
        return;
      }
      stdout += chunk;
      try { options.onStdout?.(chunk); } catch (error) { outputError ??= error; kill("SIGTERM"); }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxOutputBytes) {
        outputError ??= outputLimitError("stderr", maxOutputBytes);
        kill("SIGTERM");
        return;
      }
      stderr += chunk;
    });

    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: [command, ...args],
        code: code ?? 1,
        signal: signal ?? null,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        timedOut,
        error: outputError ?? error ?? null,
        elapsedMs: Math.round(performance.now() - started),
      });
    };

    child.on("error", (error) => finish(1, null, error));
    child.on("close", (code, signal) => finish(code, signal));
    if (options.stdin !== undefined) {
      child.stdin.on("error", () => { /* early agent exit is reported by close */ });
      child.stdin.end(options.stdin);
    }
    timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => { if (!settled) kill("SIGKILL"); }, 1_000).unref();
    }, options.timeoutMs ?? 300_000);
  });
}

/** Small synchronous helper for preparation/provenance commands. */
export function runProcessSync(command, args = [], options = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.encoding === null ? null : "utf8",
    input: options.stdin,
    maxBuffer: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    timeout: options.timeoutMs,
  });
  return {
    command: [command, ...args],
    code: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? (options.encoding === null ? Buffer.alloc(0) : ""),
    stderr: result.stderr ?? (options.encoding === null ? Buffer.alloc(0) : ""),
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error ?? null,
    elapsedMs: Math.round(performance.now() - started),
  };
}

export function assertProcessSucceeded(result, label = "command") {
  if (result.timedOut) throw new Error(`${label} timed out`);
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout).trim();
    throw new Error(`${label} exited ${result.code}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}
