import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SetupError } from "./errors.js";
import { buildSetupGraph } from "./phases.js";

export const NEXT_GRAPH_FILE = ".mex/local/setup-next-graph.json";
const MAX_STATE_BYTES = 16_384;
export interface NextGraphState {
  version: 1;
  token: string;
  pid: number;
  startedAt: number;
  status: "running" | "ready" | "failed";
  completed: number;
  total: number;
  message?: string;
  diagnostic?: string;
}

function statePath(root: string): string {
  for (const part of [".mex", ".mex/local"]) {
    const path = resolve(root, part);
    const actual = realpathSync(path);
    const samePath = process.platform === "win32" ? actual.toLowerCase() === path.toLowerCase() : actual === path;
    if (lstatSync(path).isSymbolicLink() || !samePath) {
      throw new Error(`Unsafe setup graph state directory: ${part}. Correct the redirected path and rerun mex setup next.`);
    }
  }
  const path = resolve(root, NEXT_GRAPH_FILE);
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
    throw new Error(`Unsafe ${NEXT_GRAPH_FILE}. Correct the redirected path and rerun mex setup next.`);
  }
  return path;
}

export function readNextGraph(root: string): NextGraphState | null {
  const path = statePath(root);
  if (!existsSync(path)) return null;
  if (lstatSync(path).size > MAX_STATE_BYTES) throw new Error(`Oversized ${NEXT_GRAPH_FILE}; inspect and remove it, then run mex setup next --start.`);
  let value: NextGraphState;
  try { value = JSON.parse(readFileSync(path, "utf8")) as NextGraphState; }
  catch { throw new Error(`Invalid ${NEXT_GRAPH_FILE}; inspect and remove it, then run mex setup next --start.`); }
  if (!value || value.version !== 1 || typeof value.token !== "string" || value.token.length > 64
    || !Number.isSafeInteger(value.pid) || value.pid < 0 || !Number.isFinite(value.startedAt)
    || !["running", "ready", "failed"].includes(value.status)
    || !Number.isSafeInteger(value.completed) || value.completed < 0
    || !Number.isSafeInteger(value.total) || value.total < 0
    || (value.message !== undefined && typeof value.message !== "string")
    || (value.diagnostic !== undefined && typeof value.diagnostic !== "string")) {
    throw new Error(`Invalid ${NEXT_GRAPH_FILE}; inspect and remove it, then run mex setup next --start.`);
  }
  return value;
}

function writeState(root: string, state: NextGraphState): void {
  const path = statePath(root);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { flag: "wx", encoding: "utf8" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function boundedDetail(text: string, bytes: number): string {
  let tail = text.slice(-bytes).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
  while (Buffer.byteLength(JSON.stringify(tail)) > bytes) tail = tail.slice(Math.ceil(tail.length / 8));
  return tail;
}

/** Called only under setup-next's queue lock. The detached owner holds the ordinary graph lease. */
export async function ensureNextGraph(root: string, restartFailure = false): Promise<NextGraphState> {
  const previous = readNextGraph(root);
  if (previous?.status === "ready" || (previous?.status === "failed" && !restartFailure)) return previous;
  if (previous?.status === "running" && (previous.pid > 0 ? alive(previous.pid) : Date.now() - previous.startedAt < 15_000)) return previous;
  const state: NextGraphState = { version: 1, token: randomUUID(), pid: 0, startedAt: Date.now(),
    status: "running", completed: 0, total: 0 };
  if (previous?.status === "running") state.message = `The previous graph worker (pid ${previous.pid}) is gone; no exit status was recorded. Restarting its build; finished tasks are kept.`;
  writeState(root, state);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = [resolve(here, "setup-graph.js"), resolve(here, "../../dist/setup-graph.js")].find(existsSync);
    if (!entry) throw new Error("The setup graph worker is missing. Run npm run build from source or reinstall MEX, then run mex setup next --start.");
    const child = spawn(process.execPath, [entry, root, state.token], {
      cwd: root, detached: true, windowsHide: true, stdio: "ignore",
      env: { ...process.env, MEX_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    });
    await new Promise<void>((accept, reject) => { child.once("spawn", accept); child.once("error", reject); });
    state.pid = child.pid!;
    writeState(root, state);
    child.unref();
    return state;
  } catch (error) {
    state.status = "failed";
    state.message = `The background graph worker could not start. Rebuild MEX from source or check Node execution permissions, then run mex setup next --start.`;
    state.diagnostic = boundedDetail(String(error), 8192);
    writeState(root, state);
    return state;
  }
}

/** Private executable: progress and terminal outcome survive the invoking CLI. */
export async function runNextGraphWorker(root: string, token: string): Promise<void> {
  let state = readNextGraph(root);
  if (!state || state.token !== token || state.status !== "running") return;
  // The launching process records the PID before this worker writes anything.
  // This handshake prevents its initial record overwriting fast progress/outcomes.
  for (let attempt = 0; state.pid === 0 && attempt < 1500; attempt++) {
    await new Promise((accept) => setTimeout(accept, 10));
    state = readNextGraph(root);
    if (!state || state.token !== token || state.status !== "running") return;
  }
  if (state.pid !== process.pid) return;
  state.pid = process.pid;
  const save = () => { if (readNextGraph(root)?.token === token) writeState(root, state!); };
  try {
    // A killed predecessor's child may still be closing SQLite handles. Its lease
    // remains authoritative until maintenance can reclaim it safely.
    for (let attempt = 0; ; attempt++) {
      try {
        await buildSetupGraph(root, { background: true, onProgress: (progress) => {
          if (progress.total !== undefined) state!.total = progress.total;
          if (progress.completed !== undefined) state!.completed = progress.completed;
          // Progress is advisory. A reader/rename collision must not terminate
          // the graph worker; the terminal outcome is persisted separately.
          try { save(); } catch { /* the next update retries */ }
        } });
        break;
      } catch (error) {
        const cause = error instanceof SetupError ? error.cause : error;
        if (attempt >= 30 || !(cause instanceof Error) || !("code" in cause) || cause.code !== "GRAPH_MAINTENANCE_LOCKED") throw error;
        await new Promise((accept) => setTimeout(accept, 1_000));
      }
    }
    state.status = "ready";
  } catch (error) {
    state.status = "failed";
    state.message = boundedDetail(error instanceof SetupError ? error.userMessage : String(error), 2048);
    state.diagnostic = boundedDetail(error instanceof Error ? error.message : String(error), 8192);
  }
  for (let attempt = 0; ; attempt++) {
    try { save(); break; }
    catch (error) {
      if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise((accept) => setTimeout(accept, 100));
    }
  }
}
