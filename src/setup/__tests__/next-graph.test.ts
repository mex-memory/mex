import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureNextGraph, NEXT_GRAPH_FILE, readNextGraph, runNextGraphWorker, type NextGraphState } from "../next-graph.js";
import { buildSetupGraph } from "../phases.js";
import { spawn } from "node:child_process";
import { SetupError } from "../errors.js";

vi.mock("../phases.js", () => ({ buildSetupGraph: vi.fn(async () => undefined) }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync), existsSync: (path: string) => path.endsWith("setup-graph.js") || fs.existsSync(path) };
});
vi.mock("node:child_process", () => ({ spawn: vi.fn(() => {
  const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
  queueMicrotask(() => child.emit("spawn"));
  return child;
}) }));

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-next-graph-")); roots.push(root);
  mkdirSync(join(root, ".mex/local"), { recursive: true });
  return root;
}

it("starts one detached owner, reuses it, and saves its progress and terminal result", async () => {
  const root = fixture();
  const state = await ensureNextGraph(root);
  expect(state.status).toBe("running");
  expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ detached: true, windowsHide: true, stdio: "ignore" }));
  await ensureNextGraph(root);
  expect(spawn).toHaveBeenCalledTimes(1);
  vi.mocked(buildSetupGraph).mockImplementationOnce(async (_root, options) => {
    options?.onProgress?.({ phase: "parse", completed: 4, total: 9, message: "Parsing" });
    expect(readNextGraph(root)).toMatchObject({ completed: 4, total: 9, status: "running" });
  });
  await runNextGraphWorker(root, state.token);
  expect(readNextGraph(root)?.status).toBe("ready");
  await ensureNextGraph(root);
  expect(spawn).toHaveBeenCalledTimes(1);
});

it.skipIf(process.platform !== "win32")("accepts ordinary Windows path casing", async () => {
  const root = fixture();
  const state = await ensureNextGraph(root.toUpperCase());
  expect(state.status).toBe("running");
  expect(readNextGraph(root)?.token).toBe(state.token);
});

it("takes over a dead owner and never lets its old token overwrite the replacement", async () => {
  const root = fixture();
  const old: NextGraphState = { version: 1, token: "old", pid: 2147483647, startedAt: 0,
    status: "running", completed: 3, total: 9 };
  writeFileSync(join(root, NEXT_GRAPH_FILE), JSON.stringify(old));
  const replacement = await ensureNextGraph(root);
  expect(replacement.token).not.toBe("old");
  expect(replacement.message).toContain("previous graph worker");
  await runNextGraphWorker(root, "old");
  expect(buildSetupGraph).not.toHaveBeenCalled();
  expect(readNextGraph(root)?.token).toBe(replacement.token);
});

it("retains bounded failure diagnostics and restarts only on explicit retry", async () => {
  const root = fixture(); const state = await ensureNextGraph(root);
  vi.mocked(buildSetupGraph).mockRejectedValueOnce(new Error("x".repeat(20000) + "signal SIGKILL"));
  await runNextGraphWorker(root, state.token);
  const failed = readNextGraph(root)!;
  expect(failed.status).toBe("failed");
  expect(failed.diagnostic!.length).toBeLessThanOrEqual(8192);
  expect(failed.diagnostic).toContain("SIGKILL");
  expect(readFileSync(join(root, NEXT_GRAPH_FILE)).length).toBeLessThan(16_384);
  await ensureNextGraph(root); expect(spawn).toHaveBeenCalledTimes(1);
  await ensureNextGraph(root, true); expect(spawn).toHaveBeenCalledTimes(2);
});

it("waits for a predecessor's live graph lease before retrying maintenance", async () => {
  const root = fixture(); const state = await ensureNextGraph(root);
  vi.mocked(buildSetupGraph).mockRejectedValueOnce(new SetupError("busy", {
    cause: Object.assign(new Error("busy"), { code: "GRAPH_MAINTENANCE_LOCKED" }), userMessage: "Wait for the graph lock",
  }));
  vi.useFakeTimers();
  const pending = runNextGraphWorker(root, state.token);
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(buildSetupGraph).toHaveBeenCalledTimes(2);
  expect(readNextGraph(root)?.status).toBe("ready");
});

it.each(["null", "[]", "{broken", JSON.stringify({ version: 1, token: "x", pid: "wrong" })])("rejects invalid durable state with a recovery command: %s", (text) => {
  const root = fixture(); writeFileSync(join(root, NEXT_GRAPH_FILE), text);
  expect(() => readNextGraph(root)).toThrow("mex setup next --start");
});

it("does not turn a busy progress file into a graph failure and retries the terminal write", async () => {
  const root = fixture(); const state = await ensureNextGraph(root);
  vi.mocked(buildSetupGraph).mockImplementationOnce(async (_root, options) => {
    vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error("busy progress"), { code: "EPERM" }); });
    options?.onProgress?.({ phase: "parse", completed: 7, total: 9, message: "Parsing" });
    vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error("busy outcome"), { code: "EBUSY" }); });
  });
  vi.useFakeTimers();
  const pending = runNextGraphWorker(root, state.token);
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(readNextGraph(root)).toMatchObject({ status: "ready", completed: 7, total: 9 });
});
