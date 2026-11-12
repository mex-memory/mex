import { describe, expect, it } from "vitest";
import type { JsonValue, RepoState, Revision, RevisionExpectation } from "../../src/team/contracts/shared.js";
import type {
  ActivityEvent,
  StoredActivityEvent,
  TeamActivityListRequest,
  TeamCurrentActor,
  TeamIdentityActivityCommand,
  TeamIdentityActivityPreviewEnvelope,
  TeamMember,
  TeamMemberListRequest,
  TeamPage,
  TeamWorkflowResult,
} from "../../src/team/contracts/workflow.js";

export type TeamIdentityActivityScenario =
  | "empty"
  | "git-alias"
  | "git-fallback"
  | "unknown"
  | "legacy-v1"
  | "legacy-v2"
  | "legacy-v3";

/** Consumer view of the internal Checkpoint C application service. */
export interface TeamIdentityActivityContractPort {
  getMember(memberId: string): Promise<TeamMember | null>;
  listMembers(request?: TeamMemberListRequest): Promise<TeamPage<TeamMember>>;
  getCurrentActor(): Promise<TeamCurrentActor>;
  getActivity(activityId: string): Promise<StoredActivityEvent | null>;
  listActivity(request?: TeamActivityListRequest): Promise<TeamPage<StoredActivityEvent>>;
  previewIdentityActivity(
    command: TeamIdentityActivityCommand,
  ): Promise<TeamIdentityActivityPreviewEnvelope>;
  applyIdentityActivity(
    envelope: TeamIdentityActivityPreviewEnvelope,
  ): Promise<TeamWorkflowResult<JsonValue>>;
}

export interface TeamIdentityActivitySnapshot {
  canonicalDigest: Revision;
  localDigest: Revision | null;
  localEntries: readonly string[];
  activityIds: readonly string[];
}

export interface SeedMemberRequest {
  id?: string;
  displayName: string;
  active?: boolean;
  gitAliases?: readonly { name?: string | null; email?: string | null }[];
}

export interface TeamIdentityActivityContractHarness {
  port: TeamIdentityActivityContractPort;
  oracle: {
    now: string;
    memberIds: readonly string[];
  };
  seedMember(request: SeedMemberRequest): Promise<TeamMember>;
  snapshot(): Promise<TeamIdentityActivitySnapshot>;
  restart(): Promise<TeamIdentityActivityContractPort>;
  contendingPort(): Promise<TeamIdentityActivityContractPort>;
  setNow(timestamp: string): void;
  setGitIdentity(identity: { name: string | null; email: string | null } | "unavailable"): void;
  setRepoState(patch: Partial<RepoState>): void;
  localSchemaVersion(): number | null;
  installActivitySourceTruncation(): void;
  close(): Promise<void>;
}

export interface TeamIdentityActivityTwoCloneHarness {
  left: TeamIdentityActivityContractHarness;
  right: TeamIdentityActivityContractHarness;
  synchronizeCanonical(): Promise<void>;
  close(): Promise<void>;
}

export interface TeamIdentityActivityContractFactory {
  open(scenario: TeamIdentityActivityScenario): Promise<TeamIdentityActivityContractHarness>;
  openTwoClone(): Promise<TeamIdentityActivityTwoCloneHarness>;
}

export function defineTeamIdentityActivityContract(
  adapterName: string,
  factory: TeamIdentityActivityContractFactory,
  options: { skip?: boolean } = {},
): void {
  const suite = options.skip === true ? describe.skip : describe;

  suite(`${adapterName} identity/activity contract`, () => {
    it("bounds, filters, and revision-binds member reads", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const activeA = await harness.seedMember({
          id: harness.oracle.memberIds[0],
          displayName: "Ada Lovelace",
          active: true,
          gitAliases: [{ name: "Ada", email: "ada@example.test" }],
        });
        const inactive = await harness.seedMember({
          id: harness.oracle.memberIds[1],
          displayName: "Grace Hopper",
          active: false,
        });
        const activeB = await harness.seedMember({
          id: harness.oracle.memberIds[2],
          displayName: "Katherine Johnson",
          active: true,
        });

        await expect(harness.port.getMember(activeA.ref.id)).resolves.toEqual(activeA);
        await expect(harness.port.getMember("member_01ARZ3NDEKTSV4RRFFQ69G5FZZ"))
          .resolves.toBeNull();

        const first = await harness.port.listMembers({ active: true, limit: 1 });
        expect(first.items).toHaveLength(1);
        expect(first.items[0]?.active).toBe(true);
        expect(first.nextCursor).not.toBeNull();
        expect(first.sourceTruncated).toBe(false);

        const second = await harness.port.listMembers({
          active: true,
          limit: 1,
          cursor: first.nextCursor!,
        });
        expect(new Set([...first.items, ...second.items].map((member) => member.ref.id)))
          .toEqual(new Set([activeA.ref.id, activeB.ref.id]));
        await expect(harness.port.listMembers({ active: false, limit: 10 }))
          .resolves.toMatchObject({ items: [expect.objectContaining({ ref: inactive.ref })] });

        await harness.seedMember({
          id: harness.oracle.memberIds[3],
          displayName: "Margaret Hamilton",
          active: true,
        });
        await expect(harness.port.listMembers({
          active: true,
          limit: 1,
          cursor: first.nextCursor!,
        })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });

        await expect(harness.port.listMembers({ limit: 101 }))
          .rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
        await expect(harness.port.listMembers({ cursor: "x".repeat(4_097) }))
          .rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
      });
    });

    it("bounds, filters, and revision-binds Activity reads", async () => {
      await withHarness(factory, "git-fallback", async (harness) => {
        for (const [index, timestamp] of [
          "2026-08-27T04:05:06.000Z",
          "2026-08-27T04:06:00.000Z",
          "2026-08-27T04:07:00.000Z",
        ].entries()) {
          harness.setNow(timestamp);
          await applyPreview(harness.port, {
            operationId: `contract_activity_page_${index}`,
            action: {
              kind: "activity.record",
              activity: { action: `review.page-${index}`, subjects: [] },
            },
            expectedRevisions: [],
          });
        }

        const first = await harness.port.listActivity({ limit: 1 });
        expect(first.items).toHaveLength(1);
        expect(first.items[0]?.action).toBe("review.page-2");
        expect(first.nextCursor).not.toBeNull();
        expect(first.sourceTruncated).toBe(false);

        const second = await harness.port.listActivity({
          limit: 1,
          cursor: first.nextCursor!,
        });
        expect(second.items).toHaveLength(1);
        expect(second.items[0]?.action).toBe("review.page-1");
        await expect(harness.port.listActivity({
          since: "2026-08-27T04:06:00.000Z",
          limit: 10,
        })).resolves.toMatchObject({ items: [
          expect.objectContaining({ action: "review.page-2" }),
          expect.objectContaining({ action: "review.page-1" }),
        ] });

        harness.setNow("2026-08-27T04:08:00.000Z");
        await applyPreview(harness.port, {
          operationId: "contract_activity_cursor_stale",
          action: {
            kind: "activity.record",
            activity: { action: "review.page-new", subjects: [] },
          },
          expectedRevisions: [],
        });
        await expect(harness.port.listActivity({
          limit: 1,
          cursor: first.nextCursor!,
        })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });

        await expect(harness.port.listActivity({ limit: 101 }))
          .rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
        await expect(harness.port.listActivity({ cursor: "x".repeat(4_097) }))
          .rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
        await expect(harness.port.listActivity({ since: "not-a-timestamp" }))
          .rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
      });
    });

    it("keeps selection local until apply, with signer-only preview preparation and no Activity", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const member = await harness.seedMember({
          id: harness.oracle.memberIds[0],
          displayName: "Ada Lovelace",
          active: true,
        });
        const command = selectMember("contract_select_member", member, null);
        const before = await harness.snapshot();
        const envelope = await harness.port.previewIdentityActivity(command);

        expect(envelope).toMatchObject({
          schemaVersion: 1,
          request: command,
          preview: { valid: true, scope: "local", changes: [] },
          receipt: { schemaVersion: 1, purposeIds: [] },
        });
        expect(envelope.preview.localChanges).toEqual([
          expect.objectContaining({
            namespace: "member-selection",
            id: "current",
            beforeRevision: null,
          }),
        ]);
        const prepared = await harness.snapshot();
        expectSignerOnlyPreparation(before, prepared);
        expect(await harness.port.previewIdentityActivity(command)).toEqual(envelope);
        expect(await harness.snapshot()).toEqual(prepared);

        const applied = await harness.port.applyIdentityActivity(jsonRoundTrip(envelope));
        expect(applied.events).toEqual([]);
        expect(applied.changes).toEqual([]);
        expect(await harness.port.listActivity()).toMatchObject({ items: [] });
        const current = await harness.port.getCurrentActor();
        expect(current).toMatchObject({
          source: "configured-member",
          actor: { kind: "member", memberId: member.ref.id, displayName: member.displayName },
          selection: { memberId: member.ref.id },
        });

        const clear = await harness.port.previewIdentityActivity({
          operationId: "contract_clear_member",
          action: { kind: "member.clear" },
          expectedRevisions: [selectionExpectation(current.selection!.revision)],
        });
        const cleared = await harness.port.applyIdentityActivity(jsonRoundTrip(clear));
        expect(cleared.events).toEqual([]);
        expect((await harness.port.getCurrentActor()).selection).toBeNull();
        expect((await harness.port.listActivity()).items).toEqual([]);
      });
    });

    for (const version of [1, 2, 3] as const) {
      it(`reads and previews schema v${version} without mutation, then migrates only on apply`, async () => {
        await withHarness(factory, `legacy-v${version}`, async (harness) => {
          const member = await harness.port.getMember(harness.oracle.memberIds[0]);
          expect(member).not.toBeNull();
          const before = await harness.snapshot();

          await expect(harness.port.getCurrentActor()).resolves.toBeDefined();
          const preview = await harness.port.previewIdentityActivity(
            selectMember(`contract_select_legacy_v${version}`, member!, null),
          );
          const prepared = await harness.snapshot();
          expectSignerOnlyPreparation(before, prepared);
          expect(await harness.port.previewIdentityActivity(
            selectMember(`contract_select_legacy_v${version}`, member!, null),
          )).toEqual(preview);
          expect(await harness.snapshot()).toEqual(prepared);
          expect(harness.localSchemaVersion()).toBe(version);

          await harness.port.applyIdentityActivity(jsonRoundTrip(preview));
          expect(harness.localSchemaVersion()).toBe(4);
          expect((await harness.port.getCurrentActor()).selection?.memberId).toBe(member!.ref.id);
        });
      });
    }

    it("emits exactly one immutable Activity event for each canonical C mutation", async () => {
      await withHarness(factory, "git-fallback", async (harness) => {
        const add = await applyPreview(harness.port, {
          operationId: "contract_member_add",
          action: {
            kind: "member.add",
            member: {
              displayName: "Ada Lovelace",
              gitAliases: [{ name: "Ada", email: "ada@example.test" }],
            },
          },
          expectedRevisions: [],
        });
        expect(add.events).toHaveLength(1);
        expect(add.events[0]?.action).toBe("member.added");
        const member = onlyMember(add);
        expect((await harness.port.listActivity()).items).toHaveLength(1);

        harness.setGitIdentity({ name: "Ada", email: "ada@example.test" });
        const update = await applyPreview(harness.port, {
          operationId: "contract_member_update",
          action: {
            kind: "member.update",
            memberId: member.ref.id,
            patch: { displayName: "Ada King" },
          },
          expectedRevisions: [memberExpectation(member)],
        });
        expect(update.events).toHaveLength(1);
        expect(update.events[0]?.action).toBe("member.updated");
        const updated = onlyMember(update);
        expect((await harness.port.listActivity()).items).toHaveLength(2);

        const recorded = await applyPreview(harness.port, {
          operationId: "contract_activity_record",
          action: {
            kind: "activity.record",
            activity: {
              action: "review.completed",
              subjects: [{ kind: "entity", entity: updated.ref }],
            },
          },
          expectedRevisions: [],
        });
        expect(recorded.artifacts).toEqual([]);
        expect(recorded.events).toHaveLength(1);
        expect(recorded.events[0]?.action).toBe("review.completed");
        expect((await harness.port.listActivity()).items).toHaveLength(3);

        const deactivated = await applyPreview(harness.port, {
          operationId: "contract_member_deactivate",
          action: { kind: "member.deactivate", memberId: updated.ref.id },
          expectedRevisions: [memberExpectation(updated)],
        });
        expect(deactivated.events).toHaveLength(1);
        expect(deactivated.events[0]?.action).toBe("member.deactivated");
        expect(onlyMember(deactivated).active).toBe(false);
        expect((await harness.port.listActivity()).items).toHaveLength(4);
      });
    });

    it("never rewrites an Activity event's recorded actor after aliases or display change", async () => {
      await withHarness(factory, "git-alias", async (harness) => {
        const member = (await harness.port.listMembers({ limit: 10 })).items[0]!;
        const first = await applyPreview(harness.port, {
          operationId: "contract_historical_actor_first",
          action: {
            kind: "member.update",
            memberId: member.ref.id,
            patch: { displayName: "Ada King" },
          },
          expectedRevisions: [memberExpectation(member)],
        });
        const event = first.events[0]!;
        const recorded = await harness.port.getActivity(event.id);

        const updated = onlyMember(first);
        await applyPreview(harness.port, {
          operationId: "contract_historical_actor_second",
          action: {
            kind: "member.update",
            memberId: updated.ref.id,
            patch: {
              displayName: "Ada Byron",
              gitAliases: [{ name: "Ada Byron", email: "ada@example.test" }],
            },
          },
          expectedRevisions: [memberExpectation(updated)],
        });
        expect(await harness.port.getActivity(event.id)).toEqual(recorded);
        expect((await harness.port.getActivity(event.id))?.actor).toEqual(event.actor);
      });
    });

    it("reports configured, alias, Git fallback, and unknown actor sources honestly", async () => {
      await withHarness(factory, "git-alias", async (harness) => {
        await expect(harness.port.getCurrentActor()).resolves.toMatchObject({
          source: "git-alias",
          actor: { kind: "member" },
          selection: null,
        });
      });
      await withHarness(factory, "git-fallback", async (harness) => {
        await expect(harness.port.getCurrentActor()).resolves.toMatchObject({
          source: "git-fallback",
          actor: { kind: "git" },
          selection: null,
        });
      });
      await withHarness(factory, "unknown", async (harness) => {
        await expect(harness.port.getCurrentActor()).resolves.toMatchObject({
          source: "unknown",
          actor: { kind: "unknown" },
          selection: null,
        });
      });
    });

    it("round-trips the portable JSON envelope across service instances", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const before = await harness.snapshot();
        const preview = await harness.port.previewIdentityActivity({
          operationId: "contract_cross_process_apply",
          action: {
            kind: "member.add",
            member: { displayName: "Portable member", gitAliases: [] },
          },
          expectedRevisions: [],
        });
        expect(Buffer.byteLength(JSON.stringify(preview), "utf8")).toBeLessThanOrEqual(64 * 1024);
        expect(Buffer.byteLength(JSON.stringify(preview.receipt), "utf8"))
          .toBeLessThanOrEqual(8 * 1024);
        const prepared = await harness.snapshot();
        expectSignerOnlyPreparation(before, prepared);
        expect(await harness.port.previewIdentityActivity(preview.request)).toEqual(preview);
        expect(await harness.snapshot()).toEqual(prepared);

        const restarted = await harness.restart();
        const result = await restarted.applyIdentityActivity(jsonRoundTrip(preview));
        expect(result.idempotentReplay).toBe(false);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]?.id).toBe(purposeId(preview, "activity"));
        expect(onlyMember(result).ref.id).toBe(purposeId(preview, "member"));

        const replayed = await (await harness.restart()).applyIdentityActivity(
          jsonRoundTrip(preview),
        );
        expect(replayed.idempotentReplay).toBe(true);
        expect((await harness.port.listActivity()).items).toHaveLength(1);
      });
    });

    it("rejects envelope tampering, stale authority, and expiry without writes", async () => {
      const mutations: Array<[
        string,
        (value: TeamIdentityActivityPreviewEnvelope) => void,
      ]> = [
        ["request", (value) => {
          const action = value.request.action;
          if (action.kind === "member.add") action.member.displayName = "Tampered";
        }],
        ["visible preview", (value) => {
          (value.preview as { scope: string }).scope = "local";
        }],
        ["actor", (value) => {
          value.receipt.authority.actor = { kind: "unknown" };
        }],
        ["timestamp", (value) => {
          value.receipt.authority.occurredAt = "2000-01-01T00:00:00.000Z";
        }],
        ["repository", (value) => {
          value.receipt.authority.repoState.dirty = !value.receipt.authority.repoState.dirty;
        }],
        ["purpose IDs", (value) => {
          value.receipt.purposeIds = [];
        }],
        ["request revision", (value) => {
          value.receipt.requestRevision = "f".repeat(64) as Revision;
        }],
        ["presentation revision", (value) => {
          value.receipt.presentationRevision = "f".repeat(64) as Revision;
        }],
        ["preview revision", (value) => {
          value.receipt.previewRevision = "f".repeat(64) as Revision;
        }],
      ];

      for (const [label, mutate] of mutations) {
        await withHarness(factory, "empty", async (harness) => {
          const envelope = await harness.port.previewIdentityActivity({
            operationId: `contract_tamper_${label.replaceAll(" ", "_")}`,
            action: {
              kind: "member.add",
              member: { displayName: "Untampered", gitAliases: [] },
            },
            expectedRevisions: [],
          });
          const before = await harness.snapshot();
          const altered = jsonRoundTrip(envelope);
          mutate(altered);
          await expectRefusal((await harness.restart()).applyIdentityActivity(altered));
          expect(await harness.snapshot()).toEqual(before);
        });
      }

      await withHarness(factory, "empty", async (harness) => {
        const envelope = await harness.port.previewIdentityActivity({
          operationId: "contract_stale_repository",
          action: { kind: "activity.record", activity: { action: "review.started", subjects: [] } },
          expectedRevisions: [],
        });
        const before = await harness.snapshot();
        harness.setRepoState({ dirty: true });
        await expectRefusal((await harness.restart()).applyIdentityActivity(envelope));
        expect(await harness.snapshot()).toEqual(before);
      });

      await withHarness(factory, "empty", async (harness) => {
        const envelope = await harness.port.previewIdentityActivity({
          operationId: "contract_expired_preview",
          action: { kind: "activity.record", activity: { action: "review.expired", subjects: [] } },
          expectedRevisions: [],
        });
        const before = await harness.snapshot();
        harness.setNow("2026-08-27T04:36:00.001Z");
        await expectRefusal((await harness.restart()).applyIdentityActivity(envelope));
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("rejects altered operation reuse and converges under same-receipt contention", async () => {
      await withHarness(factory, "empty", async (harness) => {
        const envelope = await harness.port.previewIdentityActivity({
          operationId: "contract_contended_receipt",
          action: { kind: "activity.record", activity: { action: "review.contended", subjects: [] } },
          expectedRevisions: [],
        });
        const firstPort = await harness.restart();
        const secondPort = await harness.contendingPort();
        const outcomes = await Promise.allSettled([
          firstPort.applyIdentityActivity(jsonRoundTrip(envelope)),
          secondPort.applyIdentityActivity(jsonRoundTrip(envelope)),
        ]);
        expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);

        const replay = await (await harness.restart()).applyIdentityActivity(
          jsonRoundTrip(envelope),
        );
        expect(replay.idempotentReplay).toBe(true);
        expect((await harness.port.listActivity()).items).toHaveLength(1);

        const altered = await (await harness.restart()).previewIdentityActivity({
          operationId: envelope.request.operationId,
          action: { kind: "activity.record", activity: { action: "review.altered", subjects: [] } },
          expectedRevisions: [],
        });
        await expect((await harness.restart()).applyIdentityActivity(altered))
          .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
      });
    });

    it("converges canonical members across two clones without converging local selection", async () => {
      const clones = await factory.openTwoClone();
      try {
        const leftMember = await applyPreview(clones.left.port, {
          operationId: "contract_clone_left_member",
          action: { kind: "member.add", member: { displayName: "Left", gitAliases: [] } },
          expectedRevisions: [],
        }).then(onlyMember);
        const rightMember = await applyPreview(clones.right.port, {
          operationId: "contract_clone_right_member",
          action: { kind: "member.add", member: { displayName: "Right", gitAliases: [] } },
          expectedRevisions: [],
        }).then(onlyMember);

        await applyPreview(clones.left.port, selectMember(
          "contract_clone_left_selection",
          leftMember,
          null,
        ));
        await applyPreview(clones.right.port, selectMember(
          "contract_clone_right_selection",
          rightMember,
          null,
        ));
        await clones.synchronizeCanonical();

        const leftMembers = await clones.left.port.listMembers({ limit: 10 });
        const rightMembers = await clones.right.port.listMembers({ limit: 10 });
        expect(leftMembers.items.map((member) => member.ref.id).sort())
          .toEqual(rightMembers.items.map((member) => member.ref.id).sort());
        expect(leftMembers.items).toHaveLength(2);
        expect((await clones.left.port.getCurrentActor()).selection?.memberId)
          .toBe(leftMember.ref.id);
        expect((await clones.right.port.getCurrentActor()).selection?.memberId)
          .toBe(rightMember.ref.id);
      } finally {
        await clones.close();
      }
    });

    // Creating and inspecting 4,097 real directories measured 44.7s serially on Windows.
    it("fails closed when the canonical Activity source exceeds its scan bound", { timeout: 120_000, retry: 1 }, async () => {
      await withHarness(factory, "empty", async (harness) => {
        harness.installActivitySourceTruncation();
        await expectRefusal(harness.port.listActivity({ limit: 1 }));
        await expectRefusal(harness.port.getActivity("event_01ARZ3NDEKTSV4RRFFQ69G5FAB"));
      });
    });
  });
}

function memberExpectation(member: TeamMember): RevisionExpectation {
  return {
    target: { kind: "artifact", path: member.sourcePath },
    revision: member.revision,
  };
}

function selectionExpectation(revision: Revision | null): RevisionExpectation {
  return {
    target: { kind: "local", namespace: "member-selection", id: "current" },
    revision,
  };
}

function expectSignerOnlyPreparation(
  before: TeamIdentityActivitySnapshot,
  after: TeamIdentityActivitySnapshot,
): void {
  expect(after.canonicalDigest).toBe(before.canonicalDigest);
  expect(after.activityIds).toEqual(before.activityIds);
  const stableLocal = (snapshot: TeamIdentityActivitySnapshot) => snapshot.localEntries.filter(
    (entry) => !entry.startsWith("D:.mex/local:")
      && !entry.startsWith("F:.mex/local/identity-activity-signing.key:"),
  );
  expect(stableLocal(after)).toEqual(stableLocal(before));
  expect(after.localEntries).toEqual(expect.arrayContaining([
    expect.stringMatching(/^F:\.mex\/local\/identity-activity-signing\.key:32:/u),
  ]));
}

function selectMember(
  operationId: string,
  member: TeamMember,
  selectionRevision: Revision | null,
): TeamIdentityActivityCommand {
  return {
    operationId,
    action: { kind: "member.select", memberId: member.ref.id },
    expectedRevisions: [memberExpectation(member), selectionExpectation(selectionRevision)],
  };
}

async function applyPreview(
  port: TeamIdentityActivityContractPort,
  command: TeamIdentityActivityCommand,
): Promise<TeamWorkflowResult<JsonValue>> {
  return port.applyIdentityActivity(jsonRoundTrip(
    await port.previewIdentityActivity(command),
  ));
}

function onlyMember(result: TeamWorkflowResult<JsonValue>): TeamMember {
  expect(result.artifacts).toHaveLength(1);
  const member = result.artifacts[0];
  if (member?.kind !== "member") throw new Error("Expected one member artifact.");
  return member;
}

function purposeId(
  envelope: TeamIdentityActivityPreviewEnvelope,
  purpose: "activity" | "member",
): string {
  const value = envelope.receipt.purposeIds.find((candidate) => candidate.purpose === purpose);
  if (value === undefined) throw new Error(`Missing ${purpose} purpose ID.`);
  return value.id;
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function expectRefusal(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("Expected the operation to be refused.");
  } catch (error) {
    if (error instanceof Error && error.message === "Expected the operation to be refused.") {
      throw error;
    }
    expect(error).toMatchObject({
      problem: {
        code: expect.stringMatching(
          /^(?:INVALID_REQUEST|VALIDATION_FAILED|REVISION_CONFLICT|OPERATION_INTERRUPTED)$/,
        ),
      },
    });
  }
}

async function withHarness(
  factory: TeamIdentityActivityContractFactory,
  scenario: TeamIdentityActivityScenario,
  run: (harness: TeamIdentityActivityContractHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory.open(scenario);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

// Compile-time guard: Activity result events remain immutable storage values,
// not mutable effective-actor projections.
const _activityEventCompatibility: ActivityEvent | undefined = undefined;
void _activityEventCompatibility;
