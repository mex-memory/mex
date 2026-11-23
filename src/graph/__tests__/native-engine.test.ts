import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createGraphEngine } from "../engine-impl.js";
import { rebuildGraph } from "../maintenance.js";
import { GRAPH_ENGINE_CONTRACT, graphEngineBinary, graphEngineVersion, runGraphEngine, type EngineEvent } from "../native-engine.js";

/**
 * The Node side of the Rust engine's contract. Runs only where an engine is
 * built (`cargo build` in native/engine, or MEX_GRAPH_ENGINE); the Rust job
 * tests cover the engine's side on every OS.
 */
const binary = graphEngineBinary();
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());

function fixture(): { root: string; index: string } {
  const dir = mkdtempSync(join(tmpdir(), "mex-native-engine-"));
  dirs.push(dir);
  const root = join(dir, "repo"); const index = join(dir, "index");
  mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(index);
  writeFileSync(join(root, "src", "app.py"), "def main():\n    pass\n");
  return { root, index };
}

describe.skipIf(!binary)("the Rust graph engine from Node", () => {
  it("reports the contract version MEX speaks", () => {
    expect(graphEngineVersion(binary!)).toMatchObject({ contract: GRAPH_ENGINE_CONTRACT });
  });

  it("runs a build through the start barrier and streams its result", async () => {
    const { root, index } = fixture();
    const output = join(index, "graph-tmp-1-node.db");
    const events: EngineEvent[] = [];
    const run = await runGraphEngine(binary!, {
      mode: "build", root, files: [{ path: "src/app.py" }], languages: [], output,
      limits: { memoryMb: 4096, deadlineMs: 60_000 },
    }, { onEvent: (event) => events.push(event) });
    expect(run.exitCode).toBe(0);
    expect(run.result).toMatchObject({ type: "result", coverageGaps: 1 });
    expect(events.at(-1)?.type).toBe("result");
    expect(existsSync(output)).toBe(true);
    expect(existsSync(`${output}.request.json`)).toBe(false);
  });

  it("streams staged Python rows without writing a candidate", async () => {
    const { root, index } = fixture();
    const events: EngineEvent[] = [];
    const run = await runGraphEngine(binary!, {
      mode: "stage", root, files: [{ path: "src/app.py" }, { path: "README.md" }], languages: ["python"],
      limits: { memoryMb: 4096, deadlineMs: 60_000 },
    }, { onEvent: (event) => events.push(event), requestDir: index });
    expect(run.exitCode).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["staged", "file", "result"]);
    const staged = events[0] as Extract<EngineEvent, { type: "staged" }>;
    expect(staged).toMatchObject({ path: "src/app.py", language: "python", parseStatus: "ok" });
    expect(staged.nodes.map((node) => node.kind)).toEqual(["file", "function"]);
    expect(staged.edges).toEqual([expect.objectContaining({ kind: "contains", target: staged.nodes[1]!.id })]);
    expect(readdirSync(index)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("publishes basic stage rows in v4 with visible definitions and unresolved call coverage", async () => {
    const { root, index } = fixture();
    const path = "src/app.py";
    writeFileSync(join(root, path), "def target():\n    pass\n\ndef caller():\n    target()\n");
    const events: EngineEvent[] = [];
    const run = await runGraphEngine(binary!, {
      mode: "stage", root, files: [{ path }], languages: ["python"],
      limits: { memoryMb: 4096, deadlineMs: 60_000 },
    }, { onEvent: event => events.push(event), requestDir: index });
    expect(run.exitCode).toBe(0);
    const staged = events.find(event => event.type === "staged")!;
    const call = staged.edges.find(edge => edge.kind === "calls")!;
    expect(call).toBeDefined();
    staged.coverage = "basic";
    call.resolutionMethod = "basic";
    call.confidence = 0;
    const stub = join(index, "stage-basic");
    writeFileSync(stub, `#!/bin/sh
if [ "$1" = version ]; then
  echo '{"version":"0.1.0","contract":${GRAPH_ENGINE_CONTRACT}}'
  exit 0
fi
read -r start
[ "$start" = start ] || exit 2
cat <<'MEX_STAGE'
${events.map(event => JSON.stringify(event)).join("\n")}
MEX_STAGE
`, { mode: 0o755 });
    vi.stubEnv("MEX_HOME", join(index, "home"));
    vi.stubEnv("MEX_GRAPH_ENGINE", stub);
    vi.stubEnv("MEX_GRAPH_ENGINE_LANGUAGES", "python");
    vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
    expect(await rebuildGraph(root)).toMatchObject({ status: { schemaVersion: 4 }, engine: { fallbackFiles: 0 } });
    const graph = createGraphEngine({ rootDir: root, readOnly: true });
    try {
      expect(graph.coverageFor(path)).toEqual({ indexed: true, reason: "basic" });
      expect(graph.getNode(call.target)?.name).toBe("target");
      expect(graph.getIncoming(call.target, ["calls"])).toEqual([expect.objectContaining({
        edge: expect.objectContaining({ source: call.source, resolutionMethod: "basic", confidence: 0 }),
      })]);
      expect(graph.getCallers(call.target)).toEqual([]);
      expect(graph.getCallees(call.source)).toEqual([]);
    } finally { graph.close(); }
  });

  it("removes the candidate when the engine stops over its cap", async () => {
    const { root, index } = fixture();
    const output = join(index, "graph-tmp-2-node.db");
    const run = await runGraphEngine(binary!, {
      mode: "build", root, files: [{ path: "src/app.py" }], languages: [], output,
      limits: { memoryMb: 1, deadlineMs: 60_000 },
    });
    expect(run.exitCode).toBe(3);
    expect(run.error?.code).toBe("graph_memory_limit");
    expect(existsSync(output)).toBe(false);
  });
});
