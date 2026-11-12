import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { WORKFLOW_REPOSITORY_LIMITS } from "../../src/team/artifacts/index.js";
import type {
  ActorRef,
  EntityRef,
  RepoState,
  Revision,
} from "../../src/team/contracts/shared.js";
import type {
  LocalDraft,
  PreparedTeamWorkflowCommand,
  StoredActivityEvent,
  TeamArtifact,
  TeamArtifactKind,
  TeamArtifactState,
  TeamWorkflowCommand,
  TeamWorkflowPort,
} from "../../src/team/contracts/workflow.js";
import { TEAM_READ_LIMITS } from "../../src/team/contracts/workflow.js";
import { TEAM_LOCAL_STATE_LIMITS } from "../../src/team/local-state/index.js";

export const TEAM_WORKFLOW_CONTRACT_PHASES = [
  "before-canonical-publication",
  "after-canonical-publication",
  "after-activity-publication",
  "after-local-cleanup",
] as const;

export const TEAM_WORKFLOW_CONTRACT_ARTIFACT_KINDS = [
  "member",
  "workstream",
  "proposal",
  "relay",
  "playbook",
  "playbook_run",
] as const satisfies readonly TeamArtifactKind[];

export type TeamWorkflowContractPhase =
  (typeof TEAM_WORKFLOW_CONTRACT_PHASES)[number];

export type TeamWorkflowContractScenario =
  | "populated"
  | "uninitialized-local"
  | "legacy-v3"
  | "legacy-v3-invalid"
  | "source-bound"
  | "lease-contention"
  | "root-swap"
  | "containment:canonical"
  | "containment:activity"
  | "containment:local"
  | "authority-drift"
  | "local-drift"
  | "mock-wiki"
  | "mock-wiki-stale"
  | "mock-wiki-restart"
  | "recovery-repository-drift"
  | "recovery-primary-tamper"
  | "two-clone"
  | "real-wiki"
  | `recovery:${TeamWorkflowContractPhase}`;

export type TeamWorkflowCommandCase =
  | "canonical-create"
  | "canonical-update"
  | "local-draft-create"
  | "mixed-publish"
  | "wiki-approve";

export type InvalidTeamWorkflowCommandCase =
  | "missing-target-expectation"
  | "unrelated-target-expectation"
  | "forged-actor"
  | "forged-time"
  | "forged-repo-state";

export type PreparedCommandAlteration =
  | "intent"
  | "actor"
  | "time"
  | "repo-state";

/**
 * Digests are over the complete bounded stores, not selected records. A fixture
 * must settle any explicit initialization before returning from `open` so a
 * before/after equality assertion proves the tested read or preview did not
 * mutate storage. Every path, ID, and event collection is code-point sorted.
 */
export interface TeamWorkflowContractSnapshot {
  /** Canonical bytes under the real root bound when the port was constructed. */
  boundRootDigest: Revision;
  /** Canonical bytes currently reachable through the caller-supplied root path. */
  activeRootDigest: Revision;
  canonicalDigest: Revision;
  localStateDigest: Revision | null;
  gitHead: string | null;
  gitIndexDigest: Revision;
  gitStatusDigest: Revision;
  gitTrackedPaths: readonly string[];
  wikiCanonicalDigest: Revision;
  wikiIndexDigest: Revision;
  outsideDigest: Revision;
  artifactIds: readonly string[];
  localDraftIds: readonly string[];
  activities: readonly StoredActivityEvent[];
  modelInvocations: number;
  outboundRequests: number;
}

/** Test-only, bounded projection of the private workflow journal. */
export interface TeamWorkflowJournalInspection {
  rowCount: number;
  incompleteCount: number;
  operationIds: readonly string[];
  rows: readonly {
    operationId: string;
    phase: "intent" | "canonical_published" | "local_finalized" | "complete";
    effectCount: number;
    effectJsonBytes: number;
    /** Canonical JSON selected directly from the local database. */
    serializedEffects: string;
    /** Canonical test projection containing every durable journal column. */
    serializedRow: string;
  }[];
  /** Total bytes of the fresh fixture's SQLite database and existing sidecars. */
  durableStorageBytes: number;
  /** Canary labels found by bounded byte scans of SQLite, WAL, and SHM files. */
  durableStorageForbiddenMatches: readonly string[];
}

/** Test-only exact projection of the repository-local SQLite schema. */
export interface TeamWorkflowLocalSchemaInspection {
  version: number | null;
  /** Canonical sqlite_master rows, including exact table/index SQL. */
  objects: readonly string[];
}

export interface TeamWorkflowContractOracle {
  configuredActor: ActorRef;
  fixedNow: string;
  repositoryState: RepoState;
  artifactsByKind: Readonly<Record<TeamArtifactKind, EntityRef>>;
  activeArtifact: {
    ref: EntityRef;
    kind: TeamArtifactKind;
    state: TeamArtifactState;
  };
  archivedArtifact: {
    ref: EntityRef;
    kind: TeamArtifactKind;
    state: TeamArtifactState;
  };
  secondKind: TeamArtifactKind;
  localDraft: { id: string; kind: LocalDraft<unknown>["kind"] };
  /** Values deliberately present in workflow inputs/errors but forbidden from the journal. */
  journalPrivacySentinels: readonly string[];
  projectRoot: string;
}

export interface TeamWorkflowPhasePause {
  reached: Promise<void>;
  release(): void;
}

export interface TeamWorkflowPortContractHarness<TWikiOperationPlan> {
  port: TeamWorkflowPort<TWikiOperationPlan>;
  oracle: TeamWorkflowContractOracle;
  /**
   * Broad scenarios use real files, real local SQLite state, and a real Git
   * repository with a behavioral WikiPort. Only `real-wiki` may select the
   * repository Wiki adapter.
   */
  fixture: {
    filesystem: "real";
    localState: "real";
    git: "real";
    wiki: "behavioral-mock" | "real-adapter";
  };
  makeCommand(kind: TeamWorkflowCommandCase): Promise<TeamWorkflowCommand<TWikiOperationPlan>>;
  makeInvalidCommand(kind: InvalidTeamWorkflowCommandCase): Promise<unknown>;
  alterPreparedCommand(
    command: PreparedTeamWorkflowCommand<TWikiOperationPlan>,
    alteration: PreparedCommandAlteration,
  ): Promise<PreparedTeamWorkflowCommand<TWikiOperationPlan>>;
  makeConcurrentTargetEdit(): Promise<void>;
  makeConcurrentDraftEdit(): Promise<void>;
  makeWikiTargetEdit(): Promise<void>;
  makeRepositoryStateChange(): Promise<void>;
  tamperPublishedCanonicalEffect(): Promise<void>;
  armPhaseFailure(phase: TeamWorkflowContractPhase): Promise<void>;
  pauseAtPhase(phase: TeamWorkflowContractPhase): Promise<TeamWorkflowPhasePause>;
  restart(): Promise<TeamWorkflowPort<TWikiOperationPlan>>;
  contendingPort(): Promise<TeamWorkflowPort<TWikiOperationPlan>>;
  swapProjectRoot(): Promise<void>;
  installEscapingAncestor(target: "canonical" | "activity" | "local"): Promise<void>;
  peerPort(): Promise<TeamWorkflowPort<TWikiOperationPlan>>;
  makePeerCommand(kind: TeamWorkflowCommandCase): Promise<TeamWorkflowCommand<TWikiOperationPlan>>;
  synchronizeClones(): Promise<void>;
  peerSnapshot(): Promise<TeamWorkflowContractSnapshot>;
  inspectPeerJournal(): Promise<TeamWorkflowJournalInspection>;
  snapshot(): Promise<TeamWorkflowContractSnapshot>;
  inspectJournal(): Promise<TeamWorkflowJournalInspection>;
  inspectLocalSchema(): Promise<TeamWorkflowLocalSchemaInspection>;
  /** Makes the next explicit v3 migration fail after its v4 DDL has begun. */
  armLegacyMigrationFailure(): Promise<void>;
  close(): Promise<void>;
}

export interface TeamWorkflowPortContractFactory<TWikiOperationPlan> {
  open(
    scenario: TeamWorkflowContractScenario,
  ): Promise<TeamWorkflowPortContractHarness<TWikiOperationPlan>>;
}

/**
 * Consumer-owned contract for the internal repository TeamWorkflowPort.
 *
 * The adapter registration must run this suite against repository fixtures;
 * replacing the fixture stores with in-memory fakes defeats the containment,
 * restart, lease, privacy, and portability assertions below.
 */
export function defineTeamWorkflowPortContract<TWikiOperationPlan>(
  adapterName: string,
  factory: TeamWorkflowPortContractFactory<TWikiOperationPlan>,
): void {
  const withHarness = async <T>(
    scenario: TeamWorkflowContractScenario,
    run: (harness: TeamWorkflowPortContractHarness<TWikiOperationPlan>) => Promise<T>,
  ): Promise<T> => {
    const harness = await factory.open(scenario);
    try {
      expect(harness.fixture).toMatchObject({
        filesystem: "real",
        localState: "real",
        git: "real",
      });
      expect(harness.fixture.wiki).toBe(
        scenario === "real-wiki" ? "real-adapter" : "behavioral-mock",
      );
      const result = await run(harness);
      const finalSnapshot = await harness.snapshot();
      expect(finalSnapshot.modelInvocations).toBe(0);
      expect(finalSnapshot.outboundRequests).toBe(0);
      return result;
    } finally {
      await harness.close();
    }
  };

  describe(`${adapterName} TeamWorkflowPort contract`, () => {
    it("reads, filters, and paginates canonical artifacts deterministically", async () => {
      await withHarness("populated", async ({ port, oracle, snapshot }) => {
        const before = await snapshot();
        expect(await port.resolveActor()).toEqual(oracle.configuredActor);
        expect(await port.getArtifact(oracle.activeArtifact.ref)).toMatchObject({
          ref: oracle.activeArtifact.ref,
          kind: oracle.activeArtifact.kind,
        });
        expect(await port.getArtifact({
          id: "ws_00000000000000000000000000",
          kind: "workstream",
        }))
          .toBeNull();
        for (const kind of TEAM_WORKFLOW_CONTRACT_ARTIFACT_KINDS) {
          expect(await port.getArtifact(oracle.artifactsByKind[kind])).toMatchObject({ kind });
        }
        expect(oracle.secondKind).not.toBe(oracle.activeArtifact.kind);
        await expectCode(
          () => port.getArtifact({
            ...oracle.activeArtifact.ref,
            kind: oracle.secondKind,
          }),
          "VALIDATION_FAILED",
        );

        const first = await port.listArtifacts({ limit: 2 });
        const repeated = await port.listArtifacts({ limit: 2 });
        expect(repeated).toEqual(first);
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).not.toBeNull();
        expect(first.truncated).toBe(true);
        expect(first.sourceTruncated).toBe(false);
        expectRevision(first.deterministicRevision);
        expect(first.diagnostics.length).toBeLessThanOrEqual(
          WORKFLOW_REPOSITORY_LIMITS.maxDiagnostics,
        );

        const second = await port.listArtifacts({ cursor: first.nextCursor!, limit: 2 });
        expect(intersection(ids(first.items), ids(second.items))).toEqual([]);

        const kindFiltered = await port.listArtifacts({
          kinds: [oracle.activeArtifact.kind],
          limit: TEAM_READ_LIMITS.maxPageSize,
        });
        expect(kindFiltered.items.length).toBeGreaterThan(0);
        expect(kindFiltered.items.every((artifact) => artifact.kind === oracle.activeArtifact.kind))
          .toBe(true);

        const stateFiltered = await port.listArtifacts({
          states: [oracle.activeArtifact.state],
          limit: TEAM_READ_LIMITS.maxPageSize,
        });
        expect(stateFiltered.items.length).toBeGreaterThan(0);
        expect(stateFiltered.items.every((artifact) => artifactState(artifact)
          === oracle.activeArtifact.state)).toBe(true);

        const combined = await port.listArtifacts({
          kinds: [oracle.activeArtifact.kind],
          states: [oracle.activeArtifact.state],
          limit: TEAM_READ_LIMITS.maxPageSize,
        });
        expect(combined.items.length).toBeGreaterThan(0);
        expect(combined.items.every((artifact) => (
          artifact.kind === oracle.activeArtifact.kind
          && artifactState(artifact) === oracle.activeArtifact.state
        ))).toBe(true);

        expect(ids((await port.listArtifacts()).items))
          .not.toContain(oracle.archivedArtifact.ref.id);
        expect(ids((await port.listArtifacts({ includeArchived: true })).items))
          .toContain(oracle.archivedArtifact.ref.id);
        expect((await port.listArtifacts({ kinds: [oracle.secondKind] })).items
          .every((artifact) => artifact.kind === oracle.secondKind)).toBe(true);

        await expectCode(
          () => port.listArtifacts({ limit: TEAM_READ_LIMITS.maxPageSize + 1 }),
          "INVALID_REQUEST",
        );
        await expectCode(() => port.listArtifacts({ limit: 0 }), "INVALID_REQUEST");
        await expectCode(() => port.listArtifacts({ limit: 1.5 }), "INVALID_REQUEST");
        await expectCode(() => port.listArtifacts({ cursor: "not-a-cursor" }), "INVALID_REQUEST");
        await expectOneOfCodes(
          () => port.listArtifacts({
            cursor: first.nextCursor!,
            kinds: [oracle.activeArtifact.kind],
          }),
          ["INVALID_REQUEST", "REVISION_CONFLICT"],
        );
        expect(await snapshot()).toEqual(before);
      });
    });

    it("reads and filters checkout-local drafts without touching canonical state", async () => {
      await withHarness("populated", async ({ port, oracle, snapshot }) => {
        const before = await snapshot();
        const draft = await port.getLocalDraft(oracle.localDraft.id);
        expect(draft).toMatchObject({
          id: oracle.localDraft.id,
          kind: oracle.localDraft.kind,
        });
        expect(await port.getLocalDraft("draft_missing")).toBeNull();

        const page = await port.listLocalDrafts({ kind: oracle.localDraft.kind, limit: 1 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toEqual(draft);
        expect(page.items.every((item) => item.kind === oracle.localDraft.kind)).toBe(true);
        expectRevision(page.deterministicRevision);
        expect(page.sourceTruncated).toBe(false);
        await expectCode(
          () => port.listLocalDrafts({ limit: TEAM_READ_LIMITS.maxPageSize + 1 }),
          "INVALID_REQUEST",
        );
        await expectCode(
          () => port.listLocalDrafts({ cursor: "not-a-cursor" }),
          "INVALID_REQUEST",
        );
        expect(await snapshot()).toEqual(before);
      });
    });

    it("does not initialize absent checkout-local storage during reads or preview", async () => {
      await withHarness("uninitialized-local", async ({ port, makeCommand, snapshot }) => {
        const before = await snapshot();
        expect(before.localStateDigest).toBeNull();
        await port.resolveActor();
        await port.listArtifacts();
        await port.listLocalDrafts();
        await port.getLocalDraft("draft_missing");
        await port.preview(await makeCommand("canonical-create"));
        expect(await snapshot()).toEqual(before);
        expect((await snapshot()).localStateDigest).toBeNull();
      });
    });

    it("keeps legacy v3 reads and preview immutable, then migrates on the first local apply", async () => {
      await withHarness("legacy-v3", async ({
        port,
        makeCommand,
        snapshot,
        inspectLocalSchema,
      }) => {
        const before = await snapshot();
        const beforeSchema = await inspectLocalSchema();
        expect(before.localStateDigest).not.toBeNull();
        expect(beforeSchema.version).toBe(3);
        expect(beforeSchema.objects.some((value) => value.includes("inbox_drafts"))).toBe(false);

        await port.resolveActor();
        await port.listArtifacts();
        await expectCode(() => port.listLocalDrafts(), "MIGRATION_REQUIRED");
        await expectCode(() => port.getLocalDraft("draft_missing"), "MIGRATION_REQUIRED");
        const preview = await port.preview(await makeCommand("local-draft-create"));
        expect(preview).toMatchObject({ valid: true, scope: "local", changes: [] });
        expect(await snapshot()).toEqual(before);
        expect(await inspectLocalSchema()).toEqual(beforeSchema);

        const result = await port.apply({
          command: preview.command,
          expectedPreviewRevision: preview.previewRevision,
        });
        const after = await snapshot();
        const afterSchema = await inspectLocalSchema();
        expect(result).toMatchObject({ applied: true, idempotentReplay: false });
        expect(result.changes).toEqual([]);
        expect(result.events).toEqual([]);
        expect(afterSchema.version).toBe(4);
        expect(afterSchema.objects.some((value) => value.includes("inbox_drafts"))).toBe(true);
        expect(after.localDraftIds.length).toBe(before.localDraftIds.length + 1);
        expect(after.canonicalDigest).toBe(before.canonicalDigest);
        expect(after.gitHead).toBe(before.gitHead);
        expect(after.gitIndexDigest).toBe(before.gitIndexDigest);
        expect(after.gitStatusDigest).toBe(before.gitStatusDigest);
      });
    });

    it("rolls a failed post-preview v3 migration back to the exact v3 state", async () => {
      await withHarness("legacy-v3-invalid", async ({
        port,
        makeCommand,
        snapshot,
        inspectLocalSchema,
        armLegacyMigrationFailure,
      }) => {
        const preview = await port.preview(await makeCommand("local-draft-create"));
        const before = await snapshot();
        const beforeSchema = await inspectLocalSchema();
        expect(beforeSchema.version).toBe(3);

        await armLegacyMigrationFailure();
        await expectCode(
          () => port.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "VALIDATION_FAILED",
        );

        expect(await inspectLocalSchema()).toEqual(beforeSchema);
        expect(await snapshot()).toEqual(before);
      });
    });

    // The real 4,097-entry fixture passes serially; allow disk contention in parallel runs.
    it("fails closed at a bounded source ceiling without returning a trusted partial corpus", { timeout: 60_000, retry: 1 }, async () => {
      await withHarness("source-bound", async ({ port, snapshot }) => {
        const before = await snapshot();
        const error = await captureError(() => port.listArtifacts({
          limit: TEAM_READ_LIMITS.maxPageSize,
        }));
        expect(errorCode(error)).toBe("VALIDATION_FAILED");
        expect(safeErrorBytes(error)).toBeLessThanOrEqual(16 * 1024);
        expect(await snapshot()).toEqual(before);
      });
    });

    it("previews an exact structured canonical change and applies it once", async () => {
      await withHarness("populated", async ({ port, oracle, makeCommand, snapshot }) => {
        const command = await makeCommand("canonical-create");
        const before = await snapshot();
        const preview = await port.preview(command);
        expect(preview).toMatchObject({
          operationId: command.operationId,
          valid: true,
          scope: "canonical",
          localChanges: [],
        });
        expectRevision(preview.previewRevision);
        expect(preview.changes.length).toBeGreaterThan(0);
        expect(preview.diagnostics.length).toBeLessThanOrEqual(
          WORKFLOW_REPOSITORY_LIMITS.maxDiagnostics,
        );
        expect(preview.command).toEqual({
          ...command,
          authority: {
            actor: oracle.configuredActor,
            occurredAt: oracle.fixedNow,
            repoState: oracle.repositoryState,
          },
        });
        expect(await port.preview(command)).toEqual(preview);
        expect(await snapshot()).toEqual(before);

        const result = await port.apply({
          command: preview.command,
          expectedPreviewRevision: preview.previewRevision,
        });
        expect(result).toMatchObject({
          operationId: command.operationId,
          previewRevision: preview.previewRevision,
          applied: true,
          idempotentReplay: false,
        });
        expect(result.changes).toEqual(preview.changes);
        expect(result.localChanges).toEqual(preview.localChanges);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
          actor: preview.command.authority.actor,
          timestamp: preview.command.authority.occurredAt,
          repoState: preview.command.authority.repoState,
        });

        const after = await snapshot();
        expect(after.canonicalDigest).not.toBe(before.canonicalDigest);
        expect(after.gitHead).toBe(before.gitHead);
        expect(after.gitIndexDigest).toBe(before.gitIndexDigest);
        expect(after.gitStatusDigest).not.toBe(before.gitStatusDigest);
        expect(after.wikiIndexDigest).toBe(before.wikiIndexDigest);
        expect(after.localDraftIds).toEqual(before.localDraftIds);
        expect(activityIds(after)).toEqual([
          ...activityIds(before),
          result.events[0]!.id,
        ].sort(compareCodePoints));
        const storedEvent = after.activities.find((event) => event.id === result.events[0]!.id);
        expect(storedEvent).toMatchObject(result.events[0]!);
        expect(storedEvent?.sourcePath).toMatch(/^\.mex\/events\/activity\//);
        expectRevision(storedEvent?.revision ?? "");
      });
    });

    it("keeps local draft mutations out of Git and canonical Activity", async () => {
      await withHarness("populated", async ({ port, makeCommand, snapshot }) => {
        const command = await makeCommand("local-draft-create");
        const before = await snapshot();
        const preview = await port.preview(command);
        expect(preview).toMatchObject({
          valid: true,
          scope: "local",
          changes: [],
        });
        expect(preview.localChanges.length).toBeGreaterThan(0);
        expect(await snapshot()).toEqual(before);

        const result = await port.apply({
          command: preview.command,
          expectedPreviewRevision: preview.previewRevision,
        });
        const after = await snapshot();
        expect(result.events).toEqual([]);
        expect(result.changes).toEqual([]);
        expect(after.canonicalDigest).toBe(before.canonicalDigest);
        expect(after.gitHead).toBe(before.gitHead);
        expect(after.gitIndexDigest).toBe(before.gitIndexDigest);
        expect(after.gitStatusDigest).toBe(before.gitStatusDigest);
        expect(after.wikiCanonicalDigest).toBe(before.wikiCanonicalDigest);
        expect(after.wikiIndexDigest).toBe(before.wikiIndexDigest);
        expect(activityIds(after)).toEqual(activityIds(before));
        expect(after.localStateDigest).not.toBe(before.localStateDigest);
        expect(after.localDraftIds.length).toBe(before.localDraftIds.length + 1);
      });
    });

    it("requires the expected revision of every existing target", async () => {
      await withHarness("populated", async ({
        port,
        makeInvalidCommand,
        makeCommand,
        makeConcurrentTargetEdit,
        snapshot,
      }) => {
        for (const kind of [
          "missing-target-expectation",
          "unrelated-target-expectation",
        ] as const) {
          const before = await snapshot();
          await expectCode(
            () => previewUnknown(port, makeInvalidCommand(kind)),
            "VALIDATION_FAILED",
          );
          expect(await snapshot()).toEqual(before);
        }

        const command = await makeCommand("canonical-update");
        const preview = await port.preview(command);
        await makeConcurrentTargetEdit();
        const afterConcurrentEdit = await snapshot();
        await expectCode(
          () => port.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "REVISION_CONFLICT",
        );
        expect(await snapshot()).toEqual(afterConcurrentEdit);
      });
    });

    it("rejects a wrong preview revision before any effect", async () => {
      await withHarness("populated", async ({ port, makeCommand, snapshot }) => {
        const preview = await port.preview(await makeCommand("canonical-create"));
        const before = await snapshot();
        await expectCode(
          () => port.apply({
            command: preview.command,
            expectedPreviewRevision: differentRevision(preview.previewRevision),
          }),
          "REVISION_CONFLICT",
        );
        expect(await snapshot()).toEqual(before);
      });
    });

    it("revalidates a checkout-local draft revision before mixed publication", async () => {
      await withHarness("local-drift", async ({
        port,
        makeCommand,
        makeConcurrentDraftEdit,
        snapshot,
      }) => {
        const preview = await port.preview(await makeCommand("mixed-publish"));
        await makeConcurrentDraftEdit();
        const afterConcurrentEdit = await snapshot();
        await expectCode(
          () => port.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "REVISION_CONFLICT",
        );
        expect(await snapshot()).toEqual(afterConcurrentEdit);
      });
    });

    it("makes exact replay idempotent and rejects operation-ID reuse or altered authority", async () => {
      await withHarness("populated", async ({
        port,
        makeCommand,
        alterPreparedCommand,
        restart,
        snapshot,
      }) => {
        const preview = await port.preview(await makeCommand("canonical-create"));
        const request = {
          command: preview.command,
          expectedPreviewRevision: preview.previewRevision,
        };
        const first = await port.apply(request);
        const afterFirst = await snapshot();
        const replay = await port.apply(request);
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.operationId).toBe(first.operationId);
        expect(replay.previewRevision).toBe(first.previewRevision);
        expect(await snapshot()).toEqual(afterFirst);

        const restarted = await restart();
        const restartedReplay = await restarted.apply(request);
        expect(restartedReplay.idempotentReplay).toBe(true);
        expect(await snapshot()).toEqual(afterFirst);

        for (const alteration of ["intent", "actor", "time", "repo-state"] as const) {
          const changed = await alterPreparedCommand(preview.command, alteration);
          expect(changed.operationId).toBe(preview.command.operationId);
          await expectOneOfCodes(
            () => restarted.apply({
              command: changed,
              expectedPreviewRevision: preview.previewRevision,
            }),
            ["VALIDATION_FAILED", "REVISION_CONFLICT"],
          );
          expect(await snapshot()).toEqual(afterFirst);
        }
      });
    });

    it("does not accept caller-forged actor, timestamp, or repository state", async () => {
      await withHarness("populated", async ({ port, makeInvalidCommand, snapshot }) => {
        for (const kind of [
          "forged-actor",
          "forged-time",
          "forged-repo-state",
        ] as const) {
          const before = await snapshot();
          await expectCode(
            () => previewUnknown(port, makeInvalidCommand(kind)),
            "VALIDATION_FAILED",
          );
          expect(await snapshot()).toEqual(before);
        }
      });
    });

    it("revalidates service-owned repository authority at apply time", async () => {
      await withHarness("authority-drift", async ({
        port,
        makeCommand,
        makeRepositoryStateChange,
        snapshot,
      }) => {
        const preview = await port.preview(await makeCommand("canonical-create"));
        await makeRepositoryStateChange();
        const afterDrift = await snapshot();
        await expectCode(
          () => port.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "REVISION_CONFLICT",
        );
        expect(await snapshot()).toEqual(afterDrift);
      });
    });

    it("uses a fresh exact behavioral-Wiki preview and emits one Activity on approval", async () => {
      await withHarness("mock-wiki", async ({ port, makeCommand, snapshot }) => {
        const before = await snapshot();
        const preview = await port.preview(await makeCommand("wiki-approve"));
        expect(preview).toMatchObject({ valid: true, scope: "canonical" });
        expect(await snapshot()).toEqual(before);
        const request = {
          command: preview.command,
          expectedPreviewRevision: preview.previewRevision,
        };
        const result = await port.apply(request);
        const after = await snapshot();
        expect(result.events).toHaveLength(1);
        expect(after.activities.length).toBe(before.activities.length + 1);
        expect(after.wikiCanonicalDigest).not.toBe(before.wikiCanonicalDigest);
        expect(after.wikiIndexDigest).not.toBe(before.wikiIndexDigest);
        expect((await port.apply(request)).idempotentReplay).toBe(true);
        expect(await snapshot()).toEqual(after);
      });
    });

    it("rejects a stale Wiki target atomically after approval preview", async () => {
      await withHarness("mock-wiki-stale", async ({
        port,
        makeCommand,
        makeWikiTargetEdit,
        snapshot,
      }) => {
        const preview = await port.preview(await makeCommand("wiki-approve"));
        await makeWikiTargetEdit();
        const afterConcurrentEdit = await snapshot();
        await expectCode(
          () => port.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "REVISION_CONFLICT",
        );
        expect(await snapshot()).toEqual(afterConcurrentEdit);
      });
    });

    it("requires a fresh Wiki preview after restart when nothing was published", async () => {
      await withHarness("mock-wiki-restart", async ({
        port,
        makeCommand,
        restart,
        snapshot,
      }) => {
        const preview = await port.preview(await makeCommand("wiki-approve"));
        const beforeRestart = await snapshot();
        const restarted = await restart();
        await expectOneOfCodes(
          () => restarted.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          ["OPERATION_INTERRUPTED", "REVISION_CONFLICT"],
        );
        expect(await snapshot()).toEqual(beforeRestart);
        expect((await restarted.preview(await makeCommand("wiki-approve"))).valid).toBe(true);
      });
    });

    for (const phase of TEAM_WORKFLOW_CONTRACT_PHASES) {
      it(`recovers an interrupted mixed workflow at ${phase} without duplicate effects`, async () => {
        await withHarness(`recovery:${phase}`, async (harness) => {
          const { port, makeCommand, snapshot, inspectJournal } = harness;
          const preview = await port.preview(await makeCommand("mixed-publish"));
          expect(preview.scope).toBe("mixed");
          expect(preview.changes.length).toBeGreaterThan(0);
          expect(preview.localChanges.length).toBeGreaterThan(0);
          const before = await snapshot();
          await harness.armPhaseFailure(phase);

          await expectCode(
            () => port.apply({
              command: preview.command,
              expectedPreviewRevision: preview.previewRevision,
            }),
            "OPERATION_INTERRUPTED",
          );
          const interrupted = await snapshot();
          const journal = await inspectJournal();
          expect(journal.incompleteCount).toBe(1);
          expect(journal.operationIds).toContain(preview.operationId);

          assertInterruptedVisibility(phase, before, interrupted);
          assertJournalBoundsAndPrivacy(journal, harness.oracle);

          const restarted = await harness.restart();
          const recovered = await restarted.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          });
          expect(recovered.applied).toBe(true);
          const afterRecovery = await snapshot();
          expect(afterRecovery.artifactIds.length).toBe(before.artifactIds.length + 1);
          expect(afterRecovery.localDraftIds.length).toBe(before.localDraftIds.length - 1);
          expect(afterRecovery.activities.length).toBe(before.activities.length + 1);
          expect(afterRecovery.gitHead).toBe(before.gitHead);
          expect(afterRecovery.gitIndexDigest).toBe(before.gitIndexDigest);
          expect(afterRecovery.wikiIndexDigest).toBe(before.wikiIndexDigest);
          expect((await inspectJournal()).incompleteCount).toBe(0);

          const afterExactRecovery = await snapshot();
          const replay = await restarted.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          });
          expect(replay.idempotentReplay).toBe(true);
          expect(await snapshot()).toEqual(afterExactRecovery);
        });
      });
    }

    it("refuses post-publication recovery after branch or HEAD drift", async () => {
      await withHarness("recovery-repository-drift", async (harness) => {
        const preview = await harness.port.preview(await harness.makeCommand("mixed-publish"));
        await harness.armPhaseFailure("after-canonical-publication");
        await expectCode(
          () => harness.port.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "OPERATION_INTERRUPTED",
        );
        await harness.makeRepositoryStateChange();
        const afterDrift = await harness.snapshot();
        const restarted = await harness.restart();
        await expectCode(
          () => restarted.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "REVISION_CONFLICT",
        );
        expect(await harness.snapshot()).toEqual(afterDrift);
      });
    });

    it("refuses recovery when an already-published canonical effect was altered", async () => {
      await withHarness("recovery-primary-tamper", async (harness) => {
        const preview = await harness.port.preview(await harness.makeCommand("mixed-publish"));
        await harness.armPhaseFailure("after-canonical-publication");
        await expectCode(
          () => harness.port.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "OPERATION_INTERRUPTED",
        );
        await harness.tamperPublishedCanonicalEffect();
        const afterTamper = await harness.snapshot();
        const restarted = await harness.restart();
        await expectOneOfCodes(
          () => restarted.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          ["REVISION_CONFLICT", "INDEX_CORRUPT"],
        );
        expect(await harness.snapshot()).toEqual(afterTamper);
      });
    });

    it("serializes writers with one repository Team workflow lease", async () => {
      await withHarness("lease-contention", async (harness) => {
        const { port, makeCommand, snapshot } = harness;
        const preview = await port.preview(await makeCommand("canonical-create"));
        const before = await snapshot();
        const pause = await harness.pauseAtPhase("before-canonical-publication");
        const firstApply = port.apply({
          command: preview.command,
          expectedPreviewRevision: preview.previewRevision,
        });
        await pause.reached;
        const contender = await harness.contendingPort();
        let contentionAssertion: { error: unknown } | null = null;
        try {
          const whileHeld = await snapshot();
          await expectCode(
            () => contender.apply({
              command: preview.command,
              expectedPreviewRevision: preview.previewRevision,
            }),
            "OPERATION_INTERRUPTED",
          );
          expect(await snapshot()).toEqual(whileHeld);
        } catch (error) {
          contentionAssertion = { error };
        } finally {
          pause.release();
        }

        const result = await firstApply;
        if (contentionAssertion !== null) throw contentionAssertion.error;
        expect(result.idempotentReplay).toBe(false);
        expect((await snapshot()).activities.length).toBe(before.activities.length + 1);
      });
    });

    for (const target of ["canonical", "activity", "local"] as const) {
      it(`rejects an escaping ${target} storage ancestor without outside writes`, async () => {
        await withHarness(`containment:${target}`, async ({
          port,
          makeCommand,
          installEscapingAncestor,
          snapshot,
        }) => {
          const commandCase = target === "local" ? "local-draft-create" : "canonical-create";
          const preview = await port.preview(await makeCommand(commandCase));
          await installEscapingAncestor(target);
          const afterAttack = await snapshot();
          await expectCode(
            () => port.apply({
              command: preview.command,
              expectedPreviewRevision: preview.previewRevision,
            }),
            "PATH_OUTSIDE_PROJECT",
          );
          expect(await snapshot()).toEqual(afterAttack);
        });
      });
    }

    it("fails closed if the canonical project root is swapped after preview", async () => {
      await withHarness("root-swap", async ({
        port,
        makeCommand,
        swapProjectRoot,
        snapshot,
      }) => {
        const preview = await port.preview(await makeCommand("canonical-create"));
        await swapProjectRoot();
        const afterSwap = await snapshot();
        await expectOneOfCodes(
          () => port.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          ["PATH_OUTSIDE_PROJECT", "REVISION_CONFLICT"],
        );
        expect(await snapshot()).toEqual(afterSwap);
      });
    });

    it("keeps the bounded journal metadata-only and leaves reads/previews nonmutating", async () => {
      await withHarness("recovery:after-canonical-publication", async (harness) => {
        const beforeReads = await harness.snapshot();
        await harness.port.resolveActor();
        await harness.port.listArtifacts();
        await harness.port.listLocalDrafts();
        expect(await harness.snapshot()).toEqual(beforeReads);

        const preview = await harness.port.preview(await harness.makeCommand("mixed-publish"));
        expect(await harness.snapshot()).toEqual(beforeReads);
        expect((await harness.inspectJournal()).incompleteCount).toBe(0);

        await harness.armPhaseFailure("after-canonical-publication");
        await expectCode(
          () => harness.port.apply({
            command: preview.command,
            expectedPreviewRevision: preview.previewRevision,
          }),
          "OPERATION_INTERRUPTED",
        );
        assertJournalBoundsAndPrivacy(await harness.inspectJournal(), harness.oracle);
      });
    });

    it("keeps canonical team memory portable while local drafts and journals stay clone-local", async () => {
      await withHarness("two-clone", async (harness) => {
        const peer = await harness.peerPort();
        const initialPrimary = await harness.snapshot();
        const initialPeer = await harness.peerSnapshot();
        const primaryCanonical = await harness.port.preview(
          await harness.makeCommand("canonical-create"),
        );
        const peerCanonical = await peer.preview(
          await harness.makePeerCommand("canonical-create"),
        );
        expect(primaryCanonical.operationId).not.toBe(peerCanonical.operationId);

        await harness.port.apply({
          command: primaryCanonical.command,
          expectedPreviewRevision: primaryCanonical.previewRevision,
        });
        await peer.apply({
          command: peerCanonical.command,
          expectedPreviewRevision: peerCanonical.previewRevision,
        });
        const local = await harness.port.preview(
          await harness.makeCommand("local-draft-create"),
        );
        await harness.port.apply({
          command: local.command,
          expectedPreviewRevision: local.previewRevision,
        });

        const beforeSyncPrimary = await harness.snapshot();
        const beforeSyncPeer = await harness.peerSnapshot();
        const primaryArtifactAdds = difference(
          beforeSyncPrimary.artifactIds,
          initialPrimary.artifactIds,
        );
        const peerArtifactAdds = difference(beforeSyncPeer.artifactIds, initialPeer.artifactIds);
        const primaryActivityAdds = difference(
          activityIds(beforeSyncPrimary),
          activityIds(initialPrimary),
        );
        const peerActivityAdds = difference(activityIds(beforeSyncPeer), activityIds(initialPeer));
        expect(primaryArtifactAdds).toHaveLength(1);
        expect(peerArtifactAdds).toHaveLength(1);
        expect(intersection(primaryArtifactAdds, peerArtifactAdds)).toEqual([]);
        expect(primaryActivityAdds).toHaveLength(1);
        expect(peerActivityAdds).toHaveLength(1);
        expect(intersection(primaryActivityAdds, peerActivityAdds)).toEqual([]);
        const primaryLocalIds = beforeSyncPrimary.localDraftIds;
        expect(primaryLocalIds.length).toBeGreaterThan(beforeSyncPeer.localDraftIds.length);
        await harness.synchronizeClones();

        const afterPrimary = await harness.snapshot();
        const afterPeer = await harness.peerSnapshot();
        expect(afterPrimary.canonicalDigest).toBe(afterPeer.canonicalDigest);
        expect(afterPrimary.artifactIds).toEqual(afterPeer.artifactIds);
        expect(activityIds(afterPrimary)).toEqual(activityIds(afterPeer));
        expect(afterPrimary.artifactIds).toEqual(
          union(beforeSyncPrimary.artifactIds, beforeSyncPeer.artifactIds),
        );
        expect(afterPrimary.localDraftIds).toEqual(primaryLocalIds);
        expect(afterPeer.localDraftIds).toEqual(beforeSyncPeer.localDraftIds);
        expect(afterPrimary.gitTrackedPaths.some((path) => path === ".mex/local"
          || path.startsWith(".mex/local/"))).toBe(false);
        expect(afterPeer.gitTrackedPaths.some((path) => path === ".mex/local"
          || path.startsWith(".mex/local/"))).toBe(false);

        const primaryJournal = await harness.inspectJournal();
        const peerJournal = await harness.inspectPeerJournal();
        expect(primaryJournal.operationIds).toContain(primaryCanonical.operationId);
        expect(primaryJournal.operationIds).not.toContain(peerCanonical.operationId);
        expect(peerJournal.operationIds).toContain(peerCanonical.operationId);
        expect(peerJournal.operationIds).not.toContain(primaryCanonical.operationId);
      });
    });

    it("runs one approval through the real Wiki adapter without replaying its mutation", async () => {
      await withHarness("real-wiki", async ({ port, makeCommand, snapshot }) => {
        const beforePreview = await snapshot();
        const preview = await port.preview(await makeCommand("wiki-approve"));
        expect(preview.valid).toBe(true);
        expect(preview.scope).toBe("canonical");
        const before = await snapshot();
        expect(before).toEqual(beforePreview);
        const request = {
          command: preview.command,
          expectedPreviewRevision: preview.previewRevision,
        };
        const result = await port.apply(request);
        const after = await snapshot();
        expect(result.events).toHaveLength(1);
        expect(after.wikiCanonicalDigest).not.toBe(before.wikiCanonicalDigest);
        expect(after.wikiIndexDigest).not.toBe(before.wikiIndexDigest);
        expect(after.canonicalDigest).not.toBe(before.canonicalDigest);
        expect(after.gitHead).toBe(before.gitHead);
        expect(after.gitIndexDigest).toBe(before.gitIndexDigest);
        expect(after.activities.length).toBe(before.activities.length + 1);
        expect((await port.apply(request)).idempotentReplay).toBe(true);
        expect(await snapshot()).toEqual(after);
      });
    });
  });
}

function assertInterruptedVisibility(
  phase: TeamWorkflowContractPhase,
  before: TeamWorkflowContractSnapshot,
  interrupted: TeamWorkflowContractSnapshot,
): void {
  const canonicalPublished = phase !== "before-canonical-publication";
  const activityPublished = phase === "after-activity-publication"
    || phase === "after-local-cleanup";
  const localCleaned = phase === "after-local-cleanup";

  expect(interrupted.artifactIds.length).toBe(
    before.artifactIds.length + (canonicalPublished ? 1 : 0),
  );
  expect(interrupted.activities.length).toBe(
    before.activities.length + (activityPublished ? 1 : 0),
  );
  expect(interrupted.localDraftIds.length).toBe(
    before.localDraftIds.length - (localCleaned ? 1 : 0),
  );
  if (!canonicalPublished) {
    expect(interrupted.canonicalDigest).toBe(before.canonicalDigest);
    expect(interrupted.gitStatusDigest).toBe(before.gitStatusDigest);
  }
  expect(interrupted.gitHead).toBe(before.gitHead);
  expect(interrupted.gitIndexDigest).toBe(before.gitIndexDigest);
  expect(interrupted.wikiIndexDigest).toBe(before.wikiIndexDigest);
  expect(interrupted.outsideDigest).toBe(before.outsideDigest);
}

function assertJournalBoundsAndPrivacy(
  journal: TeamWorkflowJournalInspection,
  oracle: TeamWorkflowContractOracle,
): void {
  expect(journal.rowCount).toBeLessThanOrEqual(
    TEAM_LOCAL_STATE_LIMITS.terminalWorkflowRetention + 1,
  );
  expect(journal.rows).toHaveLength(journal.rowCount);
  expect(journal.durableStorageBytes).toBeLessThanOrEqual(
    (TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffectBytes
      * (TEAM_LOCAL_STATE_LIMITS.terminalWorkflowRetention + 1))
      + (4 * 1024 * 1024),
  );
  expect(journal.durableStorageForbiddenMatches).toEqual([]);
  for (const row of journal.rows) {
    expect(row.effectCount).toBeLessThanOrEqual(TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffects);
    expect(row.effectJsonBytes).toBe(Buffer.byteLength(row.serializedEffects, "utf8"));
    expect(row.effectJsonBytes).toBeLessThanOrEqual(
      TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffectBytes,
    );
    expect(Buffer.byteLength(row.serializedRow, "utf8")).toBeLessThanOrEqual(
      TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffectBytes + (8 * 1024),
    );
    for (const sentinel of [...oracle.journalPrivacySentinels, oracle.projectRoot]) {
      expect(row.serializedRow).not.toContain(sentinel);
    }
    expect(row.serializedRow).not.toMatch(/(?:^|["'])\/(?:Users|home|private|tmp)\//);
    expect(row.serializedRow).not.toMatch(/(?:sourceBody|prompt|transcript|diff|handle|credential|rawError)/i);
  }
}

async function previewUnknown<TWikiOperationPlan>(
  port: TeamWorkflowPort<TWikiOperationPlan>,
  command: Promise<unknown>,
): Promise<unknown> {
  return port.preview(await command as TeamWorkflowCommand<TWikiOperationPlan>);
}

function ids<TWikiOperationPlan>(
  artifacts: readonly TeamArtifact<TWikiOperationPlan>[],
): readonly string[] {
  return artifacts.map((artifact) => artifact.ref.id);
}

function activityIds(snapshot: TeamWorkflowContractSnapshot): readonly string[] {
  return snapshot.activities.map((event) => event.id).sort(compareCodePoints);
}

function artifactState<TWikiOperationPlan>(
  artifact: TeamArtifact<TWikiOperationPlan>,
): TeamArtifactState | undefined {
  return "state" in artifact ? artifact.state : undefined;
}

function intersection(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).sort(compareCodePoints);
}

function difference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item)).sort(compareCodePoints);
}

function union(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])].sort(compareCodePoints);
}

function differentRevision(revision: Revision): Revision {
  const replacement = revision[0] === "0" ? "1" : "0";
  return `${replacement}${revision.slice(1)}`;
}

function expectRevision(value: string): void {
  expect(value).toMatch(/^[a-f0-9]{64}$/);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function captureError<T>(run: () => Promise<T>): Promise<unknown> {
  try {
    await run();
    throw new Error("Expected the operation to fail, but it succeeded.");
  } catch (error) {
    return error;
  }
}

function safeErrorBytes(error: unknown): number {
  if (!error || typeof error !== "object") return Buffer.byteLength(String(error), "utf8");
  const candidate = "problem" in error ? error.problem : error;
  try {
    return Buffer.byteLength(JSON.stringify(candidate), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function expectCode<T>(run: () => Promise<T>, expected: string): Promise<void> {
  await expectOneOfCodes(run, [expected]);
}

async function expectOneOfCodes<T>(
  run: () => Promise<T>,
  expected: readonly string[],
): Promise<void> {
  try {
    await run();
    throw new Error(`Expected ${expected.join(" or ")}, but the operation succeeded.`);
  } catch (error) {
    const code = errorCode(error);
    if (!code || !expected.includes(code)) throw error;
    expect(expected).toContain(code);
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = "code" in error ? error.code : undefined;
  if (typeof direct === "string") return direct;
  if (!("problem" in error) || !error.problem || typeof error.problem !== "object") {
    return undefined;
  }
  const nested = "code" in error.problem ? error.problem.code : undefined;
  return typeof nested === "string" ? nested : undefined;
}
