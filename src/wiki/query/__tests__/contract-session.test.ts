import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, readdirSync, renameSync, symlinkSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { createFingerprint, serializeFingerprint } from "../../../graph/fingerprint.js";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import { openWikiIndex } from "../../index/open.js";
import { WIKI_CORPUS_LIMITS } from "../../index/corpus-policy.js";
import { WIKI_META_KEYS } from "../../index/schema.js";
import { createScaffold, steppingClock, type Scaffold } from "../../index/__tests__/harness.js";
import {
  inspectWikiContractIndex,
  openWikiContractReadSession,
  withWikiContractReadSessionAsync,
  WikiContractReadError,
} from "../contract-session.js";

const TOPIC = "mx_01KRC0G1Y0B27EG9PJMQMMD3RE";
const SOURCE = "mx_01KQVXGJ60VSKPKQ4H1GJ2S0CB";
const TARGET = "mx_01KQYKB4T0FC6RE3HSRDJ4AVAH";

let scaffold: Scaffold | null = null;

afterEach(() => {
  scaffold?.dispose();
  scaffold = null;
});

function fixture(lineEnding = "\n"): string {
  return [
    "<!-- mex:entity",
    `id: ${TOPIC}`,
    "type: topic",
    "status: promoted",
    "revision: 1",
    "topics: []",
    "-->",
    "# Authentication",
    "",
    "Identity knowledge.",
    "",
    "<!-- mex:entity",
    `id: ${SOURCE}`,
    "type: architecture",
    "status: promoted",
    "revision: 3",
    `topics: [${TOPIC}]`,
    "relations:",
    "  - type: depends_on",
    `    target: ${TARGET}`,
    "    note: Runtime dependency",
    "    metadata:",
    "      strength: required",
    "sources:",
    "  - type: file",
    "    ref: src/gateway.ts",
    "    note: Implementation",
    "    metadata:",
    "      reviewed: true",
    "provenance:",
    "  createdBy:",
    "    kind: human",
    "    id: member_daksh",
    "  createdAt: 2026-08-22T00:00:00.000Z",
    "grounds_to:",
    "  - node: function:a3f8c21d9e4b7f60a1c2d3e4f5061728",
    "    fingerprint: mh:64:9f2a4c6e",
    "    file: src/gateway.ts",
    "    reason: Implements the gateway",
    "-->",
    "## Gateway architecture",
    "",
    "Bounded gateway body with a searchneedle.",
    "",
    "<!-- mex:entity",
    `id: ${TARGET}`,
    "type: component",
    "status: promoted",
    "revision: 1",
    `topics: [${TOPIC}]`,
    "-->",
    "## Gateway component",
    "",
    "The runtime component.",
    "",
  ].join(lineEnding);
}

function setup(lineEnding = "\n") {
  scaffold = createScaffold();
  scaffold.write("context/wiki.md", fixture(lineEnding));
  const indexPath = join(scaffold.root, "wiki.db");
  rebuildWikiIndex({
    scaffoldRoot: scaffold.root,
    indexPath,
    now: steppingClock(),
    resolveGrounding: (grounding) => ({
      state: "unresolved",
      health: "ambiguous",
      node: grounding.node,
      candidates: ["function:bbbbbbbbbbbbbbbb", "function:cccccccccccccccc"],
      reason: "Two candidates have equal confidence.",
    }),
  });
  return { scaffold, indexPath };
}

describe("Wiki contract read session", () => {
  it("projects complete entity, evidence, provenance, relation, and grounding data", () => {
    const { scaffold: target, indexPath } = setup();
    const inspected = inspectWikiContractIndex({ scaffoldRoot: target.root, indexPath });
    expect(inspected.diagnostics.map((entry) => entry.code)).toEqual(["GROUNDING_UNRESOLVED"]);
    expect(inspected).toMatchObject({ state: "fresh" });
    const session = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      const entity = session.get(SOURCE);
      expect(entity).toMatchObject({
        id: SOURCE,
        type: "architecture",
        semanticRevision: 3,
        groundingHealth: "ambiguous",
        topics: [TOPIC],
        sourceTypes: ["file"],
        provenance: { createdBy: { kind: "human", id: "member_daksh" } },
      });
      expect(entity?.fileContentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entity?.sources[0]).toMatchObject({
        type: "file",
        ref: "src/gateway.ts",
        metadata: { reviewed: true },
      });
      expect(entity?.relations[0]).toMatchObject({
        type: "depends_on",
        targetId: TARGET,
        metadata: { strength: "required" },
      });
      expect(entity?.groundings[0]).toMatchObject({
        requestedNode: "function:a3f8c21d9e4b7f60a1c2d3e4f5061728",
        resolution: {
          state: "unresolved",
          health: "ambiguous",
          candidates: ["function:bbbbbbbbbbbbbbbb", "function:cccccccccccccccc"],
        },
      });
      expect(session.relations({ entityId: SOURCE, direction: "outgoing" }).items[0]).toMatchObject({
        direction: "outgoing",
        entity: { id: TARGET },
      });
      expect(session.relations({ entityId: TARGET, direction: "incoming" }).items[0]).toMatchObject({
        direction: "incoming",
        entity: { id: SOURCE },
      });
      expect(session.get(TARGET)?.backlinks[0]).toMatchObject({ source: { id: SOURCE }, target: { id: TARGET } });
      expect(session.validate().valid).toBe(true);
    } finally {
      session.close();
    }
  });

  it("filters before paging and binds strict cursors to request and revision", () => {
    const { scaffold: target, indexPath } = setup();
    const session = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      const first = session.list({ kinds: ["architecture", "component", "topic"], limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      expect(first.truncated).toBe(true);
      expect(session.list({ kinds: ["architecture", "component", "topic"], limit: 3 }).truncated).toBe(false);
      const second = session.list({
        kinds: ["component", "topic", "architecture"],
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      expect(() => session.list({ kinds: ["component"], limit: 1, cursor: first.nextCursor! }))
        .toThrowError(WikiContractReadError);

      const searched = session.search({ query: "searchneedle", kinds: ["architecture"] });
      expect(searched.items).toHaveLength(1);
      expect(searched.items[0]).toMatchObject({ entity: { id: SOURCE }, matchedFields: ["body"] });
      expect(session.list({ topics: [TOPIC] }).items.map((item) => item.id)).toEqual([SOURCE, TARGET]);
      expect(session.list({ groundingHealth: ["ambiguous"] }).items.map((item) => item.id)).toEqual([SOURCE]);
      expect(session.list({ sourceTypes: ["file"] }).items.map((item) => item.id)).toEqual([SOURCE]);
      expect(() => session.list({ limit: 101 })).toThrowError(WikiContractReadError);
      expect(() => session.list({ cursor: "1junk" })).toThrowError(WikiContractReadError);
      expect(() => session.list({ maxTokens: 1 })).toThrowError(WikiContractReadError);

      const one = session.list({ limit: 1 });
      const tokenBound = session.list({ limit: 3, maxTokens: one.estimatedTokens });
      expect(tokenBound.items).toHaveLength(1);
      expect(tokenBound.nextCursor).not.toBeNull();
      expect(tokenBound.truncated).toBe(true);

      expect(() => session.list({
        limit: 1,
        cursor: cursorWithOffset(one.nextCursor!, 100_000),
      })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));

      const searchPage = session.search({ query: "gateway", limit: 1 });
      expect(searchPage.nextCursor).not.toBeNull();
      expect(() => session.search({
        query: "gateway",
        limit: 1,
        cursor: cursorWithOffset(searchPage.nextCursor!, 100_000),
      })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    } finally {
      session.close();
    }
  });

  it("uses exact containing-file bytes for freshness and rejects mixed reads", () => {
    const { scaffold: target, indexPath } = setup("\r\n");
    const session = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    const before = session.get(SOURCE)!;
    target.write("context/wiki.md", fixture("\n"));
    const status = inspectWikiContractIndex({ scaffoldRoot: target.root, indexPath });
    expect(status.state).toBe("stale");
    expect(session.validate().valid).toBe(false);
    session.close();
    expect(readdirSync(target.root).filter((name) => name.startsWith("wiki.db-"))).toEqual([]);

    const rebuilt = rebuildWikiIndex({ scaffoldRoot: target.root, indexPath, now: steppingClock() });
    expect(rebuilt.diagnostics).toEqual([]);
    const afterSession = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      const after = afterSession.get(SOURCE)!;
      expect(after.fileContentHash).not.toBe(before.fileContentHash);
      expect(after.entityContentHash).toBe(before.entityContentHash);
    } finally {
      afterSession.close();
    }
  });

  it("discovers sorted added, modified, and deleted refresh paths inside the immutable handshake", async () => {
    const { scaffold: target, indexPath } = setup();
    target.write("context/added.md", fixture().replaceAll(SOURCE, "mx_01KRZZZZZZZZZZZZZZZZZZZZZY"));
    target.remove("context/wiki.md");
    const stale = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      expect(stale.refreshPaths()).toEqual(["context/added.md", "context/wiki.md"]);
    } finally {
      stale.close();
    }

    // Use a second already-fresh fixture for the final-revalidation race. This
    // keeps the assertion focused on the immutable read boundary instead of a
    // just-published SQLite file competing for descriptors under parallel CI.
    const { scaffold: raceTarget, indexPath: raceIndexPath } = setup();
    await expect(withWikiContractReadSessionAsync(
      { scaffoldRoot: raceTarget.root, indexPath: raceIndexPath },
      async (session) => {
        raceTarget.write("context/wiki.md", `${fixture()}\nChanged mid-discovery.\n`);
        expect(session.refreshPaths()).toEqual(["context/wiki.md"]);
        return session.refreshPaths();
      },
    )).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("rejects a corpus change during the initial status handshake", () => {
    const { scaffold: target, indexPath } = setup();
    expect(() => openWikiContractReadSession({
      scaffoldRoot: target.root,
      indexPath,
      hooks: {
        afterInitialStatusInspection() {
          target.write("context/wiki.md", `${fixture()}\nChanged during inspection.\n`);
        },
      },
    })).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
  });

  it("keeps the descriptor-bound session open through asynchronous composition", async () => {
    const { scaffold: target, indexPath } = setup();
    await expect(withWikiContractReadSessionAsync(
      { scaffoldRoot: target.root, indexPath },
      async (session) => {
        const buffered = session.get(SOURCE);
        expect(buffered?.id).toBe(SOURCE);
        target.write("context/wiki.md", `${fixture()}\nChanged during async composition.\n`);
        await Promise.resolve();
        return buffered;
      },
    )).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("rejects a page cursor after an explicit index revision change", () => {
    const { scaffold: target, indexPath } = setup();
    const firstSession = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    const first = firstSession.list({ limit: 1 });
    firstSession.close();
    expect(first.nextCursor).not.toBeNull();

    target.write("context/wiki.md", `${fixture()}\nFresh canonical bytes.\n`);
    const rebuilt = rebuildWikiIndex({ scaffoldRoot: target.root, indexPath, now: steppingClock() });
    expect(rebuilt.diagnostics).toEqual([]);
    const secondSession = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      expect(() => secondSession.list({ limit: 1, cursor: first.nextCursor! })).toThrowError(
        expect.objectContaining({ code: "REVISION_CONFLICT" }),
      );
    } finally {
      secondSession.close();
    }
  });

  it("rejects a cursor when derived grounding state changes over the same canonical corpus", () => {
    const { scaffold: target, indexPath } = setup();
    const firstSession = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    const canonicalRevision = firstSession.indexedRevision;
    const snapshotRevision = firstSession.snapshotRevision;
    const first = firstSession.list({ limit: 1 });
    firstSession.close();
    expect(first.nextCursor).not.toBeNull();

    rebuildWikiIndex({
      scaffoldRoot: target.root,
      indexPath,
      now: steppingClock(),
      resolveGrounding: (grounding) => ({
        state: "fresh",
        health: "fresh",
        node: grounding.node,
        resolvedNode: grounding.node,
        rebound: false,
        bodyHash: "current-body",
      }),
    });
    const secondSession = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      expect(secondSession.indexedRevision).toBe(canonicalRevision);
      expect(secondSession.snapshotRevision).not.toBe(snapshotRevision);
      expect(() => secondSession.list({ limit: 1, cursor: first.nextCursor! }))
        .toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    } finally {
      secondSession.close();
    }
  });

  it("returns a deterministic bounded neighborhood", () => {
    const { scaffold: target, indexPath } = setup();
    const session = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      const neighborhood = session.neighborhood({
        entityId: SOURCE,
        direction: "outgoing",
        relationTypes: ["depends_on"],
        depth: 1,
        maxEntities: 10,
        maxTokens: 10_000,
      });
      expect(neighborhood.root.id).toBe(SOURCE);
      expect(neighborhood.entities.map((entity) => entity.id)).toEqual([TARGET]);
      expect(neighborhood.relations).toHaveLength(1);
      expect(neighborhood.truncated).toBe(false);
      expect(neighborhood.estimatedTokens).toBeGreaterThan(0);
    } finally {
      session.close();
    }
  });

  it("filters dangling and archived relation neighbors before safety paging", () => {
    const { scaffold: target, indexPath } = setup();
    const writable = openWikiIndex(indexPath, { readOnly: false });
    if (!writable.ok) throw new Error(writable.diagnostic.message);
    const sourceKey = (writable.index.db.prepare(
      `SELECT entity_key FROM wiki_entities WHERE id = ? AND shadowed = 0 LIMIT 1`,
    ).get(SOURCE) as { entity_key: string }).entity_key;
    const insert = writable.index.db.prepare(
      `INSERT INTO wiki_relations
       (source_key, ordinal, type, target_id, target_resolved, note, metadata)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    );
    for (let index = 0; index < 210; index += 1) {
      insert.run(sourceKey, 1000 + index, "a_dangling", "mx_00000000000000000000000000", 0);
    }
    insert.run(sourceKey, 2000, "z_valid", TOPIC, 1);
    writable.index.db.pragma("wal_checkpoint(TRUNCATE)");
    writable.index.close();

    const session = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      const first = session.relations({ entityId: SOURCE, direction: "outgoing", limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.items[0]?.entity?.id).toBe(TARGET);
      expect(first.nextCursor).not.toBeNull();
      const second = session.relations({
        entityId: SOURCE,
        direction: "outgoing",
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(second.items[0]?.entity?.id).toBe(TOPIC);
      expect(second.truncated).toBe(false);
      expect(() => session.relations({
        entityId: SOURCE,
        direction: "outgoing",
        limit: 1,
        cursor: cursorWithOffset(first.nextCursor!, 100_000),
      })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    } finally {
      session.close();
    }
  });

  it("rejects missing relation roots and omits dangling neighbors", () => {
    const { scaffold: target, indexPath } = setup();
    const missing = "mx_00000000000000000000000000";
    const writable = openWikiIndex(indexPath, { readOnly: false });
    if (!writable.ok) throw new Error(writable.diagnostic.message);
    writable.index.db.prepare(
      `UPDATE wiki_relations SET target_id = ?, target_resolved = 0 WHERE target_id = ?`,
    ).run(missing, TARGET);
    writable.index.db.pragma("wal_checkpoint(TRUNCATE)");
    writable.index.close();

    const session = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      expect(session.relations({ entityId: SOURCE, direction: "outgoing" }).items).toEqual([]);
      expect(() => session.relations({ entityId: missing, direction: "both" }))
        .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(() => session.neighborhood({
        entityId: missing,
        depth: 1,
        maxEntities: 10,
        maxTokens: 10_000,
      })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    } finally {
      session.close();
    }
  });

  it("refuses a database A-to-B-to-A swap even when B copies indexedRevision", () => {
    const { scaffold: target, indexPath } = setup();
    const replacement = join(target.root, "wiki-replacement.db");
    const previous = join(target.root, "wiki-previous.db");
    copyFileSync(indexPath, replacement);
    const opened = openWikiIndex(replacement, { readOnly: false });
    if (!opened.ok) throw new Error(opened.diagnostic.message);
    opened.index.db.prepare(`UPDATE wiki_entities SET title = 'Forged title' WHERE id = ?`).run(SOURCE);
    opened.index.db.pragma("wal_checkpoint(TRUNCATE)");
    opened.index.close();

    // Put forged B under the canonical name before the outer descriptor bind,
    // then restore exact A in the deterministic seam. A revision-only check
    // would accept B because it copied A's metadata; descriptor identity and
    // its full-byte digest bind the session to the exact inspected database.
    renameSync(indexPath, previous);
    renameSync(replacement, indexPath);
    expect(() => openWikiContractReadSession({
      scaffoldRoot: target.root,
      indexPath,
      hooks: {
        afterInitialIndexBind() {
          renameSync(indexPath, replacement);
          renameSync(previous, indexPath);
        },
      },
    })).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
  });

  it("fails closed on unavailable sidecars and closes every bound descriptor on failures", () => {
    const { scaffold: target, indexPath } = setup();
    let inspectionCloses = 0;
    const inspected = inspectWikiContractIndex({
      scaffoldRoot: target.root,
      indexPath,
      hooks: {
        beforeSidecarStat(path) {
          if (path.endsWith("-wal")) throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
        afterIndexDescriptorClose() {
          inspectionCloses += 1;
        },
      },
    });
    expect(inspected.state).toBe("degraded");
    expect(inspected.diagnostics[0]?.message).not.toContain(target.root);
    expect(inspectionCloses).toBe(1);

    let hookFailureCloses = 0;
    expect(() => openWikiContractReadSession({
      scaffoldRoot: target.root,
      indexPath,
      hooks: {
        afterInitialIndexBind() {
          throw new Error("test hook failure");
        },
        afterIndexDescriptorClose() {
          hookFailureCloses += 1;
        },
      },
    })).toThrow("test hook failure");
    expect(hookFailureCloses).toBe(1);

    let openFailureCloses = 0;
    expect(() => openWikiContractReadSession({
      scaffoldRoot: target.root,
      indexPath,
      hooks: {
        beforeSessionImmutableOpen() {
          throw new Error("test immutable open failure");
        },
        afterIndexDescriptorClose() {
          openFailureCloses += 1;
        },
      },
    })).toThrow("test immutable open failure");
    // One descriptor belongs to the nested status inspection and one to the
    // session that was about to open its immutable SQLite handle.
    expect(openFailureCloses).toBe(2);
  });

  it("classifies missing, legacy, incompatible, and unsafe indexes", () => {
    scaffold = createScaffold();
    const indexPath = join(scaffold.root, "wiki.db");
    expect(inspectWikiContractIndex({ scaffoldRoot: scaffold.root, indexPath }).state).toBe("missing");
    scaffold.write("ROUTER.md", "---\nname: legacy-router\n---\n\n# Router\n");
    expect(inspectWikiContractIndex({ scaffoldRoot: scaffold.root, indexPath }).state).toBe("migration_required");

    scaffold.write("context/wiki.md", fixture());
    rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
    const unsafe = openWikiIndex(indexPath, { readOnly: false });
    if (!unsafe.ok) throw new Error(unsafe.diagnostic.message);
    unsafe.index.db.prepare(
      `UPDATE wiki_sources SET ref = '../escape.md'
        WHERE entity_key = (SELECT entity_key FROM wiki_entities WHERE id = ? LIMIT 1)`,
    ).run(SOURCE);
    unsafe.index.db.pragma("wal_checkpoint(TRUNCATE)");
    unsafe.index.close();
    expect(inspectWikiContractIndex({ scaffoldRoot: scaffold.root, indexPath }).state).toBe("corrupt");

    rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
    const future = openWikiIndex(indexPath, { readOnly: false });
    if (!future.ok) throw new Error(future.diagnostic.message);
    future.index.db.prepare(`UPDATE wiki_meta SET value = '999' WHERE key = ?`).run(WIKI_META_KEYS.schemaVersion);
    future.index.db.pragma("wal_checkpoint(TRUNCATE)");
    future.index.close();
    expect(inspectWikiContractIndex({ scaffoldRoot: scaffold.root, indexPath }).state).toBe("migration_required");
  });

  it("accepts a graph-produced grounding fingerprint larger than 4 KiB", () => {
    scaffold = createScaffold();
    // 256 neighbours: the compact encoding (#233) takes 17 bytes for each, so
    // this is what still crosses 4 KiB once serialized.
    const neighbours = Array.from(
      { length: 256 },
      (_, index) => `function:${index.toString(16).padStart(32, "0")}`,
    );
    const fingerprint = serializeFingerprint(createFingerprint(
      ["Identifier", "OpenParenToken", "CloseParenToken"],
      neighbours,
    ));
    expect(Buffer.byteLength(fingerprint, "utf8")).toBeGreaterThan(4_096);
    scaffold.write("context/wiki.md", fixture().replace("mh:64:9f2a4c6e", fingerprint));
    const indexPath = join(scaffold.root, "wiki.db");
    rebuildWikiIndex({
      scaffoldRoot: scaffold.root,
      indexPath,
      now: steppingClock(),
      resolveGrounding: (grounding) => ({
        state: "unresolved",
        health: "ambiguous",
        node: grounding.node,
        candidates: ["function:bbbbbbbbbbbbbbbb", "function:cccccccccccccccc"],
        reason: "Two candidates have equal confidence.",
      }),
    });

    expect(inspectWikiContractIndex({ scaffoldRoot: scaffold.root, indexPath })).toMatchObject({
      state: "fresh",
    });
    const session = openWikiContractReadSession({ scaffoldRoot: scaffold.root, indexPath });
    try {
      expect(session.get(SOURCE)?.groundings[0]?.fingerprint).toBe(fingerprint);
    } finally {
      session.close();
    }
  });

  it("refuses an oversized disposable index before hashing or SQLite materialization", () => {
    const { scaffold: target, indexPath } = setup();
    truncateSync(indexPath, WIKI_CORPUS_LIMITS.maxIndexBytes + 1);

    const inspected = inspectWikiContractIndex({ scaffoldRoot: target.root, indexPath });

    expect(inspected.state).toBe("degraded");
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
      code: "WIKI_PARSE_ERROR",
      message: "The disposable Wiki index corpus exceeds MEX's bounded inspection policy.",
    }));
  });

  it("does not classify a missing index as initializable when legacy inspection exceeds its corpus bound", () => {
    scaffold = createScaffold();
    scaffold.write("ROUTER.md", "x".repeat(WIKI_CORPUS_LIMITS.maxFileBytes + 1));

    const inspected = inspectWikiContractIndex({
      scaffoldRoot: scaffold.root,
      indexPath: join(scaffold.root, "wiki.db"),
    });

    expect(inspected.state).toBe("degraded");
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
      code: "WIKI_PARSE_ERROR",
      message: "The canonical Wiki corpus exceeds MEX's bounded inspection policy.",
    }));
  });

  it("uses the same no-follow source set for rebuild and corpus inspection", () => {
    const { scaffold: target, indexPath } = setup();
    target.write("outside.md", fixture());
    symlinkSync("../outside.md", join(target.root, "context", "linked.md"));
    rebuildWikiIndex({ scaffoldRoot: target.root, indexPath, now: steppingClock() });
    const inspected = inspectWikiContractIndex({ scaffoldRoot: target.root, indexPath });
    expect(inspected.state).toBe("degraded");
    expect(inspected.state).not.toBe("stale");
  });

  it("sanitizes diagnostic prose and rejects malformed diagnostic rows", () => {
    const { scaffold: target, indexPath } = setup();
    const writable = openWikiIndex(indexPath, { readOnly: false });
    if (!writable.ok) throw new Error(writable.diagnostic.message);
    writable.index.db.prepare(
      `UPDATE wiki_diagnostics SET message = ?, remediation = ?`,
    ).run(
      `Read failed path=${target.root}/secret folder/key.md, file://${target.root}/uri secret.md, and {"path":"C:\\secret folder\\key.md"}`,
      `Open [${target.root}/secret folder/key.md]`,
    );
    writable.index.db.pragma("wal_checkpoint(TRUNCATE)");
    writable.index.close();

    const safe = inspectWikiContractIndex({ scaffoldRoot: target.root, indexPath });
    expect(JSON.stringify(safe.diagnostics)).not.toContain(target.root);
    expect(JSON.stringify(safe.diagnostics)).not.toContain("folder/key.md");
    expect(JSON.stringify(safe.diagnostics)).not.toContain("secret folder");
    expect(JSON.stringify(safe.diagnostics)).not.toContain("file://");

    const malformed = openWikiIndex(indexPath, { readOnly: false });
    if (!malformed.ok) throw new Error(malformed.diagnostic.message);
    malformed.index.db.prepare(`UPDATE wiki_diagnostics SET code = 'NOT_A_REAL_CODE'`).run();
    malformed.index.db.pragma("wal_checkpoint(TRUNCATE)");
    malformed.index.close();
    expect(inspectWikiContractIndex({ scaffoldRoot: target.root, indexPath }).state).toBe("corrupt");
  });

  it("rejects malformed provenance before an adapter can project it", () => {
    const { scaffold: target, indexPath } = setup();
    const writable = openWikiIndex(indexPath, { readOnly: false });
    if (!writable.ok) throw new Error(writable.diagnostic.message);
    writable.index.db.prepare(`UPDATE wiki_entities SET provenance = '{}' WHERE id = ?`).run(SOURCE);
    writable.index.db.pragma("wal_checkpoint(TRUNCATE)");
    writable.index.close();

    expect(inspectWikiContractIndex({ scaffoldRoot: target.root, indexPath }).state).toBe("corrupt");
  });

  it("rejects relation metadata inventories beyond the structural safety bound", () => {
    const { scaffold: target, indexPath } = setup();
    const writable = openWikiIndex(indexPath, { readOnly: false });
    if (!writable.ok) throw new Error(writable.diagnostic.message);
    const sourceKey = (writable.index.db.prepare(
      `SELECT entity_key FROM wiki_entities WHERE id = ? AND shadowed = 0 LIMIT 1`,
    ).get(SOURCE) as { entity_key: string }).entity_key;
    writable.index.db.prepare(
      `WITH RECURSIVE counter(n) AS (
         VALUES(0)
         UNION ALL
         SELECT n + 1 FROM counter WHERE n < 100000
       )
       INSERT INTO wiki_entity_topics (entity_key, ordinal, topic_entity_id)
       SELECT ?, n + 1000, ? FROM counter`,
    ).run(sourceKey, TOPIC);
    writable.index.db.pragma("wal_checkpoint(TRUNCATE)");
    writable.index.close();
    expect(inspectWikiContractIndex({ scaffoldRoot: target.root, indexPath }).state).toBe("corrupt");
  });

  it("filters diagnostics before applying the response bound", () => {
    const { scaffold: target, indexPath } = setup();
    const writable = openWikiIndex(indexPath, { readOnly: false });
    if (!writable.ok) throw new Error(writable.diagnostic.message);
    const insert = writable.index.db.prepare(
      `INSERT INTO wiki_diagnostics
       (scope, code, severity, message, file, entity_id, path, start_offset, end_offset, start_line, end_line, remediation)
       VALUES ('file', 'GROUNDING_UNRESOLVED', 'error', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
    );
    for (let index = 0; index < 101; index += 1) {
      insert.run(`Unrelated ${index}`, `a/unrelated-${String(index).padStart(3, "0")}.md`, TOPIC);
    }
    writable.index.db.pragma("wal_checkpoint(TRUNCATE)");
    writable.index.close();

    const session = openWikiContractReadSession({ scaffoldRoot: target.root, indexPath });
    try {
      const filtered = session.diagnostics({ entityIds: [SOURCE], limit: 100 });
      expect(filtered.items).toHaveLength(1);
      expect(filtered.items[0]).toMatchObject({
        code: "GROUNDING_UNRESOLVED",
        entityId: SOURCE,
      });
      expect(session.diagnosticValidation()).toEqual({ valid: false });
      expect(session.diagnosticValidation({ entityIds: [SOURCE] })).toEqual({ valid: true });
      expect(session.diagnosticValidation({ paths: ["context/wiki.md"] })).toEqual({ valid: false });
      expect(session.diagnosticValidation({ paths: ["context/absent.md"] })).toEqual({ valid: true });
      expect(session.diagnosticValidation({ entityIds: [] })).toEqual({ valid: true });
      expect(session.diagnostics({ limit: 0 })).toMatchObject({ items: [], truncated: true });
    } finally {
      session.close();
    }
  });
});

function cursorWithOffset(cursor: string, offset: number): string {
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...payload, offset }), "utf8").toString("base64url");
}
