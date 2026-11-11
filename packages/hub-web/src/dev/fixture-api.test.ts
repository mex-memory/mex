import {
  ActivityResponseSchema,
  CodeWorkspaceResponseSchema,
  CodeKnowledgeResponseSchema,
  HealthResponseSchema,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HubJobSnapshotSchema,
  InboxDraftDetailSchema,
  InboxDraftListResponseSchema,
  InboxOperationApplyResponseSchema,
  InboxOperationPreviewResponseSchema,
  InboxProposalDetailSchema,
  InboxProposalListResponseSchema,
  JobPageResponseSchema,
  RelayDetailSchema,
  RelayDraftDetailSchema,
  RelayDraftListResponseSchema,
  RelayListResponseSchema,
  RelayOperationApplyResponseSchema,
  RelayOperationPreviewResponseSchema,
  SearchResponseSchema,
  SessionResponseSchema,
  SpecDetailResponseSchema,
  SpecListResponseSchema,
  TeamCurrentActorResponseSchema,
  TeamMemberListResponseSchema,
  TeamMemberSchema,
  TeamOperationApplyResponseSchema,
  TeamOperationPreviewResponseSchema,
  TeamWorkstreamListResponseSchema,
  TeamWorkstreamSchema,
  WikiBacklinksResponseSchema,
  WikiEntityDetailResponseSchema,
  WikiEntityListResponseSchema,
  WikiRelationsResponseSchema,
} from "@mex/hub-contracts";
import { OverviewResponseSchema } from "@mex/hub-contracts/overview";
import { describe, expect, it } from "vitest";
import type { OverviewFixtureVariant } from "../api/client";
import { activityHeadline } from "../lib/activity-presentation";
import { createFixtureApi } from "./fixture-api";

describe("development-only populated fixture", () => {
  it("stays inside every shared wire contract", async () => {
    const api = createFixtureApi();
    const [session, capabilities, home, overview, activity, search, code, health, jobs, entities, detail, relations, backlinks, codeKnowledge] = await Promise.all([
      api.getSession(),
      api.getCapabilities(),
      api.getHome(),
      api.getOverview(),
      api.getActivity({ limit: 25 }),
      api.search({ q: "bootstrap", limit: 25 }),
      api.getCodeSymbol("sym.createHubServer", { view: "impact", depth: 2 }),
      api.getHealth(),
      api.getJobs(),
      api.listWikiEntities({ limit: 25 }),
      api.getWikiEntity("mx_01K36WVM6H7JK8M9NPQRSTVVWX"),
      api.getWikiRelations("mx_01K36WVM6H7JK8M9NPQRSTVVWX", { direction: "both", limit: 25 }),
      api.getWikiBacklinks("mx_01K36WVM6H7JK8M9NPQRSTVVWX", { limit: 25 }),
      api.getCodeKnowledge("sym.createHubServer", { limit: 25 }),
    ]);

    expect(SessionResponseSchema.safeParse(session).success).toBe(true);
    expect(HubCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(HomeResponseSchema.safeParse(home).success).toBe(true);
    expect(OverviewResponseSchema.safeParse(overview).success).toBe(true);
    expect(ActivityResponseSchema.safeParse(activity).success).toBe(true);
    expect(home.attention.inbox).toEqual({ availability: "available", teamReviewCount: 3 });
    expect(home.attention.relays).toEqual({ availability: "available", readyToTakeCount: 1, inYourHandsCount: 1 });
    expect(home.jobs).toEqual({ availability: "available", activeCount: 1 });
    expect(overview.shell).toEqual(home);
    expect(activity.items.some((item) => item.source === "activity")).toBe(true);
    expect(activity.items.some((item) => item.source === "legacy")).toBe(true);
    const activityTail = await api.getActivity({
      limit: 25,
      ...(activity.nextCursor === null ? {} : { cursor: activity.nextCursor }),
    });
    expect([...activity.items, ...activityTail.items]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "activity",
        action: "inbox.published",
        recordOrigin: { kind: "workflow", operation: "inbox.publish" },
        label: "Keep approval consequences explicit",
        subjects: [expect.objectContaining({
          kind: "entity",
          entity: expect.objectContaining({
            id: "proposal_01000000000000000000001721",
            entityKind: "proposal",
          }),
        })],
        subjectCount: 1,
      }),
      expect.objectContaining({
        source: "activity",
        action: "relay.acknowledged",
        recordOrigin: { kind: "workflow", operation: "relay.acknowledge" },
        label: "Carry the release evidence through the final cross-platform gate.",
        subjects: [expect.objectContaining({
          kind: "entity",
          entity: expect.objectContaining({
            id: "relay_01000000000000000000000001",
            entityKind: "relay",
          }),
        })],
        subjectCount: 1,
      }),
      expect.objectContaining({
        source: "activity",
        action: "member.updated",
        recordOrigin: { kind: "workflow", operation: "member.update" },
        label: "Daksh Jaitly",
        subjects: [expect.objectContaining({
          kind: "entity",
          entity: expect.objectContaining({
            id: "member_01K35Z2A3B4C5D6E7FGHJKMNPQ",
            entityKind: "member",
          }),
        })],
        subjectCount: 1,
      }),
      expect.objectContaining({
        source: "activity",
        action: "relay.closed",
        recordOrigin: { kind: "custom" },
        label: "Imported closure note",
      }),
      expect.objectContaining({
        source: "activity",
        action: "repository.initialized",
        recordOrigin: { kind: "unknown" },
        label: null,
      }),
    ]));
    expect(SearchResponseSchema.safeParse(search).success).toBe(true);
    expect(CodeWorkspaceResponseSchema.safeParse(code).success).toBe(true);
    expect(HealthResponseSchema.safeParse(health).success).toBe(true);
    expect(JobPageResponseSchema.safeParse(jobs).success).toBe(true);
    expect(jobs.items.every((job) => HubJobSnapshotSchema.safeParse(job).success)).toBe(true);
    const entityPage = WikiEntityListResponseSchema.safeParse(entities);
    expect(entityPage.success, entityPage.success ? undefined : entityPage.error.message).toBe(true);
    expect(WikiEntityDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(WikiRelationsResponseSchema.safeParse(relations).success).toBe(true);
    expect(WikiBacklinksResponseSchema.safeParse(backlinks).success).toBe(true);
    expect(CodeKnowledgeResponseSchema.safeParse(codeKnowledge).success).toBe(true);
    const [relayDrafts, relays] = await Promise.all([
      api.getRelayDrafts({ limit: 25 }),
      api.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
    ]);
    expect(RelayDraftListResponseSchema.safeParse(relayDrafts).success).toBe(true);
    expect(RelayListResponseSchema.safeParse(relays).success).toBe(true);
    expect(RelayDraftDetailSchema.safeParse(await api.getRelayDraft(relayDrafts.items[0]!.id)).success).toBe(true);
    expect(RelayDetailSchema.safeParse(await api.getRelay(relays.items[0]!.ref.id)).success).toBe(true);

    const members = await api.getMembers({ limit: 25 });
    const member = await api.getMember(members.items[0]!.id);
    const currentActor = await api.getCurrentActor();
    expect(TeamMemberListResponseSchema.safeParse(members).success).toBe(true);
    expect(TeamMemberSchema.safeParse(member).success).toBe(true);
    expect(TeamCurrentActorResponseSchema.safeParse(currentActor).success).toBe(true);

    const preview = await api.previewTeamOperation({
      operationId: "fixture_member_select_contract",
      action: { kind: "member.select", memberId: members.items[1]!.id },
      expectedRevisions: [
        {
          target: { kind: "artifact", path: members.items[1]!.sourcePath },
          revision: members.items[1]!.revision,
        },
        {
          target: { kind: "local", namespace: "member-selection", id: "current" },
          revision: currentActor.selection?.revision ?? null,
        },
      ],
    });
    const applied = await api.applyTeamOperation(preview);
    expect(TeamOperationPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(TeamOperationApplyResponseSchema.safeParse(applied).success).toBe(true);
    expect(applied.events).toEqual([]);
    expect(applied.workstreams).toEqual([]);
    expect((await api.getCurrentActor()).selection?.memberId).toBe(members.items[1]!.id);

    const workstreamPreview = await api.previewTeamOperation({
      operationId: "fixture_workstream_create_contract",
      action: {
        kind: "workstream.create",
        workstream: {
          title: "Spec review",
          goal: "Keep hierarchy explicit.",
          summary: "Use the dedicated fresh-index reader.",
          owners: [currentActor.actor],
          nextMilestone: "Review the Hub surface.",
        },
      },
      expectedRevisions: [],
    });
    const workstreamApplied = await api.applyTeamOperation(workstreamPreview);
    expect(TeamOperationPreviewResponseSchema.safeParse(workstreamPreview).success).toBe(true);
    expect(TeamOperationApplyResponseSchema.safeParse(workstreamApplied).success).toBe(true);
    expect(workstreamApplied.workstreams).toHaveLength(1);
    expect(workstreamApplied.events).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        action: "workstream.created",
        origin: { kind: "workflow", operation: "workstream.create" },
        label: "Spec review",
      }),
    ]);
  });

  it("keeps every Overview fixture scenario inside the production aggregate contract", async () => {
    const variants: OverviewFixtureVariant[] = [
      "established",
      "caught-up",
      "pending-review",
      "relay-ready",
      "relay-in-hand",
      "identity-unresolved",
      "indexes-stale",
      "indexes-degraded",
      "indexes-missing",
      "job-determinate",
      "job-indeterminate",
      "failure",
      "partial",
      "unavailable",
    ];

    for (const variant of variants) {
      const overview = await createFixtureApi({ overviewFixture: variant }).getOverview();
      const parsed = OverviewResponseSchema.safeParse(overview);
      expect(parsed.success, variant).toBe(true);
      expect(overview.focus.availability === "unavailable"
        ? true
        : overview.focus.inbox.availability === "unavailable"
          || overview.focus.inbox.items.length <= 3, variant).toBe(true);
      expect(overview.focus.availability === "unavailable"
        ? true
        : overview.focus.relays.availability === "unavailable"
          || (overview.focus.relays.readyToTake.length <= 3
            && overview.focus.relays.inYourHands.length <= 3), variant).toBe(true);
      expect(overview.activity.availability === "unavailable"
        ? true
        : overview.activity.items.length <= 5, variant).toBe(true);
    }
  });

  it("defaults the Overview fixture to the established production-like scenario", async () => {
    const [implicit, explicit] = await Promise.all([
      createFixtureApi().getOverview(),
      createFixtureApi({ overviewFixture: "established" }).getOverview(),
    ]);
    expect(implicit).toEqual(explicit);
  });

  it("projects bounded Overview focus semantics without fixture-only attention", async () => {
    const established = await createFixtureApi({ overviewFixture: "established" }).getOverview();
    expect(established.shell.attention).toEqual({
      inbox: { availability: "available", teamReviewCount: 3 },
      relays: { availability: "available", readyToTakeCount: 1, inYourHandsCount: 1 },
    });
    expect(established.focus).toMatchObject({
      availability: "available",
      identity: { availability: "available", requiresAttention: false },
      inbox: { availability: "available", teamReviewCount: 3 },
      relays: { availability: "available", readyToTakeCount: 1, inYourHandsCount: 1 },
    });
    if (established.focus.availability !== "available"
      || established.focus.inbox.availability !== "available"
      || established.focus.relays.availability !== "available") {
      throw new Error("Expected the established Overview focus sources.");
    }
    expect(established.focus.inbox.items).toHaveLength(3);
    expect(established.focus.relays.readyToTake).toHaveLength(1);
    expect(established.focus.relays.readyToTake[0]?.state).toBe("published");
    expect(established.focus.relays.inYourHands).toHaveLength(1);
    expect(established.focus.relays.inYourHands[0]?.state).toBe("acknowledged");
    expect(established.context).toMatchObject({
      availability: "available",
      graph: {
        availability: "available",
        details: { indexStatus: "stale", changes: { total: 7 } },
      },
      wiki: { availability: "available", details: { indexStatus: "fresh" } },
    });
    if (established.context.availability !== "available"
      || established.context.graph.availability !== "available") {
      throw new Error("Expected established Graph context.");
    }
    expect(established.context.graph.details.currentBranch).toBe(established.shell.repository.branch);
    expect(established.context.graph.details.currentHead).toBe(established.shell.repository.head);

    const caughtUp = await createFixtureApi({ overviewFixture: "caught-up" }).getOverview();
    expect(caughtUp.shell.attention).toEqual({
      inbox: { availability: "available", teamReviewCount: 0 },
      relays: { availability: "available", readyToTakeCount: 0, inYourHandsCount: 0 },
    });
    expect(caughtUp.operation).toMatchObject({
      availability: "available",
      active: null,
      latestRelevantFailure: null,
    });

    const pending = await createFixtureApi({ overviewFixture: "pending-review" }).getOverview();
    expect(pending.shell.attention.inbox).toEqual({ availability: "available", teamReviewCount: 3 });
    const ready = await createFixtureApi({ overviewFixture: "relay-ready" }).getOverview();
    expect(ready.shell.attention.relays).toEqual({
      availability: "available",
      readyToTakeCount: 1,
      inYourHandsCount: 0,
    });
    const inHand = await createFixtureApi({ overviewFixture: "relay-in-hand" }).getOverview();
    expect(inHand.shell.attention.relays).toEqual({
      availability: "available",
      readyToTakeCount: 0,
      inYourHandsCount: 1,
    });
  });

  it("keeps unresolved identity and independent source failures honest", async () => {
    const identity = await createFixtureApi({ overviewFixture: "identity-unresolved" }).getOverview();
    expect(identity.identity).toMatchObject({
      availability: "available",
      current: {
        actor: { kind: "unknown" },
        source: "unknown",
        diagnostics: [{ code: "GIT_IDENTITY_UNAVAILABLE" }],
      },
    });
    expect(identity.focus).toMatchObject({
      availability: "available",
      identity: { availability: "available", requiresAttention: true },
      relays: { availability: "unavailable" },
    });

    const partial = await createFixtureApi({ overviewFixture: "partial" }).getOverview();
    expect(partial.focus).toMatchObject({
      availability: "available",
      inbox: { availability: "available", teamReviewCount: 2 },
      relays: { availability: "unavailable" },
    });
    expect(partial.activity).toMatchObject({ availability: "unavailable" });
    expect(partial.context).toMatchObject({
      availability: "available",
      graph: { availability: "unavailable" },
      wiki: { availability: "available", details: { indexStatus: "fresh" } },
    });

    const unavailableOverview = await createFixtureApi({ overviewFixture: "unavailable" }).getOverview();
    expect(unavailableOverview.identity.availability).toBe("unavailable");
    expect(unavailableOverview.focus.availability).toBe("unavailable");
    expect(unavailableOverview.activity.availability).toBe("unavailable");
    expect(unavailableOverview.context.availability).toBe("unavailable");
    expect(unavailableOverview.operation.availability).toBe("unavailable");
    expect(unavailableOverview.shell).toMatchObject({
      attention: {
        inbox: { availability: "unavailable" },
        relays: { availability: "unavailable" },
      },
      jobs: { availability: "unavailable" },
    });
  });

  it("projects exact index states, parse composition, and active-operation progress", async () => {
    const stale = await createFixtureApi({ overviewFixture: "indexes-stale" }).getOverview();
    expect(stale.context).toMatchObject({
      availability: "available",
      graph: {
        availability: "available",
        details: { indexStatus: "stale", changes: { total: 7 } },
      },
      wiki: { availability: "available", details: { indexStatus: "fresh" } },
    });

    const degraded = await createFixtureApi({ overviewFixture: "indexes-degraded" }).getOverview();
    expect(degraded.context).toMatchObject({
      availability: "available",
      graph: {
        availability: "available",
        details: {
          indexStatus: "degraded",
          parseHealth: { total: 183, ok: 178, partial: 4, failed: 1 },
        },
      },
    });
    const missing = await createFixtureApi({ overviewFixture: "indexes-missing" }).getOverview();
    expect(missing.context).toMatchObject({
      availability: "available",
      graph: { availability: "available", details: { indexStatus: "missing" } },
      wiki: { availability: "available", details: { indexStatus: "missing" } },
    });

    const determinate = await createFixtureApi({ overviewFixture: "job-determinate" }).getOverview();
    expect(determinate.operation).toMatchObject({
      availability: "available",
      active: { kind: "graph_refresh", progress: { completed: 124, total: 183 } },
      latestRelevantFailure: null,
    });
    const indeterminate = await createFixtureApi({ overviewFixture: "job-indeterminate" }).getOverview();
    expect(indeterminate.operation).toMatchObject({
      availability: "available",
      active: { kind: "wiki_refresh", progress: { completed: 37 } },
      latestRelevantFailure: null,
    });
    if (indeterminate.operation.availability !== "available") throw new Error("Expected an operation panel.");
    expect(indeterminate.operation.active?.progress).not.toHaveProperty("total");
  });

  it("keeps superseded failures quiet and exposes only a relevant latest failure", async () => {
    const established = await createFixtureApi({ overviewFixture: "established" }).getOverview();
    expect(established.operation).toMatchObject({
      availability: "available",
      latestRelevantFailure: null,
    });

    const failure = await createFixtureApi({ overviewFixture: "failure" }).getOverview();
    expect(failure.operation).toMatchObject({
      availability: "available",
      active: null,
      latestRelevantFailure: {
        kind: "graph_refresh",
        generation: 15,
        state: "failed",
        problem: { code: "JOB_FAILED" },
      },
    });
  });

  it("reuses Activity origin truth and preserves the unknown-action fallback in its bounded preview", async () => {
    const overview = await createFixtureApi({ overviewFixture: "established" }).getOverview();
    if (overview.activity.availability !== "available") throw new Error("Expected recent Activity.");
    expect(overview.activity.items).toHaveLength(5);
    expect(overview.activity.items.map(activityHeadline)).toEqual([
      "Proposed a Spec change",
      "Took a handoff",
      "Keep activity immutable and preserve Project notes as a read-only projection.",
      "Updated a teammate",
      "Recorded “relay.closed”",
    ]);
    expect(overview.activity.sourceTruncated).toBe(false);
    expect(overview.activity.diagnostics).toEqual([
      expect.objectContaining({ code: "LEGACY_ACTIVITY_MALFORMED" }),
    ]);
  });

  it("projects each bounded Member identity through Current, Home, Relay, and receipt reads", async () => {
    const cases = [
      {
        variant: "configured",
        actor: { kind: "member", memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX", displayName: "Ada Lovelace" },
        source: "configured-member",
        selectionId: "member_01K36WVM6H7JK8M9NPQRSTVVWX",
        diagnosticCodes: [],
      },
      {
        variant: "git-alias",
        actor: { kind: "member", memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX", displayName: "Ada Lovelace" },
        source: "git-alias",
        selectionId: null,
        diagnosticCodes: [],
      },
      {
        variant: "git-fallback",
        actor: { kind: "git", name: "MEX Contributor", email: "contributor@example.test" },
        source: "git-fallback",
        selectionId: null,
        diagnosticCodes: [],
      },
      {
        variant: "unknown",
        actor: { kind: "unknown" },
        source: "unknown",
        selectionId: null,
        diagnosticCodes: ["GIT_IDENTITY_UNAVAILABLE"],
      },
      {
        variant: "stale",
        actor: { kind: "member", memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX", displayName: "Ada Lovelace" },
        source: "git-alias",
        selectionId: "member_01K39WVM6H7JK8M9NPQRSTVVWX",
        diagnosticCodes: ["ACTOR_MEMBER_MISSING"],
      },
      {
        variant: "inactive",
        actor: { kind: "member", memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX", displayName: "Ada Lovelace" },
        source: "git-alias",
        selectionId: "member_01K35Z2A3B4C5D6E7FGHJKMNPQ",
        diagnosticCodes: ["ACTOR_MEMBER_INACTIVE"],
      },
      {
        variant: "ambiguous",
        actor: { kind: "git", name: "Grace", email: "ada@example.test" },
        source: "git-fallback",
        selectionId: null,
        diagnosticCodes: ["ACTOR_ALIAS_AMBIGUOUS"],
      },
      {
        variant: "partial",
        actor: { kind: "member", memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX", displayName: "Ada Lovelace" },
        source: "configured-member",
        selectionId: "member_01K36WVM6H7JK8M9NPQRSTVVWX",
        diagnosticCodes: [],
      },
    ] as const;

    for (const fixtureCase of cases) {
      const api = createFixtureApi({ memberFixture: fixtureCase.variant });
      const actor = await api.getCurrentActor();
      const homeResult = await api.getHome();
      const preview = await api.previewTeamOperation({
        operationId: `fixture_member_projection_${fixtureCase.variant.replace("-", "_")}`,
        action: { kind: "member.clear" },
        expectedRevisions: [{
          target: { kind: "local", namespace: "member-selection", id: "current" },
          revision: actor.selection?.revision ?? null,
        }],
      });

      expect(TeamCurrentActorResponseSchema.safeParse(actor).success).toBe(true);
      expect(HomeResponseSchema.safeParse(homeResult).success).toBe(true);
      expect(TeamOperationPreviewResponseSchema.safeParse(preview).success).toBe(true);
      expect(actor.actor, fixtureCase.variant).toEqual(fixtureCase.actor);
      expect(actor.source, fixtureCase.variant).toBe(fixtureCase.source);
      expect(actor.selection?.memberId ?? null, fixtureCase.variant).toBe(fixtureCase.selectionId);
      expect(actor.diagnostics.map((diagnostic) => diagnostic.code), fixtureCase.variant)
        .toEqual(fixtureCase.diagnosticCodes);
      if (fixtureCase.variant === "inactive") {
        expect(actor.diagnostics[0]?.path).toBe(
          ".mex/team/members/member_01K35Z2A3B4C5D6E7FGHJKMNPQ.md",
        );
      }
      expect(homeResult.actor, fixtureCase.variant).toEqual(actor.actor);
      expect(preview.receipt.authority.actor, fixtureCase.variant).toEqual(actor.actor);

      if (actor.actor.kind === "member") {
        expect(homeResult.attention.relays, fixtureCase.variant)
          .toEqual({ availability: "available", readyToTakeCount: 1, inYourHandsCount: 1 });
        await expect(api.getRelays({
          perspective: "mine",
          states: ["published", "acknowledged"],
          limit: 25,
        })).resolves.toMatchObject({ items: expect.any(Array) });
      } else {
        expect(homeResult.attention.relays, fixtureCase.variant).toEqual({
          availability: "unavailable",
          reason: "Select an active Member to see your personal Relay handoffs.",
        });
        await expect(api.getRelays({
          perspective: "mine",
          states: ["published", "acknowledged"],
          limit: 25,
        })).rejects.toThrow("Select an active Member to use this Relay perspective.");
      }
    }
  });

  it("falls back through the matching Git alias after clearing local selection across all receipts", async () => {
    const api = createFixtureApi({ memberFixture: "configured" });
    const selected = await api.getCurrentActor();
    const clear = await api.previewTeamOperation({
      operationId: "fixture_member_clear_to_git_alias",
      action: { kind: "member.clear" },
      expectedRevisions: [{
        target: { kind: "local", namespace: "member-selection", id: "current" },
        revision: selected.selection?.revision ?? null,
      }],
    });
    await api.applyTeamOperation(clear);

    const actor = await api.getCurrentActor();
    const homeResult = await api.getHome();
    const [relayDrafts] = await Promise.all([
      api.getRelayDrafts({ limit: 25 }),
    ]);
    const relayDraft = relayDrafts.items[0]!;
    const [teamPreview, relayPreview] = await Promise.all([
      api.previewTeamOperation({
        operationId: "fixture_member_clear_alias_team_receipt",
        action: { kind: "member.clear" },
        expectedRevisions: [{
          target: { kind: "local", namespace: "member-selection", id: "current" },
          revision: null,
        }],
      }),
      api.previewRelayOperation({
        operationId: "fixture_member_clear_alias_relay_receipt",
        action: { kind: "relay.draft.delete", draftId: relayDraft.id },
        expectedRevisions: [{
          target: { kind: "local", namespace: "relay-draft", id: relayDraft.id },
          revision: relayDraft.revision,
        }],
      }),
    ]);

    expect(actor).toMatchObject({
      actor: { kind: "member", memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX", displayName: "Ada Lovelace" },
      source: "git-alias",
      selection: null,
      diagnostics: [],
    });
    expect(homeResult.actor).toEqual(actor.actor);
    expect(homeResult.attention.relays).toEqual({ availability: "available", readyToTakeCount: 1, inYourHandsCount: 1 });
    await expect(api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 25,
    })).resolves.toMatchObject({ items: expect.any(Array) });
    expect([
      teamPreview.receipt.authority.actor,
      relayPreview.receipt.authority.actor,
    ]).toEqual([actor.actor, actor.actor]);
  });

  it("paginates Members by the actual bounded offset for every page size", async () => {
    const api = createFixtureApi();
    const first = await api.getMembers({ limit: 1 });
    const second = await api.getMembers({ limit: 1, cursor: first.nextCursor ?? undefined });
    const third = await api.getMembers({ limit: 1, cursor: second.nextCursor ?? undefined });

    for (const page of [first, second, third]) {
      expect(TeamMemberListResponseSchema.safeParse(page).success).toBe(true);
    }
    expect(first.nextCursor).toBe("fixture_members_1");
    expect(second.nextCursor).toBe("fixture_members_2");
    expect(third.nextCursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map((member) => member.displayName))
      .toEqual(["Ada Lovelace", "Grace Hopper", "Lin Chen"]);
  });

  it("keeps Member fixture state and granular capability projections isolated", async () => {
    const first = createFixtureApi({ memberFixture: "configured" });
    const second = createFixtureApi({ memberFixture: "configured" });
    const partial = createFixtureApi({ memberFixture: "partial" });
    const explicit = createFixtureApi({
      memberFixture: "configured",
      inboxFixture: "unknown",
      relayFixture: "missing",
    });
    const firstActor = await first.getCurrentActor();
    const clear = await first.previewTeamOperation({
      operationId: "fixture_member_instance_isolation",
      action: { kind: "member.clear" },
      expectedRevisions: [{
        target: { kind: "local", namespace: "member-selection", id: "current" },
        revision: firstActor.selection?.revision ?? null,
      }],
    });
    await first.applyTeamOperation(clear);

    expect((await first.getCurrentActor()).source).toBe("git-alias");
    expect(await second.getCurrentActor()).toMatchObject({
      source: "configured-member",
      selection: { memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX" },
    });
    expect(await explicit.getCurrentActor()).toMatchObject({
      source: "configured-member",
      selection: { memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX" },
    });
    expect((await partial.getCapabilities()).members).toEqual({
      read: { availability: "available" },
      canonicalMutation: {
        availability: "unavailable",
        reason: "Canonical Member writes are not connected in this Hub process.",
      },
      localSelection: { availability: "available" },
    });
    expect((await second.getCapabilities()).members).toEqual({
      read: { availability: "available" },
      canonicalMutation: { availability: "available" },
      localSelection: { availability: "available" },
    });
  });

  it("models the human Relay inbox across personal, sent, team, closed, and draft views", async () => {
    const api = createFixtureApi();
    const mineFirst = await api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 1,
    });
    const mineSecond = await api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 1,
      cursor: mineFirst.nextCursor ?? undefined,
    });
    const [sentOpen, sentClosed, teamOpen, drafts] = await Promise.all([
      api.getRelays({ perspective: "sent", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelays({ perspective: "sent", states: ["closed"], limit: 25 }),
      api.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelayDrafts({ limit: 25 }),
    ]);
    const mine = [...mineFirst.items, ...mineSecond.items];

    for (const page of [mineFirst, mineSecond, sentOpen, sentClosed, teamOpen]) {
      expect(RelayListResponseSchema.safeParse(page).success).toBe(true);
    }
    expect(mine.map((relay) => [relay.ref.id, relay.state])).toEqual([
      ["relay_01000000000000000000000002", "acknowledged"],
      ["relay_01000000000000000000000001", "published"],
    ]);
    expect(mineFirst).toMatchObject({ nextCursor: "fixture_relays_1", truncated: true });
    expect(mineSecond).toMatchObject({ nextCursor: null, truncated: false });
    expect(sentOpen.items.map((relay) => [relay.ref.id, relay.state])).toEqual([
      ["relay_01000000000000000000000003", "published"],
      ["relay_01000000000000000000000004", "acknowledged"],
    ]);
    expect(sentClosed.items.map((relay) => [relay.ref.id, relay.state])).toEqual([
      ["relay_01000000000000000000000005", "closed"],
    ]);
    expect(teamOpen.items.map((relay) => relay.ref.id)).toEqual([
      "relay_01000000000000000000000002",
      "relay_01000000000000000000000001",
      "relay_01000000000000000000000003",
      "relay_01000000000000000000000004",
    ]);
    expect([...teamOpen.items, ...sentClosed.items].every((relay) => relay.ref.title === undefined)).toBe(true);

    const details = await Promise.all(
      [...teamOpen.items, ...sentClosed.items].map((relay) => api.getRelay(relay.ref.id)),
    );
    expect(details.every((relay) => RelayDetailSchema.safeParse(relay).success)).toBe(true);
    expect(details.every((relay) => (
      relay.schemaVersion === 3
      && relay.workstream === null
      && relay.publishedRepoState !== null
    ))).toBe(true);
    expect(details.map((relay) => relay.publishedRepoState)).toEqual(expect.arrayContaining([
      expect.objectContaining({ branch: "codex/hub-ux", dirty: false }),
      expect.objectContaining({ branch: "feature/relay-accessibility", dirty: true }),
      expect.objectContaining({ branch: null, head: expect.any(String) }),
      expect.objectContaining({ branch: "feature/unborn-relay", head: null }),
    ]));
    expect(details.find((relay) => (
      relay.state === "acknowledged"
      && relay.acknowledgedBy?.kind === "member"
      && relay.acknowledgedBy.memberId === "member_01K36WVM6H7JK8M9NPQRSTVVWX"
    )))
      .toMatchObject({ summary: "Finish the keyboard and screen-reader pass for the Hub review surfaces." });

    const richSummary = drafts.items.find((draft) => (
      draft.summary === "Carry the release evidence through the final cross-platform gate."
    ));
    if (richSummary === undefined) throw new Error("Expected the translated legacy Relay draft fixture.");
    const draft = await api.getRelayDraft(richSummary.id);
    expect(RelayDraftDetailSchema.safeParse(draft).success).toBe(true);
    expect(draft).not.toHaveProperty("workstream");
    expect(draft.input).not.toHaveProperty("workstream");
    expect(draft.input).toMatchObject({
      completed: ["The deterministic benchmark fixture is stable."],
      inProgress: ["Collect the final pinned runner evidence."],
      blockers: ["Windows packed-install evidence is not yet recorded."],
      unresolvedQuestions: ["Does the Windows packed-install run retain the same digest?"],
      nextActions: ["Run the cross-platform storage matrix."],
    });
    expect(draft.input.decisions).toHaveLength(1);
    expect(draft.input.code.map((item) => item.kind)).toEqual(["symbol", "file"]);
    expect(draft.input.evidence.map((item) => item.kind)).toEqual([
      "entity",
      "entity",
      "code",
      "file",
      "commit",
      "external",
      "manual",
    ]);
    expect(draft.input.evidence[0]).toMatchObject({
      kind: "entity",
      entity: { kind: "workstream", id: "ws_01K37WVM6H7JK8M9NPQRSTVVW0" },
    });

    const sparseSummary = drafts.items.find((item) => item.id === "relay-draft-02");
    if (sparseSummary === undefined) throw new Error("Expected the sparse standalone Relay draft fixture.");
    const sparse = await api.getRelayDraft(sparseSummary.id);
    expect(RelayDraftDetailSchema.safeParse(sparse).success).toBe(true);
    expect(sparse.input).toEqual({
      recipients: sparse.recipients,
      summary: sparse.summary,
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
    });
  });

  it("publishes a standalone schema-v3 Relay with exact repository provenance", async () => {
    const api = createFixtureApi();
    const draft = await api.getRelayDraft("relay-draft-01");
    const recipient = draft.recipients[0];
    if (recipient?.kind !== "member") throw new Error("Expected the Relay fixture recipient to be a Member.");
    const member = await api.getMember(recipient.memberId);
    const preview = await api.previewRelayOperation({
      operationId: "fixture_standalone_relay_publish",
      action: { kind: "relay.publish", draftId: draft.id },
      expectedRevisions: [
        {
          target: { kind: "local", namespace: "relay-draft", id: draft.id },
          revision: draft.revision,
        },
        {
          target: { kind: "artifact", path: member.sourcePath },
          revision: member.revision,
        },
      ],
    });
    expect(RelayOperationPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(preview.receipt.authority.repoState.dirty).toBe(true);
    expect(preview.preview.diagnostics).toEqual([{
      code: "RELAY_DIRTY_PUBLICATION_STATE",
      severity: "warning",
      message: "MEX recorded that local changes existed when this Relay was published; it did not record their paths, diff, or contents.",
    }]);

    const applied = await api.applyRelayOperation(preview);
    expect(RelayOperationApplyResponseSchema.safeParse(applied).success).toBe(true);
    expect(applied.relays).toHaveLength(1);
    expect(applied.relays[0]).toMatchObject({
      schemaVersion: 3,
      workstream: null,
      publishedAt: preview.receipt.authority.occurredAt,
      publishedRepoState: preview.receipt.authority.repoState,
      evidence: draft.input.evidence,
    });
    expect(applied.events).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        action: "relay.published",
        origin: { kind: "workflow", operation: "relay.publish" },
        label: draft.summary,
        workstream: null,
        repoState: preview.receipt.authority.repoState,
      }),
    ]);
    await expect(api.getRelayDraft(draft.id)).rejects.toThrow("Fixture Relay draft not found.");
  });

  it("projects an exact empty Activity timeline without suppressing read or record capability", async () => {
    const api = createFixtureApi({ activityFixture: "empty" });
    const [capability, homeResult, page] = await Promise.all([
      api.getCapabilities(),
      api.getHome(),
      api.getActivity({ limit: 25 }),
    ]);

    expect(HubCapabilitiesSchema.safeParse(capability).success).toBe(true);
    expect(HomeResponseSchema.safeParse(homeResult).success).toBe(true);
    expect(ActivityResponseSchema.safeParse(page).success).toBe(true);
    expect(capability.activity).toEqual({ availability: "available" });
    expect(capability.activityRecord).toEqual({ availability: "available" });
    expect(homeResult.attention.inbox).toEqual({ availability: "available", teamReviewCount: 3 });
    expect(page).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
      sourceTruncated: false,
      deterministicRevision: "7".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  });

  it("isolates valid legacy Activity without inventing canonical history or diagnostics", async () => {
    const api = createFixtureApi({ activityFixture: "legacy" });
    const [homeResult, all, canonical] = await Promise.all([
      api.getHome(),
      api.getActivity({ limit: 25 }),
      api.getActivity({ source: "activity", limit: 25 }),
    ]);

    expect(ActivityResponseSchema.safeParse(all).success).toBe(true);
    expect(ActivityResponseSchema.safeParse(canonical).success).toBe(true);
    expect(homeResult.attention.inbox).toEqual({ availability: "available", teamReviewCount: 3 });
    expect(all.items).toHaveLength(2);
    expect(all.items.every((item) => item.source === "legacy")).toBe(true);
    expect(all.diagnostics).toEqual([]);
    expect(canonical.items).toEqual([]);
    expect(canonical.diagnostics).toEqual([]);
  });

  it("keeps trusted Activity visible beside bounded partial-source diagnostics", async () => {
    const api = createFixtureApi({ activityFixture: "partial" });
    const [homeResult, page] = await Promise.all([
      api.getHome(),
      api.getActivity({ limit: 25 }),
    ]);

    expect(ActivityResponseSchema.safeParse(page).success).toBe(true);
    expect(homeResult.attention.inbox).toEqual({ availability: "available", teamReviewCount: 3 });
    expect(page.items).toHaveLength(4);
    expect(page.nextCursor).not.toBeNull();
    expect(page.sourceTruncated).toBe(true);
    expect(page.diagnosticsTruncated).toBe(true);
    expect(page.diagnostics).toEqual([{
      code: "LEGACY_ACTIVITY_MALFORMED",
      severity: "warning",
      message: "One malformed legacy row was excluded while valid history was retained.",
      path: ".mex/events/decisions.jsonl",
    }]);
  });

  it("projects exact empty Relay queues and drafts without suppressing Relay reads", async () => {
    const api = createFixtureApi({ relayFixture: "empty" });
    const [capability, homeResult, drafts, open, closed] = await Promise.all([
      api.getCapabilities(),
      api.getHome(),
      api.getRelayDrafts({ limit: 25 }),
      api.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelays({ perspective: "all", states: ["closed"], limit: 25 }),
    ]);

    expect(HubCapabilitiesSchema.safeParse(capability).success).toBe(true);
    expect(HomeResponseSchema.safeParse(homeResult).success).toBe(true);
    expect(RelayListResponseSchema.safeParse(open).success).toBe(true);
    expect(RelayListResponseSchema.safeParse(closed).success).toBe(true);
    expect(capability.relays).toEqual({
      read: { availability: "available" },
      draftMutation: { availability: "available" },
      publish: { availability: "available" },
      lifecycleMutation: { availability: "available" },
    });
    expect(homeResult.attention.relays).toEqual({ availability: "available", readyToTakeCount: 0, inYourHandsCount: 0 });
    expect(drafts).toMatchObject({ items: [], nextCursor: null, truncated: false });
    expect(open).toMatchObject({ items: [], nextCursor: null, truncated: false });
    expect(closed).toMatchObject({ items: [], nextCursor: null, truncated: false });
    await expect(api.getRelayDraft("relay-draft-01")).rejects.toThrow("Fixture Relay draft not found.");
    await expect(api.getRelay("relay_01000000000000000000000001")).rejects.toThrow("Fixture Relay not found.");
  });

  it("isolates a contract-valid closed handoff for closed-state visual review", async () => {
    const api = createFixtureApi({ relayFixture: "closed" });
    const [homeResult, open, closed] = await Promise.all([
      api.getHome(),
      api.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelays({ perspective: "all", states: ["closed"], limit: 25 }),
    ]);

    expect(homeResult.attention.relays).toEqual({ availability: "available", readyToTakeCount: 0, inYourHandsCount: 0 });
    expect(open.items).toEqual([]);
    expect(closed.items.map((relay) => relay.ref.id)).toEqual([
      "relay_01000000000000000000000005",
    ]);
    const detail = await api.getRelay(closed.items[0]!.ref.id);
    expect(RelayDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({
      state: "closed",
      acknowledgedBy: { kind: "member", displayName: "Grace Hopper" },
      closedBy: { kind: "member", displayName: "Ada Lovelace" },
    });
  });

  it("projects a stale configured Member while retaining Team and local-draft reads", async () => {
    const api = createFixtureApi({ relayFixture: "missing" });
    const [actor, homeResult, team, drafts] = await Promise.all([
      api.getCurrentActor(),
      api.getHome(),
      api.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelayDrafts({ limit: 25 }),
    ]);

    expect(TeamCurrentActorResponseSchema.safeParse(actor).success).toBe(true);
    expect(actor).toMatchObject({
      actor: { kind: "member", memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX", displayName: "Ada Lovelace" },
      source: "git-alias",
      selection: { memberId: "member_01K39WVM6H7JK8M9NPQRSTVVWX" },
      diagnostics: [{
        code: "ACTOR_MEMBER_MISSING",
        severity: "warning",
        message: "The referenced member no longer exists.",
      }],
    });
    expect(homeResult.attention.relays).toEqual({ availability: "available", readyToTakeCount: 1, inYourHandsCount: 1 });
    expect(team.items).toHaveLength(4);
    await expect(api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 25,
    })).resolves.toMatchObject({ items: expect.any(Array) });
  });

  it("projects partial Relay mutation capability without suppressing reads or local drafts", async () => {
    const api = createFixtureApi({ relayFixture: "partial" });
    const [capability, homeResult, drafts, relays] = await Promise.all([
      api.getCapabilities(),
      api.getHome(),
      api.getRelayDrafts({ limit: 25 }),
      api.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
    ]);

    expect(HubCapabilitiesSchema.safeParse(capability).success).toBe(true);
    expect(capability.relays).toEqual({
      read: { availability: "available" },
      draftMutation: { availability: "available" },
      publish: {
        availability: "unavailable",
        reason: "Relay publication is not connected in this Hub process.",
      },
      lifecycleMutation: {
        availability: "unavailable",
        reason: "Relay lifecycle writes are not connected in this Hub process.",
      },
    });
    expect(homeResult.attention.relays).toEqual({ availability: "available", readyToTakeCount: 1, inYourHandsCount: 1 });
    expect(relays.items).toHaveLength(2);
  });

  it("isolates schema-v1/v2 Relays with their recorded Workstreams and v1 warning", async () => {
    const api = createFixtureApi({ relayFixture: "legacy" });
    const page = await api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 25,
    });

    expect(RelayListResponseSchema.safeParse(page).success).toBe(true);
    expect(page.items.map((relay) => relay.ref.id)).toEqual([
      "relay_01000000000000000000000007",
      "relay_01000000000000000000000006",
    ]);
    expect(page.diagnostics).toEqual([{
      code: "RELAY_LEGACY_PUBLICATION_TIME",
      severity: "warning",
      message: "One or more legacy schema-v1 Relays have no canonical publication timestamp.",
    }]);
    const details = await Promise.all(page.items.map((relay) => api.getRelay(relay.ref.id)));
    expect(details.every((detail) => RelayDetailSchema.safeParse(detail).success)).toBe(true);
    expect(details[0]).toMatchObject({
      schemaVersion: 2,
      workstream: {
        kind: "workstream",
        id: "ws_01K37WVM6H7JK8M9NPQRSTVVW0",
      },
      publishedAt: expect.any(String),
      publishedRepoState: null,
      diagnostics: [],
    });
    expect(details[1]).toMatchObject({
      schemaVersion: 1,
      state: "published",
      sender: { kind: "git", name: "Grace", email: "grace@example.test" },
      publishedAt: null,
      publishedRepoState: null,
      diagnostics: page.diagnostics,
    });
  });

  it.each(["empty", "closed", "missing", "partial", "legacy"] as const)(
    "keeps Knowledge, Inbox, Activity, and Workstreams stable for the %s Relay variant",
    async (relayFixture) => {
      const baseline = createFixtureApi();
      const variant = createFixtureApi({ relayFixture });
      const request = { limit: 25 } as const;
      const [
        baselineKnowledge,
        variantKnowledge,
        baselineActivity,
        variantActivity,
        ] = await Promise.all([
        baseline.listWikiEntities(request),
        variant.listWikiEntities(request),
        baseline.getActivity(request),
        variant.getActivity(request),
      ]);

      expect(variantKnowledge).toEqual(baselineKnowledge);
      const [baselineKnowledgeNext, variantKnowledgeNext] = await Promise.all([
        baseline.listWikiEntities({
          limit: 25,
          cursor: baselineKnowledge.nextCursor ?? undefined,
        }),
        variant.listWikiEntities({
          limit: 25,
          cursor: variantKnowledge.nextCursor ?? undefined,
        }),
      ]);
      expect(variantKnowledgeNext).toEqual(baselineKnowledgeNext);
      expect([...variantKnowledge.items, ...variantKnowledgeNext.items]).toHaveLength(3);
      expect(variantActivity).toEqual(baselineActivity);
    },
  );

  it.each(["empty", "unknown", "partial"] as const)(
    "keeps unrelated fixture routes stable for the %s Inbox variant",
    async (inboxFixture) => {
      const baseline = createFixtureApi();
      const variant = createFixtureApi({ inboxFixture });
      const request = { limit: 25 } as const;
      const [baselineActivity, variantActivity, baselineRelays, variantRelays, ] = await Promise.all([
        baseline.getActivity(request),
        variant.getActivity(request),
        baseline.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
        variant.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
      ]);

      expect(variantActivity).toEqual(baselineActivity);
      expect(variantRelays).toEqual(baselineRelays);
    },
  );

  it.each(["empty", "legacy", "partial"] as const)(
    "keeps Knowledge, Inbox, Relay, and Workstreams stable for the %s Activity variant",
    async (activityFixture) => {
      const baseline = createFixtureApi();
      const variant = createFixtureApi({ activityFixture });
      const request = { limit: 25 } as const;
      const [
        baselineKnowledge,
        variantKnowledge,
        baselineRelays,
        variantRelays,
        ] = await Promise.all([
        baseline.listWikiEntities(request),
        variant.listWikiEntities(request),
        baseline.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
        variant.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
      ]);

      expect(variantKnowledge).toEqual(baselineKnowledge);
      expect(variantRelays).toEqual(baselineRelays);
    },
  );
});
