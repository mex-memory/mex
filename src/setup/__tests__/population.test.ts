import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  launchSetupPopulation,
  selectSetupAgent,
  SetupPopulationError,
} from "../population.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setup population launcher", () => {
  it("launches the first selected available supported agent", () => {
    const available = vi.fn((command: string) => command === "codex");
    expect(selectSetupAgent(["claude", "codex"], available)).toBe("codex");
    expect(available).toHaveBeenCalledWith("claude");
    expect(available).toHaveBeenCalledWith("codex");
  });

  it("never falls back to an unselected agent", () => {
    expect(selectSetupAgent(["cursor"], () => true)).toBeNull();
  });

  it("lists only the agents it probed, and stops probing after the chosen one", () => {
    const project = fixture();
    const available = vi.fn((command: string) => command === "claude");
    expect(launchSetupPopulation(["claude", "codex"], "prompt", project, {
      isAvailable: available,
      run: () => true,
    })).toEqual({ tool: "claude", unavailable: [], completed: true });
    expect(available).toHaveBeenCalledWith("claude");
    expect(available).not.toHaveBeenCalledWith("codex");
  });

  it("reports no unavailable agent when the selection contains none that setup can drive", () => {
    // An empty `unavailable` with `tool: null` is the signal that no selected tool is Claude Code
    // or Codex, which is a different reason from a missing CLI.
    const project = fixture();
    const available = vi.fn(() => true);
    expect(launchSetupPopulation(["cursor", "windsurf"], "prompt", project, {
      isAvailable: available,
    })).toEqual({ tool: null, unavailable: [], completed: false });
    expect(available).not.toHaveBeenCalled();
  });

  it("keeps a large prompt off argv while the agent can read every byte", () => {
    const project = fixture();
    const prompt = `# Population\n\n${"x".repeat(12 * 1024)}\n`;
    const run = vi.fn((_tool: string, instruction: string, cwd: string) => {
      expect(Buffer.byteLength(instruction, "utf8")).toBeLessThan(256);
      const pointer = /`([^`]+)`/u.exec(instruction)?.[1];
      expect(pointer).toBeDefined();
      expect(readFileSync(join(cwd, pointer!), "utf8")).toBe(prompt);
      return true;
    });

    expect(launchSetupPopulation(["codex"], prompt, project, {
      isAvailable: () => true,
      run,
    })).toEqual({ tool: "codex", unavailable: [], completed: true });
    expect(run).toHaveBeenCalledWith(
      "codex",
      expect.stringMatching(/^Read the full setup population prompt from `\.mex\/local\/setup-population-[^/]+\/prompt\.md`/u),
      project,
      { timeoutMs: null },
    );
    expect(readdirSync(join(project, ".mex", "local"))).toEqual([]);
  });

  it("reports unavailable and failed launches without pretending population completed", () => {
    const unavailableProject = fixture();
    expect(launchSetupPopulation(["codex"], "prompt", unavailableProject, {
      isAvailable: () => false,
    })).toEqual({ tool: null, unavailable: ["codex"], completed: false });

    const failedProject = fixture();
    expect(launchSetupPopulation(["claude"], "prompt", failedProject, {
      isAvailable: () => true,
      run: () => false,
    })).toEqual({ tool: "claude", unavailable: [], completed: false });
    expect(readdirSync(join(failedProject, ".mex", "local"))).toEqual([]);
    expect(() => readdirSync(join(unavailableProject, ".mex", "local"))).toThrow();
  });

  it("removes its private prompt when the runner throws", () => {
    const project = fixture();
    expect(() => launchSetupPopulation(["codex"], "secret prompt", project, {
      isAvailable: () => true,
      run: () => { throw new Error("runner failed"); },
    })).toThrow("runner failed");
    expect(readdirSync(join(project, ".mex", "local"))).toEqual([]);
  });

  it.each(["symlink", "file"] as const)("fails closed when .mex/local is a %s", (kind) => {
    const project = fixture();
    const local = join(project, ".mex", "local");
    if (kind === "symlink") {
      const outside = mkdtempSync(join(tmpdir(), "mex-population-outside-"));
      roots.push(outside);
      symlinkSync(outside, local, "dir");
    } else {
      writeFileSync(local, "not a directory\n", "utf8");
    }
    const run = vi.fn(() => true);

    expect(() => launchSetupPopulation(["codex"], "prompt", project, {
      isAvailable: () => true,
      run,
    })).toThrow(SetupPopulationError);
    expect(run).not.toHaveBeenCalled();
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-population-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  return root;
}
