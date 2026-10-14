import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSetupProjectRoot, resolveDefaultEntry } from "../entry.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("default setup entry", () => {
  it("keeps empty folders and missing paths read-only while choosing setup", async () => {
    const root = fixture();
    const missing = join(root, "not-created", "nested");
    expect(findSetupProjectRoot(root)).toBe(root);
    expect(findSetupProjectRoot(missing)).toBe(missing);
    expect(await resolveDefaultEntry(root)).toBe("setup");
    expect(await resolveDefaultEntry(missing)).toBe("setup");
    expect(readdirSync(root)).toEqual([]);
  });

  it("chooses setup for a Git checkout before its scaffold exists", async () => {
    const root = fixture(true);
    const before = snapshot(root);
    expect(await resolveDefaultEntry(root)).toBe("setup");
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, ".mex"))).toBe(false);
  });

  it("chooses setup until the code project's identity is committed", async () => {
    const root = fixture(true);
    scaffold(root, "code-repo");
    const before = snapshot(root);
    expect(await resolveDefaultEntry(root)).toBe("setup");
    expect(snapshot(root)).toEqual(before);
  });

  it("keeps Agent memory in setup even when its identity is committed", async () => {
    const root = fixture(true);
    scaffold(root, "agent-memory");
    commitIdentity(root);
    const before = snapshot(root);
    expect(await resolveDefaultEntry(root)).toBe("setup");
    expect(snapshot(root)).toEqual(before);
  });

  it("preserves Hub recovery for committed code projects without indexes or populated files", async () => {
    const root = fixture(true);
    scaffold(root, "code-repo");
    commitIdentity(root);
    const before = snapshot(root);
    expect(await resolveDefaultEntry(root)).toBe("hub");
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, ".mex/graph.db"))).toBe(false);
    expect(existsSync(join(root, ".mex/wiki.db"))).toBe(false);
    expect(existsSync(join(root, ".mex/local"))).toBe(false);
  });

  it("does not route a committed identity without ROUTER.md to Hub", async () => {
    const root = fixture(true);
    scaffold(root, "code-repo");
    rmSync(join(root, ".mex/ROUTER.md"));
    commitIdentity(root);
    const before = snapshot(root);
    expect(await resolveDefaultEntry(root)).toBe("setup");
    expect(snapshot(root)).toEqual(before);
  });

  it("returns to setup when the working identity differs from the committed identity", async () => {
    const root = fixture(true);
    scaffold(root, "code-repo");
    commitIdentity(root);
    scaffold(root, "code-repo");
    const before = snapshot(root);
    expect(await resolveDefaultEntry(root)).toBe("setup");
    expect(snapshot(root)).toEqual(before);
  });

  it("discovers the same checkout from a nested working directory and preserves the old export", async () => {
    const root = fixture(true);
    scaffold(root, "code-repo");
    commitIdentity(root);
    const nested = join(root, "src", "nested");
    mkdirSync(nested, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(nested);
    const before = snapshot(root);
    expect(findSetupProjectRoot()).toBe(root);
    expect(await resolveDefaultEntry()).toBe("hub");
    const setup = await import("../index.js");
    expect(setup.findSetupProjectRoot).toBe(findSetupProjectRoot);
    expect(snapshot(root)).toEqual(before);
  });
});

function fixture(withGit = false): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-entry-"));
  roots.push(root);
  if (withGit) git(root, "-c", "init.templateDir=", "init", "--quiet");
  return root;
}

function scaffold(root: string, mode: "code-repo" | "agent-memory"): void {
  mkdirSync(join(root, ".mex"), { recursive: true });
  writeFileSync(join(root, ".mex/ROUTER.md"), "# [Project Name]\n");
  writeFileSync(join(root, ".mex/config.json"), JSON.stringify({
    scaffold_id: randomUUID(), scaffold_name: "Entry fixture", setupMode: mode, aiTools: [],
  }));
}

function git(root: string, ...args: string[]): void {
  // Fixture commits must not leave background maintenance racing the full .git snapshot.
  execFileSync("git", ["-c", "maintenance.auto=false", ...args], { cwd: root, stdio: "pipe" });
}

function commitIdentity(root: string): void {
  git(root, "add", ".mex/config.json");
  git(root, "-c", "user.name=Setup entry test", "-c", "user.email=entry@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=.git/hooks", "commit", "--quiet", "-m", "Fixture identity");
}

/** Small fixtures include Git bytes so discovery cannot silently initialize state. */
function snapshot(root: string, prefix = ""): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      entries[`${path}/`] = "";
      Object.assign(entries, snapshot(root, path));
    } else entries[path] = readFileSync(join(root, path)).toString("base64");
  }
  return entries;
}
