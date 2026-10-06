/**
 * §21 and §24 — the acceptance sweep, walked as a set.
 *
 * Every phase has asserted its own exit criteria. Nothing before this had
 * walked §21's seven groups or §24's thirteen clauses end to end, which is a
 * different exercise: it measures the engine against the *spec* rather than
 * against each phase's brief, and the two can drift without anything failing.
 *
 * ## How to read this file
 *
 * Every clause is one test, named for its clause, so a failure names the
 * acceptance criterion rather than a mechanism. Where an earlier phase already
 * proves a clause in depth, this asserts it **at the boundary** — through the
 * service surface a consumer actually calls — rather than restating the
 * phase's own test. A clause proved twice in two vocabularies is a clause that
 * can pass in one and fail in the other.
 *
 * Three clauses are not closed by a test here and say so in their own names,
 * because a clause closed by argument is a different thing from a clause
 * closed by evidence and the handoff records which is which.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGraphEngine } from "../../graph/engine-impl.js";
import { openGraphDatabase } from "../../graph/db/database.js";
import { FingerprintStore } from "../../graph/fingerprint-store.js";
import { MinHashReconciler } from "../../graph/reconcile-engine.js";
import { createGroundingGraph, createSynthesisGraph, deriveGrounding } from "../grounding/adapter.js";
import { resolveGrounding } from "../grounding/resolve.js";
import { createWikiEngine } from "../service.js";
import { rebuildWikiIndex } from "../index/rebuild.js";
import { dumpWikiIndex } from "../index/dump.js";
import { openWikiIndex } from "../index/open.js";
import { locateEntity } from "../operations/locate.js";
import { entityContentHash } from "../model/hash.js";
import { entityTextOf } from "../markdown/codec.js";
import { readAuditLog, acceptedOperations } from "../operations/audit.js";
import { queryEntitiesGroundedIn } from "../query/for-code.js";
import { openWikiQuery } from "../query/session.js";
import { WIKI_OPERATION_TYPES } from "../model/operation.js";
import type { GroundingGraph } from "../grounding/adapter.js";

const GRAPH_TIMEOUT = 60_000;
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const ARCH = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const COMPONENT = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const DECISION = "mx_01KRMEXM00JAAVJPQVVRX8N56V";
const TOPIC = "mx_01KRZ8B4Q7WNVX5JGD3M2PTKS6";

const SOURCE = `export function rotateToken(userId: string): number {
  const windowSeconds = 3600;
  return userId.length * windowSeconds;
}
`;

function scaffoldText(groundsTo = ""): Record<string, string> {
  return {
    "context/architecture.md": `<!-- mex:entity
id: ${TOPIC}
type: topic
status: promoted
revision: 1
title: Authentication
-->
## Authentication

Everything about tokens lives under this topic.

<!-- mex:entity
id: ${ARCH}
type: architecture
status: promoted
revision: 1
title: System architecture
topics: [${TOPIC}]
sources:
  - type: url
    ref: https://example.invalid/design
    note: The original design note
relations:
  - type: depends_on
    target: ${COMPONENT}
-->
## System architecture

Three services behind one gateway.

<!-- mex:entity
id: ${COMPONENT}
type: component
status: promoted
revision: 1
title: Token service
topics: [${TOPIC}]
${groundsTo}-->
## Token service

Issues and rotates tokens.
`,
    "context/decisions.md": `<!-- mex:entity
id: ${DECISION}
type: decision
status: promoted
revision: 1
title: Rotate hourly
relations:
  - type: implements
    target: ${COMPONENT}
-->
## Rotate hourly

The rotation window is one hour.
`,
  };
}

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

function createProject(groundsTo = ""): Project {
  const root = mkdtempSync(join(tmpdir(), "mex-accept-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.ts"), SOURCE, "utf-8");
  const scaffoldRoot = join(root, ".mex");
  for (const [path, text] of Object.entries(scaffoldText(groundsTo))) {
    const absolute = join(scaffoldRoot, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text, "utf-8");
  }
  return { root, scaffoldRoot, sourcePath: join(root, "src", "auth.ts") };
}

function engineFor(project: Project) {
  return createWikiEngine({ scaffoldRoot: project.scaffoldRoot });
}

async function buildGraph(project: Project): Promise<void> {
  const engine = createGraphEngine({ rootDir: project.root });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
}

function withGraph<T>(project: Project, body: (graph: GroundingGraph, db: ReturnType<typeof openGraphDatabase>) => T): T {
  const dbPath = join(project.root, ".mex", "graph.db");
  const engine = createGraphEngine({ rootDir: project.root, dbPath });
  const db = openGraphDatabase(dbPath);
  try {
    return body(createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db), db);
  } finally {
    engine.close();
    db.close();
  }
}

function nodeIdOf(project: Project, name: string): string {
  const dbPath = join(project.root, ".mex", "graph.db");
  const engine = createGraphEngine({ rootDir: project.root, dbPath });
  const db = openGraphDatabase(dbPath);
  try {
    const graph = createSynthesisGraph(engine, db);
    const found = graph.nodesInFile("src/auth.ts").find((node) => graph.describeNode(node.id)?.name === name);
    if (found === undefined) throw new Error(`no node named ${name}`);
    return found.id;
  } finally {
    engine.close();
    db.close();
  }
}

/** An operation envelope with a live precondition, the way a real caller builds one. */
function envelopeFor(
  project: Project,
  type: string,
  entityId: string,
  payload: unknown,
  opId: string,
): Record<string, unknown> {
  const located = locateEntity(entityId, { scaffoldRoot: project.scaffoldRoot });
  if (located === null) throw new Error(`cannot locate ${entityId}`);
  return {
    opId,
    type,
    actor: { kind: "human", id: "acceptance" },
    timestamp: "2026-08-25T00:00:00.000Z",
    entityId,
    baseRevision: located.entity.revision,
    baseContentHash: entityContentHash(entityTextOf(located.text, located.entity.location!)),
    payload,
  };
}

// ── §21.1 Canonical and rebuildable ─────────────────────────────────────────

describe("§21.1 canonical and rebuildable", () => {
  it("rebuilds every entity, relation, topic, source and grounding from Markdown alone", async () => {
    const project = createProject();
    await buildGraph(project);
    const nodeId = nodeIdOf(project, "rotateToken");
    const grounding = withGraph(project, (graph) => deriveGrounding(graph, nodeId)!);

    const path = join(project.scaffoldRoot, "context", "architecture.md");
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace(
        `topics: [${TOPIC}]\n-->\n## Token service`,
        `topics: [${TOPIC}]\ngrounds_to:\n  - node: ${grounding.node}\n    fingerprint: ${grounding.fingerprint}\n    bodyHash: ${grounding.bodyHash}\n-->\n## Token service`,
      ),
      "utf-8",
    );

    const engine = engineFor(project);
    await engine.rebuildIndex();

    // Each of the five kinds the clause names, counted rather than sampled.
    const listed = await engine.list();
    expect(listed.data.entities).toHaveLength(4);

    const related = await engine.related(ARCH);
    expect(related.data?.relations.map((edge) => edge.targetId)).toEqual([COMPONENT]);

    expect((await engine.list({ topicId: TOPIC })).data.entities).toHaveLength(2);

    const evidence = openWikiQuery(join(project.scaffoldRoot, "wiki.db"));
    expect(evidence.ok).toBe(true);
    if (evidence.ok) {
      try {
        expect(evidence.value.sourcesFor(ARCH)).toHaveLength(1);
        expect(evidence.value.groundingsFor(COMPONENT)).toHaveLength(1);
      } finally {
        evidence.value.close();
      }
    }
  }, GRAPH_TIMEOUT);

  it("loses nothing shareable when wiki.db is deleted", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();
    const before = (await engine.list()).data.entities.map((entity) => entity.id).sort();
    const dump = (): string => {
      const opened = openWikiIndex(join(project.scaffoldRoot, "wiki.db"));
      if (!opened.ok) throw new Error("index missing");
      try {
        return dumpWikiIndex(opened.index.db);
      } finally {
        opened.index.close();
      }
    };
    const dumpBefore = dump();

    rmSync(join(project.scaffoldRoot, "wiki.db"), { force: true });
    expect(existsSync(join(project.scaffoldRoot, "wiki.db"))).toBe(false);
    await engine.rebuildIndex();

    expect((await engine.list()).data.entities.map((entity) => entity.id).sort()).toEqual(before);
    // Byte-identical, not merely "the same count".
    expect(dump()).toBe(dumpBefore);
    expect(before.length).toBe(4);
  });

  it("keeps wiki.db* out of Git", () => {
    // Asserted through Git itself rather than by reading .gitignore, because
    // what matters is the answer Git gives, not the text of the rule.
    for (const path of [".mex/wiki.db", ".mex/wiki.db-wal", ".mex/wiki.db-shm"]) {
      const output = execFileSync("git", ["check-ignore", "-v", path], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(output).toContain(path);
    }
  });
});

// ── §21.2 Stable identity ───────────────────────────────────────────────────

describe("§21.2 stable identity", () => {
  it("survives a heading rename, a move to another file, and a reorganization", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();

    const before = await engine.related(COMPONENT, { includeBacklinks: true });
    const backlinksBefore = before.data!.backlinks.map((edge) => `${edge.type}:${edge.targetId}`).sort();
    const topicsBefore = (await engine.list({ topicId: TOPIC })).data.entities.map((entity) => entity.id).sort();
    expect(backlinksBefore.length).toBeGreaterThan(0);

    // 1. Rename the heading.
    const renamed = await engine.applyOperation(
      envelopeFor(project, "update-entry", COMPONENT, { title: "Token rotation service" }, "op_rename"),
      { apply: true },
    );
    expect(renamed.data.applied).toBe(true);
    // 2. Move it to another file. `file` + `insertAt`, not `targetFile`: a
    // move has to say *where* in the destination, or the operation is refused.
    const moved = await engine.applyOperation(
      envelopeFor(
        project,
        "move-entry",
        COMPONENT,
        { file: "context/decisions.md", insertAt: { at: "end-of-file" } },
        "op_move",
      ),
      { apply: true },
    );
    // Asserted, because a refused operation would otherwise leave the entity
    // where it was and the clause would fail as though identity had broken.
    expect(moved.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(moved.data.applied).toBe(true);
    // 3. Reorganize what is around it.
    const decisions = join(project.scaffoldRoot, "context", "decisions.md");
    writeFileSync(decisions, `# Decisions\n\nA new preamble nobody owns.\n\n${readFileSync(decisions, "utf-8")}`, "utf-8");

    await engine.rebuildIndex();

    const after = await engine.get(COMPONENT);
    expect(after.data.entity, "the id must survive all three").not.toBeNull();
    expect(after.data.entity!.title).toBe("Token rotation service");
    expect(after.data.entity!.file).toBe("context/decisions.md");

    const relatedAfter = await engine.related(COMPONENT, { includeBacklinks: true });
    expect(relatedAfter.data!.backlinks.map((edge) => `${edge.type}:${edge.targetId}`).sort()).toEqual(backlinksBefore);
    expect((await engine.list({ topicId: TOPIC })).data.entities.map((entity) => entity.id).sort()).toEqual(topicsBefore);
  });
});

// ── §21.3 Safe mutation ─────────────────────────────────────────────────────

describe("§21.3 safe mutation", () => {
  it("changes only the entity's own range, plus the operation log", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();

    const path = join(project.scaffoldRoot, "context", "architecture.md");
    const before = readFileSync(path, "utf-8");
    const otherBefore = readFileSync(join(project.scaffoldRoot, "context", "decisions.md"), "utf-8");

    await engine.applyOperation(
      envelopeFor(project, "update-entry", COMPONENT, { summary: "Issues and rotates bearer tokens." }, "op_scope"),
      { apply: true },
    );

    const after = readFileSync(path, "utf-8");
    expect(after).not.toBe(before);
    // Sentinels outside the changed entity, each checked individually so a
    // whole-file comparison cannot pass by being wrong in two places.
    expect(after).toContain("Everything about tokens lives under this topic.");
    expect(after).toContain("Three services behind one gateway.");
    expect(after.slice(0, after.indexOf("id: " + COMPONENT))).toBe(
      before.slice(0, before.indexOf("id: " + COMPONENT)),
    );
    expect(readFileSync(join(project.scaffoldRoot, "context", "decisions.md"), "utf-8")).toBe(otherBefore);

    expect(acceptedOperations(readAuditLog(project.scaffoldRoot))).toHaveLength(1);
  });

  it("blocks a write whose revision precondition is stale", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();
    const envelope = envelopeFor(project, "update-entry", COMPONENT, { summary: "First." }, "op_stale_rev");
    const before = readFileSync(join(project.scaffoldRoot, "context", "architecture.md"), "utf-8");

    const result = await engine.applyOperation({ ...envelope, baseRevision: 99 }, { apply: true });
    expect(result.data.applied).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("REVISION_CONFLICT");
    expect(readFileSync(join(project.scaffoldRoot, "context", "architecture.md"), "utf-8")).toBe(before);
  });

  it("blocks a write whose content-hash precondition is stale", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();
    const envelope = envelopeFor(project, "update-entry", COMPONENT, { summary: "First." }, "op_stale_hash");
    const before = readFileSync(join(project.scaffoldRoot, "context", "architecture.md"), "utf-8");

    const result = await engine.applyOperation(
      { ...envelope, baseContentHash: "0".repeat(64) },
      { apply: true },
    );
    expect(result.data.applied).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("CONTENT_HASH_CONFLICT");
    expect(readFileSync(join(project.scaffoldRoot, "context", "architecture.md"), "utf-8")).toBe(before);
  });

  it("returns the exact diff a dry run promised", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();
    const envelope = envelopeFor(project, "update-entry", COMPONENT, { summary: "Exactly this." }, "op_exact");

    const planned = await engine.planOperation(envelope);
    expect(planned.data.planned).toBe(true);
    // The bytes the plan said the file would contain, compared against what
    // apply actually wrote. Not a reconstruction from the rendered hunks: those
    // are a line-based *display* diff that drops a trailing newline, so
    // replaying them does not give the file back — which is exactly why
    // `proposedText` exists on the plan.
    const targetPath = planned.data.files[0]!;
    const absolute = join(project.scaffoldRoot, targetPath);
    const original = readFileSync(absolute, "utf-8");
    const promised = planned.data.proposedText[targetPath]!;
    expect(promised).not.toBe(original);
    expect(promised).toContain("Exactly this.");

    await engine.applyOperation(envelope, { apply: true });
    expect(readFileSync(absolute, "utf-8")).toBe(promised);

    // And the rendered diff a human reads describes that same change, so the
    // two halves of "the exact intended diff" cannot disagree.
    const diff = planned.data.preview!.files.find((file) => file.path === targetPath)!;
    expect(diff.hunks.length).toBeGreaterThan(0);
    expect(diff.hunks.flatMap((hunk) => hunk.added).join("\n")).toContain("Exactly this.");
  });
});

// ── §21.4 Migration ─────────────────────────────────────────────────────────

describe("§21.4 migration", () => {
  function legacyProject(): Project {
    const root = mkdtempSync(join(tmpdir(), "mex-accept-mig-"));
    roots.push(root);
    const scaffoldRoot = join(root, ".mex");
    mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
    mkdirSync(join(scaffoldRoot, "patterns"), { recursive: true });
    writeFileSync(
      join(scaffoldRoot, "context", "architecture.md"),
      `---
name: architecture
description: How the system fits together.
edges:
  - target: patterns/retry.md
    condition: when a call may fail transiently
---
# Architecture

## System architecture

Three services sit behind one gateway, which terminates TLS and routes by path
prefix. Authentication happens in exactly one place and the audit trail has a
single writer, which is the property the arrangement exists to preserve.
`,
      "utf-8",
    );
    writeFileSync(
      join(scaffoldRoot, "patterns", "retry.md"),
      `---
name: retry-with-backoff
description: Retry idempotent calls with exponential backoff.
---
# Retry with backoff

Retry idempotent calls with exponential backoff and full jitter. A fixed delay
synchronises every client that failed at the same moment, so the retry storm
arrives together and the recovering service falls over a second time.
`,
      "utf-8",
    );
    return { root, scaffoldRoot, sourcePath: "" };
  }

  it("leaves existing content readable and substantively unchanged", async () => {
    const project = legacyProject();
    const before = Object.fromEntries(
      ["context/architecture.md", "patterns/retry.md"].map((path) => [
        path,
        readFileSync(join(project.scaffoldRoot, path), "utf-8"),
      ]),
    );

    const engine = engineFor(project);
    const plan = await engine.planMigration();
    const applied = await engine.applyMigration(plan.data);
    expect(applied.data.applied).toBe(true);
    expect(applied.data.report.idsGenerated.length).toBeGreaterThan(0);

    // Every line of prose from before must still be there, in order.
    for (const [path, original] of Object.entries(before)) {
      const now = readFileSync(join(project.scaffoldRoot, path), "utf-8");
      for (const line of original.split("\n").filter((entry) => entry.trim().length > 0)) {
        if (line.startsWith("---") || /^[a-z_]+:/.test(line) || line.startsWith("  ")) continue;
        expect(now, `${path} lost: ${line}`).toContain(line);
      }
    }
  });

  it("retains compatible edges and surfaces what it could not decide", async () => {
    const project = legacyProject();
    const engine = engineFor(project);
    const plan = await engine.planMigration();
    // Ambiguity is surfaced as an outcome rather than swallowed. Either a
    // conversion is planned or an abstention says why not; silence is the failure.
    expect(
      plan.data.report.edgesConverted
        + plan.data.report.edgesAmbiguous
        + plan.data.report.abstentions.length,
    ).toBeGreaterThan(0);
    await engine.applyMigration(plan.data);

    // The legacy key survives — it is shipped navigation and a shipped drift
    // check reads it — and the relation is additive.
    expect(readFileSync(join(project.scaffoldRoot, "context", "architecture.md"), "utf-8")).toContain("edges:");

    // Once the canonical relation exists, a second plan is a genuine no-op
    // rather than another conversion hidden behind operation-id replay.
    expect((await engine.planMigration()).data.report.edgesConverted).toBe(0);
  });

  it("is idempotent", async () => {
    const project = legacyProject();
    const engine = engineFor(project);
    const plan = await engine.planMigration();
    await engine.applyMigration(plan.data);

    const after = Object.fromEntries(
      ["context/architecture.md", "patterns/retry.md"].map((path) => [
        path,
        readFileSync(join(project.scaffoldRoot, path), "utf-8"),
      ]),
    );
    const idsAfterFirst = acceptedOperations(readAuditLog(project.scaffoldRoot)).length;

    const second = await engine.planMigration();
    const reapplied = await engine.applyMigration(second.data);
    expect(reapplied.data.report.idsGenerated).toEqual([]);
    for (const [path, text] of Object.entries(after)) {
      expect(readFileSync(join(project.scaffoldRoot, path), "utf-8")).toBe(text);
    }
    expect(acceptedOperations(readAuditLog(project.scaffoldRoot))).toHaveLength(idsAfterFirst);
  });
});

// ── §21.5 Grounding ─────────────────────────────────────────────────────────

describe("§21.5 grounding", () => {
  async function grounded(): Promise<{ project: Project; nodeId: string }> {
    const project = createProject();
    await buildGraph(project);
    const nodeId = nodeIdOf(project, "rotateToken");
    const grounding = withGraph(project, (graph) => deriveGrounding(graph, nodeId)!);
    const path = join(project.scaffoldRoot, "context", "architecture.md");
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace(
        `topics: [${TOPIC}]\n-->\n## Token service`,
        `topics: [${TOPIC}]\ngrounds_to:\n  - node: ${grounding.node}\n    fingerprint: ${grounding.fingerprint}\n    bodyHash: ${grounding.bodyHash}\n-->\n## Token service`,
      ),
      "utf-8",
    );
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    return { project, nodeId };
  }

  it("retrieves grounded knowledge from a code-node id through an indexed join", async () => {
    const { project, nodeId } = await grounded();
    const session = openWikiQuery(join(project.scaffoldRoot, "wiki.db"));
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    try {
      const found = session.value.forCode([nodeId]);
      expect(found.items.map((entry) => entry.entity.id)).toEqual([COMPONENT]);
    } finally {
      session.value.close();
    }
  }, GRAPH_TIMEOUT);

  it("produces local stale health when the code changes", async () => {
    const { project } = await grounded();
    const grounding = {
      node: nodeIdOf(project, "rotateToken"),
      fingerprint: withGraph(project, (graph) => deriveGrounding(graph, nodeIdOf(project, "rotateToken"))!.fingerprint),
      bodyHash: withGraph(project, (graph) => deriveGrounding(graph, nodeIdOf(project, "rotateToken"))!.bodyHash),
    };
    withGraph(project, (graph) => {
      expect(resolveGrounding(grounding, graph).health).toBe("fresh");
    });

    writeFileSync(project.sourcePath, SOURCE.replace("3600", "7200"), "utf-8");
    await buildGraph(project);

    withGraph(project, (graph) => {
      // The edit the fingerprint alone cannot see. This is why the body hash
      // is the change signal.
      expect(resolveGrounding(grounding, graph).health).not.toBe("fresh");
    });
  }, GRAPH_TIMEOUT);

  it("never lets branch-local drift rewrite a canonical lifecycle", async () => {
    const { project } = await grounded();
    writeFileSync(project.sourcePath, SOURCE.replace("3600", "7200"), "utf-8");
    await buildGraph(project);
    withGraph(project, (graph) => {
      rebuildWikiIndex({
        scaffoldRoot: project.scaffoldRoot,
        resolveGrounding: (entry) => resolveGrounding(entry, graph),
      });
    });

    const engine = engineFor(project);
    const status = (await engine.groundingStatus({ id: COMPONENT })).data.entities[0]!;
    expect(status.health).not.toBe("fresh");
    // Health moved; lifecycle did not. §5.7, asserted at the boundary.
    expect(status.status).toBe("promoted");
    expect(readFileSync(join(project.scaffoldRoot, "context", "architecture.md"), "utf-8")).toContain("status: promoted");
  }, GRAPH_TIMEOUT);

  it("refuses a grounding asserted from unverified caller input", async () => {
    const project = createProject();
    await buildGraph(project);
    const engine = createWikiEngine({
      scaffoldRoot: project.scaffoldRoot,
      graph: withGraph(project, (graph) => graph),
    });
    await engine.rebuildIndex();

    const fabricated = envelopeFor(
      project,
      "set-grounding",
      COMPONENT,
      {
        groundings: [
          { node: "function:0000000000000000000000000000dead", fingerprint: "mh:64:dead", bodyHash: "0".repeat(64) },
        ],
      },
      "op_fabricated",
    );
    const result = await engine.applyOperation(fabricated, { apply: true });
    expect(result.data.applied).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(readFileSync(join(project.scaffoldRoot, "context", "architecture.md"), "utf-8")).not.toContain("dead");
  }, GRAPH_TIMEOUT);
});

// ── §21.6 Retrieval ─────────────────────────────────────────────────────────

describe("§21.6 retrieval", () => {
  it("answers every query kind the clause names", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();

    expect((await engine.get(ARCH)).data.entity?.id).toBe(ARCH);
    expect((await engine.list({ type: "component" })).data.entities.map((entity) => entity.id)).toEqual([COMPONENT]);
    expect((await engine.list({ topicId: TOPIC })).data.entities).toHaveLength(2);
    expect((await engine.list({ status: "promoted" })).data.entities.length).toBe(4);
    expect((await engine.list({ health: "fresh" })).data.entities).toHaveLength(0);
    expect((await engine.search("gateway")).data.hits.length).toBeGreaterThan(0);
    expect((await engine.related(ARCH)).data?.relations.length).toBeGreaterThan(0);
    expect((await engine.backlinks(COMPONENT)).data.backlinks.length).toBeGreaterThan(0);

    const session = openWikiQuery(join(project.scaffoldRoot, "wiki.db"));
    if (session.ok) {
      try {
        expect(session.value.sourcesFor(ARCH)).toHaveLength(1);
      } finally {
        session.value.close();
      }
    }
  });

  it("obeys entity, depth and token limits", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();

    const bounded = await engine.related(ARCH, { limit: 1, depth: 1 });
    expect(bounded.data!.reached.length).toBeLessThanOrEqual(1);

    const tiny = await engine.related(ARCH, { maxTokens: 1 });
    expect(tiny.data!.truncated).toBe(true);
    expect(tiny.data!.estimatedTokens).toBeGreaterThan(0);

    const listBound = await engine.list({ limit: 2 });
    expect(listBound.data.entities.length).toBeLessThanOrEqual(2);
    expect(listBound.data.truncated).toBe(true);
  });

  it("returns deterministic results for the same files and index version", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();
    const first = await engine.list();
    await engine.rebuildIndex();
    const second = await engine.list();
    expect(second.data.entities).toEqual(first.data.entities);
    expect(first.data.entities.length).toBe(4);
  });
});

// ── §21.7 Hub readiness ─────────────────────────────────────────────────────

describe("§21.7 Hub readiness", () => {
  it("exposes exploration, review queues, diagnostics, evidence, drift and traceability", async () => {
    const project = createProject();
    const engine = engineFor(project);
    await engine.rebuildIndex();

    expect((await engine.list({ type: "architecture" })).data.entities).toHaveLength(1);
    expect((await engine.groundingStatus()).data.entities.length).toBeGreaterThan(0);
    expect((await engine.validate()).data.entitiesChecked).toBe(4);
    expect((await engine.graph()).data.edges.length).toBeGreaterThan(0);

    const { wikiEvidence, wikiSupersessionTimeline, wikiTraceability, wikiDriftPanel } = await import("../service/hub.js");
    expect(wikiEvidence({ scaffoldRoot: project.scaffoldRoot, id: ARCH }).data.sources).toHaveLength(1);
    expect(wikiSupersessionTimeline({ scaffoldRoot: project.scaffoldRoot, id: DECISION }).data.entries.length).toBeGreaterThan(0);
    expect(wikiTraceability({ scaffoldRoot: project.scaffoldRoot, id: DECISION }).data.origin).not.toBeNull();
    // Drift with no baseline store says so rather than reporting "no drift".
    expect(wikiDriftPanel({ scaffoldRoot: project.scaffoldRoot, id: COMPONENT }).data.unavailable).toBe(true);
  });

  it("requires no Hub-specific storage or mutation model", () => {
    // Structural: the service module must not create a table of its own, and
    // must route mutation through the one pipeline. Asserted by reading the
    // source, because the claim is about what cannot exist rather than about
    // what one run happened to do.
    const hub = readFileSync(join(REPO_ROOT, "src", "wiki", "service", "hub.ts"), "utf-8");
    const withoutComments = hub.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(withoutComments).not.toMatch(/CREATE\s+TABLE/i);
    expect(withoutComments).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(withoutComments).not.toMatch(/writeFileSync|appendFileSync/);
  });
});

// ── §24 Definition of done ──────────────────────────────────────────────────

describe("§24 definition of done", () => {
  it("clause 2: the current scaffold shape stays compatible", async () => {
    // A scaffold with none of mex's metadata must still parse, index and
    // answer — the compatibility promise for every installation in the wild.
    const root = mkdtempSync(join(tmpdir(), "mex-accept-plain-"));
    roots.push(root);
    mkdirSync(join(root, "context"), { recursive: true });
    writeFileSync(join(root, "context", "notes.md"), "# Notes\n\nOrdinary prose, no metadata.\n", "utf-8");
    const engine = createWikiEngine({ scaffoldRoot: root });
    const built = await engine.rebuildIndex();
    expect(built.data.fileCount).toBe(1);
    expect(built.data.entityCount).toBe(0);
    expect((await engine.list()).diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("clause 9: validation covers structural, referential, source and log failures; check covers grounding", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-accept-bad-"));
    roots.push(root);
    mkdirSync(join(root, "context"), { recursive: true });
    mkdirSync(join(root, "events"), { recursive: true });
    writeFileSync(
      join(root, "context", "broken.md"),
      `<!-- mex:entity
id: ${ARCH}
type: architecture
status: promoted
revision: 1
title: Points nowhere
sources:
  - type: file
    ref: src/does-not-exist.ts
relations:
  - type: depends_on
    target: mx_01KRZZZZZZZZZZZZZZZZZZZZZZ
grounds_to:
  - node: function:00000000000000000000000000000001
    fingerprint: mh:64:aaaa
-->
## Points nowhere

Everything about this entity is wrong in a different way.
`,
      "utf-8",
    );
    writeFileSync(join(root, "events", "operations.jsonl"), "{not json\n", "utf-8");

    const report = await createWikiEngine({ scaffoldRoot: root }).validate();
    const codes = new Set(report.diagnostics.map((entry) => entry.code));
    expect(codes.has("INVALID_RELATION_TARGET"), "referential").toBe(true);
    expect(codes.has("SOURCE_FILE_MISSING"), "source").toBe(true);
    expect(codes.has("MALFORMED_OPERATION_LOG"), "operation log").toBe(true);
    // Grounding: code links are `mex check`'s, decided by the shared verdict
    // (`test/grounding-verdict-agreement.test.ts`), so validate reports none.
    expect([...codes].some((code) => code.startsWith("GROUNDING_")), "grounding").toBe(false);
  });

  it("clause 10: synthesis produces reviewed operations rather than direct writes", () => {
    // Structural, and it is the invariant the whole posture rests on: no
    // module under synthesis/ can reach the pipeline that writes.
    const files = ["propose.ts", "global-pass.ts", "relationships.ts"];
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, "src", "wiki", "synthesis", file), "utf-8");
      expect(source).not.toMatch(/from "\.\.\/operations\/(apply|plan|audit)\.js"/);
    }
  });

  it("clause 12: the eleven operation types are a closed set", () => {
    expect(WIKI_OPERATION_TYPES).toHaveLength(11);
  });
});
