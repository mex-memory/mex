import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { plantGraph } from "../../../graph/__tests__/plant-graph.js";
import { hasCommittedHubIdentity, projectSetupStatus } from "../readiness.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Hub setup readiness", () => {
  it("keeps completed code setup at a commit checkpoint without creating local state", async () => {
    const root = fixture("code-repo");
    git(root, "init");
    const before = readdirSync(join(root, ".mex"));
    expect(await projectSetupStatus(root)).toMatchObject({ ready: false, stage: "needs_commit", mode: "code-repo" });
    expect(readdirSync(join(root, ".mex"))).toEqual(before);
    commitConfig(root);
    expect(await projectSetupStatus(root)).toMatchObject({ ready: true, stage: "ready" });
    expect(readdirSync(join(root, ".mex"))).toEqual(before);
  });

  it("keeps existing Hub recovery available without disposable indexes", async () => {
    const root = fixture("code-repo", false);
    git(root, "init");
    commitConfig(root);
    expect(await hasCommittedHubIdentity(root)).toBe(true);
    expect(await projectSetupStatus(root)).toMatchObject({ ready: false, stage: "needs_finalize" });
  });

  it.each([false, true])("finishes Agent memory with hasGit=%s without trying to open a code Hub", async (withGit) => {
    const root = fixture("agent-memory", false);
    if (withGit) {
      git(root, "init");
      commitConfig(root);
    }
    expect(await projectSetupStatus(root)).toMatchObject({
      mode: "agent-memory", stage: "complete", ready: false, commitCommands: [],
    });
  });

  it("rejects a changed working-tree identity until it is committed", async () => {
    const root = fixture("code-repo");
    git(root, "init");
    commitConfig(root);
    writeFileSync(join(root, ".mex/config.json"), JSON.stringify({ scaffold_id: randomUUID(), scaffold_name: "Changed", setupMode: "code-repo" }));
    expect(await hasCommittedHubIdentity(root)).toBe(false);
    expect(await projectSetupStatus(root)).toMatchObject({ ready: false, stage: "needs_commit" });
  });
});

function fixture(mode: "code-repo" | "agent-memory", indexes = true): string {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-readiness-"));
  roots.push(root);
  mkdirSync(join(root, ".mex/context"), { recursive: true });
  for (const name of ["AGENTS.md", "ROUTER.md", "context/architecture.md", "context/stack.md", "context/conventions.md", "context/decisions.md", "context/setup.md"]) {
    writeFileSync(join(root, ".mex", name), "# Test project\n\nPopulated fixture content.\n");
  }
  writeFileSync(join(root, ".mex/config.json"), JSON.stringify({ scaffold_id: randomUUID(), scaffold_name: "Test project", setupMode: mode, aiTools: [] }));
  if (indexes) {
    // This boundary observes readiness only; it never opens or maintains indexes.
    plantGraph(root, "");
    writeFileSync(join(root, ".mex/wiki.db"), "");
  }
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function commitConfig(root: string): void {
  git(root, "add", ".mex/config.json");
  git(root, "-c", "user.name=Setup test", "-c", "user.email=setup@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initialize test identity");
}
