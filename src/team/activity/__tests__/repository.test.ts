import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GitChangedFilesRequest,
  GitDiffRequest,
  GitFileAtRevisionRequest,
  GitHistoryRequest,
  GitPort,
} from "../../contracts/git.js";
import type { RepoState } from "../../contracts/shared.js";
import { MexPortError } from "../../contracts/shared.js";
import { generateArtifactId } from "../../artifacts/ulid.js";
import { serializeActivityArtifact } from "../../artifacts/codecs.js";
import { revisionOf } from "../../artifacts/revision.js";
import type { ActivityEventV1 } from "../../contracts/workflow.js";
import { ActivityRepository, TimelineReader } from "../repository.js";

const roots: string[] = [];
const timestamp = "2026-08-23T01:02:03.000Z";
const firstId = "event_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const secondId = "event_01ARZ3NDEKTSV4RRFFQ69G5FAC";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ActivityRepository", () => {
  it("accepts an explicit workflow-owned event ID without consuming the generator", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const repository = fixedRepository(root, git, secondId);
    const preview = await repository.previewCreateWithAuthority({
      actor: { kind: "unknown" },
      action: "activity.recorded",
      subjects: [],
    }, {
      timestamp,
      repoState: git.state,
    }, firstId);

    expect(preview.event.id).toBe(firstId);
    expect(preview.event).toMatchObject({
      schemaVersion: 2,
      origin: { kind: "custom" },
    });
    expect((await repository.applyCreate(preview, preview.previewRevision)).id).toBe(firstId);
    const generated = await repository.previewCreate({
      actor: { kind: "unknown" },
      action: "activity.recorded",
      subjects: [],
    });
    expect(generated.event.id).toBe(secondId);
  });

  it("binds an enclosing workflow's service-owned authority and still revalidates Git", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const repository = fixedRepository(root, git, firstId);
    const authority = {
      timestamp: "2026-08-23T04:05:06.000Z",
      repoState: { ...git.state },
    };

    const preview = await repository.previewCreateWithAuthority({
      actor: { kind: "member", memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      action: "workstream.created",
      subjects: [{ kind: "entity", entity: { id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "workstream" } }],
    }, authority, undefined, {
      origin: { kind: "workflow", operation: "workstream.create" },
      label: "Activity workbench",
    });

    expect(preview.event).toMatchObject({
      timestamp: authority.timestamp,
      repoState: authority.repoState,
      schemaVersion: 2,
      origin: { kind: "workflow", operation: "workstream.create" },
      label: "Activity workbench",
    });
    git.state = { ...git.state, head: "2".repeat(40) };
    await expect(repository.applyCreate(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(existsSync(join(root, ...preview.sourcePath.split("/")))).toBe(false);
  });

  it("previews without writes, captures Git state, and atomically creates an immutable event", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const repository = fixedRepository(root, git, firstId);

    const preview = await repository.previewCreate({
      actor: { kind: "member", memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      action: "member.updated",
      subjects: [{ kind: "file", path: "src/index.ts" }],
      metadata: { reason: "ownership changed" },
    });

    expect(preview.event).toMatchObject({
      schemaVersion: 2,
      origin: { kind: "custom" },
    });

    expect(existsSync(join(root, ".mex/events/activity"))).toBe(false);
    expect(preview.changes[0]).toMatchObject({ kind: "create", beforeRevision: null });
    const stored = await repository.applyCreate(preview, preview.previewRevision);
    expect(stored.repoState).toEqual(git.state);
    expect(repository.get(firstId)).toEqual(stored);

    await expect(repository.applyCreate(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
  });

  it("rejects stale previews before writing", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const repository = fixedRepository(root, git, firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" },
      action: "workstream.observed",
      subjects: [],
    });

    git.state = { ...git.state, dirty: true };
    await expect(repository.applyCreate(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(existsSync(join(root, ...preview.sourcePath.split("/")))).toBe(false);
  });

  it("validates Git before a workflow write and publishes the exact event afterward", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const repository = fixedRepository(root, git, firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.created", subjects: [],
    });

    const publication = await repository.prepareApplyCreate(
      preview,
      preview.previewRevision,
    );
    // Simulate the enclosing workflow's reviewed canonical publication.
    git.state = { ...git.state, dirty: true };
    const stored = await publication.publish();

    expect(stored.revision).toBe(preview.revision);
    expect(stored.repoState.dirty).toBe(false);
    await expect(publication.publish()).rejects.toThrowError(MexPortError);
  });

  it("does not consume a prepared publication when a conflicting path is removed for retry", async () => {
    const root = temporaryRoot();
    const repository = fixedRepository(root, fakeGit(), firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.created", subjects: [],
    });
    const publication = await repository.prepareApplyCreate(preview, preview.previewRevision);
    const path = join(root, ...preview.sourcePath.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "conflicting bytes\n", "utf8");

    await expect(publication.publish()).rejects.toThrowError(MexPortError);
    unlinkSync(path);
    expect((await publication.publish()).revision).toBe(preview.revision);
  });

  it("recovers only an exact journaled Activity event and replays it idempotently", async () => {
    const root = temporaryRoot();
    const repository = fixedRepository(root, fakeGit(), firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.created", subjects: [],
    });

    const recovered = await repository.recoverJournaledCreate(preview.event, preview.revision);
    await expect(repository.recoverJournaledCreate(preview.event, preview.revision))
      .resolves.toEqual(recovered);
    await expect(repository.recoverJournaledCreate(preview.event, "f".repeat(64)))
      .rejects.toThrowError(MexPortError);
  });

  it("reads and recovers schema-v1 Activity without rewriting or migrating its bytes", async () => {
    const root = temporaryRoot();
    const repository = fixedRepository(root, fakeGit(), secondId);
    const event: ActivityEventV1 = {
      schemaVersion: 1,
      id: firstId,
      timestamp,
      actor: { kind: "unknown" },
      action: "relay.closed",
      subjects: [],
      repoState: fakeGit().state,
    };
    const bytes = serializeActivityArtifact(event);
    const stored = await repository.recoverJournaledCreate(event, revisionOf(bytes));
    const path = join(root, ...stored.sourcePath.split("/"));
    const before = {
      bytes: readFileSync(path, "utf8"),
      mtimeMs: statSync(path).mtimeMs,
    };

    expect(repository.get(firstId)).toMatchObject({ schemaVersion: 1 });
    expect(repository.list().items).toHaveLength(1);
    expect({ bytes: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs })
      .toEqual(before);
  });

  it("binds the canonical project root before a caller symlink can be swapped", async () => {
    const firstRoot = temporaryRoot();
    const secondRoot = temporaryRoot();
    const links = temporaryRoot();
    const link = join(links, "repository");
    symlinkSync(firstRoot, link, "dir");
    const repository = fixedRepository(link, fakeGit(), firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.created", subjects: [],
    });

    unlinkSync(link);
    symlinkSync(secondRoot, link, "dir");
    await repository.applyCreate(preview, preview.previewRevision);

    expect(existsSync(join(firstRoot, ...preview.sourcePath.split("/")))).toBe(true);
    expect(existsSync(join(secondRoot, ...preview.sourcePath.split("/")))).toBe(false);
  });

  it("diagnoses malformed and conflicting canonical events", async () => {
    const root = temporaryRoot();
    const first = fixedRepository(root, fakeGit(), firstId);
    const preview = await first.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.observed", subjects: [],
    });
    await first.applyCreate(preview, preview.previewRevision);

    const conflictDir = join(root, ".mex/events/activity/2026-09");
    mkdirSync(conflictDir, { recursive: true });
    writeFileSync(join(conflictDir, `${firstId}.md`), readFileSync(join(root, ...preview.sourcePath.split("/")), "utf8").replace(timestamp, "2026-09-23T01:02:03.000Z"));
    writeFileSync(join(conflictDir, "bad.md"), "not-frontmatter\n");

    const read = first.readAll();
    expect(read.events).toEqual([]);
    expect(read.diagnostics.map((item) => item.code)).toContain("ACTIVITY_ID_CONFLICT");
    expect(read.diagnostics.map((item) => item.code)).toContain("ACTIVITY_ARTIFACT_UNEXPECTED");
    expect(() => first.get(firstId)).toThrowError(MexPortError);
  });

  it("enforces directory capacity at preview and again under the publication lock", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const repository = fixedRepository(root, git, firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.created", subjects: [],
    });
    const publication = await repository.prepareApplyCreate(preview, preview.previewRevision);
    const month = join(root, ".mex/events/activity", timestamp.slice(0, 7));
    mkdirSync(month, { recursive: true });
    for (let index = 0; index < 4_095; index += 1) {
      writeFileSync(join(month, `unexpected-${String(index).padStart(4, "0")}.txt`), "x");
    }

    const bounded = repository.readAll();
    expect(bounded.sourceTruncated).toBe(false);
    expect(bounded.diagnostics).toHaveLength(100);
    expect(bounded.diagnostics.at(-1)?.code).toBe("ACTIVITY_DIAGNOSTICS_TRUNCATED");
    await expect(fixedRepository(root, git, secondId).previewCreate({
      actor: { kind: "unknown" }, action: "workstream.created", subjects: [],
    })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    await expect(publication.publish()).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });

    unlinkSync(join(month, "unexpected-4094.txt"));
    await expect(publication.publish()).resolves.toMatchObject({ id: firstId });
  });

  // Each operation scans the whole corpus; keep their hang guards independent.
  it.each(["read", "get", "preview"] as const)("counts malformed canonical candidates toward the 2,048-record ceiling (%s)", async (operation) => {
    const root = temporaryRoot();
    const month = join(root, ".mex/events/activity", timestamp.slice(0, 7));
    mkdirSync(month, { recursive: true });
    const ids = Array.from({ length: 2_048 }, (_, index) => seededEventId(index));
    for (const eventId of ids) writeFileSync(join(month, `${eventId}.md`), "malformed\n");
    const repository = fixedRepository(root, fakeGit(), firstId);

    if (operation === "read") {
      const read = repository.readAll();
      expect(read.sourceTruncated).toBe(false);
      expect(read.untrustedIds).toHaveLength(2_048);
      expect(read.diagnostics).toHaveLength(100);
    } else if (operation === "get") {
      expect(() => repository.get(ids[0]!)).toThrowError(MexPortError);
    } else {
      await expect(repository.previewCreate({
        actor: { kind: "unknown" }, action: "workstream.created", subjects: [],
      })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    }
  });

  it("fails closed at the 32 MiB aggregate Activity byte ceiling", async () => {
    const root = temporaryRoot();
    const month = join(root, ".mex/events/activity", timestamp.slice(0, 7));
    mkdirSync(month, { recursive: true });
    for (let index = 0; index < 513; index += 1) {
      writeFileSync(join(month, `${seededEventId(index)}.md`), "x".repeat(65_500));
    }
    const repository = fixedRepository(root, fakeGit(), firstId);
    const read = repository.readAll();
    expect(read.sourceTruncated).toBe(true);
    expect(read.events).toEqual([]);
    expect(read.diagnostics).toHaveLength(100);
    await expect(repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.created", subjects: [],
    })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
  });

  it("combines canonical and legacy history without rewriting legacy bytes", async () => {
    const root = temporaryRoot();
    const repository = fixedRepository(root, fakeGit(), secondId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.observed", subjects: [],
    });
    await repository.applyCreate(preview, preview.previewRevision);
    const legacyPath = join(root, ".mex/events/decisions.jsonl");
    mkdirSync(join(root, ".mex/events"), { recursive: true });
    const legacy = `${JSON.stringify({ timestamp: "2026-08-22T00:00:00.000Z", kind: "note", message: "old", files: [] })}\n`;
    writeFileSync(legacyPath, legacy, "utf8");

    const page = new TimelineReader(root, repository).list();

    expect(page.items.map((item) => item.source)).toEqual(["activity", "legacy"]);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
  });

  it("rejects a forged preview digest", async () => {
    const root = temporaryRoot();
    const repository = fixedRepository(root, fakeGit(), firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.observed", subjects: [],
    });
    await expect(repository.applyCreate(preview, "f".repeat(64))).rejects.toBeInstanceOf(MexPortError);
  });

  it("rejects caller-forged repository provenance even with an issued digest", async () => {
    const root = temporaryRoot();
    const repository = fixedRepository(root, fakeGit(), firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.observed", subjects: [],
    });
    const forged = structuredClone(preview);
    forged.event.repoState.observedAt = "2026-08-23T00:00:00.000Z";

    await expect(repository.applyCreate(forged, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(repository.list().items).toEqual([]);
  });

  it("fails closed instead of trusting nondeterministic canonical scan prefixes", () => {
    const root = temporaryRoot();
    const month = join(root, ".mex/events/activity/2026-08");
    mkdirSync(month, { recursive: true });
    for (let index = 0; index < 4_097; index += 1) {
      writeFileSync(join(month, `unexpected-${String(index).padStart(4, "0")}.txt`), "x", "utf8");
    }

    const repository = fixedRepository(root, fakeGit(), firstId);
    const read = repository.readAll();
    expect(read.events).toEqual([]);
    expect(read.sourceTruncated).toBe(true);
    expect(read.diagnostics).toContainEqual(expect.objectContaining({
      code: "ACTIVITY_SOURCE_TRUNCATED",
    }));
    expect(repository.list()).toMatchObject({
      items: [],
      truncated: false,
      sourceTruncated: true,
    });
  });

  it("separates legacy corpus truncation from an empty filtered page", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, ".mex/events"), { recursive: true });
    const row = JSON.stringify({
      timestamp: "2026-08-22T00:00:00.000Z",
      kind: "note",
      message: "legacy",
      files: [],
    });
    writeFileSync(
      join(root, ".mex/events/decisions.jsonl"),
      `${Array.from({ length: 10_001 }, () => row).join("\n")}\n`,
      "utf8",
    );
    const repository = fixedRepository(root, fakeGit(), firstId);
    const page = new TimelineReader(root, repository).list({
      source: "legacy",
      since: "2030-01-01T00:00:00.000Z",
      limit: 100,
    });
    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(false);
    expect(page.sourceTruncated).toBe(true);
  });
});

function fixedRepository(root: string, git: FakeGit, id: string): ActivityRepository {
  return new ActivityRepository({
    projectRoot: root,
    git,
    now: () => new Date(timestamp),
    generateId: () => id,
  });
}

function seededEventId(index: number): string {
  return generateArtifactId("event", {
    now: Date.parse(timestamp) + index,
    random: new Uint8Array(10).fill(index % 251),
  });
}

interface FakeGit extends GitPort {
  state: RepoState;
}

function fakeGit(): FakeGit {
  const git: FakeGit = {
    state: {
      branch: "feature/team",
      head: "1".repeat(40),
      dirty: false,
      observedAt: timestamp,
    },
    async getRepoState() { return git.state; },
    async getIdentity() { return { name: "Dev", email: "dev@example.test" }; },
    async getWorkingTree() { return { items: [], nextCursor: null, truncated: false }; },
    async resolveRevision(ref: string) { return ref; },
    async getDiff(request: GitDiffRequest) {
      return { target: request.target, diff: "", bytes: 0, truncated: false };
    },
    async getHistory(_request?: GitHistoryRequest) {
      return { items: [], nextCursor: null, truncated: false };
    },
    async readFileAtRevision(_request: GitFileAtRevisionRequest) { return null; },
    async getChangedFiles(_request: GitChangedFilesRequest) {
      return { items: [], nextCursor: null, truncated: false };
    },
  };
  return git;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-lane-c-activity-"));
  roots.push(root);
  return root;
}
