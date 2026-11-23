import { describe, expect, it } from "vitest";
import { currentGraphMachine, graphEngineMemoryMb, graphSizing } from "../sizing.js";

// A build sizes itself to the machine: a small one gets smaller chunks and
// caches and runs slower; it never skips work.

describe("graph machine sizing", () => {
  it("uses the full chunks and caches on a large machine", () => {
    const sizing = graphSizing({ cores: 16, freeMb: 20_000, totalMb: 32_000 });
    expect(sizing).toMatchObject({
      budgetMb: 2048,
      readConcurrency: 16, sqliteCacheMb: 128, sqliteTempStore: "MEMORY",
    });
  });

  it("shrinks everything on a 4-core machine with 4 GB free, and still builds", () => {
    const sizing = graphSizing({ cores: 4, freeMb: 4096, totalMb: 8192 });
    expect(sizing).toMatchObject({
      budgetMb: 2048, readConcurrency: 8,
    });
    const tiny = graphSizing({ cores: 2, freeMb: 1024, totalMb: 2048 });
    expect(tiny.budgetMb).toBe(512);
    expect(tiny.sqliteTempStore).toBe("FILE");
    expect(tiny.sqliteCacheMb).toBe(64);
  });

  it("reads a simulated machine from MEX_GRAPH_MACHINE", () => {
    expect(currentGraphMachine({ MEX_GRAPH_MACHINE: "cores=4,freeMb=4096" })).toMatchObject({ cores: 4, freeMb: 4096 });
    expect(currentGraphMachine({ MEX_GRAPH_MACHINE: "cores=x" }).cores).toBeGreaterThan(0);
  });

  it.each([
    [1024, 256, 256, 128],
    [8192, 1024, 1024, 512],
    [16384, 2048, 2048, 1024],
    [65536, 4096, 3072, 2048],
  ])("sizes engine RSS to a %i MiB machine", (totalMb, native, wasi, resident) => {
    const machine = { cores: 8, freeMb: 128, totalMb };
    expect(graphEngineMemoryMb("native", machine)).toBe(native);
    expect(graphEngineMemoryMb("wasi", machine)).toBe(wasi);
    expect(graphEngineMemoryMb("resident", machine)).toBe(resident);
  });
});
