import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock cross-spawn so we can drive the exact SpawnSyncReturns shapes that
// `runToolInteractive` must map to a boolean, without launching anything.
vi.mock("cross-spawn", () => ({
  default: { sync: vi.fn() },
}));

import crossSpawn from "cross-spawn";
import { runToolInteractive } from "../src/sync/index.js";

const mockSync = crossSpawn.sync as unknown as ReturnType<typeof vi.fn>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-sync-transport-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  return root;
}

describe("runToolInteractive return-value logic", () => {
  beforeEach(() => {
    mockSync.mockReset();
  });

  it("treats a clean exit (status 0) as success", () => {
    mockSync.mockReturnValue({ status: 0 });
    expect(runToolInteractive("claude", "brief", process.cwd())).toBe(true);
    expect(mockSync).toHaveBeenCalledWith("claude", ["brief"], expect.objectContaining({
      timeout: 15 * 60_000,
    }));
  });

  it("can leave a setup population session unbounded and launches Codex in the project root", () => {
    mockSync.mockReturnValue({ status: 0 });
    const cwd = process.cwd();
    expect(runToolInteractive("codex", "populate", cwd, { timeoutMs: null })).toBe(true);
    expect(mockSync).toHaveBeenCalledWith("codex", ["populate"], {
      cwd,
      stdio: "inherit",
    });
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

  it.each(["claude", "codex", "opencode"] as const)("keeps a large %s sync brief readable and off argv", (tool) => {
    const root = fixture();
    const brief = "Review complete defaults, including QUERY.\r\n".repeat(1_000);
    mockSync.mockImplementation((_command: string, args: string[]) => {
      const instruction = args.at(-1)!;
      expect(instruction.length).toBeLessThan(256);
      expect(args.join(" ")).not.toContain("QUERY");
      const path = join(root, /`([^`]+)`/u.exec(instruction)![1]!);
      expect(readFileSync(path, "utf8")).toBe(brief);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      return { status: 0 };
    });
    expect(runToolInteractive(tool, brief, root)).toBe(true);
    expect(readdirSync(join(root, ".mex/local"))).toEqual([]);
  });

  it.each(["error", "throw"])("cleans a large prompt after a spawn %s", (failure) => {
    const root = fixture();
    mockSync.mockImplementation(() => {
      if (failure === "throw") throw new Error("spawn failed");
      return { error: new Error("spawn failed"), status: null };
    });
    if (failure === "throw") expect(() => runToolInteractive("codex", "x".repeat(12_000), root)).toThrow("spawn failed");
    else expect(runToolInteractive("codex", "x".repeat(12_000), root)).toBe(false);
    expect(readdirSync(join(root, ".mex/local"))).toEqual([]);
  });

  it("refuses a symlinked private directory and preserves the destination", () => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(outside, join(root, ".mex/local"), "dir");
    expect(() => runToolInteractive("codex", "x".repeat(12_000), root)).toThrow(/not a regular directory/);
    expect(mockSync).not.toHaveBeenCalled();
    expect(readdirSync(outside)).toEqual([".mex"]);
  });

  it("refuses oversized context instead of silently discarding review evidence", () => {
    const root = fixture();
    expect(() => runToolInteractive("codex", "x".repeat(1024 * 1024 + 1), root)).toThrow(/1 MiB/);
    expect(mockSync).not.toHaveBeenCalled();
    expect(readdirSync(join(root, ".mex"))).toEqual([]);
  });
});
