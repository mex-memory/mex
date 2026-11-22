import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runGraphStatus } from "../cli-status.js";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { GRAPH_ENGINE_ENV, graphEngineBinary } from "../native-engine.js";
import { graphLocation, openCurrentGraph, readGraphPointer } from "../storage.js";
import { openWarmCheckout } from "../warm.js";

const native = graphEngineBinary();
const wasi = resolve("dist/mex-graph.wasm");
const temporaries: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of temporaries.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function fixture(language: "py" | "ts" = "py"): string {
  const root = mkdtempSync(join(tmpdir(), "mex-m6-"));
  temporaries.push(root);
  const sources = language === "py"
    ? "def helper():\n    return 42\n\ndef caller():\n    return helper()\n"
    : "export function helper() { return 42; }\nexport function caller() { return helper(); }\n";
  writeFileSync(join(root, `code.${language}`), sources);
  return root;
}

it.skipIf(!native)("reads a v4 publication and upgrades it to the v5 default on refresh", async () => {
  const root = fixture();
  vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
  expect((await rebuildGraph(root)).status).toMatchObject({ schemaVersion: 4, engineRuntime: "native" });
  const v4 = openCurrentGraph(root)!;
  try { expect(v4.prepare("SELECT name FROM nodes WHERE name = 'helper'").get()).toEqual({ name: "helper" }); }
  finally { v4.close(); }
  vi.stubEnv("MEX_GRAPH_STORAGE", undefined);
  vi.stubEnv("MEX_GRAPH_ENGINE_LANGUAGES", undefined);
  const updated = await refreshGraph(root);
  expect(updated.status).toMatchObject({ schemaVersion: 5, engineRuntime: "native" });
  expect(updated.engine).toMatchObject({ languages: ["python"], files: 1, fallbackFiles: 0 });
});

it("shows a Health warning when there is no usable engine for a Python-only checkout", async () => {
  const root = fixture();
  vi.stubEnv(GRAPH_ENGINE_ENV, join(root, "missing.wasm"));
  const result = await rebuildGraph(root);
  expect(result.status).toMatchObject({ schemaVersion: 4, engineRuntime: "node" });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await runGraphStatus({ root });
  expect(log).toHaveBeenCalledWith("Graph engine: Node tree-sitter");
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/^WARNING GRAPH_ENGINE_FALLBACK: .*no mex-graph binary was found/u));
});

it.skipIf(!existsSync(wasi) || process.platform === "win32")("uses WASI after a blocked native executable and refreshes in one shot", async () => {
  const root = fixture();
  const blocked = join(root, "blocked-mex-graph");
  writeFileSync(blocked, "blocked", { mode: 0o600 });
  vi.stubEnv(GRAPH_ENGINE_ENV, blocked);
  const result = await rebuildGraph(root);
  expect(result.status).toMatchObject({ schemaVersion: 5, engineRuntime: "wasi" });
  expect(result.status.diagnostics).toContainEqual(expect.objectContaining({
    code: "GRAPH_ENGINE_WASI", message: expect.stringContaining("could not be executed"),
  }));
  expect(result.engine).toMatchObject({ cpuMs: expect.any(Number), peakRssMb: expect.any(Number) });
  await expect(openWarmCheckout(root)).rejects.toThrow();
  writeFileSync(join(root, "code.py"), "def helper():\n    return 7\n");
  const refreshed = await refreshGraph(root);
  expect(refreshed.status).toMatchObject({ schemaVersion: 5, engineRuntime: "wasi" });
  expect(refreshed.refresh).toMatchObject({ publication: "delta", filesReextracted: 1 });
});

it.skipIf(process.platform === "win32").each(["engine", "parent", "both processes"])("recovers an interrupted candidate after SIGKILL of the %s", async (target) => {
  const root = fixture("ts");
  await rebuildGraph(root);
  const location = graphLocation(root);
  const prior = readGraphPointer(location);
  const engine = join(root, "controlled-engine");
  const marker = join(root, "engine-pid");
  // Hold an unpublished candidate with its sidecars until killed. This makes
  // the interruption deterministic regardless of engine or filesystem speed.
  writeFileSync(engine, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "version") {
  console.log(JSON.stringify({ engine: "mex-graph", version: "0.1.0", contract: 3 }));
} else {
  const request = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  process.stdin.once("data", () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.writeFileSync(request.output + suffix, "partial");
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.pid));
  });
  process.stdin.resume();
}
`, { mode: 0o700 });
  const proc = spawn(process.execPath, [resolve("dist/cli.js"), "graph", "rebuild", "--root", root, "--json"], {
    env: { ...process.env, [GRAPH_ENGINE_ENV]: engine, MEX_GRAPH_STORAGE: "v5", MEX_BACKGROUND: "0" },
    stdio: "ignore",
  });
  const closed = once(proc, "close");
  let enginePid: number | undefined;
  try {
    await vi.waitFor(() => {
      enginePid = JSON.parse(readFileSync(marker, "utf8")) as number;
      expect(readdirSync(location.directory).some(name => /^graph-tmp-.*\.db-wal$/u.test(name))).toBe(true);
    }, { timeout: 10_000 });
    if (target !== "engine") proc.kill("SIGKILL");
    if (target !== "parent") process.kill(enginePid!, "SIGKILL");
    const [exit, signal] = await closed;
    if (target === "engine") expect(exit).toBe(1);
    else expect(signal).toBe("SIGKILL");
    expect(readGraphPointer(location)).toEqual(prior);
    if (target === "engine") {
      expect(readdirSync(location.directory).filter(name => name === "graph.lock" || name.startsWith("graph-tmp-"))).toEqual([]);
    }
    const retried = await rebuildGraph(root);
    expect(retried.state).toBe("succeeded");
    expect(readdirSync(location.directory).filter(name => name === "graph.lock" || name.startsWith("graph-tmp-"))).toEqual([]);
  } finally {
    proc.kill("SIGKILL");
    if (enginePid) {
      try { process.kill(enginePid, "SIGKILL"); } catch { /* already exited */ }
    }
    await closed;
  }
}, 30_000);
