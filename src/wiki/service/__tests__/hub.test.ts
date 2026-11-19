/**
 * §17 — one test per Hub surface, asserting the engine returns enough.
 *
 * §17 lists twelve surfaces and §21.7 turns them into an acceptance clause:
 * "the service exposes all data and operations required for entity
 * exploration, review queues, diagnostics, evidence, drift, and SDD
 * traceability", with "no Hub-specific storage model required". So each test
 * below names its surface and asserts the *fields a Hub would need to render
 * it* — not merely that a call returned.
 *
 * Ten of the twelve are projections of primitives built in earlier phases, and
 * they are exercised here through the same functions a Hub would call rather
 * than being re-implemented. The two with real composition behind them, the
 * supersession timeline and SDD traceability, get the most attention. The
 * traceability chain is walked against a **real code graph** for its last two
 * hops, because a stub would prove the walk and not the join.
 */

import { currentGraphPath } from "../../../graph/storage.js";
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraphEngine } from "../../../graph/engine-impl.js";
import { openGraphDatabase } from "../../../graph/db/database.js";
import { createSynthesisGraph } from "../../grounding/adapter.js";
import { WikiBaselineStore } from "../../grounding/baseline.js";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import { wikiGroundingStatus, wikiList, wikiSearch } from "../read.js";
import { wikiValidate } from "../validate.js";
import { wikiPlanOperation } from "../write.js";
import { wikiDriftPanel, wikiEvidence, wikiSupersessionTimeline, wikiTraceability } from "../hub.js";
import { isTestPath, SDD_CHAIN, ACCEPTANCE_CRITERION_RELATION } from "../../model/sdd.js";
import { locateEntity } from "../../operations/locate.js";
import { entityContentHash } from "../../model/hash.js";
import { entityTextOf } from "../../markdown/codec.js";

const SPEC = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const REQ = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const DECISION = "mx_01KRMEXM00JAAVJPQVVRX8N56V";
const COMPONENT = "mx_01KR2E4K002H3ZYA9G0C4XV531";
const CRITERION = "mx_01KRWG9F3TMHZ2PB6XKV7Q4YE8";
const OLD_DECISION = "mx_01KRQ7X5N8VBDJ3ZFY2M6TCH94";
const TOPIC = "mx_01KRZ8B4Q7WNVX5JGD3M2PTKS6";
const THIRD_DECISION = "mx_01KRV6C2H9XKPT4NBZ8QW3RJD5";

/** A scaffold carrying a whole SDD chain, plus a superseded decision. */
function scaffoldFiles(nodeName: string): Record<string, string> {
  return {
    "specs/tokens.md": `<!-- mex:entity
id: ${SPEC}
type: spec
status: promoted
revision: 1
title: Token rotation
topics: [${TOPIC}]
-->
## Token rotation

Refresh tokens must not live forever.

<!-- mex:entity
id: ${REQ}
type: requirement
status: promoted
revision: 1
title: Rotate within the hour
relations:
  - type: derived_from
    target: ${SPEC}
-->
### Rotate within the hour

A refresh token is rotated at most one hour after issue.

<!-- mex:entity
id: ${CRITERION}
type: acceptance_criterion
status: promoted
revision: 1
title: A token older than an hour is refused
relations:
  - type: verified_by
    target: ${REQ}
-->
### A token older than an hour is refused

Presenting an expired refresh token returns 401.
`,
    "context/decisions.md": `<!-- mex:entity
id: ${OLD_DECISION}
type: decision
status: deprecated
revision: 2
title: Rotate daily
-->
## Rotate daily

Superseded: a day was chosen for convenience, not for a threat model.

<!-- mex:entity
id: ${DECISION}
type: decision
status: promoted
revision: 1
title: Rotate hourly
relations:
  - type: implements
    target: ${REQ}
  - type: supersedes
    target: ${OLD_DECISION}
-->
## Rotate hourly

The window is one hour, enforced in the token service.
`,
    "context/architecture.md": `<!-- mex:entity
id: ${TOPIC}
type: topic
status: promoted
revision: 1
title: Authentication
-->
## Authentication

Everything about tokens.

<!-- mex:entity
id: ${COMPONENT}
type: component
status: promoted
revision: 1
title: Token service
topics: [${TOPIC}]
relations:
  - type: implements
    target: ${DECISION}
grounds_to: []
-->
## Token service

Issues and rotates tokens. Grounded to \`${nodeName}\`.
`,
  };
}

const SOURCE = `export function rotateRefreshToken(userId: string): number {
  const windowSeconds = 3600;
  const attempts = userId.length;
  return attempts * windowSeconds;
}
`;

const TEST_SOURCE = `import { rotateRefreshToken } from "../src/auth.js";

export function checkRotation(): boolean {
  return rotateRefreshToken("someone") > 0;
}
`;

/**
 * Tests that build a real code graph get an explicit timeout.
 *
 * A number beside the test that needs one says *which* tests are integration
 * tests; a flag on the invocation is invisible and loosens every other test in
 * the run. Tree-sitter extraction plus a compiler pass is seconds of real work,
 * and under full-suite parallel load it tips past vitest's 5s default — which
 * P6 and P9 both met and closed the same way.
 */
const GRAPH_TEST_TIMEOUT = 60_000;

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
}

/** A real repository: source, a test file that calls it, and a wiki scaffold. */
function createProject(): Project {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "auth.ts"), SOURCE, "utf-8");
  writeFileSync(join(root, "test", "auth.test.ts"), TEST_SOURCE, "utf-8");

  const scaffoldRoot = join(root, ".mex");
  for (const [path, text] of Object.entries(scaffoldFiles("rotateRefreshToken"))) {
    const absolute = join(scaffoldRoot, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text, "utf-8");
  }
  return { root, scaffoldRoot };
}

async function buildGraph(project: Project): Promise<void> {
  const engine = createGraphEngine({ rootDir: project.root });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
}

function withSynthesisGraph<T>(project: Project, body: (graph: ReturnType<typeof createSynthesisGraph>) => T): T {
  const dbPath = currentGraphPath(project.root);
  const engine = createGraphEngine({ rootDir: project.root });
  const db = openGraphDatabase(dbPath);
  try {
    return body(createSynthesisGraph(engine, db));
  } finally {
    engine.close();
    db.close();
  }
}

/**
 * The graph's id for the fixture function.
 *
 * Node ids are content hashes — `function:16525437…` — not names, so a lookup
 * has to go through `describeNode` rather than matching on the id text. A
 * substring match on the symbol name silently finds nothing and every
 * assertion downstream of it then measures an empty chain.
 */
function implementationNode(graph: ReturnType<typeof createSynthesisGraph>): string | undefined {
  return graph
    .nodesInFile("src/auth.ts")
    .find((node) => graph.describeNode(node.id)?.name === "rotateRefreshToken")?.id;
}

/** Write the component's grounding into its Markdown, as `set-grounding` would. */
function groundComponent(project: Project, nodeId: string, fingerprint: string, bodyHash: string): void {
  const path = join(project.scaffoldRoot, "context", "architecture.md");
  const text = readFileSync(path, "utf-8");
  // A `String.replace` whose pattern does not match returns the string
  // unchanged and says nothing. That happened here once: the fixture moved
  // `grounds_to` out from under a `mex:` key and this call kept targeting the
  // old shape, so every grounding assertion downstream measured an ungrounded
  // component and read as a bug in the traversal.
  if (!text.includes("grounds_to: []")) {
    throw new Error("the fixture no longer carries the `grounds_to: []` placeholder this helper fills in");
  }
  writeFileSync(
    path,
    text.replace(
      "grounds_to: []",
      `grounds_to:\n  - node: ${nodeId}\n    fingerprint: ${fingerprint}\n    bodyHash: ${bodyHash}`,
    ),
    "utf-8",
  );
}

describe("§17 surfaces that are projections of existing primitives", () => {
  function indexed(): string {
    const project = createProject();
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    return project.scaffoldRoot;
  }

  it("architecture and component explorer: list by type, with a location to open", () => {
    const scaffoldRoot = indexed();
    const components = wikiList({ scaffoldRoot, type: "component" });
    expect(components.data.entities).toHaveLength(1);
    const entity = components.data.entities[0]!;
    // Every graph node must lead somewhere: §17 requires "open the canonical
    // Markdown location", so the file and line have to come back with it.
    expect(entity.file).toBe("context/architecture.md");
    expect(entity.startLine).toBeGreaterThan(0);
    expect(entity.title).toBe("Token service");
  });

  it("conventions and patterns catalog: the same projection, a different filter", () => {
    const scaffoldRoot = indexed();
    expect(wikiList({ scaffoldRoot, type: "decision" }).data.entities).toHaveLength(2);
    expect(wikiList({ scaffoldRoot, type: "spec" }).data.entities).toHaveLength(1);
  });

  it("topic pages: members of a topic, by topic id", () => {
    const scaffoldRoot = indexed();
    const members = wikiList({ scaffoldRoot, topicId: TOPIC });
    expect(members.data.entities.map((entity) => entity.id).sort()).toEqual([SPEC, COMPONENT].sort());
  });

  it("in-flight proposal review: a status filter over the lifecycle", () => {
    const scaffoldRoot = indexed();
    const deprecated = wikiList({ scaffoldRoot, status: "deprecated" });
    expect(deprecated.data.entities.map((entity) => entity.id)).toEqual([OLD_DECISION]);
    // The filter has to be able to answer both ways, or a queue cannot be built.
    const promoted = wikiList({ scaffoldRoot, status: "promoted" });
    expect(promoted.data.entities.length).toBeGreaterThan(1);
    expect(promoted.data.entities.map((entity) => entity.id)).not.toContain(OLD_DECISION);
  });

  it("stale/missing grounding review queue: per-entity health, null when nothing looked", () => {
    const scaffoldRoot = indexed();
    const queue = wikiGroundingStatus({ scaffoldRoot });
    expect(queue.data.entities.length).toBeGreaterThan(0);
    // Null, not "unverified". A queue that showed "checked and fine" for an
    // unchecked entity is the failure this distinction exists to prevent.
    expect(queue.data.entities.every((entry) => entry.health === null)).toBe(true);
    expect(queue.data.unresolved).toBe(true);
  });

  it("contradictions and orphan diagnostics: a validation pass with codes and locations", () => {
    const scaffoldRoot = indexed();
    const report = wikiValidate({ scaffoldRoot });
    expect(report.data.entitiesChecked).toBe(7);
    for (const entry of report.diagnostics) {
      expect(entry.code).toBeTruthy();
      expect(entry.severity).toBeTruthy();
      // A diagnostics panel needs somewhere to send the reader.
      expect(entry.remediation ?? entry.message).toBeTruthy();
    }
  });

  it("exact operation diff and apply: a plan carries the diff before anything is written", () => {
    const scaffoldRoot = indexed();
    // `baseContentHash` is required on a mutating operation: an unconditional
    // write would overwrite an edit made between plan and apply and the audit
    // log would record a success. A real reviewer's tool locates the entity to
    // get it, so the test does too.
    const located = locateEntity(DECISION, { scaffoldRoot });
    expect(located, "the decision must be locatable").not.toBeNull();
    const planned = wikiPlanOperation(
      {
        opId: "op_hub_1",
        type: "set-property",
        actor: { kind: "human", id: "reviewer" },
        timestamp: "2026-08-25T00:00:00.000Z",
        entityId: DECISION,
        baseRevision: 1,
        baseContentHash: entityContentHash(entityTextOf(located!.text, located!.entity.location!)),
        payload: { property: "status", value: "deprecated" },
      },
      { scaffoldRoot },
    );
    expect(planned.data.planned).toBe(true);
    expect(planned.data.diff).toContain("deprecated");
    expect(planned.data.files).toEqual(["context/decisions.md"]);
    // The preview hash is what pins "the diff you approved is the diff applied".
    expect(planned.data.preview?.previewHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lexical search across the catalog", () => {
    const scaffoldRoot = indexed();
    const hits = wikiSearch({ scaffoldRoot, text: "rotation" });
    expect(hits.data.hits.length).toBeGreaterThan(0);
    expect(hits.data.hits[0]!.field).toBeTruthy();
  });
});

describe("§17 supersession timeline", () => {
  it("orders a chain oldest first and marks the current entry", () => {
    const project = createProject();
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });

    const timeline = wikiSupersessionTimeline({ scaffoldRoot: project.scaffoldRoot, id: DECISION });
    expect(timeline.data.cycles).toEqual([]);
    expect(timeline.data.entries.map((entry) => entry.entity.id)).toEqual([OLD_DECISION, DECISION]);
    expect(timeline.data.entries.map((entry) => entry.ordinal)).toEqual([0, 1]);
    expect(timeline.data.entries.map((entry) => entry.current)).toEqual([false, true]);
    expect(timeline.data.entries[1]!.supersedes).toBe(OLD_DECISION);
  });

  it("answers the same from either end of the chain", () => {
    // A reader can open the superseded decision as easily as the current one,
    // and must not be shown half a history for having done so.
    const project = createProject();
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    const fromOld = wikiSupersessionTimeline({ scaffoldRoot: project.scaffoldRoot, id: OLD_DECISION });
    const fromNew = wikiSupersessionTimeline({ scaffoldRoot: project.scaffoldRoot, id: DECISION });
    expect(fromOld.data.entries.map((entry) => entry.entity.id)).toEqual(
      fromNew.data.entries.map((entry) => entry.entity.id),
    );
  });

  it("reports a cycle instead of hanging on it", () => {
    const project = createProject();
    // Close the loop: the old decision now supersedes the new one too.
    const path = join(project.scaffoldRoot, "context", "decisions.md");
    const text = readFileSync(path, "utf-8");
    writeFileSync(
      path,
      text.replace(
        `title: Rotate daily\n-->`,
        `title: Rotate daily\nrelations:\n  - type: supersedes\n    target: ${DECISION}\n-->`,
      ),
      "utf-8",
    );
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });

    const timeline = wikiSupersessionTimeline({ scaffoldRoot: project.scaffoldRoot, id: DECISION });
    expect(timeline.data.cycles.length).toBeGreaterThan(0);
    expect(timeline.data.cycles[0]).toContain(DECISION);
    // No ordering is produced, because none is true — but the call returns.
    expect(timeline.data.entries).toEqual([]);
  });

  it("terminates on a cycle with an entrant, and still reports it", () => {
    // Written to provoke a `cycles.length === 0` guard the first draft had —
    // and it could not, which is why that guard is gone. In *any* cycle every
    // member's supersession target is inside the chain, so no head exists and
    // the ordering is empty for that reason rather than for the guard's.
    // A third decision superseding *into* the loop was the shape most likely
    // to look like a legitimate head; it is not one either, because its own
    // target is in the chain too.
    //
    // The test earns its place on the other two properties: the walk
    // terminates rather than looping forever, and the cycle is still reported
    // from an entity that is not itself part of it.
    const project = createProject();
    const path = join(project.scaffoldRoot, "context", "decisions.md");
    const text = readFileSync(path, "utf-8");
    writeFileSync(
      path,
      `${text.replace(
        `title: Rotate daily\n-->`,
        `title: Rotate daily\nrelations:\n  - type: supersedes\n    target: ${DECISION}\n-->`,
      )}
<!-- mex:entity
id: ${THIRD_DECISION}
type: decision
status: promoted
revision: 1
title: Rotate on demand
relations:
  - type: supersedes
    target: ${OLD_DECISION}
-->
## Rotate on demand

Rotation happens when the client asks, which supersedes the daily job.
`,
      "utf-8",
    );
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });

    const timeline = wikiSupersessionTimeline({ scaffoldRoot: project.scaffoldRoot, id: THIRD_DECISION });
    expect(timeline.data.cycles.length).toBeGreaterThan(0);
    expect(timeline.data.entries).toEqual([]);
  });
});

describe("§17 evidence panel", () => {
  it("returns the entity with its sources and groundings", () => {
    const project = createProject();
    const path = join(project.scaffoldRoot, "specs", "tokens.md");
    const text = readFileSync(path, "utf-8");
    writeFileSync(
      path,
      text.replace(
        `title: Token rotation`,
        `title: Token rotation\nsources:\n  - type: url\n    ref: https://example.invalid/rfc\n    note: The rotation RFC`,
      ),
      "utf-8",
    );
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });

    const evidence = wikiEvidence({ scaffoldRoot: project.scaffoldRoot, id: SPEC });
    expect(evidence.data.entity?.id).toBe(SPEC);
    expect(evidence.data.sources).toHaveLength(1);
    expect(evidence.data.sources[0]).toMatchObject({ type: "url", ref: "https://example.invalid/rfc" });
    expect(evidence.data.health).toBeNull();
  });

  it("reports a missing entity rather than an empty panel", () => {
    const project = createProject();
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    const evidence = wikiEvidence({ scaffoldRoot: project.scaffoldRoot, id: "mx_01KRZZZZZZZZZZZZZZZZZZZZZZ" });
    expect(evidence.data.entity).toBeNull();
    expect(evidence.diagnostics.map((entry) => entry.code)).toContain("ENTITY_NOT_FOUND");
  });
});

describe("§17 old-versus-new drift panel", () => {
  it("says it could not look, rather than reporting no drift, with no baseline store", () => {
    const project = createProject();
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    const drift = wikiDriftPanel({ scaffoldRoot: project.scaffoldRoot, id: COMPONENT });
    expect(drift.data.unavailable).toBe(true);
    expect(drift.data.panes).toEqual([]);
  });

  it("returns both sides of the diff from a real baseline", async () => {
    const project = createProject();
    await buildGraph(project);

    const dbPath = currentGraphPath(project.root);
    const db = openGraphDatabase(dbPath);
    try {
      const baselines = new WikiBaselineStore(db);
      baselines.capture(COMPONENT, { node: "function:rotateRefreshToken", fingerprint: "mh:64:abcd" }, SOURCE, "hash-at-grounding");
      rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });

      const drift = wikiDriftPanel({
        scaffoldRoot: project.scaffoldRoot,
        id: COMPONENT,
        baselines,
        currentSource: () => `${SOURCE}\n// changed since grounding\n`,
      });
      expect(drift.data.unavailable).toBe(false);
      expect(drift.data.panes).toHaveLength(1);
      const pane = drift.data.panes[0]!;
      expect(pane.oldSource).toBe(SOURCE);
      expect(pane.newSource).toContain("changed since grounding");
      expect(pane.drifted).toBe(true);
    } finally {
      db.close();
    }
  }, GRAPH_TEST_TIMEOUT);

  it("does not call an unchanged node drifted", async () => {
    const project = createProject();
    await buildGraph(project);
    const db = openGraphDatabase(currentGraphPath(project.root));
    try {
      const baselines = new WikiBaselineStore(db);
      baselines.capture(COMPONENT, { node: "function:rotateRefreshToken", fingerprint: "mh:64:abcd" }, SOURCE, "hash");
      rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
      const drift = wikiDriftPanel({
        scaffoldRoot: project.scaffoldRoot,
        id: COMPONENT,
        baselines,
        currentSource: () => SOURCE,
      });
      // The polarity assertion. A panel that called everything drifted would
      // pass the previous test.
      expect(drift.data.panes[0]!.drifted).toBe(false);
    } finally {
      db.close();
    }
  }, GRAPH_TEST_TIMEOUT);
});

describe("§17 SDD traceability", () => {
  it("pins each hop to one relation type, in one place", () => {
    // The mapping is a decision the spec does not make, so it is data rather
    // than something each traversal spells out. This asserts the table itself,
    // because everything below reads from it.
    expect(SDD_CHAIN).toEqual([
      { from: "requirement", to: "spec", relation: "derived_from" },
      { from: "decision", to: "requirement", relation: "implements" },
      { from: "component", to: "decision", relation: "implements" },
    ]);
    expect(ACCEPTANCE_CRITERION_RELATION).toBe("verified_by");
  });

  it("recognises the test-path conventions, and only those", () => {
    for (const path of [
      "test/auth.test.ts",
      "src/auth.spec.ts",
      "src/__tests__/auth.ts",
      "tests/e2e/login.ts",
      "packages/api/src/__tests__/handler.ts",
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
    for (const path of ["src/auth.ts", "src/latest.ts", "contest/entry.ts", "src/protest.ts"]) {
      expect(isTestPath(path), path).toBe(false);
    }
    // Windows spelling must answer the same as POSIX.
    expect(isTestPath("test\\auth.test.ts")).toBe(true);
  });

  it("walks all six hops from the spec end, against a real graph", async () => {
    const project = createProject();
    await buildGraph(project);

    const nodeId = withSynthesisGraph(project, (graph) => {
      const found = implementationNode(graph);
      expect(found, "the fixture function must be in the graph").toBeDefined();
      return found!;
    });
    groundComponent(project, nodeId, "mh:64:abcd", "hash");
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });

    withSynthesisGraph(project, (graph) => {
      const chain = wikiTraceability({ scaffoldRoot: project.scaffoldRoot, id: SPEC, graph });

      // Hops 1-3, entity to entity.
      expect(chain.data.origin?.id).toBe(SPEC);
      expect(chain.data.nodes["requirement"]?.map((node) => node.entity.id)).toEqual([REQ]);
      expect(chain.data.nodes["decision"]?.map((node) => node.entity.id)).toEqual([DECISION]);
      expect(chain.data.nodes["component"]?.map((node) => node.entity.id)).toEqual([COMPONENT]);

      // Hop 4, component to implementation, through grounding.
      expect(chain.data.implementations.map((entry) => entry.nodeId)).toEqual([nodeId]);

      // Hop 5, implementation to test, through the code graph's calls edges.
      expect(chain.data.tests.length).toBeGreaterThan(0);
      expect(chain.data.tests[0]!.testFile).toContain("auth.test.ts");

      // The decoration.
      expect(chain.data.acceptanceCriteria.map((entry) => entry.criterionId)).toEqual([CRITERION]);
    });
  }, GRAPH_TEST_TIMEOUT);

  it("answers the same chain walked from the component end", async () => {
    const project = createProject();
    await buildGraph(project);
    const nodeId = withSynthesisGraph(project, (graph) => implementationNode(graph)!);
    groundComponent(project, nodeId, "mh:64:abcd", "hash");
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });

    withSynthesisGraph(project, (graph) => {
      const forward = wikiTraceability({ scaffoldRoot: project.scaffoldRoot, id: SPEC, graph });
      const reverse = wikiTraceability({ scaffoldRoot: project.scaffoldRoot, id: COMPONENT, graph });
      // "What implements FR-001?" and "why does this component exist?" are the
      // same edges walked in opposite directions.
      const ids = (data: typeof forward.data): string[] =>
        Object.values(data.nodes).flat().map((node) => node.entity.id).sort();
      expect(ids(reverse.data)).toEqual(ids(forward.data));
      expect(reverse.data.implementations).toEqual(forward.data.implementations);
    });
  }, GRAPH_TEST_TIMEOUT);

  it("reports a break at the hop that is missing, rather than throwing or filtering", () => {
    const project = createProject();
    // Cut the decision → requirement hop, leaving everything else intact.
    const path = join(project.scaffoldRoot, "context", "decisions.md");
    const text = readFileSync(path, "utf-8");
    writeFileSync(path, text.replace(`  - type: implements\n    target: ${REQ}\n`, ""), "utf-8");
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });

    const chain = wikiTraceability({ scaffoldRoot: project.scaffoldRoot, id: DECISION });
    const gap = chain.data.gaps.find((entry) => entry.hop === "decision → requirement");
    expect(gap, "the missing hop must be named").toBeDefined();
    expect(gap!.entityId).toBe(DECISION);
    expect(gap!.reason).toContain("implements");
    // The rest of the chain is still returned: a break is a finding, not a
    // reason to show nothing.
    expect(chain.data.nodes["decision"]?.map((node) => node.entity.id)).toEqual([DECISION]);
  });

  it("reports an ungrounded component as a gap at the implementation hop", () => {
    const project = createProject();
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    const chain = wikiTraceability({ scaffoldRoot: project.scaffoldRoot, id: COMPONENT });
    const gap = chain.data.gaps.find((entry) => entry.hop === "component → implementation");
    expect(gap).toBeDefined();
    expect(chain.data.implementations).toEqual([]);
  });

  it("walks the wiki hops with no code graph at all", () => {
    // §23.8: basic wiki reads must not require the graph. Four of the six hops
    // are pure wiki, and they must still answer in a checkout with no graph.
    const project = createProject();
    rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot });
    const chain = wikiTraceability({ scaffoldRoot: project.scaffoldRoot, id: SPEC });
    expect(chain.data.nodes["requirement"]?.map((node) => node.entity.id)).toEqual([REQ]);
    expect(chain.data.nodes["component"]?.map((node) => node.entity.id)).toEqual([COMPONENT]);
    expect(chain.data.tests).toEqual([]);
  });
});
