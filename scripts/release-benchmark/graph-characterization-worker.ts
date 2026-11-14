import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createGraphEngine } from "../../src/graph/engine-impl.js";

const root = process.argv[2]!;
let running = false;
process.on("disconnect", () => process.exit());
process.on("message", async (message: { mode?: string }) => {
  if (running || !["build", "unchanged", "changed"].includes(message.mode ?? "")) {
    process.exitCode = 1;
    process.disconnect?.();
    return;
  }
  running = true;
  let graph: ReturnType<typeof createGraphEngine> | undefined;
  try {
    if (message.mode === "changed") {
      const path = join(root, "packages/p0/module-0.ts");
      const before = readFileSync(path, "utf8");
      const states = ["value += 101; // characterization-state:A", "value += 207; // characterization-state:B"];
      const current = before.includes(states[0]!) ? 0 : 1;
      const after = before.replace(states[current]!, states[1 - current]!);
      if (after === before) throw new Error("Missing characterization change marker.");
      writeFileSync(path, after);
    }
    const beforeCpu = process.cpuUsage();
    const start = performance.now();
    graph = createGraphEngine({ rootDir: root });
    const result = message.mode === "build"
      ? await graph.build()
      : await graph.sync(message.mode === "changed" ? ["packages/p0/module-0.ts"] : []);
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(beforeCpu);
    const returnMemory = process.memoryUsage();
    graph.close();
    graph = undefined;
    // This is diagnostic retained-memory characterization, never a production GC policy.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      global.gc?.();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    process.send?.({ mode: message.mode, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1_000,
      result, returnMemory, postGcMemory: process.memoryUsage() });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message.slice(0, 2_000) : "Graph characterization failed." });
  } finally {
    graph?.close();
    running = false;
  }
});
process.send?.({ ready: true });
