import {
  AgentLoggingPolicySchema,
  AgentLoggingUpdateRequestSchema,
  type AgentLoggingPolicy,
  type AgentLoggingUpdateRequest,
  HubOnboardingCompleteRequestSchema,
  HubOnboardingStateSchema,
  type HubOnboardingState,
  ActivityRequestSchema,
  ActivityResponseSchema,
  BootstrapRequestSchema,
  BootstrapResponseSchema,
  CodeWorkspaceRequestSchema,
  CodeWorkspaceResponseSchema,
  CodeKnowledgeRequestSchema,
  CodeKnowledgeResponseSchema,
  GraphSymbolIdSchema,
  HealthResponseSchema,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HUB_LIMITS,
  HubJobSnapshotSchema,
  InboxDraftDetailSchema,
  InboxDraftIdSchema,
  InboxDraftListRequestSchema,
  InboxDraftListResponseSchema,
  InboxOperationApplyRequestSchema,
  InboxOperationApplyResponseSchema,
  InboxOperationPreviewRequestSchema,
  InboxOperationPreviewResponseSchema,
  InboxProposalDetailSchema,
  InboxProposalIdSchema,
  InboxProposalListRequestSchema,
  InboxProposalListResponseSchema,
  InboxProposalStateSchema,
  RelayDetailSchema,
  RelayDraftDetailSchema,
  RelayDraftIdSchema,
  RelayDraftListRequestSchema,
  RelayDraftListResponseSchema,
  RelayIdSchema,
  RelayListRequestSchema,
  RelayListResponseSchema,
  RelayOperationApplyRequestSchema,
  RelayOperationApplyResponseSchema,
  RelayOperationPreviewRequestSchema,
  RelayOperationPreviewResponseSchema,
  RelayStateSchema,
  JobCancelRequestSchema,
  JobPageRequestSchema,
  JobPageResponseSchema,
  JobStartRequestSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SessionResponseSchema,
  SpecDetailResponseSchema,
  SpecListRequestSchema,
  SpecListResponseSchema,
  TeamCurrentActorResponseSchema,
  TeamMemberIdSchema,
  TeamMemberListRequestSchema,
  TeamMemberListResponseSchema,
  TeamMemberSchema,
  TeamOperationApplyRequestSchema,
  TeamOperationApplyResponseSchema,
  TeamOperationPreviewRequestSchema,
  TeamOperationPreviewResponseSchema,
  TeamWorkstreamIdSchema,
  TeamWorkstreamListRequestSchema,
  TeamWorkstreamListResponseSchema,
  TeamWorkstreamSchema,
  WikiBacklinksRequestSchema,
  WikiBacklinksResponseSchema,
  WikiEntityDetailResponseSchema,
  WikiEntityIdSchema,
  WikiEntityListRequestSchema,
  WikiEntityListResponseSchema,
  WikiRelationsRequestSchema,
  WikiRelationsResponseSchema,
  WikiGraphResponseSchema,
  WikiGroundedCodeResponseSchema,
  type HealthResponse,
  type CodeWorkspaceRequest,
  type CodeWorkspaceResponse,
  type CodeKnowledgeRequest,
  type CodeKnowledgeResponse,
  type ActivityRequest,
  type ActivityResponse,
  type HomeResponse,
  type OverviewResponse,
  type HubCapabilities,
  type HubJobKind,
  type HubJobSnapshot,
  type InboxDraftDetail,
  type InboxDraftListRequest,
  type InboxDraftListResponse,
  type InboxOperationApplyRequest,
  type InboxOperationApplyResponse,
  type InboxOperationPreviewRequest,
  type InboxOperationPreviewResponse,
  type InboxProposalDetail,
  type InboxProposalListRequest,
  type InboxProposalListResponse,
  type RelayDetail,
  type RelayDraftDetail,
  type RelayDraftListRequest,
  type RelayDraftListResponse,
  type RelayListRequest,
  type RelayListResponse,
  type RelayOperationApplyRequest,
  type RelayOperationApplyResponse,
  type RelayOperationPreviewRequest,
  type RelayOperationPreviewResponse,
  type JobPageRequest,
  type SearchRequest,
  type SearchResponse,
  type SpecDetailResponse,
  type SpecListRequest,
  type SpecListResponse,
  type TeamCurrentActorResponse,
  type TeamMember,
  type TeamMemberListRequest,
  type TeamMemberListResponse,
  type TeamOperationApplyRequest,
  type TeamOperationApplyResponse,
  type TeamOperationPreviewRequest,
  type TeamOperationPreviewResponse,
  type TeamWorkstream,
  type TeamWorkstreamListRequest,
  type TeamWorkstreamListResponse,
  type WikiBacklinksRequest,
  type WikiBacklinksResponse,
  type WikiEntityDetailResponse,
  type WikiEntityListRequest,
  type WikiEntityListResponse,
  type WikiRelationsRequest,
  type WikiRelationsResponse,
  type WikiGraphResponse,
  type WikiGroundedCodeResponse,
} from "@mex/hub-contracts";
import { OverviewResponseSchema } from "@mex/hub-contracts/overview";
import {
  SetupRunSchema,
  SetupInstallationSchema,
  ContactPreferenceSchema,
  ContactPreferenceRequestSchema,
  SetupContactRequestSchema,
  SetupContactResponseSchema,
  type SetupInstallation,
  SetupStartRequestSchema,
  SetupCancelRequestSchema,
  SetupStatusSchema,
  SetupTranscriptBatchSchema,
  SetupCommitPreviewRequestSchema,
  SetupCommitPreviewSchema,
  SetupCommitRequestSchema,
  SetupCommitResponseSchema,
  SetupCommitDiffRequestSchema,
  SetupCommitDiffSchema,
  type SetupRun,
  type SetupStartRequest,
  type SetupStatus,
  type SetupTranscriptBatch,
  type SetupCommitPreview,
  type SetupCommitDiff,
  type SetupCommitDiffRequest,
  type SetupCommitRequest,
  type SetupCommitResponse,
} from "@mex/hub-contracts/setup";
import { readContactPreference, rememberContactPreference, submitSetupContact } from "../setup/contact.js";
import { Hono, type Context } from "hono";
import { getCookie, generateCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import {
  createRequestId,
  HubHttpError,
  invalidRequest,
  notFound,
  parseInput,
  problemResponse,
  resourceResponse,
  unavailable,
  validationFailed,
} from "./http/errors.js";
import { readBoundedJson, readStrictQuery } from "./http/request.js";
import { HUB_PAGE_EVENT_BODY_BYTES, HubPageViewSchema, HubTelemetry, type HubTelemetrySink } from "./telemetry.js";
import {
  type HubSession,
  HubSessionManager,
} from "./security/session.js";
import {
  HubAssetManifest,
  validateHubRequestPath,
} from "./static/assets.js";

const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "interrupted"]);
const SSE_HEARTBEAT_MS = 15_000;
const MAX_PENDING_SSE_EVENTS = 64;
const MAX_SSE_SUBSCRIBERS_PER_JOB = 8;
const MAX_SSE_SUBSCRIBERS_PER_PROCESS = 32;

type HubJobEventType = "snapshot" | "progress" | "terminal";

export interface HubJobEvent {
  readonly type: HubJobEventType;
  readonly job: HubJobSnapshot;
}

/** Structural seam implemented by the internal persistent Hub job manager. */
export interface HubJobService {
  list(request: JobPageRequest): Promise<{
    items: readonly HubJobSnapshot[];
    nextCursor?: string | null;
  }> | {
    items: readonly HubJobSnapshot[];
    nextCursor?: string | null;
  };
  get(id: string): Promise<HubJobSnapshot | null> | HubJobSnapshot | null;
  start(request: { kind: HubJobKind }): Promise<HubJobSnapshot> | HubJobSnapshot;
  cancel(id: string): Promise<HubJobSnapshot> | HubJobSnapshot;
  subscribe(id: string, listener: (event: HubJobEvent) => void): () => void;
}

/** Process-local setup wizard seam. Present only while Hub is in setup mode. */
export interface HubSetupService {
  status(): SetupStatus | Promise<SetupStatus>;
  snapshot(): SetupRun;
  start(request: SetupStartRequest): SetupRun;
  cancel(): SetupRun;
  subscribe(listener: (run: SetupRun) => void): () => void;
  readTranscript?(runId: string, after: number): SetupTranscriptBatch;
  subscribeTranscript?(listener: () => void): () => void;
  previewCommit?(): Promise<SetupCommitPreview>;
  commitDiff?(request: SetupCommitDiffRequest): SetupCommitDiff | Promise<SetupCommitDiff>;
  commitSetup?(request: SetupCommitRequest): Promise<SetupCommitResponse>;
  installation?(): SetupInstallation;
  installGlobally?(): Promise<SetupInstallation>;
}

export interface HubReadServices {
  loggingPolicy?(): Promise<AgentLoggingPolicy> | AgentLoggingPolicy;
  setLoggingPolicy?(request: AgentLoggingUpdateRequest): Promise<AgentLoggingPolicy> | AgentLoggingPolicy;
  onboardingState?(): Promise<HubOnboardingState> | HubOnboardingState;
  completeOnboarding?(): Promise<HubOnboardingState> | HubOnboardingState;
  capabilities(): Promise<HubCapabilities> | HubCapabilities;
  home(): Promise<HomeResponse> | HomeResponse;
  overview?(): Promise<OverviewResponse> | OverviewResponse;
  activity(request: ActivityRequest): Promise<ActivityResponse> | ActivityResponse;
  members?(
    request: TeamMemberListRequest,
  ): Promise<TeamMemberListResponse> | TeamMemberListResponse;
  member?(memberId: string): Promise<TeamMember | null> | TeamMember | null;
  workstreams?(
    request: TeamWorkstreamListRequest,
  ): Promise<TeamWorkstreamListResponse> | TeamWorkstreamListResponse;
  workstream?(workstreamId: string): Promise<TeamWorkstream | null> | TeamWorkstream | null;
  inboxDrafts?(
    request: InboxDraftListRequest,
  ): Promise<InboxDraftListResponse> | InboxDraftListResponse;
  inboxDraft?(draftId: string): Promise<InboxDraftDetail | null> | InboxDraftDetail | null;
  inboxProposals?(
    request: InboxProposalListRequest,
  ): Promise<InboxProposalListResponse> | InboxProposalListResponse;
  inboxProposal?(
    proposalId: string,
  ): Promise<InboxProposalDetail | null> | InboxProposalDetail | null;
  previewInboxOperation?(
    request: InboxOperationPreviewRequest,
  ): Promise<InboxOperationPreviewResponse> | InboxOperationPreviewResponse;
  applyInboxOperation?(
    request: InboxOperationApplyRequest,
  ): Promise<InboxOperationApplyResponse> | InboxOperationApplyResponse;
  relayDrafts?(
    request: RelayDraftListRequest,
  ): Promise<RelayDraftListResponse> | RelayDraftListResponse;
  relayDraft?(draftId: string): Promise<RelayDraftDetail | null> | RelayDraftDetail | null;
  relays?(request: RelayListRequest): Promise<RelayListResponse> | RelayListResponse;
  relay?(relayId: string): Promise<RelayDetail | null> | RelayDetail | null;
  previewRelayOperation?(
    request: RelayOperationPreviewRequest,
  ): Promise<RelayOperationPreviewResponse> | RelayOperationPreviewResponse;
  applyRelayOperation?(
    request: RelayOperationApplyRequest,
  ): Promise<RelayOperationApplyResponse> | RelayOperationApplyResponse;
  specs?(request: SpecListRequest): Promise<SpecListResponse> | SpecListResponse;
  spec?(specId: string): Promise<SpecDetailResponse> | SpecDetailResponse;
  currentActor?(): Promise<TeamCurrentActorResponse> | TeamCurrentActorResponse;
  previewTeamOperation?(
    request: TeamOperationPreviewRequest,
  ): Promise<TeamOperationPreviewResponse> | TeamOperationPreviewResponse;
  applyTeamOperation?(
    request: TeamOperationApplyRequest,
  ): Promise<TeamOperationApplyResponse> | TeamOperationApplyResponse;
  search(request: SearchRequest): Promise<SearchResponse> | SearchResponse;
  codeSymbol?(
    symbolId: string,
    request: CodeWorkspaceRequest,
  ): Promise<CodeWorkspaceResponse> | CodeWorkspaceResponse;
  wikiEntities?(
    request: WikiEntityListRequest,
  ): Promise<WikiEntityListResponse> | WikiEntityListResponse;
  wikiGraph?(): Promise<WikiGraphResponse> | WikiGraphResponse;
  wikiGroundedCode?(entityId: string): Promise<WikiGroundedCodeResponse> | WikiGroundedCodeResponse;
  wikiEntity?(
    entityId: string,
  ): Promise<WikiEntityDetailResponse> | WikiEntityDetailResponse;
  wikiRelations?(
    entityId: string,
    request: WikiRelationsRequest,
  ): Promise<WikiRelationsResponse> | WikiRelationsResponse;
  wikiBacklinks?(
    entityId: string,
    request: WikiBacklinksRequest,
  ): Promise<WikiBacklinksResponse> | WikiBacklinksResponse;
  codeKnowledge?(
    symbolId: string,
    request: CodeKnowledgeRequest,
  ): Promise<CodeKnowledgeResponse> | CodeKnowledgeResponse;
  health(): Promise<HealthResponse> | HealthResponse;
  assertJobStartAllowed?(kind: HubJobKind): Promise<void> | void;
}

interface HubEnvironment {
  Variables: {
    requestId: string;
    session: HubSession;
  };
}

export interface CreateHubAppOptions {
  readonly security: HubSessionManager;
  readonly services: HubReadServices;
  readonly jobs?: HubJobService;
  readonly setup?: HubSetupService;
  readonly assets?: HubAssetManifest;
  readonly requestId?: () => string;
  readonly now?: () => number;
  readonly telemetry?: HubTelemetrySink;
}

export function createHubApp(options: CreateHubAppOptions): Hono<HubEnvironment> {
  const app = new Hono<HubEnvironment>();
  const requestId = options.requestId ?? createRequestId;
  const now = options.now ?? Date.now;
  const telemetry = new HubTelemetry(options.telemetry, now);
  const subscribers = new SseSubscriberTracker();

  app.onError((error, context) => {
    const response = problemResponse(context, error);
    applySecurityHeaders(
      response,
      context.get("requestId") as string | undefined ?? requestId(),
      context.req.path.startsWith("/api/"),
    );
    return response;
  });

  app.use("*", async (context, next) => {
    context.set("requestId", requestId());
    options.security.assertHost(context.req.raw.headers);
    await next();
    applySecurityHeaders(
      context.res,
      context.get("requestId"),
      context.req.path.startsWith("/api/"),
    );
  });

  app.use("/api/*", async (context, next) => {
    const isBootstrap = context.req.method === "POST"
      && context.req.path === "/api/v1/session/bootstrap";
    if (isBootstrap) {
      options.security.assertOrigin(context.req.raw.headers);
      await next();
      return;
    }

    const session = options.security.authenticate(
      getCookie(context, options.security.sessionCookieName),
    );
    context.set("session", session);

    if (!isReadMethod(context.req.method)) {
      options.security.assertOrigin(context.req.raw.headers);
      options.security.assertCsrf(session, context.req.header("x-mex-csrf"));
    }
    await next();
  });

  app.post("/api/v1/session/bootstrap", async (context) => {
    const body = parseInput(
      BootstrapRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    const session = options.security.exchangeBootstrap(body.token);
    const response = resourceResponse(
      BootstrapResponseSchema,
      { expiresAt: session.expiresAt },
      201,
    );
    const maxAge = options.security.remainingSessionSeconds(session);
    response.headers.append("set-cookie", generateCookie(
      options.security.sessionCookieName,
      session.id,
      {
        httpOnly: true,
        sameSite: "Strict",
        path: "/api/v1",
        maxAge,
      },
    ));
    return response;
  });

  app.get("/api/v1/session", (context) => resourceResponse(
    SessionResponseSchema,
    {
      csrfToken: context.get("session").csrfToken,
      expiresAt: context.get("session").expiresAt,
    },
  ));

  app.post("/api/v1/telemetry/page", async (context) => {
    readStrictQuery(context.req.raw, []);
    const request = parseInput(HubPageViewSchema, await readBoundedJson(context.req.raw, HUB_PAGE_EVENT_BODY_BYTES));
    telemetry.pageViewed(request.page);
    // Accepted locally is not a delivery promise. Opt-out and rate-limited
    // events take the same quiet path without queuing or persisting anything.
    return new Response(null, { status: 204 });
  });

  app.get("/api/v1/capabilities", async () => resourceResponse(
    HubCapabilitiesSchema,
    await options.services.capabilities(),
  ));

  app.get("/api/v1/home", async () => resourceResponse(
    HomeResponseSchema,
    await options.services.home(),
  ));

  app.get("/api/v1/overview", async () => {
    const overview = options.services.overview;
    if (overview === undefined) {
      throw unavailable("Overview reads are not connected in this build.");
    }
    return resourceResponse(OverviewResponseSchema, await overview());
  });

  app.get("/api/v1/members", async (context) => {
    const request = parseInput(
      TeamMemberListRequestSchema,
      readStrictQuery(context.req.raw, ["active", "cursor", "limit"]),
    );
    const members = options.services.members;
    if (members === undefined) {
      throw unavailable("Member reads are not connected in this build.");
    }
    return resourceResponse(TeamMemberListResponseSchema, await members(request));
  });

  app.get("/api/v1/members/:id", async (context) => {
    readStrictQuery(context.req.raw, []);
    const memberId = parseInput(TeamMemberIdSchema, context.req.param("id"));
    const readMember = options.services.member;
    if (readMember === undefined) {
      throw unavailable("Member reads are not connected in this build.");
    }
    const member = await readMember(memberId);
    if (member === null) throw notFound("The requested member does not exist.");
    return resourceResponse(TeamMemberSchema, member);
  });

  app.get("/api/v1/workstreams", async (context) => {
    const request = parseInput(
      TeamWorkstreamListRequestSchema,
      readStrictQuery(context.req.raw, ["state", "includeArchived", "cursor", "limit"]),
    );
    const workstreams = options.services.workstreams;
    if (workstreams === undefined) {
      throw unavailable("Workstream reads are not connected in this build.");
    }
    return resourceResponse(TeamWorkstreamListResponseSchema, await workstreams(request));
  });

  app.get("/api/v1/workstreams/:id", async (context) => {
    readStrictQuery(context.req.raw, []);
    const workstreamId = parseInput(TeamWorkstreamIdSchema, context.req.param("id"));
    const readWorkstream = options.services.workstream;
    if (readWorkstream === undefined) {
      throw unavailable("Workstream reads are not connected in this build.");
    }
    const workstream = await readWorkstream(workstreamId);
    if (workstream === null) throw notFound("The requested Workstream does not exist.");
    return resourceResponse(TeamWorkstreamSchema, workstream);
  });

  app.get("/api/v1/inbox/drafts", async (context) => {
    const request = parseInput(
      InboxDraftListRequestSchema,
      readStrictQuery(context.req.raw, ["cursor", "limit"]),
    );
    const drafts = options.services.inboxDrafts;
    if (drafts === undefined) throw unavailable("Inbox draft reads are not connected in this build.");
    return resourceResponse(InboxDraftListResponseSchema, await drafts(request));
  });

  app.get("/api/v1/inbox/drafts/:id", async (context) => {
    readStrictQuery(context.req.raw, []);
    const draftId = parseInput(InboxDraftIdSchema, context.req.param("id"));
    const readDraft = options.services.inboxDraft;
    if (readDraft === undefined) throw unavailable("Inbox draft reads are not connected in this build.");
    const draft = await readDraft(draftId);
    if (draft === null) throw notFound("The requested Inbox draft does not exist.");
    return resourceResponse(InboxDraftDetailSchema, draft);
  });

  app.get("/api/v1/inbox/proposals", async (context) => {
    const request = parseInput(
      InboxProposalListRequestSchema,
      readInboxProposalListQuery(context.req.raw),
    );
    const proposals = options.services.inboxProposals;
    if (proposals === undefined) throw unavailable("Inbox proposal reads are not connected in this build.");
    return resourceResponse(InboxProposalListResponseSchema, await proposals(request));
  });

  app.get("/api/v1/inbox/proposals/:id", async (context) => {
    readStrictQuery(context.req.raw, []);
    const proposalId = parseInput(InboxProposalIdSchema, context.req.param("id"));
    const readProposal = options.services.inboxProposal;
    if (readProposal === undefined) throw unavailable("Inbox proposal reads are not connected in this build.");
    const proposal = await readProposal(proposalId);
    if (proposal === null) throw notFound("The requested Inbox proposal does not exist.");
    return resourceResponse(InboxProposalDetailSchema, proposal);
  });

  app.post("/api/v1/inbox/operations/preview", async (context) => {
    const request = parseInput(
      InboxOperationPreviewRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    const preview = options.services.previewInboxOperation;
    if (preview === undefined) throw unavailable("Inbox mutations are not connected in this build.");
    return telemetry.action(request.action.kind, "preview", async () =>
      resourceResponse(InboxOperationPreviewResponseSchema, await preview(request)));
  });

  app.post("/api/v1/inbox/operations/apply", async (context) => {
    const request = parseInput(
      InboxOperationApplyRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    const apply = options.services.applyInboxOperation;
    if (apply === undefined) throw unavailable("Inbox mutations are not connected in this build.");
    const completed = await telemetry.action(request.request.action.kind, "apply", async () => {
      const result = await apply(request);
      return { result, response: resourceResponse(InboxOperationApplyResponseSchema, result) };
    }, ({ result }) => result.idempotentReplay);
    return completed.response;
  });

  app.get("/api/v1/relays/drafts", async (context) => {
    const request = parseInput(
      RelayDraftListRequestSchema,
      readStrictQuery(context.req.raw, ["cursor", "limit"]),
    );
    const drafts = options.services.relayDrafts;
    if (drafts === undefined) throw unavailable("Relay draft reads are not connected in this build.");
    return resourceResponse(RelayDraftListResponseSchema, await drafts(request));
  });

  app.get("/api/v1/relays/drafts/:id", async (context) => {
    readStrictQuery(context.req.raw, []);
    const draftId = parseInput(RelayDraftIdSchema, context.req.param("id"));
    const readDraft = options.services.relayDraft;
    if (readDraft === undefined) throw unavailable("Relay draft reads are not connected in this build.");
    const draft = await readDraft(draftId);
    if (draft === null) throw notFound("The requested Relay draft does not exist.");
    return resourceResponse(RelayDraftDetailSchema, draft);
  });

  app.get("/api/v1/relays", async (context) => {
    const request = parseInput(RelayListRequestSchema, readRelayListQuery(context.req.raw));
    const relays = options.services.relays;
    if (relays === undefined) throw unavailable("Relay reads are not connected in this build.");
    return resourceResponse(RelayListResponseSchema, await relays(request));
  });

  app.get("/api/v1/relays/:id", async (context) => {
    readStrictQuery(context.req.raw, []);
    const relayId = parseInput(RelayIdSchema, context.req.param("id"));
    const readRelay = options.services.relay;
    if (readRelay === undefined) throw unavailable("Relay reads are not connected in this build.");
    const relay = await readRelay(relayId);
    if (relay === null) throw notFound("The requested Relay does not exist.");
    return resourceResponse(RelayDetailSchema, relay);
  });

  app.post("/api/v1/relays/operations/preview", async (context) => {
    const request = parseInput(
      RelayOperationPreviewRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    const preview = options.services.previewRelayOperation;
    if (preview === undefined) throw unavailable("Relay mutations are not connected in this build.");
    return telemetry.action(request.action.kind, "preview", async () =>
      resourceResponse(RelayOperationPreviewResponseSchema, await preview(request)));
  });

  app.post("/api/v1/relays/operations/apply", async (context) => {
    const request = parseInput(
      RelayOperationApplyRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    const apply = options.services.applyRelayOperation;
    if (apply === undefined) throw unavailable("Relay mutations are not connected in this build.");
    const completed = await telemetry.action(request.request.action.kind, "apply", async () => {
      const result = await apply(request);
      return { result, response: resourceResponse(RelayOperationApplyResponseSchema, result) };
    }, ({ result }) => result.idempotentReplay);
    return completed.response;
  });

  app.get("/api/v1/specs", async (context) => {
    const request = parseInput(
      SpecListRequestSchema,
      readSpecListQuery(context.req.raw),
    );
    const specs = options.services.specs;
    if (specs === undefined) throw unavailable("Spec reads are not connected in this build.");
    return resourceResponse(SpecListResponseSchema, await specs(request));
  });

  app.get("/api/v1/specs/:id", async (context) => {
    readStrictQuery(context.req.raw, []);
    const specId = parseInput(WikiEntityIdSchema, context.req.param("id"));
    const spec = options.services.spec;
    if (spec === undefined) throw unavailable("Spec reads are not connected in this build.");
    return resourceResponse(SpecDetailResponseSchema, await spec(specId));
  });

  app.get("/api/v1/actor/current", async (context) => {
    readStrictQuery(context.req.raw, []);
    const currentActor = options.services.currentActor;
    if (currentActor === undefined) {
      throw unavailable("Current actor resolution is not connected in this build.");
    }
    return resourceResponse(TeamCurrentActorResponseSchema, await currentActor());
  });

  app.post("/api/v1/team/operations/preview", async (context) => {
    const request = parseInput(
      TeamOperationPreviewRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    const preview = options.services.previewTeamOperation;
    if (preview === undefined) {
      throw unavailable("Member and Activity mutations are not connected in this build.");
    }
    return telemetry.action(request.action.kind, "preview", async () =>
      resourceResponse(TeamOperationPreviewResponseSchema, await preview(request)));
  });

  app.post("/api/v1/team/operations/apply", async (context) => {
    const request = parseInput(
      TeamOperationApplyRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    const apply = options.services.applyTeamOperation;
    if (apply === undefined) {
      throw unavailable("Member and Activity mutations are not connected in this build.");
    }
    const completed = await telemetry.action(request.request.action.kind, "apply", async () => {
      const result = await apply(request);
      return { result, response: resourceResponse(TeamOperationApplyResponseSchema, result) };
    }, ({ result }) => result.idempotentReplay);
    return completed.response;
  });

  app.get("/api/v1/activity", async (context) => {
    const request = parseInput(
      ActivityRequestSchema,
      readStrictQuery(context.req.raw, ["source", "since", "cursor", "limit"]),
    );
    return resourceResponse(ActivityResponseSchema, await options.services.activity(request));
  });

  app.get("/api/v1/search", async (context) => {
    const request = graphInput(() => parseInput(
      SearchRequestSchema,
      readStrictQuery(context.req.raw, [
        "q",
        "limit",
        "wikiCursor",
        "symbolCursor",
        "sourceCursor",
      ]),
    ));
    return resourceResponse(SearchResponseSchema, await options.services.search(request));
  });

  app.get("/api/v1/code/symbols/:id", async (context) => {
    if (!options.services.codeSymbol) {
      throw unavailable("Code graph reads are not connected in this build.");
    }
    const symbolId = graphInput(() => parseInput(GraphSymbolIdSchema, context.req.param("id")));
    const request = graphInput(() => parseInput(
      CodeWorkspaceRequestSchema,
      readStrictQuery(context.req.raw, ["view", "cursor", "limit", "depth", "sourceCursor"]),
    ));
    return resourceResponse(
      CodeWorkspaceResponseSchema,
      await options.services.codeSymbol(symbolId, request),
    );
  });

  app.get("/api/v1/code/symbols/:id/knowledge", async (context) => {
    if (!options.services.codeKnowledge) {
      throw unavailable("Code-to-Knowledge reads are not connected in this build.");
    }
    const symbolId = graphInput(() => parseInput(GraphSymbolIdSchema, context.req.param("id")));
    const request = graphInput(() => parseInput(
      CodeKnowledgeRequestSchema,
      readStrictQuery(context.req.raw, ["cursor", "limit"]),
    ));
    return resourceResponse(
      CodeKnowledgeResponseSchema,
      await options.services.codeKnowledge(symbolId, request),
    );
  });

  app.get("/api/v1/wiki/graph", async (context) => {
    if (!options.services.wikiGraph) throw unavailable("Context graph reads are not connected in this build.");
    graphInput(() => readStrictQuery(context.req.raw, []));
    return resourceResponse(WikiGraphResponseSchema, await options.services.wikiGraph());
  });

  app.get("/api/v1/wiki/entities/:id/code", async (context) => {
    if (!options.services.wikiGroundedCode) throw unavailable("Context code reads are not connected in this build.");
    const entityId = graphInput(() => parseInput(WikiEntityIdSchema, context.req.param("id")));
    graphInput(() => readStrictQuery(context.req.raw, []));
    return resourceResponse(WikiGroundedCodeResponseSchema, await options.services.wikiGroundedCode(entityId));
  });

  app.get("/api/v1/wiki/entities", async (context) => {
    if (!options.services.wikiEntities) throw unavailable("Wiki reads are not connected in this build.");
    const request = graphInput(() => parseInput(
      WikiEntityListRequestSchema,
      readStrictQuery(context.req.raw, [
        "kind", "topic", "lifecycle", "grounding", "sourceType", "cursor", "limit",
      ]),
    ));
    return resourceResponse(
      WikiEntityListResponseSchema,
      await options.services.wikiEntities(request),
    );
  });

  app.get("/api/v1/wiki/entities/:id/relations", async (context) => {
    if (!options.services.wikiRelations) throw unavailable("Wiki relation reads are not connected in this build.");
    const entityId = graphInput(() => parseInput(WikiEntityIdSchema, context.req.param("id")));
    const request = graphInput(() => parseInput(
      WikiRelationsRequestSchema,
      readStrictQuery(context.req.raw, ["direction", "type", "cursor", "limit"]),
    ));
    return resourceResponse(
      WikiRelationsResponseSchema,
      await options.services.wikiRelations(entityId, request),
    );
  });

  app.get("/api/v1/wiki/entities/:id/backlinks", async (context) => {
    if (!options.services.wikiBacklinks) throw unavailable("Wiki backlink reads are not connected in this build.");
    const entityId = graphInput(() => parseInput(WikiEntityIdSchema, context.req.param("id")));
    const request = graphInput(() => parseInput(
      WikiBacklinksRequestSchema,
      readStrictQuery(context.req.raw, ["type", "cursor", "limit"]),
    ));
    return resourceResponse(
      WikiBacklinksResponseSchema,
      await options.services.wikiBacklinks(entityId, request),
    );
  });

  app.get("/api/v1/wiki/entities/:id", async (context) => {
    if (!options.services.wikiEntity) throw unavailable("Wiki reads are not connected in this build.");
    const entityId = graphInput(() => parseInput(WikiEntityIdSchema, context.req.param("id")));
    graphInput(() => readStrictQuery(context.req.raw, []));
    return resourceResponse(
      WikiEntityDetailResponseSchema,
      await options.services.wikiEntity(entityId),
    );
  });

  app.get("/api/v1/settings/logging", async (context) => {
    readStrictQuery(context.req.raw, []);
    if (!options.services.loggingPolicy) throw unavailable("Agent logging preferences are unavailable in this build.");
    return resourceResponse(AgentLoggingPolicySchema, await options.services.loggingPolicy());
  });

  app.post("/api/v1/settings/logging", async (context) => {
    readStrictQuery(context.req.raw, []);
    if (!options.services.setLoggingPolicy) throw unavailable("Agent logging preferences are unavailable in this build.");
    const request = parseInput(AgentLoggingUpdateRequestSchema, await readBoundedJson(context.req.raw));
    return telemetry.action("settings.logging.update", "direct", async () =>
      resourceResponse(AgentLoggingPolicySchema, await options.services.setLoggingPolicy!(request)));
  });

  app.get("/api/v1/settings/onboarding", async (context) => {
    readStrictQuery(context.req.raw, []);
    if (!options.services.onboardingState) throw unavailable("The Hub tour state is unavailable in this build.");
    return resourceResponse(HubOnboardingStateSchema, await options.services.onboardingState());
  });

  app.post("/api/v1/settings/onboarding", async (context) => {
    readStrictQuery(context.req.raw, []);
    if (!options.services.completeOnboarding) throw unavailable("The Hub tour state is unavailable in this build.");
    parseInput(HubOnboardingCompleteRequestSchema, await readBoundedJson(context.req.raw));
    return resourceResponse(HubOnboardingStateSchema, await options.services.completeOnboarding());
  });

  app.get("/api/v1/health", async () => resourceResponse(
    HealthResponseSchema,
    await options.services.health(),
  ));

  app.get("/api/v1/setup", async (context) => {
    readStrictQuery(context.req.raw, []);
    return resourceResponse(SetupStatusSchema, await requireSetup(options.setup).status());
  });

  app.get("/api/v1/setup/run", async (context) => {
    readStrictQuery(context.req.raw, []);
    return resourceResponse(SetupRunSchema, requireSetup(options.setup).snapshot());
  });

  app.get("/api/v1/setup/installation", (context) => {
    readStrictQuery(context.req.raw, []);
    const setup = requireSetup(options.setup);
    if (!setup.installation) throw unavailable("Global installation is unavailable in this build.");
    return resourceResponse(SetupInstallationSchema, setup.installation());
  });

  app.post("/api/v1/setup/installation", async (context) => {
    readStrictQuery(context.req.raw, []);
    parseInput(SetupCancelRequestSchema, await readBoundedJson(context.req.raw));
    const setup = requireSetup(options.setup);
    if (!setup.installGlobally) throw unavailable("Global installation is unavailable in this build.");
    return resourceResponse(SetupInstallationSchema, await setup.installGlobally(), 202);
  });

  app.get("/api/v1/contact", (context) => {
    readStrictQuery(context.req.raw, []);
    return resourceResponse(ContactPreferenceSchema, readContactPreference());
  });

  app.post("/api/v1/contact/preference", async (context) => {
    readStrictQuery(context.req.raw, []);
    const request = parseInput(ContactPreferenceRequestSchema, await readBoundedJson(context.req.raw));
    return resourceResponse(ContactPreferenceSchema, await rememberContactPreference(request));
  });

  app.post("/api/v1/contact", async (context) => {
    readStrictQuery(context.req.raw, []);
    const request = parseInput(SetupContactRequestSchema, await readBoundedJson(context.req.raw));
    return resourceResponse(SetupContactResponseSchema, await submitSetupContact(request, { signal: context.req.raw.signal }));
  });

  app.post("/api/v1/setup", async (context) => {
    readStrictQuery(context.req.raw, []);
    const setup = requireSetup(options.setup);
    const request = parseInput(SetupStartRequestSchema, await readBoundedJson(context.req.raw));
    return telemetry.action("setup.start", "direct", async () =>
      resourceResponse(SetupRunSchema, setup.start(request), 202));
  });

  app.post("/api/v1/setup/cancel", async (context) => {
    readStrictQuery(context.req.raw, []);
    parseInput(SetupCancelRequestSchema, await readBoundedJson(context.req.raw));
    return resourceResponse(SetupRunSchema, requireSetup(options.setup).cancel(), 202);
  });

  app.post("/api/v1/setup/commit/preview", async (context) => {
    readStrictQuery(context.req.raw, []);
    parseInput(SetupCommitPreviewRequestSchema, await readBoundedJson(context.req.raw));
    const setup = requireSetup(options.setup);
    if (!setup.previewCommit) throw unavailable("Setup commit review is unavailable in this build.");
    return resourceResponse(SetupCommitPreviewSchema, await setup.previewCommit());
  });

  app.post("/api/v1/setup/commit/diff", async (context) => {
    readStrictQuery(context.req.raw, []);
    const request = parseInput(SetupCommitDiffRequestSchema, await readBoundedJson(context.req.raw));
    const setup = requireSetup(options.setup);
    if (!setup.commitDiff) throw unavailable("Setup commit review is unavailable in this build.");
    return resourceResponse(SetupCommitDiffSchema, await setup.commitDiff(request));
  });

  app.post("/api/v1/setup/commit", async (context) => {
    readStrictQuery(context.req.raw, []);
    const request = parseInput(SetupCommitRequestSchema, await readBoundedJson(context.req.raw));
    const setup = requireSetup(options.setup);
    if (!setup.commitSetup) throw unavailable("Setup commits are unavailable in this build.");
    return resourceResponse(SetupCommitResponseSchema, await setup.commitSetup(request));
  });

  app.get("/api/v1/setup/events", async (context) => {
    if (context.req.method === "HEAD") {
      throw new HubHttpError(
        405,
        "INVALID_REQUEST",
        "Method not allowed",
        "Hub setup event streams require GET.",
      );
    }
    readStrictQuery(context.req.raw, []);
    const setup = requireSetup(options.setup);
    const release = subscribers.reserve("setup");
    try {
      return createSetupEventStream(
        context,
        setup,
        context.get("session").expiresAt,
        now,
        release,
      );
    } catch (error) {
      release();
      throw error;
    }
  });

  app.get("/api/v1/setup/transcript/events", (context) => {
    if (context.req.method === "HEAD") {
      throw new HubHttpError(405, "INVALID_REQUEST", "Method not allowed", "Setup transcript streams require GET.");
    }
    const query = readStrictQuery(context.req.raw, ["run"]);
    const runId = parseInput(SetupTranscriptBatchSchema.shape.runId, query.run);
    const header = context.req.header("Last-Event-ID") ?? "0";
    if (!/^(0|[1-9][0-9]{0,15})$/u.test(header) || !Number.isSafeInteger(Number(header))) {
      throw invalidRequest("The setup transcript cursor is invalid.");
    }
    const after = Number(header);
    const setup = requireSetup(options.setup);
    if (!setup.readTranscript || !setup.subscribeTranscript) {
      throw unavailable("Session output is unavailable in this Hub process.");
    }
    // Validate session ownership before sending SSE headers or reserving a slot.
    setup.readTranscript(runId, after);
    const release = subscribers.reserve("setup-transcript");
    try {
      return createSetupTranscriptStream(context, setup, runId, after,
        context.get("session").expiresAt, now, release);
    } catch (error) {
      release();
      throw error;
    }
  });

  app.get("/api/v1/jobs", async (context) => {
    const jobs = requireJobs(options.jobs);
    const request = parseInput(
      JobPageRequestSchema,
      readStrictQuery(context.req.raw, ["cursor", "limit"]),
    );
    const page = await jobs.list(request);
    return resourceResponse(JobPageResponseSchema, {
      items: page.items,
      nextCursor: page.nextCursor ?? null,
    });
  });

  app.post("/api/v1/jobs", async (context) => {
    const jobs = requireJobs(options.jobs);
    const request = parseInput(
      JobStartRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    return telemetry.action("job.start", "direct", async () => {
      await options.services.assertJobStartAllowed?.(request.kind);
      return resourceResponse(HubJobSnapshotSchema, await jobs.start(request), 202);
    });
  });

  app.get("/api/v1/jobs/:id", async (context) => {
    const jobs = requireJobs(options.jobs);
    const id = parseJobId(context.req.param("id"));
    const job = await jobs.get(id);
    if (job === null) throw notFound("The requested Hub job does not exist.");
    return resourceResponse(HubJobSnapshotSchema, job);
  });

  app.post("/api/v1/jobs/:id/cancel", async (context) => {
    const jobs = requireJobs(options.jobs);
    const id = parseJobId(context.req.param("id"));
    parseInput(JobCancelRequestSchema, await readBoundedJson(context.req.raw));
    return telemetry.action("job.cancel", "direct", async () =>
      resourceResponse(HubJobSnapshotSchema, await jobs.cancel(id)));
  });

  app.get("/api/v1/jobs/:id/events", async (context) => {
    // Hono implements HEAD by dispatching the matching GET handler and then
    // discarding its body. Starting a stream in that path would reserve a
    // subscriber whose callback has no reader and therefore never settles.
    if (context.req.method === "HEAD") {
      throw new HubHttpError(
        405,
        "INVALID_REQUEST",
        "Method not allowed",
        "Hub job event streams require GET.",
      );
    }
    const jobs = requireJobs(options.jobs);
    const id = parseJobId(context.req.param("id"));
    const current = await jobs.get(id);
    if (current === null) throw notFound("The requested Hub job does not exist.");
    const release = subscribers.reserve(id);
    try {
      return createJobEventStream(
        context,
        jobs,
        id,
        context.get("session").expiresAt,
        now,
        release,
      );
    } catch (error) {
      release();
      throw error;
    }
  });

  app.all("/api/*", () => {
    throw notFound("The requested Hub API resource does not exist.");
  });

  app.get("*", (context) => serveAsset(context, options.assets));
  app.all("*", () => {
    throw notFound("The requested Hub resource does not exist.");
  });

  return app;
}

function graphInput<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof HubHttpError && error.code === "INVALID_REQUEST") {
      throw validationFailed(error.message);
    }
    throw error;
  }
}

function requireJobs(jobs: HubJobService | undefined): HubJobService {
  if (jobs === undefined) {
    throw unavailable("No executable graph or Wiki job capability is registered.");
  }
  return jobs;
}

function requireSetup(setup: HubSetupService | undefined): HubSetupService {
  if (setup === undefined) {
    throw unavailable("Setup is not available in this Hub process.");
  }
  return setup;
}

const TERMINAL_SETUP_STATUSES = new Set(["succeeded", "failed", "paused", "idle", "cancelled"]);

function createSetupEventStream(
  context: Context<HubEnvironment>,
  setup: HubSetupService,
  sessionExpiresAt: string,
  now: () => number,
  releaseSubscriber: () => void,
): Response {
  const sessionDeadline = Date.parse(sessionExpiresAt);
  return streamSSE(context, async (stream) => {
    const queue: SetupRun[] = [];
    let notify: (() => void) | null = null;
    const enqueue = (run: SetupRun) => {
      if (queue.length >= MAX_PENDING_SSE_EVENTS) queue.shift();
      queue.push(run);
      notify?.();
      notify = null;
    };
    let unsubscribe: () => void = () => undefined;
    try {
      if (now() >= sessionDeadline) return;
      unsubscribe = setup.subscribe(enqueue);
      while (!context.req.raw.signal.aborted && now() < sessionDeadline) {
        const event = queue.shift();
        if (event !== undefined) {
          if (now() >= sessionDeadline) break;
          const parsed = SetupRunSchema.safeParse(event);
          if (!parsed.success) {
            throw new Error("The Hub setup runner emitted an invalid event.");
          }
          const terminal = TERMINAL_SETUP_STATUSES.has(parsed.data.status);
          const eventData = JSON.stringify(parsed.data);
          if (Buffer.byteLength(eventData, "utf8") > HUB_LIMITS.maxJsonResponseBytes) {
            throw new Error("The Hub setup event exceeded its safe serialized size.");
          }
          await stream.writeSSE({
            event: terminal ? "terminal" : "snapshot",
            data: eventData,
          });
          if (terminal) break;
          continue;
        }

        const outcome = await waitForEventOrHeartbeat(
          context.req.raw.signal,
          sessionDeadline,
          now,
          () => new Promise<void>((resolve) => {
            notify = resolve;
            if (queue.length > 0) {
              notify();
              notify = null;
            }
          }),
        );
        if (outcome === "expired" || outcome === "aborted") break;
        if (outcome === "heartbeat") await stream.write(": heartbeat\n\n");
      }
    } finally {
      notify = null;
      unsubscribe();
      releaseSubscriber();
    }
  });
}

function parseJobId(value: string): string {
  const parsed = HubJobSnapshotSchema.shape.id.safeParse(value);
  if (!parsed.success) throw invalidRequest("The Hub job ID is invalid.");
  return parsed.data;
}

function createSetupTranscriptStream(
  context: Context<HubEnvironment>,
  setup: HubSetupService,
  runId: string,
  after: number,
  sessionExpiresAt: string,
  now: () => number,
  releaseSubscriber: () => void,
): Response {
  const deadline = Date.parse(sessionExpiresAt);
  return streamSSE(context, async (stream) => {
    let cursor = after;
    let dirty = true;
    let initial = true;
    let notify: (() => void) | null = null;
    let unsubscribe: () => void = () => undefined;
    const wake = () => {
      dirty = true;
      notify?.();
      notify = null;
    };
    stream.onAbort(wake);
    // Expiry also interrupts a blocked write when a client stops reading.
    const expiryTimer = setTimeout(() => stream.abort(), Math.max(0, deadline - now()));
    expiryTimer.unref();
    try {
      if (now() >= deadline) return;
      unsubscribe = setup.subscribeTranscript!(wake);
      while (!stream.aborted && !context.req.raw.signal.aborted && now() < deadline) {
        if (setup.snapshot().transcriptId !== runId) break;
        if (dirty) {
          dirty = false;
          const batch = SetupTranscriptBatchSchema.parse(setup.readTranscript!(runId, cursor));
          const data = JSON.stringify(batch);
          if (Buffer.byteLength(data, "utf8") > HUB_LIMITS.maxJsonResponseBytes) {
            throw new Error("The setup transcript exceeded its safe serialized size.");
          }
          if (initial || batch.entries.length > 0 || batch.done || batch.truncated) {
            if (now() >= deadline) break;
            await stream.writeSSE({ event: "transcript", id: String(batch.cursor), data });
            cursor = batch.cursor;
            initial = false;
          }
          if (batch.done) break;
          if (batch.entries.length > 0) {
            // Drain one bounded page at a time. A slow subscriber holds no
            // backlog; eviction is reported if its cursor falls behind.
            dirty = true;
            continue;
          }
        }
        const outcome = await waitForEventOrHeartbeat(context.req.raw.signal, deadline, now,
          () => new Promise<void>((resolve) => {
            notify = resolve;
            if (dirty) { notify(); notify = null; }
          }));
        if (outcome === "expired" || outcome === "aborted") break;
        if (outcome === "heartbeat") await stream.write(": heartbeat\n\n");
      }
    } finally {
      clearTimeout(expiryTimer);
      notify = null;
      unsubscribe();
      releaseSubscriber();
    }
  });
}

function createJobEventStream(
  context: Context<HubEnvironment>,
  jobs: HubJobService,
  id: string,
  sessionExpiresAt: string,
  now: () => number,
  releaseSubscriber: () => void,
): Response {
  const sessionDeadline = Date.parse(sessionExpiresAt);
  return streamSSE(context, async (stream) => {
    const queue: HubJobEvent[] = [];
    let notify: (() => void) | null = null;
    const enqueue = (event: HubJobEvent) => {
      if (queue.length >= MAX_PENDING_SSE_EVENTS) queue.shift();
      queue.push(event);
      notify?.();
      notify = null;
    };
    let unsubscribe: () => void = () => undefined;
    try {
      if (now() >= sessionDeadline) return;
      unsubscribe = jobs.subscribe(id, enqueue);
      while (!context.req.raw.signal.aborted && now() < sessionDeadline) {
        const event = queue.shift();
        if (event !== undefined) {
          if (now() >= sessionDeadline) break;
          const parsedJob = HubJobSnapshotSchema.safeParse(event.job);
          if (!parsedJob.success) {
            throw new Error("The Hub job manager emitted an invalid event.");
          }
          const terminal = event.type === "terminal"
            || TERMINAL_JOB_STATES.has(parsedJob.data.state);
          const eventType = terminal ? "terminal" : event.type;
          const eventData = JSON.stringify(parsedJob.data);
          if (Buffer.byteLength(eventData, "utf8") > HUB_LIMITS.maxJsonResponseBytes) {
            throw new Error("The Hub job event exceeded its safe serialized size.");
          }
          await stream.writeSSE({
            event: eventType,
            id: parsedJob.data.revision,
            data: eventData,
          });
          if (terminal) break;
          continue;
        }

        const outcome = await waitForEventOrHeartbeat(
          context.req.raw.signal,
          sessionDeadline,
          now,
          () => new Promise<void>((resolve) => {
            notify = resolve;
            if (queue.length > 0) {
              notify();
              notify = null;
            }
          }),
        );
        if (outcome === "expired" || outcome === "aborted") break;
        if (outcome === "heartbeat") await stream.write(": heartbeat\n\n");
      }
    } finally {
      notify = null;
      unsubscribe();
      releaseSubscriber();
    }
  });
}

class SseSubscriberTracker {
  #total = 0;
  readonly #byJob = new Map<string, number>();

  reserve(jobId: string): () => void {
    const forJob = this.#byJob.get(jobId) ?? 0;
    if (
      forJob >= MAX_SSE_SUBSCRIBERS_PER_JOB
      || this.#total >= MAX_SSE_SUBSCRIBERS_PER_PROCESS
    ) {
      throw new HubHttpError(
        429,
        "RATE_LIMITED",
        "Too many event streams",
        "The local Hub event-stream subscriber limit has been reached.",
      );
    }
    this.#byJob.set(jobId, forJob + 1);
    this.#total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#byJob.get(jobId) ?? 1;
      if (current <= 1) this.#byJob.delete(jobId);
      else this.#byJob.set(jobId, current - 1);
      this.#total = Math.max(0, this.#total - 1);
    };
  }
}

function readSpecListQuery(request: Request): Record<string, unknown> {
  const query = readStrictQuery(request, [
    "includeArchived",
    "cursor",
    "limit",
    "lifecycleStates",
    "groundingHealth",
    "topics",
  ]);
  return {
    ...(query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.lifecycleStates === undefined
      ? {}
      : { lifecycleStates: query.lifecycleStates.split(",") }),
    ...(query.groundingHealth === undefined
      ? {}
      : { groundingHealth: query.groundingHealth.split(",") }),
    ...(query.topics === undefined ? {} : { topics: query.topics.split(",") }),
  };
}

function readInboxProposalListQuery(request: Request): Record<string, unknown> {
  const query = readStrictQuery(request, ["state", "cursor", "limit"]);
  const states = query.state === undefined ? undefined : query.state.split(",");
  if (states !== undefined) {
    for (const state of states) parseInput(InboxProposalStateSchema, state);
  }
  return {
    ...(states === undefined ? {} : { states }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

function readRelayListQuery(request: Request): Record<string, unknown> {
  const query = readStrictQuery(request, ["perspective", "state", "workstreamId", "cursor", "limit"]);
  const states = query.state === undefined ? undefined : query.state.split(",");
  if (states !== undefined) {
    for (const state of states) parseInput(RelayStateSchema, state);
  }
  return {
    ...(query.perspective === undefined ? {} : { perspective: query.perspective }),
    ...(states === undefined ? {} : { states }),
    ...(query.workstreamId === undefined ? {} : { workstreamId: query.workstreamId }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

async function waitForEventOrHeartbeat(
  signal: AbortSignal,
  sessionDeadline: number,
  now: () => number,
  event: () => Promise<void>,
): Promise<"event" | "heartbeat" | "aborted" | "expired"> {
  const remainingSessionMs = sessionDeadline - now();
  if (remainingSessionMs <= 0) return "expired";
  const timeoutMs = Math.min(SSE_HEARTBEAT_MS, remainingSessionMs);
  const timeoutOutcome = remainingSessionMs <= SSE_HEARTBEAT_MS
    ? "expired" as const
    : "heartbeat" as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const result = await Promise.race([
    event().then(() => "event" as const),
    new Promise<"heartbeat" | "expired">((resolve) => {
      timer = setTimeout(() => resolve(timeoutOutcome), timeoutMs);
      timer.unref?.();
    }),
    new Promise<"aborted">((resolve) => {
      abort = () => resolve("aborted");
      signal.addEventListener("abort", abort, { once: true });
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (abort !== undefined) signal.removeEventListener("abort", abort);
  return result;
}

function serveAsset(context: Context, assets: HubAssetManifest | undefined): Response {
  if (assets === undefined) {
    throw unavailable("The built Project Hub frontend assets are unavailable.");
  }
  const path = validateHubRequestPath(context.req.raw.url);
  const requestedAsset = path === "/" ? "/index.html" : path;
  const fallbackToShell = !assets.has(requestedAsset)
    && context.req.header("accept")?.includes("text/html") === true
    && !requestedAsset.slice(requestedAsset.lastIndexOf("/") + 1).includes(".");
  const asset = assets.read(fallbackToShell ? "/index.html" : requestedAsset);
  return new Response(asset.bytes as BodyInit, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": asset.cacheControl,
    },
  });
}

function applySecurityHeaders(response: Response, requestId: string, apiResponse: boolean): void {
  response.headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self' https://api.web3forms.com; font-src 'self'; "
      + "form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; "
      + "object-src 'none'; script-src 'self'; style-src 'self'",
  );
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set(
    "permissions-policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("x-request-id", requestId);
  if (apiResponse || response.headers.get("content-type")?.includes("application/") === true) {
    response.headers.set("cache-control", "no-store");
  }
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}
