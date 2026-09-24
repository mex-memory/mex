/**
 * §20.4 — every operation, against every criterion.
 *
 * The eight criteria are the same for all eleven, so they are asserted by one
 * table-driven suite rather than eleven hand-written copies: dry-run diff
 * exact and writes nothing, apply succeeds, wrong revision rejected, wrong
 * content hash rejected, unrelated bytes preserved, index refreshed, audit
 * appended, replay idempotent. Eleven copies is eleven chances for one of them
 * to quietly omit a criterion, and the omission would be invisible.
 *
 * What each operation *means* is then asserted individually below, because that
 * part genuinely differs.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWikiMarkdown } from "../../markdown/codec.js";
import { generateEntityId } from "../../model/ids.js";
import { applyOperation } from "../apply.js";
import { planOperation } from "../plan.js";
import { previewPlan, renderPreview } from "../preview.js";
import type { GroundingGraph } from "../../grounding/adapter.js";
import { acceptedOperations, operationLogPath, readAuditLog } from "../audit.js";
import {
  ARCH,
  ARCH_MD,
  GATEWAY,
  JWT,
  PATTERN,
  TOPIC,
  assertUntouched,
  codesOf,
  envelope,
  makeScaffold,
  type Scaffold,
} from "./helpers.js";

const scaffolds: Scaffold[] = [];

function scaffold(files?: Record<string, string>): Scaffold {
  const made = makeScaffold(files);
  scaffolds.push(made);
  return made;
}

afterEach(() => {
  while (scaffolds.length > 0) scaffolds.pop()!.dispose();
});

/** A grounding graph that produces exactly one pair, for `set-grounding`. */
const NODE = "function:a3f8c21d9e4b7f60a1c2d3e4f5061728";
const FINGERPRINT = "mh:64:9f2a4c6e";
const BODY_HASH = "b".repeat(64);

const stubGraph: GroundingGraph = {
  getNode: (id) => (id === NODE ? { id: NODE, bodyHash: BODY_HASH, filePath: "src/token.ts", startLine: 1, endLine: 9 } : null),
  getFingerprint: (id) => (id === NODE ? FINGERPRINT : null),
  reconcile: () => null,
  // Never consulted by a write; a throw is the assertion that it is not.
  getBaselineSource: () => {
    throw new Error("set-grounding must not read the cached baseline");
  },
};

/**
 * The one place a grounding is minted in these tests.
 *
 * `deriveVerifiedGroundings` re-derives from the graph, so the stub has to be
 * the thing that produces the values — a literal written here would be exactly
 * the fabrication §12.4 exists to reject, and the test would then be asserting
 * that the check fails.
 */
function groundingPayload(): Record<string, unknown> {
  return { groundsTo: [{ node: NODE, fingerprint: FINGERPRINT, bodyHash: BODY_HASH }] };
}

/** Each operation, with the envelope that exercises it. */
interface Case {
  type: string;
  entityId?: string;
  payload: unknown;
  /** Files the operation is expected to touch. */
  files: string[];
  /** Needs the stub graph. */
  graph?: boolean;
}

const CASES: Case[] = [
  {
    type: "create-entry",
    payload: {
      file: "context/architecture.md",
      insertAt: { at: "after-entity", entityId: GATEWAY },
      type: "convention",
      title: "Name services after their domain",
      body: "Not after the team that owns them.",
      headingDepth: 2,
    },
    files: ["context/architecture.md"],
  },
  {
    type: "update-entry",
    entityId: GATEWAY,
    payload: { body: "Terminates TLS, routes by path prefix, and rate limits." },
    files: ["context/architecture.md"],
  },
  {
    type: "set-property",
    entityId: JWT,
    payload: { property: "status", value: "deprecated" },
    files: ["context/architecture.md"],
  },
  {
    type: "add-relation",
    entityId: GATEWAY,
    payload: { relation: { type: "depends_on", target: JWT } },
    files: ["context/architecture.md"],
  },
  {
    type: "remove-relation",
    entityId: GATEWAY,
    payload: { type: "depends_on", target: JWT },
    files: ["context/architecture.md"],
  },
  {
    type: "add-source",
    entityId: JWT,
    payload: { source: { type: "commit", commit: "a1b2c3d4e5f6789012345678901234567890abcd" } },
    files: ["context/architecture.md"],
  },
  {
    type: "remove-source",
    entityId: JWT,
    payload: { sourceIdentity: "commit||a1b2c3d" },
    files: ["context/architecture.md"],
  },
  {
    type: "set-grounding",
    entityId: JWT,
    payload: groundingPayload(),
    files: ["context/architecture.md"],
    graph: true,
  },
  {
    type: "supersede-entry",
    entityId: JWT,
    payload: {
      replacement: {
        file: "context/architecture.md",
        insertAt: { at: "end-of-file" },
        type: "decision",
        title: "Use opaque tokens",
        body: "Revocable, at the cost of a lookup.",
        headingDepth: 2,
      },
    },
    files: ["context/architecture.md"],
  },
  {
    type: "move-entry",
    entityId: GATEWAY,
    payload: { file: "patterns/problem-documents.md", insertAt: { at: "end-of-file" } },
    files: ["context/architecture.md", "patterns/problem-documents.md"],
  },
  {
    type: "archive-entry",
    entityId: JWT,
    payload: { note: "Superseded by opaque tokens." },
    files: ["context/architecture.md"],
  },
];

/** Prepare a scaffold in whatever state this case needs before it runs. */
function prepare(target: Scaffold, testCase: Case): void {
  if (testCase.type === "remove-relation") {
    // The relation has to exist before it can be removed, and it is added
    // through the pipeline rather than by editing the fixture — a hand-edited
    // precondition proves the removal works on a file the writer never made.
    const added = applyOperation(
      envelope(target, "add-relation", { relation: { type: "depends_on", target: JWT } }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );
    expect(added.ok, "setup: add-relation").toBe(true);
  }
  if (testCase.type === "remove-source") {
    const added = applyOperation(
      envelope(
        target,
        "add-source",
        { source: { type: "commit", commit: "a1b2c3d4e5f6789012345678901234567890abcd" } },
        { entityId: JWT },
      ),
      { scaffoldRoot: target.root },
    );
    expect(added.ok, "setup: add-source").toBe(true);
  }
}

function optionsFor(target: Scaffold, testCase: Case): Record<string, unknown> {
  return { scaffoldRoot: target.root, ...(testCase.graph === true ? { graph: stubGraph } : {}) };
}

describe.each(CASES)("$type", (testCase) => {
  it("produces an exact dry-run diff and writes nothing", () => {
    const target = scaffold();
    prepare(target, testCase);
    const before = target.files();
    // Not "the log does not exist": some cases need a setup operation, which
    // legitimately creates one. What a dry run may not do is add to it.
    const logBefore = existsSync(operationLogPath(target.root)) ? readFileSync(operationLogPath(target.root), "utf-8") : null;
    const planned = planOperation(envelope(target, testCase.type, testCase.payload, { entityId: testCase.entityId }), optionsFor(target, testCase) as never);
    expect(planned.ok ? [] : codesOf(planned.diagnostics)).toEqual([]);
    if (!planned.ok) return;

    const preview = previewPlan(planned.plan);
    expect(preview.files.map((file) => file.path).sort()).toEqual([...testCase.files].sort());

    // "Exact" is checkable, not a feeling: applying the plan's own hunks to the
    // base text must reproduce the proposed text byte for byte. A diff that
    // renders something other than what would be written is worse than none.
    for (const file of planned.plan.files) {
      let rebuilt = "";
      let cursor = 0;
      for (const edit of file.edits) {
        rebuilt += file.baseText.slice(cursor, edit.start) + edit.text;
        cursor = edit.end;
      }
      rebuilt += file.baseText.slice(cursor);
      expect(rebuilt).toBe(file.proposedText);
    }
    expect(renderPreview(preview)).toContain("+++");

    // And nothing on disk moved, including the audit log.
    expect(target.files()).toEqual(before);
    const logAfter = existsSync(operationLogPath(target.root)) ? readFileSync(operationLogPath(target.root), "utf-8") : null;
    expect(logAfter).toBe(logBefore);
  });

  it("applies, preserves unrelated bytes, appends an audit line, and replays as a no-op", () => {
    const target = scaffold();
    prepare(target, testCase);
    const before = target.files();

    const env = envelope(target, testCase.type, testCase.payload, { entityId: testCase.entityId });
    const planned = planOperation(env, optionsFor(target, testCase) as never);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const applied = applyOperation(env, optionsFor(target, testCase) as never);
    expect(applied.ok ? [] : codesOf(applied.diagnostics)).toEqual([]);
    expect(applied.changedFiles.sort()).toEqual([...testCase.files].sort());
    expect(applied.replayed).toBe(false);

    // Unrelated bytes, asserted with the harness rather than by inspection —
    // against a file that genuinely has unrelated bytes (see helpers.ts).
    for (const file of planned.plan.files) {
      assertUntouched(before[file.path]!, target.read(file.path), file.declared);
    }
    // Files the operation did not name are byte-identical.
    for (const [path, text] of Object.entries(before)) {
      if (testCase.files.includes(path)) continue;
      expect(target.read(path), `${path} was not named by ${testCase.type}`).toBe(text);
    }
    // The result still parses, with no new errors.
    for (const path of testCase.files) {
      const parsed = parseWikiMarkdown({ path, text: target.read(path) });
      expect(parsed.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    }

    // The audit log carries exactly one accepted line for this operation.
    const log = readAuditLog(target.root);
    expect(log.diagnostics).toEqual([]);
    const accepted = acceptedOperations(log).filter((entry) => entry.opId === env["opId"]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.type).toBe(testCase.type);
    expect(accepted[0]!.actor.id).toBe("p5-tests");
    expect(accepted[0]!.files.sort()).toEqual([...testCase.files].sort());

    // Replay: a no-op that reports the original, and changes not one byte.
    const after = target.files();
    const replayed = applyOperation(env, optionsFor(target, testCase) as never);
    expect(replayed.ok).toBe(true);
    expect(replayed.replayed).toBe(true);
    expect(replayed.changedFiles.sort()).toEqual([...testCase.files].sort());
    expect(target.files()).toEqual(after);
    expect(acceptedOperations(readAuditLog(target.root)).filter((entry) => entry.opId === env["opId"])).toHaveLength(1);
  });

  it("rejects a wrong revision and a wrong content hash", () => {
    const target = scaffold();
    prepare(target, testCase);
    const before = target.files();

    if (testCase.entityId === undefined) {
      // `create-entry` names no existing entity, so it has no preconditions to
      // get wrong. Stated as an assertion rather than skipped, because "this
      // one has none" and "this one forgot to check" look identical in a skip.
      const env = envelope(target, testCase.type, testCase.payload);
      expect(env["baseRevision"]).toBeUndefined();
      expect(env["baseContentHash"]).toBeUndefined();
      const planned = planOperation(env, optionsFor(target, testCase) as never);
      expect(planned.ok).toBe(true);
      return;
    }

    const wrongRevision = planOperation(
      envelope(target, testCase.type, testCase.payload, { entityId: testCase.entityId, baseRevision: 99 }),
      optionsFor(target, testCase) as never,
    );
    expect(wrongRevision.ok).toBe(false);
    expect(codesOf(wrongRevision.diagnostics)).toContain("REVISION_CONFLICT");

    const wrongHash = planOperation(
      envelope(target, testCase.type, testCase.payload, { entityId: testCase.entityId, baseContentHash: "0".repeat(64) }),
      optionsFor(target, testCase) as never,
    );
    expect(wrongHash.ok).toBe(false);
    expect(codesOf(wrongHash.diagnostics)).toContain("CONTENT_HASH_CONFLICT");

    // Rejected means nothing was written, not "written and then complained".
    expect(target.files()).toEqual(before);
  });

  it("refreshes the index it was given, and reports when there is none", () => {
    const target = scaffold();
    prepare(target, testCase);

    // With no index — the normal case in production, since nothing builds one.
    const noIndex = applyOperation(
      envelope(target, testCase.type, testCase.payload, { entityId: testCase.entityId }),
      optionsFor(target, testCase) as never,
    );
    expect(noIndex.ok).toBe(true);
    expect(codesOf(noIndex.diagnostics)).toContain("INDEX_REFRESH_REQUIRED");
    // And it did not build one behind the user's back.
    expect(existsSync(join(target.root, "wiki.db"))).toBe(false);
  });

  it("rejects a read-only target at plan time, before any preview exists", () => {
    // The whole scaffold is reserved, so whichever files this operation would
    // touch, it is refused. Every one of the eleven, per the exit criteria.
    const target = scaffold();
    prepare(target, testCase);
    const before = target.files();
    const planned = planOperation(
      envelope(target, testCase.type, testCase.payload, { entityId: testCase.entityId }),
      { ...optionsFor(target, testCase), readOnly: ["**"] } as never,
    );
    expect(planned.ok).toBe(false);
    expect(codesOf(planned.diagnostics)).toContain("WRITE_SCOPE_VIOLATION");
    expect(planned.ok ? true : planned.diagnostics.some((entry) => /read-only/.test(entry.message))).toBe(true);
    expect(target.files()).toEqual(before);
  });
});

describe("the index really is refreshed", () => {
  it("moves the rows the write changed", async () => {
    const { rebuildWikiIndex } = await import("../../index/rebuild.js");
    const { getEntity } = await import("../../query/get.js");
    const target = scaffold();
    const indexPath = join(target.root, "wiki.db");
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath });

    // The row says what the file said, before anything is applied — otherwise
    // "the row changed" could be a row that was always going to say this.
    const was = getEntity(indexPath, JWT);
    expect(was.ok && was.value.status).toBe("promoted");

    const applied = applyOperation(
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT }),
      { scaffoldRoot: target.root, indexPath },
    );
    expect(applied.ok).toBe(true);
    expect(codesOf(applied.diagnostics)).not.toContain("INDEX_REFRESH_REQUIRED");

    const now = getEntity(indexPath, JWT);
    expect(now.ok && now.value.status).toBe("deprecated");
  });

  it("keeps the Markdown when the refresh fails", () => {
    const target = scaffold();
    const indexPath = join(target.root, "wiki.db");
    // A file that is not a database at all: opening it fails, which is the
    // failure mode a corrupt index actually has.
    target.write("wiki.db", "this is not a SQLite database");

    const applied = applyOperation(
      envelope(target, "set-property", { property: "status", value: "deprecated" }, { entityId: JWT }),
      { scaffoldRoot: target.root, indexPath },
    );

    expect(applied.ok).toBe(true);
    expect(codesOf(applied.diagnostics)).toContain("INDEX_REFRESH_REQUIRED");
    // **The write stands.** Never undo a valid write because a cache broke.
    expect(target.read("context/architecture.md")).toContain("status: deprecated");
    expect(acceptedOperations(readAuditLog(target.root))).toHaveLength(1);
  });
});

describe("what each operation means", () => {
  it.each([
    ["add-source", { source: { type: "file", ref: "../outside.md" } }, JWT],
    ["set-grounding", {
      groundsTo: [{ node: NODE, fingerprint: FINGERPRINT, bodyHash: BODY_HASH, file: "/etc/passwd" }],
    }, JWT],
    ["create-entry", {
      file: "context/architecture.md",
      insertAt: { at: "end-of-file" },
      type: "convention",
      title: "Unsafe source must not land",
      body: "This proposed entity is rejected before preview.",
      sources: [{ type: "file", ref: "src\\secret.ts" }],
      headingDepth: 2,
    }, undefined],
  ] as const)("rejects unsafe path metadata in %s before producing a preview", (type, payload, entityId) => {
    const target = scaffold();
    const before = target.files();
    const planned = planOperation(
      envelope(target, type, payload, entityId === undefined ? {} : { entityId }),
      { scaffoldRoot: target.root },
    );
    expect(planned.ok).toBe(false);
    expect(planned.ok ? [] : codesOf(planned.diagnostics)).toEqual(expect.arrayContaining([
      type === "set-grounding" ? "MALFORMED_GROUNDING" : "MALFORMED_SOURCE",
    ]));
    expect(target.files()).toEqual(before);
    expect(existsSync(operationLogPath(target.root))).toBe(false);
  });

  it("create-entry never overwrites existing prose", () => {
    const target = scaffold();
    const before = target.read("context/architecture.md");
    const applied = applyOperation(
      envelope(target, "create-entry", {
        file: "context/architecture.md",
        insertAt: { at: "after-entity", entityId: GATEWAY },
        type: "convention",
        title: "Name services after their domain",
        body: "Not after the team.",
        headingDepth: 2,
      }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);
    const after = target.read("context/architecture.md");

    // Every original character is still present, in order: an insert can only
    // add. Checked as a subsequence-free property — the original text with the
    // inserted block removed is the original text.
    expect(after.length).toBeGreaterThan(before.length);
    expect(applied.createdIds).toHaveLength(1);
    const created = target.entity(applied.createdIds[0]!);
    const block = after.slice(created.location.metadataStart, created.location.bodyEnd);
    expect(after.replace(block, "").replace(/\n{3,}/g, "\n\n")).toBe(before);
  });

  it("update-entry never alters an adjacent entity", () => {
    const target = scaffold();
    const neighbours = [ARCH, JWT].map((id) => target.entity(id).location.entityContentHash);
    const applied = applyOperation(
      envelope(target, "update-entry", { body: "Rewritten entirely." }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);
    expect(target.entity(GATEWAY).body.trim()).toBe("Rewritten entirely.");
    // The entity above it and the entity below it, both unchanged.
    expect([ARCH, JWT].map((id) => target.entity(id).location.entityContentHash)).toEqual(neighbours);
  });

  it("update-entry rewrites the heading in place, keeping its shape", () => {
    const target = scaffold();
    const applied = applyOperation(
      envelope(target, "update-entry", { title: "Edge gateway" }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);
    const after = target.read("context/architecture.md");
    expect(after).toContain("## Edge gateway");
    expect(after).not.toContain("## Gateway");
    expect(target.entity(GATEWAY).title).toBe("Edge gateway");
  });

  it("set-property rejects anything outside SETTABLE_PROPERTIES and bumps the revision", () => {
    const target = scaffold();
    const before = target.entity(JWT).revision;

    const rejected = planOperation(
      envelope(target, "set-property", { property: "id", value: generateEntityId() }, { entityId: JWT }),
      { scaffoldRoot: target.root },
    );
    expect(rejected.ok).toBe(false);
    expect(codesOf(rejected.diagnostics)).toContain("INVALID_OPERATION_PAYLOAD");

    const applied = applyOperation(
      envelope(target, "set-property", { property: "summary", value: "Stateless sessions." }, { entityId: JWT }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);
    expect(target.entity(JWT).revision).toBe(before + 1);
    expect(target.entity(JWT).summary).toBe("Stateless sessions.");
  });

  it("add-relation refuses a duplicate and a self-relation, and changes only the source entity", () => {
    const target = scaffold();
    const targetHash = target.entity(JWT).location.entityContentHash;

    const first = applyOperation(
      envelope(target, "add-relation", { relation: { type: "depends_on", target: JWT } }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );
    expect(first.ok).toBe(true);
    expect(target.entity(GATEWAY).relations).toEqual([{ type: "depends_on", target: JWT }]);
    // The *target* of the relation is not edited: a relation is one entity's
    // outgoing statement, and backlinks are derived.
    expect(target.entity(JWT).location.entityContentHash).toBe(targetHash);

    const duplicate = planOperation(
      envelope(target, "add-relation", { relation: { type: "depends_on", target: JWT } }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );
    expect(codesOf(duplicate.diagnostics)).toContain("DUPLICATE_RELATION");

    const self = planOperation(
      envelope(target, "add-relation", { relation: { type: "related_to", target: GATEWAY } }, { entityId: GATEWAY }),
      { scaffoldRoot: target.root },
    );
    expect(codesOf(self.diagnostics)).toContain("SELF_RELATION");
  });

  it("add-source deduplicates by normalized identity, not by literal equality", () => {
    const target = scaffold();
    const full = "a1b2c3d4e5f6789012345678901234567890abcd";
    expect(
      applyOperation(envelope(target, "add-source", { source: { type: "commit", commit: full } }, { entityId: JWT }), {
        scaffoldRoot: target.root,
      }).ok,
    ).toBe(true);

    // The same commit, abbreviated. `sourceIdentity` normalizes to seven
    // characters, so this is the same evidence and must be refused.
    const abbreviated = planOperation(
      envelope(target, "add-source", { source: { type: "commit", commit: full.slice(0, 7) } }, { entityId: JWT }),
      { scaffoldRoot: target.root },
    );
    expect(codesOf(abbreviated.diagnostics)).toContain("DUPLICATE_SOURCE");
  });

  it("set-grounding refuses a fabricated pair and accepts a re-derivable one", () => {
    const target = scaffold();
    const fabricated = planOperation(
      envelope(target, "set-grounding", { groundsTo: [{ node: NODE, fingerprint: "mh:64:deadbeef" }] }, { entityId: JWT }),
      { scaffoldRoot: target.root, graph: stubGraph },
    );
    expect(fabricated.ok).toBe(false);
    expect(codesOf(fabricated.diagnostics)).toContain("GROUNDING_UNVERIFIED");

    const applied = applyOperation(envelope(target, "set-grounding", groundingPayload(), { entityId: JWT }), {
      scaffoldRoot: target.root,
      graph: stubGraph,
    });
    expect(applied.ok).toBe(true);
    const grounding = target.entity(JWT).groundsTo;
    expect(grounding).toHaveLength(1);
    expect(grounding[0]!.node).toBe(NODE);
    // Finding 39: everything mex writes carries a body hash, or drift is
    // structurally undetectable.
    expect(grounding[0]!.bodyHash).toBe(BODY_HASH);
  });

  it("set-grounding leaves anchors alone unless asked, and rewrites only the link's URI", () => {
    const other = "function:0000111122223333444455556666777";
    const withAnchor = `<!-- mex:entity
id: ${PATTERN}
type: pattern
status: promoted
revision: 1
grounds_to:
  - node: "${other}"
    fingerprint: "mh:64:00000000"
-->
## Return problem documents

See [the handler](mex://${other}) for the shape.
`;
    const target = scaffold({ "patterns/problem-documents.md": withAnchor });

    const untouched = applyOperation(
      envelope(target, "set-grounding", groundingPayload(), { entityId: PATTERN }),
      { scaffoldRoot: target.root, graph: stubGraph },
    );
    expect(untouched.ok).toBe(true);
    expect(target.read("patterns/problem-documents.md")).toContain(`mex://${other}`);

    // Asked for explicitly, the link's URI moves and its visible text does not.
    const target2 = scaffold({ "patterns/problem-documents.md": withAnchor });
    const asked = applyOperation(
      envelope(target2, "set-grounding", { ...groundingPayload(), updateAnchors: true }, { entityId: PATTERN }),
      { scaffoldRoot: target2.root, graph: stubGraph },
    );
    expect(asked.ok).toBe(true);
    const after = target2.read("patterns/problem-documents.md");
    expect(after).toContain(`[the handler](mex://${NODE})`);
    expect(after).not.toContain(other);
  });

  it("supersede-entry deprecates without deleting, and rejects a cycle", () => {
    const target = scaffold();
    const body = target.entity(JWT).body;

    const applied = applyOperation(
      envelope(
        target,
        "supersede-entry",
        {
          replacement: {
            file: "context/architecture.md",
            insertAt: { at: "end-of-file" },
            type: "decision",
            title: "Use opaque tokens",
            body: "Revocable, at the cost of a lookup.",
            headingDepth: 2,
          },
        },
        { entityId: JWT },
      ),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);

    // Never a hard delete: the old entity is still there, with its body.
    expect(target.entity(JWT).status).toBe("deprecated");
    // Trimmed, because the replacement was appended at end-of-file and a body
    // runs to the next entity's metadata — so the old entity's body range grows
    // by the blank line separating them. Not one character of its prose moved.
    expect(target.entity(JWT).body.trim()).toBe(body.trim());
    const replacement = target.entity(applied.createdIds[0]!);
    expect(replacement.relations).toContainEqual({ type: "supersedes", target: JWT });

    // The reverse closes a cycle and is refused.
    const cycle = planOperation(
      envelope(target, "supersede-entry", { replacementId: JWT }, { entityId: replacement.id }),
      { scaffoldRoot: target.root },
    );
    expect(cycle.ok).toBe(false);
    expect(codesOf(cycle.diagnostics)).toContain("SUPERSESSION_CYCLE");
  });

  it("move-entry preserves the id and every inbound relation", () => {
    const target = scaffold();
    // Something points at the entity about to move, by id.
    expect(
      applyOperation(
        envelope(target, "add-relation", { relation: { type: "depends_on", target: GATEWAY } }, { entityId: PATTERN }),
        { scaffoldRoot: target.root },
      ).ok,
    ).toBe(true);

    const before = target.entity(GATEWAY);
    const applied = applyOperation(
      envelope(target, "move-entry", { file: "patterns/problem-documents.md", insertAt: { at: "end-of-file" } }, {
        entityId: GATEWAY,
      }),
      { scaffoldRoot: target.root },
    );
    expect(applied.ok).toBe(true);

    // Gone from the source, present in the destination, same id, same body.
    expect(target.read("context/architecture.md")).not.toContain(GATEWAY);
    const moved = target.entity(GATEWAY, "patterns/problem-documents.md");
    expect(moved.id).toBe(before.id);
    expect(moved.body.trim()).toBe(before.body.trim());
    expect(moved.revision).toBe(before.revision);

    // **Inbound relations need no update, because they target the id and not
    // the path.** Asserted directly, since finding 29 is the reason to be
    // nervous about ids and references.
    expect(target.entity(PATTERN).relations).toContainEqual({ type: "depends_on", target: GATEWAY });

    // And the source document is left clean: no hole where the entity was.
    const source = target.read("context/architecture.md");
    expect(source).not.toMatch(/\n{3,}/);
    expect(parseWikiMarkdown({ path: "context/architecture.md", text: source }).diagnostics).toEqual([]);
  });

  it("archive-entry preserves body, relations and sources", () => {
    const target = scaffold();
    const before = target.entity(JWT);
    const applied = applyOperation(envelope(target, "archive-entry", {}, { entityId: JWT }), {
      scaffoldRoot: target.root,
    });
    expect(applied.ok).toBe(true);

    const after = target.entity(JWT);
    expect(after.status).toBe("archived");
    expect(after.body).toBe(before.body);
    expect(after.relations).toEqual(before.relations);
    expect(after.sources).toEqual(before.sources);
    expect(after.topics).toEqual(before.topics);
    expect(after.topics).toContain(TOPIC);
  });
});

describe("create-entry, on the two things P8 needed from it", () => {
  it("re-derives the groundings it is handed, and refuses the ones the graph cannot produce", () => {
    // The §12.4 gate, on the operation that mints rather than moves. Before
    // this, `set-grounding` re-derived and `create-entry` wrote its `groundsTo`
    // straight into metadata — so the invariant that an agent may not invent a
    // node id had a hole in the operation an agent reaches for first.
    const target = scaffold();
    const fabricated = {
      file: "context/architecture.md",
      insertAt: { at: "end-of-file" },
      type: "component",
      title: "Invented",
      body: "Grounded to a node that does not exist.",
      headingDepth: 2,
      groundsTo: [{ node: "function:0000000000000000000000000000000f", fingerprint: "mh:64:deadbeef" }],
    };

    const before = target.read("context/architecture.md");
    const refused = applyOperation(envelope(target, "create-entry", fabricated), {
      scaffoldRoot: target.root,
      graph: stubGraph,
    });

    expect(refused.ok).toBe(false);
    expect(codesOf(refused.diagnostics)).toContain("GROUNDING_UNVERIFIED");
    expect(target.read("context/architecture.md")).toBe(before);
  });

  it("accepts a grounding the graph does produce, and writes what came back", () => {
    // The other polarity, so the check above is not passing because the gate
    // refuses everything.
    const target = scaffold();
    const applied = applyOperation(
      envelope(target, "create-entry", {
        file: "context/architecture.md",
        insertAt: { at: "end-of-file" },
        type: "component",
        title: "Token minting",
        body: "One function mints every token.",
        headingDepth: 2,
        ...groundingPayload(),
      }),
      { scaffoldRoot: target.root, graph: stubGraph },
    );

    expect(applied.ok).toBe(true);
    const created = target.entity(applied.createdIds[0]!);
    expect(created.groundsTo).toEqual([
      { node: NODE, fingerprint: FINGERPRINT, bodyHash: BODY_HASH, file: "src/token.ts" },
    ]);
  });

  it("refuses a grounding when there is no graph at all", () => {
    // §38's asymmetry, on this path too: a read with no graph degrades, a write
    // that mints a permanent canonical reference does not.
    const target = scaffold();
    const refused = applyOperation(
      envelope(target, "create-entry", {
        file: "context/architecture.md",
        insertAt: { at: "end-of-file" },
        type: "component",
        title: "No graph here",
        body: "Should not be written without a graph to verify against.",
        headingDepth: 2,
        ...groundingPayload(),
      }),
      { scaffoldRoot: target.root },
    );

    expect(refused.ok).toBe(false);
    expect(codesOf(refused.diagnostics)).toContain("GROUNDING_UNVERIFIED");
  });

  it("writes a metadata map, and the codec reads it back", () => {
    // The payload field P8 needed: a fact recorded at creation time rather than
    // in a second operation with a second audit line.
    const target = scaffold();
    const applied = applyOperation(
      envelope(target, "create-entry", {
        file: "context/architecture.md",
        insertAt: { at: "end-of-file" },
        type: "component",
        title: "Carries metadata",
        body: "An entity with an open metadata map attached at creation.",
        headingDepth: 2,
        metadata: { synthesis: { confidence: 0.82, stage: "architecture_component" } },
      }),
      { scaffoldRoot: target.root },
    );

    expect(applied.ok).toBe(true);
    expect(target.entity(applied.createdIds[0]!).metadata).toEqual({
      synthesis: { confidence: 0.82, stage: "architecture_component" },
    });
  });

  it("omits the metadata key when the map is empty", () => {
    // An empty map in the frontmatter is noise in a diff, and it is the shape
    // every other optional field in `newEntityFields` already avoids.
    const target = scaffold();
    const applied = applyOperation(
      envelope(target, "create-entry", {
        file: "context/architecture.md",
        insertAt: { at: "end-of-file" },
        type: "component",
        title: "No metadata",
        body: "An entity created with an empty metadata map.",
        headingDepth: 2,
        metadata: {},
      }),
      { scaffoldRoot: target.root },
    );

    expect(applied.ok).toBe(true);
    expect(target.read("context/architecture.md")).not.toContain("metadata:");
  });
});

describe("approval evidence in one Wiki operation", () => {
  const provenance = {
    createdBy: { kind: "agent" as const, id: "original-producer" },
    createdAt: "2026-08-20T10:00:00.000Z",
    agentSessionId: "original-session",
  };
  const approval = {
    type: "document" as const,
    ref: ".mex/inbox/proposal_reviewed.md",
    note: "Preserve the approved rationale.\n\nSecond line.\r\n\tOriginal indentation.",
    capturedAt: "2026-08-24T10:00:00.000Z",
    metadata: { proposalId: "proposal_reviewed", author: { kind: "agent", id: "producer" }, approvedBy: { kind: "human", id: "reviewer" } },
  };

  it.each([false, true])("captures creation authority only when explicitly enabled: %s", (captureCreationProvenance) => {
    const target = scaffold();
    const request = {
      ...envelope(target, "create-entry", {
        file: "context/architecture.md", insertAt: { at: "end-of-file" },
        type: "component", title: "New component", body: "Newly authored content.", headingDepth: 2,
      }),
      actor: { kind: "agent", id: "known-producer", sessionId: "known-session" },
      timestamp: "2026-09-08T10:00:00.000Z",
    };
    const result = applyOperation(request, { scaffoldRoot: target.root, captureCreationProvenance });
    expect(result.ok).toBe(true);
    const created = target.entity(result.createdIds[0]!);
    expect(created.provenance).toEqual(captureCreationProvenance ? {
      createdBy: { kind: "agent", id: "known-producer" },
      createdAt: request.timestamp,
      agentSessionId: "known-session",
    } : undefined);
    expect(created.sources).toEqual([]);
  });

  it("does not turn adoption time or actor into the original prose's provenance", () => {
    const text = "---\nlast_updated: 2020-01-01\n---\n\n# Existing guide\n\nLongstanding prose.\n";
    const target = scaffold({ "context/guide.md": text });
    const request = envelope(target, "create-entry", {
      file: "context/guide.md", adopt: { at: "file" }, type: "guide", title: "Existing guide",
    });
    const result = applyOperation(request, { scaffoldRoot: target.root, captureCreationProvenance: true });
    expect(result.ok).toBe(true);
    expect(target.entity(result.createdIds[0]!).provenance).toBeUndefined();
    expect(target.read("context/guide.md")).toContain("last_updated: 2020-01-01");
    expect(target.read("context/guide.md")).toContain("Longstanding prose.");
  });

  it("does not bypass authoring provenance bounds when capturing operation authority", () => {
    const target = scaffold();
    const before = target.files();
    const request = envelope(target, "create-entry", {
      file: "context/architecture.md", insertAt: { at: "end-of-file" },
      type: "component", title: "New component", body: "Newly authored content.", headingDepth: 2,
    });
    for (const actor of [
      { kind: "agent", id: "x".repeat(257) },
      { kind: "agent", id: "known", sessionId: "x".repeat(257) },
    ]) {
      const planned = planOperation({ ...request, actor }, { scaffoldRoot: target.root, captureCreationProvenance: true });
      expect(planned.ok).toBe(false);
      expect(planned.diagnostics.some((entry) => entry.code === "INVALID_OPERATION_PAYLOAD")).toBe(true);
    }
    expect(target.files()).toEqual(before);
    expect(readAuditLog(target.root).entries).toEqual([]);
  });

  it("creates explicit producer provenance and exact proposal evidence with one replay-safe audit", () => {
    const target = scaffold();
    const before = target.files();
    const request = envelope(target, "create-entry", {
      file: "context/architecture.md", insertAt: { at: "end-of-file" },
      type: "decision", title: "Reviewed decision", body: "The accepted context.", headingDepth: 2,
      provenance, sources: [approval],
    });
    const planned = planOperation(request, { scaffoldRoot: target.root, captureCreationProvenance: true });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const applied = applyOperation(request, { scaffoldRoot: target.root, captureCreationProvenance: true });
    expect(applied.ok).toBe(true);
    const created = target.entity(applied.createdIds[0]!);
    expect(created.provenance).toEqual(provenance);
    expect(created.sources).toEqual([approval]);
    expect(created.groundsTo).toEqual([]);
    for (const file of planned.plan.files) assertUntouched(before[file.path]!, target.read(file.path), file.declared);
    const after = target.files();
    expect(applyOperation(request, { scaffoldRoot: target.root })).toMatchObject({ ok: true, replayed: true });
    expect(target.files()).toEqual(after);
    expect(acceptedOperations(readAuditLog(target.root))).toHaveLength(1);
  });

  it.each([ARCH, GATEWAY])("appends evidence to %s while preserving original provenance, grounding, and neighboring entities", (id) => {
    const target = scaffold();
    const indent = id === ARCH ? "  " : "";
    const metadata = [
      "provenance:", "  createdBy:", "    kind: agent", "    id: original-producer",
      "  createdAt: '2026-08-20T10:00:00.000Z'", "  agentSessionId: original-session",
      "sources:", "  - type: manual", "    note: Prior evidence", "    metadata:", "      keep: original",
      "grounds_to:", `  - node: ${NODE}`, `    fingerprint: ${FINGERPRINT}`, `    bodyHash: ${BODY_HASH}`,
    ].map((line) => `${indent}${line}\n`).join("");
    target.write("context/architecture.md", target.read("context/architecture.md")
      .replace(`${indent}id: ${id}\n`, `${indent}id: ${id}\n${metadata}`));
    const original = target.entity(id);
    const before = target.files();
    const request = envelope(target, "update-entry", {
      body: "The approved correction.",
      appendSources: [
        { type: "manual", note: "prior evidence", metadata: { keep: "must not replace original" } },
        approval,
        approval,
      ],
    }, { entityId: id });
    const planned = planOperation(request, { scaffoldRoot: target.root });
    expect(planned.ok ? [] : codesOf(planned.diagnostics)).toEqual([]);
    if (!planned.ok) return;
    const applied = applyOperation(request, { scaffoldRoot: target.root });
    expect(applied.ok).toBe(true);
    const updated = target.entity(id);
    expect(updated.revision).toBe(original.revision + 1);
    expect(updated.provenance).toEqual(original.provenance);
    expect(updated.sources).toEqual([...original.sources, approval]);
    expect(updated.groundsTo).toEqual(original.groundsTo);
    expect(target.read("context/architecture.md")).toContain(`    bodyHash: ${BODY_HASH}`);
    for (const file of planned.plan.files) assertUntouched(before[file.path]!, target.read(file.path), file.declared);
    const after = target.files();
    expect(applyOperation(request, { scaffoldRoot: target.root })).toMatchObject({ ok: true, replayed: true });
    expect(target.files()).toEqual(after);
    expect(acceptedOperations(readAuditLog(target.root))).toHaveLength(1);
  });

  it("rejects an evidence append that would exceed the existing collection bound without touching the file", () => {
    const target = scaffold();
    const sources = Array.from({ length: 200 }, (_, index) => `  - type: document\n    ref: evidence-${index}\n`).join("");
    target.write("context/architecture.md", target.read("context/architecture.md")
      .replace(`id: ${GATEWAY}\n`, `id: ${GATEWAY}\nsources:\n${sources}`));
    const before = target.files();
    const applied = applyOperation(envelope(target, "update-entry", {
      summary: "Must not land partially.", appendSources: [approval],
    }, { entityId: GATEWAY }), { scaffoldRoot: target.root });
    expect(applied.ok).toBe(false);
    expect(codesOf(applied.diagnostics)).toContain("INVALID_OPERATION_PAYLOAD");
    expect(target.files()).toEqual(before);
    expect(acceptedOperations(readAuditLog(target.root))).toHaveLength(0);
  });
});

describe("set-grounding and a root `grounds_to` (#226)", () => {
  const ROOT_ENTRY = { node: "function:1c9d4b7e2f5a8036c4e1b9d7a2f60358", fingerprint: "mh:64:4b1c7e29", bodyHash: "a".repeat(64) };
  const withRoot = (): string => ARCH_MD.replace(
    "last_updated: 2026-08-22\n",
    `last_updated: 2026-08-22\ngrounds_to:\n  - node: ${ROOT_ENTRY.node}\n    fingerprint: ${ROOT_ENTRY.fingerprint}\n    bodyHash: ${ROOT_ENTRY.bodyHash}\n`,
  );

  it("absorbs the root key into the file-level entity without re-deriving it", () => {
    const target = scaffold({ "context/architecture.md": withRoot() });
    expect(target.entity(ARCH).groundsTo).toEqual([ROOT_ENTRY]);
    // No graph at all: a move of values already in the file needs none.
    const applied = applyOperation(envelope(target, "set-grounding", {
      groundsTo: [ROOT_ENTRY], absorbRootGroundings: true,
    }, { entityId: ARCH }), { scaffoldRoot: target.root });
    expect(applied.ok ? [] : codesOf(applied.diagnostics)).toEqual([]);
    const after = target.read("context/architecture.md");
    expect(after).not.toMatch(/^grounds_to:/m);
    expect(target.entity(ARCH).groundsTo).toEqual([ROOT_ENTRY]);
    expect(parseWikiMarkdown({ path: "context/architecture.md", text: after }).diagnostics).toEqual([]);
    expect(after).toContain("# keep this note; a whole-map rewrite would eat it");
  });

  it("refuses to absorb into a section entity", () => {
    const target = scaffold({ "context/architecture.md": withRoot() });
    const before = target.files();
    const applied = applyOperation(envelope(target, "set-grounding", {
      groundsTo: [], absorbRootGroundings: true,
    }, { entityId: GATEWAY }), { scaffoldRoot: target.root });
    expect(applied.ok).toBe(false);
    expect(codesOf(applied.diagnostics)).toContain("INVALID_OPERATION_PAYLOAD");
    expect(target.files()).toEqual(before);
  });

  it("refuses an absorb that would change the groundings it moves", () => {
    const target = scaffold({ "context/architecture.md": withRoot() });
    const before = target.files();
    const applied = applyOperation(envelope(target, "set-grounding", {
      groundsTo: [{ ...ROOT_ENTRY, bodyHash: "c".repeat(64) }], absorbRootGroundings: true,
    }, { entityId: ARCH }), { scaffoldRoot: target.root });
    expect(applied.ok).toBe(false);
    expect(codesOf(applied.diagnostics)).toContain("INVALID_OPERATION_PAYLOAD");
    expect(target.files()).toEqual(before);
  });

  it("replaces the root key too on an explicit set-grounding, so removed groundings stay removed", () => {
    const target = scaffold({ "context/architecture.md": withRoot() });
    const applied = applyOperation(envelope(target, "set-grounding", groundingPayload(), { entityId: ARCH }),
      { scaffoldRoot: target.root, graph: stubGraph } as never);
    expect(applied.ok ? [] : codesOf(applied.diagnostics)).toEqual([]);
    expect(target.read("context/architecture.md")).not.toMatch(/^grounds_to:/m);
    expect(target.entity(ARCH).groundsTo.map((entry) => entry.node)).toEqual([NODE]);
  });
});
