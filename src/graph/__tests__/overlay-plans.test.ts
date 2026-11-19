import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { graphLocation, readGraphPointer } from "../storage.js";
import { createGraphEngine } from "../engine-impl.js";
import { loadFreshGraphReadSession } from "../read-session.js";
import { inspectGraphStatus } from "../status.js";
import { runGraphGet, runGraphQuery, runGraphScope, runImpact } from "../cli-agent.js";
import { OWNED_TABLES } from "../overlay.js";

/**
 * Reads through an overlay go through TEMP views over base and overlay. A
 * query that joins those views can make SQLite materialize a whole view
 * (measured on novu: a two-hop caller query went from 50 ms to 8.6 s). Every
 * statement prepared on an overlay connection while the read surfaces run is
 * explained here, and none may materialize a view.
 */

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=plans", "-c", "user.email=plans@example.com", ...args], { cwd, encoding: "utf8", windowsHide: true });
}

it("never materializes an overlay view on the read paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-overlay-plans-"));
  roots.push(root);
  vi.stubEnv("MEX_HOME", join(root, ".home"));
  const checkout = join(root, "repo");
  mkdirSync(join(checkout, "src"), { recursive: true });
  for (let index = 0; index < 6; index++) {
    writeFileSync(join(checkout, "src", `m${index}.ts`), [
      index > 0 ? `import { step${index - 1} } from "./m${index - 1}";` : "",
      `export function step${index}(value: number): number {`,
      `  return ${index > 0 ? `step${index - 1}(value) + ` : ""}${index};`,
      "}",
      "",
    ].join("\n"));
  }
  writeFileSync(join(checkout, "tsconfig.json"), "{\"compilerOptions\":{\"strict\":true}}\n");
  git(checkout, "init", "-q");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "start");
  await rebuildGraph(checkout);
  writeFileSync(join(checkout, "src", "m2.ts"), "import { step1 } from \"./m1\";\nexport function step2(value: number): number {\n  return step1(value) * 2;\n}\nexport function extra(): number { return step2(1); }\n");
  await refreshGraph(checkout);
  expect(readGraphPointer(graphLocation(checkout))?.overlay).toBeTruthy();

  const original = DatabaseSync.prototype.prepare;
  const offending = new Map<string, string>();
  let explained = 0;
  const views = new Set(OWNED_TABLES.map(entry => entry.table));
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    const statement = original.call(this, sql);
    if (/^\s*(SELECT|WITH)\b/i.test(sql)) {
      const attached = (original.call(this, "PRAGMA database_list").all() as Array<{ name: string }>).some(row => row.name === "base");
      if (attached) {
        explained++;
        let plan: Array<{ detail: string }> = [];
        try { plan = original.call(this, `EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>; } catch { /* not explainable */ }
        const materialized = plan.map(row => row.detail).filter(detail => /^MATERIALIZE (\w+)/.test(detail) && views.has(detail.split(" ")[1]!));
        if (materialized.length > 0) offending.set(sql.replace(/\s+/g, " ").trim(), materialized.join("; "));
      }
    }
    return statement;
  });
  try {
    const engine = createGraphEngine({ rootDir: checkout, readOnly: true });
    try {
      const target = engine.searchNodes("step1").find(node => node.name === "step1")!;
      expect(target).toBeTruthy();
      engine.getNode(target.id);
      engine.getCallers(target.id);
      engine.getCallees(target.id);
      engine.getIncoming(target.id);
      engine.getOutgoing(target.id);
      engine.searchSource?.("step value");
      engine.coverageFor("src/m2.ts");
    } finally { engine.close(); }
    const loaded = await loadFreshGraphReadSession(checkout);
    loaded.session?.close();
    await inspectGraphStatus({ projectRoot: checkout });
    const out: string[] = [];
    const write = (line: string) => { out.push(line); };
    await runGraphScope("step value", checkout, { write });
    await runImpact("step1", checkout, { write }, { direction: "both" });
    await runGraphQuery("who-calls", "step1", checkout, { write });
    await runGraphQuery("what-calls", "step2", checkout, { write });
    await runGraphQuery("where-defined", "extra", checkout, { write });
    const id = (JSON.parse(out.find(line => line.includes("\"id\"")) ?? "{}") as { nodes?: Array<{ id: string }> }).nodes?.[0]?.id;
    if (id) await runGraphGet([id], checkout, { write });
  } finally { spy.mockRestore(); }
  expect(explained).toBeGreaterThan(20);
  expect([...offending.entries()]).toEqual([]);
}, 120_000);
