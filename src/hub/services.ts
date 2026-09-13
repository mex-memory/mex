import { readAgentLoggingPolicy, setAgentLoggingPolicy } from "../logging/policy.js";
import { completeHubOnboarding, readHubOnboarding } from "./onboarding.js";
import {
  AgentLoggingPolicySchema,
  HubOnboardingStateSchema,
  HUB_LIMITS,
  type ActivityActor,
  type ActivityDiagnostic,
  type ActivityEntityRef,
  type ActivityRequest,
  type ActivityResponse,
  type ActivitySubject,
  type CapabilityStatus,
  type CodeWorkspaceRequest,
  type CodeWorkspaceResponse,
  type CodeKnowledgeRequest,
  type CodeKnowledgeResponse,
  type GraphHealthDetails,
  type GraphRelation as HubGraphRelation,
  type GraphSymbol as HubGraphSymbol,
  type HealthResponse,
  type HomeResponse,
  type HubActor,
  type HubCapabilities,
  type HubJobSnapshot,
  type InboxDraftDetail,
  type InboxDraftInput,
  type InboxDraftListRequest,
  type InboxDraftListResponse,
  type InboxDraftSummary,
  type InboxEvidenceRef,
  type InboxLocalChange,
  type InboxOperationApplyRequest,
  type InboxOperationApplyResponse,
  type InboxOperationPreviewRequest,
  type InboxOperationPreviewResponse,
  type InboxProposalDetail,
  type InboxProposalListRequest,
  type InboxProposalListResponse,
  type InboxProposalSummary,
  type InboxSpecChange,
  type OverviewContextPanel,
  type OverviewFocusInboxSource,
  type OverviewFocusRelaySource,
  type OverviewResponse,
  type RelayDetail,
  type RelayDraftDetail,
  type RelayDraftInput,
  type RelayDraftListRequest,
  type RelayDraftListResponse,
  type RelayDraftSummary,
  type RelayEvidenceRef,
  type RelayListRequest,
  type RelayListResponse,
  type RelayLocalChange,
  type RelayOperationApplyRequest,
  type RelayOperationApplyResponse,
  type RelayOperationPreviewRequest,
  type RelayOperationPreviewResponse,
  type RelaySummary,
  type TeamFileChange,
  type SearchRequest,
  type SearchResponse,
  type SpecDetailResponse,
  type SpecListRequest,
  type SpecListResponse,
  type TeamCurrentActorResponse,
  type TeamMember as HubTeamMember,
  type TeamMemberListRequest as HubTeamMemberListRequest,
  type TeamMemberListResponse,
  type TeamOperationApplyRequest,
  type TeamOperationApplyResponse,
  type TeamOperationPreviewRequest,
  type TeamOperationPreviewResponse,
  type TeamWorkstream as HubTeamWorkstream,
  type TeamWorkstreamListRequest as HubTeamWorkstreamListRequest,
  type TeamWorkstreamListResponse,
  type WikiBacklinksRequest,
  type WikiBacklinksResponse,
  type WikiEntityDetailResponse,
  type WikiEntityListRequest,
  type WikiEntityListResponse,
  type WikiEntitySummary as HubWikiEntitySummary,
  type WikiGrounding as HubWikiGrounding,
  type WikiGraphResponse,
  type WikiGroundedCodeResponse,
  type WikiHealthDetails,
  type WikiRelation as HubWikiRelation,
  type WikiRelationsRequest,
  type WikiRelationsResponse,
} from "@mex/hub-contracts";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  GraphImpactResult,
  GraphRelation,
  GraphSource,
  GraphStatus,
  CodeSymbol,
} from "../team/contracts/graph.js";
import type { GitPort } from "../team/contracts/git.js";
import {
  isRepoRelativePath,
  type ActorRef,
  type Diagnostic,
  type EntityRef,
  type JsonValue,
  type RepoState,
  type RevisionExpectation,
  type FileChange,
} from "../team/contracts/shared.js";
import type {
  ActivityEvent,
  ActivitySubjectRef,
  StoredActivityEvent,
  TeamEvidenceRef,
  TeamActivityListRequest,
  TeamCurrentActor,
  TeamIdentityActivityCommand,
  TeamIdentityActivityPreviewEnvelope,
  TeamInboxDraftListRequest,
  TeamInboxProposalListRequest,
  TeamInboxSpecApplyResult,
  TeamInboxSpecCommand,
  TeamInboxSpecDraftDetail,
  TeamInboxSpecDraftSummary,
  TeamInboxSpecDraftInput,
  TeamInboxSpecPage,
  TeamInboxSpecPreviewEnvelope,
  TeamInboxSpecProposalDetail,
  TeamInboxSpecProposalSummary,
  TeamInboxSpecRef,
  TeamRelayApplyResult,
  TeamRelayCommand,
  TeamRelayDetail,
  TeamRelayDraftDetail,
  TeamRelayDraftListRequest,
  TeamRelayDraftSummary,
  TeamRelayListRequest,
  TeamRelayPage,
  TeamRelayPreviewEnvelope,
  TeamRelaySummary,
  TeamMember,
  TeamMemberListRequest,
  TeamPage,
  TeamWorkstreamCommand,
  TeamWorkstreamListRequest,
  TeamWorkstreamPreviewEnvelope,
  TeamWorkflowResult,
  Workstream,
} from "../team/contracts/workflow.js";
import type {
  SpecDetailProjection,
  SpecIndexProjection,
  SpecListResult,
  SpecReadService,
  SpecShowResult,
  SpecSummaryProjection,
} from "../team/specs/service.js";
import type {
  WikiEntity,
  WikiEntitySummary,
  WikiGroundingResolution,
  WikiIndexStatus,
  WikiListRequest,
  WikiQueryRequest,
  WikiRelation,
  WikiRelationHit,
  WikiSource,
} from "../team/contracts/wiki.js";
import {
  ActivityRepository,
  TimelineReader,
  type ResolvedTimelineEntry,
  type ResolvedTimelinePage,
} from "../team/activity/repository.js";
import { createRepositoryGitPort } from "../team/git/git-port.js";
import { ActorResolver } from "../team/identity/actor-resolver.js";
import { MemberRepository } from "../team/identity/member-repository.js";
import { normalizeTeamInboxSpecCommand } from "../team/inbox/spec-authoring.js";
import type { HubReadServices } from "./app.js";
import { HubHttpError } from "./http/errors.js";
import type {
  GraphSearchBundleRequest,
  GraphSearchBundleResult,
  GraphBoundedSourceMatch,
  GraphSymbolWorkspaceRequest,
  GraphSymbolWorkspaceResult,
} from "../graph/application-adapter.js";
import type {
  RepositoryCodeKnowledgeRequest,
  RepositoryCodeKnowledgeResult,
  RepositoryKnowledgeWorkspace,
  RepositoryKnowledgeWorkspaceRequest,
  RepositoryWikiListBundle,
  RepositoryWikiSearchBundle,
  RepositoryWikiGraphOverview,
  RepositoryWikiGroundedCode,
} from "../wiki/application-adapter.js";
import {
  TEAM_READABLE_ENTITY_TYPES,
  WIKI_ENTITY_TYPES,
} from "../wiki/model/entity.js";

interface HubJobReader {
  list(request?: { limit?: number }): {
    items: readonly HubJobSnapshot[];
    nextCursor?: string | null;
  };
}

/** Narrow structural seam so production can inject the repository adapter and tests can stay isolated. */
export interface HubGraphReadService {
  inspectStatus(): Promise<GraphStatus>;
  searchBundle(request: GraphSearchBundleRequest): Promise<GraphSearchBundleResult>;
  readSymbolWorkspace(request: GraphSymbolWorkspaceRequest): Promise<GraphSymbolWorkspaceResult>;
}

/** Narrow private seam implemented by the repository-bound Wiki adapter. */
export interface HubWikiReadService {
  inspectIndex(): Promise<WikiIndexStatus>;
  listBundle(request: WikiListRequest): Promise<RepositoryWikiListBundle>;
  searchBundle(request: WikiQueryRequest): Promise<RepositoryWikiSearchBundle>;
  readKnowledgeWorkspace(request: RepositoryKnowledgeWorkspaceRequest): Promise<RepositoryKnowledgeWorkspace>;
  knowledgeForCode(request: RepositoryCodeKnowledgeRequest): Promise<RepositoryCodeKnowledgeResult>;
  graphOverview?(): Promise<RepositoryWikiGraphOverview>;
  readGroundedCode?(entityId: string): Promise<RepositoryWikiGroundedCode>;
}

/** Exact internal C0 application facade used by the private Hub. */
export interface HubTeamIdentityActivityService {
  getMember(memberId: string): Promise<TeamMember | null>;
  listMembers(request?: TeamMemberListRequest): Promise<TeamPage<TeamMember>>;
  getCurrentActor(): Promise<TeamCurrentActor>;
  getActivity(id: string): Promise<StoredActivityEvent | null>;
  listActivity(request?: TeamActivityListRequest): Promise<TeamPage<StoredActivityEvent>>;
  previewIdentityActivity(
    command: TeamIdentityActivityCommand,
  ): Promise<TeamIdentityActivityPreviewEnvelope>;
  applyIdentityActivity(
    envelope: TeamIdentityActivityPreviewEnvelope,
  ): Promise<TeamWorkflowResult<JsonValue>>;
}

export interface HubTeamWorkstreamService {
  getWorkstream(workstreamId: string): Promise<Workstream | null>;
  listWorkstreams(request?: TeamWorkstreamListRequest): Promise<TeamPage<Workstream>>;
  previewWorkstream(command: TeamWorkstreamCommand): Promise<TeamWorkstreamPreviewEnvelope>;
  applyWorkstream(
    envelope: TeamWorkstreamPreviewEnvelope,
  ): Promise<TeamWorkflowResult<JsonValue>>;
}

/** Exact private Checkpoint E facade consumed by the loopback Hub only. */
export interface HubInboxSpecAuthoringService {
  getInboxDraft(draftId: string): Promise<TeamInboxSpecDraftDetail | null>;
  listInboxDrafts(
    request?: TeamInboxDraftListRequest,
  ): Promise<TeamInboxSpecPage<TeamInboxSpecDraftSummary>>;
  getInboxProposal(proposalId: string): Promise<TeamInboxSpecProposalDetail | null>;
  listInboxProposals(
    request?: TeamInboxProposalListRequest,
  ): Promise<TeamInboxSpecPage<TeamInboxSpecProposalSummary>>;
  previewInbox(command: TeamInboxSpecCommand): Promise<TeamInboxSpecPreviewEnvelope>;
  applyInbox(envelope: TeamInboxSpecPreviewEnvelope): Promise<TeamInboxSpecApplyResult>;
}

/** Exact private Relay facade consumed by the loopback Hub only. */
export interface HubRelayHandoffService {
  getRelayDraft(draftId: string): Promise<TeamRelayDraftDetail | null>;
  listRelayDrafts(
    request?: TeamRelayDraftListRequest,
  ): Promise<TeamRelayPage<TeamRelayDraftSummary>>;
  getRelay(relayId: string): Promise<TeamRelayDetail | null>;
  listRelays(request?: TeamRelayListRequest): Promise<TeamRelayPage<TeamRelaySummary>>;
  previewRelay(command: TeamRelayCommand): Promise<TeamRelayPreviewEnvelope>;
  applyRelay(envelope: TeamRelayPreviewEnvelope): Promise<TeamRelayApplyResult>;
}

export interface LocalHubReadServicesOptions {
  readonly projectRoot: string;
  readonly scaffoldId: string;
  readonly jobs: HubJobReader;
  readonly team: HubTeamIdentityActivityService;
  readonly workstreams?: HubTeamWorkstreamService;
  readonly inbox?: HubInboxSpecAuthoringService;
  readonly relays?: HubRelayHandoffService;
  readonly specs?: SpecReadService;
  readonly git?: GitPort;
  readonly graph?: HubGraphReadService;
  readonly wiki?: HubWikiReadService;
  readonly now?: () => Date;
}

/**
 * Honest production read model for the local Hub.
 *
 * Every populated projection comes from bounded repository services. Missing
 * adapters stay explicitly unavailable; the read model never invents visual
 * data or performs a mutation to make a panel look ready.
 */
export function createLocalHubReadServices(
  options: LocalHubReadServicesOptions,
): HubReadServices {
  const now = options.now ?? (() => new Date());
  const git = options.git ?? createRepositoryGitPort(options.projectRoot, { now });
  const graph = options.graph;
  const wiki = options.wiki;
  const team = options.team;
  const workstreams = options.workstreams;
  const inbox = options.inbox;
  const relays = options.relays;
  const specs = options.specs;
  // Activity's existing workbench includes bounded legacy JSONL alongside
  // canonical events and resolves today's effective member separately from the
  // immutable recorded actor. Keep that read model independent from C0 writes.
  const members = new MemberRepository(options.projectRoot);
  const actors = new ActorResolver(members, git);
  const canonicalActivity = new ActivityRepository({
    projectRoot: options.projectRoot,
    git,
    now,
  });
  const timeline = new TimelineReader(options.projectRoot, canonicalActivity, actors);

  return {
    loggingPolicy() {
      return AgentLoggingPolicySchema.parse(readAgentLoggingPolicy(options.projectRoot));
    },
    async setLoggingPolicy(request) {
      return AgentLoggingPolicySchema.parse(await setAgentLoggingPolicy(options.projectRoot, request));
    },
    onboardingState() {
      return HubOnboardingStateSchema.parse(readHubOnboarding(options.projectRoot));
    },
    async completeOnboarding() {
      return HubOnboardingStateSchema.parse(await completeHubOnboarding(options.projectRoot));
    },
    async capabilities(): Promise<HubCapabilities> {
      const gitStatus = await gitCapability(git);
      return {
        apiVersion: "v1",
        git: gitStatus,
        activity: available(),
        activityRecord: available(),
        members: {
          read: available(),
          canonicalMutation: available(),
          localSelection: available(),
        },
        workstreams: {
          read: workstreams ? available() : unavailable("Workstream reads are not connected in this build."),
          canonicalMutation: workstreams ? available() : unavailable("Workstream mutations are not connected in this build."),
        },
        specs: {
          read: specs ? available() : unavailable("The read-only Spec service is not connected in this build."),
        },
        inbox: {
          read: inbox ? available() : unavailable("Inbox reads are not connected in this build."),
          draftMutation: inbox ? available() : unavailable("Inbox draft mutations are not connected in this build."),
          proposalMutation: inbox
            ? available()
            : unavailable("Inbox proposal mutations are not connected in this build."),
          specApproval: inbox && wiki
            ? available()
            : unavailable("Inbox Spec approval requires exact Wiki planning and apply."),
        },
        relays: {
          read: relays ? available() : unavailable("Relay reads are not connected in this build."),
          draftMutation: relays ? available() : unavailable("Relay draft mutations are not connected in this build."),
          publish: relays ? available() : unavailable("Relay publication is not connected in this build."),
          lifecycleMutation: relays ? available() : unavailable("Relay lifecycle mutations are not connected in this build."),
        },
        jobs: available(),
        graph: {
          read: graph ? available() : unavailable("The GraphPort is not connected in this build."),
          refresh: graph ? available() : unavailable("Graph refresh requires the Lane A adapter."),
          rebuild: graph ? available() : unavailable("Graph rebuild requires the Lane A recovery adapter."),
        },
        wiki: {
          read: wiki ? available() : unavailable("The WikiPort is not connected in this build."),
          refresh: wiki ? available() : unavailable("Wiki refresh requires the repository adapter."),
          rebuild: wiki ? available() : unavailable("Wiki rebuild requires the repository adapter."),
        },
      };
    },

    async home(): Promise<HomeResponse> {
      const observedAt = now().toISOString();
      const [repository, identity, inboxRead, relayRead] = await Promise.all([
        git.getRepoState(),
        readOverviewIdentity(team, observedAt),
        readOverviewInbox(inbox, observedAt),
        readOverviewRelays(relays, observedAt),
      ]);
      const jobsRead = readOverviewJobs(options.jobs, observedAt);
      return projectHomeResponse({
        observedAt,
        scaffoldId: options.scaffoldId,
        projectRoot: options.projectRoot,
        repository,
        identity,
        inbox: inboxRead,
        relays: relayRead,
        jobs: jobsRead,
      });
    },

    async overview(): Promise<OverviewResponse> {
      const observedAt = now().toISOString();
      const [repository, identity, inboxRead, relayRead, activity, graphRead, wikiRead] = await Promise.all([
        git.getRepoState(),
        readOverviewIdentity(team, observedAt),
        readOverviewInbox(inbox, observedAt),
        readOverviewRelays(relays, observedAt),
        readOverviewActivity(timeline, observedAt),
        readOverviewGraph(graph, observedAt),
        readOverviewWiki(wiki, observedAt),
      ]);
      const jobsRead = readOverviewJobs(options.jobs, observedAt);
      const shell = projectHomeResponse({
        observedAt,
        scaffoldId: options.scaffoldId,
        projectRoot: options.projectRoot,
        repository,
        identity,
        inbox: inboxRead,
        relays: relayRead,
        jobs: jobsRead,
      });
      const focusSources = projectOverviewFocus(identity, inboxRead, relayRead, observedAt);
      return {
        observedAt,
        shell,
        identity,
        focus: focusSources,
        activity,
        context: projectOverviewContext(graphRead, wikiRead, observedAt),
        operation: projectOverviewOperation(jobsRead, observedAt),
      };
    },

    async members(request: HubTeamMemberListRequest): Promise<TeamMemberListResponse> {
      let pageLimit = request.limit;
      while (true) {
        const page = await team.listMembers({
          active: request.active,
          limit: pageLimit,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        });
        const diagnostics = page.diagnostics.map(projectDiagnostic);
        const response: TeamMemberListResponse = {
          items: page.items.map(projectTeamMember),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          sourceTruncated: page.sourceTruncated,
          deterministicRevision: page.deterministicRevision,
          diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
          diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        // Recompute the cursor and rows together at a smaller maximum. Trimming
        // an already-built page would make its continuation cursor skip data.
        if (pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async member(memberId: string): Promise<HubTeamMember | null> {
      const member = await team.getMember(memberId);
      return member === null ? null : projectTeamMember(member);
    },

    async workstreams(
      request: HubTeamWorkstreamListRequest,
    ): Promise<TeamWorkstreamListResponse> {
      if (workstreams === undefined) throw unavailableWorkstreams();
      let pageLimit = request.limit;
      while (true) {
        const page = await workstreams.listWorkstreams({
          ...(request.state === undefined ? {} : { states: [request.state] }),
          ...(request.includeArchived === undefined ? {} : { includeArchived: request.includeArchived }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          limit: pageLimit,
        });
        const diagnostics = page.diagnostics.map(projectDiagnostic);
        const response: TeamWorkstreamListResponse = {
          items: page.items.map(projectTeamWorkstream),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          sourceTruncated: page.sourceTruncated,
          deterministicRevision: page.deterministicRevision,
          diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
          diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        if (pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async workstream(workstreamId: string): Promise<HubTeamWorkstream | null> {
      if (workstreams === undefined) throw unavailableWorkstreams();
      const item = await workstreams.getWorkstream(workstreamId);
      return item === null ? null : projectTeamWorkstream(item);
    },

    async inboxDrafts(request: InboxDraftListRequest): Promise<InboxDraftListResponse> {
      if (inbox === undefined) throw unavailableInbox();
      let pageLimit = request.limit;
      while (true) {
        const page = await inbox.listInboxDrafts({
          limit: pageLimit,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        });
        const diagnostics = page.diagnostics.map(projectDiagnostic);
        const response: InboxDraftListResponse = {
          items: page.items.map(projectInboxDraftSummary),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          sourceTruncated: page.sourceTruncated,
          deterministicRevision: page.deterministicRevision,
          diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
          diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        if (pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async inboxDraft(draftId: string): Promise<InboxDraftDetail | null> {
      if (inbox === undefined) throw unavailableInbox();
      const draft = await inbox.getInboxDraft(draftId);
      return draft === null ? null : projectInboxDraftDetail(draft);
    },

    async inboxProposals(
      request: InboxProposalListRequest,
    ): Promise<InboxProposalListResponse> {
      if (inbox === undefined) throw unavailableInbox();
      let pageLimit = request.limit;
      while (true) {
        const page = await inbox.listInboxProposals({
          limit: pageLimit,
          ...(request.states === undefined ? {} : { states: request.states }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        });
        const diagnostics = page.diagnostics.map(projectDiagnostic);
        const response: InboxProposalListResponse = {
          items: page.items.map(projectInboxProposalSummary),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          sourceTruncated: page.sourceTruncated,
          deterministicRevision: page.deterministicRevision,
          diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
          diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        if (pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async inboxProposal(proposalId: string): Promise<InboxProposalDetail | null> {
      if (inbox === undefined) throw unavailableInbox();
      const proposal = await inbox.getInboxProposal(proposalId);
      return proposal === null ? null : projectInboxProposalDetail(proposal);
    },

    async previewInboxOperation(
      request: InboxOperationPreviewRequest,
    ): Promise<InboxOperationPreviewResponse> {
      if (inbox === undefined) throw unavailableInbox();
      return projectInboxPreviewEnvelope(await inbox.previewInbox(
        projectInboxCommandToService(request),
      ));
    },

    async applyInboxOperation(
      request: InboxOperationApplyRequest,
    ): Promise<InboxOperationApplyResponse> {
      if (inbox === undefined) throw unavailableInbox();
      const result = await inbox.applyInbox(projectInboxEnvelopeToService(request));
      return {
        operationId: result.operationId,
        previewRevision: result.previewRevision,
        applied: true,
        idempotentReplay: result.idempotentReplay,
        changes: result.changes.map(projectInboxFileChange),
        localChanges: result.localChanges.map(projectInboxLocalChange),
        proposals: result.proposals.map(projectInboxProposalDetail),
        events: result.events.map(projectTeamActivityEvent),
      };
    },

    async relayDrafts(request: RelayDraftListRequest): Promise<RelayDraftListResponse> {
      if (relays === undefined) throw unavailableRelays();
      let pageLimit = request.limit;
      while (true) {
        const page = await relays.listRelayDrafts({
          limit: pageLimit,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        });
        const diagnostics = page.diagnostics.map(projectDiagnostic);
        const response: RelayDraftListResponse = {
          items: page.items.map(projectRelayDraftSummary),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          sourceTruncated: page.sourceTruncated,
          deterministicRevision: page.deterministicRevision,
          diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
          diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        if (pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async relayDraft(draftId: string): Promise<RelayDraftDetail | null> {
      if (relays === undefined) throw unavailableRelays();
      const draft = await relays.getRelayDraft(draftId);
      return draft === null ? null : projectRelayDraftDetail(draft);
    },

    async relays(request: RelayListRequest): Promise<RelayListResponse> {
      if (relays === undefined) throw unavailableRelays();
      let pageLimit = request.limit;
      while (true) {
        const page = await relays.listRelays({
          perspective: request.perspective,
          ...(request.states === undefined ? {} : { states: request.states }),
          ...(request.workstreamId === undefined ? {} : { workstreamId: request.workstreamId }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          limit: pageLimit,
        });
        const diagnostics = page.diagnostics.map(projectDiagnostic);
        const response: RelayListResponse = {
          items: page.items.map(projectRelaySummary),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          sourceTruncated: page.sourceTruncated,
          deterministicRevision: page.deterministicRevision,
          diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
          diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        if (pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async relay(relayId: string): Promise<RelayDetail | null> {
      if (relays === undefined) throw unavailableRelays();
      const relay = await relays.getRelay(relayId);
      return relay === null ? null : projectRelayDetail(relay);
    },

    async previewRelayOperation(
      request: RelayOperationPreviewRequest,
    ): Promise<RelayOperationPreviewResponse> {
      if (relays === undefined) throw unavailableRelays();
      return projectRelayPreviewEnvelope(await relays.previewRelay(
        projectRelayCommandToService(request),
      ));
    },

    async applyRelayOperation(
      request: RelayOperationApplyRequest,
    ): Promise<RelayOperationApplyResponse> {
      if (relays === undefined) throw unavailableRelays();
      const result = await relays.applyRelay(projectRelayEnvelopeToService(request));
      return {
        operationId: result.operationId,
        previewRevision: result.previewRevision,
        applied: true,
        idempotentReplay: result.idempotentReplay,
        changes: result.changes.map(projectInboxFileChange),
        localChanges: result.localChanges.map(projectRelayLocalChange),
        relays: result.relays.map(projectRelayDetail),
        events: result.events.map(projectTeamActivityEvent),
      };
    },

    async specs(request: SpecListRequest): Promise<SpecListResponse> {
      if (specs === undefined) throw unavailableSpecs();
      let pageLimit = request.limit;
      while (true) {
        const response = projectSpecList(await specs.list({ ...request, limit: pageLimit }));
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        if (response.availability !== "ready" || pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async spec(specId: string): Promise<SpecDetailResponse> {
      if (specs === undefined) throw unavailableSpecs();
      return projectSpecDetail(await specs.show(specId));
    },

    async currentActor(): Promise<TeamCurrentActorResponse> {
      return projectCurrentActor(await team.getCurrentActor());
    },

    async previewTeamOperation(
      request: TeamOperationPreviewRequest,
    ): Promise<TeamOperationPreviewResponse> {
      if (isWorkstreamOperation(request)) {
        if (workstreams === undefined) throw unavailableWorkstreams();
        return projectTeamOperationEnvelope(
          await workstreams.previewWorkstream(toWorkstreamCommand(request)),
        );
      }
      return projectTeamOperationEnvelope(
        await team.previewIdentityActivity(toIdentityActivityCommand(request)),
      );
    },

    async applyTeamOperation(
      request: TeamOperationApplyRequest,
    ): Promise<TeamOperationApplyResponse> {
      const workstreamOperation = isWorkstreamOperation(request.request);
      const result = workstreamOperation
        ? await requireWorkstreamService(workstreams).applyWorkstream(
          toWorkstreamEnvelope(request),
        )
        : await team.applyIdentityActivity(toIdentityActivityEnvelope(request));
      if (result.artifacts.some((artifact) => (
        workstreamOperation ? artifact.kind !== "workstream" : artifact.kind !== "member"
      ))) {
        throw invalidTeamProjection();
      }
      return {
        operationId: result.operationId,
        previewRevision: result.previewRevision,
        applied: true,
        idempotentReplay: result.idempotentReplay,
        changes: result.changes.map((change) => ({ ...change })),
        localChanges: projectIdentityLocalChanges(result.localChanges),
        members: result.artifacts
          .filter((artifact): artifact is TeamMember => artifact.kind === "member")
          .map(projectTeamMember),
        workstreams: result.artifacts
          .filter((artifact): artifact is Workstream => artifact.kind === "workstream")
          .map(projectTeamWorkstream),
        events: result.events.map(projectTeamActivityEvent),
      };
    },

    async activity(request: ActivityRequest): Promise<ActivityResponse> {
      let pageLimit = request.limit;
      while (true) {
        const page = await timeline.listResolved({ ...request, limit: pageLimit });
        const response = projectActivityPage(page);
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        // `limit` is a maximum. Retry from the same revision-bound cursor with
        // a smaller coherent page rather than returning an oversized response
        // or trimming rows after their cursor was calculated.
        if (pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async search(request: SearchRequest): Promise<SearchResponse> {
      return unifiedSearch(graph, wiki, request, now);
    },

    async health(): Promise<HealthResponse> {
      let gitStatus: "healthy" | "degraded" = "healthy";
      let gitSummary = "Repository state is readable without mutation.";
      try {
        await git.getRepoState();
      } catch {
        gitStatus = "degraded";
        gitSummary = "Repository state could not be observed safely.";
      }

      const graphComponent = graph
        ? await projectGraphHealth(graph, options.jobs)
        : {
            id: "graph" as const,
            label: "Code graph",
            status: "unavailable" as const,
            summary: "Graph health requires the Lane A adapter.",
            diagnostics: [],
          };
      const wikiComponent = wiki
        ? await projectWikiHealth(wiki, options.jobs)
        : {
            id: "wiki" as const,
            label: "Wiki index",
            status: "unavailable" as const,
            summary: "Wiki health requires the repository adapter.",
            diagnostics: [],
          };
      const components: HealthResponse["components"] = [
        {
          id: "git",
          label: "Git repository",
          status: gitStatus,
          summary: gitSummary,
          diagnostics: [],
        },
        {
          id: "local_state",
          label: "Local Hub state",
          status: "healthy",
          summary: "Schema v3 job summaries are available locally.",
          diagnostics: [],
        },
        {
          id: "migration",
          label: "Local migration",
          status: "healthy",
          summary: "Local Hub state passed startup migration and validation.",
          diagnostics: [],
        },
        graphComponent,
        wikiComponent,
      ];
      return {
        status: components.every((component) => component.status === "healthy")
          ? "healthy"
          : "degraded",
        observedAt: now().toISOString(),
        components,
      };
    },

    async codeSymbol(
      symbolId: string,
      request: CodeWorkspaceRequest,
    ): Promise<CodeWorkspaceResponse> {
      if (!graph) {
        throw new HubHttpError(
          503,
          "CAPABILITY_UNAVAILABLE",
          "Capability unavailable",
          "Code graph reads are not connected in this build.",
        );
      }
      return readCodeWorkspace(graph, symbolId, request);
    },

    async wikiGraph(): Promise<WikiGraphResponse> {
      const connected = requireWiki(wiki);
      if (!connected.graphOverview) throw unavailableWikiGraph();
      return projectWikiGraph(await connected.graphOverview());
    },

    async wikiGroundedCode(entityId: string): Promise<WikiGroundedCodeResponse> {
      const connected = requireWiki(wiki);
      if (!connected.readGroundedCode) throw unavailableWikiGraph();
      const result = await connected.readGroundedCode(entityId);
      return {
        indexedRevision: result.indexedRevision, observedAt: result.observedAt,
        entityId: result.entityId, graphRevision: result.graphRevision,
        groundings: result.groundings.map((grounding) => ({
          requestedNode: boundedWikiText(grounding.requestedNode, 512, ""),
          resolvedNode: grounding.resolvedNode === null ? null : boundedWikiText(grounding.resolvedNode, 512, ""),
          health: grounding.health,
          symbol: grounding.symbol === null ? null : projectGraphSymbol(grounding.symbol),
        })),
        truncated: result.truncated,
      };
    },

    async wikiEntities(request: WikiEntityListRequest): Promise<WikiEntityListResponse> {
      const connected = requireWiki(wiki);
      if (request.kind !== undefined && isTeamReadableEntityKind(request.kind)) {
        throw new HubHttpError(
          400,
          "INVALID_REQUEST",
          "Invalid Knowledge kind",
          "Team-owned entity kinds are available through their dedicated Hub workbenches, not Knowledge.",
        );
      }
      const bundle = await connected.listBundle({
        limit: request.limit,
        includeArchived: request.lifecycle === "archived",
        kinds: request.kind === undefined ? WIKI_ENTITY_TYPES : [request.kind],
        ...(request.topic === undefined ? {} : { topics: [request.topic] }),
        ...(request.lifecycle === undefined ? {} : { lifecycleStates: [request.lifecycle] }),
        ...(request.grounding === undefined ? {} : { groundingHealth: [request.grounding] }),
        ...(request.sourceType === undefined ? {} : { sourceTypes: [request.sourceType] }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      return {
        indexedRevision: bundle.indexedRevision,
        observedAt: bundle.observedAt,
        items: bundle.results.items.map(projectWikiSummary),
        nextCursor: bundle.results.nextCursor,
        truncated: bundle.results.truncated,
      };
    },

    async wikiEntity(entityId: string): Promise<WikiEntityDetailResponse> {
      const workspace = await requireWiki(wiki).readKnowledgeWorkspace({ entityId });
      return projectWikiDetail(workspace);
    },

    async wikiRelations(
      entityId: string,
      request: WikiRelationsRequest,
    ): Promise<WikiRelationsResponse> {
      const workspace = await requireWiki(wiki).readKnowledgeWorkspace({
        entityId,
        view: "relations",
        direction: request.direction,
        includeArchived: true,
        limit: request.limit,
        ...(request.type === undefined ? {} : { relationTypes: [request.type] }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      if (workspace.selection.kind !== "relations") throw invalidWikiProjection();
      return {
        indexedRevision: workspace.indexedRevision,
        observedAt: workspace.observedAt,
        items: workspace.selection.results.items.map(projectWikiRelationHit),
        nextCursor: workspace.selection.results.nextCursor,
        truncated: workspace.selection.results.truncated,
      };
    },

    async wikiBacklinks(
      entityId: string,
      request: WikiBacklinksRequest,
    ): Promise<WikiBacklinksResponse> {
      const workspace = await requireWiki(wiki).readKnowledgeWorkspace({
        entityId,
        view: "backlinks",
        includeArchived: true,
        limit: request.limit,
        ...(request.type === undefined ? {} : { relationTypes: [request.type] }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      if (workspace.selection.kind !== "backlinks") throw invalidWikiProjection();
      return {
        indexedRevision: workspace.indexedRevision,
        observedAt: workspace.observedAt,
        items: workspace.selection.results.items.map(projectWikiRelation),
        nextCursor: workspace.selection.results.nextCursor,
        truncated: workspace.selection.results.truncated,
      };
    },

    async codeKnowledge(
      symbolId: string,
      request: CodeKnowledgeRequest,
    ): Promise<CodeKnowledgeResponse> {
      const result = await requireWiki(wiki).knowledgeForCode({
        nodeIds: [symbolId],
        limit: request.limit,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      return {
        indexedRevision: result.indexedRevision,
        observedAt: result.observedAt,
        items: result.items.map((item) => ({
          entity: projectWikiSummary(item.entity),
          matchedNodes: item.matchedNodes.slice(0, 50),
        })),
        nextCursor: result.nextCursor,
        truncated: result.truncated,
      };
    },

    async assertJobStartAllowed(kind): Promise<void> {
      if (!["graph_refresh", "graph_rebuild", "wiki_refresh", "wiki_rebuild"].includes(kind)) return;
      // Preserve the job manager's authoritative 409 contention response (and
      // active job ID). A running writer can make graph status deliberately
      // non-actionable, but it must not mask JOB_ALREADY_RUNNING as a 503.
      const active = options.jobs.list({ limit: 100 }).items.find((job) => (
        job.state === "queued" || job.state === "running"
      ));
      if (active) return;
      if (kind === "wiki_refresh" || kind === "wiki_rebuild") {
        if (!wiki) {
          throw new HubHttpError(
            503,
            "CAPABILITY_UNAVAILABLE",
            "Capability unavailable",
            "Wiki maintenance is not connected in this build.",
          );
        }
        const status = await wiki.inspectIndex();
        if (!allowedWikiOperations(status).includes(kind)) {
          throw new HubHttpError(
            503,
            "CAPABILITY_UNAVAILABLE",
            "Capability unavailable",
            "The requested Wiki operation is not safe for the current index state.",
          );
        }
        return;
      }
      if (!graph) {
        throw new HubHttpError(
          503,
          "CAPABILITY_UNAVAILABLE",
          "Capability unavailable",
          "Graph maintenance is not connected in this build.",
        );
      }
      const status = await graph.inspectStatus();
      const operations = allowedGraphOperations(status);
      if (!operations.includes(kind)) {
        throw new HubHttpError(
          503,
          "CAPABILITY_UNAVAILABLE",
          "Capability unavailable",
          "The requested graph operation is not safe for the current index state.",
        );
      }
    },
  };
}

async function unifiedSearch(
  graph: HubGraphReadService | undefined,
  wiki: HubWikiReadService | undefined,
  request: SearchRequest,
  now: () => Date,
): Promise<SearchResponse> {
  const wikiGroupPromise: Promise<SearchResponse["groups"]["wiki"]> = wiki === undefined
    ? Promise.resolve(unavailableSearch("Wiki search requires the repository adapter."))
    : wiki.searchBundle({
        query: request.q,
        limit: request.limit,
        kinds: WIKI_ENTITY_TYPES,
        ...(request.wikiCursor === undefined ? {} : { cursor: request.wikiCursor }),
      }).then((bundle): SearchResponse["groups"]["wiki"] => ({
        status: "available",
        items: bundle.results.items.map((hit) => projectWikiSearchHit(hit.entity, hit.matchedFields)),
        nextCursor: bundle.results.nextCursor,
        truncated: bundle.results.truncated,
        revision: bundle.indexedRevision,
      })).catch((error: unknown) => failedSearch(error));

  const graphGroupsPromise: Promise<Pick<SearchResponse["groups"], "symbols" | "sources">> = graph === undefined
    ? Promise.resolve({
        symbols: unavailableSearch("Code-symbol search requires the GraphPort adapter."),
        sources: unavailableSearch("Source-chunk search requires the GraphPort adapter."),
      })
    : graph.searchBundle({
        nodes: {
          query: request.q,
          limit: request.limit,
          ...(request.symbolCursor === undefined ? {} : { cursor: request.symbolCursor }),
        },
        sources: {
          query: request.q,
          limit: request.limit,
          maxLinesPerMatch: 40,
          maxBytesPerMatch: 2_048,
          ...(request.sourceCursor === undefined ? {} : { cursor: request.sourceCursor }),
        },
      }).then((bundle) => ({
        symbols: bundle.nodes.ok
          ? {
              status: "available" as const,
              items: bundle.nodes.value.items.map(projectSearchSymbol),
              nextCursor: bundle.nodes.value.nextCursor,
              truncated: bundle.nodes.value.truncated,
              revision: bundle.revision,
            }
          : failedSearch(bundle.nodes.problem),
        sources: bundle.sources.ok
          ? {
              status: "available" as const,
              items: bundle.sources.value.items.map((item) => projectSearchSource(item, bundle.revision)),
              nextCursor: bundle.sources.value.nextCursor,
              truncated: bundle.sources.value.truncated,
              revision: bundle.revision,
            }
          : failedSearch(bundle.sources.problem),
      })).catch((error: unknown) => ({
        // A final graph freshness invalidation makes both graph groups
        // untrustworthy, but it must not erase an independently fresh Wiki
        // group assembled by the sibling repository adapter.
        symbols: failedSearch(error),
        sources: failedSearch(error),
      }));
  const [wikiGroup, graphGroups] = await Promise.all([wikiGroupPromise, graphGroupsPromise]);
  return {
    query: request.q,
    observedAt: now().toISOString(),
    groups: {
      wiki: wikiGroup,
      symbols: graphGroups.symbols,
      sources: graphGroups.sources,
    },
  };
}

async function readCodeWorkspace(
  graph: HubGraphReadService,
  symbolId: string,
  request: CodeWorkspaceRequest,
): Promise<CodeWorkspaceResponse> {
  const relationRequest = request.view === "callers" || request.view === "callees"
    ? {
        limit: request.limit ?? 25,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      }
    : undefined;
  const workspace = await graph.readSymbolWorkspace({
    symbolId,
    workspaceView: request.view,
    source: {
      maxLines: 200,
      maxBytes: 128 * 1_024,
      limit: 25,
      ...(request.sourceCursor === undefined ? {} : { cursor: request.sourceCursor }),
    },
    ...(request.view === "callers" ? { callers: relationRequest } : {}),
    ...(request.view === "callees" ? { callees: relationRequest } : {}),
    ...(request.view === "impact"
      ? { impact: { depth: request.depth ?? 2, maxNodes: 100 } }
      : {}),
  });
  return {
    revision: workspace.revision,
    symbol: projectGraphSymbol(workspace.symbol),
    source: {
      items: workspace.source.items.map(projectGraphSource),
      nextCursor: workspace.source.nextCursor,
      truncated: workspace.source.truncated,
    },
    view: request.view,
    traversal: projectWorkspaceTraversal(workspace, request.view),
  };
}

function projectWorkspaceTraversal(
  workspace: GraphSymbolWorkspaceResult,
  view: CodeWorkspaceRequest["view"],
): CodeWorkspaceResponse["traversal"] {
  if (view === "overview") return { view };
  if (view === "callers" || view === "callees") {
    const page = view === "callers" ? workspace.callers : workspace.callees;
    if (page === null) throw invalidGraphProjection();
    return {
      view,
      items: page.items.map(projectGraphRelation),
      nextCursor: page.nextCursor,
      truncated: page.truncated,
    };
  }
  if (workspace.impact === null) throw invalidGraphProjection();
  return projectGraphImpact(workspace.impact);
}

function projectSearchSymbol(symbol: CodeSymbol): SearchResponse["groups"]["symbols"]["items"][number] {
  return { kind: "code_symbol", ...projectGraphSymbol(symbol) };
}

function projectSearchSource(
  source: GraphBoundedSourceMatch,
  graphRevision: string,
): SearchResponse["groups"]["sources"]["items"][number] {
  const preview = truncateUtf8(source.content, 2_048);
  const symbolIds = source.symbolRefs.map((ref) => ref.symbolId).slice(0, 8);
  return {
    id: createHash("sha256")
      .update(`${graphRevision}\0${source.path}\0${source.startLine}\0${source.endLine}\0${source.contentHash}`)
      .digest("hex"),
    kind: "source_chunk",
    path: source.path,
    startLine: source.startLine,
    endLine: source.endLine,
    preview,
    previewTruncated: source.bytesTruncated
      || source.linesTruncated
      || Buffer.byteLength(source.content, "utf8") > 2_048,
    matchedTerms: source.matchedTerms
      .map((term) => truncateUtf8(safeDisplayText(term), 128))
      .filter((term) => term.length > 0)
      .slice(0, 32),
    symbolIds,
    ...(symbolIds[0] === undefined
      ? {}
      : { route: graphSymbolRoute(symbolIds[0]) }),
  };
}

function projectGraphSymbol(symbol: CodeSymbol): HubGraphSymbol {
  return {
    id: symbol.ref.symbolId,
    symbolKind: truncateUtf8(safeDisplayText(symbol.symbolKind), 128),
    name: truncateUtf8(safeDisplayText(symbol.name), 512),
    qualifiedName: truncateUtf8(safeDisplayText(symbol.qualifiedName), 1_024),
    language: truncateUtf8(safeDisplayText(symbol.language), 128),
    path: symbol.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    ...(symbol.signature === undefined
      ? {}
      : { signature: truncateUtf8(safeDisplayText(symbol.signature), 2_048) }),
    route: graphSymbolRoute(symbol.ref.symbolId),
  };
}

function projectGraphSource(source: GraphSource): CodeWorkspaceResponse["source"]["items"][number] {
  return {
    path: source.path,
    startLine: source.startLine,
    endLine: source.endLine,
    content: truncateUtf8(source.content, 128 * 1_024),
    contentHash: source.contentHash,
    symbolIds: source.symbolRefs.map((ref) => ref.symbolId).slice(0, 100),
  };
}

function projectGraphRelation(relation: GraphRelation): HubGraphRelation {
  return {
    kind: truncateUtf8(safeDisplayText(relation.kind), 128),
    sourceId: relation.source.symbolId,
    targetId: relation.target.symbolId,
    ...(relation.path === undefined || !isCanonicalRepoPath(relation.path)
      ? {}
      : { path: relation.path }),
    ...(relation.line === undefined ? {} : { line: relation.line }),
    ...(relation.column === undefined ? {} : { column: relation.column }),
    ...(relation.confidence === undefined ? {} : { confidence: relation.confidence }),
    ...(relation.provenance === undefined
      ? {}
      : { provenance: truncateUtf8(safeDisplayText(relation.provenance), 128) }),
  };
}

function projectGraphImpact(impact: GraphImpactResult): CodeWorkspaceResponse["traversal"] {
  if (impact.target.kind !== "symbol") throw invalidGraphProjection();
  return {
    view: "impact",
    targetId: impact.target.symbolId,
    roots: impact.roots.slice(0, 100).map(projectGraphSymbol),
    impacted: impact.impacted.slice(0, 100).map((item) => ({
      symbol: projectGraphSymbol(item.symbol),
      depth: item.depth,
      rootId: item.root.symbolId,
    })),
    relations: impact.relations.slice(0, 500).map(projectGraphRelation),
    truncated: impact.truncated
      || impact.roots.length > 100
      || impact.impacted.length > 100
      || impact.relations.length > 500,
  };
}

function unavailableWikiGraph(): HubHttpError {
  return new HubHttpError(503, "CAPABILITY_UNAVAILABLE", "Capability unavailable", "Context graph reads are not connected in this build.");
}

function projectWikiGraph(bundle: RepositoryWikiGraphOverview): WikiGraphResponse {
  const result: WikiGraphResponse = {
    indexedRevision: bundle.indexedRevision, observedAt: bundle.observedAt,
    nodes: [], relations: [], coverage: { ...bundle.coverage },
  };
  let bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  for (const entity of bundle.nodes) {
    const node = projectWikiSummary(entity);
    const cost = Buffer.byteLength(JSON.stringify(node), "utf8") + (result.nodes.length > 0 ? 1 : 0);
    if (bytes + cost > HUB_LIMITS.maxJsonResponseBytes) {
      result.coverage.nodesTruncated = true;
      break;
    }
    bytes += cost;
    result.nodes.push(node);
  }
  const included = new Set(result.nodes.map((node) => node.id));
  for (const value of bundle.relations) {
    if (!included.has(value.source.id) || !included.has(value.target.id)) {
      result.coverage.relationsTruncated = true;
      continue;
    }
    const relation = projectWikiRelation(value);
    const cost = Buffer.byteLength(JSON.stringify(relation), "utf8") + (result.relations.length > 0 ? 1 : 0);
    if (bytes + cost > HUB_LIMITS.maxJsonResponseBytes) {
      result.coverage.relationsTruncated = true;
      break;
    }
    bytes += cost;
    result.relations.push(relation);
  }
  return result;
}

function projectWikiSummary(entity: WikiEntitySummary): HubWikiEntitySummary {
  if (!isCanonicalRepoPath(entity.location.path)) throw invalidWikiProjection();
  const topics = entity.topics.slice(0, 50);
  const safeSourceTypes = entity.sourceTypes
    .map((value) => safeWikiTaxonomy(value, "unknown"))
    .slice(0, 50);
  const diagnostics = entity.diagnostics.map(projectWikiDiagnostic);
  return {
    id: entity.ref.id,
    kind: safeWikiTaxonomy(entity.ref.kind, "unknown"),
    title: boundedWikiText(entity.title, 512, "Untitled Wiki entry"),
    summary: entity.summary === undefined ? null : boundedWikiText(entity.summary, 2_048, ""),
    lifecycleState: entity.lifecycleState,
    groundingHealth: entity.groundingHealth,
    topics,
    topicsTruncated: entity.topics.length > topics.length,
    sourceTypes: safeSourceTypes,
    sourceTypesTruncated: entity.sourceTypes.length > safeSourceTypes.length,
    location: {
      path: entity.location.path,
      startLine: entity.location.startLine ?? 1,
      endLine: Math.max(entity.location.startLine ?? 1, entity.location.endLine ?? entity.location.startLine ?? 1),
    },
    version: {
      semanticRevision: entity.version.semanticRevision,
      contentHash: entity.version.contentHash,
    },
    diagnostics: diagnostics.slice(0, 10),
    diagnosticsTruncated: diagnostics.length > 10,
    route: wikiEntityRoute(entity.ref.id),
  };
}

function projectWikiSearchHit(
  entity: WikiEntitySummary,
  matchedFields: readonly ("id" | "title" | "summary" | "body")[],
): SearchResponse["groups"]["wiki"]["items"][number] {
  const summary = projectWikiSummary(entity);
  return {
    id: summary.id,
    kind: "wiki",
    entityKind: summary.kind,
    title: summary.title,
    summary: summary.summary,
    lifecycleState: summary.lifecycleState,
    groundingHealth: summary.groundingHealth,
    topics: summary.topics,
    topicsTruncated: summary.topicsTruncated,
    sourceTypes: summary.sourceTypes,
    sourceTypesTruncated: summary.sourceTypesTruncated,
    path: summary.location.path,
    matchedFields: [...new Set(matchedFields)].slice(0, 4),
    route: summary.route,
  };
}

function projectWikiDetail(workspace: RepositoryKnowledgeWorkspace): WikiEntityDetailResponse {
  const entity: WikiEntity<never> = workspace.entity;
  const bodyBytes = Buffer.byteLength(entity.body, "utf8");
  const sources = entity.sources.slice(0, 50).map(projectWikiSource);
  const groundings = entity.groundings.slice(0, 50).map(projectWikiGrounding);
  return {
    indexedRevision: workspace.indexedRevision,
    observedAt: workspace.observedAt,
    entity: projectWikiSummary(entity),
    body: {
      content: truncateUtf8(entity.body, 128 * 1_024),
      totalBytes: bodyBytes,
      truncated: bodyBytes > 128 * 1_024,
    },
    provenance: entity.provenance === undefined
      ? null
      : {
          kind: entity.provenance.kind,
          id: safeEvidenceValue(entity.provenance.id, 256),
          capturedAt: isIsoTimestamp(entity.provenance.capturedAt)
            ? entity.provenance.capturedAt!
            : null,
        },
    sources: {
      items: sources,
      total: entity.sources.length,
      truncated: entity.sources.length > sources.length,
    },
    groundings: {
      items: groundings,
      total: entity.groundings.length,
      truncated: entity.groundings.length > groundings.length,
    },
    // The repository adapter rejects entities whose canonical relation arrays
    // exceed its safety bound, so these are exact for every successful detail.
    relationCount: entity.relations.length,
    backlinkCount: entity.backlinks.length,
  };
}

function projectSpecList(result: SpecListResult): SpecListResponse {
  const index = projectSpecIndex(result.index);
  if (result.availability !== "ready") {
    return { availability: result.availability, index, page: null };
  }
  return {
    availability: "ready",
    index,
    page: {
      schemaVersion: 1,
      items: result.page.items.map(projectSpecSummary),
      nextCursor: result.page.nextCursor,
      truncated: result.page.truncated,
      estimatedTokens: result.page.estimatedTokens,
      deterministicRevision: result.page.deterministicRevision,
    },
  };
}

function projectSpecDetail(result: SpecShowResult): SpecDetailResponse {
  const index = projectSpecIndex(result.index);
  if (result.availability !== "ready") {
    return { availability: result.availability, index, detail: null };
  }
  return {
    availability: "ready",
    index,
    detail: projectReadySpecDetail(result.detail),
  };
}

function projectSpecIndex(index: SpecIndexProjection): SpecListResponse["index"] {
  const diagnostics = index.diagnostics
    .map(projectWikiDiagnostic)
    .slice(0, HUB_LIMITS.maxDiagnosticCount);
  return {
    state: index.state,
    observedAt: index.observedAt,
    indexedRevision: index.indexedRevision,
    indexedAt: index.indexedAt,
    diagnostics,
    diagnosticsTruncated: index.diagnosticsTruncated
      || diagnostics.length < index.diagnostics.length,
  };
}

function projectSpecSummary(
  summary: SpecSummaryProjection,
): Extract<SpecListResponse, { availability: "ready" }>["page"]["items"][number] {
  const diagnostics = summary.diagnostics.map(projectWikiDiagnostic).slice(0, 10);
  return {
    schemaVersion: 1,
    id: summary.id,
    kind: summary.kind,
    title: summary.title,
    summary: summary.summary,
    lifecycleState: summary.lifecycleState,
    groundingHealth: summary.groundingHealth,
    sourcePath: summary.sourcePath,
    version: { ...summary.version },
    topics: [...summary.topics],
    sourceTypes: [...summary.sourceTypes],
    diagnostics,
    diagnosticsTruncated: summary.diagnosticsTruncated
      || diagnostics.length < summary.diagnostics.length,
  };
}

function projectReadySpecDetail(
  detail: SpecDetailProjection,
): Extract<SpecDetailResponse, { availability: "ready" }>["detail"] {
  return {
    schemaVersion: 1,
    spec: projectSpecSummary(detail.spec),
    body: detail.body,
    bodyTruncated: detail.bodyTruncated,
    provenance: detail.provenance === null
      ? null
      : {
          kind: detail.provenance.kind,
          id: safeEvidenceValue(detail.provenance.id, 256),
          capturedAt: isIsoTimestamp(detail.provenance.capturedAt)
            ? detail.provenance.capturedAt!
            : null,
        },
    sources: detail.sources.map(projectWikiSource),
    sourcesTruncated: detail.sourcesTruncated,
    groundings: detail.groundings.map(projectWikiGrounding),
    groundingsTruncated: detail.groundingsTruncated,
    hierarchy: {
      requirements: detail.hierarchy.requirements.map(projectSpecSummary),
      acceptanceCriteria: detail.hierarchy.acceptanceCriteria.map(projectSpecSummary),
      constraints: detail.hierarchy.constraints.map(projectSpecSummary),
      relations: detail.hierarchy.relations.map((relation) => ({
        type: relation.type,
        source: { ...relation.source },
        target: { ...relation.target },
        note: relation.note,
      })),
      estimatedTokens: detail.hierarchy.estimatedTokens,
    },
    deterministicRevision: detail.deterministicRevision,
  };
}

function projectWikiSource(source: WikiSource): WikiEntityDetailResponse["sources"]["items"][number] {
  const ref = source.type === "agent_session" ? null : safeEvidenceValue(source.ref, 2_048);
  return {
    type: safeWikiTaxonomy(source.type, "unknown"),
    ref,
    note: safeEvidenceValue(source.note, 2_048),
    repository: safeEvidenceValue(source.repository, 512),
    commit: safeEvidenceValue(source.commit, 128),
    capturedAt: isIsoTimestamp(source.capturedAt) ? source.capturedAt! : null,
  };
}

function projectWikiGrounding(value: WikiGroundingResolution): HubWikiGrounding {
  const candidates = value.state === "unresolved"
    ? (value.candidates ?? []).slice(0, 8).map((candidate) => ({
        node: boundedWikiText(candidate.node, 512, "unavailable"),
        fingerprint: candidate.fingerprint === undefined
          ? null
          : boundedWikiText(candidate.fingerprint, 256, ""),
        file: candidate.file !== undefined && isCanonicalRepoPath(candidate.file)
          ? candidate.file
          : null,
        score: typeof candidate.score === "number" && Number.isFinite(candidate.score)
          ? candidate.score
          : null,
      }))
    : [];
  if (value.state === "ungrounded") {
    return {
      state: "ungrounded",
      health: "unverified",
      requestedNode: null,
      resolvedNode: null,
      fingerprint: null,
      file: null,
      commit: null,
      verifiedAt: null,
      reason: safeEvidenceValue(value.reason, 1_024),
      candidates,
      candidatesTruncated: false,
    };
  }
  const grounding = value.grounding;
  return {
    state: value.state,
    health: value.health,
    requestedNode: boundedWikiText(value.requestedNode, 512, "unavailable"),
    resolvedNode: "resolvedNode" in value && value.resolvedNode !== undefined
      ? boundedWikiText(value.resolvedNode, 512, "")
      : null,
    fingerprint: boundedWikiText(grounding.fingerprint, 256, ""),
    file: grounding.file !== undefined && isCanonicalRepoPath(grounding.file)
      ? grounding.file
      : null,
    commit: safeEvidenceValue(grounding.commit, 128),
    verifiedAt: isIsoTimestamp(grounding.verifiedAt) ? grounding.verifiedAt! : null,
    reason: safeEvidenceValue(value.reason ?? grounding.reason, 1_024),
    candidates,
    candidatesTruncated: value.state === "unresolved"
      && (value.candidates?.length ?? 0) > candidates.length,
  };
}

function projectWikiRelationHit(hit: WikiRelationHit): WikiRelationsResponse["items"][number] {
  return {
    direction: hit.direction,
    relation: projectWikiRelation(hit.relation),
    entity: projectWikiSummary(hit.entity),
  };
}

function projectWikiRelation(relation: WikiRelation): HubWikiRelation {
  return {
    type: boundedWikiText(relation.type, 128, "related_to"),
    source: projectWikiRef(relation.source),
    target: projectWikiRef(relation.target),
    note: relation.note === undefined ? null : boundedWikiText(relation.note, 2_048, ""),
  };
}

function projectWikiRef(ref: EntityRef): HubWikiRelation["source"] {
  return {
    id: ref.id,
    kind: safeWikiTaxonomy(ref.kind, "unknown"),
    title: ref.title === undefined ? null : boundedWikiText(ref.title, 512, ""),
  };
}

async function projectWikiHealth(
  wiki: HubWikiReadService,
  jobs: HubJobReader,
): Promise<HealthResponse["components"][number]> {
  try {
    const status = await wiki.inspectIndex();
    const active = jobs.list({ limit: 100 }).items.find((job) => (
      (job.kind === "wiki_refresh" || job.kind === "wiki_rebuild")
      && (job.state === "queued" || job.state === "running")
    ));
    return projectWikiHealthStatus(status, active?.id ?? null);
  } catch {
    return {
      id: "wiki",
      label: "Wiki index",
      status: "unavailable",
      summary: "Wiki status could not be observed against a stable local snapshot.",
      diagnostics: [],
    };
  }
}

function projectWikiHealthStatus(
  status: WikiIndexStatus,
  activeJobId: string | null,
): HealthResponse["components"][number] {
  const allowedJobKinds = allowedWikiOperations(status);
  const recommendedJobKind = recommendedWikiOperation(status, allowedJobKinds);
  const wikiDetails: WikiHealthDetails = {
    indexStatus: status.state,
    observedAt: status.observedAt,
    indexedAt: status.indexedAt,
    schemaVersion: status.schemaVersion,
    indexedRevision: status.indexedRevision,
    allowedJobKinds,
    recommendedJobKind,
    activeJobId,
  };
  return {
    id: "wiki",
    label: "Wiki index",
    status: status.state === "fresh" ? "healthy" : "degraded",
    summary: wikiHealthSummary(status),
    diagnostics: status.diagnostics
      .slice(0, HUB_LIMITS.maxDiagnosticCount)
      .map(projectWikiDiagnostic),
    ...(recommendedJobKind === null ? {} : { repairJobKind: recommendedJobKind }),
    wiki: wikiDetails,
  };
}

function allowedWikiOperations(
  status: WikiIndexStatus,
): Array<"wiki_refresh" | "wiki_rebuild"> {
  if (status.diagnostics.some((diagnostic) => (
    diagnostic.code === "PATH_OUTSIDE_SCAFFOLD"
    || diagnostic.code === "WRITE_SCOPE_VIOLATION"
  ))) return [];
  switch (status.state) {
    case "stale": return ["wiki_refresh", "wiki_rebuild"];
    case "missing":
    case "corrupt":
    case "rebuild_required": return ["wiki_rebuild"];
    case "fresh": return ["wiki_refresh", "wiki_rebuild"];
    case "degraded":
    case "migration_required": return [];
  }
}

function recommendedWikiOperation(
  status: WikiIndexStatus,
  allowed: readonly ("wiki_refresh" | "wiki_rebuild")[],
): "wiki_refresh" | "wiki_rebuild" | null {
  if (status.state === "stale" && allowed.includes("wiki_refresh")) return "wiki_refresh";
  if (["missing", "corrupt", "rebuild_required"].includes(status.state)
    && allowed.includes("wiki_rebuild")) return "wiki_rebuild";
  return null;
}

function wikiHealthSummary(status: WikiIndexStatus): string {
  switch (status.state) {
    case "fresh": return "The Wiki index matches the current canonical Knowledge corpus.";
    case "missing": return "No Wiki index has been built for this repository.";
    case "stale": return "Canonical Knowledge changed and requires an explicit Wiki refresh.";
    case "degraded": return "Wiki health could not be established safely; retry after the local writer or observation race settles.";
    case "rebuild_required": return "The Wiki index requires an explicit compatible rebuild.";
    case "corrupt": return "The Wiki index failed integrity checks and cannot be read safely.";
    case "migration_required": return "Legacy Knowledge requires an explicit migration before Hub reads can continue.";
  }
}

function projectWikiDiagnostic(diagnostic: Diagnostic): HealthResponse["components"][number]["diagnostics"][number] {
  return {
    code: /^[A-Z0-9_]{1,128}$/.test(diagnostic.code) ? diagnostic.code : "WIKI_DIAGNOSTIC",
    severity: diagnostic.severity,
    message: wikiDiagnosticMessage(diagnostic.code),
    ...(diagnostic.path !== undefined && isCanonicalRepoPath(diagnostic.path)
      ? { path: diagnostic.path }
      : {}),
  };
}

function wikiDiagnosticMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    WIKI_INDEX_MISSING: "The Wiki index is missing.",
    WIKI_INDEX_REBUILD_REQUIRED: "The Wiki index requires explicit maintenance.",
    INDEX_REFRESH_REQUIRED: "Canonical Knowledge changed but its disposable index was not refreshed.",
    WIKI_PARSE_ERROR: "A canonical Knowledge file could not be read safely.",
    PATH_OUTSIDE_SCAFFOLD: "A Wiki path was rejected at the repository boundary.",
  };
  return messages[code] ?? "The Wiki reported a bounded local health diagnostic.";
}

async function projectGraphHealth(
  graph: HubGraphReadService,
  jobs: HubJobReader,
): Promise<HealthResponse["components"][number]> {
  try {
    const status = await graph.inspectStatus();
    const active = jobs.list({ limit: 100 }).items.find((job) => (
      (job.kind === "graph_refresh" || job.kind === "graph_rebuild")
      && (job.state === "queued" || job.state === "running")
    ));
    return projectGraphHealthStatus(status, active?.id ?? null);
  } catch {
    return {
      id: "graph",
      label: "Code graph",
      status: "unavailable",
      summary: "Graph status could not be observed against a stable local snapshot.",
      diagnostics: [],
    };
  }
}

function projectGraphHealthStatus(
  status: GraphStatus,
  activeJobId: string | null,
): HealthResponse["components"][number] {
  const allowedJobKinds = allowedGraphOperations(status);
  const recommendedJobKind = recommendedGraphOperation(status, allowedJobKinds);
  const failedPaths = status.parseHealth.failedPaths
      .filter(isCanonicalRepoPath)
      .slice(0, 25);
  const added = status.changes.added.filter(isCanonicalRepoPath).slice(0, 25);
  const modified = status.changes.modified.filter(isCanonicalRepoPath).slice(0, 25);
  const deleted = status.changes.deleted.filter(isCanonicalRepoPath).slice(0, 25);
  const graphDetails: GraphHealthDetails = {
      indexStatus: status.status,
      observedAt: status.observedAt,
      lastSuccessfulIndexAt: status.lastSuccessfulIndexAt,
      indexedAt: status.indexedAt,
      indexedBranch: status.indexedBranch,
      indexedHead: status.indexedHead,
      currentBranch: status.currentRepo.branch,
      currentHead: status.currentRepo.head,
      schemaVersion: status.schemaVersion,
      extractorVersion: status.extractorVersion,
      grammarVersion: status.grammarVersion,
      parseHealth: {
        total: status.parseHealth.total,
        ok: status.parseHealth.ok,
        partial: status.parseHealth.partial,
        failed: status.parseHealth.failed,
        failedPaths,
        failedPathsTruncated: status.parseHealth.failedPathsTruncated
          || failedPaths.length !== status.parseHealth.failedPaths.length,
      },
      changes: {
        total: status.changes.total,
        added,
        modified,
        deleted,
        truncated: status.changes.truncated
          || added.length !== status.changes.added.length
          || modified.length !== status.changes.modified.length
          || deleted.length !== status.changes.deleted.length,
        branchChanged: status.changes.branchChanged,
        manifestChanged: status.changes.manifestChanged,
        configChanged: status.changes.configChanged,
        grammarChanged: status.changes.grammarChanged,
      },
      allowedJobKinds,
      recommendedJobKind,
    activeJobId,
  };
  return {
    id: "graph",
    label: "Code graph",
    status: status.status === "fresh" && status.parseHealth.failed === 0
      ? "healthy"
      : "degraded",
    summary: graphHealthSummary(status),
    diagnostics: status.diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount).map(projectGraphDiagnostic),
    ...(recommendedJobKind === null ? {} : { repairJobKind: recommendedJobKind }),
    graph: graphDetails,
  };
}

function allowedGraphOperations(status: GraphStatus): Array<"graph_refresh" | "graph_rebuild"> {
  if (status.status === "fresh") return ["graph_refresh", "graph_rebuild"];
  const commands = new Set(status.diagnostics.flatMap((diagnostic) => (
    diagnostic.remediation?.map((action) => action.command).filter(Boolean) ?? []
  )));
  const operations: Array<"graph_refresh" | "graph_rebuild"> = [];
  if (commands.has("mex graph refresh")) operations.push("graph_refresh");
  if (commands.has("mex graph rebuild") || commands.has("mex graph")) {
    operations.push("graph_rebuild");
  }
  return operations;
}

function recommendedGraphOperation(
  status: GraphStatus,
  allowed: readonly ("graph_refresh" | "graph_rebuild")[],
): "graph_refresh" | "graph_rebuild" | null {
  if (status.status === "fresh") return null;
  if (allowed.includes("graph_refresh")) return "graph_refresh";
  if (allowed.includes("graph_rebuild")) return "graph_rebuild";
  return null;
}

function graphHealthSummary(status: GraphStatus): string {
  switch (status.status) {
    case "fresh":
      return status.parseHealth.failed === 0
        ? "The code graph matches the current repository snapshot."
        : "The graph is current, but some source files could not be parsed completely.";
    case "missing": return "No code graph has been built for this repository.";
    case "stale": return `${status.changes.total} repository change${status.changes.total === 1 ? "" : "s"} require an explicit graph refresh.`;
    case "degraded": return "Graph health could not be established completely; retry after resolving the reported condition.";
    case "rebuild_required": return "The code graph requires an explicit compatible rebuild.";
    case "corrupt": return "The code graph failed integrity checks and cannot be read safely.";
  }
}

function projectGraphDiagnostic(diagnostic: Diagnostic): HealthResponse["components"][number]["diagnostics"][number] {
  return {
    code: /^[A-Z0-9_]{1,128}$/.test(diagnostic.code) ? diagnostic.code : "GRAPH_DIAGNOSTIC",
    severity: diagnostic.severity,
    message: graphDiagnosticMessage(diagnostic.code),
    ...(diagnostic.path !== undefined && isCanonicalRepoPath(diagnostic.path)
      ? { path: diagnostic.path }
      : {}),
  };
}

function graphDiagnosticMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    GRAPH_INDEX_MISSING: "The graph index is missing.",
    GRAPH_INDEX_BRANCH_CHANGED: "The indexed branch differs from the current branch.",
    GRAPH_INDEX_HEAD_CHANGED: "The repository HEAD changed since the last successful index.",
    GRAPH_BUILD_MANIFEST_CHANGED: "Graph extraction inputs changed since the last index.",
    GRAPH_SEMANTIC_INPUTS_CHANGED: "Graph semantic inputs changed since the last index.",
    GRAPH_SOURCE_CORPUS_MISMATCH: "The source corpus differs from the indexed snapshot.",
    GRAPH_PARSE_DEGRADED: "One or more source files could not be parsed completely.",
    GRAPH_INDEX_REBUILD_REQUIRED: "The graph requires an explicit rebuild.",
    GRAPH_INDEX_CORRUPT: "The graph failed an integrity check.",
    GRAPH_INDEX_SIDECAR_ACTIVE: "Graph maintenance is currently publishing local changes.",
    GRAPH_STATUS_OBSERVATION_RACE: "Repository state changed during graph inspection.",
  };
  return messages[code] ?? "The graph reported a bounded local health diagnostic.";
}

function failedSearch(problem: unknown): SearchResponse["groups"]["symbols"] {
  const rawCode = readProblemCode(problem);
  const code = isSearchFailureCode(rawCode) ? rawCode : "INTERNAL_ERROR";
  return {
    status: "failed",
    items: [],
    nextCursor: null,
    truncated: false,
    revision: null,
    code,
    detail: searchFailureDetail(code),
  };
}

function readProblemCode(problem: unknown): string {
  if (typeof problem !== "object" || problem === null) return "INTERNAL_ERROR";
  if ("code" in problem && typeof problem.code === "string") return problem.code;
  if ("problem" in problem) return readProblemCode(problem.problem);
  return "INTERNAL_ERROR";
}

function isSearchFailureCode(code: string): code is SearchResponse["groups"]["symbols"]["code"] & string {
  return [
    "NOT_FOUND",
    "INVALID_REQUEST",
    "VALIDATION_FAILED",
    "REVISION_CONFLICT",
    "INDEX_MISSING",
    "INDEX_STALE",
    "INDEX_CORRUPT",
    "MIGRATION_REQUIRED",
    "PATH_OUTSIDE_PROJECT",
    "OPERATION_INTERRUPTED",
  ].includes(code);
}

function searchFailureDetail(code: string): string {
  switch (code) {
    case "REVISION_CONFLICT": return "The local index changed since this result page was loaded. Reload the newest results.";
    case "INVALID_REQUEST": return "This search page cursor is invalid for the current request.";
    case "VALIDATION_FAILED": return "This search page cursor is invalid for the current request.";
    case "INDEX_MISSING": return "The required local index has not been built.";
    case "INDEX_STALE": return "The required local index is stale and needs explicit maintenance.";
    case "INDEX_CORRUPT": return "The required local index could not be read safely.";
    case "MIGRATION_REQUIRED": return "The local Knowledge corpus requires an explicit migration.";
    case "PATH_OUTSIDE_PROJECT": return "The local search refused an unsafe project path.";
    case "OPERATION_INTERRUPTED": return "The local index changed while search results were being assembled.";
    default: return "The local search group could not be read safely.";
  }
}

function graphSymbolRoute(symbolId: string): string {
  return `/code/symbols/${encodeURIComponent(symbolId)}`;
}

function wikiEntityRoute(entityId: string): string {
  return `/knowledge/${encodeURIComponent(entityId)}`;
}

function requireWiki(wiki: HubWikiReadService | undefined): HubWikiReadService {
  if (wiki !== undefined) return wiki;
  throw new HubHttpError(
    503,
    "CAPABILITY_UNAVAILABLE",
    "Capability unavailable",
    "Wiki reads are not connected in this build.",
  );
}

function requireWorkstreamService(
  workstreams: HubTeamWorkstreamService | undefined,
): HubTeamWorkstreamService {
  if (workstreams !== undefined) return workstreams;
  throw unavailableWorkstreams();
}

function invalidWikiProjection(): HubHttpError {
  return new HubHttpError(
    500,
    "INTERNAL_ERROR",
    "Invalid Wiki projection",
    "The Wiki adapter returned an invalid bounded Knowledge result.",
  );
}

function boundedWikiText(value: string, maximumBytes: number, fallback: string): string {
  const safe = safeDisplayText(value);
  const bounded = truncateUtf8(safe, maximumBytes);
  return bounded.length === 0 ? fallback : bounded;
}

function safeWikiTaxonomy(value: string, fallback: string): string {
  const bounded = boundedWikiText(value, 128, fallback);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(bounded) ? bounded : fallback;
}

function isTeamReadableEntityKind(value: string): boolean {
  return (TEAM_READABLE_ENTITY_TYPES as readonly string[]).includes(value);
}

function safeEvidenceValue(value: string | undefined, maximumBytes: number): string | null {
  if (value === undefined || value.length === 0) return null;
  const normalized = safeDisplayText(value);
  if (normalized.length === 0 || containsLocalAbsolutePath(normalized)) return null;
  if (/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/u.test(normalized)) return null;
  try {
    const url = new URL(normalized);
    if ((url.protocol === "http:" || url.protocol === "https:")
      && (url.username !== "" || url.password !== "")) return null;
  } catch {
    // Ordinary non-URL evidence is allowed after local-path screening.
  }
  return truncateUtf8(normalized, maximumBytes);
}

function containsLocalAbsolutePath(value: string): boolean {
  if (/\bfile:(?:\/|\\)+/iu.test(value)) return true;
  if (/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/u.test(value)) return true;
  if (/(?:^|[^\\])\\\\(?:[^\\]|$)/u.test(value)) return true;

  // Ignore ordinary absolute URL paths, then reject a POSIX absolute path at
  // the start or after any delimiter. This catches punctuation-delimited
  // evidence such as `trace(/Users/...)` and `cwd=/var/...` without treating
  // `https://example.test/path` as a local filesystem disclosure.
  const withoutUrls = value.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>{}\[\]"']+/gu, "");
  return /(?:^|[^A-Za-z0-9_/])\/(?!\/)/u.test(withoutUrls);
}

function isIsoTimestamp(value: string | undefined): value is string {
  return value !== undefined
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function safeDisplayText(value: string): string {
  return value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

function invalidGraphProjection(): HubHttpError {
  return new HubHttpError(
    500,
    "INTERNAL_ERROR",
    "Invalid graph projection",
    "The graph adapter returned an invalid bounded workspace result.",
  );
}

function invalidRelayProjection(): HubHttpError {
  return new HubHttpError(
    500,
    "INTERNAL_ERROR",
    "Invalid Relay projection",
    "The Relay adapter returned an invalid bounded handoff result.",
  );
}

function projectRelayActor(actor: ActorRef): RelaySummary["sender"] {
  return cloneActor(actor);
}

function projectRelayMemberActor(
  actor: ActorRef,
): RelayDraftInput["recipients"][number] {
  if (actor.kind !== "member") throw invalidRelayProjection();
  return {
    kind: "member",
    memberId: actor.memberId,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
  };
}

function projectRelayEntity(entity: EntityRef): { id: string; kind: string; title?: string } {
  return {
    id: entity.id,
    kind: entity.kind,
    ...(entity.title === undefined ? {} : { title: entity.title }),
  };
}

function projectRelayWorkstream(entity: EntityRef): NonNullable<RelaySummary["workstream"]> {
  if (entity.kind !== "workstream") throw invalidRelayProjection();
  return { ...projectRelayEntity(entity), kind: "workstream" };
}

function projectRelayCode(
  code: TeamRelayDetail["code"][number],
): RelayDraftInput["code"][number] {
  return code.kind === "file"
    ? {
        kind: "file",
        path: code.path,
        ...(code.fingerprint === undefined ? {} : { fingerprint: code.fingerprint }),
      }
    : {
        kind: "symbol",
        symbolId: code.symbolId,
        ...(code.fingerprint === undefined ? {} : { fingerprint: code.fingerprint }),
      };
}

function projectRelayEvidence(evidence: TeamEvidenceRef): RelayEvidenceRef {
  switch (evidence.kind) {
    case "entity": return { kind: "entity", entity: projectRelayEntity(evidence.entity) };
    case "code": return { kind: "code", code: projectRelayCode(evidence.code) };
    case "commit": return { kind: "commit", hash: evidence.hash };
    case "file": return { kind: "file", path: evidence.path };
    case "external": return {
      kind: "external",
      uri: evidence.uri,
      ...(evidence.label === undefined ? {} : { label: evidence.label }),
    };
    case "manual": return { kind: "manual", note: evidence.note };
  }
}

function projectRelayDraftInput(input: TeamRelayDraftDetail["input"]): RelayDraftInput {
  return {
    ...(input.audience === undefined ? {} : { audience: input.audience }),
    recipients: input.recipients.map(projectRelayMemberActor),
    summary: input.summary,
    completed: [...input.completed],
    inProgress: [...input.inProgress],
    decisions: input.decisions.map(projectRelayEntity),
    blockers: [...input.blockers],
    unresolvedQuestions: [...input.unresolvedQuestions],
    changedFiles: [...input.changedFiles],
    code: input.code.map(projectRelayCode),
    evidence: input.evidence.map(projectRelayEvidence),
    nextActions: [...input.nextActions],
  };
}

function projectRelayDraftSummary(draft: TeamRelayDraftSummary): RelayDraftSummary {
  return {
    ...(draft.audience === undefined ? {} : { audience: draft.audience }),
    id: draft.id,
    revision: draft.revision,
    updatedAt: draft.updatedAt,
    summary: draft.summary,
    recipients: draft.recipients.map(projectRelayMemberActor),
  };
}

function projectRelayDraftDetail(draft: TeamRelayDraftDetail): RelayDraftDetail {
  return { ...projectRelayDraftSummary(draft), input: projectRelayDraftInput(draft.input) };
}

function projectRelaySummary(relay: TeamRelaySummary): RelaySummary {
  if (relay.ref.kind !== "relay") throw invalidRelayProjection();
  return {
    ...(relay.audience === undefined ? {} : { audience: relay.audience }),
    schemaVersion: relay.schemaVersion,
    ref: { ...projectRelayEntity(relay.ref), kind: "relay" },
    sourcePath: relay.sourcePath,
    revision: relay.revision,
    state: relay.state,
    sender: projectRelayActor(relay.sender),
    recipients: relay.recipients.map(projectRelayActor),
    workstream: relay.workstream === null
      ? null
      : projectRelayWorkstream(relay.workstream),
    summary: relay.summary,
    publishedAt: relay.publishedAt,
    publishedRepoState: relay.publishedRepoState === null
      ? null
      : { ...relay.publishedRepoState },
    acknowledgedBy: relay.acknowledgedBy === undefined ? null : projectRelayActor(relay.acknowledgedBy),
    acknowledgedAt: relay.acknowledgedAt ?? null,
    closedBy: relay.closedBy === undefined ? null : projectRelayActor(relay.closedBy),
    closedAt: relay.closedAt ?? null,
  };
}

function projectRelayDetail(relay: TeamRelayDetail): RelayDetail {
  const diagnostics = relay.diagnostics.map(projectDiagnostic);
  return {
    ...projectRelaySummary(relay),
    completed: [...relay.completed],
    inProgress: [...relay.inProgress],
    decisions: relay.decisions.map(projectRelayEntity),
    blockers: [...relay.blockers],
    unresolvedQuestions: [...relay.unresolvedQuestions],
    changedFiles: [...relay.changedFiles],
    code: relay.code.map(projectRelayCode),
    evidence: relay.evidence.map(projectRelayEvidence),
    nextActions: [...relay.nextActions],
    diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
    diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
  };
}

function projectRelayDraftInputToService(input: RelayDraftInput): TeamRelayDraftDetail["input"] {
  return {
    ...(input.audience === undefined ? {} : { audience: input.audience }),
    recipients: input.recipients.map((actor) => ({ ...actor })),
    summary: input.summary,
    completed: [...input.completed],
    inProgress: [...input.inProgress],
    decisions: input.decisions.map((entity) => ({ ...entity })),
    blockers: [...input.blockers],
    unresolvedQuestions: [...input.unresolvedQuestions],
    changedFiles: [...input.changedFiles],
    code: input.code.map((code) => ({ ...code })),
    evidence: input.evidence.map((evidence) => {
      if (evidence.kind === "entity") return { kind: "entity" as const, entity: { ...evidence.entity } };
      if (evidence.kind === "code") return { kind: "code" as const, code: { ...evidence.code } };
      return { ...evidence };
    }),
    nextActions: [...input.nextActions],
  };
}

function projectRelayCommandToService(request: RelayOperationPreviewRequest): TeamRelayCommand {
  const action = request.action;
  return {
    operationId: request.operationId,
    action: action.kind === "relay.draft.save"
      ? {
          kind: "relay.draft.save",
          ...(action.draftId === undefined ? {} : { draftId: action.draftId }),
          draft: projectRelayDraftInputToService(action.draft),
        }
      : { ...action },
    expectedRevisions: request.expectedRevisions.map((expectation) => expectation.target.kind === "local"
      ? {
          target: { kind: "local", namespace: "relay-draft", id: expectation.target.id },
          revision: expectation.revision,
        }
      : { target: { kind: "artifact", path: expectation.target.path }, revision: expectation.revision }),
  };
}

function projectRelayCommandToWire(command: TeamRelayCommand): RelayOperationPreviewRequest {
  const action = command.action;
  return {
    operationId: command.operationId,
    action: action.kind === "relay.draft.save"
      ? {
          kind: "relay.draft.save",
          ...(action.draftId === undefined ? {} : { draftId: action.draftId }),
          draft: projectRelayDraftInput(action.draft),
        }
      : { ...action },
    expectedRevisions: command.expectedRevisions.map((expectation) => {
      if (expectation.target.kind === "local") {
        if (expectation.target.namespace !== "relay-draft" || expectation.revision === null) {
          throw invalidRelayProjection();
        }
        return {
          target: { kind: "local" as const, namespace: "relay-draft" as const, id: expectation.target.id },
          revision: expectation.revision,
        };
      }
      if (expectation.target.kind !== "artifact" || expectation.revision === null) {
        throw invalidRelayProjection();
      }
      return {
        target: { kind: "artifact" as const, path: expectation.target.path },
        revision: expectation.revision,
      };
    }),
  };
}

function projectRelayLocalChange(
  change: TeamRelayApplyResult["localChanges"][number],
): RelayLocalChange {
  if (change.namespace !== "relay-draft") throw invalidRelayProjection();
  return { ...change, namespace: "relay-draft" };
}

function projectRelayPreviewDiagnostic(
  diagnostic: Diagnostic,
): RelayOperationPreviewResponse["preview"]["diagnostics"][number] {
  const allowedKeys = new Set(["code", "severity", "message", "path"]);
  if (Object.keys(diagnostic).some((key) => !allowedKeys.has(key))) throw invalidRelayProjection();
  if (
    !/^[A-Z0-9_]{1,128}$/.test(diagnostic.code)
    || diagnostic.message !== relayDiagnosticMessage(diagnostic.code)
    || (diagnostic.path !== undefined && (
      !isCanonicalRepoPath(diagnostic.path)
      || Buffer.byteLength(diagnostic.path, "utf8") > 4_096
    ))
  ) throw invalidRelayProjection();
  return { ...diagnostic };
}

function relayDiagnosticMessage(code: string): string {
  switch (code) {
    case "ENVELOPE_TOO_LARGE": return "The Relay operation exceeded its bounded preview envelope.";
    case "PATH_OUTSIDE_PROJECT": return "A Relay preview path was rejected at the repository boundary.";
    case "RELAY_DIRTY_PUBLICATION_STATE": return "MEX recorded that local changes existed when this Relay was published; it did not record their paths, diff, or contents.";
    case "REVISION_CONFLICT": return "The Relay operation no longer matches the observed repository revision.";
    case "VALIDATION_FAILED": return "The Relay operation failed bounded validation.";
    default: return "The Relay operation reported a bounded diagnostic.";
  }
}

function projectRelayPreviewEnvelope(
  envelope: TeamRelayPreviewEnvelope,
): RelayOperationPreviewResponse {
  return {
    schemaVersion: 1,
    request: projectRelayCommandToWire(envelope.request),
    preview: {
      valid: envelope.preview.valid,
      scope: envelope.preview.scope,
      changes: envelope.preview.changes.map(projectInboxFileChange),
      localChanges: envelope.preview.localChanges.map(projectRelayLocalChange),
      diagnostics: envelope.preview.diagnostics.map(projectRelayPreviewDiagnostic),
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: cloneActor(envelope.receipt.authority.actor),
        occurredAt: envelope.receipt.authority.occurredAt,
        repoState: { ...envelope.receipt.authority.repoState },
      },
      purposeIds: envelope.receipt.purposeIds.map((purposeId) => ({ ...purposeId })),
      requestRevision: envelope.receipt.requestRevision,
      presentationRevision: envelope.receipt.presentationRevision,
      previewRevision: envelope.receipt.previewRevision,
    },
  };
}

function projectRelayEnvelopeToService(
  envelope: RelayOperationApplyRequest,
): TeamRelayPreviewEnvelope {
  return {
    schemaVersion: 1,
    request: projectRelayCommandToService(envelope.request),
    preview: {
      valid: envelope.preview.valid,
      scope: envelope.preview.scope,
      changes: envelope.preview.changes.map(projectInboxFileChangeToService),
      localChanges: envelope.preview.localChanges.map((change) => ({ ...change })),
      diagnostics: envelope.preview.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: cloneActor(envelope.receipt.authority.actor),
        occurredAt: envelope.receipt.authority.occurredAt,
        repoState: { ...envelope.receipt.authority.repoState },
      },
      purposeIds: envelope.receipt.purposeIds.map((purposeId) => ({ ...purposeId })),
      requestRevision: envelope.receipt.requestRevision,
      presentationRevision: envelope.receipt.presentationRevision,
      previewRevision: envelope.receipt.previewRevision,
    },
  };
}

function invalidInboxProjection(): HubHttpError {
  return new HubHttpError(
    500,
    "INTERNAL_ERROR",
    "Invalid Inbox projection",
    "The Inbox adapter returned an invalid bounded Spec-authoring result.",
  );
}

function projectInboxDraftSummary(
  draft: TeamInboxSpecDraftSummary,
): InboxDraftSummary {
  return {
    id: draft.id,
    revision: draft.revision,
    updatedAt: draft.updatedAt,
    changeKind: draft.changeKind,
    entityKind: draft.entityKind,
    title: draft.title,
    rationaleExcerpt: draft.rationaleExcerpt,
  };
}

function projectInboxDraftDetail(
  draft: TeamInboxSpecDraftDetail,
): InboxDraftDetail {
  return {
    ...projectInboxDraftSummary(draft),
    input: projectInboxDraftInput(draft.input),
  };
}

function projectInboxDraftInput(
  input: TeamInboxSpecDraftInput,
): InboxDraftInput {
  return {
    change: projectInboxSpecChange(input.change),
    rationale: input.rationale,
    evidence: input.evidence.map(projectInboxEvidence),
    targetRevisions: input.targetRevisions.map(projectInboxEntityExpectation),
  };
}

function projectInboxProposalSummary(
  proposal: TeamInboxSpecProposalSummary,
): InboxProposalSummary {
  if (proposal.ref.kind !== "proposal") throw invalidInboxProjection();
  return {
    schemaVersion: 1,
    ref: {
      id: proposal.ref.id,
      kind: "proposal",
      ...(proposal.ref.title === undefined ? {} : { title: proposal.ref.title }),
    },
    sourcePath: proposal.sourcePath,
    revision: proposal.revision,
    state: proposal.state,
    author: projectInboxActor(proposal.author),
    changeKind: proposal.changeKind,
    entityKind: proposal.entityKind,
    title: proposal.title,
    rationaleExcerpt: proposal.rationaleExcerpt,
    ...(proposal.reviewer === undefined
      ? {}
      : { reviewer: projectInboxActor(proposal.reviewer) }),
    ...(proposal.reviewedAt === undefined ? {} : { reviewedAt: proposal.reviewedAt }),
  };
}

function projectInboxProposalDetail(
  proposal: TeamInboxSpecProposalDetail,
): InboxProposalDetail {
  return {
    ...projectInboxProposalSummary(proposal),
    change: projectInboxSpecChange(proposal.change),
    rationale: proposal.rationale,
    evidence: proposal.evidence.map(projectInboxEvidence),
    targetRevisions: proposal.targetRevisions.map(projectInboxEntityExpectation),
    ...(proposal.reviewRationale === undefined
      ? {}
      : { reviewRationale: proposal.reviewRationale }),
  };
}

function projectInboxSpecChange(
  change: TeamInboxSpecDraftInput["change"],
): InboxSpecChange {
  if (change.kind === "knowledge.update") {
    return {
      kind: change.kind,
      target: {
        id: change.target.id,
        kind: change.target.kind,
        ...(change.target.title === undefined ? {} : { title: change.target.title }),
      },
      patch: {
        ...(change.patch.title === undefined ? {} : { title: change.patch.title }),
        ...(change.patch.summary === undefined ? {} : { summary: change.patch.summary }),
        ...(change.patch.body === undefined ? {} : { body: change.patch.body }),
      },
    };
  }
  if (change.kind === "knowledge.create") {
    return {
      kind: change.kind,
      entityKind: change.entityKind,
      title: change.title,
      body: change.body,
      ...(change.summary === undefined ? {} : { summary: change.summary }),
      status: change.status,
      ...(change.topics === undefined ? {} : { topics: [...change.topics] }),
    };
  }
  if (change.kind === "spec.update") {
    return {
      kind: "spec.update",
      target: projectInboxSpecRef(change.target),
      patch: {
        ...(change.patch.title === undefined ? {} : { title: change.patch.title }),
        ...(change.patch.summary === undefined ? {} : { summary: change.patch.summary }),
        ...(change.patch.body === undefined ? {} : { body: change.patch.body }),
      },
    };
  }
  return {
    kind: "spec.create",
    entityKind: change.entityKind,
    title: change.title,
    body: change.body,
    ...(change.summary === undefined ? {} : { summary: change.summary }),
    status: change.status,
    ...(change.topics === undefined ? {} : { topics: [...change.topics] }),
    ...(change.relation === undefined
      ? {}
      : { relation: projectInboxRelation(change.relation) }),
  };
}

function projectInboxSpecRef(
  ref: TeamInboxSpecRef,
): Extract<InboxSpecChange, { kind: "spec.update" }>["target"] {
  return {
    id: ref.id,
    kind: ref.kind,
    ...(ref.title === undefined ? {} : { title: ref.title }),
  };
}

function projectInboxRelation(
  relation: NonNullable<Extract<TeamInboxSpecDraftInput["change"], { kind: "spec.create" }>["relation"]>,
): NonNullable<Extract<InboxSpecChange, { kind: "spec.create" }>["relation"]> {
  const title = relation.target.title === undefined
    ? {}
    : { title: relation.target.title };
  switch (relation.type) {
    case "derived_from":
      if (relation.target.kind !== "spec") throw invalidInboxProjection();
      return {
        type: "derived_from",
        target: { id: relation.target.id, kind: "spec", ...title },
      };
    case "verified_by":
      if (relation.target.kind !== "spec" && relation.target.kind !== "requirement") {
        throw invalidInboxProjection();
      }
      return {
        type: "verified_by",
        target: { id: relation.target.id, kind: relation.target.kind, ...title },
      };
    case "constrained_by":
      if (relation.target.kind !== "constraint") throw invalidInboxProjection();
      return {
        type: "constrained_by",
        target: { id: relation.target.id, kind: "constraint", ...title },
      };
    case "refines":
      if (relation.target.kind !== "requirement") throw invalidInboxProjection();
      return {
        type: "refines",
        target: { id: relation.target.id, kind: "requirement", ...title },
      };
  }
}

function projectInboxEvidence(evidence: TeamEvidenceRef): InboxEvidenceRef {
  switch (evidence.kind) {
    case "entity":
      return {
        kind: "entity",
        entity: {
          id: evidence.entity.id,
          kind: evidence.entity.kind,
          ...(evidence.entity.title === undefined ? {} : { title: evidence.entity.title }),
        },
      };
    case "code":
      return evidence.code.kind === "file"
        ? {
            kind: "code",
            code: {
              kind: "file",
              path: evidence.code.path,
              ...(evidence.code.fingerprint === undefined
                ? {}
                : { fingerprint: evidence.code.fingerprint }),
            },
          }
        : {
            kind: "code",
            code: {
              kind: "symbol",
              symbolId: evidence.code.symbolId,
              ...(evidence.code.fingerprint === undefined
                ? {}
                : { fingerprint: evidence.code.fingerprint }),
            },
          };
    case "commit":
      return { kind: "commit", hash: evidence.hash };
    case "file":
      return { kind: "file", path: evidence.path };
    case "external":
      return {
        kind: "external",
        uri: evidence.uri,
        ...(evidence.label === undefined ? {} : { label: evidence.label }),
      };
    case "manual":
      return { kind: "manual", note: evidence.note };
  }
}

function projectInboxEntityExpectation(
  expectation: RevisionExpectation,
): InboxDraftInput["targetRevisions"][number] {
  if (
    expectation.target.kind !== "entity"
    || expectation.revision === null
    || expectation.semanticRevision === undefined
    || expectation.semanticRevision === null
  ) {
    throw invalidInboxProjection();
  }
  return {
    target: { kind: "entity", id: expectation.target.id },
    revision: expectation.revision,
    semanticRevision: expectation.semanticRevision,
  };
}

function projectInboxActor(actor: ActorRef): InboxProposalSummary["author"] {
  if (actor.kind === "unknown") return { kind: "unknown" };
  if (actor.kind === "git") {
    return { kind: "git", name: actor.name, email: actor.email };
  }
  return {
    kind: "member",
    memberId: actor.memberId,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
  };
}

function projectInboxCommandToWire(
  command: TeamInboxSpecCommand,
): InboxOperationPreviewRequest {
  const expectedRevisions = command.expectedRevisions.map(projectInboxCommandExpectation);
  switch (command.action.kind) {
    case "inbox.draft.save":
      return {
        operationId: command.operationId,
        action: {
          kind: "inbox.draft.save",
          ...(command.action.draftId === undefined ? {} : { draftId: command.action.draftId }),
          draft: projectInboxDraftInput(command.action.draft),
        },
        expectedRevisions,
      };
    case "inbox.draft.delete":
    case "inbox.publish":
      return {
        operationId: command.operationId,
        action: { kind: command.action.kind, draftId: command.action.draftId },
        expectedRevisions,
      };
    case "inbox.approve":
      return {
        operationId: command.operationId,
        action: { kind: "inbox.approve", proposalId: command.action.proposalId },
        expectedRevisions,
      };
    case "inbox.reject":
    case "inbox.mark-stale":
      return {
        operationId: command.operationId,
        action: {
          kind: command.action.kind,
          proposalId: command.action.proposalId,
          rationale: command.action.rationale,
        },
        expectedRevisions,
      };
    case "inbox.withdraw":
      return {
        operationId: command.operationId,
        action: {
          kind: "inbox.withdraw",
          proposalId: command.action.proposalId,
          ...(command.action.rationale === undefined
            ? {}
            : { rationale: command.action.rationale }),
        },
        expectedRevisions,
      };
    case "inbox.repair":
      return {
        operationId: command.operationId,
        action: {
          kind: "inbox.repair",
          proposalId: command.action.proposalId,
          replacement: projectInboxDraftInput(command.action.replacement),
        },
        expectedRevisions,
      };
  }
}

function projectInboxCommandExpectation(
  expectation: RevisionExpectation,
): InboxOperationPreviewRequest["expectedRevisions"][number] {
  if (expectation.semanticRevision !== undefined || expectation.revision === null) {
    throw invalidInboxProjection();
  }
  if (expectation.target.kind === "artifact") {
    return {
      target: { kind: "artifact", path: expectation.target.path },
      revision: expectation.revision,
    };
  }
  if (
    expectation.target.kind === "local"
    && expectation.target.namespace === "inbox-draft"
  ) {
    return {
      target: {
        kind: "local",
        namespace: "inbox-draft",
        id: expectation.target.id,
      },
      revision: expectation.revision,
    };
  }
  throw invalidInboxProjection();
}

function projectInboxCommandToService(
  request: InboxOperationPreviewRequest,
): TeamInboxSpecCommand {
  return normalizeTeamInboxSpecCommand({
    operationId: request.operationId,
    action: projectInboxActionToService(request.action),
    expectedRevisions: request.expectedRevisions.map((expectation) => (
      expectation.target.kind === "artifact"
        ? {
            target: { kind: "artifact", path: expectation.target.path },
            revision: expectation.revision,
          }
        : {
            target: {
              kind: "local",
              namespace: "inbox-draft",
              id: expectation.target.id,
            },
            revision: expectation.revision,
          }
    )),
  });
}

function projectInboxActionToService(
  action: InboxOperationPreviewRequest["action"],
): Readonly<Record<string, unknown>> {
  switch (action.kind) {
    case "inbox.draft.save":
      return {
        kind: "inbox.draft.save",
        ...(action.draftId === undefined ? {} : { draftId: action.draftId }),
        draft: projectInboxDraftInputToService(action.draft),
      };
    case "inbox.draft.delete":
    case "inbox.publish":
      return { kind: action.kind, draftId: action.draftId };
    case "inbox.approve":
      return { kind: "inbox.approve", proposalId: action.proposalId };
    case "inbox.reject":
    case "inbox.mark-stale":
      return {
        kind: action.kind,
        proposalId: action.proposalId,
        rationale: action.rationale,
      };
    case "inbox.withdraw":
      return {
        kind: "inbox.withdraw",
        proposalId: action.proposalId,
        ...(action.rationale === undefined ? {} : { rationale: action.rationale }),
      };
    case "inbox.repair":
      return {
        kind: "inbox.repair",
        proposalId: action.proposalId,
        replacement: projectInboxDraftInputToService(action.replacement),
      };
  }
}

function projectInboxDraftInputToService(
  input: InboxDraftInput,
): Readonly<Record<string, unknown>> {
  return {
    change: projectInboxSpecChangeToService(input.change),
    rationale: input.rationale,
    evidence: input.evidence.map(projectInboxEvidenceToService),
    targetRevisions: input.targetRevisions.map((expectation) => ({
      target: { kind: "entity", id: expectation.target.id },
      revision: expectation.revision,
      semanticRevision: expectation.semanticRevision,
    })),
  };
}

function projectInboxSpecChangeToService(
  change: InboxSpecChange,
): Readonly<Record<string, unknown>> {
  if (change.kind === "spec.update" || change.kind === "knowledge.update") {
    return {
      kind: change.kind,
      target: {
        id: change.target.id,
        kind: change.target.kind,
        ...(change.target.title === undefined ? {} : { title: change.target.title }),
      },
      patch: {
        ...(change.patch.title === undefined ? {} : { title: change.patch.title }),
        ...(change.patch.summary === undefined ? {} : { summary: change.patch.summary }),
        ...(change.patch.body === undefined ? {} : { body: change.patch.body }),
      },
    };
  }
  return {
    kind: change.kind,
    entityKind: change.entityKind,
    title: change.title,
    body: change.body,
    ...(change.summary === undefined ? {} : { summary: change.summary }),
    status: change.status,
    ...(change.topics === undefined ? {} : { topics: [...change.topics] }),
    ...(change.kind !== "spec.create" || change.relation === undefined
      ? {}
      : {
          relation: {
            type: change.relation.type,
            target: {
              id: change.relation.target.id,
              kind: change.relation.target.kind,
              ...(change.relation.target.title === undefined
                ? {}
                : { title: change.relation.target.title }),
            },
          },
        }),
  };
}

function projectInboxEvidenceToService(
  evidence: InboxEvidenceRef,
): Readonly<Record<string, unknown>> {
  switch (evidence.kind) {
    case "entity":
      return {
        kind: "entity",
        entity: {
          id: evidence.entity.id,
          kind: evidence.entity.kind,
          ...(evidence.entity.title === undefined ? {} : { title: evidence.entity.title }),
        },
      };
    case "code":
      return evidence.code.kind === "file"
        ? {
            kind: "code",
            code: {
              kind: "file",
              path: evidence.code.path,
              ...(evidence.code.fingerprint === undefined
                ? {}
                : { fingerprint: evidence.code.fingerprint }),
            },
          }
        : {
            kind: "code",
            code: {
              kind: "symbol",
              symbolId: evidence.code.symbolId,
              ...(evidence.code.fingerprint === undefined
                ? {}
                : { fingerprint: evidence.code.fingerprint }),
            },
          };
    case "commit":
      return { kind: "commit", hash: evidence.hash };
    case "file":
      return { kind: "file", path: evidence.path };
    case "external":
      return {
        kind: "external",
        uri: evidence.uri,
        ...(evidence.label === undefined ? {} : { label: evidence.label }),
      };
    case "manual":
      return { kind: "manual", note: evidence.note };
  }
}

function projectInboxFileChange(change: FileChange): TeamFileChange {
  switch (change.kind) {
    case "create":
      return {
        kind: "create",
        path: change.path,
        diff: change.diff,
        beforeRevision: null,
        afterRevision: change.afterRevision,
      };
    case "update":
      return {
        kind: "update",
        path: change.path,
        diff: change.diff,
        beforeRevision: change.beforeRevision,
        afterRevision: change.afterRevision,
      };
    case "delete":
      return {
        kind: "delete",
        path: change.path,
        diff: change.diff,
        beforeRevision: change.beforeRevision,
        afterRevision: null,
      };
    case "move":
      return {
        kind: "move",
        path: change.path,
        previousPath: change.previousPath,
        diff: change.diff,
        beforeRevision: change.beforeRevision,
        afterRevision: change.afterRevision,
      };
  }
}

function projectInboxFileChangeToService(change: TeamFileChange): FileChange {
  switch (change.kind) {
    case "create":
      return {
        kind: "create",
        path: change.path,
        diff: change.diff,
        beforeRevision: null,
        afterRevision: change.afterRevision,
      };
    case "update":
      return {
        kind: "update",
        path: change.path,
        diff: change.diff,
        beforeRevision: change.beforeRevision,
        afterRevision: change.afterRevision,
      };
    case "delete":
      return {
        kind: "delete",
        path: change.path,
        diff: change.diff,
        beforeRevision: change.beforeRevision,
        afterRevision: null,
      };
    case "move":
      return {
        kind: "move",
        path: change.path,
        previousPath: change.previousPath,
        diff: change.diff,
        beforeRevision: change.beforeRevision,
        afterRevision: change.afterRevision,
      };
  }
}

function projectInboxLocalChange(
  change: TeamInboxSpecApplyResult["localChanges"][number],
): InboxLocalChange {
  if (change.namespace !== "inbox-draft") throw invalidInboxProjection();
  return {
    namespace: "inbox-draft",
    id: change.id,
    beforeRevision: change.beforeRevision,
    afterRevision: change.afterRevision,
    summary: change.summary,
  };
}

function projectInboxLocalChangeToService(
  change: InboxLocalChange,
): TeamInboxSpecPreviewEnvelope["preview"]["localChanges"][number] {
  return {
    namespace: "inbox-draft",
    id: change.id,
    beforeRevision: change.beforeRevision,
    afterRevision: change.afterRevision,
    summary: change.summary,
  };
}

function projectInboxPreviewDiagnostic(
  diagnostic: Diagnostic,
): InboxOperationPreviewResponse["preview"]["diagnostics"][number] {
  const allowedKeys = new Set(["code", "severity", "message", "path"]);
  if (Object.keys(diagnostic).some((key) => !allowedKeys.has(key))) {
    throw invalidInboxProjection();
  }
  if (
    !/^[A-Z0-9_]{1,128}$/.test(diagnostic.code)
    || diagnostic.message !== inboxDiagnosticMessage(diagnostic.code)
    || (diagnostic.path !== undefined && (
      !isCanonicalRepoPath(diagnostic.path)
      || Buffer.byteLength(diagnostic.path, "utf8") > 4_096
    ))
  ) {
    throw invalidInboxProjection();
  }
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
  };
}

function inboxDiagnosticMessage(code: string): string {
  switch (code) {
    case "ENVELOPE_TOO_LARGE":
      return "The Inbox operation exceeded its bounded preview envelope.";
    case "PATH_OUTSIDE_PROJECT":
      return "An Inbox preview path was rejected at the repository boundary.";
    case "REVISION_CONFLICT":
      return "The Inbox operation no longer matches the observed repository revision.";
    case "VALIDATION_FAILED":
      return "The Inbox operation failed bounded validation.";
    default:
      return "The Inbox operation reported a bounded diagnostic.";
  }
}

function projectInboxPurposeId(
  purposeId: TeamInboxSpecPreviewEnvelope["receipt"]["purposeIds"][number],
): InboxOperationPreviewResponse["receipt"]["purposeIds"][number] {
  switch (purposeId.purpose) {
    case "inbox-draft":
      return { purpose: "inbox-draft", id: purposeId.id };
    case "proposal":
      return { purpose: "proposal", id: purposeId.id };
    case "activity":
      return { purpose: "activity", id: purposeId.id };
    case "spec-entity":
      return { purpose: "spec-entity", id: purposeId.id };
  }
}

function projectInboxPreviewEnvelope(
  envelope: TeamInboxSpecPreviewEnvelope,
): InboxOperationPreviewResponse {
  return {
    schemaVersion: 1,
    request: projectInboxCommandToWire(envelope.request),
    preview: {
      valid: envelope.preview.valid,
      scope: envelope.preview.scope,
      changes: envelope.preview.changes.map(projectInboxFileChange),
      localChanges: envelope.preview.localChanges.map(projectInboxLocalChange),
      diagnostics: envelope.preview.diagnostics.map(projectInboxPreviewDiagnostic),
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: projectInboxActor(envelope.receipt.authority.actor),
        occurredAt: envelope.receipt.authority.occurredAt,
        repoState: {
          branch: envelope.receipt.authority.repoState.branch,
          head: envelope.receipt.authority.repoState.head,
          dirty: envelope.receipt.authority.repoState.dirty,
          observedAt: envelope.receipt.authority.repoState.observedAt,
        },
      },
      purposeIds: envelope.receipt.purposeIds.map(projectInboxPurposeId),
      requestRevision: envelope.receipt.requestRevision,
      presentationRevision: envelope.receipt.presentationRevision,
      previewRevision: envelope.receipt.previewRevision,
    },
  };
}

function projectInboxEnvelopeToService(
  envelope: InboxOperationApplyRequest,
): TeamInboxSpecPreviewEnvelope {
  const command = projectInboxCommandToService(envelope.request);
  return {
    schemaVersion: 1,
    request: command,
    preview: {
      valid: envelope.preview.valid,
      scope: envelope.preview.scope,
      changes: envelope.preview.changes.map(projectInboxFileChangeToService),
      localChanges: envelope.preview.localChanges.map(projectInboxLocalChangeToService),
      diagnostics: envelope.preview.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      })),
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: projectInboxActorToService(envelope.receipt.authority.actor),
        occurredAt: envelope.receipt.authority.occurredAt,
        repoState: {
          branch: envelope.receipt.authority.repoState.branch,
          head: envelope.receipt.authority.repoState.head,
          dirty: envelope.receipt.authority.repoState.dirty,
          observedAt: envelope.receipt.authority.repoState.observedAt,
        },
      },
      purposeIds: envelope.receipt.purposeIds.map((purposeId) => ({
        purpose: purposeId.purpose,
        id: purposeId.id,
      })),
      requestRevision: envelope.receipt.requestRevision,
      presentationRevision: envelope.receipt.presentationRevision,
      previewRevision: envelope.receipt.previewRevision,
    },
  };
}

function projectInboxActorToService(
  actor: InboxProposalSummary["author"],
): ActorRef {
  if (actor.kind === "unknown") return { kind: "unknown" };
  if (actor.kind === "git") {
    return { kind: "git", name: actor.name, email: actor.email };
  }
  return {
    kind: "member",
    memberId: actor.memberId,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
  };
}

function projectTeamMember(member: TeamMember): HubTeamMember {
  return {
    schemaVersion: 1,
    id: member.ref.id,
    displayName: member.displayName,
    gitAliases: member.gitAliases.map((alias) => ({ ...alias })),
    active: member.active,
    sourcePath: member.sourcePath,
    revision: member.revision,
  };
}

function projectTeamWorkstream(workstream: Workstream): HubTeamWorkstream {
  return {
    schemaVersion: 1,
    id: workstream.ref.id,
    entityRevision: workstream.entityRevision,
    title: workstream.title,
    goal: workstream.goal,
    summary: workstream.summary,
    state: workstream.state,
    owners: workstream.owners.map(cloneActor),
    contributors: workstream.contributors.map(cloneActor),
    paths: [...workstream.paths],
    code: workstream.code.map((entry) => ({ ...entry })),
    topics: workstream.topics.map((entry) => ({ ...entry })),
    components: workstream.components.map((entry) => ({ ...entry })),
    related: workstream.related.map((entry) => ({ ...entry })),
    blockers: [...workstream.blockers],
    currentState: workstream.currentState,
    nextMilestone: workstream.nextMilestone,
    createdBy: cloneActor(workstream.createdBy),
    createdAt: workstream.createdAt,
    updatedBy: cloneActor(workstream.updatedBy),
    updatedAt: workstream.updatedAt,
    sourcePath: workstream.sourcePath,
    revision: workstream.revision,
  };
}

function projectTeamActivityEvent(event: ActivityEvent): TeamOperationApplyResponse["events"][number] {
  if (
    event.metadata !== undefined
    || (event.workstream !== undefined && event.workstream.kind !== "workstream")
  ) {
    throw invalidTeamProjection();
  }
  const common = {
    id: event.id,
    timestamp: event.timestamp,
    actor: cloneActor(event.actor),
    action: event.action,
    subjects: event.subjects.map(cloneActivitySubject),
    workstream: event.workstream === undefined
      ? null
      : { ...event.workstream, kind: "workstream" as const },
    repoState: { ...event.repoState },
  };
  if (event.schemaVersion === 1) return { schemaVersion: 1, ...common };
  return {
    schemaVersion: 2,
    ...common,
    origin: event.origin.kind === "custom"
      ? { kind: "custom" }
      : { kind: "workflow", operation: event.origin.operation },
    ...(event.label === undefined ? {} : { label: event.label }),
  };
}

function cloneActor(actor: ActorRef): ActorRef {
  if (actor.kind === "unknown") return { kind: "unknown" };
  if (actor.kind === "git") return { kind: "git", name: actor.name, email: actor.email };
  return {
    kind: "member",
    memberId: actor.memberId,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
  };
}

function cloneActivitySubject(subject: ActivitySubjectRef): ActivitySubjectRef {
  if (subject.kind === "entity") return { kind: "entity", entity: { ...subject.entity } };
  if (subject.kind === "commit") return { kind: "commit", hash: subject.hash };
  if (subject.kind === "file") return { kind: "file", path: subject.path };
  if (subject.code.kind === "file") {
    return { kind: "code", code: { ...subject.code } };
  }
  return { kind: "code", code: { ...subject.code } };
}

function toIdentityActivityCommand(
  request: TeamOperationPreviewRequest,
): TeamIdentityActivityCommand {
  if (isWorkstreamOperation(request)) throw invalidTeamProjection();
  return {
    operationId: request.operationId,
    action: cloneTeamAction(request.action),
    expectedRevisions: cloneTeamExpectations(request.expectedRevisions),
  } as TeamIdentityActivityCommand;
}

function toWorkstreamCommand(
  request: TeamOperationPreviewRequest,
): TeamWorkstreamCommand {
  if (!isWorkstreamOperation(request)) throw invalidTeamProjection();
  return {
    operationId: request.operationId,
    action: cloneTeamAction(request.action),
    expectedRevisions: cloneTeamExpectations(request.expectedRevisions),
  } as TeamWorkstreamCommand;
}

function cloneTeamAction(
  action:
    | TeamOperationPreviewRequest["action"]
    | TeamIdentityActivityCommand["action"]
    | TeamWorkstreamCommand["action"],
): TeamOperationPreviewRequest["action"] {
  switch (action.kind) {
    case "member.add":
      return {
        kind: "member.add",
        member: {
          displayName: action.member.displayName,
          gitAliases: action.member.gitAliases.map((alias) => ({ ...alias })),
        },
      };
    case "member.update":
      return {
        kind: "member.update",
        memberId: action.memberId,
        patch: {
          ...(action.patch.displayName === undefined
            ? {}
            : { displayName: action.patch.displayName }),
          ...(action.patch.gitAliases === undefined
            ? {}
            : { gitAliases: action.patch.gitAliases.map((alias) => ({ ...alias })) }),
        },
      };
    case "member.deactivate":
    case "member.reactivate":
      return { kind: action.kind, memberId: action.memberId };
    case "member.select":
      return { kind: "member.select", memberId: action.memberId };
    case "member.clear":
      return { kind: "member.clear" };
    case "workstream.create":
      return {
        kind: "workstream.create",
        workstream: {
          title: action.workstream.title,
          goal: action.workstream.goal,
          summary: action.workstream.summary,
          owners: action.workstream.owners.map(cloneActor),
          ...(action.workstream.contributors === undefined
            ? {}
            : { contributors: action.workstream.contributors.map(cloneActor) }),
          ...(action.workstream.paths === undefined ? {} : { paths: [...action.workstream.paths] }),
          ...(action.workstream.code === undefined
            ? {}
            : { code: action.workstream.code.map((entry) => ({ ...entry })) }),
          ...(action.workstream.topics === undefined
            ? {}
            : { topics: action.workstream.topics.map((entry) => ({ ...entry })) }),
          ...(action.workstream.components === undefined
            ? {}
            : { components: action.workstream.components.map((entry) => ({ ...entry })) }),
          ...(action.workstream.related === undefined
            ? {}
            : { related: action.workstream.related.map((entry) => ({ ...entry })) }),
          nextMilestone: action.workstream.nextMilestone,
        },
      };
    case "workstream.update":
      return {
        kind: "workstream.update",
        workstreamId: action.workstreamId,
        patch: {
          ...(action.patch.title === undefined ? {} : { title: action.patch.title }),
          ...(action.patch.goal === undefined ? {} : { goal: action.patch.goal }),
          ...(action.patch.summary === undefined ? {} : { summary: action.patch.summary }),
          ...(action.patch.state === undefined ? {} : { state: action.patch.state }),
          ...(action.patch.owners === undefined
            ? {}
            : { owners: action.patch.owners.map(cloneActor) }),
          ...(action.patch.contributors === undefined
            ? {}
            : { contributors: action.patch.contributors.map(cloneActor) }),
          ...(action.patch.paths === undefined ? {} : { paths: [...action.patch.paths] }),
          ...(action.patch.code === undefined
            ? {}
            : { code: action.patch.code.map((entry) => ({ ...entry })) }),
          ...(action.patch.topics === undefined
            ? {}
            : { topics: action.patch.topics.map((entry) => ({ ...entry })) }),
          ...(action.patch.components === undefined
            ? {}
            : { components: action.patch.components.map((entry) => ({ ...entry })) }),
          ...(action.patch.related === undefined
            ? {}
            : { related: action.patch.related.map((entry) => ({ ...entry })) }),
          ...(action.patch.blockers === undefined
            ? {}
            : { blockers: [...action.patch.blockers] }),
          ...(action.patch.currentState === undefined
            ? {}
            : { currentState: action.patch.currentState }),
          ...(action.patch.nextMilestone === undefined
            ? {}
            : { nextMilestone: action.patch.nextMilestone }),
        },
      };
    case "workstream.archive":
      return { kind: "workstream.archive", workstreamId: action.workstreamId };
    case "activity.record": {
      if (action.activity.workstream !== undefined
        && action.activity.workstream.kind !== "workstream") {
        throw invalidTeamProjection();
      }
      return {
        kind: "activity.record",
        activity: {
          action: action.activity.action,
          subjects: action.activity.subjects.map(cloneActivitySubject),
          ...(action.activity.workstream === undefined
            ? {}
            : { workstream: { ...action.activity.workstream, kind: "workstream" as const } }),
        },
      };
    }
  }
}

function projectTeamOperationEnvelope(
  envelope: TeamIdentityActivityPreviewEnvelope | TeamWorkstreamPreviewEnvelope,
): TeamOperationPreviewResponse {
  return {
    schemaVersion: 1,
    request: {
      operationId: envelope.request.operationId,
      action: cloneTeamAction(envelope.request.action),
      expectedRevisions: cloneTeamExpectations(envelope.request.expectedRevisions),
    },
    preview: {
      valid: envelope.preview.valid,
      scope: envelope.preview.scope,
      changes: envelope.preview.changes.map((change) => ({ ...change })),
      localChanges: projectIdentityLocalChanges(envelope.preview.localChanges),
      diagnostics: envelope.preview.diagnostics.map(projectPortableTeamDiagnostic),
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: cloneActor(envelope.receipt.authority.actor),
        occurredAt: envelope.receipt.authority.occurredAt,
        repoState: { ...envelope.receipt.authority.repoState },
      },
      purposeIds: envelope.receipt.purposeIds.map((purpose) => ({ ...purpose })),
      requestRevision: envelope.receipt.requestRevision,
      presentationRevision: envelope.receipt.presentationRevision,
      previewRevision: envelope.receipt.previewRevision,
    },
  };
}

function projectIdentityLocalChanges(
  changes: readonly TeamWorkflowResult<JsonValue>["localChanges"][number][],
): TeamOperationApplyResponse["localChanges"] {
  return changes.map((change) => {
    if (change.namespace !== "member-selection" || change.id !== "current") {
      throw invalidTeamProjection();
    }
    return {
      namespace: "member-selection",
      id: "current",
      beforeRevision: change.beforeRevision,
      afterRevision: change.afterRevision,
      summary: change.summary,
    };
  });
}

function invalidTeamProjection(): HubHttpError {
  return new HubHttpError(
    500,
    "INTERNAL_ERROR",
    "Invalid Team projection",
    "The Team workflow returned an invalid bounded identity result.",
  );
}

function projectPortableTeamDiagnostic(diagnostic: Diagnostic): ActivityDiagnostic {
  const projected = projectDiagnostic(diagnostic);
  if (
    diagnostic.code !== projected.code
    || diagnostic.severity !== projected.severity
    || diagnostic.message !== projected.message
    || diagnostic.path !== projected.path
    || diagnostic.location !== undefined
    || diagnostic.entity !== undefined
    || diagnostic.remediation !== undefined
    || diagnostic.detail !== undefined
  ) {
    throw invalidTeamProjection();
  }
  return projected;
}

function toIdentityActivityEnvelope(
  envelope: TeamOperationApplyRequest,
): TeamIdentityActivityPreviewEnvelope {
  const purposeIds = envelope.receipt.purposeIds.map((purpose) => {
    if (purpose.purpose === "workstream") throw invalidTeamProjection();
    return { ...purpose };
  });
  return {
    schemaVersion: 1,
    request: toIdentityActivityCommand(envelope.request),
    preview: {
      valid: envelope.preview.valid,
      scope: envelope.preview.scope,
      changes: envelope.preview.changes.map((change) => ({ ...change })),
      localChanges: envelope.preview.localChanges.map((change) => ({ ...change })),
      diagnostics: envelope.preview.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: cloneActor(envelope.receipt.authority.actor),
        occurredAt: envelope.receipt.authority.occurredAt,
        repoState: { ...envelope.receipt.authority.repoState },
      },
      purposeIds,
      requestRevision: envelope.receipt.requestRevision,
      presentationRevision: envelope.receipt.presentationRevision,
      previewRevision: envelope.receipt.previewRevision,
    },
  };
}

function toWorkstreamEnvelope(
  envelope: TeamOperationApplyRequest,
): TeamWorkstreamPreviewEnvelope {
  const purposeIds = envelope.receipt.purposeIds.map((purpose) => {
    if (purpose.purpose === "member") throw invalidTeamProjection();
    return { ...purpose };
  });
  return {
    schemaVersion: 1,
    request: toWorkstreamCommand(envelope.request),
    preview: {
      valid: envelope.preview.valid,
      scope: envelope.preview.scope,
      changes: envelope.preview.changes.map((change) => ({ ...change })),
      localChanges: envelope.preview.localChanges.map((change) => ({ ...change })),
      diagnostics: envelope.preview.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: cloneActor(envelope.receipt.authority.actor),
        occurredAt: envelope.receipt.authority.occurredAt,
        repoState: { ...envelope.receipt.authority.repoState },
      },
      purposeIds,
      requestRevision: envelope.receipt.requestRevision,
      presentationRevision: envelope.receipt.presentationRevision,
      previewRevision: envelope.receipt.previewRevision,
    },
  };
}

function cloneTeamExpectations(
  expectations: readonly RevisionExpectation[],
): TeamOperationPreviewRequest["expectedRevisions"] {
  return expectations.map((expectation) => (
    expectation.target.kind === "artifact"
      ? {
          target: { kind: "artifact" as const, path: expectation.target.path },
          revision: expectation.revision,
        }
      : {
          target: {
            kind: "local" as const,
            namespace: "member-selection" as const,
            id: "current" as const,
          },
          revision: expectation.revision,
        }
  ));
}

function isWorkstreamOperation(
  request: { action: { kind: string } },
): boolean {
  return request.action.kind === "workstream.create"
    || request.action.kind === "workstream.update"
    || request.action.kind === "workstream.archive";
}

function projectTimelineEntry(item: ResolvedTimelineEntry): ActivityResponse["items"][number] {
  const entry = item.entry;
  if (entry.source === "legacy") {
    const safeFiles = entry.files.filter(isCanonicalRepoPath);
    const subjects = safeFiles
      .filter((path) => Buffer.byteLength(path, "utf8") <= 384)
      .map((path): ActivitySubject => ({ kind: "file", path }));
    const preview = subjects.slice(0, 8);
    const message = boundedLegacyMessage(entry.message);
    return {
      source: "legacy",
      id: entry.id,
      timestamp: entry.timestamp,
      action: entry.kind,
      subjects: preview,
      subjectCount: safeFiles.length,
      subjectsTruncated: safeFiles.length > preview.length,
      sourcePath: entry.sourcePath,
      recordedActor: null,
      effectiveActor: null,
      actorDiagnostics: [],
      workstream: null,
      repository: null,
      revision: null,
      sourceLine: entry.sourceLine,
      message: message.value,
      messageTruncated: message.truncated,
    };
  }

  const subjects = entry.event.subjects.flatMap((subject) => {
    const projected = projectSubject(subject);
    return projected === null ? [] : [projected];
  });
  const preview = subjects.slice(0, 8);
  return {
    source: "activity",
    id: entry.id,
    timestamp: entry.timestamp,
    action: entry.event.action,
    subjects: preview,
    subjectCount: entry.event.subjects.length,
    subjectsTruncated: entry.event.subjects.length > preview.length,
    sourcePath: entry.sourcePath,
    recordedActor: projectActor(item.recordedActor ?? entry.actor),
    effectiveActor: projectActor(item.effectiveActor ?? entry.actor),
    actorDiagnostics: item.diagnostics.slice(0, 2).map(projectDiagnostic),
    recordOrigin: entry.event.schemaVersion === 1
      ? { kind: "unknown" }
      : entry.event.origin.kind === "custom"
        ? { kind: "custom" }
        : { kind: "workflow", operation: entry.event.origin.operation },
    label: entry.event.schemaVersion === 1 ? null : entry.event.label ?? null,
    workstream: entry.event.workstream === undefined
      ? null
      : projectEntity(entry.event.workstream),
    repository: {
      branch: entry.repoState.branch,
      head: entry.repoState.head,
      dirty: entry.repoState.dirty,
      observedAt: entry.repoState.observedAt,
    },
    revision: entry.event.revision,
  };
}

function projectActor(actor: ActorRef): ActivityActor {
  if (actor.kind === "unknown") return actor;
  if (actor.kind === "git") return actor;
  return {
    kind: "member",
    memberId: actor.memberId,
    displayName: actor.displayName ?? null,
  };
}

function projectEntity(entity: EntityRef): ActivityEntityRef {
  return {
    id: entity.id,
    entityKind: entity.kind,
    title: entity.title ?? null,
  };
}

function projectSubject(subject: ActivitySubjectRef): ActivitySubject | null {
  if (subject.kind === "entity") {
    return { kind: "entity", entity: projectEntity(subject.entity) };
  }
  if (subject.kind === "commit") return { kind: "commit", hash: subject.hash };
  if (subject.kind === "file") {
    return isActivityDisplayPath(subject.path) ? { kind: "file", path: subject.path } : null;
  }
  if (subject.code.kind === "file") {
    return isActivityDisplayPath(subject.code.path)
      ? { kind: "file", path: subject.code.path }
      : null;
  }
  return { kind: "symbol", symbolId: subject.code.symbolId };
}

function projectDiagnostic(diagnostic: Diagnostic): ActivityDiagnostic {
  return {
    code: truncateUtf8(diagnostic.code, 128) || "ACTIVITY_DIAGNOSTIC",
    severity: diagnostic.severity,
    message: safeDiagnosticMessage(diagnostic.code),
    ...(diagnostic.path !== undefined
      && isActivityDisplayPath(diagnostic.path)
      ? { path: diagnostic.path }
      : {}),
  };
}

function safeDiagnosticMessage(code: string): string {
  switch (code) {
    case "ACTIVITY_ARTIFACT_UNEXPECTED":
      return "An unexpected item in canonical activity storage was ignored.";
    case "ACTIVITY_ID_CONFLICT":
      return "Conflicting canonical events were excluded from trusted activity.";
    case "ACTIVITY_SOURCE_TRUNCATED":
      return "Canonical activity exceeded its safe read bound.";
    case "LEGACY_ACTIVITY_MALFORMED":
      return "A malformed legacy activity row was ignored.";
    case "LEGACY_ACTIVITY_DUPLICATE":
      return "A duplicate legacy activity row was retained with a diagnostic.";
    case "LEGACY_ACTIVITY_LIMIT_EXCEEDED":
      return "Legacy activity exceeded its safe read bound.";
    case "ACTOR_MEMBER_MISSING":
      return "The referenced member no longer exists.";
    case "ACTOR_MEMBER_INACTIVE":
      return "The referenced member is currently inactive.";
    case "ACTOR_ALIAS_AMBIGUOUS":
      return "The recorded Git identity matches multiple active members and was not remapped.";
    case "GIT_IDENTITY_UNAVAILABLE":
      return "Git identity could not be inspected safely.";
    case "GIT_IDENTITY_INVALID":
      return "Git identity exceeded the bounded actor contract and was ignored.";
    case "RELAY_LEGACY_PUBLICATION_TIME":
      return "One or more legacy schema-v1 Relays have no canonical publication timestamp.";
    default:
      return "Activity history reported a local diagnostic.";
  }
}

function boundedLegacyMessage(message: string): { value: string; truncated: boolean } {
  const normalized = message
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  return {
    value: truncateUtf8(normalized, 2_048),
    truncated: Buffer.byteLength(normalized, "utf8") > 2_048,
  };
}

function isCanonicalRepoPath(path: string): boolean {
  return isRepoRelativePath(path)
    && path.normalize("NFC") === path
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path);
}

function isActivityDisplayPath(path: string): boolean {
  return isCanonicalRepoPath(path) && Buffer.byteLength(path, "utf8") <= 384;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maximumBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

function available(): CapabilityStatus {
  return { availability: "available" };
}

function unavailable(reason: string): CapabilityStatus {
  return { availability: "unavailable", reason };
}

async function gitCapability(git: GitPort): Promise<CapabilityStatus> {
  try {
    await git.getRepoState();
    return available();
  } catch {
    return unavailable("Git repository state is not safely readable.");
  }
}

type OverviewIdentityRead = OverviewResponse["identity"];
type OverviewContextAvailable = Extract<OverviewContextPanel, { availability: "available" }>;
type OverviewGraphRead = OverviewContextAvailable["graph"];
type OverviewWikiRead = OverviewContextAvailable["wiki"];

type OverviewRelayCorpus =
  | {
      availability: "available";
      observedAt: string;
      items: RelaySummary[];
      deterministicRevision: string;
      diagnostics: ActivityDiagnostic[];
      diagnosticsTruncated: boolean;
    }
  | {
      availability: "unavailable";
      observedAt: string;
      reason: string;
      deterministicRevision?: string;
      truncated?: boolean;
      sourceTruncated?: boolean;
      diagnostics?: ActivityDiagnostic[];
      diagnosticsTruncated?: boolean;
    };

type OverviewJobsRead =
  | { availability: "available"; observedAt: string; items: HubJobSnapshot[] }
  | { availability: "unavailable"; observedAt: string; reason: string };

async function readOverviewIdentity(
  team: HubTeamIdentityActivityService,
  observedAt: string,
): Promise<OverviewIdentityRead> {
  try {
    return {
      availability: "available",
      observedAt,
      current: projectCurrentActor(await team.getCurrentActor()),
    };
  } catch {
    return {
      availability: "unavailable",
      observedAt,
      reason: "Current team identity could not be resolved safely.",
    };
  }
}

function projectCurrentActor(current: TeamCurrentActor): TeamCurrentActorResponse {
  const diagnostics = current.diagnostics.map(projectDiagnostic);
  return {
    actor: cloneActor(current.actor),
    source: current.source,
    selection: current.selection === null ? null : { ...current.selection },
    diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
    diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
  };
}

async function readOverviewInbox(
  inbox: HubInboxSpecAuthoringService | undefined,
  observedAt: string,
): Promise<OverviewFocusInboxSource> {
  if (inbox === undefined) {
    return { availability: "unavailable", observedAt, reason: "Inbox workflows are not connected in this build." };
  }
  try {
    const page = await inbox.listInboxProposals({ states: ["pending", "stale"], limit: 100 });
    const diagnostics = page.diagnostics.map(projectDiagnostic);
    if (
      page.sourceTruncated
      || page.truncated
      || page.nextCursor !== null
      || page.diagnostics.length > 0
    ) {
      return {
        availability: "unavailable",
        observedAt,
        reason: "The team review queue exceeded a bounded, trustworthy first-page summary.",
        deterministicRevision: page.deterministicRevision,
        truncated: page.truncated || page.nextCursor !== null,
        sourceTruncated: page.sourceTruncated,
        diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
        diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
      };
    }
    return {
      availability: "available",
      observedAt,
      teamReviewCount: page.items.length,
      items: page.items.slice(0, 3).map(projectInboxProposalSummary),
      deterministicRevision: page.deterministicRevision,
      sourceTruncated: false,
      diagnostics: [],
      diagnosticsTruncated: false,
    };
  } catch {
    return { availability: "unavailable", observedAt, reason: "Inbox proposals could not be read safely." };
  }
}

async function readOverviewRelays(
  relays: HubRelayHandoffService | undefined,
  observedAt: string,
): Promise<OverviewRelayCorpus> {
  if (relays === undefined) {
    return { availability: "unavailable", observedAt, reason: "Relay workflows are not connected in this build." };
  }
  try {
    const page = await relays.listRelays({
      perspective: "all",
      states: ["published", "acknowledged"],
      limit: 100,
    });
    const unsafeDiagnostic = page.diagnostics.some(
      (diagnostic) => diagnostic.code !== "RELAY_LEGACY_PUBLICATION_TIME",
    );
    const diagnostics = page.diagnostics.map(projectDiagnostic);
    if (page.sourceTruncated || page.truncated || page.nextCursor !== null || unsafeDiagnostic) {
      return {
        availability: "unavailable",
        observedAt,
        reason: "Open Relay handoffs exceeded a bounded, trustworthy first-page summary.",
        deterministicRevision: page.deterministicRevision,
        truncated: page.truncated || page.nextCursor !== null,
        sourceTruncated: page.sourceTruncated,
        diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
        diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
      };
    }
    return {
      availability: "available",
      observedAt,
      items: page.items.map(projectRelaySummary),
      deterministicRevision: page.deterministicRevision,
      diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
      diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
    };
  } catch {
    return { availability: "unavailable", observedAt, reason: "Relay handoffs could not be read safely." };
  }
}

function projectOverviewRelays(
  identity: OverviewIdentityRead,
  corpus: OverviewRelayCorpus,
  observedAt: string,
): OverviewFocusRelaySource {
  if (corpus.availability === "unavailable") return corpus;
  if (identity.availability === "unavailable" || identity.current.actor.kind !== "member") {
    return {
      availability: "unavailable",
      observedAt,
      reason: "Select an active Member to see your personal Relay handoffs.",
    };
  }
  const memberId = identity.current.actor.memberId;
  const readyToTake = corpus.items.filter((relay) => (
    relay.state === "published"
    && (relay.audience === "team" || relay.recipients.some((recipient) => (
      recipient.kind === "member" && recipient.memberId === memberId
    )))
  ));
  const inYourHands = corpus.items.filter((relay) => (
    relay.state === "acknowledged"
    && relay.acknowledgedBy?.kind === "member"
    && relay.acknowledgedBy.memberId === memberId
  ));
  return {
    availability: "available",
    observedAt,
    readyToTakeCount: readyToTake.length,
    inYourHandsCount: inYourHands.length,
    readyToTake: readyToTake.slice(0, 3),
    inYourHands: inYourHands.slice(0, 3),
    deterministicRevision: corpus.deterministicRevision,
    sourceTruncated: false,
    diagnostics: corpus.diagnostics,
    diagnosticsTruncated: corpus.diagnosticsTruncated,
  };
}

async function readOverviewActivity(
  timeline: TimelineReader,
  observedAt: string,
): Promise<OverviewResponse["activity"]> {
  try {
    const page = await timeline.listResolved({ limit: 5 });
    const projected = projectActivityPage(page);
    return { availability: "available", observedAt, ...projected };
  } catch {
    return {
      availability: "unavailable",
      observedAt,
      reason: "Recent team activity could not be read safely.",
    };
  }
}

function projectActivityPage(page: ResolvedTimelinePage): ActivityResponse {
  const diagnostics = page.diagnostics.map(projectDiagnostic);
  return {
    items: page.items.map(projectTimelineEntry),
    nextCursor: page.nextCursor,
    hasMore: page.truncated,
    sourceTruncated: page.sourceTruncated,
    deterministicRevision: page.deterministicRevision,
    diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
    diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
  };
}

async function readOverviewGraph(
  graph: HubGraphReadService | undefined,
  observedAt: string,
): Promise<OverviewGraphRead> {
  if (graph === undefined) {
    return { availability: "unavailable", observedAt, reason: "The Graph adapter is not connected in this build." };
  }
  try {
    const status = await graph.inspectStatus();
    const component = projectGraphHealthStatus(status, null);
    if (component.graph === undefined) throw new Error("Missing Graph health details.");
    const { activeJobId: _activeJobId, ...details } = component.graph;
    void _activeJobId;
    return {
      availability: "available",
      observedAt: status.observedAt,
      status: status.status === "fresh" && status.parseHealth.failed === 0
        ? "healthy"
        : "degraded",
      summary: component.summary,
      diagnostics: component.diagnostics,
      diagnosticsTruncated: status.diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
      repairJobKind: component.graph.recommendedJobKind,
      details,
    };
  } catch {
    return {
      availability: "unavailable",
      observedAt,
      reason: "Graph status could not be observed against a stable local snapshot.",
    };
  }
}

async function readOverviewWiki(
  wiki: HubWikiReadService | undefined,
  observedAt: string,
): Promise<OverviewWikiRead> {
  if (wiki === undefined) {
    return { availability: "unavailable", observedAt, reason: "The Wiki adapter is not connected in this build." };
  }
  try {
    const status = await wiki.inspectIndex();
    const component = projectWikiHealthStatus(status, null);
    if (component.wiki === undefined) throw new Error("Missing Wiki health details.");
    const { activeJobId: _activeJobId, ...details } = component.wiki;
    void _activeJobId;
    return {
      availability: "available",
      observedAt: status.observedAt,
      status: status.state === "fresh" ? "healthy" : "degraded",
      summary: component.summary,
      diagnostics: component.diagnostics,
      diagnosticsTruncated: status.diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
      repairJobKind: component.wiki.recommendedJobKind,
      details,
    };
  } catch {
    return {
      availability: "unavailable",
      observedAt,
      reason: "Wiki status could not be observed against a stable local snapshot.",
    };
  }
}

function readOverviewJobs(jobs: HubJobReader, observedAt: string): OverviewJobsRead {
  try {
    const page = jobs.list({ limit: 100 });
    if (page.nextCursor !== undefined && page.nextCursor !== null) {
      return {
        availability: "unavailable",
        observedAt,
        reason: "Local operations exceeded the bounded first-page summary.",
      };
    }
    return { availability: "available", observedAt, items: [...page.items].sort(compareJobsNewest) };
  } catch {
    return { availability: "unavailable", observedAt, reason: "Local operations could not be read safely." };
  }
}

function compareJobsNewest(left: HubJobSnapshot, right: HubJobSnapshot): number {
  const time = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return time === 0 ? right.id.localeCompare(left.id) : time;
}

function jobIsNewer(left: HubJobSnapshot, right: HubJobSnapshot): boolean {
  return compareJobsNewest(left, right) < 0;
}

const OVERVIEW_FAILURE_RELEVANCE_MS = 7 * 24 * 60 * 60 * 1_000;

function jobFailureIsRecent(job: HubJobSnapshot, observedAt: string): boolean {
  const occurredAt = Date.parse(job.finishedAt ?? job.createdAt);
  const age = Date.parse(observedAt) - occurredAt;
  return age <= OVERVIEW_FAILURE_RELEVANCE_MS;
}

function projectHomeResponse(input: {
  observedAt: string;
  scaffoldId: string;
  projectRoot: string;
  repository: RepoState;
  identity: OverviewIdentityRead;
  inbox: OverviewFocusInboxSource;
  relays: OverviewRelayCorpus;
  jobs: OverviewJobsRead;
}): HomeResponse {
  const relayFocus = projectOverviewRelays(input.identity, input.relays, input.observedAt);
  return {
    observedAt: input.observedAt,
    repository: {
      scaffoldId: input.scaffoldId,
      name: basename(input.projectRoot),
      branch: input.repository.branch,
      head: input.repository.head,
      dirty: input.repository.dirty,
    },
    actor: projectHomeActor(input.identity),
    attention: {
      inbox: input.inbox.availability === "available"
        ? { availability: "available", teamReviewCount: input.inbox.teamReviewCount }
        : { availability: "unavailable", reason: input.inbox.reason },
      relays: relayFocus.availability === "available"
        ? {
            availability: "available",
            readyToTakeCount: relayFocus.readyToTakeCount,
            inYourHandsCount: relayFocus.inYourHandsCount,
          }
        : { availability: "unavailable", reason: relayFocus.reason },
    },
    jobs: input.jobs.availability === "available"
      ? {
          availability: "available",
          activeCount: input.jobs.items.filter(
            (job) => job.state === "queued" || job.state === "running",
          ).length,
        }
      : { availability: "unavailable", reason: input.jobs.reason },
  };
}

function projectHomeActor(identity: OverviewIdentityRead): HubActor {
  if (identity.availability === "unavailable") return { kind: "unknown" };
  const actor = identity.current.actor;
  if (actor.kind !== "member") return actor;
  return {
    kind: "member",
    memberId: actor.memberId,
    // Current resolution normally carries the canonical display name. The ID
    // remains a truthful bounded fallback for older/custom service adapters.
    displayName: actor.displayName ?? actor.memberId,
  };
}

function projectOverviewFocus(
  identity: OverviewIdentityRead,
  inbox: OverviewFocusInboxSource,
  relays: OverviewRelayCorpus,
  observedAt: string,
): OverviewResponse["focus"] {
  const focusIdentity = identity.availability === "available"
    ? {
        availability: "available" as const,
        observedAt,
        requiresAttention: identity.current.actor.kind !== "member"
          || identity.current.diagnostics.some((diagnostic) => [
            "ACTOR_MEMBER_MISSING",
            "ACTOR_MEMBER_INACTIVE",
            "ACTOR_ALIAS_AMBIGUOUS",
            "GIT_IDENTITY_UNAVAILABLE",
            "GIT_IDENTITY_INVALID",
          ].includes(diagnostic.code)),
      }
    : identity;
  const relayFocus = projectOverviewRelays(identity, relays, observedAt);
  if (
    focusIdentity.availability === "unavailable"
    && inbox.availability === "unavailable"
    && relayFocus.availability === "unavailable"
  ) {
    return {
      availability: "unavailable",
      observedAt,
      reason: "Personal focus sources could not be read safely.",
    };
  }
  return {
    availability: "available",
    observedAt,
    identity: focusIdentity,
    inbox,
    relays: relayFocus,
  };
}

function projectOverviewContext(
  graph: OverviewGraphRead,
  wiki: OverviewWikiRead,
  observedAt: string,
): OverviewResponse["context"] {
  if (graph.availability === "unavailable" && wiki.availability === "unavailable") {
    return {
      availability: "unavailable",
      observedAt,
      reason: "Graph and Wiki context readiness could not be observed safely.",
    };
  }
  return { availability: "available", observedAt, graph, wiki };
}

function projectOverviewOperation(
  jobs: OverviewJobsRead,
  observedAt: string,
): OverviewResponse["operation"] {
  if (jobs.availability === "unavailable") return jobs;
  const active = jobs.items.find((job) => job.state === "queued" || job.state === "running") ?? null;
  const latestRelevantFailure = jobs.items.find((candidate) => (
    (candidate.state === "failed" || candidate.state === "interrupted")
    && jobFailureIsRecent(candidate, observedAt)
    && !jobs.items.some((job) => (
      job.kind === candidate.kind
      && job.state === "succeeded"
      && jobIsNewer(job, candidate)
    ))
  )) ?? null;
  return { availability: "available", observedAt, active, latestRelevantFailure };
}

function unavailableWorkstreams(): HubHttpError {
  return new HubHttpError(
    503,
    "CAPABILITY_UNAVAILABLE",
    "Capability unavailable",
    "Workstream workflows are not connected in this build.",
  );
}

function unavailableSpecs(): HubHttpError {
  return new HubHttpError(
    503,
    "CAPABILITY_UNAVAILABLE",
    "Capability unavailable",
    "Spec reads are not connected in this build.",
  );
}

function unavailableInbox(): HubHttpError {
  return new HubHttpError(
    503,
    "CAPABILITY_UNAVAILABLE",
    "Capability unavailable",
    "Inbox workflows are not connected in this build.",
  );
}

function unavailableRelays(): HubHttpError {
  return new HubHttpError(
    503,
    "CAPABILITY_UNAVAILABLE",
    "Capability unavailable",
    "Relay workflows are not connected in this build.",
  );
}

function unavailableSearch(reason: string): SearchResponse["groups"]["wiki"] {
  return {
    status: "unavailable",
    items: [],
    nextCursor: null,
    truncated: false,
    revision: null,
    code: "CAPABILITY_UNAVAILABLE",
    detail: reason,
  };
}
