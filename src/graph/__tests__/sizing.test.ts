import { describe, expect, it } from "vitest";
import { currentGraphMachine, graphSizing } from "../sizing.js";

// A build sizes itself to the machine: a small one gets smaller chunks and
// caches and runs slower; it never skips work.

describe("graph machine sizing", () => {
  it("uses the full chunks and caches on a large machine", () => {
    const sizing = graphSizing({ cores: 16, freeMb: 20_000, totalMb: 32_000 });
    expect(sizing).toMatchObject({
      budgetMb: 2048, serverBudgetMb: 819, chunkProjects: 12, chunkRootFiles: 4000,
      readConcurrency: 16, sqliteCacheMb: 128, sqliteTempStore: "MEMORY",
    });
  });

  it("shrinks everything on a 4-core machine with 4 GB free, and still builds", () => {
    const sizing = graphSizing({ cores: 4, freeMb: 4096, totalMb: 8192 });
    expect(sizing).toMatchObject({
      budgetMb: 2048, serverBudgetMb: 819, readConcurrency: 8,
    });
    const tiny = graphSizing({ cores: 2, freeMb: 1024, totalMb: 2048 });
    expect(tiny.budgetMb).toBe(512);
    expect(tiny.serverBudgetMb).toBe(256);
    expect(tiny.chunkProjects).toBeGreaterThanOrEqual(2);
    expect(tiny.chunkRootFiles).toBeGreaterThanOrEqual(500);
    expect(tiny.chunkRootFiles).toBeLessThan(4000);
    expect(tiny.sqliteTempStore).toBe("FILE");
    expect(tiny.sqliteCacheMb).toBe(64);
    expect(tiny.spoolCapturesFrom).toBeLessThan(graphSizing({ cores: 16, freeMb: 20_000, totalMb: 32_000 }).spoolCapturesFrom);
  });

  it("reads a simulated machine from MEX_GRAPH_MACHINE", () => {
    expect(currentGraphMachine({ MEX_GRAPH_MACHINE: "cores=4,freeMb=4096" })).toMatchObject({ cores: 4, freeMb: 4096 });
    expect(currentGraphMachine({ MEX_GRAPH_MACHINE: "cores=x" }).cores).toBeGreaterThan(0);
  });
});
