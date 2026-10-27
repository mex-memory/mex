import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appendFileSync = vi.hoisted(() => vi.fn());
const mkdirSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync, mkdirSync };
});

import { flushGraphPhaseTimings, phaseTimingsWorkerEnv, recordGraphPhase } from "../src/graph/phase-timing.js";

const DEFAULT_FILE = join(".mex", "local", "graph-phase-timings.jsonl");

describe("MEX_GRAPH_PHASE_TIMINGS", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    appendFileSync.mockClear();
    mkdirSync.mockClear();
    vi.restoreAllMocks();
  });

  it("appends a record to the named file", () => {
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "/tmp/mex-phase-timings.jsonl");
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    expect(appendFileSync).toHaveBeenCalledOnce();
    const [path, line] = appendFileSync.mock.calls[0]!;
    expect(path).toBe("/tmp/mex-phase-timings.jsonl");
    expect(JSON.parse(String(line))).toMatchObject({ label: "update", phases: { scan: 5 } });
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(["1", "true", "TRUE", "yes", "on", " 1 "])("writes %j to the default file, not a file named after it", (value) => {
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", value);
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    expect(appendFileSync).toHaveBeenCalledOnce();
    const [path, line] = appendFileSync.mock.calls[0]!;
    expect(path).toBe(DEFAULT_FILE);
    expect(JSON.parse(String(line))).toMatchObject({ label: "update", phases: { scan: 5 } });
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each(["0", "false", "No", "off"])("treats %j as off without a file or a warning", (value) => {
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", value);
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("puts the default file under the project root, not the working directory", () => {
    const root = resolve("project-root");
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "1");
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update", root);
    expect(mkdirSync).toHaveBeenCalledWith(join(root, ".mex", "local"), { recursive: true });
    expect(appendFileSync.mock.calls[0]?.[0]).toBe(join(root, DEFAULT_FILE));
  });

  it("pins a relative path for a worker that runs in the project root", () => {
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "timings.jsonl");
    expect(phaseTimingsWorkerEnv()).toEqual({ MEX_GRAPH_PHASE_TIMINGS: resolve("timings.jsonl") });
    const absolute = resolve("timings.jsonl");
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", absolute);
    expect(phaseTimingsWorkerEnv()).toEqual({});
    for (const value of ["1", "no", ""]) {
      vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", value);
      expect(phaseTimingsWorkerEnv()).toEqual({});
    }
  });

  it("stays off and silent when unset", () => {
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "");
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
