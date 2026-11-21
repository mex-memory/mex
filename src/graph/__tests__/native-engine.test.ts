import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GRAPH_ENGINE_CONTRACT, graphEngineBinary, graphEngineVersion, runGraphEngine, type EngineEvent } from "../native-engine.js";

/**
 * The Node side of the Rust engine's contract. Runs only where an engine is
 * built (`cargo build` in native/engine, or MEX_GRAPH_ENGINE); the Rust job
 * tests cover the engine's side on every OS.
 */
const binary = graphEngineBinary();
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

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
