/**
 * `mex wiki for-code`, and the claim it exists to make good on.
 *
 * The exit criterion is not "a function returns rows" — it is *given a task,
 * one command returns code scope **and** the conventions, decisions and
 * patterns grounded to that scope, within one token budget*. The last test here
 * is that sentence, executed: a real graph, a real wiki, one `graph scope
 * --wiki` run, and both halves in the output under one ledger.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../../../graph/index.js";
import { openGraphDatabase } from "../../../graph/db/database.js";
import { openSqlite } from "../../../graph/db/sqlite.js";
import { currentGraphPath } from "../../../graph/storage.js";
import { FingerprintStore } from "../../../graph/fingerprint-store.js";
import { MinHashReconciler } from "../../../graph/reconcile-engine.js";
import { runGraphScope, type AgentCommandDeps } from "../../../graph/cli-agent.js";
import { createGroundingGraph, deriveGrounding } from "../../grounding/adapter.js";
import { resolveGrounding } from "../../grounding/resolve.js";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import { knowledgeRecordsFor, runWikiForCode, WIKI_CLI_SCHEMA_VERSION, type ForCodeRecord } from "../for-code.js";
import type { GraphEngine } from "../../../graph/engine.js";

const DECISION_ID = "mx_01KR2E4K002H3ZYA9G0C4XV531";
const UNGROUNDED_ID = "mx_01KRMEXM00JAAVJPQVVRX8N56V";

let root: string;
let scaffoldRoot: string;
let engine: GraphEngine;
let db: ReturnType<typeof openGraphDatabase>;
let helperId: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-wiki-forcode-cli-"));
  scaffoldRoot = join(root, ".mex");
  mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
  writeFileSync(join(root, "util.ts"), `export function helper(x: number): number {\n  return x + 1;\n}\n`);
  writeFileSync(
    join(root, "main.ts"),
    `import { helper } from "./util";\nexport function run(): number {\n  return helper(41);\n}\n`,
  );

  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
  helperId = engine.searchNodes("helper").find((node) => node.kind === "function")!.id;

  const graphDbPath = currentGraphPath(root);
  const graphDb = openGraphDatabase(graphDbPath, { readOnly: true, immutable: true });
  const grounding = deriveGrounding(
    createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(graphDb)), graphDb),
    helperId,
  )!;
  graphDb.close();

  writeFileSync(
    join(scaffoldRoot, "context", "auth.md"),
    `---\nname: auth\n---\n\n# Authentication\n\n` +
      `<!-- mex:entity\nid: ${DECISION_ID}\ntype: decision\nstatus: promoted\nrevision: 1\n` +
      `grounds_to:\n  - node: ${grounding.node}\n    fingerprint: ${grounding.fingerprint}\n` +
      `    bodyHash: ${grounding.bodyHash}\n-->\n` +
      `## Increments go through helper\n\nEvery increment routes through one place.\n\n` +
      `<!-- mex:entity\nid: ${UNGROUNDED_ID}\ntype: convention\nstatus: promoted\nrevision: 1\n-->\n` +
      `## An ungrounded convention\n\nNot attached to any code.\n`,
    "utf-8",
  );

  const liveDb = openGraphDatabase(graphDbPath, { readOnly: true, immutable: true });
  const seam = createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(liveDb)), liveDb);
  rebuildWikiIndex({
    scaffoldRoot,
    indexPath: join(scaffoldRoot, "wiki.db"),
    resolveGrounding: (entry) => resolveGrounding(entry, seam),
  });
  liveDb.close();

  db = openGraphDatabase(graphDbPath, { readOnly: true, immutable: true });
}, 180000);

afterAll(() => {
  engine.close();
  db.close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // See the note in scope-attachment.test.ts: Windows file handles.
  }
});

function capture(run: (write: (line: string) => void) => void): Record<string, unknown>[] {
  const lines: string[] = [];
  run((line) => lines.push(line));
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("mex wiki for-code", () => {
  it("prints one JSONL record per grounded entity", () => {
    const records = capture((write) => runWikiForCode([helperId], root, { write }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "knowledge",
      id: DECISION_ID,
      entityType: "decision",
      title: "Increments go through helper",
      status: "promoted",
      // Resolved against the real graph during the rebuild, so this is a
      // verdict and not a placeholder.
      health: "fresh",
      matchedNodes: [helperId],
    });
    // An entity with no grounding is not "about" any code and must not appear.
    expect(records.map((record) => record.id)).not.toContain(UNGROUNDED_ID);
  });

  it("wraps the answer in the envelope P9 will standardize, under --json", () => {
    const records = capture((write) => runWikiForCode([helperId], root, { write, json: true }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schemaVersion: WIKI_CLI_SCHEMA_VERSION,
      ok: true,
      diagnostics: [],
    });
    const data = records[0]!["data"] as { entities: ForCodeRecord[]; truncated: boolean };
    expect(data.entities).toHaveLength(1);
    expect(data.truncated).toBe(false);
    // §15.2, both halves stated separately because the previous single
    // assertion only covered one of them: the top level is an object rather
    // than a bare array, and the line carries no ANSI.
    expect(Array.isArray(records[0])).toBe(false);
    expect(JSON.stringify(records[0]).startsWith("{")).toBe(true);
    // eslint-disable-next-line no-control-regex -- checking for ESC is the point.
    expect(JSON.stringify(records[0])).not.toMatch(/\u001b\[/);
  });

  it("reports a missing index as a typed diagnostic, and never rebuilds one", () => {
    const empty = mkdtempSync(join(tmpdir(), "mex-wiki-forcode-empty-"));
    try {
      const records = capture((write) =>
        runWikiForCode([helperId], empty, { write, json: true }),
      );
      expect(records[0]).toMatchObject({ ok: false });
      const diagnostics = records[0]!["diagnostics"] as Array<{ code: string }>;
      expect(diagnostics[0]!.code).toBe("WIKI_INDEX_MISSING");
      // A read never builds: the database the diagnostic complains about must
      // still not exist afterwards.
      expect(() => openSqlite(join(empty, ".mex", "wiki.db"), { readOnly: true })).toThrow();
    } finally {
      process.exitCode = 0;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("returns nothing, rather than everything, for a node nobody grounded", () => {
    expect(capture((write) => runWikiForCode(["function:0000000000000000"], root, { write }))).toEqual([]);
  });

  it("degrades to silence when there is no wiki at all", () => {
    // The `graph scope --wiki` path. A missing wiki must never take out a graph
    // command that would otherwise have succeeded.
    const empty = mkdtempSync(join(tmpdir(), "mex-wiki-forcode-none-"));
    try {
      expect(knowledgeRecordsFor([helperId], {}, empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("one command returns code scope and the knowledge grounded to it", () => {
  it("answers a task with both halves, inside one budget", () => {
    const lines: string[] = [];
    const deps: AgentCommandDeps = {
      open: () => ({ graph: engine, db, close: () => {} }),
      write: (line) => lines.push(line),
      knowledgeFor: (nodeIds) => knowledgeRecordsFor(nodeIds, {}, root).map((record) => ({ ...record })),
    };
    runGraphScope("helper increment", root, deps, {});
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    // The code half: the graph's own answer, unchanged.
    expect(records.some((record) => record.type === "fact" && record.name === "helper")).toBe(true);
    expect(records.some((record) => record.type === "source")).toBe(true);

    // The knowledge half: the decision grounded to exactly that code, found
    // through the node id and not through any word it happens to share.
    const knowledge = records.filter((record) => record.type === "knowledge");
    expect(knowledge).toHaveLength(1);
    expect(knowledge[0]).toMatchObject({ id: DECISION_ID, title: "Increments go through helper" });
    expect(knowledge[0]!["matchedNodes"]).toEqual([helperId]);

    // One budget, accounted for once: the summary's estimate covers everything
    // emitted, knowledge included.
    const summary = records.find((record) => record.type === "summary")!;
    expect(summary["truncated"]).toBe(false);
    expect(summary["estimatedOutputTokens"] as number).toBeGreaterThan(0);
    expect(summary["estimatedOutputTokens"] as number).toBeLessThanOrEqual(summary["maxOutputTokens"] as number);
  }, 60000);
});
