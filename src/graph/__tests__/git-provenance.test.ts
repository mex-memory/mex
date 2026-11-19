import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGraphEngine } from "../engine-impl.js";
import { gitProvenanceChanged, readGraphGitProvenance } from "../snapshot.js";

// A git read that fails or times out is never a branch or HEAD change; a
// real HEAD move during staging still fails the build.

const roots: string[] = [];
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, encoding: "utf8" }).trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-git-provenance-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main", ".");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export function a(): number {\n  return 1;\n}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  return root;
}

/** A PATH with no git on it: every read fails to run. */
function withoutGit(): void {
  const empty = mkdtempSync(join(tmpdir(), "mex-no-git-"));
  roots.push(empty);
  process.env.PATH = empty;
}

describe("graph git provenance", () => {
  it("reads branch and HEAD from refs", () => {
    const root = repo();
    expect(readGraphGitProvenance(root)).toEqual({ branch: "main", head: git(root, "rev-parse", "HEAD") });
    git(root, "checkout", "-q", "--detach");
    expect(readGraphGitProvenance(root)).toEqual({ branch: null, head: git(root, "rev-parse", "HEAD") });
  });

  it("reports an unborn HEAD and a non-repository as null, not unreadable", () => {
    const unborn = mkdtempSync(join(tmpdir(), "mex-git-unborn-"));
    roots.push(unborn);
    git(unborn, "init", "-q", "-b", "trunk", ".");
    expect(readGraphGitProvenance(unborn)).toEqual({ branch: "trunk", head: null });
    const plain = mkdtempSync(join(tmpdir(), "mex-git-none-"));
    roots.push(plain);
    // The temp folder may sit inside some other repository; only check the shape.
    expect(readGraphGitProvenance(plain).unreadable).toBeUndefined();
  });

  it("marks a read that cannot run as unreadable, which is never a change", () => {
    const root = repo();
    withoutGit();
    const failed = readGraphGitProvenance(root);
    expect(failed.unreadable).toBe(true);
    expect(gitProvenanceChanged({ branch: "main", head: "a".repeat(40) }, failed)).toBe(false);
    expect(gitProvenanceChanged(failed, { branch: "other", head: "b".repeat(40) })).toBe(false);
    expect(gitProvenanceChanged({ branch: "main", head: "a".repeat(40) }, { branch: "main", head: "b".repeat(40) })).toBe(true);
  });

  it("builds when the final git read fails during staging", async () => {
    const root = repo();
    const engine = createGraphEngine({
      rootDir: root,
      dbPath: join(root, "graph.db"),
      __internalGraphEngineHooks: { beforePublication: withoutGit },
    } as Parameters<typeof createGraphEngine>[0]);
    try {
      const result = await engine.build();
      expect(result.filesIndexed).toBe(1);
    } finally {
      engine.close();
    }
  });

  it("still fails the build when HEAD really moves during staging", async () => {
    const root = repo();
    const engine = createGraphEngine({
      rootDir: root,
      dbPath: join(root, "graph.db"),
      __internalGraphEngineHooks: {
        beforePublication: () => { git(root, "commit", "-q", "--allow-empty", "-m", "moved"); },
      },
    } as Parameters<typeof createGraphEngine>[0]);
    try {
      await expect(engine.build()).rejects.toThrow(/staging|HEAD/i);
    } finally {
      engine.close();
    }
  });
});
