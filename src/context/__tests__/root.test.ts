import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveContextRoot } from "../root.js";
import { cleanupProjects, createProject } from "./fixture.js";

afterEach(() => {
  cleanupProjects();
  vi.unstubAllEnvs();
});

describe("resolveContextRoot", () => {
  it("finds the project from the root and from any depth below it", () => {
    const fx = createProject();
    const deep = join(fx.root, "packages", "api", "src", "routes");
    mkdirSync(deep, { recursive: true });
    for (const start of [fx.root, join(fx.root, "packages"), deep]) {
      expect(resolveContextRoot(start)).toEqual({
        projectRoot: resolve(fx.root),
        scaffoldRoot: join(resolve(fx.root), ".mex"),
        localDir: join(resolve(fx.root), ".mex", "local"),
      });
    }
  });

  it("works without a Git repository (findConfig insists on one)", () => {
    const fx = createProject();
    expect(resolveContextRoot(fx.root)?.projectRoot).toBe(resolve(fx.root));
  });

  it("resolves from inside .mex itself instead of refusing", () => {
    const fx = createProject();
    expect(resolveContextRoot(join(fx.root, ".mex", "context"))?.projectRoot).toBe(resolve(fx.root));
    expect(resolveContextRoot(join(fx.root, ".mex"))?.projectRoot).toBe(resolve(fx.root));
  });

  it("prefers the nearest scaffold in a nested project", () => {
    const outer = createProject();
    const inner = join(outer.root, "vendor", "inner");
    mkdirSync(join(inner, ".mex"), { recursive: true });
    writeFileSync(join(inner, ".mex", "ROUTER.md"), "# Router\n");
    mkdirSync(join(inner, "src"), { recursive: true });
    expect(resolveContextRoot(join(inner, "src"))?.projectRoot).toBe(resolve(inner));
    expect(resolveContextRoot(join(outer.root, "vendor"))?.projectRoot).toBe(resolve(outer.root));
  });

  it("returns null when no ancestor holds a scaffold", () => {
    const bare = mkdtempSync(join(tmpdir(), "mex-context-bare-"));
    expect(resolveContextRoot(bare)).toBeNull();
  });

  describe("the per-machine MEX home", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "mex-context-home-"));
      vi.stubEnv("MEX_HOME", home);
      mkdirSync(join(home, ".mex"), { recursive: true });
      writeFileSync(join(home, ".mex", "config.json"), "{}");
    });

    it("is never mistaken for a project scaffold", () => {
      const work = join(home, "work", "notes");
      mkdirSync(work, { recursive: true });
      expect(resolveContextRoot(work)).toBeNull();
      expect(resolveContextRoot(join(home, ".mex"))).toBeNull();
    });
  });
});
