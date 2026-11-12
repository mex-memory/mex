import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { findConfig } from "../src/config.js";
import { findSetupProjectRoot } from "../src/setup/entry.js";
import { locateTeamRepositoryRoot } from "../src/team/cli/repository-root.js";

describe("hermetic temp discovery", () => {
  it("does not discover a parent repository or its scaffold across the temp ceiling", () => {
    expect(process.env.GIT_CEILING_DIRECTORIES?.split(delimiter)).toContain(tmpdir());
    const parent = mkdtempSync(join(tmpdir(), "parent-repo-"));
    expect(spawnSync("git", ["init", "-q", parent]).status).toBe(0);
    mkdirSync(join(parent, ".mex"));
    writeFileSync(join(parent, ".mex", "ROUTER.md"), "# Parent scaffold\n");
    const ceiling = join(parent, "temp");
    const project = join(ceiling, "project");
    mkdirSync(project, { recursive: true });
    expect(findConfig(project).projectRoot).toBe(parent);
    vi.stubEnv("GIT_CEILING_DIRECTORIES", ceiling);
    try {
      expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: project }).status).not.toBe(0);
      expect(() => findConfig(project)).toThrow("No git repository found");
      expect(findSetupProjectRoot(project)).toBe(project);
      expect(() => locateTeamRepositoryRoot(project)).toThrow("Run the Team command from an initialized repository");
      expect(spawnSync("git", ["init", "-q", project]).status).toBe(0);
      mkdirSync(join(project, ".mex"));
      writeFileSync(join(project, ".mex", "ROUTER.md"), "# Local scaffold\n");
      expect(findConfig(project).projectRoot).toBe(project);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
