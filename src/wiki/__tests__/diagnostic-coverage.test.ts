/**
 * Diagnostic code coverage, for the whole engine.
 *
 * Lives here rather than beside one layer's tests because the emitters now come
 * from three layers — the model (P0/P1), the Markdown codec (P2b), and the
 * index and query layers (P3). §3c finding 27 accepted keeping this in
 * `model/__tests__/diagnostic.test.ts` while there were two, and named the
 * condition that would flip the decision: emitters from a third layer. This is
 * that third layer, so it moved.
 *
 * The property is unchanged, and is the reason the file exists: the emitted set
 * and the deferred set are **disjoint and together cover the registry exactly**.
 * A code cannot be parked as "not yet emitted" once its check lands, a newly
 * added code cannot be forgotten, and a code cannot be quietly dropped. The
 * deferred list may only shrink.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateScaffold } from "../migration/migrate.js";
import { inventoryScaffold } from "../migration/inventory.js";
import { planGeneratedView, GENERATED_BEGIN, GENERATED_END } from "../migration/generated.js";
import { validateScaffold } from "../validation/validate.js";
import { wikiSynthesisPropose } from "../service/synthesis.js";
import {
  WIKI_DIAGNOSTIC_CODES,
  isWikiDiagnosticCode,
  type WikiDiagnostic,
  type WikiDiagnosticCode,
} from "../model/diagnostic.js";
import {
  createEntityValidator,
  detectRevisionDivergence,
  validateEntity,
  validateEntitySetIdentity,
  type WikiLifecycleState,
} from "../model/entity.js";
import { validateRelationGraph, type RelationSubject, type WikiRelationRef, type WikiRelationType } from "../model/relation.js";
import {
  buildTopicIndex,
  resolveTopicOrDiagnose,
  validateTopicHierarchy,
  validateTopicMembership,
  PARENT_TOPIC_RELATION,
  type TopicSubject,
} from "../model/topic.js";
import { findDuplicateSources, reportUnresolvedSources, validateSource } from "../model/source.js";
import { validateGrounding, verifyGroundingProvenance } from "../model/grounding.js";
import { checkOperationPreconditions, validateOperation, type WikiOperationType } from "../model/operation.js";
import { entityContentHash } from "../model/hash.js";
import { rootContext } from "../model/validate.js";
import { generateEntityId, type EntityId } from "../model/ids.js";
import { entity, grounding, location, ids } from "../model/__tests__/helpers.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import type { ParsedEntity } from "../markdown/contract.js";
import { detectRangeOverlaps } from "../index/write.js";
import { openWikiIndex } from "../index/open.js";
import { fts5UnavailableDiagnostic } from "../index/fts5.js";
import { assertFts5Available, openSqlite } from "../../graph/db/sqlite.js";
import { rebuildWikiIndex } from "../index/rebuild.js";
import { getEntity } from "../query/get.js";
import { escapedSymlinkDiagnostic } from "../index/discover.js";
import { planOperation } from "../operations/plan.js";
import { applyOperation } from "../operations/apply.js";
import { readAuditLog } from "../operations/audit.js";
import type { GroundingResolver } from "../index/write.js";

/** Run `body` against a fresh scratch directory, cleaning up afterwards. */
function inScratch<T>(body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "mex-wiki-coverage-"));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Codes declared in the registry but not yet emitted by any check.
 *
 * They belong to phases that are not built: the Markdown codec, the SQLite
 * index, the grounding adapter, the operations pipeline and migration. They are
 * declared now because the code vocabulary is a published contract and a
 * consumer should be able to match on a code before the check that emits it
 * ships.
 *
 * **This list may only shrink.** The test below asserts it and the emitted set
 * are disjoint and together cover the registry, so a code cannot be quietly
 * parked here after its phase lands, and a newly added code cannot be forgotten.
 */
/**
 * Empty, and it may only ever be empty or shrinking.
 *
 * Forty-nine codes were declared in P1 with seventeen deferred; P9's validation
 * pass emits the last two. A code added later belongs here only with the phase
 * that will emit it named, and the disjoint-and-covering assertion below is
 * what stops one being parked here after its check has landed.
 */
const NOT_YET_EMITTED: Record<string, string> = {};

function codesOf(diagnostics: readonly WikiDiagnostic[]): WikiDiagnosticCode[] {
  return diagnostics.map((entry) => entry.code);
}

function relate(type: WikiRelationType, target: EntityId): WikiRelationRef {
  return { type, target };
}

function subject(id: EntityId, relations: WikiRelationRef[] = [], overrides: Partial<RelationSubject> = {}): RelationSubject {
  return { id, type: "decision", status: "promoted", relations, ...overrides };
}

function topic(id: EntityId, title: string, parents: EntityId[] = []): TopicSubject {
  return { id, type: "topic", title, relations: parents.map((target) => ({ type: PARENT_TOPIC_RELATION, target })) };
}

/**
 * Every code this phase's checks can produce, each paired with an input that
 * actually produces it.
 *
 * Written as data rather than as one test per code so the coverage assertion
 * below is exhaustive by construction: a new code with no way to trigger it
 * fails the disjoint-and-covering test rather than passing unnoticed.
 */
/**
 * Parse a small inline document and return its diagnostics.
 *
 * The codec's codes are emitted here rather than in a separate coverage file so
 * that "disjoint and covering" stays a single provable fact in one place. The
 * alternative — hoisting both maps into a shared module so a third file can
 * assert over them — moves 130 lines of test data to buy layering purity that
 * the lint rule does not ask for, since it exempts `__tests__` by design.
 */
function codecDiagnostics(text: string): readonly WikiDiagnostic[] {
  return parseWikiMarkdown({ path: "inline.md", text }).diagnostics;
}

const CODEC_ID = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const OPS_ID = "mx_01D78XYFJ1PRM1WPBCBT3VHMNV";
const OPS_OTHER = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";

/** One entity out of a file on disk, for building a live precondition. */
function entityOf(absolutePath: string, id: string) {
  const text = readFileSync(absolutePath, "utf-8");
  const found = parseWikiMarkdown({ path: "context/notes.md", text }).entities.find((entry) => entry.entity.id === id);
  if (found === undefined) throw new Error(`no entity ${id}`);
  return found.entity;
}

/**
 * A scaffold on disk, for the two codes that can only be reached by validating one.
 *
 * Both of P9's codes are properties of a *file*: one is about a path that is
 * not in the checkout, the other about an anchor inside an entity's body. A
 * synthetic diagnostic would prove the registry has the code, not that anything
 * emits it, which is finding 44's shape.
 */
function validationDiagnostics(files: Record<string, string>): readonly WikiDiagnostic[] {
  const root = mkdtempSync(join(tmpdir(), "mex-coverage-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, text, "utf-8");
    }
    return validateScaffold({ scaffoldRoot: root, projectRoot: root }).diagnostics;
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows keeps handles on just-closed files.
    }
  }
}

const COVERAGE_ENTITY = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";

const EMITTERS: Record<string, () => readonly WikiDiagnostic[]> = {
  INVALID_ENTITY_ID: () => validateEntity(entity({ id: "not-an-id" as unknown as EntityId }), rootContext()).diagnostics,
  DUPLICATE_ENTITY_ID: () => {
    const id = generateEntityId();
    return validateEntitySetIdentity([
      { id, location: location({ file: "a.md" }) },
      { id, location: location({ file: "b.md" }) },
    ]);
  },
  INVALID_ENTITY_TYPE: () => validateEntity(entity({ type: "runbook" }), rootContext()).diagnostics,
  INVALID_LIFECYCLE_STATE: () =>
    validateEntity(entity({ status: "stale" as unknown as WikiLifecycleState }), rootContext()).diagnostics,
  INVALID_REVISION: () => validateEntity(entity({ revision: 0 }), rootContext()).diagnostics,
  MISSING_ENTITY_TITLE: () => validateEntity(entity({ title: "" }), rootContext()).diagnostics,
  MISSING_REQUIRED_FIELD: () =>
    createEntityValidator({ requireLocation: true })(
      entity({ location: location({ file: "" }) }),
      rootContext(),
    ).diagnostics,
  INVALID_FIELD_TYPE: () => validateEntity(entity({ metadata: "not an object" as never }), rootContext()).diagnostics,
  REVISION_DIVERGED: () => detectRevisionDivergence(entity(), entityContentHash("edited by hand")),

  INVALID_RELATION_TYPE: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [{ type: "sort_of" as WikiRelationType, target: b }]), subject(b)]);
  },
  INVALID_RELATION_TARGET: () => {
    const [a, missing] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("depends_on", missing)])]);
  },
  DUPLICATE_RELATION: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("affects", b), relate("affects", b)]), subject(b)]);
  },
  SELF_RELATION: () => {
    const [a] = ids(1) as [EntityId];
    return validateRelationGraph([subject(a, [relate("related_to", a)])]);
  },
  SUPERSESSION_CYCLE: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("supersedes", b)]), subject(b, [relate("supersedes", a)])]);
  },
  CONTRADICTORY_ACTIVE_DECISIONS: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("contradicts", b)]), subject(b)]);
  },
  INACTIVE_RELATION_TARGET: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("depends_on", b)]), subject(b, [], { status: "archived" })]);
  },
  ORPHANED_ENTITY: () => {
    const [a] = ids(1) as [EntityId];
    return validateRelationGraph([subject(a)], { reportOrphans: true });
  },

  UNKNOWN_TOPIC: () => resolveTopicOrDiagnose(buildTopicIndex([]), "authentication", "topics[0]").diagnostics,
  AMBIGUOUS_TOPIC_REFERENCE: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const index = buildTopicIndex([topic(a, "Auth"), topic(b, "Auth")]);
    return resolveTopicOrDiagnose(index, "auth", "topics[0]").diagnostics;
  },
  INVALID_TOPIC_MEMBER: () => {
    const [member, decision] = ids(2) as [EntityId, EntityId];
    return validateTopicMembership([{ id: member, topics: [decision] }], new Map([[decision, { type: "decision" }]]));
  },
  TOPIC_CYCLE: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateTopicHierarchy(buildTopicIndex([topic(a, "A", [b]), topic(b, "B", [a])]));
  },

  MALFORMED_SOURCE: () => validateSource({ type: "manual" }, rootContext()).diagnostics,
  INVALID_COMMIT_FORMAT: () => validateSource({ type: "commit", ref: "yesterday" }, rootContext()).diagnostics,
  DUPLICATE_SOURCE: () =>
    findDuplicateSources([
      { type: "file", ref: "src/a.ts" },
      { type: "file", ref: "src/a.ts" },
    ]),
  UNRESOLVED_EXTERNAL_SOURCE: () => reportUnresolvedSources([{ type: "url", ref: "https://example.com" }]),

  MALFORMED_GROUNDING: () => validateGrounding({ node: "rotateToken", fingerprint: "x" }, rootContext()).diagnostics,
  GROUNDING_UNVERIFIED: () => verifyGroundingProvenance([grounding()], () => false),
  GROUNDING_MIXED_SHAPE: () =>
    // #226: a root `grounds_to` beside the file-level `mex` map.
    parseWikiMarkdown({
      path: "patterns/rotate.md",
      text: [
        "---",
        "name: rotate",
        "grounds_to:",
        `  - node: "${grounding().node}"`,
        `    fingerprint: "${grounding().fingerprint}"`,
        "mex:",
        `  id: ${ids(1)[0]}`,
        "  type: pattern",
        "  status: promoted",
        "---",
        "",
        "# Rotate",
        "",
      ].join("\n"),
    }).diagnostics,

  INVALID_OPERATION_ENVELOPE: () =>
    validateOperation(
      { opId: "op_1", type: "archive-entry", actor: { kind: "agent", id: "x" }, timestamp: "this morning", payload: {} },
      rootContext(),
    ).diagnostics,
  UNKNOWN_OPERATION_TYPE: () =>
    validateOperation({ opId: "op_1", type: "delete-entry" as WikiOperationType, actor: { kind: "agent", id: "x" }, timestamp: "2026-08-23T10:00:00Z", payload: {} }, rootContext())
      .diagnostics,
  INVALID_OPERATION_PAYLOAD: () =>
    validateOperation(
      {
        opId: "op_1",
        type: "set-property",
        entityId: generateEntityId(),
        actor: { kind: "agent", id: "x" },
        timestamp: "2026-08-23T10:00:00Z",
        payload: { property: "id", value: "forged" },
      },
      rootContext(),
    ).diagnostics,
  REVISION_CONFLICT: () =>
    checkOperationPreconditions({ baseRevision: 1 }, { revision: 4, entityContentHash: entityContentHash("x") }),
  CONTENT_HASH_CONFLICT: () =>
    checkOperationPreconditions(
      { baseContentHash: entityContentHash("old") },
      { revision: 1, entityContentHash: entityContentHash("new") },
    ),

  // -- P2b, the Markdown codec ----------------------------------------------

  WIKI_PARSE_ERROR: () =>
    codecDiagnostics(`<!-- mex:entity
id: "unterminated
type: decision
-->
## Heading
`),

  UNBOUND_ENTITY_METADATA: () =>
    codecDiagnostics(`<!-- mex:entity
id: ${CODEC_ID}
type: decision
status: promoted
-->

Prose, and no heading after it.
`),

  DUPLICATE_ENTITY_METADATA: () =>
    codecDiagnostics(
      `<!-- mex:entity
id: ${CODEC_ID}
type: decision
status: promoted
-->
` +
        `<!-- mex:entity
id: mx_01BX5ZZKBKACTAV9WEVGEMMVRZ
type: decision
status: promoted
-->
` +
        `## One heading, two claimants
`,
    ),

  // -- P3, the disposable index and the query layer --------------------------

  WIKI_INDEX_MISSING: () =>
    inScratch((directory) => {
      const opened = openWikiIndex(join(directory, "wiki.db"));
      return opened.ok ? [] : [opened.diagnostic];
    }),

  WIKI_INDEX_FTS5_UNAVAILABLE: () => {
    // No FTS5-less Node exists to reproduce this on, so the probe's SQLite
    // opener is injected. Everything downstream of it — the actionable message
    // and the mapping onto this code rather than WIKI_INDEX_REBUILD_REQUIRED —
    // is the real production path.
    const withoutFts5: typeof openSqlite = () => ({
      prepare: () => {
        throw new Error("not reached");
      },
      exec: () => {
        throw new Error("no such module: fts5");
      },
      pragma: () => {},
      transaction: (fn) => fn(),
      close: () => {},
      open: true,
    });
    const emitted = fts5UnavailableDiagnostic("wiki.db", () => assertFts5Available(withoutFts5));
    return emitted ? [emitted] : [];
  },

  WIKI_INDEX_REBUILD_REQUIRED: () =>
    inScratch((directory) => {
      const path = join(directory, "wiki.db");
      // A file that is not a database at all. Same remedy as a version
      // mismatch, and the same typed diagnostic rather than a throw from deep
      // inside an open.
      writeFileSync(path, "this is not a database", "utf-8");
      const opened = openWikiIndex(path);
      return opened.ok ? [] : [opened.diagnostic];
    }),

  ENTITY_RANGE_OVERLAP: () => {
    // Built by hand, because the codec's partition property means it cannot
    // produce an overlap — which is exactly why the index checks for one
    // anyway, before P5 computes a patch plan from two locations claiming the
    // same bytes and writes one over the other.
    const [first, second] = ids(2) as [EntityId, EntityId];
    const overlapping: ParsedEntity[] = [
      {
        entity: entity({ id: first, location: location({ file: "a.md", metadataStart: 0, bodyEnd: 100 }) }),
        metadataKind: "comment",
      },
      {
        entity: entity({ id: second, location: location({ file: "a.md", metadataStart: 50, bodyEnd: 150 }) }),
        metadataKind: "comment",
      },
    ];
    return detectRangeOverlaps("a.md", overlapping);
  },

  ENTITY_NOT_FOUND: () =>
    inScratch((directory) => {
      const scaffoldRoot = join(directory, "scaffold");
      mkdirSync(scaffoldRoot, { recursive: true });
      writeFileSync(join(scaffoldRoot, "notes.md"), "# Prose, and no entity\n", "utf-8");
      // Repository-bound maintenance only mutates the scaffold's exact index
      // directory; a fixture outside it would test an authority the production
      // engine deliberately does not grant.
      const built = rebuildWikiIndex({ scaffoldRoot, indexPath: join(scaffoldRoot, "wiki.db") });
      const result = getEntity(built.indexPath, generateEntityId());
      return result.ok ? [] : [result.diagnostic];
    }),

  // Called directly rather than through a real symlink: Windows refuses those
  // without developer mode, and an emitter that fires only on some machines
  // makes a coverage assertion depend on the environment. The walk that calls
  // it is exercised in discover.test.ts.
  WRITE_SCOPE_VIOLATION: () =>
    // A body carrying its own metadata block: every byte inside the declared
    // range, and an entity the operation never named. The scope check cannot
    // see it; the plan's re-parse can.
    inScratch((directory) => {
      const file = join(directory, "context", "notes.md");
      mkdirSync(join(directory, "context"), { recursive: true });
      writeFileSync(
        file,
        [`<!-- mex:entity`, `id: ${OPS_ID}`, "type: decision", "status: promoted", "revision: 1", "-->", "## A decision", "", "Body."].join(String.fromCharCode(10)),
        "utf-8",
      );
      const planned = planOperation(
        {
          opId: "coverage-scope",
          type: "update-entry",
          entityId: OPS_ID,
          baseContentHash: entityOf(file, OPS_ID).location.entityContentHash,
          actor: { kind: "agent", id: "coverage" },
          timestamp: "2026-08-24T10:00:00.000Z",
          payload: {
            body: ["Body.", "", "<!-- mex:entity", `id: ${OPS_OTHER}`, "type: decision", "status: promoted", "revision: 1", "-->", "## Smuggled", "", "In."].join(String.fromCharCode(10)),
          },
        },
        { scaffoldRoot: directory },
      );
      return planned.ok ? [] : planned.diagnostics;
    }),

  INDEX_REFRESH_REQUIRED: () =>
    // Applying with no `wiki.db` at all — the normal case in production, since
    // nothing there builds one. The write stands and the cache is reported.
    inScratch((directory) => {
      const file = join(directory, "context", "notes.md");
      mkdirSync(join(directory, "context"), { recursive: true });
      writeFileSync(
        file,
        [`<!-- mex:entity`, `id: ${OPS_ID}`, "type: decision", "status: promoted", "revision: 1", "-->", "## A decision", "", "Body."].join(String.fromCharCode(10)),
        "utf-8",
      );
      return applyOperation(
        {
          opId: "coverage-refresh",
          type: "set-property",
          entityId: OPS_ID,
          baseContentHash: entityOf(file, OPS_ID).location.entityContentHash,
          actor: { kind: "agent", id: "coverage" },
          timestamp: "2026-08-24T10:00:00.000Z",
          payload: { property: "status", value: "deprecated" },
        },
        { scaffoldRoot: directory },
      ).diagnostics;
    }),

  MALFORMED_OPERATION_LOG: () =>
    inScratch((directory) => {
      mkdirSync(join(directory, "events"), { recursive: true });
      writeFileSync(join(directory, "events", "operations.jsonl"), `{"v":1,"phase":"comp${String.fromCharCode(10)}`, "utf-8");
      return readAuditLog(directory).diagnostics;
    }),

  PATH_OUTSIDE_SCAFFOLD: () => [escapedSymlinkDiagnostic("linked.md", "/elsewhere/outside.md")],

  // The three grounding verdicts, each produced by building a real index over
  // a real grounded entity and resolving it. The resolver is a stub because
  // what is being covered is the *reporting*, not the verdict — the verdicts
  // have their own tests, against a stub graph and against a real one.
  GROUNDING_STALE: () =>
    groundingDiagnostics((grounding) => ({
      state: "stale",
      health: "changed",
      node: grounding.node,
      resolvedNode: grounding.node,
      currentBodyHash: "live",
    })),

  GROUNDING_MISSING: () =>
    groundingDiagnostics((grounding) => ({
      state: "missing",
      health: "missing",
      node: grounding.node,
      reason: "the declaration is gone",
    })),

  SOURCE_FILE_MISSING: () =>
    validationDiagnostics({
      "context/x.md": `<!-- mex:entity
id: ${COVERAGE_ENTITY}
type: decision
status: promoted
revision: 1
sources:
  - type: file
    ref: src/never-existed.ts
-->
## Cites a file that is gone

Body.
`,
    }),

  ANCHOR_GROUNDING_MISMATCH: () =>
    validationDiagnostics({
      "context/x.md": `<!-- mex:entity
id: ${COVERAGE_ENTITY}
type: decision
status: promoted
revision: 1
grounds_to:
  - node: "function:deadbeefdeadbeef"
    fingerprint: "mh:64:aabbccdd"
-->
## Grounded one way, anchored another

See [the code](mex://function:0123456789abcdef).
`,
    }),

  GROUNDING_UNRESOLVED: () =>
    groundingDiagnostics((grounding) => ({
      state: "unresolved",
      health: "unverified",
      node: grounding.node,
      reason: "no code graph in this checkout",
    })),

  AMBIGUOUS_MIGRATION: () =>
    // A legacy edge whose target file yields several entities and no
    // file-level entity: "that file" names no single thing, and section 13.1
    // says report rather than guess.
    inScratch((directory) => {
      mkdirSync(join(directory, "context"), { recursive: true });
      mkdirSync(join(directory, "patterns"), { recursive: true });
      const substantial = [
        "Prose enough to clear the substantiality threshold, over several lines.",
        "A second line of prose that carries several more words along with it.",
        "And a third line of prose so the section is a claim rather than a note.",
      ].join(String.fromCharCode(10));
      writeFileSync(
        join(directory, "patterns", "thing.md"),
        [
          "---",
          "name: thing",
          'description: "x"',
          "edges:",
          "  - target: context/risks.md",
          "    condition: when weighing a failure mode",
          "---",
          "",
          "# Thing",
          "",
          substantial,
          "",
        ].join(String.fromCharCode(10)),
        "utf-8",
      );
      writeFileSync(
        join(directory, "context", "risks.md"),
        [
          "---",
          "name: risks",
          'description: "x"',
          "---",
          "",
          "# Risks",
          "",
          "## One",
          "",
          substantial,
          "",
          "## Two",
          "",
          substantial,
          "",
        ].join(String.fromCharCode(10)),
        "utf-8",
      );
      return migrateScaffold({ scaffoldRoot: directory }).diagnostics;
    }),

  GENERATED_VIEW_DRIFT: () =>
    // A generated block that no longer matches the entities it summarizes.
    inScratch((directory) => {
      mkdirSync(join(directory, "patterns"), { recursive: true });
      writeFileSync(
        join(directory, "patterns", "INDEX.md"),
        [
          "---",
          "name: pattern-index",
          'description: "x"',
          "---",
          "",
          "# Pattern Index",
          "",
          GENERATED_BEGIN,
          "",
          "| Entity | Where |",
          "|---|---|",
          "| a row nothing produced | `nowhere` |",
          "",
          GENERATED_END,
          "",
        ].join(String.fromCharCode(10)),
        "utf-8",
      );
      const inventory = inventoryScaffold({ scaffoldRoot: directory });
      const index = inventory.files.find((file) => file.path === "patterns/INDEX.md")!;
      return planGeneratedView(index, inventory, "pattern")?.diagnostics ?? [];
    }),

  INVALID_AGENT_RESPONSE: () =>
    // A response file that is not the shape the stage expects. Through the real
    // command path, so the code stays reachable rather than merely registered.
    inScratch((directory) => {
      const response = join(directory, "response.json");
      writeFileSync(response, JSON.stringify({ stage: "pattern", cluster: "auth", notUnits: [] }), "utf-8");
      return wikiSynthesisPropose({ scaffoldRoot: directory, repoRoot: directory, responsePath: response })
        .diagnostics;
    }),
};

/**
 * Index one grounded entity, resolve it with `resolve`, and return whatever the
 * index reported.
 *
 * Goes through a real rebuild rather than calling the diagnostic builder
 * directly: these codes are only reachable when a grounding row exists, and a
 * test that manufactured the diagnostic would keep passing after the path that
 * produces it was removed.
 */
function groundingDiagnostics(resolve: GroundingResolver): readonly WikiDiagnostic[] {
  return inScratch((directory) => {
    const root = join(directory, "scaffold");
    mkdirSync(join(root, "notes"), { recursive: true });
    const id = generateEntityId();
    writeFileSync(
      join(root, "notes", "grounded.md"),
      `---\nname: grounded\n---\n\n# Grounded\n\n` +
        `<!-- mex:entity\nid: ${id}\ntype: decision\nstatus: promoted\nrevision: 1\n` +
        `grounds_to:\n  - node: function:1a2b3c4d5e6f7a8b\n    fingerprint: mh:64:0a0b\n-->\n` +
        `## A decision\n\nProse.\n`,
      "utf-8",
    );

    const indexPath = join(root, "wiki.db");
    rebuildWikiIndex({ scaffoldRoot: root, indexPath, resolveGrounding: resolve });

    const opened = openWikiIndex(indexPath);
    if (!opened.ok) return [opened.diagnostic];
    try {
      return opened.index.db
        .prepare(`SELECT code, severity, message, file, entity_id, path FROM wiki_diagnostics`)
        .all() as WikiDiagnostic[];
    } finally {
      opened.index.close();
    }
  });
}

describe("diagnostic code coverage", () => {
  it("emits every code this phase owns", () => {
    for (const [code, emit] of Object.entries(EMITTERS)) {
      expect(codesOf(emit()), `${code} was not emitted by its own example`).toContain(code);
    }
  });

  it("accounts for every registered code exactly once", () => {
    // Disjoint and covering: a code cannot be parked in NOT_YET_EMITTED once
    // its check lands, and a newly added code cannot be forgotten.
    const emitted = new Set(Object.keys(EMITTERS));
    const deferred = new Set(Object.keys(NOT_YET_EMITTED));

    // P9 emits the last two, so the deferred map is empty. Asserted directly
    // as well as through the covering property: "empty" is the exit criterion,
    // and a map that grew again would satisfy disjoint-and-covering perfectly
    // well while quietly reopening a check nobody emits.
    expect(Object.keys(NOT_YET_EMITTED)).toEqual([]);

    const overlap = [...emitted].filter((code) => deferred.has(code));
    expect(overlap, "these codes are emitted, so remove them from NOT_YET_EMITTED").toEqual([]);

    const unaccounted = WIKI_DIAGNOSTIC_CODES.filter((code) => !emitted.has(code) && !deferred.has(code));
    expect(unaccounted, "add an emitter, or record the phase that will emit it").toEqual([]);

    const stale = [...emitted, ...deferred].filter((code) => !isWikiDiagnosticCode(code));
    expect(stale, "these names are not registry codes").toEqual([]);
  });

  it("names a real phase for every deferred code", () => {
    for (const [code, phase] of Object.entries(NOT_YET_EMITTED)) {
      expect(phase, `${code} needs the phase that will emit it`).toMatch(/^P\d/);
    }
  });
});
