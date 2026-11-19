/**
 * The regression oracle — assertions harvested from a reference deployment.
 *
 * These are ported from a working demonstration whose verifier scripts were
 * the acceptance evidence that "the system still works". They are re-derived
 * here as mex's own tests, against mex's own vocabulary, because after this
 * phase that is what they are. Where a harvested check asserted something that
 * is false or meaningless under Markdown-canonical storage, it is recorded in
 * the handoff with its reason rather than silently dropped.
 *
 * Three groups, and the first is the most valuable thing in the set.
 *
 * ## 1. A read never mutates
 *
 * The pattern recurred across four of the source scripts and mex had no
 * equivalent: **the database is byte-identical after every read.** A read that
 * writes is the bug nobody finds — it corrupts under concurrency, it makes two
 * readers disagree, and every individual test still passes because each one
 * reads correctly. Asserting it needs a checksum taken before and after, over
 * every read path there is, which is what this does.
 *
 * ## 2. Grounding integrity
 *
 * No dangling grounding; a grounding is a declaration rather than a module;
 * one baseline row per (entity, node) pair. These are properties of the join
 * §5.1 is built on, and they are what makes code-driven retrieval trustworthy.
 *
 * ## 3. The drift beat
 *
 * One code edit, and exactly the entities that ride on the edited node go
 * stale — no more, no fewer. The source deployment shaped this so that a
 * single edit is provably the whole trigger, which is the part worth keeping:
 * a drift test where several things could have caused the verdict proves
 * nothing about the one that did.
 */

import { currentGraphPath } from "../../graph/storage.js";
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraphEngine } from "../../graph/engine-impl.js";
import { openGraphDatabase } from "../../graph/db/database.js";
import { FingerprintStore } from "../../graph/fingerprint-store.js";
import { MinHashReconciler } from "../../graph/reconcile-engine.js";
import { createGroundingGraph, createSynthesisGraph, deriveGrounding } from "../grounding/adapter.js";
import { resolveEntityGroundings, resolveGrounding } from "../grounding/resolve.js";
import { rebuildWikiIndex } from "../index/rebuild.js";
import { wikiGet, wikiGraph, wikiGroundingStatus, wikiList, wikiSearch, wikiNeighborhood, wikiBacklinks } from "../service/read.js";
import { wikiValidate } from "../service/validate.js";
import { wikiEvidence, wikiSupersessionTimeline, wikiTraceability } from "../service/hub.js";
import { openWikiQuery } from "../query/session.js";
import type { GroundingGraph } from "../grounding/adapter.js";

const GRAPH_TEST_TIMEOUT = 60_000;

const CONVENTION = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const DRIFT_UNIT = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const UNRELATED = "mx_01KRMEXM00JAAVJPQVVRX8N56V";

/** Two symbols; the first is what both load-bearing entities ride on. */
const SOURCE = `export function limitLength(value: string): string {
  const maximum = 255;
  return value.length > maximum ? value.slice(0, maximum) : value;
}

export function normalizeCase(value: string): string {
  return value.toLowerCase();
}
`;

/** The stage edit: 255 becomes 128, which is what the prose asserts against. */
const EDITED = SOURCE.replace("const maximum = 255;", "const maximum = 128;");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows holds SQLite files open a moment past close.
    }
  }
});

interface Project {
  root: string;
  scaffoldRoot: string;
  sourcePath: string;
}

function createProject(): Project {
  const root = mkdtempSync(join(tmpdir(), "mex-oracle-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, "src", "text.ts"), SOURCE, "utf-8");
  return { root, scaffoldRoot: join(root, ".mex"), sourcePath: join(root, "src", "text.ts") };
}

async function buildGraph(project: Project): Promise<void> {
  const engine = createGraphEngine({ rootDir: project.root });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
}

function withGraph<T>(project: Project, body: (graph: GroundingGraph, db: ReturnType<typeof openGraphDatabase>) => T, writable = false): T {
  const dbPath = currentGraphPath(project.root);
  const engine = createGraphEngine({ rootDir: project.root });
  // A published graph is immutable, so reads open it that way; only the test that
  // saves baselines needs to write.
  const db = openGraphDatabase(dbPath, writable ? {} : { readOnly: true, immutable: true });
  try {
    return body(createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db), db);
  } finally {
    engine.close();
    db.close();
  }
}

function nodeIdOf(project: Project, name: string): string {
  const dbPath = currentGraphPath(project.root);
  const engine = createGraphEngine({ rootDir: project.root });
  const db = openGraphDatabase(dbPath, { readOnly: true, immutable: true });
  try {
    const graph = createSynthesisGraph(engine, db);
    const found = graph.nodesInFile("src/text.ts").find((node) => graph.describeNode(node.id)?.name === name);
    if (found === undefined) throw new Error(`the graph has no node named ${name}`);
    return found.id;
  } finally {
    engine.close();
    db.close();
  }
}

/** Write a scaffold whose two entities both ground to `limitLength`. */
function writeScaffold(project: Project, groundings: Record<string, string[]>): void {
  const block = (id: string, type: string, title: string, prose: string): string => {
    const nodes = groundings[id] ?? [];
    const grounds =
      nodes.length === 0
        ? ""
        : `grounds_to:\n${nodes.map((entry) => `  - ${entry}`).join("\n")}\n`;
    return `<!-- mex:entity
id: ${id}
type: ${type}
status: promoted
revision: 1
title: ${title}
${grounds}-->
## ${title}

${prose}

`;
  };

  const text =
    block(CONVENTION, "convention", "Truncate rather than reject", "Over-long input is truncated, never refused.") +
    block(DRIFT_UNIT, "decision", "The cap is 255 characters", "The maximum accepted length is 255 characters.") +
    block(UNRELATED, "component", "Case normalizer", "Lowercases input before comparison.");
  // A fixture that silently yields fewer entities than it declares empties
  // every assertion downstream of it, so it is counted here rather than hoped
  // for. Three ids, three blocks.
  for (const id of [CONVENTION, DRIFT_UNIT, UNRELATED]) {
    if (!text.includes(`id: ${id}`)) throw new Error(`the fixture lost ${id}`);
  }
  writeFileSync(join(project.scaffoldRoot, "context", "text.md"), text, "utf-8");
}

/**
 * A checksum over the index database itself.
 *
 * **The database only, not its `-wal` and `-shm` siblings**, and that is a
 * measured decision rather than a convenience. Digesting all three fails, and
 * examining why is the interesting part: opening a WAL-mode database *creates*
 * a `-shm` shared-memory file and an empty `-wal`, even for a pure read. No
 * data is written — the WAL is zero bytes, so no transaction was committed,
 * and `wiki.db` itself is byte-for-byte unchanged.
 *
 * So the honest claim is the one asserted below: a read does not change the
 * data, and leaves no committed transaction behind. It is *not* true that a
 * read touches no files at all, and a test claiming that would be wrong rather
 * than strict. The consequence is real and is recorded: reading an index on a
 * genuinely read-only filesystem needs SQLite's immutable open, which the wiki
 * index does not currently pass.
 */
function indexDigest(scaffoldRoot: string): string {
  return createHash("sha256").update(readFileSync(join(scaffoldRoot, "wiki.db"))).digest("hex");
}

/** Bytes in the write-ahead log — non-zero means a transaction was committed. */
function walSize(scaffoldRoot: string): number {
  try {
    return readFileSync(join(scaffoldRoot, "wiki.db-wal")).byteLength;
  } catch {
    return 0;
  }
}

describe("a read never mutates what it reads", () => {
  function indexed(): string {
    const project = createProject();
    writeScaffold(project, {});
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    return project.scaffoldRoot;
  }

  it("leaves the index byte-identical after every read path", () => {
    const scaffoldRoot = indexed();
    const before = indexDigest(scaffoldRoot);

    // Every read the service offers, including the composed ones. A read that
    // wrote would be invisible to each of these tests individually — they all
    // return the right answer — and visible only here.
    wikiList({ scaffoldRoot });
    wikiGet({ scaffoldRoot, id: CONVENTION });
    wikiGet({ scaffoldRoot, id: CONVENTION, includeBody: true });
    wikiSearch({ scaffoldRoot, text: "truncated" });
    wikiNeighborhood({ scaffoldRoot, id: CONVENTION });
    wikiBacklinks({ scaffoldRoot, id: CONVENTION });
    wikiGroundingStatus({ scaffoldRoot });
    wikiGraph({ scaffoldRoot });
    wikiEvidence({ scaffoldRoot, id: CONVENTION });
    wikiSupersessionTimeline({ scaffoldRoot, id: DRIFT_UNIT });
    wikiTraceability({ scaffoldRoot, id: CONVENTION });

    expect(indexDigest(scaffoldRoot)).toBe(before);
    // And nothing was committed: a WAL with bytes in it is a write, however
    // the database file happened to compare.
    expect(walSize(scaffoldRoot)).toBe(0);
  });

  it("is measuring an index that exists and answers", () => {
    // Every assertion above would hold over an index that returned nothing, so
    // the subject is measured before it is trusted.
    const scaffoldRoot = indexed();
    expect(readFileSync(join(scaffoldRoot, "wiki.db")).byteLength).toBeGreaterThan(0);
    expect(wikiList({ scaffoldRoot }).data.entities).toHaveLength(3);
    expect(wikiGet({ scaffoldRoot, id: CONVENTION }).data.entity).not.toBeNull();
  });

  it("leaves the scaffold's Markdown byte-identical after every read path", () => {
    const project = createProject();
    writeScaffold(project, {});
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    const path = join(project.scaffoldRoot, "context", "text.md");
    const before = readFileSync(path, "utf-8");

    wikiList({ scaffoldRoot: project.scaffoldRoot });
    wikiValidate({ scaffoldRoot: project.scaffoldRoot });
    wikiGraph({ scaffoldRoot: project.scaffoldRoot });
    wikiEvidence({ scaffoldRoot: project.scaffoldRoot, id: CONVENTION });

    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("does not mutate the code graph by reading knowledge out of it", async () => {
    const project = createProject();
    await buildGraph(project);
    const graphPath = currentGraphPath(project.root);
    const before = createHash("sha256").update(readFileSync(graphPath)).digest("hex");

    const nodeId = nodeIdOf(project, "limitLength");
    writeScaffold(project, { [CONVENTION]: [`node: ${nodeId}`] });
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    wikiGroundingStatus({ scaffoldRoot: project.scaffoldRoot });
    wikiTraceability({ scaffoldRoot: project.scaffoldRoot, id: CONVENTION });

    // Adding knowledge, and reading it back, must not touch the code graph.
    expect(createHash("sha256").update(readFileSync(graphPath)).digest("hex")).toBe(before);
  }, GRAPH_TEST_TIMEOUT);
});

describe("grounding integrity", () => {
  it("has no dangling grounding, and every grounding names a node the graph has", async () => {
    const project = createProject();
    await buildGraph(project);
    const nodeId = nodeIdOf(project, "limitLength");

    const grounding = withGraph(project, (graph) => deriveGrounding(graph, nodeId));
    expect(grounding, "the fixture node must be groundable").not.toBeNull();
    writeScaffold(project, {
      [CONVENTION]: [`node: ${grounding!.node}\n    fingerprint: ${grounding!.fingerprint}\n    bodyHash: ${grounding!.bodyHash}`],
    });
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });

    const session = openWikiQuery(join(project.scaffoldRoot, "wiki.db"));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    try {
      const groundings = session.value.groundingsFor(CONVENTION);
      expect(groundings).toHaveLength(1);
      withGraph(project, (graph) => {
        for (const entry of groundings) {
          expect(graph.getNode(entry.nodeId), `${entry.nodeId} is dangling`).not.toBeNull();
        }
      });
    } finally {
      session.value.close();
    }
  }, GRAPH_TEST_TIMEOUT);

  it("grounds to declarations rather than to whole files", async () => {
    // A grounding onto a `file:` node says "this knowledge is about that file",
    // which is not a claim the drift machinery can check usefully: any edit
    // anywhere in the file moves it. The reference deployment asserted this
    // and it is worth keeping.
    const project = createProject();
    await buildGraph(project);
    const nodeId = nodeIdOf(project, "limitLength");
    expect(nodeId.startsWith("file:")).toBe(false);
    expect(nodeId.startsWith("function:")).toBe(true);
  }, GRAPH_TEST_TIMEOUT);

  it("keeps one baseline row per (entity, node) pair however often it is captured", async () => {
    const project = createProject();
    await buildGraph(project);
    const nodeId = nodeIdOf(project, "limitLength");

    withGraph(project, (graph, db) => {
      const store = new FingerprintStore(db);
      const grounding = deriveGrounding(graph, nodeId)!;
      const subject = { kind: "entity" as const, id: CONVENTION };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        store.saveBaseline({
          subject,
          nodeId: grounding.node,
          source: SOURCE,
          bodyHash: grounding.bodyHash ?? "",
          fingerprint: grounding.fingerprint,
        });
      }
      expect(store.listBaselines(subject)).toHaveLength(1);
    }, true);
  }, GRAPH_TEST_TIMEOUT);
});

describe("the drift beat — one edit, and exactly what rides on it goes stale", () => {
  it("takes exactly the entities grounded to the edited node stale, and no others", async () => {
    const project = createProject();
    await buildGraph(project);
    const limitNode = nodeIdOf(project, "limitLength");
    const caseNode = nodeIdOf(project, "normalizeCase");
    expect(limitNode).not.toBe(caseNode);

    const [limitGrounding, caseGrounding] = withGraph(project, (graph) => [
      deriveGrounding(graph, limitNode)!,
      deriveGrounding(graph, caseNode)!,
    ]);
    const render = (entry: { node: string; fingerprint: string; bodyHash?: string }): string =>
      `node: ${entry.node}\n    fingerprint: ${entry.fingerprint}\n    bodyHash: ${entry.bodyHash}`;

    writeScaffold(project, {
      [CONVENTION]: [render(limitGrounding)],
      [DRIFT_UNIT]: [render(limitGrounding)],
      [UNRELATED]: [render(caseGrounding)],
    });

    // Baseline: nothing is stale before the edit. Without this the assertion
    // after the edit could be measuring a scaffold that was never fresh.
    withGraph(project, (graph) => {
      for (const grounding of [limitGrounding, caseGrounding]) {
        expect(resolveEntityGroundings([grounding], graph).health).toBe("fresh");
      }
    });

    // The stage edit: one constant, in one function.
    writeFileSync(project.sourcePath, EDITED, "utf-8");
    await buildGraph(project);

    withGraph(project, (graph) => {
      // The edited symbol's groundings are stale...
      expect(resolveEntityGroundings([limitGrounding], graph).health).not.toBe("fresh");
      // ...and the untouched symbol's is not. This is the half that makes the
      // edit provably the whole trigger: a resolver that called everything
      // stale would satisfy the assertion above on its own.
      expect(resolveEntityGroundings([caseGrounding], graph).health).toBe("fresh");
    });
  }, GRAPH_TEST_TIMEOUT);

  it("changes one node and leaves the node count alone — a body edit is not structural", async () => {
    const project = createProject();
    await buildGraph(project);
    const before = nodeIdOf(project, "limitLength");
    const countBefore = withGraph(project, (_graph, db) =>
      (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c,
    );

    writeFileSync(project.sourcePath, EDITED, "utf-8");
    await buildGraph(project);

    const countAfter = withGraph(project, (_graph, db) =>
      (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c,
    );
    expect(countAfter).toBe(countBefore);
    // The node keeps its identity across a body edit, which is what makes the
    // grounding still resolve to it rather than reading as deleted.
    expect(nodeIdOf(project, "limitLength")).toBe(before);
  }, GRAPH_TEST_TIMEOUT);

  it("reports the entity's health as changed while its lifecycle stays promoted", async () => {
    // §5.7, and the reference deployment's own separation: drift is checkout
    // health, lifecycle is governance. A code edit must never rewrite what the
    // team agreed is current.
    const project = createProject();
    await buildGraph(project);
    const limitNode = nodeIdOf(project, "limitLength");
    const grounding = withGraph(project, (graph) => deriveGrounding(graph, limitNode)!);
    writeScaffold(project, {
      [CONVENTION]: [`node: ${grounding.node}\n    fingerprint: ${grounding.fingerprint}\n    bodyHash: ${grounding.bodyHash}`],
    });

    writeFileSync(project.sourcePath, EDITED, "utf-8");
    await buildGraph(project);

    withGraph(project, (graph) => {
      rebuildWikiIndex({
        scaffoldRoot: project.scaffoldRoot,
        resolveGrounding: (entry) => resolveGrounding(entry, graph),
      });
    });

    const status = wikiGroundingStatus({ scaffoldRoot: project.scaffoldRoot, id: CONVENTION });
    expect(status.data.entities[0]!.health).not.toBe("fresh");
    expect(status.data.entities[0]!.status).toBe("promoted");
  }, GRAPH_TEST_TIMEOUT);
});
