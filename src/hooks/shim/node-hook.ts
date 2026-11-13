/**
 * The Node fallback for mex-hook. It runs when the native binary is missing or
 * fails its self-test, and must behave the same way: always exit 0 and always
 * write one valid JSON reply. Keep imports minimal — this file starts on every
 * hook call when there is no binary.
 */

const MAX_PAYLOAD = 8 << 20;
const READ_TIMEOUT_MS = 2_000;
const EMPTY_REPLY = "{}\n";

export interface NodeHookIO {
  stdin: NodeJS.ReadableStream | null;
  write: (text: string) => void;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Reads up to MAX_PAYLOAD bytes, drains the rest, and gives up after the timeout. */
export function readPayload(stdin: NodeJS.ReadableStream | null, timeoutMs = READ_TIMEOUT_MS): Promise<Buffer | null> {
  if (!stdin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (size < MAX_PAYLOAD) chunks.push(buf.subarray(0, MAX_PAYLOAD - size));
      size += buf.length;
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    stdin.on("data", onData);
    stdin.once("end", () => finish(Buffer.concat(chunks)));
    stdin.once("error", () => finish(null));
  });
}

/** Handles one hook call. Never throws; the exit code is always 0. */
export async function runNodeHook(io: NodeHookIO): Promise<0> {
  try {
    if (io.env.MEX_BACKGROUND === "1") {
      io.write(EMPTY_REPLY);
      return 0;
    }
    await readPayload(io.stdin, io.timeoutMs);
    io.write(EMPTY_REPLY);
  } catch {
    try {
      io.write(EMPTY_REPLY);
    } catch {
      // stdout is gone; nothing left to do.
    }
  }
  return 0;
}
