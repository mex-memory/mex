import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appendFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync };
});

// A fresh module per test, so the warn-once state never leaks between cases.
async function load() {
  vi.resetModules();
  return import("../src/graph/phase-timing.js");
}

describe("MEX_GRAPH_PHASE_TIMINGS", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    appendFileSync.mockClear();
    vi.restoreAllMocks();
  });

  it("appends a record to the named file", async () => {
    const { flushGraphPhaseTimings, recordGraphPhase } = await load();
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "/tmp/mex-phase-timings.jsonl");
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    expect(appendFileSync).toHaveBeenCalledOnce();
    const [path, line] = appendFileSync.mock.calls[0]!;
    expect(path).toBe("/tmp/mex-phase-timings.jsonl");
    expect(JSON.parse(String(line))).toMatchObject({ label: "update", phases: { scan: 5 } });
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(["1", "true", "TRUE", "yes", "on", " 1 "])("does not write a file named %j and warns once", async (value) => {
    const { flushGraphPhaseTimings, recordGraphPhase } = await load();
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", value);
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    flushGraphPhaseTimings("update");
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    expect(String(stderr.mock.calls[0]![0])).toContain("MEX_GRAPH_PHASE_TIMINGS must name a file");
  });

  it.each(["0", "false", "No", "off"])("treats %j as off without a file or a warning", async (value) => {
    const { flushGraphPhaseTimings, recordGraphPhase } = await load();
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", value);
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("stays off and silent when unset", async () => {
    const { flushGraphPhaseTimings, recordGraphPhase } = await load();
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "");
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
