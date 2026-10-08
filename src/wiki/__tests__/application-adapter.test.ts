import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "../../graph/db/sqlite.js";
import { MexPortError } from "../../team/contracts/shared.js";
import type { WikiOperationRequest, WikiOperationType } from "../../team/contracts/wiki.js";
import {
  createRepositoryWikiPort,
  type RepositoryWikiGroundingSnapshot,
  type RepositoryWikiOperationPayload,
} from "../application-adapter.js";
import { prepareWikiRebuild } from "../index/rebuild.js";
import { WIKI_CORPUS_LIMITS } from "../index/corpus-policy.js";
import { OPERATION_LOG_MAX_BYTES } from "../operations/audit.js";
import { withWikiContractReadSession } from "../query/contract-session.js";

const ENTITY = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const TARGET = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJE";
const THIRD = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJF";
const TOPIC = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJG";
const FOURTH = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJH";
const WORKSTREAM = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(withGroundings = false): { root: string; firstPath: string } {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-adapter-"));
  roots.push(root);
  const context = join(root, ".mex", "context");
  mkdirSync(context, { recursive: true });
  const firstPath = join(context, "architecture.md");
  writeFileSync(firstPath, `<!-- mex:entity
id: ${ENTITY}
type: architecture
status: promoted
revision: 1
relations:
  - type: depends_on
    target: ${TARGET}
sources:
  - type: manual
    note: Maintainer review
-->
## Architecture

One service owns the durable queue.
`, "utf8");
  writeFileSync(join(context, "component.md"), `<!-- mex:entity
id: ${TARGET}
type: component
status: promoted
revision: 1
${withGroundings ? `grounds_to:
  - node: function:1111111111111111
    fingerprint: mh:4:11111111
` : ""}
-->
## Durable queue

The queue stores work before dispatch.
`, "utf8");
  writeFileSync(join(context, "worker.md"), `<!-- mex:entity
id: ${THIRD}
type: component
status: promoted
revision: 1
${withGroundings ? `grounds_to:
  - node: function:1111111111111111
    fingerprint: mh:4:11111111
` : ""}
-->
## Queue worker

The worker dispatches durable queue entries.
`, "utf8");
  mkdirSync(join(root, ".mex", "events"), { recursive: true });
  writeFileSync(join(root, ".mex", "events", "operations.jsonl"), "", "utf8");
  return { root, firstPath };
}

function migrationProject(): {
  root: string;
  selectedPath: string;
  unselectedPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-adapter-migration-"));
  roots.push(root);
  const context = join(root, ".mex", "context");
  const patterns = join(root, ".mex", "patterns");
  const topics = join(root, ".mex", "topics");
  mkdirSync(context, { recursive: true });
  mkdirSync(patterns, { recursive: true });
  mkdirSync(topics, { recursive: true });
  const selectedPath = join(context, "architecture.md");
  const unselectedPath = join(patterns, "webhook.md");
  writeFileSync(selectedPath, `---
name: checkout-architecture
description: Legacy checkout architecture
grounds_to:
  - node: "function:1111111111111111"
    fingerprint: "mh:4:11111111"
last_updated: "2026-08-01"
---

# Checkout architecture

Persist capture attempts before calling the gateway.

## Retry path

Retry capture with the original idempotency key.
`, "utf8");
  writeFileSync(unselectedPath, `---
name: webhook-inbox
description: Legacy webhook inbox
last_updated: "2026-08-01"
---

# Webhook inbox

Persist delivery identifiers before processing.
`, "utf8");
  writeFileSync(join(topics, "payments.md"), `<!-- mex:entity
id: ${TOPIC}
type: topic
status: promoted
revision: 1
-->
## Payments

Payment capture and delivery behavior.
`, "utf8");
  mkdirSync(join(root, ".mex", "events"), { recursive: true });
  writeFileSync(join(root, ".mex", "events", "operations.jsonl"), "", "utf8");
  return { root, selectedPath, unselectedPath };
}

describe("RepositoryWikiPort", () => {
  it("reads a Team-owned mex entity but cannot preview a write to its hard-reserved path", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-wiki-adapter-team-"));
    roots.push(root);
    const workstreams = join(root, ".mex", "workstreams");
    mkdirSync(workstreams, { recursive: true });
    const sourcePath = join(workstreams, `${WORKSTREAM}.md`);
    writeFileSync(sourcePath, `<!-- mex:entity
id: ${WORKSTREAM}
type: workstream
status: in_flight
revision: 1
-->
## Release performance baseline

Coordinate the bounded release work.
`, "utf8");
    mkdirSync(join(root, ".mex", "events"), { recursive: true });
    const auditPath = join(root, ".mex", "events", "operations.jsonl");
    writeFileSync(auditPath, "", "utf8");

    const port = createRepositoryWikiPort(root, { readOnly: [] });
    await expect(port.rebuildIndex()).resolves.toMatchObject({ entitiesIndexed: 1 });
    const entity = await port.getEntity(WORKSTREAM);
    expect(entity).toMatchObject({
      ref: { id: WORKSTREAM, kind: "workstream", title: "Release performance baseline" },
      lifecycleState: "in_flight",
      body: expect.stringContaining("bounded release work"),
      location: { path: `.mex/workstreams/${WORKSTREAM}.md` },
    });
    expect((await port.listEntities({ kinds: ["workstream"] })).items.map((item) => item.ref.id))
      .toEqual([WORKSTREAM]);
    if (!entity) throw new Error("team fixture entity missing");

    const beforeSource = readFileSync(sourcePath);
    const beforeAudit = readFileSync(auditPath);
    await expectCode(() => port.previewOperations({
      operation: {
        opId: "operation_adapter_team_ownership",
        type: "update-entry",
        entityId: WORKSTREAM,
        baseRevision: entity.version.semanticRevision,
        baseContentHash: entity.version.contentHash,
        actor: { kind: "human", id: "member_adapter_test" },
        timestamp: "2026-08-27T00:00:00.000Z",
        payload: { body: "Wiki must not own this update." },
      },
      expectedRevisions: [{
        target: { kind: "entity", id: WORKSTREAM },
        version: entity.version,
      }],
    }), "PATH_OUTSIDE_PROJECT");
    expect(readFileSync(sourcePath)).toEqual(beforeSource);
    expect(readFileSync(auditPath)).toEqual(beforeAudit);
  });

  it("discovers the exact added, modified, and deleted paths for targeted refresh", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const architecture = readFileSync(target.firstPath, "utf8").replace(
      `relations:\n  - type: depends_on\n    target: ${TARGET}\n`,
      "",
    );
    writeFileSync(target.firstPath, architecture.replace("durable queue", "durable dispatch queue"), "utf8");
    rmSync(join(target.root, ".mex", "context", "component.md"));
    writeFileSync(join(target.root, ".mex", "context", "new.md"), `<!-- mex:entity
id: ${FOURTH}
type: component
status: promoted
revision: 1
-->
## New component

New bounded Wiki content.
`, "utf8");

    await expect(port.discoverRefreshPaths()).resolves.toEqual([
      ".mex/context/architecture.md",
      ".mex/context/component.md",
      ".mex/context/new.md",
    ]);
    await port.refreshFiles(await port.discoverRefreshPaths());
    await expect(port.discoverRefreshPaths()).resolves.toEqual([]);
    await expect(port.inspectIndex()).resolves.toMatchObject({ state: "fresh" });
  });

  it("keeps missing-index reads explicit and rebuilds only on request", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);

    await expectCode(() => port.getEntity(ENTITY), "INDEX_MISSING");
    expect((await port.inspectIndex()).state).toBe("missing");

    const rebuilt = await port.rebuildIndex();
    expect(rebuilt).toMatchObject({
      state: "succeeded",
      entitiesIndexed: 3,
      relationsIndexed: 1,
    });
    expect((await port.inspectIndex()).state).toBe("fresh");
    expect((await port.getEntity(ENTITY))?.location.path).toBe(".mex/context/architecture.md");
  });

  it("reports maintenance counts and revision from one revalidated read", async () => {
    const target = project();
    let reads = 0;
    let inspections = 0;
    const port = createRepositoryWikiPort(target.root, { __internal: {
      inspect() { inspections++; throw new Error("redundant inspection"); },
      read(options, callback) {
        reads++;
        return withWikiContractReadSession(options, callback);
      },
    } });
    const rebuilt = await port.rebuildIndex();
    expect(rebuilt).toMatchObject({ entitiesIndexed: 3, relationsIndexed: 1 });
    expect(rebuilt.indexedRevision).toMatch(/^[a-f0-9]{64}$/);
    await expect(port.refreshFiles([".mex/context/architecture.md"])).resolves.toMatchObject({
      entitiesIndexed: 3, relationsIndexed: 1, indexedRevision: rebuilt.indexedRevision,
    });
    expect(reads).toBe(2);
    expect(inspections).toBe(0);
  });

  it("rejects a maintenance census when canonical files change during its read", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root, { __internal: {
      read(options, callback) {
        return withWikiContractReadSession(options, (session) => {
          const result = callback(session);
          writeFileSync(target.firstPath, readFileSync(target.firstPath, "utf8") + "\nConcurrent edit.\n");
          return result;
        });
      },
    } });
    await expectCode(() => port.rebuildIndex(), "REVISION_CONFLICT");
  });

  it("reads Inbox targets only from a fresh same-session Wiki snapshot without consulting Graph", async () => {
    const target = project(true);
    await createRepositoryWikiPort(target.root).rebuildIndex();
    const before = readFileSync(target.firstPath);
    const indexBefore = readFileSync(join(target.root, ".mex", "wiki.db"));
    let reads = 0;
    const port = createRepositoryWikiPort(target.root, {
      groundingBridge: { async withFreshGroundingSnapshot() { throw new Error("Inbox target lookup must not consult Graph."); } },
      __internal: {
        read(options, callback) {
          reads += 1;
          return withWikiContractReadSession(options, callback);
        },
      },
    });
    await expect(port.readInboxTarget(ENTITY)).resolves.toMatchObject({
      ref: { id: ENTITY }, body: expect.stringContaining("One service owns"),
      sources: [{ type: "manual", note: "Maintainer review" }],
      version: { semanticRevision: 1, contentHash: hash(before) },
    });
    expect(reads).toBe(1);
    await expect(port.readInboxTarget(TARGET)).resolves.toMatchObject({ groundingHealth: "unverified" });
    await expect(port.readInboxTarget(FOURTH)).resolves.toBeNull();
    expect(readFileSync(target.firstPath)).toEqual(before);
    expect(readFileSync(join(target.root, ".mex", "wiki.db"))).toEqual(indexBefore);

    writeFileSync(target.firstPath, Buffer.concat([before, Buffer.from("\nConcurrent edit.\n")]));
    await expectCode(() => port.readInboxTarget(ENTITY), "INDEX_STALE");
    writeFileSync(target.firstPath, before);
    const racing = createRepositoryWikiPort(target.root, {
      __internal: {
        read(options, callback) {
          return withWikiContractReadSession(options, (session) => {
            const result = callback(session);
            writeFileSync(target.firstPath, Buffer.concat([before, Buffer.from("\nChanged after projection.\n")]));
            return result;
          });
        },
      },
    });
    await expectCode(() => racing.readInboxTarget(ENTITY), "REVISION_CONFLICT");
    expect(readFileSync(join(target.root, ".mex", "wiki.db"))).toEqual(indexBefore);
  });

  it("projects exact file-byte revisions and revision-bound pages", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();

    const entity = await port.getEntity(ENTITY);
    expect(entity?.version.contentHash).toBe(hash(readFileSync(target.firstPath)));
    const first = await port.listEntities({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    writeFileSync(target.firstPath, readFileSync(target.firstPath, "utf8").replace("One service", "Two services"), "utf8");
    expect((await port.inspectIndex()).state).toBe("stale");
    await port.refreshFiles([".mex/context/architecture.md"]);
    await expectCode(
      () => port.listEntities({ limit: 1, cursor: first.nextCursor! }),
      "REVISION_CONFLICT",
    );
  });

  it("validates revisions from bounded canonical bytes and rejects duplicate claimants", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const entity = await port.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    const auditPath = join(target.root, ".mex", "events", "operations.jsonl");
    const indexBefore = readFileSync(join(target.root, ".mex", "wiki.db"));
    const auditBefore = readFileSync(auditPath);
    await expect(port.validateCurrentRevisionExpectations([
      { target: { kind: "entity", id: ENTITY }, version: entity.version },
      { target: { kind: "entity", id: FOURTH }, version: null },
      {
        target: { kind: "artifact", path: ".mex/context/worker.md" },
        contentHash: hash(readFileSync(join(target.root, ".mex", "context", "worker.md"))),
      },
    ])).resolves.toBeUndefined();
    expect(readFileSync(join(target.root, ".mex", "wiki.db"))).toEqual(indexBefore);
    expect(readFileSync(auditPath)).toEqual(auditBefore);

    writeFileSync(
      target.firstPath,
      readFileSync(target.firstPath, "utf8").replace("One service owns", "Two services own"),
      "utf8",
    );
    await expectCode(() => port.validateCurrentRevisionExpectations([
      { target: { kind: "entity", id: ENTITY }, version: entity.version },
    ]), "REVISION_CONFLICT");

    const duplicatePath = join(target.root, ".mex", "context", "duplicate.md");
    writeFileSync(duplicatePath, readFileSync(target.firstPath), "utf8");
    await expectCode(() => port.validateCurrentRevisionExpectations([
      {
        target: { kind: "entity", id: ENTITY },
        version: {
          semanticRevision: entity.version.semanticRevision,
          contentHash: hash(readFileSync(target.firstPath)),
        },
      },
    ]), "REVISION_CONFLICT");
    expect(readFileSync(join(target.root, ".mex", "wiki.db"))).toEqual(indexBefore);
    expect(readFileSync(auditPath)).toEqual(auditBefore);
  });

  it("bounds and post-read stabilizes direct artifact revision observations", async () => {
    const target = project();
    const oversizedPath = join(target.root, ".mex", "context", "oversized.md");
    writeFileSync(oversizedPath, "", "utf8");
    truncateSync(oversizedPath, WIKI_CORPUS_LIMITS.maxFileBytes + 1);
    const bounded = createRepositoryWikiPort(target.root);
    await expectCode(() => bounded.validateCurrentRevisionExpectations([{
      target: { kind: "artifact", path: ".mex/context/oversized.md" },
      contentHash: "0".repeat(64),
    }]), "REVISION_CONFLICT");

    const auditPath = join(target.root, ".mex", "events", "operations.jsonl");
    truncateSync(auditPath, OPERATION_LOG_MAX_BYTES + 1);
    await expectCode(() => bounded.validateCurrentRevisionExpectations([{
      target: { kind: "artifact", path: ".mex/events/operations.jsonl" },
      contentHash: "0".repeat(64),
    }]), "REVISION_CONFLICT");

    await expect(bounded.validateCurrentRevisionExpectations([{
      target: { kind: "artifact", path: ".mex/context/absent.md" },
      contentHash: null,
    }])).resolves.toBeUndefined();
    if (process.platform !== "win32") {
      symlinkSync("missing-target.md", join(target.root, ".mex", "context", "dangling.md"));
      await expectCode(() => bounded.validateCurrentRevisionExpectations([{
        target: { kind: "artifact", path: ".mex/context/dangling.md" },
        contentHash: null,
      }]), "REVISION_CONFLICT");
    }

    const workerPath = join(target.root, ".mex", "context", "worker.md");
    const expected = hash(readFileSync(workerPath));
    const failing = createRepositoryWikiPort(target.root, {
      __internal: {
        onCurrentRevisionArtifactRead: () => { throw new Error("injected read failure"); },
      },
    });
    await expectCode(() => failing.validateCurrentRevisionExpectations([{
      target: { kind: "artifact", path: ".mex/context/worker.md" },
      contentHash: null,
    }]), "REVISION_CONFLICT");
    let raced = false;
    const racing = createRepositoryWikiPort(target.root, {
      __internal: {
        onCurrentRevisionArtifactRead: (path) => {
          if (raced || path !== "context/worker.md") return;
          raced = true;
          writeFileSync(workerPath, `${readFileSync(workerPath, "utf8")}\nConcurrent edit.\n`, "utf8");
        },
      },
    });
    await expectCode(() => racing.validateCurrentRevisionExpectations([{
      target: { kind: "artifact", path: ".mex/context/worker.md" },
      contentHash: expected,
    }]), "REVISION_CONFLICT");
    expect(raced).toBe(true);
  });

  it("fails closed when canonical claimant discovery is incomplete", async () => {
    if (process.platform === "win32") return;
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const entity = await port.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    symlinkSync("missing-claimant.md", join(target.root, ".mex", "context", "broken.md"));

    await expectCode(() => port.validateCurrentRevisionExpectations([{
      target: { kind: "entity", id: ENTITY },
      version: entity.version,
    }]), "REVISION_CONFLICT");
  });

  it("re-attests duplicate claimant ownership inside the Wiki apply boundary", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const entity = await port.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_apply_duplicate",
        type: "update-entry",
        entityId: ENTITY,
        baseRevision: entity.version.semanticRevision,
        baseContentHash: entity.version.contentHash,
        actor: { kind: "human", id: "member_adapter_test" },
        timestamp: "2026-08-27T04:00:00.000Z",
        payload: { summary: "This must not land in an ambiguous corpus." },
      },
      expectedRevisions: [{ target: { kind: "entity", id: ENTITY }, version: entity.version }],
    };
    const preview = await port.previewOperations(request);
    if (!preview.plan.valid) throw new Error("expected a valid preview");
    const auditPath = join(target.root, ".mex", "events", "operations.jsonl");
    const original = readFileSync(target.firstPath, "utf8");
    writeFileSync(join(target.root, ".mex", "context", "z-duplicate.md"), original, "utf8");
    const auditBefore = readFileSync(auditPath);

    await expectCode(() => port.applyOperations({
      ...request,
      plan: preview.plan,
      expectedPreviewRevision: preview.previewRevision,
    }), "REVISION_CONFLICT");
    expect(readFileSync(target.firstPath, "utf8")).toBe(original);
    expect(readFileSync(auditPath)).toEqual(auditBefore);
  });

  it("keeps an ordinary stale preview invalid when no durable recovery prefix exists", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const entity = await port.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_ordinary_stale",
        type: "update-entry",
        entityId: ENTITY,
        baseRevision: entity.version.semanticRevision,
        baseContentHash: entity.version.contentHash,
        actor: { kind: "human", id: "member_adapter_test" },
        timestamp: "2026-08-27T00:30:00.000Z",
        payload: { summary: "This stale request must not become recovery." },
      },
      expectedRevisions: [{ target: { kind: "entity", id: ENTITY }, version: entity.version }],
    };
    writeFileSync(target.firstPath, `${readFileSync(target.firstPath, "utf8")}\nConcurrent manual edit.\n`, "utf8");
    const before = [
      readFileSync(target.firstPath),
      readFileSync(join(target.root, ".mex", "events", "operations.jsonl")),
      readFileSync(join(target.root, ".mex", "wiki.db")),
    ];
    expect(port.inspectOperationRecovery(request).state).toBe("none");
    const preview = await port.previewOperations(request);
    expect(preview.valid).toBe(false);
    expect(preview.recoveryManifest).toBeUndefined();
    expect([
      readFileSync(target.firstPath),
      readFileSync(join(target.root, ".mex", "events", "operations.jsonl")),
      readFileSync(join(target.root, ".mex", "wiki.db")),
    ]).toEqual(before);
  });

  it("previews exact canonical and audit bytes, then applies that plan", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const entity = await port.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_update",
        type: "update-entry",
        entityId: ENTITY,
        baseRevision: entity.version.semanticRevision,
        baseContentHash: entity.version.contentHash,
        actor: { kind: "human", id: "member_adapter_test" },
        reason: "Exercise the application adapter.",
        timestamp: "2026-08-26T00:00:00.000Z",
        payload: { body: "Two services share the durable queue." },
      },
      expectedRevisions: [{
        target: { kind: "entity", id: ENTITY },
        version: entity.version,
      }],
    };

    const before = readFileSync(target.firstPath, "utf8");
    const preview = await port.previewOperations(request);
    expect(preview.valid).toBe(true);
    expect(preview.changes.map((change) => change.path)).toEqual([
      ".mex/context/architecture.md",
      ".mex/events/operations.jsonl",
    ]);
    expect(readFileSync(target.firstPath, "utf8")).toBe(before);

    if (!preview.plan.valid) throw new Error("expected a valid adapter plan");
    const forgedPlan = {
      ...preview.plan,
      handle: "0".repeat(64),
    };
    await expectCode(() => port.applyOperations({
      ...request,
      plan: forgedPlan,
      expectedPreviewRevision: hashCanonical({
        v: forgedPlan.v,
        requestHash: forgedPlan.requestHash,
        handle: forgedPlan.handle,
      }),
    }), "VALIDATION_FAILED");
    expect(readFileSync(target.firstPath, "utf8")).toBe(before);

    const applied = await port.applyOperations({
      ...request,
      plan: preview.plan,
      expectedPreviewRevision: preview.previewRevision,
    });
    expect(applied).toMatchObject({ applied: true, idempotentReplay: false });
    expect((await port.getEntity(ENTITY))?.body).toContain("Two services share");
    expect(readFileSync(join(target.root, ".mex", "events", "operations.jsonl"), "utf8"))
      .not.toContain("Two services share");

    const replay = await port.applyOperations({
      ...request,
      plan: preview.plan,
      expectedPreviewRevision: preview.previewRevision,
    });
    expect(replay.idempotentReplay).toBe(true);
  });

  it("attests an ordered Spec endpoint set under one fresh immutable Wiki view", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();

    const emptyView = await port.readExactEntityAttestations([]);
    expect(emptyView.indexedRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(emptyView.entities).toEqual([]);
    const view = await port.readExactEntityAttestations([TARGET, FOURTH, ENTITY]);
    expect(view.indexedRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(view.entities.map((entry) => entry.id)).toEqual([TARGET, FOURTH, ENTITY]);
    expect(view.entities[0]?.entity).toMatchObject({
      ref: { id: TARGET, kind: "component", title: "Durable queue" },
      version: { semanticRevision: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
    expect(view.entities[1]?.entity).toBeNull();
    expect(view.entities[2]?.entity?.ref).toMatchObject({ id: ENTITY, kind: "architecture" });

    await expectCode(() => port.readExactEntityAttestations([ENTITY, ENTITY]), "INVALID_REQUEST");
    await expectCode(() => port.readExactEntityAttestations([WORKSTREAM]), "INVALID_REQUEST");

    writeFileSync(target.firstPath, `${readFileSync(target.firstPath, "utf8")}\nManual drift.\n`, "utf8");
    await expectCode(() => port.readExactEntityAttestations([ENTITY]), "INDEX_STALE");
  });

  it("rejects an indexed mx entity whose canonical source is Team-owned", async () => {
    const target = project();
    const inbox = join(target.root, ".mex", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "claimed-spec.md"), `<!-- mex:entity
id: ${FOURTH}
type: spec
status: in_flight
revision: 1
-->
## Team-owned claimant

Inbox bytes cannot become an exact Wiki authoring source.
`, "utf8");
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();

    await expectCode(
      () => port.readExactEntityAttestations([FOURTH]),
      "REVISION_CONFLICT",
    );
  });

  it("rejects a structurally valid entity row that differs from current source bytes", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const db = openSqlite(join(target.root, ".mex", "wiki.db"));
    try {
      db.prepare("UPDATE wiki_entities SET title = ? WHERE id = ?")
        .run("Forged indexed title", ENTITY);
    } finally {
      db.close();
    }
    expect((await port.inspectIndex()).state).toBe("fresh");
    await expectCode(
      () => port.readExactEntityAttestations([ENTITY]),
      "REVISION_CONFLICT",
    );
  });

  it.each([
    {
      column: "entity_key",
      value: "context/component.md#0000009999",
    },
    {
      column: "metadata_kind",
      value: "frontmatter",
    },
    {
      column: "provenance",
      value: '{"createdBy":{"id":"member_forged","kind":"system"}}',
    },
    {
      column: "metadata",
      value: '{"forged":true}',
    },
  ] as const)("rejects a structurally valid forged $column entity-row field", async ({
    column,
    value,
  }) => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const db = openSqlite(join(target.root, ".mex", "wiki.db"));
    try {
      db.prepare(`UPDATE wiki_entities SET ${column} = ? WHERE id = ?`)
        .run(value, TARGET);
    } finally {
      db.close();
    }
    expect((await port.inspectIndex()).state).toBe("fresh");
    await expectCode(
      () => port.readExactEntityAttestations([TARGET]),
      "REVISION_CONFLICT",
    );
  });

  it("ignores only Team-owned publication drift during exact authoring attestation", async () => {
    const target = project();
    const inbox = join(target.root, ".mex", "inbox");
    const activity = join(target.root, ".mex", "events", "activity", "2026-08");
    mkdirSync(inbox, { recursive: true });
    mkdirSync(activity, { recursive: true });
    const proposalPath = join(inbox, "proposal_01K4FAM7W8N9R3T5Y6Q2ZBCHJK.md");
    const activityPath = join(activity, "activity_01K4FAM7W8N9R3T5Y6Q2ZBCHJM.md");
    writeFileSync(proposalPath, "# Governed Spec proposal\n\nDraft.\n", "utf8");
    writeFileSync(activityPath, "# Proposal drafted\n\nThe draft was saved.\n", "utf8");
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();

    writeFileSync(proposalPath, "# Governed Spec proposal\n\nPending review.\n", "utf8");
    writeFileSync(
      activityPath,
      "# Proposal published\n\nThe canonical proposal was published.\n",
      "utf8",
    );
    writeFileSync(
      join(inbox, "proposal_01K4FAM7W8N9R3T5Y6Q2ZBCHJN.md"),
      "# Second governed proposal\n\nNew Team-owned publication.\n",
      "utf8",
    );

    expect((await port.inspectIndex()).state).toBe("stale");
    await expect(port.readExactEntityAttestations([])).resolves.toMatchObject({ entities: [] });
    await expect(port.readExactEntityAttestations([ENTITY, TARGET])).resolves.toMatchObject({
      entities: [
        { id: ENTITY, entity: { ref: { id: ENTITY } } },
        { id: TARGET, entity: { ref: { id: TARGET } } },
      ],
    });

    const unrelatedPath = join(target.root, ".mex", "context", "worker.md");
    const unrelatedBytes = readFileSync(unrelatedPath, "utf8");
    writeFileSync(unrelatedPath, `${unrelatedBytes}\nUnrelated Wiki drift.\n`, "utf8");
    await expectCode(() => port.readExactEntityAttestations([]), "INDEX_STALE");

    writeFileSync(unrelatedPath, unrelatedBytes, "utf8");
    const addedWikiPath = join(target.root, ".mex", "context", "unindexed.md");
    writeFileSync(addedWikiPath, "# Unindexed Wiki-owned source\n", "utf8");
    await expectCode(() => port.readExactEntityAttestations([ENTITY]), "INDEX_STALE");
    rmSync(addedWikiPath);

    rmSync(unrelatedPath);
    await expectCode(() => port.readExactEntityAttestations([ENTITY]), "INDEX_STALE");
    writeFileSync(unrelatedPath, unrelatedBytes, "utf8");

    await expect(port.readExactEntityAttestations([ENTITY])).resolves.toMatchObject({
      entities: [{ id: ENTITY, entity: { ref: { id: ENTITY } } }],
    });
    writeFileSync(target.firstPath, `${readFileSync(target.firstPath, "utf8")}\nRequested Wiki drift.\n`, "utf8");
    await expectCode(() => port.readExactEntityAttestations([ENTITY]), "INDEX_STALE");
  });

  it("does not launder a degraded Wiki-owned diagnostic through later Team drift", async () => {
    const target = project();
    const componentPath = join(target.root, ".mex", "context", "component.md");
    writeFileSync(
      componentPath,
      readFileSync(componentPath, "utf8").replace(
        "revision: 1\n",
        `revision: 1
relations:
  - type: depends_on
    target: ${FOURTH}
`,
      ),
      "utf8",
    );
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    expect((await port.inspectIndex()).state).toBe("degraded");

    const inbox = join(target.root, ".mex", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, "proposal_01K4FAM7W8N9R3T5Y6Q2ZBCHJR.md"),
      "# Team publication after degraded Wiki index\n",
      "utf8",
    );
    expect((await port.inspectIndex()).state).toBe("stale");
    await expectCode(
      () => port.readExactEntityAttestations([TARGET]),
      "INDEX_STALE",
    );
  });

  it("previews one governed update across Team-only drift while keeping public preview behavior", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const entity = await port.getEntity(ENTITY);
    if (entity === null) throw new Error("fixture entity missing");
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_exact_authoring_update",
        type: "update-entry",
        entityId: ENTITY,
        baseRevision: entity.version.semanticRevision,
        baseContentHash: entity.version.contentHash,
        actor: { kind: "human", id: "member_adapter_reviewer" },
        reason: "Apply one reviewed governed Spec update.",
        timestamp: "2026-08-28T06:00:00.000Z",
        payload: { body: "The governed update keeps exact Wiki authority." },
      },
      expectedRevisions: [{
        target: { kind: "entity", id: ENTITY },
        version: entity.version,
      }],
    };

    const inbox = join(target.root, ".mex", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, "proposal_01K4FAM7W8N9R3T5Y6Q2ZBCHJP.md"),
      "# Published proposal\n\nTeam-owned bytes advanced after Wiki indexing.\n",
      "utf8",
    );
    await expect(port.previewOperations(request)).resolves.toMatchObject({ valid: true });

    const preview = await port.previewAuthoringOperations(request);
    expect(preview.valid).toBe(true);
    expect(preview.affectedEntities).toEqual([{
      id: ENTITY,
      kind: "architecture",
      title: "Architecture",
    }]);

    const proposalPath = join(inbox, "proposal_01K4FAM7W8N9R3T5Y6Q2ZBCHJP.md");
    const proposalBytes = readFileSync(proposalPath, "utf8");
    writeFileSync(
      proposalPath,
      readFileSync(target.firstPath, "utf8").replace(ENTITY, FOURTH),
      "utf8",
    );
    await expect(port.readExactEntityAttestations([ENTITY])).resolves.toMatchObject({
      entities: [{ id: ENTITY, entity: { ref: { id: ENTITY } } }],
    });
    writeFileSync(proposalPath, readFileSync(target.firstPath, "utf8"), "utf8");
    await expectCode(
      () => port.readExactEntityAttestations([ENTITY]),
      "REVISION_CONFLICT",
    );
    const duplicatePreview = await port.previewAuthoringOperations(request);
    expect(duplicatePreview.valid).toBe(true);
    if (!duplicatePreview.plan.valid) throw new Error("expected a structurally valid duplicate-claim preview");
    await expectCode(() => port.applyOperations({
      ...request,
      plan: duplicatePreview.plan,
      expectedPreviewRevision: duplicatePreview.previewRevision,
    }), "REVISION_CONFLICT");
    writeFileSync(proposalPath, proposalBytes, "utf8");

    writeFileSync(
      join(target.root, ".mex", "context", "unrelated.md"),
      "# Unreviewed Wiki-owned source\n",
      "utf8",
    );
    await expectCode(() => port.previewAuthoringOperations(request), "INDEX_STALE");
  });

  it("keeps exact authoring reads bound to containment, root identity, and index identity", async () => {
    if (process.platform === "win32") return;

    const unsafe = project();
    const unsafePort = createRepositoryWikiPort(unsafe.root);
    await unsafePort.rebuildIndex();
    const outside = mkdtempSync(join(tmpdir(), "mex-wiki-authoring-outside-"));
    roots.push(outside);
    const inbox = join(unsafe.root, ".mex", "inbox");
    mkdirSync(inbox, { recursive: true });
    const outsidePath = join(outside, "escaped.md");
    writeFileSync(outsidePath, "# Escaped Team source\n", "utf8");
    symlinkSync(outsidePath, join(inbox, "escaped.md"));
    await expectCode(
      () => unsafePort.readExactEntityAttestations([ENTITY]),
      "PATH_OUTSIDE_PROJECT",
    );

    const swappedRoot = project();
    const rootPort = createRepositoryWikiPort(swappedRoot.root);
    await rootPort.rebuildIndex();
    renameSync(join(swappedRoot.root, ".mex"), join(swappedRoot.root, ".mex-original"));
    mkdirSync(join(swappedRoot.root, ".mex"));
    await expectCode(
      () => rootPort.readExactEntityAttestations([ENTITY]),
      "PATH_OUTSIDE_PROJECT",
    );

    const swappedIndex = project();
    await createRepositoryWikiPort(swappedIndex.root).rebuildIndex();
    const indexPath = join(swappedIndex.root, ".mex", "wiki.db");
    const previousPath = join(swappedIndex.root, ".mex", "wiki-previous.db");
    const indexBytes = readFileSync(indexPath);
    let armed = true;
    const indexPort = createRepositoryWikiPort(swappedIndex.root, {
      __internal: {
        read(options, callback) {
          return withWikiContractReadSession({
            ...options,
            hooks: {
              afterInitialIndexBind() {
                if (!armed) return;
                armed = false;
                renameSync(indexPath, previousPath);
                writeFileSync(indexPath, indexBytes);
              },
            },
          }, callback);
        },
      },
    });
    await expectCode(
      () => indexPort.readExactEntityAttestations([ENTITY]),
      "REVISION_CONFLICT",
    );
  });

  it("retains appended approval sources in a normalized authoring update and its replay", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const entity = await port.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    const source = {
      type: "document", ref: ".mex/inbox/proposal_reviewed.md",
      note: "Accepted rationale.\n\nPreserve this evidence.",
      metadata: { proposalId: "proposal_reviewed", approvedBy: { kind: "human", id: "reviewer" } },
    };
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_append_approval", type: "update-entry", entityId: ENTITY,
        baseRevision: entity.version.semanticRevision, baseContentHash: entity.version.contentHash,
        actor: { kind: "human", id: "reviewer" }, timestamp: "2026-08-28T06:00:00.000Z",
        payload: { operations: [{ type: "update-entry", entityId: ENTITY, summary: "Approved correction.", appendSources: [source] }] },
      },
      expectedRevisions: [{ target: { kind: "entity", id: ENTITY }, version: entity.version }],
    };
    const before = readFileSync(target.firstPath);
    const preview = await port.previewAuthoringOperations(request);
    expect(preview.valid).toBe(true);
    expect(readFileSync(target.firstPath)).toEqual(before);
    if (!preview.plan.valid) throw new Error("expected a valid authoring plan");
    const apply = { ...request, plan: preview.plan, expectedPreviewRevision: preview.previewRevision };
    await expect(port.applyOperations(apply)).resolves.toMatchObject({ applied: true, idempotentReplay: false });
    const updated = await port.getEntity(ENTITY);
    expect(updated?.sources).toEqual([...entity.sources, source]);
    expect(updated?.version.semanticRevision).toBe(entity.version.semanticRevision + 1);
    const after = readFileSync(target.firstPath);
    await expect(port.applyOperations(apply)).resolves.toMatchObject({ applied: true, idempotentReplay: true });
    expect(readFileSync(target.firstPath)).toEqual(after);
  });

  it("forces and reports exactly one receipt-pinned create ID", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const sourcePath = `.mex/specs/${FOURTH}.md` as const;
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_forced_spec_create",
        type: "create-entry",
        actor: { kind: "human", id: "member_adapter_test" },
        reason: "Apply the reviewed governed Spec proposal.",
        timestamp: "2026-08-27T05:00:00.000Z",
        payload: {
          file: `specs/${FOURTH}.md`,
          insertAt: { at: "end-of-file" },
          type: "spec",
          status: "in_flight",
          title: "Pin cross-process create identity",
          summary: "Use the receipt-minted entity identity.",
          body: "A fresh process must reproduce the exact reviewed Spec ID.",
          headingDepth: 2,
        },
      },
      expectedRevisions: [{ target: { kind: "artifact", path: sourcePath }, contentHash: null }],
    };

    const inbox = join(target.root, ".mex", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, "proposal_01K4FAM7W8N9R3T5Y6Q2ZBCHJQ.md"),
      "# Published create proposal\n\nTeam-owned bytes advanced after Wiki indexing.\n",
      "utf8",
    );
    await expect(port.previewOperations(request)).resolves.toMatchObject({ valid: true });

    const preview = await port.previewOperationsWithCreatedIds(request, [FOURTH]);
    expect(preview.valid).toBe(true);
    expect(preview.affectedEntities).toEqual([{
      id: FOURTH,
      kind: "spec",
      title: "Pin cross-process create identity",
    }]);
    expect(preview.recoveryManifest?.items).toHaveLength(1);
    expect(preview.recoveryManifest?.items[0]?.createdIds).toEqual([FOURTH]);
    expect(preview.changes.find((change) => change.path === sourcePath)?.diff).toContain(FOURTH);

    await expectCode(() => port.previewOperationsWithCreatedIds(request, []), "VALIDATION_FAILED");
    await expectCode(
      () => port.previewOperationsWithCreatedIds(request, [FOURTH, TARGET]),
      "VALIDATION_FAILED",
    );
    await expectCode(() => port.previewOperationsWithCreatedIds({
      ...request,
      operation: {
        ...request.operation,
        payload: { operations: [{ type: "create-entry", payload: request.operation.payload }] },
      },
    }, [FOURTH]), "VALIDATION_FAILED");

    if (!preview.plan.valid) throw new Error("expected a valid forced-ID preview");
    const applied = await port.applyOperations({
      ...request,
      plan: preview.plan,
      expectedPreviewRevision: preview.previewRevision,
    });
    expect(applied.resultingVersions[FOURTH]).toMatchObject({ semanticRevision: 1 });
    expect(readFileSync(join(target.root, ...sourcePath.split("/")), "utf8")).toContain(FOURTH);
    expect((await port.readExactEntityAttestations([FOURTH])).entities[0]?.entity?.ref)
      .toEqual({
        id: FOURTH,
        kind: "spec",
        title: "Pin cross-process create identity",
      });
  });

  it("re-previews an exact interrupted multi-file move without writing or accepting changed authority", async () => {
    const target = project();
    let crash = true;
    const crashing = createRepositoryWikiPort(target.root, {
      __internal: {
        onOperationFileWritten: () => {
          if (!crash) return;
          crash = false;
          throw new Error("simulated process death");
        },
      },
    });
    await crashing.rebuildIndex();
    const entity = await crashing.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    const destinationPath = join(target.root, ".mex", "context", "worker.md");
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_resume_move",
        type: "move-entry",
        entityId: ENTITY,
        baseRevision: entity.version.semanticRevision,
        baseContentHash: entity.version.contentHash,
        actor: { kind: "agent", id: "agent_adapter_test", sessionId: "session_adapter_test" },
        reason: "Resume the exact reviewed move.",
        timestamp: "2026-08-27T01:00:00.000Z",
        payload: { file: "context/worker.md", insertAt: { at: "end-of-file" } },
      },
      expectedRevisions: [
        { target: { kind: "entity", id: ENTITY }, version: entity.version },
        {
          target: { kind: "artifact", path: ".mex/context/worker.md" },
          contentHash: hash(readFileSync(destinationPath)),
        },
      ],
    };
    const reviewed = await crashing.previewOperations(request);
    if (!reviewed.plan.valid || reviewed.recoveryManifest === undefined) {
      throw new Error("expected a valid recovery-bound preview");
    }
    await expect(crashing.applyOperations({
      ...request,
      plan: reviewed.plan,
      expectedPreviewRevision: reviewed.previewRevision,
    })).rejects.toThrow();

    expect(readFileSync(destinationPath, "utf8")).toContain(ENTITY);
    expect(readFileSync(target.firstPath, "utf8")).toContain(ENTITY);
    const resumedPort = createRepositoryWikiPort(target.root);
    expect(resumedPort.inspectOperationRecovery(request)).toEqual({
      schemaVersion: 1,
      state: "prefix",
      operationIds: [request.operation.opId],
      completedOperationIds: [],
      activeOperationId: request.operation.opId,
    });
    const partialBytes = [
      readFileSync(target.firstPath),
      readFileSync(destinationPath),
      readFileSync(join(target.root, ".mex", "events", "operations.jsonl")),
      readFileSync(join(target.root, ".mex", "wiki.db")),
    ];
    const mismatches: WikiOperationRequest<RepositoryWikiOperationPayload>[] = [
      {
        ...request,
        operation: { ...request.operation, payload: { file: "context/worker.md", insertAt: { at: "start-of-file" } } },
      },
      {
        ...request,
        operation: { ...request.operation, actor: { kind: "agent", id: "different_agent" } },
      },
      {
        ...request,
        operation: { ...request.operation, timestamp: "2026-08-27T01:00:01.000Z" },
      },
      {
        ...request,
        operation: { ...request.operation, reason: "Different reason." },
      },
      {
        ...request,
        operation: { ...request.operation, opId: "operation_adapter_resume_move_changed" },
      },
    ];
    for (const mismatch of mismatches) {
      await expectCode(
        () => resumedPort.resumeOperations(mismatch, reviewed.recoveryManifest!),
        "VALIDATION_FAILED",
      );
      expect([
        readFileSync(target.firstPath),
        readFileSync(destinationPath),
        readFileSync(join(target.root, ".mex", "events", "operations.jsonl")),
        readFileSync(join(target.root, ".mex", "wiki.db")),
      ]).toEqual(partialBytes);
    }

    const resumed = await resumedPort.resumeOperations(request, reviewed.recoveryManifest);
    expect(resumed.recoveryManifest).toEqual(reviewed.recoveryManifest);
    expect([
      readFileSync(target.firstPath),
      readFileSync(destinationPath),
      readFileSync(join(target.root, ".mex", "events", "operations.jsonl")),
      readFileSync(join(target.root, ".mex", "wiki.db")),
    ]).toEqual(partialBytes);
    if (!resumed.plan.valid) throw new Error("expected a valid resumed plan");
    await resumedPort.applyOperations({
      ...request,
      plan: resumed.plan,
      expectedPreviewRevision: resumed.previewRevision,
    });
    expect(readFileSync(target.firstPath, "utf8")).not.toContain(ENTITY);
    expect(readFileSync(destinationPath, "utf8").split(ENTITY)).toHaveLength(2);
    expect(resumedPort.inspectOperationRecovery(request).state).toBe("complete");
  });

  it("completes a fully published child from manifest hashes without applying it twice", async () => {
    const target = project();
    const crashing = createRepositoryWikiPort(target.root, {
      __internal: { onOperationFileWritten: () => { throw new Error("death before completion audit"); } },
    });
    await crashing.rebuildIndex();
    const entity = await crashing.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_settled_intent",
        type: "update-entry",
        entityId: ENTITY,
        baseRevision: entity.version.semanticRevision,
        baseContentHash: entity.version.contentHash,
        actor: { kind: "human", id: "member_adapter_test" },
        timestamp: "2026-08-27T01:30:00.000Z",
        payload: { summary: "Published exactly once before recovery." },
      },
      expectedRevisions: [{ target: { kind: "entity", id: ENTITY }, version: entity.version }],
    };
    const reviewed = await crashing.previewOperations(request);
    if (!reviewed.plan.valid || reviewed.recoveryManifest === undefined) throw new Error("expected valid preview");
    await expect(crashing.applyOperations({
      ...request,
      plan: reviewed.plan,
      expectedPreviewRevision: reviewed.previewRevision,
    })).rejects.toThrow();
    const published = readFileSync(target.firstPath, "utf8");
    expect(published).toContain("Published exactly once before recovery.");
    const resumedPort = createRepositoryWikiPort(target.root);
    const resumed = await resumedPort.resumeOperations(request, reviewed.recoveryManifest);
    if (!resumed.plan.valid) throw new Error("expected valid settled-intent recovery");
    await resumedPort.applyOperations({
      ...request,
      plan: resumed.plan,
      expectedPreviewRevision: resumed.previewRevision,
    });
    expect(readFileSync(target.firstPath, "utf8")).toBe(published);
    expect(resumedPort.inspectOperationRecovery(request).state).toBe("complete");
  });

  it("resumes a cross-file supersede after only its replacement was published", async () => {
    const target = project();
    let crash = true;
    const crashing = createRepositoryWikiPort(target.root, {
      __internal: {
        onOperationFileWritten: () => {
          if (!crash) return;
          crash = false;
          throw new Error("death after supersede replacement");
        },
      },
    });
    await crashing.rebuildIndex();
    const entity = await crashing.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    const destinationPath = join(target.root, ".mex", "context", "worker.md");
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_resume_supersede",
        type: "supersede-entry",
        entityId: ENTITY,
        baseRevision: entity.version.semanticRevision,
        baseContentHash: entity.version.contentHash,
        actor: { kind: "human", id: "member_adapter_test" },
        reason: "Resume the source deprecation without recreating the replacement.",
        timestamp: "2026-08-27T01:45:00.000Z",
        payload: {
          replacement: {
            file: "context/worker.md",
            insertAt: { at: "end-of-file" },
            type: "decision",
            title: "Use bounded recovery manifests",
            body: "Persist ids, paths, revisions, hashes, and audit state only.",
            headingDepth: 2,
          },
        },
      },
      expectedRevisions: [
        { target: { kind: "entity", id: ENTITY }, version: entity.version },
        {
          target: { kind: "artifact", path: ".mex/context/worker.md" },
          contentHash: hash(readFileSync(destinationPath)),
        },
      ],
    };
    const reviewed = await crashing.previewOperations(request);
    if (!reviewed.plan.valid || reviewed.recoveryManifest === undefined) throw new Error("expected valid preview");
    const replacementId = reviewed.recoveryManifest.items[0]?.createdIds[0];
    expect(replacementId).toMatch(/^mx_/);
    await expect(crashing.applyOperations({
      ...request,
      plan: reviewed.plan,
      expectedPreviewRevision: reviewed.previewRevision,
    })).rejects.toThrow();
    expect(readFileSync(destinationPath, "utf8")).toContain(replacementId);
    expect(readFileSync(target.firstPath, "utf8")).not.toContain("status: deprecated");

    const resumedPort = createRepositoryWikiPort(target.root);
    const resumed = await resumedPort.resumeOperations(request, reviewed.recoveryManifest);
    if (!resumed.plan.valid) throw new Error("expected valid cross-file supersede recovery");
    await resumedPort.applyOperations({
      ...request,
      plan: resumed.plan,
      expectedPreviewRevision: resumed.previewRevision,
    });
    expect(readFileSync(destinationPath, "utf8").split(replacementId!)).toHaveLength(2);
    expect(readFileSync(target.firstPath, "utf8")).toContain("status: deprecated");
    expect(resumedPort.inspectOperationRecovery(request).state).toBe("complete");
  });

  it("retains future create ids across a crash after a completed batch prefix", async () => {
    const target = project();
    const firstOperationId = "operation_adapter_prefix_ids_item_01";
    const crashing = createRepositoryWikiPort(target.root, {
      __internal: {
        onOperationCompleted: (operationId) => {
          if (operationId === firstOperationId) throw new Error("process died between batch children");
        },
      },
    });
    await crashing.rebuildIndex();
    const entity = await crashing.getEntity(ENTITY);
    if (!entity) throw new Error("fixture entity missing");
    const destinationPath = join(target.root, ".mex", "context", "worker.md");
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_prefix_ids",
        type: "update-entry",
        entityId: ENTITY,
        baseRevision: entity.version.semanticRevision,
        baseContentHash: entity.version.contentHash,
        actor: { kind: "human", id: "member_adapter_test" },
        reason: "Prove future ids survive a restart.",
        timestamp: "2026-08-27T02:00:00.000Z",
        payload: {
          operations: [
            { type: "update-entry", entityId: ENTITY, summary: "Durable completed prefix." },
            {
              type: "create-entry",
              payload: {
                file: "context/worker.md",
                insertAt: { at: "end-of-file" },
                type: "convention",
                title: "Keep generated ids stable",
                body: "Persist body-free recovery metadata before apply.",
                headingDepth: 2,
              },
            },
          ],
        },
      },
      expectedRevisions: [
        { target: { kind: "entity", id: ENTITY }, version: entity.version },
        {
          target: { kind: "artifact", path: ".mex/context/worker.md" },
          contentHash: hash(readFileSync(destinationPath)),
        },
      ],
    };
    const reviewed = await crashing.previewOperations(request);
    if (!reviewed.plan.valid || reviewed.recoveryManifest === undefined) {
      throw new Error("expected a valid recovery-bound batch preview");
    }
    const futureId = reviewed.recoveryManifest.items[1]?.createdIds[0];
    expect(futureId).toMatch(/^mx_/);
    await expectCode(() => crashing.applyOperations({
      ...request,
      plan: reviewed.plan,
      expectedPreviewRevision: reviewed.previewRevision,
    }), "OPERATION_INTERRUPTED");

    const resumedPort = createRepositoryWikiPort(target.root);
    expect(resumedPort.inspectOperationRecovery(request)).toEqual({
      schemaVersion: 1,
      state: "prefix",
      operationIds: [firstOperationId, "operation_adapter_prefix_ids_item_02"],
      completedOperationIds: [firstOperationId],
      activeOperationId: null,
    });
    await expectCode(() => resumedPort.previewOperations(request), "VALIDATION_FAILED");
    const beforeForgedResume = [
      readFileSync(target.firstPath),
      readFileSync(destinationPath),
      readFileSync(join(target.root, ".mex", "events", "operations.jsonl")),
    ];
    const forgedManifest = {
      ...reviewed.recoveryManifest,
      items: reviewed.recoveryManifest.items.map((item, index) => index === 1
        ? { ...item, createdIds: [FOURTH] }
        : item),
    };
    await expectCode(() => resumedPort.resumeOperations(request, forgedManifest), "VALIDATION_FAILED");
    expect([
      readFileSync(target.firstPath),
      readFileSync(destinationPath),
      readFileSync(join(target.root, ".mex", "events", "operations.jsonl")),
    ]).toEqual(beforeForgedResume);
    const resumed = await resumedPort.resumeOperations(request, reviewed.recoveryManifest);
    expect(resumed.recoveryManifest).toEqual(reviewed.recoveryManifest);
    if (!resumed.plan.valid) throw new Error("expected a valid resumed suffix");
    await resumedPort.applyOperations({
      ...request,
      plan: resumed.plan,
      expectedPreviewRevision: resumed.previewRevision,
    });
    expect(readFileSync(destinationPath, "utf8")).toContain(futureId);
    expect(resumedPort.inspectOperationRecovery(request)).toMatchObject({
      state: "complete",
      completedOperationIds: [firstOperationId, "operation_adapter_prefix_ids_item_02"],
    });
  });

  it("rejects unsafe direct paths before maintenance or validation", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const before = readFileSync(join(target.root, ".mex", "wiki.db"));

    await expectCode(() => port.refreshFiles(["../outside.md"]), "PATH_OUTSIDE_PROJECT");
    await expectCode(() => port.validate({ paths: ["..\\outside.md"] }), "PATH_OUTSIDE_PROJECT");
    expect(readFileSync(join(target.root, ".mex", "wiki.db"))).toEqual(before);
  });

  it("computes validation over all filtered diagnostics even when none are projected", async () => {
    const target = project();
    writeFileSync(
      target.firstPath,
      readFileSync(target.firstPath, "utf8").replace(TARGET, "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJZ"),
      "utf8",
    );
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();

    expect(await port.validate({ maxDiagnostics: 0 })).toEqual({
      valid: false,
      diagnostics: [],
    });
    expect((await port.validate({ maxDiagnostics: 1_000 })).diagnostics.length).toBeLessThanOrEqual(100);
    await expectCode(() => port.validate({ maxDiagnostics: -1 }), "INVALID_REQUEST");
  });

  it("previews all eleven frozen operation kinds through the exact batch planner", async () => {
    const NODE = "function:1111111111111111";
    const FINGERPRINT = "mh:4:11111111";
    const BODY_HASH = "b".repeat(64);
    const cases: ReadonlyArray<{
      type: WikiOperationType;
      entityId?: string;
      payload: RepositoryWikiOperationPayload;
      extraExpectations?: "architecture-artifact" | "component-artifact" | "target-entity";
    }> = [
      {
        type: "create-entry",
        payload: {
          file: "context/architecture.md",
          insertAt: { at: "end-of-file" },
          type: "convention",
          title: "Name queue owners",
          body: "Use a stable domain name.",
          headingDepth: 2,
        },
        extraExpectations: "architecture-artifact",
      },
      { type: "update-entry", entityId: ENTITY, payload: { summary: "Owns durable queueing." } },
      { type: "set-property", entityId: ENTITY, payload: { property: "status", value: "deprecated" } },
      { type: "add-relation", entityId: ENTITY, payload: { relation: { type: "related_to", target: TARGET } } },
      { type: "remove-relation", entityId: ENTITY, payload: { type: "depends_on", target: TARGET } },
      { type: "add-source", entityId: ENTITY, payload: { source: { type: "commit", commit: "a1b2c3d4e5f6789012345678901234567890abcd" } } },
      { type: "remove-source", entityId: ENTITY, payload: { sourceIdentity: "manual||maintainer review" } },
      { type: "set-grounding", entityId: ENTITY, payload: { groundsTo: [{ node: NODE, fingerprint: FINGERPRINT, bodyHash: BODY_HASH }] } },
      { type: "supersede-entry", entityId: ENTITY, payload: { replacementId: TARGET }, extraExpectations: "target-entity" },
      {
        type: "move-entry",
        entityId: ENTITY,
        payload: { file: "context/component.md", insertAt: { at: "end-of-file" } },
        extraExpectations: "component-artifact",
      },
      { type: "archive-entry", entityId: ENTITY, payload: { note: "Archived by adapter coverage." } },
    ];

    for (const testCase of cases) {
      const target = project();
      const port = createRepositoryWikiPort(target.root, {
        groundingBridge: {
          async withFreshGroundingSnapshot<T>(callback: (snapshot: never) => T | Promise<T>): Promise<T> {
            return callback({
              revision: "graph-operation-fixture-v1",
              getNode: (id: string) => id === NODE
                ? { id: NODE, bodyHash: BODY_HASH, filePath: "src/queue.ts", startLine: 1, endLine: 5 }
                : null,
              getFingerprint: (id: string) => id === NODE ? FINGERPRINT : null,
              reconcile: () => null,
              getBaselineSource: () => null,
            } as never);
          },
        },
      });
      await port.rebuildIndex();
      const entity = await port.getEntity(ENTITY);
      const targetEntity = await port.getEntity(TARGET);
      if (!entity || !targetEntity) throw new Error("operation fixture entity missing");
      const expectedRevisions = testCase.entityId === undefined ? [] : [{
        target: { kind: "entity" as const, id: ENTITY },
        version: entity.version,
      }];
      if (testCase.extraExpectations === "architecture-artifact") {
        expectedRevisions.push({
          target: { kind: "artifact" as const, path: ".mex/context/architecture.md" },
          contentHash: hash(readFileSync(target.firstPath)),
        } as never);
      } else if (testCase.extraExpectations === "component-artifact") {
        expectedRevisions.push({
          target: { kind: "artifact" as const, path: ".mex/context/component.md" },
          contentHash: hash(readFileSync(join(target.root, ".mex", "context", "component.md"))),
        } as never);
      } else if (testCase.extraExpectations === "target-entity") {
        expectedRevisions.push({
          target: { kind: "entity" as const, id: TARGET },
          version: targetEntity.version,
        });
      }
      const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
        operation: {
          opId: `operation_adapter_${testCase.type.replaceAll("-", "_")}`,
          type: testCase.type,
          ...(testCase.entityId === undefined ? {} : {
            entityId: ENTITY,
            baseRevision: entity.version.semanticRevision,
            baseContentHash: entity.version.contentHash,
          }),
          actor: { kind: "human", id: "member_adapter_test" },
          timestamp: "2026-08-26T00:00:00.000Z",
          payload: testCase.payload,
        },
        expectedRevisions,
      };
      const before = readFileSync(target.firstPath);
      const preview = await port.previewOperations(request);
      expect(preview.valid, testCase.type).toBe(true);
      expect(preview.changes.length, testCase.type).toBeGreaterThan(0);
      expect(readFileSync(target.firstPath), testCase.type).toEqual(before);
    }
  });

  it("requires exact optimistic expectations for secondary batch targets", async () => {
    const target = project();
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();
    const first = await port.getEntity(ENTITY);
    const second = await port.getEntity(TARGET);
    if (!first || !second) throw new Error("batch fixture entity missing");
    const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
      operation: {
        opId: "operation_adapter_secondary_targets",
        type: "update-entry",
        entityId: ENTITY,
        baseRevision: first.version.semanticRevision,
        baseContentHash: first.version.contentHash,
        actor: { kind: "human", id: "member_adapter_test" },
        timestamp: "2026-08-26T00:00:00.000Z",
        payload: {
          operations: [
            { type: "update-entry", entityId: ENTITY, summary: "First exact target." },
            { type: "update-entry", entityId: TARGET, summary: "Second exact target." },
          ],
        },
      },
      expectedRevisions: [{ target: { kind: "entity", id: ENTITY }, version: first.version }],
    };
    await expectCode(() => port.previewOperations(request), "VALIDATION_FAILED");
    const preview = await port.previewOperations({
      ...request,
      expectedRevisions: [
        ...request.expectedRevisions,
        { target: { kind: "entity", id: TARGET }, version: second.version },
      ],
    });
    expect(preview.valid).toBe(true);
  });

  it("binds Hub search, workspace, and explicit Code→Knowledge reads to one Wiki revision", async () => {
    const target = project(true);
    const port = createRepositoryWikiPort(target.root);
    await port.rebuildIndex();

    const search = await port.searchBundle({ query: "queue", limit: 10 });
    expect(search.results.items.length).toBeGreaterThan(0);
    expect(search.indexedRevision).toMatch(/^[a-f0-9]{64}$/);

    const workspace = await port.readKnowledgeWorkspace({
      entityId: ENTITY,
      view: "relations",
      direction: "outgoing",
      limit: 10,
    });
    expect(workspace.indexedRevision).toBe(search.indexedRevision);
    expect(workspace.entity.ref.id).toBe(ENTITY);
    expect(workspace.selection).toMatchObject({ kind: "relations" });

    const first = await port.knowledgeForCode({
      nodeIds: ["function:1111111111111111"],
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.matchedNodes).toEqual(["function:1111111111111111"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await port.knowledgeForCode({
      nodeIds: ["function:1111111111111111"],
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.entity.ref.id).not.toBe(first.items[0]?.entity.ref.id);
    await expectCode(() => port.knowledgeForCode({
      nodeIds: ["function:2222222222222222"],
      limit: 1,
      cursor: first.nextCursor!,
    }), "INVALID_REQUEST");
    await expectCode(() => port.knowledgeForCode({
      nodeIds: ["function:1111111111111111"],
      limit: 1,
      cursor: cursorWithOffset(first.nextCursor!, 10_000),
    }), "INVALID_REQUEST");
  });

  it("projects entity detail and neighborhood grounding under one exact Graph lease", async () => {
    const target = project(true);
    const node = "function:1111111111111111";
    const fingerprint = "mh:4:11111111";
    writeFileSync(
      target.firstPath,
      readFileSync(target.firstPath, "utf8").replace(
        "revision: 1\nrelations:",
        `revision: 1\ngrounds_to:\n  - node: ${node}\n    fingerprint: ${fingerprint}\nrelations:`,
      ),
      "utf8",
    );
    await createRepositoryWikiPort(target.root).rebuildIndex();

    let leases = 0;
    const port = createRepositoryWikiPort(target.root, {
      groundingBridge: {
        async withFreshGroundingSnapshot<T>(callback: (snapshot: never) => T | Promise<T>): Promise<T> {
          const lease = ++leases;
          return callback({
            revision: `graph-composite-${lease}`,
            getNode: (id: string) => id === node
              ? { id: node, bodyHash: "b".repeat(64), filePath: "src/queue.ts", startLine: 1, endLine: 5 }
              : null,
            getFingerprint: (id: string) => id === node
              ? (lease === 1 ? fingerprint : "mh:4:22222222")
              : null,
            reconcile: () => null,
            getBaselineSource: () => null,
          } as never);
        },
      },
    });
    const request = {
      entityId: ENTITY,
      direction: "both" as const,
      depth: 1,
      maxEntities: 10,
      maxTokens: 4_000,
      includeArchived: true,
    };

    const first = await port.getEntityNeighborhood(request);
    expect(first).not.toBeNull();
    expect(leases).toBe(1);
    expect(first?.entity).toMatchObject({
      groundingHealth: "fresh",
      groundings: [{ health: "fresh", state: "fresh" }],
    });
    expect(first?.neighborhood.root.groundingHealth).toBe("fresh");
    expect(first?.neighborhood.entities.find((entity) => entity.ref.id === TARGET)?.groundingHealth)
      .toBe("fresh");

    const second = await port.getEntityNeighborhood(request);
    expect(second).not.toBeNull();
    expect(leases).toBe(2);
    expect(second?.entity).toMatchObject({
      groundingHealth: "changed",
      groundings: [{ health: "changed", state: "stale" }],
    });
    expect(second?.neighborhood.root.groundingHealth).toBe("changed");
    expect(second?.neighborhood.entities.find((entity) => entity.ref.id === TARGET)?.groundingHealth)
      .toBe("changed");
    expect(second?.projectionRevision).not.toBe(first?.projectionRevision);
  });

  it("degrades current grounding reads to unverified when the fresh Graph bridge is unavailable", async () => {
    const target = project(true);
    let bridgeCalls = 0;
    const port = createRepositoryWikiPort(target.root, {
      groundingBridge: {
        async withFreshGroundingSnapshot() {
          bridgeCalls += 1;
          throw new MexPortError({
            code: "INDEX_MISSING",
            status: 503,
            title: "Graph unavailable",
            detail: "The test Graph is unavailable.",
          });
        },
      },
    });
    await port.rebuildIndex();
    const indexPath = join(target.root, ".mex", "wiki.db");
    const before = readFileSync(indexPath);
    const entity = await port.getEntity(TARGET);
    expect(entity?.groundingHealth).toBe("unverified");
    expect(entity?.groundings).toMatchObject([{ state: "unresolved", health: "unverified" }]);
    const listed = await port.listEntities({ groundingHealth: ["unverified"] });
    expect(listed.items.find((item) => item.ref.id === TARGET)?.groundingHealth).toBe("unverified");
    expect((await port.listEntities({ groundingHealth: ["fresh"] })).items.map((item) => item.ref.id))
      .not.toContain(TARGET);
    const queried = await port.queryEntities({ query: "durable queue", groundingHealth: ["unverified"] });
    expect(queried.items.find((item) => item.entity.ref.id === TARGET)?.entity.groundingHealth).toBe("unverified");
    const related = await port.traverseRelations({ entityId: ENTITY, direction: "outgoing" });
    expect(related.items.find((item) => item.entity.ref.id === TARGET)?.entity.groundingHealth).toBe("unverified");
    const neighborhood = await port.getNeighborhood({
      entityId: ENTITY,
      depth: 1,
      maxEntities: 10,
      maxTokens: 4_000,
    });
    expect(neighborhood.entities.find((item) => item.ref.id === TARGET)?.groundingHealth).toBe("unverified");
    expect(bridgeCalls).toBeGreaterThanOrEqual(6);
    expect(readFileSync(indexPath)).toEqual(before);
  });

  it("degrades only grounding when a fresh Graph snapshot accessor is interrupted", async () => {
    const target = project(true);
    await createRepositoryWikiPort(target.root).rebuildIndex();
    const port = createRepositoryWikiPort(target.root, {
      groundingBridge: {
        async withFreshGroundingSnapshot<T>(
          callback: (snapshot: RepositoryWikiGroundingSnapshot) => T | Promise<T>,
        ): Promise<T> {
          return callback({
            revision: "graph-accessor-interrupted-v1",
            getNode() {
              throw new MexPortError({
                code: "OPERATION_INTERRUPTED",
                status: 409,
                title: "Graph read interrupted",
                detail: "The Graph snapshot accessor could not complete safely.",
              });
            },
            getFingerprint: () => null,
            reconcile: () => null,
            getBaselineSource: () => null,
          });
        },
      },
    });

    await expect(port.getEntity(TARGET)).resolves.toMatchObject({
      ref: { id: TARGET },
      groundingHealth: "unverified",
      groundings: [{ health: "unverified", state: "unresolved" }],
    });
    await expect(port.listEntities({ groundingHealth: ["unverified"] })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({
        ref: expect.objectContaining({ id: TARGET }),
        groundingHealth: "unverified",
      })]),
    });
  });

  it("binds summary cursors to the current Graph snapshot as well as the Wiki index", async () => {
    const target = project(true);
    const builder = createRepositoryWikiPort(target.root);
    await builder.rebuildIndex();
    let revision = "graph-revision-a";
    const port = createRepositoryWikiPort(target.root, {
      groundingBridge: {
        async withFreshGroundingSnapshot<T>(callback: (snapshot: never) => T | Promise<T>): Promise<T> {
          return callback({
            revision,
            getNode: () => null,
            getFingerprint: () => null,
            reconcile: () => null,
            getBaselineSource: () => null,
          } as never);
        },
      },
    });
    const first = await port.listEntities({ limit: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));
    revision = "graph-revision-b";
    await expectCode(() => port.listEntities({ limit: 1, cursor: first.nextCursor! }), "REVISION_CONFLICT");
  });

  it("keeps Code→Knowledge lookup canonical-only and independent of Graph reconciliation", async () => {
    const target = project(true);
    const builder = createRepositoryWikiPort(target.root);
    await builder.rebuildIndex();
    let bridgeCalls = 0;
    const port = createRepositoryWikiPort(target.root, {
      groundingBridge: {
        async withFreshGroundingSnapshot<T>(): Promise<T> {
          bridgeCalls += 1;
          throw new Error("Code→Knowledge must not consult Graph");
        },
      },
    });
    const explicit = await port.knowledgeForCode({ nodeIds: ["function:1111111111111111"] });
    expect(explicit.items.length).toBeGreaterThan(0);
    const merelyReconciled = await port.knowledgeForCode({ nodeIds: ["function:9999999999999999"] });
    expect(merelyReconciled.items).toEqual([]);
    expect(bridgeCalls).toBe(0);
  });

  it("rejects a symlinked Wiki scaffold before any read or maintenance", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-wiki-root-bound-"));
    const outside = mkdtempSync(join(tmpdir(), "mex-wiki-outside-"));
    roots.push(root, outside);
    symlinkSync(outside, join(root, ".mex"), "dir");
    try {
      createRepositoryWikiPort(root);
      throw new Error("Expected a bound-root rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(MexPortError);
      expect((error as MexPortError).problem.code).toBe("PATH_OUTSIDE_PROJECT");
    }
  });

  it("pins a lazily-created Wiki scaffold to its first observed directory identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-wiki-lazy-root-"));
    roots.push(root);
    const port = createRepositoryWikiPort(root);
    mkdirSync(join(root, ".mex"));
    expect((await port.inspectIndex()).state).toBe("missing");
    renameSync(join(root, ".mex"), join(root, ".mex-original"));
    mkdirSync(join(root, ".mex"));
    await expectCode(() => port.inspectIndex(), "PATH_OUTSIDE_PROJECT");
  });

  it("discards a grounded candidate after final Graph invalidation and publishes an unverified retry", async () => {
    const target = project(true);
    let rebuildCalls = 0;
    const port = createRepositoryWikiPort(target.root, {
      groundingBridge: {
        async withFreshGroundingSnapshot<T>(callback: (snapshot: never) => T | Promise<T>): Promise<T> {
          return callback({
            revision: "graph-rebuild-snapshot-v1",
            getNode: () => null,
            getFingerprint: () => null,
            reconcile: () => null,
            getBaselineSource: () => null,
          } as never);
        },
        async withFreshGroundingPublication<T>(prepare: (snapshot: never) => Promise<{
          preflight(): void | Promise<void>;
          commit(): T | Promise<T>;
          discard(): void | Promise<void>;
        }> | {
          preflight(): void | Promise<void>;
          commit(): T | Promise<T>;
          discard(): void | Promise<void>;
        }): Promise<T> {
          const candidate = await prepare({
            revision: "graph-rebuild-snapshot-v1",
            getNode: () => null,
            getFingerprint: () => null,
            reconcile: () => null,
            getBaselineSource: () => null,
          } as never);
          await candidate.preflight();
          await candidate.discard();
          throw new MexPortError({
            code: "OPERATION_INTERRUPTED",
            status: 409,
            title: "Graph changed",
            detail: "The Graph changed during final validation.",
          });
        },
      },
      __internal: {
        prepareRebuild(options) {
          rebuildCalls += 1;
          return prepareWikiRebuild(options);
        },
      },
    });
    await expect(port.rebuildIndex()).resolves.toMatchObject({ state: "succeeded" });
    expect(rebuildCalls).toBe(2);
    expect((await port.inspectIndex()).state).toBe("fresh");
    expect(await port.getGroundingStatus(TARGET)).toEqual([
      expect.objectContaining({ health: "unverified" }),
    ]);
  });

  it("pins selective paths and nonempty topic mappings through apply and replay", async () => {
    const target = migrationProject();
    const port = createRepositoryWikiPort(target.root, {
      now: () => "2026-08-26T00:00:00.000Z",
    });
    const options = {
      paths: [".mex/context/architecture.md"],
      topicMappings: { checkout: TOPIC },
    } as const;

    const first = await port.planMigration(options);
    expect(first.validation.valid).toBe(true);
    expect(first.report.filesScanned).toBe(1);
    expect(first.changes.map((change) => change.path)).toContain(".mex/context/architecture.md");
    expect(first.changes.map((change) => change.path)).not.toContain(".mex/patterns/webhook.md");
    const same = await port.planMigration(options);
    expect(same.plan.requestHash).toBe(first.plan.requestHash);
    const remapped = await port.planMigration({
      ...options,
      topicMappings: { "checkout architecture": TOPIC },
    });
    expect(remapped.plan.requestHash).not.toBe(first.plan.requestHash);

    writeFileSync(
      target.unselectedPath,
      `${readFileSync(target.unselectedPath, "utf8")}\nConcurrent unselected corpus edit.\n`,
      "utf8",
    );
    await expectCode(() => port.applyMigration({
      migrationId: first.migrationId,
      previewRevision: first.previewRevision,
      plan: first.plan,
      expectedRevisions: first.expectedRevisions,
    }), "REVISION_CONFLICT");
    expect(readFileSync(target.selectedPath, "utf8")).not.toContain("\nmex:\n");

    const reviewed = await port.planMigration(options);
    const applied = await port.applyMigration({
      migrationId: reviewed.migrationId,
      previewRevision: reviewed.previewRevision,
      plan: reviewed.plan,
      expectedRevisions: reviewed.expectedRevisions,
    });
    expect(applied).toMatchObject({ applied: true, idempotentReplay: false });
    expect(readFileSync(target.selectedPath, "utf8")).toContain("\nmex:\n");
    expect(readFileSync(target.unselectedPath, "utf8")).not.toContain("\nmex:\n");

    const replay = await port.applyMigration({
      migrationId: reviewed.migrationId,
      previewRevision: reviewed.previewRevision,
      plan: reviewed.plan,
      expectedRevisions: reviewed.expectedRevisions,
    });
    expect(replay.idempotentReplay).toBe(true);
  });

  it("rejects invalid migration mapping targets as validation failures", async () => {
    const target = migrationProject();
    const port = createRepositoryWikiPort(target.root);
    await expectCode(() => port.planMigration({
      paths: [".mex/context/architecture.md"],
      topicMappings: { checkout: ENTITY },
    }), "VALIDATION_FAILED");
  });
});

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashCanonical(value: unknown): string {
  return hash(canonical(value));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function cursorWithOffset(cursor: string, offset: number): string {
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  return Buffer.from(canonical({ ...payload, offset }), "utf8").toString("base64url");
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(MexPortError);
    expect((error as MexPortError).problem.code).toBe(code);
  }
}
