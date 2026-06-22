import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock cross-spawn so we can drive the exact SpawnSyncReturns shapes that
// `runToolInteractive` must map to a boolean, without launching anything.
vi.mock("cross-spawn", () => ({
  default: { sync: vi.fn() },
}));

import crossSpawn from "cross-spawn";
import { runToolInteractive } from "../src/sync/index.js";

const mockSync = crossSpawn.sync as unknown as ReturnType<typeof vi.fn>;

describe("runToolInteractive return-value logic", () => {
  beforeEach(() => {
    mockSync.mockReset();
  });

  it("treats a clean exit (status 0) as success", () => {
    mockSync.mockReturnValue({ status: 0 });
    expect(runToolInteractive("claude", "brief", process.cwd())).toBe(true);
  });

  it("treats a non-zero exit (status 1) as failure", () => {
    mockSync.mockReturnValue({ status: 1 });
    expect(runToolInteractive("claude", "brief", process.cwd())).toBe(false);
  });

  it("treats a spawn error / timeout (error set, status null) as failure", () => {
    mockSync.mockReturnValue({ error: new Error("spawn ENOENT"), status: null });
    expect(runToolInteractive("claude", "brief", process.cwd())).toBe(false);
  });

  it("treats a signal kill (status null, no error) as failure", () => {
    mockSync.mockReturnValue({ status: null, signal: "SIGINT" });
    expect(runToolInteractive("claude", "brief", process.cwd())).toBe(false);
  });

  it("returns false without spawning for a tool that has no CLI", () => {
    // `cursor` is IDE-only (cli: null) — must short-circuit before spawning.
    expect(runToolInteractive("cursor", "brief", process.cwd())).toBe(false);
    expect(mockSync).not.toHaveBeenCalled();
  });
});
