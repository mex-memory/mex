/**
 * Setup's batch applies prove each batch's freshness, hold nothing between
 * applies, and report when the graph database or HEAD changed mid-phase.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryGraphPort } from "../src/graph/application-adapter.js";
import { loadFreshGraphReadSession } from "../src/graph/read-session.js";
import { createSetupBatchApplier } from "../src/setup/subsystem-apply.js";
import { createSetupGraphFreshness, graphIdentity } from "../src/setup/setup-graph-freshness.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
  }
});

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root, stdio: "ignore" });

async function project(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-freshness-"));
  roots.push(root);
  git(root, "init", "-q");
  mkdirSync(join(root, "src"));
  for (const name of ["alpha", "beta", "gamma", "delta"]) {
    writeFileSync(join(root, "src", `${name}.ts`), `export function ${name}(input: string): string {\n  return input.trim();\n}\n`);
  }
  git(root, "add", "src");
  git(root, "commit", "-qm", "base");
  cpSync(resolve("templates"), join(root, ".mex"), { recursive: true, filter: (source) => !source.includes("agent-memory") && !source.includes(".tool-configs") });
  writeFileSync(join(root, ".mex", "config.json"), "{}\n");
  await createRepositoryGraphPort(root).rebuild();
  return root;
}

function batch(root: string, name: string): string {
  const file = `.mex/local/setup-ops/${name}.json`;
  mkdirSync(join(root, ".mex/local/setup-ops"), { recursive: true });
  writeFileSync(join(root, file), JSON.stringify([{
    opId: `setup_${name}_trim`, type: "create-entry", actor: { kind: "agent", id: "test" }, timestamp: "2026-10-24T10:00:00Z", reason: "test",
    payload: { file: `context/${name}.md`, insertAt: { at: "end-of-file" }, type: "fact", title: `${name} trims its input`,
      body: `\`${name}()\` trims its input.`, headingDepth: 2, status: "promoted", groundsTo: [{ file: `src/${name}.ts`, symbol: name }],
      aliases: [`${name} trims`, `${name} whitespace`, `${name} input`] },
  }]));
  return file;
}

describe("setup batch applies and graph freshness", () => {
  it("proves every batch, holds nothing between applies, and reports a rebuild or a new HEAD", async () => {
    const root = await project();
    const loadFull = vi.fn(loadFreshGraphReadSession);
    const freshness = createSetupGraphFreshness(root, { loadFull });
    const applier = createSetupBatchApplier(root, { freshness });
    const scope = (name: string) => ({ opIdPrefix: `setup_${name}_`, files: [`context/${name}.md`] });

    expect(await applier.apply(batch(root, "alpha"), scope("alpha"))).toMatchObject({ kind: "applied", facts: 1 });
    expect(await applier.apply(batch(root, "beta"), scope("beta"))).toMatchObject({ kind: "applied", facts: 1 });
    expect(loadFull).toHaveBeenCalledTimes(2);
    expect(freshness.changed).toBe(false);
    expect(readFileSync(join(root, ".mex/context/beta.md"), "utf8")).toContain("beta trims its input");

    // Nothing is held between applies: a full rebuild replaces the database in place.
    const before = graphIdentity(root);
    await createRepositoryGraphPort(root).rebuild();
    expect(graphIdentity(root)).not.toBe(before);
    expect(await applier.apply(batch(root, "gamma"), scope("gamma"))).toMatchObject({ kind: "applied", facts: 1 });
    expect(loadFull).toHaveBeenCalledTimes(3);
    expect(freshness.changed).toBe(true);

    // A new HEAD is proved like any other batch (the graph records the commit it indexed).
    git(root, "commit", "--allow-empty", "-qm", "next");
    const afterHead = await applier.apply(batch(root, "delta"), scope("delta"));
    expect(loadFull).toHaveBeenCalledTimes(4);
    expect(afterHead).toMatchObject({ kind: "applied", facts: 1 });

    expect(await applier.close()).toEqual({ changed: true });
  }, 180_000);

  it("reports a database file change even with the same HEAD", async () => {
    const root = await project();
    const freshness = createSetupGraphFreshness(root);
    const applier = createSetupBatchApplier(root, { freshness });
    expect(await applier.apply(batch(root, "alpha"), { opIdPrefix: "setup_alpha_", files: ["context/alpha.md"] })).toMatchObject({ kind: "applied" });
    expect(freshness.changed).toBe(false);
    // Another writer touches the database (here: a no-op write transaction that still rewrites the file).
    const { openGraphDatabase } = await import("../src/graph/db/database.js");
    const db = openGraphDatabase(join(root, ".mex", "graph.db"));
    db.exec("CREATE TABLE IF NOT EXISTS setup_probe (x); DROP TABLE setup_probe;");
    db.close();
    expect(await applier.apply(batch(root, "beta"), { opIdPrefix: "setup_beta_", files: ["context/beta.md"] })).toMatchObject({ kind: "applied" });
    expect(await applier.close()).toEqual({ changed: true });
  }, 180_000);
});
