import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { boundedCandidateMessage } from "../candidate-protocol.js";
import { createGraphCandidateProgressSender } from "../candidate-progress.js";
import { runGraphCandidateProcess } from "../candidate-process.js";
import { GRAPH_CORPUS_LIMITS } from "../corpus-policy.js";
import { createGraphEngine } from "../engine-impl.js";
import { rebuildGraph, refreshGraph, type GraphMaintenanceExecutionOptions } from "../maintenance.js";
import { openSqlite } from "../db/sqlite.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const roots: string[] = [];
const children = new Set<ChildProcess>();
let bundleDir: string;
let realEntry: string;
let busyEntry: string;
let crashEntry: string;
let lateEntry: string;
let disconnectedEntry: string;
let parentEntry: string;

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "mex-candidate-process-test-"));
  roots.push(path);
  mkdirSync(join(path, ".mex"));
  writeFileSync(join(path, "service.py"), "def service():\n    return 1\n");
  return path;
}

async function bundle(name: string, source: string): Promise<string> {
  const outfile = join(bundleDir, `${name}.mjs`);
  await build({
    stdin: { contents: source, resolveDir: repository, sourcefile: `${name}.ts`, loader: "ts" },
    outfile, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", logLevel: "silent",
  });
  return outfile;
}

beforeAll(async () => {
  // The temporary bundle lives under node_modules so external runtime imports
  // resolve exactly as in an installation, without a TS loader in the child.
  const cache = join(repository, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  bundleDir = mkdtempSync(join(cache, "mex-candidate-tests-"));
  cpSync(join(repository, "src/graph/schema.sql"), join(bundleDir, "schema.sql"));
  cpSync(join(repository, "src/graph/wasm"), join(bundleDir, "wasm"), { recursive: true });
  realEntry = await bundle("real", 'import "./src/graph/candidate-entry.ts";');
  const prefix = `
    import { startGraphCandidateWatchdog } from "./src/graph/candidate-watchdog.ts";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { DatabaseSync } from "node:sqlite";
    await startGraphCandidateWatchdog();
    process.once("message", (request) => {
      const spool = join(request.workspace, "spool");
      mkdirSync(spool);
      writeFileSync(join(spool, "source"), "private temporary source");
  `;
  const suffix = '}); process.send({ type: "ready" });';
  busyEntry = await bundle("busy", prefix + `
    process.on("SIGTERM", () => {});
    process.send({ type: "progress", progress: { phase: "parse", completed: 1, total: 2 } });
    for (;;) Math.sqrt(Math.random());
  ` + suffix);
  crashEntry = await bundle("crash", prefix + `
    const db = new DatabaseSync(request.candidatePath);
    db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE candidate_crash (value TEXT); INSERT INTO candidate_crash VALUES ('unpublished');");
    process.kill(process.pid, "SIGKILL");
  ` + suffix);
  lateEntry = await bundle("late", prefix + `
    process.on("SIGTERM", () => {});
    process.send({ type: "progress", progress: { phase: "parse", completed: 1, total: 1 } });
    process.send({ type: "complete", result: { filesIndexed: 1, nodesCreated: 1, edgesCreated: 0, durationMs: 1 } });
    for (;;) Math.sqrt(Math.random());
  ` + suffix);
  disconnectedEntry = await bundle("disconnected", prefix + `
    process.on("SIGTERM", () => {});
    process.send({ type: "progress", progress: { phase: "parse", completed: 1, total: 2 } });
    process.disconnect();
    setImmediate(() => { for (;;) Math.sqrt(Math.random()); });
  ` + suffix);
  parentEntry = await bundle("parent", `
    import { runGraphCandidateProcess } from "./src/graph/candidate-process.ts";
    await runGraphCandidateProcess({
      projectRoot: process.argv[2], candidatePath: process.argv[3], operation: "rebuild",
      onProgress: () => process.send({ type: "busy" }),
      __internal: { entrypoint: process.argv[4], onSpawn: (pid, workspace) => process.send({ type: "spawned", pid, workspace }) },
    });
  `);
}, 30_000);

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
afterAll(() => { if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }); });

function hash(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function artifacts(path: string): string[] {
  return readdirSync(join(path, ".mex")).filter((name) => name.startsWith("graph.db.") || name === "graph.db.lock");
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function baseline(path: string): Promise<string> {
  const engine = createGraphEngine({ rootDir: path });
  try { await engine.build(); } finally { engine.close(); }
  return join(path, ".mex/graph.db");
}
/**
 * Give a refresh something to publish. A refresh with nothing to publish
 * returns before any candidate exists (issue #209), and these tests exercise
 * the candidate process itself.
 */
function pendingChange(path: string): void {
  writeFileSync(join(path, "service.py"), "def service():\n    return 2\n");
}
function isolated(entrypoint: string, extra: Record<string, unknown> = {}): GraphMaintenanceExecutionOptions {
  return { candidateExecution: "process", __internal: { candidateProcess: { entrypoint, ...extra } } } as GraphMaintenanceExecutionOptions;
}

describe("isolated graph candidate construction", () => {
  it("builds and refreshes a real candidate with numeric progress and a closed, valid published database", async () => {
    const path = root();
    const progress: string[] = [];
    const built = await rebuildGraph(path, { ...isolated(realEntry), onProgress: (value) => progress.push(value.phase) });
    expect(built.state).toBe("succeeded");
    expect(built.status.status).toBe("fresh");
    expect(progress).toContain("parse");
    expect(progress).toContain("resolve");
    writeFileSync(join(path, "service.py"), "def service():\n    return 2\n\ndef next_service():\n    return service()\n");
    const refreshed = await refreshGraph(path, isolated(realEntry));
    expect(refreshed.filesIndexed).toBe(1);
    expect(refreshed.status.status).toBe("fresh");
    const db = openSqlite(join(path, ".mex/graph.db"), { readOnly: true });
    try {
      expect(db.prepare("PRAGMA quick_check").get()).toMatchObject({ quick_check: "ok" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM nodes WHERE name = 'next_service'").all()).toHaveLength(1);
    } finally { db.close(); }
    expect(artifacts(path)).toEqual([]);
  });

  it("publishes rebuild and refresh candidates with an oversized-file gap and cleans their child workspaces", async () => {
    const path = root();
    const filler = `# ${"x".repeat(120)}\n`;
    writeFileSync(join(path, "generated.py"), "def oversized():\n    return True\n"
      + filler.repeat(Math.ceil(GRAPH_CORPUS_LIMITS.maxSourceFileBytes / filler.length) + 1));
    const spawned: Array<{ pid: number; workspace: string }> = [];
    const options = isolated(realEntry, {
      onSpawn: (pid: number, workspace: string) => { spawned.push({ pid, workspace }); },
    });

    for (const operation of ["rebuild", "refresh"] as const) {
      if (operation === "refresh") {
        writeFileSync(join(path, "service.py"), "def service():\n    return 2\n\ndef next_service():\n    return service()\n");
      }
      const result = await (operation === "rebuild" ? rebuildGraph : refreshGraph)(path, options);
      expect(result.state).toBe("succeeded");
      expect(result.filesIndexed).toBe(1);
      expect(result.skipped).toEqual([expect.objectContaining({
        filePath: "generated.py", reason: "corpus-limit", limit: "maxSourceFileBytes",
      })]);
      expect(result.status.changes.total).toBe(0);
      expect(result.status.diagnostics).toContainEqual(expect.objectContaining({
        code: "GRAPH_SOURCE_FILE_SKIPPED", path: "generated.py",
      }));
      const db = openSqlite(join(path, ".mex/graph.db"), { readOnly: true });
      try {
        const symbol = operation === "rebuild" ? "service" : "next_service";
        expect(db.prepare("SELECT name FROM nodes WHERE name = ?").all(symbol)).toEqual([{ name: symbol }]);
        expect(db.prepare("SELECT name FROM nodes WHERE name = 'oversized'").all()).toEqual([]);
        expect(db.prepare("PRAGMA quick_check").get()).toMatchObject({ quick_check: "ok" });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { db.close(); }
      expect(spawned).toHaveLength(operation === "rebuild" ? 1 : 2);
      expect(processAlive(spawned.at(-1)!.pid)).toBe(false);
      expect(existsSync(spawned.at(-1)!.workspace)).toBe(false);
      expect(artifacts(path)).toEqual([]);
    }
  }, 60_000);

  it("cancels real synchronous busy work, waits for process death, and preserves the prior index", async () => {
    const path = root();
    const database = await baseline(path);
    pendingChange(path);
    const before = hash(database);
    const controller = new AbortController();
    let pid = 0;
    let workspace = "";
    let ticks = 0;
    const interval = setInterval(() => ticks++, 10);
    try {
      await expect(refreshGraph(path, {
        ...isolated(busyEntry, { onSpawn: (childPid: number, directory: string) => { pid = childPid; workspace = directory; } }),
        signal: controller.signal,
        onProgress: (value) => { if (value.phase === "parse") setTimeout(() => controller.abort(), 50); },
      })).rejects.toMatchObject({ code: "GRAPH_MAINTENANCE_CANCELLED" });
    } finally { clearInterval(interval); }
    expect(ticks).toBeGreaterThan(2);
    expect(processAlive(pid)).toBe(false);
    expect(existsSync(workspace)).toBe(false);
    expect(hash(database)).toBe(before);
    expect(artifacts(path)).toEqual([]);
  });

  it("cleans the spool and SQLite sidecars after an abrupt child death during an open write transaction", async () => {
    const path = root();
    const database = await baseline(path);
    pendingChange(path);
    const before = hash(database);
    let workspace = "";
    await expect(refreshGraph(path, isolated(crashEntry, {
      onSpawn: (_pid: number, directory: string) => { workspace = directory; },
    }))).rejects.toMatchObject({ category: "failed" });
    expect(existsSync(workspace)).toBe(false);
    expect(hash(database)).toBe(before);
    expect(artifacts(path)).toEqual([]);
  });

  it("preserves a replacement workspace instead of recursively deleting a directory it no longer owns", async () => {
    const path = root();
    const database = await baseline(path);
    pendingChange(path);
    const before = hash(database);
    const original = join(path, "original-candidate-workspace");
    let workspace = "";
    let replacementCreated = false;
    let pid = 0;
    try {
      await expect(refreshGraph(path, isolated(realEntry, {
        onSpawn(childPid: number, directory: string) {
          pid = childPid;
          workspace = directory;
          renameSync(directory, original);
          mkdirSync(directory);
          replacementCreated = true;
          writeFileSync(join(directory, "sentinel"), "replacement directory must survive");
        },
      }))).rejects.toMatchObject({ code: "GRAPH_MAINTENANCE_PATH_UNSAFE" });
      expect(processAlive(pid)).toBe(false);
      expect(readFileSync(join(workspace, "sentinel"), "utf8")).toBe("replacement directory must survive");
      expect(existsSync(original)).toBe(true);
      expect(hash(database)).toBe(before);
      expect(artifacts(path)).toEqual([]);
    } finally {
      // These are the two exact directories created/moved by this fixture;
      // production cleanup must have left the replacement entirely alone.
      if (replacementCreated) rmSync(workspace, { recursive: true, force: true });
      rmSync(original, { recursive: true, force: true });
    }
  });

  it("does not accept a completion message until the child exits, and cancellation forbids late success", async () => {
    const path = root();
    const controller = new AbortController();
    await expect(runGraphCandidateProcess({
      projectRoot: path, candidatePath: join(path, ".mex", `graph.db.candidate-${"a".repeat(48)}`), operation: "rebuild",
      signal: controller.signal,
      onProgress: () => setTimeout(() => controller.abort(), 50),
      __internal: { entrypoint: lateEntry },
    })).rejects.toMatchObject({ category: "cancelled" });
  });

  it("stops a child that loses IPC and keeps computing while its parent remains alive", async () => {
    const path = root();
    const database = await baseline(path);
    pendingChange(path);
    const before = hash(database);
    const controller = new AbortController();
    let pid = 0;
    let workspace = "";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(refreshGraph(path, {
        ...isolated(disconnectedEntry, { onSpawn: (value: number, directory: string) => { pid = value; workspace = directory; } }),
        signal: controller.signal,
        // The watchdog only detects parent death. Without explicit disconnect
        // handling this guard cancels the still-running child instead of the
        // supervisor reporting the expected protocol failure.
        onProgress: (value) => { if (value.phase === "parse") timeout = setTimeout(() => controller.abort(), 2000); },
      })).rejects.toMatchObject({ category: "failed" });
    } finally { if (timeout) clearTimeout(timeout); }
    expect(processAlive(pid)).toBe(false);
    expect(existsSync(workspace)).toBe(false);
    expect(hash(database)).toBe(before);
    expect(artifacts(path)).toEqual([]);
  });

  it("enforces its hang deadline even when the compiler thread ignores SIGTERM", async () => {
    const path = root();
    let pid = 0;
    await expect(runGraphCandidateProcess({
      projectRoot: path, candidatePath: join(path, ".mex", `graph.db.candidate-${"b".repeat(48)}`), operation: "rebuild",
      __internal: { entrypoint: busyEntry, buildTimeoutMs: 500, onSpawn: (value) => { pid = value; } },
    })).rejects.toMatchObject({ category: "failed" });
    expect(processAlive(pid)).toBe(false);
  });

  it("stops an orphaned busy compiler when its parent is killed without running cleanup", async () => {
    const path = root();
    const parent = spawn(process.execPath, [parentEntry, path, join(path, ".mex", `graph.db.candidate-${"c".repeat(48)}`), busyEntry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    children.add(parent);
    let pid = 0;
    let workspace = "";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Candidate did not start.")), 5000);
      parent.on("message", (raw) => {
        const message = raw as { type: string; pid?: number; workspace?: string };
        if (message.type === "spawned") { pid = message.pid!; workspace = message.workspace!; }
        if (message.type === "busy") { clearTimeout(timeout); resolve(); }
      });
      parent.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => parent.once("close", () => resolve()));
    parent.kill("SIGKILL");
    await closed;
    children.delete(parent);
    await expect.poll(() => processAlive(pid), { timeout: 5000, interval: 25 }).toBe(false);
    // A fatally killed parent cannot run finally. Its private workspace is
    // retained instead of deleting files while a Windows writer might be alive.
    expect(existsSync(workspace)).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects unbounded and non-allowlisted protocol values", () => {
    expect(boundedCandidateMessage({ type: "progress", progress: { phase: "parse", completed: 0, total: 0 } })).toBeNull();
    expect(boundedCandidateMessage({ type: "progress", progress: { phase: "parse", total: 10 } })).toBeNull();
    expect(boundedCandidateMessage({ type: "progress", progress: { phase: "parse", completed: 3, total: 2 } })).toBeNull();
    expect(boundedCandidateMessage({ type: "progress", progress: { phase: "parse", source: "private" } })).toBeNull();
    expect(boundedCandidateMessage({ type: "failed", category: "failed", stack: "private" })).toBeNull();
    expect(boundedCandidateMessage({ type: "complete", result: { filesIndexed: -1, nodesCreated: 0, edgesCreated: 0, durationMs: 0 } })).toBeNull();
    expect(boundedCandidateMessage({ type: "failed", category: "x".repeat(1024 * 1024) })).toBeNull();
  });

  it("sends throttled counts during synchronous work without requiring completion callbacks to run", () => {
    let now = 0;
    let blocked = false;
    const sent: number[] = [];
    const callbacks: Array<() => void> = [];
    const progress = createGraphCandidateProgressSender((value, done) => {
      sent.push(value.completed!);
      callbacks.push(done);
      return !blocked;
    }, () => now);
    progress({ phase: "parse", completed: 0, total: 10 });
    now = 100;
    progress({ phase: "parse", completed: 1, total: 10 });
    now = 300;
    progress({ phase: "parse", completed: 2, total: 10 });
    expect(sent).toEqual([0, 2]);
    blocked = true;
    now = 600;
    progress({ phase: "parse", completed: 3, total: 10 });
    now = 900;
    progress({ phase: "parse", completed: 4, total: 10 });
    expect(sent).toEqual([0, 2, 3]);
    callbacks.at(-1)!();
    blocked = false;
    now = 1200;
    progress({ phase: "parse", completed: 5, total: 10 });
    expect(sent).toEqual([0, 2, 3, 5]);
  });

  it.each([true, false])("sends a fast final parse count exactly once with channel writable=%s", (writable) => {
    let now = 0;
    const sent: Array<{ phase: string; completed?: number; total?: number }> = [];
    const progress = createGraphCandidateProgressSender((value) => {
      sent.push(value);
      return writable;
    }, () => now);
    progress({ phase: "parse", completed: 0, total: 3 });
    now = 10;
    progress({ phase: "parse", completed: 1, total: 3 });
    now = 20;
    progress({ phase: "parse", completed: 3, total: 3 });
    progress({ phase: "parse", completed: 3, total: 3 });
    progress({ phase: "resolve" });
    now = 1000;
    progress({ phase: "parse", completed: 3, total: 3 });
    expect(sent).toEqual([
      { phase: "parse", completed: 0, total: 3 },
      { phase: "parse", completed: 3, total: 3 },
      { phase: "resolve" },
    ]);
  });
});
