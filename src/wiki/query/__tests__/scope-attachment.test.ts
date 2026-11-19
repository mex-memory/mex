/**
 * HARD: `mex graph scope` output is byte-identical with the wiki flag off.
 *
 * The plan claimed the existing "protocol-v3 goldens" would prove this. There
 * is no golden corpus — `AGENT_PROTOCOL_VERSION = 3` is real and the guarantee
 * lives in contract tests, not in stored files — so the comparison is built
 * here instead of leaned on (§3c finding 35).
 *
 * What "byte-identical when off" can actually mean, given the flag now exists,
 * is pinned by three claims that together leave nowhere for a change to hide:
 *
 * 1. **The graph does not know the wiki exists.** No module under `src/graph/`
 *    imports `src/wiki/`, so with no provider supplied there is no wiki code to
 *    run, skip, or perturb anything — the flag-off path is the same code it was
 *    before the option was added. This is the structural half and it is checked
 *    against the source.
 * 2. **A provider that returns nothing changes nothing.** Byte-for-byte, every
 *    line, including the summary record whose `truncated` flag is the one field
 *    that could quietly move.
 * 3. **A provider that returns something only ever appends.** The entire
 *    flag-off stream is a prefix of the flag-on stream; no graph record is
 *    reordered, edited or dropped.
 */

import { currentGraphPath } from "../../../graph/storage.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../../../graph/index.js";
import { openSqlite } from "../../../graph/db/sqlite.js";
import { runGraphScope, type AgentCommandDeps } from "../../../graph/cli-agent.js";
import type { GraphEngine } from "../../../graph/engine.js";

let root: string;
let engine: GraphEngine;
let db: ReturnType<typeof openSqlite>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-scope-wiki-"));
  writeFileSync(join(root, "util.ts"), `export function helper(x: number): number {\n  return x + 1;\n}\n`);
  writeFileSync(
    join(root, "main.ts"),
    `import { helper } from "./util";\n` +
      `export function run(): number {\n  return helper(41);\n}\n`,
  );
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
  db = openSqlite(currentGraphPath(root));
}, 120000);

afterAll(() => {
  engine.close();
  db.close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows keeps a handle on a just-closed SQLite file often enough that
    // cleanup failure would otherwise be the only red in this file.
  }
});

function scopeLines(extra: Partial<AgentCommandDeps> = {}): string[] {
  const lines: string[] = [];
  const deps: AgentCommandDeps = {
    open: () => ({ graph: engine, db, close: () => {} }),
    write: (line) => lines.push(line),
    ...extra,
  };
  runGraphScope("run helper", root, deps, {});
  return lines;
}

describe("HARD: scope output is unchanged with the wiki flag off", () => {
  it("produces output at all, so the comparisons below are not over nothing", () => {
    const lines = scopeLines();
    expect(lines.length).toBeGreaterThan(2);
    const kinds = lines.map((line) => (JSON.parse(line) as { type?: string }).type);
    expect(kinds[0]).toBe("meta");
    expect(kinds).toContain("summary");
    expect(kinds).toContain("fact");
  });

  it("no module under src/graph/ imports the wiki", () => {
    // The structural half, and the one that makes "byte-identical when off" a
    // property rather than a promise: the graph cannot behave differently
    // because of code it has no reference to. The provider is injected by
    // `src/cli.ts`, which is where composition belongs — and `wiki/query/budget`
    // already imports `graph/agent-protocol`, so importing back would make the
    // two genuinely mutually dependent.
    const repoRoot = resolve(__dirname, "..", "..", "..", "..");
    const graphDir = join(repoRoot, "src", "graph");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "wasm") continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf-8");
        for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
          if (/(^|\/)wiki\//.test(match[1]!)) {
            offenders.push(`${relative(repoRoot, full).replace(/\\/g, "/")} → ${match[1]!}`);
          }
        }
      }
    };
    walk(graphDir);
    expect(offenders).toEqual([]);
    // Vacuity guard: the walk has to have found files to check.
    expect(readdirSync(graphDir).length).toBeGreaterThan(5);
  });

  it("is byte-identical when the provider returns nothing", () => {
    const off = scopeLines();
    const empty = scopeLines({ knowledgeFor: () => [] });
    // Every line, including the summary — whose `truncated` flag is the one
    // field a provider could move without touching any record.
    expect(empty.join("\n")).toBe(off.join("\n"));
    expect(createHash("sha256").update(empty.join("\n")).digest("hex"))
      .toBe(createHash("sha256").update(off.join("\n")).digest("hex"));
  });

  it("only ever appends when the provider returns records", () => {
    const off = scopeLines();
    const seen: string[][] = [];
    const on = scopeLines({
      knowledgeFor: (nodeIds) => {
        seen.push([...nodeIds]);
        return [{ type: "knowledge", id: "mx_01KR2E4K002H3ZYA9G0C4XV531", title: "A decision" }];
      },
    });

    // The provider was actually consulted, with the nodes scope returned —
    // otherwise "appends nothing" and "appends only" are the same test.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.length).toBeGreaterThan(0);

    const knowledge = on.filter((line) => (JSON.parse(line) as { type?: string }).type === "knowledge");
    expect(knowledge).toHaveLength(1);

    // **Positional, not set-based.** Filtering the knowledge records out and
    // comparing what remains would pass even if they had been emitted *first* —
    // verified by planting exactly that reordering and watching the filtered
    // form stay green. "Appends" is a claim about position, so the flag-off
    // stream must be a byte-identical *prefix* of the flag-on one.
    const upToSummary = (lines: string[]): string[] =>
      lines.slice(0, lines.findIndex((line) => (JSON.parse(line) as { type?: string }).type === "summary"));
    const offBody = upToSummary(off);
    expect(offBody.length).toBeGreaterThan(2);
    expect(on.slice(0, offBody.length)).toEqual(offBody);
    // And the knowledge records sit after that prefix, before the summary.
    expect(on.indexOf(knowledge[0]!)).toBeGreaterThanOrEqual(offBody.length);

    // The summary differs in exactly one field, and that difference is the
    // ledger doing its job: an appended record costs tokens and the response's
    // own accounting says so. Asserted field by field rather than waved at,
    // because "the summary changed a bit" is how a real regression would look.
    const summaryOf = (lines: string[]): Record<string, unknown> =>
      JSON.parse(lines.find((line) => (JSON.parse(line) as { type?: string }).type === "summary")!) as Record<string, unknown>;
    const offSummary = summaryOf(off);
    const onSummary = summaryOf(on);
    expect(onSummary["estimatedOutputTokens"]).toBeGreaterThan(offSummary["estimatedOutputTokens"] as number);
    delete offSummary["estimatedOutputTokens"];
    delete onSummary["estimatedOutputTokens"];
    expect(onSummary).toEqual(offSummary);
  });

  it("charges the provider's records to the same ledger", () => {
    // A provider must not be able to smuggle output past the caller's token
    // ceiling. Asked for far more than any budget allows, the stream stays
    // bounded rather than growing to fit.
    const flood = Array.from({ length: 5000 }, (_, index) => ({
      type: "knowledge",
      id: `mx_${String(index).padStart(26, "0")}`,
      title: "A decision with a title long enough to cost real tokens".repeat(4),
    }));
    const on = scopeLines({ knowledgeFor: () => flood });
    const knowledge = on.filter((line) => (JSON.parse(line) as { type?: string }).type === "knowledge");
    expect(knowledge.length).toBeGreaterThan(0);
    expect(knowledge.length).toBeLessThan(flood.length);
  });
});
