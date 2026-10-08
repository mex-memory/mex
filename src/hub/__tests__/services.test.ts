import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HUB_LIMITS,
  InboxDraftDetailSchema,
  InboxDraftInputSchema,
  InboxDraftListResponseSchema,
  InboxOperationApplyResponseSchema,
  InboxOperationPreviewRequestSchema,
  InboxOperationPreviewResponseSchema,
  InboxProposalDetailSchema,
  InboxProposalListResponseSchema,
  SpecDetailResponseSchema,
  SpecListResponseSchema,
  WikiGraphResponseSchema,
  WikiGroundedCodeResponseSchema,
  type HubJobSnapshot,
} from "@mex/hub-contracts";
import { OverviewResponseSchema } from "@mex/hub-contracts/overview";
import type { GitPort } from "../../team/contracts/git.js";
import type { Diagnostic, Revision } from "../../team/contracts/shared.js";
import type { GraphStatus } from "../../team/contracts/graph.js";
import type {
  TeamMember,
  TeamMemberListRequest,
  TeamInboxSpecApplyResult,
  TeamInboxSpecCommand,
  TeamInboxSpecDraftDetail,
  TeamEvidenceRef,
  TeamInboxSpecPreviewEnvelope,
  TeamInboxSpecProposalDetail,
  TeamPage,
  TeamRelaySummary,
  Workstream,
} from "../../team/contracts/workflow.js";
import {
  createLocalHubReadServices as createLocalHubReadServicesBase,
  type HubTeamIdentityActivityService,
  type HubInboxSpecAuthoringService,
  type HubRelayHandoffService,
  type HubTeamWorkstreamService,
  type HubGraphReadService,
  type HubWikiReadService,
  type LocalHubReadServicesOptions,
} from "../services.js";
import { createRepositoryWikiPort } from "../../wiki/application-adapter.js";
import type {
  WikiEntitySummary,
  WikiIndexStatus,
  WikiListRequest,
  WikiQueryRequest,
} from "../../team/contracts/wiki.js";
import { WIKI_ENTITY_TYPES } from "../../wiki/model/entity.js";
import { createRepositoryTeamWorkflowPortWithDependencies } from "../../team/workflow/repository-team-workflow-port.js";
import { ActivityRepository } from "../../team/activity/repository.js";
import { MemberRepository } from "../../team/identity/member-repository.js";
import type {
  SpecReadService,
  SpecSummaryProjection,
} from "../../team/specs/service.js";

const EVENT = "event_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const MEMBER = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const INBOX_DRAFT = "inbox_00000000000000000000000000000001";
const INBOX_PROPOSAL = "proposal_01000000000000000000001720";
const INBOX_SPEC = "mx_01000000000000000000000001";
const NOW = new Date("2026-08-23T00:00:00.000Z");

const git = {
  getRepoState: async () => ({
    branch: "feat/project-hub-foundation",
    head: "a".repeat(40),
    dirty: true,
    observedAt: "2026-08-23T00:00:00.000Z",
  }),
  getIdentity: async () => ({ name: "Daksh", email: "daksh@example.test" }),
} as Pick<GitPort, "getRepoState" | "getIdentity"> as GitPort;

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "mex-hub-services-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function wikiWithStatus(state: WikiIndexStatus["state"]): HubWikiReadService {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    inspectIndex: async () => ({
      state,
      observedAt: NOW.toISOString(),
      schemaVersion: state === "missing" ? null : 3,
      indexedRevision: ["missing", "rebuild_required", "migration_required"].includes(state)
        ? null
        : "f".repeat(64),
      indexedAt: state === "missing" ? null : NOW.toISOString(),
      diagnostics: [] as Diagnostic[],
    }),
    listBundle: unused,
    searchBundle: unused,
    readKnowledgeWorkspace: unused,
    knowledgeForCode: unused,
  };
}

function createLocalHubReadServices(
  options: Omit<LocalHubReadServicesOptions, "team">,
): ReturnType<typeof createLocalHubReadServicesBase> {
  const team = createRepositoryTeamWorkflowPortWithDependencies(options.projectRoot, {
    scaffoldId: options.scaffoldId,
    wiki: createRepositoryWikiPort(options.projectRoot, {
      now: () => (options.now ?? (() => new Date()))().toISOString(),
    }),
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return createLocalHubReadServicesBase({ ...options, team });
}

function identityService(): HubTeamIdentityActivityService {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    getMember: unused,
    listMembers: unused,
    getCurrentActor: async () => ({
      actor: { kind: "unknown" },
      source: "unknown",
      selection: null,
      diagnostics: [] as Diagnostic[],
    }),
    getActivity: unused,
    listActivity: unused,
    previewIdentityActivity: unused,
    applyIdentityActivity: unused,
  };
}

function specIndexProjection() {
  return {
    state: "fresh" as const,
    observedAt: NOW.toISOString(),
    indexedRevision: "5".repeat(64) as Revision,
    indexedAt: NOW.toISOString(),
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function inboxDraftFixture(): TeamInboxSpecDraftDetail {
  return {
    id: INBOX_DRAFT,
    revision: "1".repeat(64),
    updatedAt: NOW.toISOString(),
    changeKind: "spec.create",
    entityKind: "requirement",
    title: "Release benchmark local draft Requirement",
    rationaleExcerpt: "Review this local draft.",
    input: {
      change: {
        kind: "spec.create",
        entityKind: "requirement",
        title: "Release benchmark local draft Requirement",
        body: "A local body.\n\nIt remains multiline.",
        status: "in_flight",
      },
      rationale: "Review this local draft.\nPreserve its context.",
      evidence: [],
      targetRevisions: [],
    },
  };
}

function inboxProposalFixture(
  state: "pending" | "stale" = "pending",
): TeamInboxSpecProposalDetail {
  return {
    schemaVersion: 1,
    ref: { id: INBOX_PROPOSAL, kind: "proposal" },
    sourcePath: `.mex/inbox/${INBOX_PROPOSAL}.md`,
    revision: "2".repeat(64),
    state,
    author: { kind: "unknown" },
    changeKind: "spec.update",
    entityKind: "spec",
    title: "Release benchmark pending Spec update",
    rationaleExcerpt: "Review this exact update.",
    change: {
      kind: "spec.update",
      target: { id: INBOX_SPEC, kind: "spec" },
      patch: { summary: "A reviewed summary." },
    },
    rationale: "Review this exact update.",
    evidence: [],
    targetRevisions: [{
      target: { kind: "entity", id: INBOX_SPEC },
      revision: "3".repeat(64),
      semanticRevision: 1,
    }],
  };
}

function inboxPreviewFixture(): TeamInboxSpecPreviewEnvelope {
  const draft = inboxDraftFixture();
  return {
    schemaVersion: 1,
    request: {
      operationId: "hub_inbox_draft_save",
      action: { kind: "inbox.draft.save", draft: draft.input },
      expectedRevisions: [],
    },
    preview: {
      valid: true,
      scope: "local",
      changes: [],
      localChanges: [{
        namespace: "inbox-draft",
        id: INBOX_DRAFT,
        beforeRevision: null,
        afterRevision: draft.revision,
        summary: "Create a checkout-local Inbox draft.",
      }],
      diagnostics: [],
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: { kind: "unknown" },
        occurredAt: NOW.toISOString(),
        repoState: {
          branch: "feature/inbox",
          head: "a".repeat(40),
          dirty: false,
          observedAt: NOW.toISOString(),
        },
      },
      purposeIds: [{ purpose: "inbox-draft", id: INBOX_DRAFT }],
      requestRevision: "4".repeat(64),
      presentationRevision: "5".repeat(64),
      previewRevision: "6".repeat(64),
    },
  };
}

function wikiSummary(id: string, kind: string, title: string): WikiEntitySummary {
  return {
    ref: { id, kind, title },
    title,
    summary: `${title} summary.`,
    location: {
      path: kind === "workstream"
        ? `.mex/workstreams/${id}.md`
        : `.mex/context/${id}.md`,
      startLine: 1,
      endLine: 12,
    },
    version: { semanticRevision: 1, contentHash: "a".repeat(64) },
    lifecycleState: "promoted",
    groundingHealth: "unverified",
    topics: [],
    sourceTypes: ["manual"],
    diagnostics: [],
  };
}

function overviewRelay(
  id: string,
  state: "published" | "acknowledged",
): TeamRelaySummary {
  return {
    schemaVersion: 3,
    ref: { id, kind: "relay", title: state === "published" ? "Ready handoff" : "Claimed handoff" },
    sourcePath: `.mex/relays/${id}.md`,
    revision: (state === "published" ? "8" : "9").repeat(64) as Revision,
    state,
    sender: { kind: "member", memberId: "member_02000000000000000000000001", displayName: "Grace" },
    recipients: [{ kind: "member", memberId: MEMBER, displayName: "Daksh" }],
    workstream: null,
    summary: state === "published" ? "Ready handoff" : "Claimed handoff",
    publishedAt: NOW.toISOString(),
    publishedRepoState: {
      branch: "feat/project-hub-foundation",
      head: "a".repeat(40),
      dirty: false,
      observedAt: NOW.toISOString(),
    },
    ...(state === "acknowledged"
      ? {
          acknowledgedBy: { kind: "member" as const, memberId: MEMBER, displayName: "Daksh" },
          acknowledgedAt: NOW.toISOString(),
        }
      : {}),
  };
}

function overviewJob(
  id: string,
  kind: HubJobSnapshot["kind"],
  state: HubJobSnapshot["state"],
  createdAt: string,
  progress: HubJobSnapshot["progress"] = null,
): HubJobSnapshot {
  return {
    id,
    scaffoldId: "scaffold-local",
    kind,
    generation: 1,
    phase: state === "running" ? "parse" : state === "succeeded" ? "complete" : "failed",
    progress,
    state,
    cancelRequested: false,
    createdAt,
    ...(state === "running" ? { startedAt: createdAt } : { finishedAt: createdAt }),
    revision: id.endsWith("1") ? "1".repeat(64) : id.endsWith("2") ? "2".repeat(64) : "3".repeat(64),
  };
}

describe("createLocalHubReadServices", () => {
  it("keeps Team-wide Relay reads independent from local actor resolution", async () => {
    const getIdentity = vi.fn(git.getIdentity);
    const relayGit = { ...git, getIdentity } as GitPort;
    const team = createRepositoryTeamWorkflowPortWithDependencies(projectRoot, {
      scaffoldId: "scaffold-local",
      wiki: createRepositoryWikiPort(projectRoot, { now: () => NOW.toISOString() }),
      git: relayGit,
      now: () => new Date(NOW),
    });

    await expect(team.listRelays({ perspective: "all", limit: 100 })).resolves.toMatchObject({
      items: [],
      nextCursor: null,
    });
    expect(getIdentity).not.toHaveBeenCalled();
    await expect(team.listRelays({ perspective: "mine", limit: 100 })).rejects.toMatchObject({
      problem: { code: "UNAUTHORIZED" },
    });
    expect(getIdentity).toHaveBeenCalledTimes(1);
  });

  it("builds Overview from one bounded read per source and reuses one actor resolution", async () => {
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const getRepoState = vi.fn(git.getRepoState);
    const overviewGit = { ...git, getRepoState } as GitPort;
    const getCurrentActor = vi.fn(async () => ({
      actor: { kind: "member" as const, memberId: MEMBER, displayName: "Daksh" },
      source: "git-alias" as const,
      selection: null,
      diagnostics: [] as Diagnostic[],
    }));
    const previewIdentityActivity = vi.fn(unused);
    const applyIdentityActivity = vi.fn(unused);
    const team: HubTeamIdentityActivityService = {
      getMember: unused,
      listMembers: unused,
      getCurrentActor,
      getActivity: unused,
      listActivity: unused,
      previewIdentityActivity,
      applyIdentityActivity,
    };
    const proposal = inboxProposalFixture("pending");
    const listInboxProposals = vi.fn(async () => ({
      items: [proposal],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "4".repeat(64) as Revision,
      diagnostics: [] as Diagnostic[],
    }));
    const inbox: HubInboxSpecAuthoringService = {
      getInboxDraft: unused,
      listInboxDrafts: unused,
      getInboxProposal: unused,
      listInboxProposals,
      previewInbox: vi.fn(unused),
      applyInbox: vi.fn(unused),
    };
    const relays = [
      overviewRelay("relay_01000000000000000000000001", "published"),
      overviewRelay("relay_01000000000000000000000002", "acknowledged"),
    ];
    const listRelays = vi.fn(async () => ({
      items: relays,
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "5".repeat(64) as Revision,
      diagnostics: [] as Diagnostic[],
    }));
    const relay: HubRelayHandoffService = {
      getRelayDraft: unused,
      listRelayDrafts: unused,
      getRelay: unused,
      listRelays,
      previewRelay: vi.fn(unused),
      applyRelay: vi.fn(unused),
    };
    const graphStatus: GraphStatus = {
      status: "stale",
      observedAt: NOW.toISOString(),
      currentRepo: {
        branch: "feat/project-hub-foundation",
        head: "a".repeat(40),
        dirty: true,
        observedAt: NOW.toISOString(),
      },
      lastSuccessfulIndexAt: "2026-08-22T00:00:00.000Z",
      indexedAt: "2026-08-22T00:00:00.000Z",
      indexedBranch: "feat/project-hub-foundation",
      indexedHead: "b".repeat(40),
      schemaVersion: 3,
      extractorVersion: "tree-sitter-v1",
      grammarVersion: "grammar-v1",
      parseHealth: { total: 3, ok: 2, partial: 1, failed: 0, failedPaths: [], failedPathsTruncated: false },
      changes: {
        total: 2,
        added: ["src/new.ts"],
        modified: ["src/changed.ts"],
        deleted: [],
        truncated: false,
        branchChanged: false,
        manifestChanged: false,
        configChanged: false,
        grammarChanged: false,
      },
      diagnostics: [],
    };
    const inspectStatus = vi.fn(async () => graphStatus);
    const graph: HubGraphReadService = {
      inspectStatus,
      searchBundle: unused,
      readSymbolWorkspace: unused,
    };
    const wiki = wikiWithStatus("fresh");
    const inspectIndex = vi.spyOn(wiki, "inspectIndex");
    const jobs = [
      overviewJob("job_01000000000000000000000003", "wiki_rebuild", "running", "2026-08-23T00:03:00.000Z", { completed: 124, total: 183 }),
      overviewJob("job_01000000000000000000000002", "graph_refresh", "succeeded", "2026-08-23T00:02:00.000Z"),
      overviewJob("job_01000000000000000000000001", "graph_refresh", "failed", "2026-08-23T00:01:00.000Z"),
      overviewJob("job_01000000000000000000000005", "graph_rebuild", "failed", "2026-08-23T00:00:30.000Z"),
      overviewJob("job_01000000000000000000000004", "wiki_refresh", "failed", "2026-08-15T00:00:00.000Z"),
    ];
    const listJobs = vi.fn(() => ({ items: jobs, nextCursor: null }));
    const listWorkstreams = vi.fn(unused);
    const activityRead = vi.spyOn(ActivityRepository.prototype, "readAll");
    const services = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      git: overviewGit,
      team,
      inbox,
      relays: relay,
      workstreams: {
        getWorkstream: unused,
        listWorkstreams,
        previewWorkstream: unused,
        applyWorkstream: unused,
      },
      graph,
      wiki,
      jobs: { list: listJobs },
      now: () => new Date(NOW),
    });

    const overview = await services.overview?.();
    expect(OverviewResponseSchema.parse(overview)).toEqual(overview);
    expect(overview).toMatchObject({
      shell: {
        attention: {
          inbox: { availability: "available", teamReviewCount: 1 },
          relays: { availability: "available", readyToTakeCount: 1, inYourHandsCount: 1 },
        },
        jobs: { availability: "available", activeCount: 1 },
      },
      identity: { availability: "available", current: { source: "git-alias" } },
      focus: {
        availability: "available",
        inbox: { availability: "available", teamReviewCount: 1, items: [{ title: proposal.title }] },
        relays: {
          availability: "available",
          readyToTakeCount: 1,
          inYourHandsCount: 1,
          readyToTake: [{ ref: { id: "relay_01000000000000000000000001" } }],
          inYourHands: [{ ref: { id: "relay_01000000000000000000000002" } }],
        },
      },
      activity: { availability: "available", items: [] },
      context: {
        availability: "available",
        graph: { availability: "available", details: { indexStatus: "stale", changes: { total: 2 } } },
        wiki: { availability: "available", details: { indexStatus: "fresh" } },
      },
      operation: {
        availability: "available",
        active: { id: "job_01000000000000000000000003", progress: { completed: 124, total: 183 } },
        latestRelevantFailure: { id: "job_01000000000000000000000005", kind: "graph_rebuild" },
      },
    });
    expect(JSON.stringify(overview?.context)).not.toContain("activeJobId");
    expect(getCurrentActor).toHaveBeenCalledTimes(1);
    expect(getRepoState).toHaveBeenCalledTimes(1);
    expect(listInboxProposals).toHaveBeenCalledTimes(1);
    expect(listInboxProposals).toHaveBeenCalledWith({ states: ["pending", "stale"], limit: 100 });
    expect(listRelays).toHaveBeenCalledTimes(1);
    expect(listRelays).toHaveBeenCalledWith({ perspective: "all", states: ["published", "acknowledged"], limit: 100 });
    expect(listJobs).toHaveBeenCalledTimes(1);
    expect(activityRead).toHaveBeenCalledTimes(1);
    expect(inspectStatus).toHaveBeenCalledTimes(1);
    expect(inspectIndex).toHaveBeenCalledTimes(1);
    expect(listWorkstreams).not.toHaveBeenCalled();
    expect(previewIdentityActivity).not.toHaveBeenCalled();
    expect(applyIdentityActivity).not.toHaveBeenCalled();
    expect(inbox.previewInbox).not.toHaveBeenCalled();
    expect(inbox.applyInbox).not.toHaveBeenCalled();
    expect(relay.previewRelay).not.toHaveBeenCalled();
    expect(relay.applyRelay).not.toHaveBeenCalled();
    activityRead.mockRestore();
  });

  it("fails bounded Overview sources closed without collapsing independent panels", async () => {
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const team = identityService();
    const inbox: HubInboxSpecAuthoringService = {
      getInboxDraft: unused,
      listInboxDrafts: unused,
      getInboxProposal: unused,
      listInboxProposals: async () => ({
        items: [inboxProposalFixture()],
        nextCursor: "more-inbox",
        truncated: true,
        sourceTruncated: false,
        deterministicRevision: "6".repeat(64) as Revision,
        diagnostics: [],
      }),
      previewInbox: unused,
      applyInbox: unused,
    };
    const relays: HubRelayHandoffService = {
      getRelayDraft: unused,
      listRelayDrafts: unused,
      getRelay: unused,
      listRelays: async () => ({
        items: [overviewRelay("relay_01000000000000000000000001", "published")],
        nextCursor: "more-relays",
        truncated: true,
        sourceTruncated: false,
        deterministicRevision: "7".repeat(64) as Revision,
        diagnostics: [],
      }),
      previewRelay: unused,
      applyRelay: unused,
    };
    const failingGraph: HubGraphReadService = {
      inspectStatus: async () => { throw new Error("private graph failure"); },
      searchBundle: unused,
      readSymbolWorkspace: unused,
    };
    const activityRead = vi.spyOn(ActivityRepository.prototype, "readAll")
      .mockImplementationOnce(() => { throw new Error("private activity failure"); });
    const services = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      team,
      inbox,
      relays,
      graph: failingGraph,
      wiki: wikiWithStatus("fresh"),
      jobs: { list: () => ({ items: [], nextCursor: "more-jobs" }) },
      now: () => new Date(NOW),
    });

    const overview = await services.overview?.();
    expect(OverviewResponseSchema.parse(overview)).toEqual(overview);
    expect(overview).toMatchObject({
      shell: {
        attention: {
          inbox: { availability: "unavailable" },
          relays: { availability: "unavailable" },
        },
        jobs: { availability: "unavailable" },
      },
      focus: {
        availability: "available",
        identity: { availability: "available", requiresAttention: true },
        inbox: {
          availability: "unavailable",
          deterministicRevision: "6".repeat(64),
          truncated: true,
          sourceTruncated: false,
          diagnostics: [],
        },
        relays: {
          availability: "unavailable",
          deterministicRevision: "7".repeat(64),
          truncated: true,
          sourceTruncated: false,
          diagnostics: [],
        },
      },
      activity: { availability: "unavailable" },
      context: {
        availability: "available",
        graph: { availability: "unavailable" },
        wiki: { availability: "available", details: { indexStatus: "fresh" } },
      },
      operation: { availability: "unavailable" },
    });
    expect(JSON.stringify(overview)).not.toContain("private graph failure");
    expect(JSON.stringify(overview)).not.toContain("private activity failure");
    activityRead.mockRestore();
  });

  it("strict-parses a real E1 multiline draft preview, apply, list, and detail through Hub projectors", async () => {
    let activitySequence = 0;
    const context = join(projectRoot, ".mex", "context");
    mkdirSync(context, { recursive: true });
    writeFileSync(join(context, "hub-inbox-index-seed.md"), `<!-- mex:entity
id: mx_02000000000000000000000001
type: topic
status: promoted
revision: 1
-->
## Hub Inbox index seed

The governed authoring test keeps one canonical entity available to the exact-reader index.
`, "utf8");
    const wiki = createRepositoryWikiPort(projectRoot, { now: () => NOW.toISOString() });
    await wiki.rebuildIndex();
    const team = createRepositoryTeamWorkflowPortWithDependencies(projectRoot, {
      scaffoldId: "scaffold-local",
      wiki,
      git,
      now: () => new Date(NOW),
      idFactories: {
        localDraft: () => INBOX_DRAFT,
        proposal: () => INBOX_PROPOSAL,
        activity: () => activitySequence++ === 0
          ? EVENT
          : "event_01ARZ3NDEKTSV4RRFFQ69G5FAC",
        leaseToken: () => "e".repeat(64),
      },
    });
    const services = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      team,
      inbox: team,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    const request = InboxOperationPreviewRequestSchema.parse({
      operationId: "hub_real_e1_draft_save",
      action: {
        kind: "inbox.draft.save",
        draft: {
          change: {
            kind: "spec.create",
            entityKind: "requirement",
            title: "Multiline Hub projection",
            body: "The first exact line.\n\tThe tabbed second line remains canonical.",
            status: "in_flight",
          },
          rationale: "Exercise the real E1 envelope.\nKeep multiline context intact.",
          evidence: [{
            kind: "manual",
            note: "Real E1 local-draft result.\n\tThe observation retains its indentation.",
          }, {
            kind: "external",
            uri: "https://example.test/review-evidence",
            label: "Bounded external evidence",
          }],
          targetRevisions: [],
        },
      },
      expectedRevisions: [],
    });
    if (request.action.kind !== "inbox.draft.save") {
      throw new Error("expected the parsed real-service request to remain a draft save");
    }
    const savedDraft = request.action.draft;
    if (savedDraft.change.kind !== "spec.create") {
      throw new Error("expected the parsed real-service change to remain a Spec create");
    }
    const hostileEvidence: readonly TeamEvidenceRef[] = [{
      kind: "entity",
      entity: { id: "mx_reference", kind: "spec", title: "C1\u0085title" },
    }, {
      kind: "code",
      code: { kind: "symbol", symbolId: "symbol\u2028boundary" },
    }, {
      kind: "external",
      uri: "https://example.test/evidence",
      label: "Broken \ud800 label",
    }, {
      kind: "external",
      uri: "https://example.test/Cafe\u0301",
    }, {
      kind: "external",
      uri: "HTTPS://example.test/evidence",
    }, {
      kind: "external",
      uri: "http:example.test/evidence",
    }, {
      kind: "external",
      uri: "https://example.test/evidence note",
    }];
    for (const [index, evidence] of hostileEvidence.entries()) {
      const hostile: TeamInboxSpecCommand = {
        ...request,
        operationId: `hub_real_e1_hostile_${index}`,
        action: {
          kind: "inbox.draft.save",
          draft: {
            change: {
              kind: "spec.create",
              entityKind: "requirement",
              title: savedDraft.change.title,
              body: savedDraft.change.body,
              status: savedDraft.change.status,
            },
            rationale: savedDraft.rationale,
            evidence: [evidence],
            targetRevisions: [],
          },
        },
      };
      expect(InboxOperationPreviewRequestSchema.safeParse(hostile).success).toBe(false);
      await expect(team.previewInbox(hostile)).rejects.toMatchObject({
        problem: { code: "INVALID_REQUEST" },
      });
    }

    const preview = await services.previewInboxOperation?.(request);
    expect(InboxOperationPreviewResponseSchema.parse(preview)).toEqual(preview);
    expect(preview?.request.action).toMatchObject({
      kind: "inbox.draft.save",
      draft: { change: { body: savedDraft.change.body } },
    });
    const applied = await services.applyInboxOperation?.(preview!);
    expect(InboxOperationApplyResponseSchema.parse(applied)).toEqual(applied);
    const page = await services.inboxDrafts?.({ limit: 25 });
    expect(InboxDraftListResponseSchema.parse(page).items).toHaveLength(1);
    const detail = await services.inboxDraft?.(INBOX_DRAFT);
    const parsedDetail = InboxDraftDetailSchema.parse(detail);
    expect(parsedDetail.input.change).toMatchObject({
      kind: "spec.create",
      body: savedDraft.change.body,
    });
    expect(parsedDetail.input.evidence).toEqual(savedDraft.evidence);

    const publish = InboxOperationPreviewRequestSchema.parse({
      operationId: "hub_real_e1_publish",
      action: { kind: "inbox.publish", draftId: INBOX_DRAFT },
      expectedRevisions: [{
        target: { kind: "local", namespace: "inbox-draft", id: INBOX_DRAFT },
        revision: parsedDetail.revision,
      }],
    });
    const publishPreview = await services.previewInboxOperation?.(publish);
    expect(InboxOperationPreviewResponseSchema.parse(publishPreview)).toEqual(publishPreview);
    await expect(services.applyInboxOperation?.(publishPreview!)).resolves.toMatchObject({
      applied: true,
      proposals: [{ ref: { id: INBOX_PROPOSAL }, state: "pending" }],
    });
    const pending = InboxProposalDetailSchema.parse(
      await services.inboxProposal?.(INBOX_PROPOSAL),
    );
    expect(pending.rationale).toBe(savedDraft.rationale);
    expect(pending.evidence).toEqual(savedDraft.evidence);

    const reject = InboxOperationPreviewRequestSchema.parse({
      operationId: "hub_real_e1_reject",
      action: {
        kind: "inbox.reject",
        proposalId: INBOX_PROPOSAL,
        rationale: "The first review finding.\n\tThe second finding remains indented.",
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: pending.sourcePath },
        revision: pending.revision,
      }],
    });
    if (reject.action.kind !== "inbox.reject") {
      throw new Error("expected the parsed real-service request to remain a rejection");
    }
    const rejectionRationale = reject.action.rationale;
    const rejectPreview = await services.previewInboxOperation?.(reject);
    expect(InboxOperationPreviewResponseSchema.parse(rejectPreview)).toEqual(rejectPreview);
    await expect(services.applyInboxOperation?.(rejectPreview!)).resolves.toMatchObject({
      applied: true,
      proposals: [{ ref: { id: INBOX_PROPOSAL }, state: "rejected" }],
    });
    expect(InboxProposalDetailSchema.parse(
      await services.inboxProposal?.(INBOX_PROPOSAL),
    )).toMatchObject({
      state: "rejected",
      reviewRationale: rejectionRationale,
    });
  });

  it.each([
    { kind: "knowledge.create", entityKind: "pattern", title: "Reviewed evidence", body: "Keep accepted code.\n\tReview drift.", summary: "", status: "in_flight" },
    { kind: "knowledge.update", target: { id: INBOX_SPEC, kind: "architecture", title: "Architecture" }, patch: { summary: "", body: "The updated architecture." } },
  ] as const)("projects $kind through both private Hub directions without changing content or leaking private fields", async (change) => {
    const base = inboxDraftFixture();
    const input: TeamInboxSpecDraftDetail["input"] = {
      ...base.input,
      change,
      targetRevisions: change.kind === "knowledge.update"
        ? [{ target: { kind: "entity", id: change.target.id }, revision: "3".repeat(64), semanticRevision: 2 }]
        : [],
    };
    const draft: TeamInboxSpecDraftDetail = {
      ...base, changeKind: change.kind,
      entityKind: change.kind === "knowledge.create" ? change.entityKind : change.target.kind,
      title: change.kind === "knowledge.create" ? change.title : change.target.title,
      input: { ...input, change: Object.assign({}, change, { privateMetadata: "private engine state" }) },
    };
    const previewInbox = vi.fn(async (request: TeamInboxSpecCommand) => ({ ...inboxPreviewFixture(), request }));
    const unused = async (): Promise<never> => { throw new Error("Unexpected Inbox operation."); };
    const services = createLocalHubReadServicesBase({
      projectRoot, scaffoldId: "scaffold-local", git, team: identityService(),
      inbox: { getInboxDraft: async () => draft, listInboxDrafts: unused, getInboxProposal: unused,
        listInboxProposals: unused, previewInbox, applyInbox: unused },
      jobs: { list: () => ({ items: [] }) }, now: () => new Date(NOW),
    });
    const projected = InboxDraftDetailSchema.parse(await services.inboxDraft?.(INBOX_DRAFT));
    expect(projected.input).toEqual(input);
    expect(JSON.stringify(projected)).not.toContain("private engine state");
    const request = InboxOperationPreviewRequestSchema.parse({
      operationId: "hub_knowledge_projection", action: { kind: "inbox.draft.save", draft: input }, expectedRevisions: [],
    });
    const preview = InboxOperationPreviewResponseSchema.parse(await services.previewInboxOperation?.(request));
    expect(preview.request).toEqual(request);
    expect(previewInbox).toHaveBeenCalledWith(request);
  });

  it("projects the private Inbox facade explicitly and counts only actionable canonical proposals", async () => {
    const draft = Object.assign(inboxDraftFixture(), { privateMetadata: "/Users/alice/draft" });
    const pending = Object.assign(inboxProposalFixture("pending"), { internalRequest: { secret: true } });
    const stale = {
      ...inboxProposalFixture("stale"),
      ref: { id: "proposal_02000000000000000000001720", kind: "proposal" as const },
      sourcePath: ".mex/inbox/proposal_02000000000000000000001720.md" as const,
      title: "Stale release Spec update",
    };
    const previewEnvelope = inboxPreviewFixture();
    const draftWire = InboxDraftInputSchema.parse(draft.input);
    const listInboxDrafts = vi.fn(async () => ({
      items: [draft],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "7".repeat(64),
      diagnostics: [] as Diagnostic[],
    }));
    const listInboxProposals = vi.fn(async (_request?: { cursor?: string; states?: readonly string[] }) => ({
      items: [pending, stale],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "8".repeat(64),
      diagnostics: [] as Diagnostic[],
    }));
    const applyInbox = vi.fn(async (envelope: TeamInboxSpecPreviewEnvelope): Promise<TeamInboxSpecApplyResult> => ({
      operationId: envelope.request.operationId,
      previewRevision: envelope.receipt.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: envelope.preview.changes,
      localChanges: envelope.preview.localChanges,
      proposals: [pending],
      events: [],
    }));
    const inbox: HubInboxSpecAuthoringService = {
      getInboxDraft: async () => draft,
      listInboxDrafts,
      getInboxProposal: async () => pending,
      listInboxProposals,
      previewInbox: async () => previewEnvelope,
      applyInbox,
    };
    const services = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      team: identityService(),
      inbox,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.capabilities()).resolves.toMatchObject({
      inbox: {
        read: { availability: "available" },
        draftMutation: { availability: "available" },
        proposalMutation: { availability: "available" },
        specApproval: { availability: "unavailable" },
      },
    });
    const home = await services.home();
    expect(home.attention.inbox).toEqual({ availability: "available", teamReviewCount: 2 });
    expect(listInboxDrafts).not.toHaveBeenCalled();
    expect(listInboxProposals.mock.calls.map(([request]) => request?.states))
      .toEqual([["pending", "stale"]]);

    const draftPage = await services.inboxDrafts?.({ limit: 25 });
    const proposalPage = await services.inboxProposals?.({ states: ["pending", "stale"], limit: 25 });
    const draftDetail = await services.inboxDraft?.(INBOX_DRAFT);
    const proposalDetail = await services.inboxProposal?.(INBOX_PROPOSAL);
    expect(InboxDraftListResponseSchema.parse(draftPage).items[0]).not.toHaveProperty("input");
    expect(InboxProposalListResponseSchema.parse(proposalPage).items[0]).not.toHaveProperty("change");
    expect(InboxDraftDetailSchema.parse(draftDetail)).not.toHaveProperty("privateMetadata");
    expect(InboxProposalDetailSchema.parse(proposalDetail)).not.toHaveProperty("internalRequest");
    expect(JSON.stringify({ draftPage, proposalPage, draftDetail, proposalDetail })).not.toContain("/Users/alice");
    expect(JSON.stringify({ draftPage, proposalPage, draftDetail, proposalDetail })).not.toContain("secret");

    const preview = await services.previewInboxOperation?.({
      operationId: previewEnvelope.request.operationId,
      action: {
        kind: "inbox.draft.save",
        draft: draftWire,
      },
      expectedRevisions: [],
    });
    expect(InboxOperationPreviewResponseSchema.parse(preview)).toEqual(preview);
    const applied = await services.applyInboxOperation?.(preview!);
    expect(InboxOperationApplyResponseSchema.parse(applied)).toEqual(applied);
    expect(applyInbox).toHaveBeenCalledWith(previewEnvelope);

    const safeDiagnostic = {
      code: "VALIDATION_FAILED",
      severity: "warning" as const,
      message: "The Inbox operation failed bounded validation.",
      path: `.mex/inbox/${INBOX_PROPOSAL}.md` as const,
    };
    const diagnosticEnvelope: TeamInboxSpecPreviewEnvelope = {
      ...previewEnvelope,
      preview: {
        ...previewEnvelope.preview,
        diagnostics: [safeDiagnostic],
      },
    };
    const diagnosticServices = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      team: identityService(),
      inbox: {
        ...inbox,
        previewInbox: async () => diagnosticEnvelope,
      },
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    const diagnosticPreview = await diagnosticServices.previewInboxOperation?.({
      operationId: previewEnvelope.request.operationId,
      action: { kind: "inbox.draft.save", draft: draftWire },
      expectedRevisions: [],
    });
    expect(diagnosticPreview?.preview.diagnostics).toEqual([safeDiagnostic]);
    expect(JSON.stringify(diagnosticPreview?.preview.diagnostics))
      .toBe(JSON.stringify(diagnosticEnvelope.preview.diagnostics));
    await expect(diagnosticServices.applyInboxOperation?.(diagnosticPreview!)).resolves.toMatchObject({
      applied: true,
    });
    expect(applyInbox).toHaveBeenLastCalledWith(diagnosticEnvelope);

    const redacting = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      team: identityService(),
      inbox: {
        ...inbox,
        previewInbox: async () => ({
          ...previewEnvelope,
          preview: {
            ...previewEnvelope.preview,
            diagnostics: [{
              code: "PRIVATE_DIAGNOSTIC",
              severity: "warning",
              message: "Internal checkout at /Users/alice/repository needs review.",
              path: "/Users/alice/repository/private.md",
            }],
          },
        }),
      },
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    await expect(redacting.previewInboxOperation?.({
      operationId: previewEnvelope.request.operationId,
      action: { kind: "inbox.draft.save", draft: draftWire },
      expectedRevisions: [],
    })).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });

    const unsafe = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      team: identityService(),
      inbox: {
        ...inbox,
        previewInbox: async () => ({
          ...previewEnvelope,
          preview: {
            ...previewEnvelope.preview,
            diagnostics: [{
              code: "PRIVATE_DIAGNOSTIC",
              severity: "warning",
              message: "Review required.",
              detail: { privatePath: "/Users/alice/repository" },
            }],
          },
        }),
      },
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    await expect(unsafe.previewInboxOperation?.({
      operationId: previewEnvelope.request.operationId,
      action: { kind: "inbox.draft.save", draft: draftWire },
      expectedRevisions: [],
    })).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
  });

  it("keeps Team-owned Wiki rows out of general Knowledge browse and search", async () => {
    const team = wikiSummary(
      "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workstream",
      "A team Workstream",
    );
    const knowledge = [
      wikiSummary("mx_01ARZ3NDEKTSV4RRFFQ69G5FA1", "spec", "Release Spec"),
      wikiSummary("mx_01ARZ3NDEKTSV4RRFFQ69G5FA2", "requirement", "Release requirement"),
      wikiSummary("mx_01ARZ3NDEKTSV4RRFFQ69G5FA3", "constraint", "Release constraint"),
      wikiSummary(
        "mx_01ARZ3NDEKTSV4RRFFQ69G5FA4",
        "acceptance_criterion",
        "Release acceptance criterion",
      ),
    ];
    const customKnowledge = wikiSummary(
      "mx_01ARZ3NDEKTSV4RRFFQ69G5FA5",
      "roadmap",
      "Registered project roadmap",
    );
    // Keep the Team row first so a missing upstream kind filter reproduces the
    // production failure before any valid `mx_` Knowledge projection appears.
    const candidates = [team, ...knowledge, customKnowledge];
    const listBundle = vi.fn(async (request: WikiListRequest) => ({
      indexedRevision: "f".repeat(64),
      observedAt: NOW.toISOString(),
      results: {
        items: candidates.filter((item) => request.kinds?.includes(item.ref.kind) ?? true),
        nextCursor: null,
        estimatedTokens: 100,
        truncated: false,
      },
    }));
    const searchBundle = vi.fn(async (request: WikiQueryRequest) => ({
      indexedRevision: "f".repeat(64),
      observedAt: NOW.toISOString(),
      results: {
        items: candidates
          .filter((item) => request.kinds?.includes(item.ref.kind) ?? true)
          .map((entity) => ({ entity, matchedFields: ["title" as const] })),
        nextCursor: null,
        estimatedTokens: 100,
        truncated: false,
      },
    }));
    const wiki = {
      ...wikiWithStatus("fresh"),
      listBundle,
      searchBundle,
    } satisfies HubWikiReadService;
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      wiki,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const browse = await services.wikiEntities?.({ limit: 25 });
    expect(browse?.items.map((item) => item.id)).toEqual(knowledge.map((item) => item.ref.id));
    expect(listBundle.mock.calls[0]?.[0].kinds).toEqual(WIKI_ENTITY_TYPES);

    const requirement = await services.wikiEntities?.({ kind: "requirement", limit: 25 });
    expect(requirement?.items.map((item) => item.kind)).toEqual(["requirement"]);
    expect(listBundle.mock.calls[1]?.[0].kinds).toEqual(["requirement"]);

    const custom = await services.wikiEntities?.({ kind: "roadmap", limit: 25 });
    expect(custom?.items.map((item) => item.id)).toEqual([customKnowledge.ref.id]);
    expect(listBundle.mock.calls[2]?.[0].kinds).toEqual(["roadmap"]);

    const callsBeforeTeamKind = listBundle.mock.calls.length;
    await expect(services.wikiEntities?.({ kind: "workstream", limit: 25 }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    expect(listBundle).toHaveBeenCalledTimes(callsBeforeTeamKind);

    const search = await services.search({ q: "release", limit: 25 });
    expect(search.groups.wiki).toMatchObject({
      status: "available",
      items: knowledge.map((item) => expect.objectContaining({ id: item.ref.id, kind: "wiki" })),
    });
    expect(searchBundle.mock.calls[0]?.[0].kinds).toEqual(WIKI_ENTITY_TYPES);
  });

  it("shrinks a valid maximal member page without breaking its continuation cursor", async () => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const members: TeamMember[] = Array.from({ length: 50 }, (_, index) => {
      const high = alphabet[Math.floor(index / alphabet.length)]!;
      const low = alphabet[index % alphabet.length]!;
      const id = `member_01ARZ3NDEKTSV4RRFFQ69G5F${high}${low}`;
      return {
        schemaVersion: 1,
        ref: { id, kind: "member" as const },
        kind: "member" as const,
        sourcePath: `.mex/team/members/${id}.md` as const,
        revision: String(index + 1).padStart(64, "a") as Revision,
        displayName: `Member ${index}`,
        gitAliases: Array.from({ length: 32 }, () => ({
          // Backslashes are valid canonical text but expand in JSON, making
          // the response budget—not the record schema—the limiting resource.
          name: "\\".repeat(200),
          email: `${"\\".repeat(310)}@test.dev`,
        })),
        active: true,
      } as TeamMember;
    });
    const listMembers = vi.fn(async (
      request: TeamMemberListRequest = {},
    ): Promise<TeamPage<TeamMember>> => {
      const limit = request.limit ?? 100;
      const items = members.slice(0, limit);
      return {
        items,
        nextCursor: items.length < members.length ? `cursor-${items.length}` : null,
        truncated: items.length < members.length,
        sourceTruncated: false,
        deterministicRevision: "d".repeat(64),
        diagnostics: [],
      };
    });
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const team = {
      listMembers,
      getMember: unused,
      getCurrentActor: unused,
      getActivity: unused,
      listActivity: unused,
      previewIdentityActivity: unused,
      applyIdentityActivity: unused,
    } satisfies HubTeamIdentityActivityService;
    const services = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      team,
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const response = await services.members?.({ limit: 50 });
    expect(response?.items).toHaveLength(25);
    expect(response).toMatchObject({ nextCursor: "cursor-25", truncated: true });
    expect(Buffer.byteLength(JSON.stringify(response), "utf8"))
      .toBeLessThanOrEqual(HUB_LIMITS.maxJsonResponseBytes);
    expect(listMembers.mock.calls.map(([request]) => request?.limit)).toEqual([50, 25]);
  });

  it("projects bounded Workstream reads and a truthful Home summary", async () => {
    const id = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAC";
    const workstream: Workstream = {
      schemaVersion: 1,
      ref: { id, kind: "workstream", title: "Checkpoint D" },
      kind: "workstream",
      sourcePath: `.mex/workstreams/${id}.md`,
      revision: "4".repeat(64) as Revision,
      entityRevision: 2,
      title: "Checkpoint D",
      goal: "Ship bounded Workstreams",
      summary: "Canonical coordination.",
      state: "active",
      owners: [{ kind: "unknown" }],
      contributors: [],
      paths: ["src/team"],
      code: [],
      topics: [],
      components: [],
      related: [],
      blockers: [],
      currentState: "Integration",
      nextMilestone: "Review",
      createdBy: { kind: "unknown" },
      createdAt: NOW.toISOString(),
      updatedBy: { kind: "unknown" },
      updatedAt: NOW.toISOString(),
    };
    const listWorkstreams = vi.fn(async () => ({
      items: [workstream],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "5".repeat(64) as Revision,
      diagnostics: [] as Diagnostic[],
    }));
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const workstreams = {
      listWorkstreams,
      getWorkstream: async (workstreamId: string) => workstreamId === id ? workstream : null,
      previewWorkstream: unused,
      applyWorkstream: unused,
    } satisfies HubTeamWorkstreamService;
    const services = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      team: identityService(),
      workstreams,
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.capabilities()).resolves.toMatchObject({
      workstreams: {
        read: { availability: "available" },
        canonicalMutation: { availability: "available" },
      },
    });
    await expect(services.workstreams?.({ state: "active", limit: 25 })).resolves.toMatchObject({
      items: [{ id, state: "active", sourcePath: `.mex/workstreams/${id}.md` }],
    });
    await expect(services.workstream?.(id)).resolves.toMatchObject({ id, entityRevision: 2 });
    const activityRead = vi.spyOn(ActivityRepository.prototype, "readAll");
    await expect(services.home()).resolves.toMatchObject({
      attention: {
        inbox: { availability: "unavailable" },
        relays: { availability: "unavailable" },
      },
    });
    expect(listWorkstreams).toHaveBeenCalledWith({ states: ["active"], limit: 25 });
    expect(listWorkstreams).toHaveBeenCalledTimes(1);
    expect(activityRead).not.toHaveBeenCalled();
    activityRead.mockRestore();
  });

  it("shrinks Spec pages coherently and projects strict safe detail evidence", async () => {
    const specId = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAD";
    const sourceType = "a".repeat(128);
    const summary: SpecSummaryProjection = {
      schemaVersion: 1,
      id: specId,
      kind: "spec",
      title: "T".repeat(512),
      summary: "S".repeat(2_048),
      lifecycleState: "promoted",
      groundingHealth: "fresh",
      sourcePath: ".mex/wiki/checkpoint-d.md",
      version: { semanticRevision: 1, contentHash: "6".repeat(64) as Revision },
      topics: Array.from({ length: 50 }, () => specId),
      sourceTypes: Array.from({ length: 50 }, () => sourceType),
      diagnostics: [{
        code: "WIKI_PARSE_ERROR",
        severity: "warning",
        message: "secret /Users/alice/private",
        path: "/Users/alice/private",
        detail: { secret: true },
      }],
      diagnosticsTruncated: false,
    };
    const list = vi.fn(async (request = {}) => {
      const limit = request.limit ?? 25;
      const items = Array.from({ length: Math.min(limit, 100) }, () => structuredClone(summary));
      return {
        availability: "ready" as const,
        index: specIndexProjection(),
        page: {
          schemaVersion: 1 as const,
          items,
          nextCursor: limit < 100 ? `cursor-${limit}` : null,
          truncated: limit < 100,
          estimatedTokens: items.length * 32,
          deterministicRevision: "7".repeat(64) as Revision,
        },
      };
    });
    const specs = {
      list,
      show: async () => ({
        availability: "ready" as const,
        index: specIndexProjection(),
        detail: {
          schemaVersion: 1 as const,
          spec: summary,
          body: "# Checkpoint D\n",
          bodyTruncated: false,
          provenance: {
            kind: "agent" as const,
            id: "/Users/alice/private-agent",
            sessionId: "session-private",
            metadata: { secret: true },
          },
          sources: [{
            type: "agent_session",
            ref: "/Users/alice/private-session",
            note: "/Users/alice/private-note",
            metadata: { secret: true },
          }],
          sourcesTruncated: false,
          groundings: [{
            state: "fresh" as const,
            health: "fresh" as const,
            requestedNode: "function:router",
            resolvedNode: "function:router",
            observedAt: NOW.toISOString(),
            reason: "/Users/alice/private-grounding",
            grounding: {
              node: "function:router",
              fingerprint: "mh:4:11111111",
              file: "src/router.ts",
              commit: "a".repeat(40),
              verifiedAt: NOW.toISOString(),
            },
          }],
          groundingsTruncated: false,
          hierarchy: {
            requirements: [],
            acceptanceCriteria: [],
            constraints: [],
            relations: [],
            estimatedTokens: 8,
          },
          deterministicRevision: "8".repeat(64) as Revision,
        },
      }),
    } satisfies SpecReadService;
    const services = createLocalHubReadServicesBase({
      projectRoot,
      scaffoldId: "scaffold-local",
      team: identityService(),
      specs,
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const page = await services.specs?.({ limit: 100 });
    expect(SpecListResponseSchema.safeParse(page).success).toBe(true);
    expect(page?.availability === "ready" ? page.page.items.length : 0).toBe(50);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8"))
      .toBeLessThanOrEqual(HUB_LIMITS.maxJsonResponseBytes);
    expect(list.mock.calls.map(([request]) => request.limit)).toEqual([100, 50]);

    const detail = await services.spec?.(specId);
    expect(SpecDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({
      availability: "ready",
      detail: {
        provenance: { id: null },
        sources: [{ ref: null, note: null }],
        groundings: [{ requestedNode: "function:router", reason: null }],
      },
    });
    expect(JSON.stringify(detail)).not.toContain("/Users/alice");
    expect(JSON.stringify(detail)).not.toContain("session-private");
  });

  it("truncates metadata-rich Context nodes to one MiB without retaining dangling relations", async () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({
      ...wikiSummary(`mx_${String(index + 1).padStart(26, "0")}`, "pattern", "界".repeat(170)),
      summary: "🧭".repeat(512),
      topics: Array.from({ length: 50 }, (_, topic) => `mx_${String(topic + 1_000).padStart(26, "0")}`),
      sourceTypes: Array.from({ length: 50 }, (_, type) => `source-${type}-`.padEnd(128, "x")),
      location: { path: `.mex/context/${"nested/".repeat(110)}entry.md`, startLine: 1, endLine: 12 },
    }));
    const wiki = {
      ...wikiWithStatus("fresh"),
      graphOverview: async () => ({
        indexedRevision: "f".repeat(64),
        observedAt: NOW.toISOString(),
        nodes,
        relations: [
          { type: "related_to", source: { id: nodes[0]!.ref.id, kind: "pattern" }, target: { id: nodes[99]!.ref.id, kind: "pattern" }, note: "Omitted target" },
          { type: "related_to", source: { id: nodes[0]!.ref.id, kind: "pattern" }, target: { id: nodes[1]!.ref.id, kind: "pattern" }, note: "Included target" },
        ],
        coverage: { nodeLimit: 100 as const, relationLimit: 500 as const, nodesTruncated: false, relationsTruncated: false },
      }),
    } satisfies HubWikiReadService;
    const services = createLocalHubReadServices({
      projectRoot, scaffoldId: "scaffold-local", git, wiki,
      jobs: { list: () => ({ items: [] }) }, now: () => new Date(NOW),
    });

    const result = await services.wikiGraph!();
    expect(WikiGraphResponseSchema.safeParse(result).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(HUB_LIMITS.maxJsonResponseBytes);
    expect(result.nodes.length).toBeGreaterThan(1);
    expect(result.nodes.length).toBeLessThan(nodes.length);
    expect(result.coverage).toMatchObject({ nodesTruncated: true, relationsTruncated: true });
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]!.note).toBe("Included target");
    const included = new Set(result.nodes.map((node) => node.id));
    expect(result.relations.every((relation) => included.has(relation.source.id) && included.has(relation.target.id))).toBe(true);
  });

  it("truncates metadata-rich Context relations to one MiB while preserving the complete node set", async () => {
    const nodes = Array.from({ length: 100 }, (_, index) => (
      wikiSummary(`mx_${String(index + 1).padStart(26, "0")}`, "pattern", "界".repeat(170))
    ));
    const relations = Array.from({ length: 500 }, (_, index) => ({
      type: "related_to",
      source: nodes[index % nodes.length]!.ref,
      target: nodes[(index + 1 + Math.floor(index / nodes.length)) % nodes.length]!.ref,
      note: "🧭".repeat(512),
      metadata: { privateMarker: "unprojected-edge-metadata" },
    }));
    const wiki = {
      ...wikiWithStatus("fresh"),
      graphOverview: async () => ({
        indexedRevision: "f".repeat(64), observedAt: NOW.toISOString(), nodes, relations,
        coverage: { nodeLimit: 100 as const, relationLimit: 500 as const, nodesTruncated: false, relationsTruncated: false },
      }),
    } satisfies HubWikiReadService;
    const services = createLocalHubReadServices({
      projectRoot, scaffoldId: "scaffold-local", git, wiki,
      jobs: { list: () => ({ items: [] }) }, now: () => new Date(NOW),
    });

    const result = await services.wikiGraph!();
    expect(WikiGraphResponseSchema.safeParse(result).success).toBe(true);
    const serialized = JSON.stringify(result);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(HUB_LIMITS.maxJsonResponseBytes);
    expect(result.nodes.map((node) => node.id)).toEqual(nodes.map((node) => node.ref.id));
    expect(result.relations.length).toBeGreaterThan(0);
    expect(result.relations.length).toBeLessThan(relations.length);
    expect(result.coverage).toMatchObject({ nodesTruncated: false, relationsTruncated: true });
    expect(serialized).not.toContain("unprojected-edge-metadata");
    const included = new Set(result.nodes.map((node) => node.id));
    expect(result.relations.every((relation) => included.has(relation.source.id) && included.has(relation.target.id))).toBe(true);
  });

  it("projects compact grounded code through an allowlist and preserves absent symbols", async () => {
    const entityId = "mx_01ARZ3NDEKTSV4RRFFQ69G5FA1";
    const symbol = {
      ref: { kind: "symbol" as const, symbolId: "function:router", fingerprint: "private-fingerprint" },
      symbolKind: "function", name: "router", qualifiedName: "hub.router", language: "typescript",
      path: "src/router.ts", startLine: 3, endLine: 7, signature: "界".repeat(1_000),
      content: "private-source-body", bodyHash: "private-body-hash", docstring: "private-docstring",
    };
    const readGroundedCode = vi.fn(async (id: string) => ({
      indexedRevision: "f".repeat(64), observedAt: NOW.toISOString(), entityId: id,
      graphRevision: "c".repeat(64),
      groundings: [
        {
          requestedNode: "function:old-router", resolvedNode: "function:router", health: "changed" as const,
          symbol, reason: "private-grounding-reason", fingerprint: "private-fingerprint",
        },
        { requestedNode: "function:missing", resolvedNode: null, health: "missing" as const, symbol: null },
      ],
      truncated: true,
      privateMetadata: "private-top-level-metadata",
    }));
    const wiki = { ...wikiWithStatus("fresh"), readGroundedCode } satisfies HubWikiReadService;
    const services = createLocalHubReadServices({
      projectRoot, scaffoldId: "scaffold-local", git, wiki,
      jobs: { list: () => ({ items: [] }) }, now: () => new Date(NOW),
    });

    const result = await services.wikiGroundedCode!(entityId);
    expect(readGroundedCode).toHaveBeenCalledExactlyOnceWith(entityId);
    expect(WikiGroundedCodeResponseSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      entityId, graphRevision: "c".repeat(64), truncated: true,
      groundings: [
        {
          requestedNode: "function:old-router", resolvedNode: "function:router", health: "changed",
          symbol: { id: "function:router", name: "router", path: "src/router.ts", startLine: 3, endLine: 7 },
        },
        { requestedNode: "function:missing", resolvedNode: null, health: "missing", symbol: null },
      ],
    });
    expect(Buffer.byteLength(result.groundings[0]!.symbol!.signature!, "utf8")).toBeLessThanOrEqual(2_048);
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("keeps grounded code unavailable without inventing a Graph revision or symbol", async () => {
    const entityId = "mx_01ARZ3NDEKTSV4RRFFQ69G5FA1";
    const wiki = {
      ...wikiWithStatus("fresh"),
      readGroundedCode: async () => ({
        indexedRevision: "f".repeat(64), observedAt: NOW.toISOString(), entityId,
        graphRevision: null,
        groundings: [{ requestedNode: "function:router", resolvedNode: null, health: "unverified" as const, symbol: null }],
        truncated: false,
      }),
    } satisfies HubWikiReadService;
    const services = createLocalHubReadServices({
      projectRoot, scaffoldId: "scaffold-local", git, wiki,
      jobs: { list: () => ({ items: [] }) }, now: () => new Date(NOW),
    });

    const result = await services.wikiGroundedCode!(entityId);
    expect(WikiGroundedCodeResponseSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      graphRevision: null,
      groundings: [{ requestedNode: "function:router", resolvedNode: null, health: "unverified", symbol: null }],
    });
  });

  it("projects real bounded Wiki browse, detail, relations, search, Code links, and health", async () => {
    const entity = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
    const target = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJE";
    const context = join(projectRoot, ".mex", "context");
    mkdirSync(context, { recursive: true });
    writeFileSync(join(context, "queue.md"), `<!-- mex:entity
id: ${entity}
type: architecture
status: promoted
revision: 1
relations:
  - type: depends_on
    target: ${target}
sources:
  - type: agent_session
    ref: session_01Jo6Wr2CMDPtLn3
  - type: manual
    note: Maintainer evidence
  - type: manual
    ref: '(\\\\server\\share\\secret)'
    note: trace(/Users/alice/private-note)
    repository: 'cwd=C:\\Users\\alice\\private-repository'
  - type: manual
    ref: file://localhost/Users/alice/file-authority-ref
    note: file://server/share/file-authority-note
provenance:
  createdBy:
    kind: agent
    id: file://localhost/Users/alice/private-provenance
grounds_to:
  - node: function:1111111111111111
    fingerprint: mh:4:11111111
    reason: file://server/share/private-grounding
-->
## Durable queue

One service owns durable queueing.
`, "utf8");
    writeFileSync(join(context, "worker.md"), `<!-- mex:entity
id: ${target}
type: component
status: promoted
revision: 1
-->
## Queue worker

The worker drains the durable queue.
`, "utf8");
    const wiki = createRepositoryWikiPort(projectRoot, { now: () => NOW.toISOString() });
    await wiki.rebuildIndex();
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      wiki,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.capabilities()).resolves.toMatchObject({
      wiki: {
        read: { availability: "available" },
        refresh: { availability: "available" },
        rebuild: { availability: "available" },
      },
    });
    const browse = await services.wikiEntities?.({ limit: 25 });
    expect(browse?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: entity, kind: "architecture", title: "Durable queue" }),
    ]));
    expect(browse?.nextCursor).toBeNull();
    const detail = await services.wikiEntity?.(entity);
    expect(detail).toMatchObject({
      entity: { id: entity, groundingHealth: "unverified" },
      body: { content: expect.stringContaining("One service owns") },
      relationCount: 1,
      backlinkCount: 0,
      sources: { total: 4 },
    });
    expect(detail?.sources.items.find((source) => source.type === "agent_session")?.ref).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("session_01Jo6Wr2CMDPtLn3");
    expect(JSON.stringify(detail)).not.toContain("/Users/alice");
    expect(JSON.stringify(detail)).not.toContain("C:\\\\Users");
    expect(JSON.stringify(detail)).not.toContain("server\\\\share");
    expect(JSON.stringify(detail)).not.toContain("file://");
    await expect(services.wikiRelations?.(entity, { direction: "outgoing", limit: 25 })).resolves.toMatchObject({
      items: [{ direction: "outgoing", relation: { target: { id: target } } }],
    });
    await expect(services.wikiBacklinks?.(target, { limit: 25 })).resolves.toMatchObject({
      items: [{ source: { id: entity }, target: { id: target } }],
    });
    await expect(services.codeKnowledge?.("function:1111111111111111", { limit: 25 })).resolves.toMatchObject({
      items: [{ entity: { id: entity }, matchedNodes: ["function:1111111111111111"] }],
    });
    const search = await services.search({ q: "durable", limit: 25 });
    expect(search.groups.wiki.status).toBe("available");
    expect(search.groups.wiki.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: entity,
        kind: "wiki",
        matchedFields: expect.arrayContaining(["body"]),
      }),
    ]));
    expect(search.groups.symbols.status).toBe("unavailable");
    const wikiHealth = (await services.health()).components.find((component) => component.id === "wiki");
    expect(wikiHealth).toMatchObject({
      status: "healthy",
      wiki: {
        indexStatus: "fresh",
        allowedJobKinds: ["wiki_refresh", "wiki_rebuild"],
        recommendedJobKind: null,
      },
    });
  });

  it("revalidates Wiki maintenance eligibility for every index state", async () => {
    const expected: Record<WikiIndexStatus["state"], readonly string[]> = {
      missing: ["wiki_rebuild"],
      fresh: ["wiki_refresh", "wiki_rebuild"],
      stale: ["wiki_refresh", "wiki_rebuild"],
      degraded: [],
      rebuild_required: ["wiki_rebuild"],
      corrupt: ["wiki_rebuild"],
      migration_required: [],
    };
    for (const [state, allowed] of Object.entries(expected) as Array<[WikiIndexStatus["state"], readonly string[]]>) {
      const wiki = wikiWithStatus(state);
      const services = createLocalHubReadServices({
        projectRoot,
        scaffoldId: "scaffold-local",
        git,
        wiki,
        jobs: { list: () => ({ items: [] }) },
        now: () => new Date(NOW),
      });
      for (const kind of ["wiki_refresh", "wiki_rebuild"] as const) {
        const assertion = services.assertJobStartAllowed?.(kind);
        if (allowed.includes(kind)) await expect(assertion, `${state}:${kind}`).resolves.toBeUndefined();
        else await expect(assertion, `${state}:${kind}`).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      }
      const health = await services.health();
      expect(health.components.find((component) => component.id === "wiki")?.wiki?.allowedJobKinds)
        .toEqual(allowed);
    }

    const unsafeWiki = {
      ...wikiWithStatus("stale"),
      inspectIndex: async () => ({
        ...(await wikiWithStatus("stale").inspectIndex()),
        diagnostics: [{
          code: "PATH_OUTSIDE_SCAFFOLD",
          severity: "warning" as const,
          message: "/Users/alice/private symlink target",
        }],
      }),
    } satisfies HubWikiReadService;
    const unsafe = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      wiki: unsafeWiki,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    await expect(unsafe.assertJobStartAllowed?.("wiki_refresh")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    await expect(unsafe.assertJobStartAllowed?.("wiki_rebuild")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    const unsafeHealth = await unsafe.health();
    const unsafeComponent = unsafeHealth.components.find((component) => component.id === "wiki");
    expect(unsafeComponent).toMatchObject({
      wiki: { allowedJobKinds: [], recommendedJobKind: null },
    });
    expect(unsafeComponent).not.toHaveProperty("repairJobKind");
    expect(JSON.stringify(unsafeHealth)).not.toContain("/Users/alice");
  });

  it("explains grounding health without exposing raw diagnostic messages", async () => {
    const wiki = wikiWithStatus("stale");
    const status = await wiki.inspectIndex();
    vi.spyOn(wiki, "inspectIndex").mockResolvedValue({
      ...status,
      diagnostics: ["GROUNDING_STALE", "GROUNDING_MISSING", "GROUNDING_UNRESOLVED"].map((code) => ({
        code, severity: "warning" as const, message: "private raw diagnostic",
      })),
    });
    const services = createLocalHubReadServices({
      projectRoot, scaffoldId: "scaffold-local", git, wiki,
      jobs: { list: () => ({ items: [] }) }, now: () => new Date(NOW),
    });
    const component = (await services.health()).components.find((item) => item.id === "wiki")!;
    expect(component.diagnostics.map((item) => item.message)).toEqual([
      "Linked code changed; review the Knowledge with mex check or mex sync.",
      "A Knowledge code link could not be found in the current graph.",
      "A Knowledge code link could not be resolved confidently.",
    ]);
    expect(JSON.stringify(component)).not.toContain("private raw diagnostic");
    expect(component.wiki?.indexStatus).toBe("stale");
  });

  it("uses real repository context without inventing unavailable project data", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.home()).resolves.toMatchObject({
      repository: {
        name: expect.stringMatching(/^mex-hub-services-/),
        branch: "feat/project-hub-foundation",
        dirty: true,
      },
      actor: { kind: "git", name: "Daksh", email: "daksh@example.test" },
      attention: {
        relays: { availability: "unavailable" },
        inbox: { availability: "unavailable" },
      },
      jobs: { availability: "available", activeCount: 0 },
    });
  });

  it("keeps Wiki and graph search groups independently unavailable", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const result = await services.search({ q: "grounding", limit: 25 });
    expect(result.groups.wiki.status).toBe("unavailable");
    expect(result.groups.symbols.status).toBe("unavailable");
    expect(result.groups.sources.status).toBe("unavailable");
    expect(result.groups.wiki.items).toEqual([]);
  });

  it("keeps a Wiki search failure local without erasing trustworthy graph groups", async () => {
    const wiki = {
      ...wikiWithStatus("stale"),
      searchBundle: async () => {
        throw {
          problem: {
            code: "INDEX_STALE",
            status: 409,
            detail: "/Users/alice/private Wiki error",
          },
        };
      },
    } satisfies HubWikiReadService;
    const graph = {
      inspectStatus: async () => { throw new Error("unused"); },
      readSymbolWorkspace: async () => { throw new Error("unused"); },
      searchBundle: async () => ({
        revision: "c".repeat(64),
        status: {} as never,
        nodes: {
          ok: true as const,
          value: { items: [], nextCursor: null, truncated: false },
        },
        sources: {
          ok: true as const,
          value: { items: [], nextCursor: null, truncated: false },
        },
      }),
    } satisfies HubGraphReadService;
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph,
      wiki,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const result = await services.search({ q: "grounding", limit: 25 });
    expect(result.groups.wiki).toMatchObject({
      status: "failed",
      code: "INDEX_STALE",
      items: [],
      revision: null,
    });
    expect(result.groups.symbols).toMatchObject({ status: "available", revision: "c".repeat(64) });
    expect(result.groups.sources).toMatchObject({ status: "available", revision: "c".repeat(64) });
    expect(JSON.stringify(result)).not.toContain("/Users/alice");
  });

  it("fails both invalidated graph groups without erasing a trustworthy Wiki group", async () => {
    const wiki = {
      ...wikiWithStatus("fresh"),
      searchBundle: async () => ({
        indexedRevision: "f".repeat(64),
        observedAt: NOW.toISOString(),
        results: { items: [], nextCursor: null, estimatedTokens: 0, truncated: false },
      }),
    } satisfies HubWikiReadService;
    const graph = {
      inspectStatus: async () => { throw new Error("unused"); },
      readSymbolWorkspace: async () => { throw new Error("unused"); },
      searchBundle: async () => {
        throw {
          problem: {
            code: "OPERATION_INTERRUPTED",
            status: 503,
            detail: "/Users/alice/private graph race",
          },
        };
      },
    } satisfies HubGraphReadService;
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph,
      wiki,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const result = await services.search({ q: "grounding", limit: 25 });
    expect(result.groups.wiki).toMatchObject({ status: "available", revision: "f".repeat(64) });
    expect(result.groups.symbols).toMatchObject({
      status: "failed",
      code: "OPERATION_INTERRUPTED",
      revision: null,
    });
    expect(result.groups.sources).toMatchObject({
      status: "failed",
      code: "OPERATION_INTERRUPTED",
      revision: null,
    });
    expect(JSON.stringify(result)).not.toContain("/Users/alice");
  });

  it("reports foundation health honestly", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const health = await services.health();
    expect(health.status).toBe("degraded");
    expect(health.components.map((component) => [component.id, component.status])).toEqual([
      ["git", "healthy"],
      ["local_state", "healthy"],
      ["migration", "healthy"],
      ["graph", "unavailable"],
      ["wiki", "unavailable"],
    ]);
  });

  it("projects real graph search, workspace, health, and safe maintenance eligibility", async () => {
    const status = {
      status: "stale" as const,
      observedAt: NOW.toISOString(),
      currentRepo: {
        branch: "feature",
        head: "b".repeat(40),
        dirty: true,
        observedAt: NOW.toISOString(),
      },
      lastSuccessfulIndexAt: NOW.toISOString(),
      indexedAt: NOW.toISOString(),
      indexedBranch: "main",
      indexedHead: "a".repeat(40),
      schemaVersion: 2,
      extractorVersion: "extractor-1",
      grammarVersion: "grammar-1",
      parseHealth: {
        total: 2,
        ok: 1,
        partial: 1,
        failed: 0,
        failedPaths: [],
        failedPathsTruncated: false,
      },
      changes: {
        total: 1,
        added: ["src/new.ts"],
        modified: [],
        deleted: [],
        truncated: false,
        branchChanged: true,
        manifestChanged: false,
        configChanged: false,
        grammarChanged: false,
      },
      diagnostics: [{
        code: "GRAPH_INDEX_BRANCH_CHANGED",
        severity: "warning" as const,
        message: "private detail /Users/alice/project",
        path: "/Users/alice/project.ts",
        remediation: [{ label: "Refresh", command: "mex graph refresh" }],
      }],
    };
    const symbol = {
      ref: { kind: "symbol" as const, symbolId: "function:router" },
      symbolKind: "function",
      name: "router",
      qualifiedName: "hub.router",
      language: "typescript",
      path: "src/router.ts",
      startLine: 3,
      endLine: 7,
      signature: "router(): void",
    };
    const graph: HubGraphReadService = {
      inspectStatus: async () => status,
      searchBundle: async () => ({
        revision: "c".repeat(64),
        status,
        nodes: {
          ok: true,
          value: { items: [symbol], nextCursor: "next-symbol", truncated: false },
        },
        sources: {
          ok: false,
          problem: {
            title: "Stale cursor",
            status: 409,
            code: "REVISION_CONFLICT",
            detail: "private stale cursor detail",
          },
        },
      }),
      readSymbolWorkspace: async () => ({
        revision: "c".repeat(64),
        status,
        symbol,
        source: {
          items: [{
            path: "src/router.ts",
            startLine: 3,
            endLine: 7,
            content: "export function router() {}",
            contentHash: "d".repeat(64),
            symbolRefs: [symbol.ref],
          }],
          nextCursor: null,
          truncated: false,
        },
        callers: {
          items: [{
            kind: "calls",
            source: { kind: "symbol", symbolId: "function:caller" },
            target: symbol.ref,
            path: "src/caller.ts",
            line: 9,
            provenance: "semantic",
          }],
          nextCursor: null,
          truncated: false,
        },
        callees: null,
        impact: null,
      }),
    };
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.capabilities()).resolves.toMatchObject({
      graph: {
        read: { availability: "available" },
        refresh: { availability: "available" },
        rebuild: { availability: "available" },
      },
      wiki: { read: { availability: "unavailable" } },
    });
    const search = await services.search({ q: "router", limit: 25 });
    expect(search.groups.symbols).toMatchObject({
      status: "available",
      revision: "c".repeat(64),
      items: [{ kind: "code_symbol", id: "function:router", path: "src/router.ts" }],
    });
    expect(search.groups.sources).toMatchObject({
      status: "failed",
      code: "REVISION_CONFLICT",
      revision: null,
    });

    await expect(services.codeSymbol?.("function:router", {
      view: "callers",
      limit: 25,
    })).resolves.toMatchObject({
      revision: "c".repeat(64),
      symbol: { id: "function:router" },
      source: { items: [{ content: "export function router() {}" }] },
      traversal: {
        view: "callers",
        items: [{ sourceId: "function:caller", targetId: "function:router" }],
      },
    });

    const health = await services.health();
    const graphHealth = health.components.find((component) => component.id === "graph");
    expect(graphHealth).toMatchObject({
      status: "degraded",
      repairJobKind: "graph_refresh",
      graph: {
        indexStatus: "stale",
        allowedJobKinds: ["graph_refresh"],
        recommendedJobKind: "graph_refresh",
      },
    });
    expect(JSON.stringify(graphHealth)).not.toContain("/Users/alice");
    await expect(services.assertJobStartAllowed?.("graph_refresh")).resolves.toBeUndefined();
    await expect(services.assertJobStartAllowed?.("graph_rebuild")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
  });

  it("recognizes legacy rebuild remediation and marks structural inspection failure unavailable", async () => {
    const missing = {
      status: "missing" as const,
      observedAt: NOW.toISOString(),
      currentRepo: { branch: "main", head: null, dirty: false, observedAt: NOW.toISOString() },
      lastSuccessfulIndexAt: null,
      indexedAt: null,
      indexedBranch: null,
      indexedHead: null,
      schemaVersion: null,
      extractorVersion: null,
      grammarVersion: null,
      parseHealth: { total: 0, ok: 0, partial: 0, failed: 0, failedPaths: [], failedPathsTruncated: false },
      changes: {
        total: 0,
        added: [],
        modified: [],
        deleted: [],
        truncated: false,
        branchChanged: false,
        manifestChanged: false,
        configChanged: false,
        grammarChanged: false,
      },
      diagnostics: [{
        code: "GRAPH_INDEX_MISSING",
        severity: "warning" as const,
        message: "missing",
        remediation: [{ label: "Build graph", command: "mex graph" }],
      }],
    };
    const base = {
      searchBundle: async () => { throw new Error("unused"); },
      readSymbolWorkspace: async () => { throw new Error("unused"); },
    };
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph: { ...base, inspectStatus: async () => missing },
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    await expect(services.assertJobStartAllowed?.("graph_rebuild")).resolves.toBeUndefined();

    const failed = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph: { ...base, inspectStatus: async () => { throw new Error("/Users/alice/private"); } },
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    const health = await failed.health();
    expect(health.components.find((component) => component.id === "graph")).toMatchObject({
      status: "unavailable",
    });
    expect(JSON.stringify(health)).not.toContain("/Users/alice");
  });

  it("lets the durable job manager retain its authoritative active-job conflict", async () => {
    const inspectStatus = vi.fn(async () => { throw new Error("must not inspect during contention"); });
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph: {
        inspectStatus,
        searchBundle: async () => { throw new Error("unused"); },
        readSymbolWorkspace: async () => { throw new Error("unused"); },
      },
      jobs: {
        list: () => ({
          items: [{
            id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            scaffoldId: "scaffold-local",
            kind: "graph_refresh",
            generation: 1,
            phase: "running",
            progress: null,
            state: "running",
            cancelRequested: false,
            createdAt: NOW.toISOString(),
            startedAt: NOW.toISOString(),
            revision: "a".repeat(64),
          }],
        }),
      },
      now: () => new Date(NOW),
    });

    await expect(services.assertJobStartAllowed?.("graph_rebuild")).resolves.toBeUndefined();
    expect(inspectStatus).not.toHaveBeenCalled();
  });

  it("projects canonical and legacy activity without exposing private fields", async () => {
    const activity = new ActivityRepository({
      projectRoot,
      git,
      now: () => new Date(NOW),
      generateId: () => EVENT,
    });
    const longPath = `src/${"x".repeat(390)}.ts`;
    const preview = await activity.previewCreate({
      actor: { kind: "git", name: "Daksh", email: "daksh@example.test" },
      action: "member.updated",
      subjects: [
        { kind: "entity", entity: { id: "workstream_alpha", kind: "workstream", title: "Alpha" } },
        { kind: "code", code: { kind: "symbol", symbolId: "symbol:router" } },
        { kind: "code", code: { kind: "file", path: "src/router.ts" } },
        { kind: "file", path: longPath },
        { kind: "commit", hash: "a".repeat(40) },
        { kind: "file", path: "src/1.ts" },
        { kind: "file", path: "src/2.ts" },
        { kind: "file", path: "src/3.ts" },
        { kind: "file", path: "src/4.ts" },
        { kind: "file", path: "src/5.ts" },
      ],
      workstream: { id: "workstream_alpha", kind: "workstream", title: "Alpha" },
      metadata: { reason: "private projection detail" },
    });
    await activity.applyCreate(preview, preview.previewRevision);
    await new MemberRepository(projectRoot).create({
      id: MEMBER,
      displayName: "Daksh Current",
      gitAliases: [{ name: "Daksh", email: "daksh@example.test" }],
    });

    mkdirSync(join(projectRoot, ".mex/events"), { recursive: true });
    writeFileSync(join(projectRoot, ".mex/events/decisions.jsonl"), [
      JSON.stringify({
        timestamp: "2026-08-24T00:00:00.000Z",
        kind: "note",
        message: "Legacy note",
        files: ["src/legacy.ts", longPath, "/Users/alice/private.ts", "src/\u0080.ts"],
        cwd: "/Users/alice/private-project",
        trace: "/Users/alice/private-trace",
        source: "secret-origin",
        status: "private-status",
      }),
      "not valid json",
      "",
    ].join("\n"), "utf8");

    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.capabilities()).resolves.toMatchObject({
      activity: { availability: "available" },
    });
    await expect(services.overview?.()).resolves.toMatchObject({
      activity: { availability: "available", items: expect.any(Array) },
    });

    const result = await services.activity({ limit: 25 });
    expect(result.items.map((item) => item.source)).toEqual(["legacy", "activity"]);
    const legacy = result.items[0];
    expect(legacy).toMatchObject({
      source: "legacy",
      recordedActor: null,
      effectiveActor: null,
      repository: null,
      message: "Legacy note",
      messageTruncated: false,
      subjectCount: 2,
      subjectsTruncated: true,
      subjects: [{ kind: "file", path: "src/legacy.ts" }],
    });
    const canonical = result.items[1];
    expect(canonical).toMatchObject({
      source: "activity",
      recordedActor: { kind: "git", name: "Daksh", email: "daksh@example.test" },
      effectiveActor: { kind: "member", memberId: MEMBER, displayName: "Daksh Current" },
      recordOrigin: { kind: "custom" },
      label: null,
      subjectCount: 10,
      subjectsTruncated: true,
      workstream: { id: "workstream_alpha", entityKind: "workstream", title: "Alpha" },
    });
    expect(canonical?.subjects).toHaveLength(8);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "LEGACY_ACTIVITY_MALFORMED",
      message: "A malformed legacy activity row was ignored.",
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private projection detail");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("private-trace");
    expect(serialized).not.toContain("secret-origin");
    expect(serialized).not.toContain("private-status");
  });

  it("caps projected diagnostics and reports a truncated legacy message", async () => {
    mkdirSync(join(projectRoot, ".mex/events"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".mex/events/decisions.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-08-24T00:00:00.000Z",
        kind: "note",
        message: "é".repeat(1_100),
        files: [],
      })}\n${Array.from({ length: 60 }, () => "malformed").join("\n")}\n`,
      "utf8",
    );
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    const result = await services.activity({ source: "legacy", limit: 25 });
    expect(result.diagnostics).toHaveLength(50);
    expect(result.diagnosticsTruncated).toBe(true);
    expect(result.items[0]).toMatchObject({
      source: "legacy",
      messageTruncated: true,
    });
    expect(Buffer.byteLength((result.items[0] as { message: string }).message, "utf8")).toBe(2_048);
  });
});
