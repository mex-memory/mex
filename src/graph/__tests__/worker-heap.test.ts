import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGraphCandidateProcess } from "../candidate-process.js";
import { describe, expect, it } from "vitest";
import { graphWorkerHeap, graphHeapRecovery } from "../candidate-process.js";
const defaults = { totalBytes: 24 * 1024 ** 3, freeBytes: 20 * 1024 ** 3, defaultHeapMb: 4144, execArgv: [] as string[] };
describe("graph worker heap", () => {
  it("sizes within the total share and ceiling, never below the default", () => {
    expect(graphWorkerHeap(defaults).heapMb).toBe(14745);
    expect(graphWorkerHeap({ ...defaults, totalBytes: 128 * 1024 ** 3, freeBytes: 100 * 1024 ** 3 }).heapMb).toBe(16384);
    expect(graphWorkerHeap({ ...defaults, totalBytes: 4 * 1024 ** 3 }).heapMb).toBe(4144);
    // Low free memory at spawn does not lower the ceiling.
    expect(graphWorkerHeap({ ...defaults, freeBytes: 1024 ** 3 }).heapMb).toBe(14745);
  });
  it.each(["--max-old-space-size=8192", "--max_old_space_size=8192", '--max-old-space-size="8192"'])("keeps user NODE_OPTIONS %s", (nodeOptions) => {
    expect(graphWorkerHeap({ ...defaults, nodeOptions })).toMatchObject({ args: [], heapMb: 8192 });
  });
  it("forwards explicit execArgv with precedence over NODE_OPTIONS", () => {
    expect(graphWorkerHeap({ ...defaults, execArgv: ["--max-old-space-size", "6144"], nodeOptions: "--max-old-space-size=8192" }))
      .toMatchObject({ args: ["--max-old-space-size", "6144"], heapMb: 6144 });
  });
  it("names heap, memory and numeric recovery command", () => {
    expect(graphHeapRecovery({ heapMb: 8192, totalMemoryMb: 24576, freeMemoryMb: 16000 })).toContain("8192 MB heap; 24576 MB machine memory, 16000 MB free");
    expect(graphHeapRecovery({ heapMb: 8192 })).toContain("NODE_OPTIONS=--max-old-space-size=12288");
  });
});

it("passes the heap flag to an actual worker and records the used heap on a fatal exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-worker-heap-"));
  try {
    mkdirSync(join(root, ".mex"));
    const entrypoint = join(root, "worker.cjs");
    writeFileSync(entrypoint, `require('node:fs').writeFileSync('heap.json', JSON.stringify(process.execArgv));
      process.stderr.write('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n'); process.exit(1);`);
    const error = await runGraphCandidateProcess({ projectRoot: root, candidatePath: join(root, ".mex", "candidate.db"), operation: "rebuild", __internal: { entrypoint } }).catch((error) => error);
    const args = JSON.parse(readFileSync(join(root, "heap.json"), "utf8"));
    expect(args).toContain(`--max-old-space-size=${error.diagnostic.heapMb}`);
    expect(error.diagnostic.resourceFailure).toBe("heap-limit");
    expect(error.message).toContain(`${error.diagnostic.heapMb} MB heap`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("uses the last user flag and does not inspect eval source as runtime options", () => {
  expect(graphWorkerHeap({ ...defaults, nodeOptions: "--max-old-space-size=4096 --max-old-space-size=8192" }).heapMb).toBe(8192);
  expect(graphWorkerHeap({ ...defaults, execArgv: ["-e", "console.log('--max-old-space-size=999')"] }).heapMb).toBe(14745);
});
