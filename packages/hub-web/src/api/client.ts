import {
  AgentLoggingPolicySchema,
  HubOnboardingStateSchema,
  ActivityResponseSchema,
  BootstrapResponseSchema,
  CodeKnowledgeResponseSchema,
  CodeWorkspaceResponseSchema,
  GraphSymbolIdSchema,
  HealthResponseSchema,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HubJobSnapshotSchema,
  HubProblemDetailsSchema,
  InboxDraftDetailSchema,
  InboxDraftIdSchema,
  InboxDraftListResponseSchema,
  InboxOperationApplyResponseSchema,
  InboxOperationPreviewResponseSchema,
  InboxProposalDetailSchema,
  InboxProposalIdSchema,
  InboxProposalListResponseSchema,
  JobPageResponseSchema,
  SearchResponseSchema,
  SessionResponseSchema,
  SpecDetailResponseSchema,
  SpecListResponseSchema,
  TeamCurrentActorResponseSchema,
  TeamMemberIdSchema,
  TeamMemberListResponseSchema,
  TeamMemberSchema,
  TeamOperationApplyResponseSchema,
  TeamOperationPreviewResponseSchema,
  TeamWorkstreamIdSchema,
  TeamWorkstreamListResponseSchema,
  TeamWorkstreamSchema,
  WikiGraphResponseSchema,
  WikiGroundedCodeResponseSchema,
  WikiBacklinksResponseSchema,
  WikiEntityDetailResponseSchema,
  WikiEntityIdSchema,
  WikiEntityListResponseSchema,
  WikiRelationsResponseSchema,
} from "@mex/hub-contracts";
import { createFixtureApi } from "virtual:mex-hub-fixture-api";
import type {
  ContactPreference,
  ContactPreferenceRequest,
  SetupContactRequest,
  SetupContactResponse,
  SetupInstallation,
  SetupRun,
  SetupStartRequest,
  SetupStatus,
  SetupTranscriptBatch,
  SetupCommitPreview,
  SetupCommitDiff,
  SetupCommitDiffRequest,
  SetupCommitRequest,
  SetupCommitResponse,
} from "@mex/hub-contracts/setup";
import type {
  AgentLoggingPolicy,
  AgentLoggingUpdateRequest,
  HubOnboardingState,
  ActivityRequest,
  ActivityResponse,
  BootstrapResponse,
  CapabilitiesResponse,
  CodeKnowledgeRequest,
  CodeKnowledgeResponse,
  CodeWorkspaceRequest,
  CodeWorkspaceResponse,
  HealthResponse,
  HomeResponse,
  InboxDraftDetail,
  InboxDraftListRequest,
  InboxDraftListResponse,
  InboxOperationApplyRequest,
  InboxOperationApplyResponse,
  InboxOperationPreviewRequest,
  InboxOperationPreviewResponse,
  InboxProposalDetail,
  InboxProposalListRequest,
  InboxProposalListResponse,
  RelayDetail,
  RelayDraftDetail,
  RelayDraftListRequest,
  RelayDraftListResponse,
  RelayListRequest,
  RelayListResponse,
  RelayOperationApplyRequest,
  RelayOperationApplyResponse,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
  JobsResponse,
  JobSummary,
  OverviewResponse,
  ProblemDetails,
  SearchRequest,
  SearchResponse,
  SessionResponse,
  SpecDetailResponse,
  SpecListRequest,
  SpecListResponse,
  StartJobRequest,
  TeamCurrentActorResponse,
  TeamMember,
  TeamMemberListRequest,
  TeamMemberListResponse,
  TeamOperationApplyRequest,
  TeamOperationApplyResponse,
  TeamOperationPreviewRequest,
  TeamOperationPreviewResponse,
  TeamWorkstream,
  TeamWorkstreamListRequest,
  TeamWorkstreamListResponse,
  WikiGraphResponse,
  WikiGroundedCodeResponse,
  WikiBacklinksRequest,
  WikiBacklinksResponse,
  WikiEntityDetailResponse,
  WikiEntityListRequest,
  WikiEntityListResponse,
  WikiRelationsRequest,
  WikiRelationsResponse,
} from "./types";
import type { RelayTransport } from "./relay-client";
import { isHubTelemetryPage, type HubTelemetryPage } from "./telemetry";

const API_ROOT = "/api/v1";

interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class HubApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail);
    this.name = "HubApiError";
    this.problem = problem;
  }
}

export function isSetupCapabilityUnavailable(error: unknown): boolean {
  return error instanceof HubApiError
    && (error.problem.code === "CAPABILITY_UNAVAILABLE" || error.problem.code === "NOT_FOUND");
}

export interface JobSubscription {
  close(): void;
}

export type InboxFixtureVariant = "empty" | "unknown" | "partial";
export type RelayFixtureVariant = "empty" | "closed" | "missing" | "partial" | "legacy";
export type ActivityFixtureVariant = "empty" | "legacy" | "partial";
export type MemberFixtureVariant =
  | "configured"
  | "git-alias"
  | "git-fallback"
  | "unknown"
  | "stale"
  | "inactive"
  | "ambiguous"
  | "partial";
export type OverviewFixtureVariant =
  | "established"
  | "caught-up"
  | "pending-review"
  | "relay-ready"
  | "relay-in-hand"
  | "identity-unresolved"
  | "indexes-stale"
  | "indexes-degraded"
  | "indexes-missing"
  | "job-determinate"
  | "job-indeterminate"
  | "failure"
  | "partial"
  | "unavailable";

export interface FixtureApiOptions {
  inboxFixture?: InboxFixtureVariant;
  relayFixture?: RelayFixtureVariant;
  activityFixture?: ActivityFixtureVariant;
  memberFixture?: MemberFixtureVariant;
  overviewFixture?: OverviewFixtureVariant;
  onboardingFixture?: "completed" | "first-run";
}

export interface HubApi {
  getContactPreference?(): Promise<ContactPreference>;
  rememberContactPreference?(request: ContactPreferenceRequest): Promise<ContactPreference>;
  submitSetupContact?(request: SetupContactRequest): Promise<SetupContactResponse>;
  getSetupInstallation?(): Promise<SetupInstallation>;
  installSetupGlobally?(): Promise<SetupInstallation>;
  recordPageView?(page: HubTelemetryPage): Promise<void>;
  getLoggingPolicy(): Promise<AgentLoggingPolicy>;
  setLoggingPolicy(request: AgentLoggingUpdateRequest): Promise<AgentLoggingPolicy>;
  getOnboardingState(): Promise<HubOnboardingState>;
  completeOnboarding(): Promise<HubOnboardingState>;
  bootstrap(token: string): Promise<BootstrapResponse>;
  getSession(): Promise<SessionResponse>;
  getCapabilities(): Promise<CapabilitiesResponse>;
  getHome(): Promise<HomeResponse>;
  getOverview(): Promise<OverviewResponse>;
  getMembers(request: TeamMemberListRequest): Promise<TeamMemberListResponse>;
  getMember(id: string): Promise<TeamMember>;
  getCurrentActor(): Promise<TeamCurrentActorResponse>;
  getWorkstreams(request: TeamWorkstreamListRequest): Promise<TeamWorkstreamListResponse>;
  getWorkstream(id: string): Promise<TeamWorkstream>;
  getInboxDrafts(request: InboxDraftListRequest): Promise<InboxDraftListResponse>;
  getInboxDraft(id: string): Promise<InboxDraftDetail>;
  getInboxProposals(request: InboxProposalListRequest): Promise<InboxProposalListResponse>;
  getInboxProposal(id: string): Promise<InboxProposalDetail>;
  previewInboxOperation(request: InboxOperationPreviewRequest): Promise<InboxOperationPreviewResponse>;
  applyInboxOperation(request: InboxOperationApplyRequest): Promise<InboxOperationApplyResponse>;
  getRelayDrafts(request: RelayDraftListRequest): Promise<RelayDraftListResponse>;
  getRelayDraft(id: string): Promise<RelayDraftDetail>;
  getRelays(request: RelayListRequest): Promise<RelayListResponse>;
  getRelay(id: string): Promise<RelayDetail>;
  previewRelayOperation(request: RelayOperationPreviewRequest): Promise<RelayOperationPreviewResponse>;
  applyRelayOperation(request: RelayOperationApplyRequest): Promise<RelayOperationApplyResponse>;
  listSpecs(request: SpecListRequest): Promise<SpecListResponse>;
  getSpec(id: string): Promise<SpecDetailResponse>;
  previewTeamOperation(request: TeamOperationPreviewRequest): Promise<TeamOperationPreviewResponse>;
  applyTeamOperation(request: TeamOperationApplyRequest): Promise<TeamOperationApplyResponse>;
  getActivity(request: ActivityRequest): Promise<ActivityResponse>;
  search(request: SearchRequest): Promise<SearchResponse>;
  getCodeSymbol(id: string, request: CodeWorkspaceRequest): Promise<CodeWorkspaceResponse>;
  wikiGraph(): Promise<WikiGraphResponse>;
  getWikiGroundedCode(id: string): Promise<WikiGroundedCodeResponse>;
  listWikiEntities(request: WikiEntityListRequest): Promise<WikiEntityListResponse>;
  getWikiEntity(id: string): Promise<WikiEntityDetailResponse>;
  getWikiRelations(id: string, request: WikiRelationsRequest): Promise<WikiRelationsResponse>;
  getWikiBacklinks(id: string, request: WikiBacklinksRequest): Promise<WikiBacklinksResponse>;
  getCodeKnowledge(id: string, request: CodeKnowledgeRequest): Promise<CodeKnowledgeResponse>;
  getHealth(): Promise<HealthResponse>;
  getJobs(cursor?: string): Promise<JobsResponse>;
  getJob(id: string): Promise<JobSummary>;
  startJob(request: StartJobRequest): Promise<JobSummary>;
  cancelJob(id: string): Promise<JobSummary>;
  subscribeToJob(id: string, onSnapshot: (job: JobSummary) => void): JobSubscription;
  getSetupStatus?(): Promise<SetupStatus>;
  getSetupRun?(): Promise<SetupRun>;
  startSetup?(request: SetupStartRequest): Promise<SetupRun>;
  cancelSetup?(): Promise<SetupRun>;
  subscribeToSetup?(onSnapshot: (run: SetupRun) => void, onDisconnect?: () => void): JobSubscription;
  subscribeToSetupTranscript?(runId: string, onBatch: (batch: SetupTranscriptBatch) => void, onDisconnect?: () => void): JobSubscription;
  previewSetupCommit?(): Promise<SetupCommitPreview>;
  setupCommitDiff?(request: SetupCommitDiffRequest): Promise<SetupCommitDiff>;
  commitSetup?(request: SetupCommitRequest): Promise<SetupCommitResponse>;
}

function fallbackProblem(status: number, detail?: string): ProblemDetails {
  return {
    type: "about:blank",
    title: status === 401 ? "Hub session required" : "Hub request failed",
    status: status >= 400 && status <= 599 ? status : 500,
    code: status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR",
    detail: detail ?? (status === 401
      ? "Open a fresh Hub link from the local CLI."
      : "The response did not match the local Hub contract."),
    requestId: crypto.randomUUID(),
  };
}

async function readJsonBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  try {
    return contentType.includes("json") ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

function throwIfHttpProblem(response: Response, body: unknown): void {
  if (response.ok) return;
  const problem = HubProblemDetailsSchema.safeParse(body);
  throw new HubApiError(problem.success ? problem.data : fallbackProblem(response.status));
}

async function parseBody<T>(response: Response, schema: Parser<T>): Promise<T> {
  const body = await readJsonBody(response);
  throwIfHttpProblem(response, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(500));
  }
  return parsed.data;
}

function assertSafeIdentifier(value: string): string {
  const parsed = HubJobSnapshotSchema.shape.id.safeParse(value);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(400, "The job identifier is invalid."));
  }
  return parsed.data;
}

function assertSafeSymbolId(value: string): string {
  const parsed = GraphSymbolIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(400, "The graph symbol identifier is invalid."));
  }
  return parsed.data;
}

function assertSafeWikiEntityId(value: string): string {
  const parsed = WikiEntityIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(400, "The Wiki entity identifier is invalid."));
  }
  return parsed.data;
}

function assertSafeTeamMemberId(value: string): string {
  const parsed = TeamMemberIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(400, "The member identifier is invalid."));
  }
  return parsed.data;
}

function assertSafeTeamWorkstreamId(value: string): string {
  const parsed = TeamWorkstreamIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(400, "The Workstream identifier is invalid."));
  }
  return parsed.data;
}

function assertSafeInboxDraftId(value: string): string {
  const parsed = InboxDraftIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(400, "The Inbox draft identifier is invalid."));
  }
  return parsed.data;
}

function assertSafeInboxProposalId(value: string): string {
  const parsed = InboxProposalIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(400, "The Inbox proposal identifier is invalid."));
  }
  return parsed.data;
}

const loadRelayClient = () => import("./relay-client");
const loadOverviewContract = () => import("@mex/hub-contracts/overview");
const loadSetupContract = () => import("@mex/hub-contracts/setup");

export function readBootstrapToken(hash = window.location.hash): string | null {
  if (!hash || hash === "#") return null;
  const fragment = hash.slice(1);
  const params = new URLSearchParams(fragment);
  const named = params.get("token") ?? params.get("bootstrap");
  if (named) return named;
  return fragment.includes("=") ? null : decodeURIComponent(fragment);
}

export function clearBootstrapFragment(): void {
  const clean = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", clean);
}

export class HttpHubApi implements HubApi {
  #csrfToken: string | null = null;
  #pageViewPending = false;

  async recordPageView(page: HubTelemetryPage): Promise<void> {
    if (!this.#csrfToken || this.#pageViewPending || !isHubTelemetryPage(page)) return;
    this.#pageViewPending = true;
    try {
      await fetch(`${API_ROOT}/telemetry/page`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-MEX-CSRF": this.#csrfToken },
        body: JSON.stringify({ page }),
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(2_000),
      });
    } catch { /* A dropped local usage event must never disturb navigation. */ }
    finally { this.#pageViewPending = false; }
  }
  #relayTransport: RelayTransport = {
    request: (path, schema, init, mutation) => this.#request(path, schema, init, mutation),
    invalidIdentifier: (detail) => {
      throw new HubApiError(fallbackProblem(400, detail));
    },
  };
  async #send(path: string, init: RequestInit = {}, mutation = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json, application/problem+json");
    if (mutation) {
      headers.set("Content-Type", "application/json");
      if (this.#csrfToken) headers.set("X-MEX-CSRF", this.#csrfToken);
    }
    return fetch(`${API_ROOT}${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
      redirect: "error",
    });
  }

  async #request<T>(
    path: string,
    schema: Parser<T>,
    init: RequestInit = {},
    mutation = false,
  ): Promise<T> {
    return parseBody(await this.#send(path, init, mutation), schema);
  }

  async #requestWhenOk<T>(
    path: string,
    loadSchema: () => Promise<Parser<T>>,
    init: RequestInit = {},
    mutation = false,
  ): Promise<T> {
    const response = await this.#send(path, init, mutation);
    const body = await readJsonBody(response);
    throwIfHttpProblem(response, body);
    const schema = await loadSchema();
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new HubApiError(fallbackProblem(500));
    return parsed.data;
  }

  bootstrap(token: string): Promise<BootstrapResponse> {
    return this.#request(
      "/session/bootstrap",
      BootstrapResponseSchema,
      { method: "POST", body: JSON.stringify({ token }) },
      true,
    );
  }

  async getSession(): Promise<SessionResponse> {
    const session = await this.#request("/session", SessionResponseSchema);
    this.#csrfToken = session.csrfToken;
    return session;
  }

  getCapabilities(): Promise<CapabilitiesResponse> {
    return this.#request("/capabilities", HubCapabilitiesSchema);
  }

  getHome(): Promise<HomeResponse> {
    return this.#request("/home", HomeResponseSchema);
  }

  async getOverview(): Promise<OverviewResponse> {
    const { OverviewResponseSchema } = await loadOverviewContract();
    return this.#request("/overview", OverviewResponseSchema);
  }

  getMembers(request: TeamMemberListRequest): Promise<TeamMemberListResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.active !== undefined) params.set("active", String(request.active));
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(`/members?${params}`, TeamMemberListResponseSchema);
  }

  async getMember(id: string): Promise<TeamMember> {
    return await this.#request(
      `/members/${encodeURIComponent(assertSafeTeamMemberId(id))}`,
      TeamMemberSchema,
    );
  }

  getCurrentActor(): Promise<TeamCurrentActorResponse> {
    return this.#request("/actor/current", TeamCurrentActorResponseSchema);
  }

  getWorkstreams(request: TeamWorkstreamListRequest): Promise<TeamWorkstreamListResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.state) params.set("state", request.state);
    if (request.includeArchived !== undefined) {
      params.set("includeArchived", String(request.includeArchived));
    }
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(`/workstreams?${params}`, TeamWorkstreamListResponseSchema);
  }

  async getWorkstream(id: string): Promise<TeamWorkstream> {
    return await this.#request(
      `/workstreams/${encodeURIComponent(assertSafeTeamWorkstreamId(id))}`,
      TeamWorkstreamSchema,
    );
  }

  getInboxDrafts(request: InboxDraftListRequest): Promise<InboxDraftListResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(`/inbox/drafts?${params}`, InboxDraftListResponseSchema);
  }

  async getInboxDraft(id: string): Promise<InboxDraftDetail> {
    return await this.#request(
      `/inbox/drafts/${encodeURIComponent(assertSafeInboxDraftId(id))}`,
      InboxDraftDetailSchema,
    );
  }

  getInboxProposals(request: InboxProposalListRequest): Promise<InboxProposalListResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.states?.length) params.set("state", request.states.join(","));
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(`/inbox/proposals?${params}`, InboxProposalListResponseSchema);
  }

  async getInboxProposal(id: string): Promise<InboxProposalDetail> {
    return await this.#request(
      `/inbox/proposals/${encodeURIComponent(assertSafeInboxProposalId(id))}`,
      InboxProposalDetailSchema,
    );
  }

  previewInboxOperation(
    request: InboxOperationPreviewRequest,
  ): Promise<InboxOperationPreviewResponse> {
    return this.#request(
      "/inbox/operations/preview",
      InboxOperationPreviewResponseSchema,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }

  applyInboxOperation(
    request: InboxOperationApplyRequest,
  ): Promise<InboxOperationApplyResponse> {
    return this.#request(
      "/inbox/operations/apply",
      InboxOperationApplyResponseSchema,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }

  async getRelayDrafts(request: RelayDraftListRequest): Promise<RelayDraftListResponse> {
    return await (await loadRelayClient()).getRelayDrafts(this.#relayTransport, request);
  }

  async getRelayDraft(id: string): Promise<RelayDraftDetail> {
    return await (await loadRelayClient()).getRelayDraft(this.#relayTransport, id);
  }

  async getRelays(request: RelayListRequest): Promise<RelayListResponse> {
    return await (await loadRelayClient()).getRelays(this.#relayTransport, request);
  }

  async getRelay(id: string): Promise<RelayDetail> {
    return await (await loadRelayClient()).getRelay(this.#relayTransport, id);
  }

  async previewRelayOperation(
    request: RelayOperationPreviewRequest,
  ): Promise<RelayOperationPreviewResponse> {
    return await (await loadRelayClient()).previewRelayOperation(this.#relayTransport, request);
  }

  async applyRelayOperation(
    request: RelayOperationApplyRequest,
  ): Promise<RelayOperationApplyResponse> {
    return await (await loadRelayClient()).applyRelayOperation(this.#relayTransport, request);
  }

  listSpecs(request: SpecListRequest): Promise<SpecListResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.includeArchived !== undefined) {
      params.set("includeArchived", String(request.includeArchived));
    }
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    if (request.lifecycleStates?.length) {
      params.set("lifecycleStates", request.lifecycleStates.join(","));
    }
    if (request.groundingHealth?.length) {
      params.set("groundingHealth", request.groundingHealth.join(","));
    }
    if (request.topics?.length) params.set("topics", request.topics.join(","));
    return this.#request(`/specs?${params}`, SpecListResponseSchema);
  }

  async getSpec(id: string): Promise<SpecDetailResponse> {
    return await this.#request(
      `/specs/${encodeURIComponent(assertSafeWikiEntityId(id))}`,
      SpecDetailResponseSchema,
    );
  }

  previewTeamOperation(
    request: TeamOperationPreviewRequest,
  ): Promise<TeamOperationPreviewResponse> {
    return this.#request(
      "/team/operations/preview",
      TeamOperationPreviewResponseSchema,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }

  applyTeamOperation(
    request: TeamOperationApplyRequest,
  ): Promise<TeamOperationApplyResponse> {
    return this.#request(
      "/team/operations/apply",
      TeamOperationApplyResponseSchema,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }

  getActivity(request: ActivityRequest): Promise<ActivityResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.source) params.set("source", request.source);
    if (request.since) params.set("since", request.since);
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(`/activity?${params}`, ActivityResponseSchema);
  }

  search(request: SearchRequest): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: request.q.slice(0, 256), limit: String(request.limit) });
    if (request.wikiCursor) params.set("wikiCursor", request.wikiCursor.slice(0, 4_096));
    if (request.symbolCursor) params.set("symbolCursor", request.symbolCursor.slice(0, 4_096));
    if (request.sourceCursor) params.set("sourceCursor", request.sourceCursor.slice(0, 4_096));
    return this.#request(`/search?${params}`, SearchResponseSchema);
  }

  async getCodeSymbol(id: string, request: CodeWorkspaceRequest): Promise<CodeWorkspaceResponse> {
    const params = new URLSearchParams({ view: request.view });
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    if (request.limit !== undefined) params.set("limit", String(request.limit));
    if (request.depth !== undefined) params.set("depth", String(request.depth));
    if (request.sourceCursor) params.set("sourceCursor", request.sourceCursor.slice(0, 4_096));
    return await this.#request(
      `/code/symbols/${encodeURIComponent(assertSafeSymbolId(id))}?${params}`,
      CodeWorkspaceResponseSchema,
    );
  }

  wikiGraph(): Promise<WikiGraphResponse> {
    return this.#request("/wiki/graph", WikiGraphResponseSchema);
  }

  getWikiGroundedCode(id: string): Promise<WikiGroundedCodeResponse> {
    return this.#request(`/wiki/entities/${encodeURIComponent(assertSafeWikiEntityId(id))}/code`, WikiGroundedCodeResponseSchema);
  }

  listWikiEntities(request: WikiEntityListRequest): Promise<WikiEntityListResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.kind) params.set("kind", request.kind);
    if (request.topic) params.set("topic", request.topic);
    if (request.lifecycle) params.set("lifecycle", request.lifecycle);
    if (request.grounding) params.set("grounding", request.grounding);
    if (request.sourceType) params.set("sourceType", request.sourceType);
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(`/wiki/entities?${params}`, WikiEntityListResponseSchema);
  }

  async getWikiEntity(id: string): Promise<WikiEntityDetailResponse> {
    return await this.#request(
      `/wiki/entities/${encodeURIComponent(assertSafeWikiEntityId(id))}`,
      WikiEntityDetailResponseSchema,
    );
  }

  getWikiRelations(id: string, request: WikiRelationsRequest): Promise<WikiRelationsResponse> {
    const params = new URLSearchParams({ direction: request.direction, limit: String(request.limit) });
    if (request.type) params.set("type", request.type);
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(
      `/wiki/entities/${encodeURIComponent(assertSafeWikiEntityId(id))}/relations?${params}`,
      WikiRelationsResponseSchema,
    );
  }

  getWikiBacklinks(id: string, request: WikiBacklinksRequest): Promise<WikiBacklinksResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.type) params.set("type", request.type);
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(
      `/wiki/entities/${encodeURIComponent(assertSafeWikiEntityId(id))}/backlinks?${params}`,
      WikiBacklinksResponseSchema,
    );
  }

  getCodeKnowledge(id: string, request: CodeKnowledgeRequest): Promise<CodeKnowledgeResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(
      `/code/symbols/${encodeURIComponent(assertSafeSymbolId(id))}/knowledge?${params}`,
      CodeKnowledgeResponseSchema,
    );
  }

  getHealth(): Promise<HealthResponse> {
    return this.#request("/health", HealthResponseSchema);
  }

  getLoggingPolicy(): Promise<AgentLoggingPolicy> {
    return this.#request("/settings/logging", AgentLoggingPolicySchema);
  }

  setLoggingPolicy(request: AgentLoggingUpdateRequest): Promise<AgentLoggingPolicy> {
    return this.#request("/settings/logging", AgentLoggingPolicySchema,
      { method: "POST", body: JSON.stringify(request) }, true);
  }

  getOnboardingState(): Promise<HubOnboardingState> {
    return this.#request("/settings/onboarding", HubOnboardingStateSchema);
  }

  completeOnboarding(): Promise<HubOnboardingState> {
    return this.#request("/settings/onboarding", HubOnboardingStateSchema,
      { method: "POST", body: JSON.stringify({ completed: true }) }, true);
  }

  getJobs(cursor?: string): Promise<JobsResponse> {
    const params = new URLSearchParams({ limit: "25" });
    if (cursor) params.set("cursor", cursor.slice(0, 4096));
    return this.#request(`/jobs?${params}`, JobPageResponseSchema);
  }

  async getJob(id: string): Promise<JobSummary> {
    return await this.#request(
      `/jobs/${encodeURIComponent(assertSafeIdentifier(id))}`,
      HubJobSnapshotSchema,
    );
  }

  startJob(request: StartJobRequest): Promise<JobSummary> {
    return this.#request(
      "/jobs",
      HubJobSnapshotSchema,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }

  async cancelJob(id: string): Promise<JobSummary> {
    return await this.#request(
      `/jobs/${encodeURIComponent(assertSafeIdentifier(id))}/cancel`,
      HubJobSnapshotSchema,
      { method: "POST", body: "{}" },
      true,
    );
  }

  subscribeToJob(id: string, onSnapshot: (job: JobSummary) => void): JobSubscription {
    const source = new EventSource(
      `${API_ROOT}/jobs/${encodeURIComponent(assertSafeIdentifier(id))}/events`,
      { withCredentials: true },
    );
    const receive = (event: MessageEvent<string>) => {
      try {
        const parsed = HubJobSnapshotSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) {
          onSnapshot(parsed.data);
          if (
            event.type === "terminal"
            || parsed.data.state === "succeeded"
            || parsed.data.state === "failed"
            || parsed.data.state === "interrupted"
          ) {
            source.close();
          }
        }
      } catch {
        // A malformed event cannot poison the current persisted snapshot.
      }
    };
    source.addEventListener("snapshot", receive as EventListener);
    source.addEventListener("progress", receive as EventListener);
    source.addEventListener("terminal", receive as EventListener);
    source.onmessage = receive;
    return { close: () => source.close() };
  }

  getSetupStatus(): Promise<SetupStatus> {
    return this.#requestWhenOk("/setup", async () => (await loadSetupContract()).SetupStatusSchema);
  }

  getContactPreference(): Promise<ContactPreference> {
    return this.#requestWhenOk("/contact", async () => (await loadSetupContract()).ContactPreferenceSchema);
  }

  rememberContactPreference(request: ContactPreferenceRequest): Promise<ContactPreference> {
    return this.#requestWhenOk("/contact/preference", async () => (await loadSetupContract()).ContactPreferenceSchema,
      { method: "POST", body: JSON.stringify(request) }, true);
  }

  submitSetupContact(request: SetupContactRequest): Promise<SetupContactResponse> {
    return this.#requestWhenOk("/contact", async () => (await loadSetupContract()).SetupContactResponseSchema,
      { method: "POST", body: JSON.stringify(request) }, true);
  }

  getSetupInstallation(): Promise<SetupInstallation> {
    return this.#requestWhenOk("/setup/installation", async () => (await loadSetupContract()).SetupInstallationSchema);
  }

  installSetupGlobally(): Promise<SetupInstallation> {
    return this.#requestWhenOk("/setup/installation", async () => (await loadSetupContract()).SetupInstallationSchema,
      { method: "POST", body: "{}" }, true);
  }

  getSetupRun(): Promise<SetupRun> {
    return this.#requestWhenOk("/setup/run", async () => (await loadSetupContract()).SetupRunSchema);
  }

  startSetup(request: SetupStartRequest): Promise<SetupRun> {
    return this.#requestWhenOk(
      "/setup",
      async () => (await loadSetupContract()).SetupRunSchema,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }

  cancelSetup(): Promise<SetupRun> {
    return this.#requestWhenOk(
      "/setup/cancel",
      async () => (await loadSetupContract()).SetupRunSchema,
      { method: "POST", body: "{}" },
      true,
    );
  }

  previewSetupCommit(): Promise<SetupCommitPreview> {
    return this.#requestWhenOk(
      "/setup/commit/preview",
      async () => (await loadSetupContract()).SetupCommitPreviewSchema,
      { method: "POST", body: "{}" },
      true,
    );
  }

  setupCommitDiff(request: SetupCommitDiffRequest): Promise<SetupCommitDiff> {
    return this.#requestWhenOk(
      "/setup/commit/diff",
      async () => (await loadSetupContract()).SetupCommitDiffSchema,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }

  commitSetup(request: SetupCommitRequest): Promise<SetupCommitResponse> {
    return this.#requestWhenOk(
      "/setup/commit",
      async () => (await loadSetupContract()).SetupCommitResponseSchema,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }

  subscribeToSetup(onSnapshot: (run: SetupRun) => void, onDisconnect?: () => void): JobSubscription {
    const source = new EventSource(`${API_ROOT}/setup/events`, { withCredentials: true });
    const contract = loadSetupContract();
    let closed = false;
    const receive = (event: MessageEvent<string>) => {
      void contract.then(({ SetupRunSchema }) => {
        if (closed) return;
        try {
          const parsed = SetupRunSchema.safeParse(JSON.parse(event.data));
          if (parsed.success) {
            onSnapshot(parsed.data);
            if (
              event.type === "terminal"
              || parsed.data.status === "succeeded"
              || parsed.data.status === "failed"
              || parsed.data.status === "cancelled"
              || parsed.data.status === "paused"
              || parsed.data.status === "idle"
            ) {
              closed = true;
              source.close();
            }
          }
        } catch {
          // A malformed event cannot poison the current setup snapshot.
        }
      });
    };
    source.addEventListener("snapshot", receive as EventListener);
    source.addEventListener("terminal", receive as EventListener);
    source.onmessage = receive;
    source.onerror = () => {
      // Promotion can remove the endpoint before the first SSE connection.
      // The view coalesces refreshes; retry errors must also recover a promotion
      // that happened after an earlier refresh still reported a running job.
      if (closed) return;
      onDisconnect?.();
    };
    return { close: () => { closed = true; source.close(); } };
  }

  subscribeToSetupTranscript(runId: string, onBatch: (batch: SetupTranscriptBatch) => void, onDisconnect?: () => void): JobSubscription {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(runId)) {
      throw new Error("Invalid setup session identifier.");
    }
    let closed = false;
    let cursor = 0;
    let source: EventSource | undefined;
    // Open only once the lazy validator is ready; no event queue can grow while
    // that module loads. Native reconnects retain this EventSource's event ID.
    void loadSetupContract().then(({ SetupTranscriptBatchSchema }) => {
      if (closed) return;
      source = new EventSource(`${API_ROOT}/setup/transcript/events?run=${encodeURIComponent(runId)}`, { withCredentials: true });
      source.addEventListener("transcript", ((event: MessageEvent<string>) => {
        if (closed || typeof event.data !== "string" || event.data.length > 1_048_576) return;
        try {
          const parsed = SetupTranscriptBatchSchema.safeParse(JSON.parse(event.data));
          if (!parsed.success || parsed.data.runId !== runId || parsed.data.cursor < cursor) return;
          const batch = parsed.data;
          if (batch.entries.some((entry, index) => entry.id > batch.cursor || (index > 0 && entry.id <= batch.entries[index - 1]!.id))) return;
          const entries = batch.entries.filter((entry) => entry.id > cursor);
          cursor = batch.cursor;
          onBatch({ ...batch, entries });
          if (batch.done) { closed = true; source?.close(); }
        } catch {
          // Malformed transcript data cannot replace the retained session.
        }
      }) as EventListener);
      source.onerror = () => { if (!closed) onDisconnect?.(); };
    }).catch(() => { if (!closed) onDisconnect?.(); });
    return { close: () => { if (!closed) source?.close(); closed = true; } };
  }
}

export function fixturesEnabled(isDevelopment: boolean, search: string): boolean {
  return isDevelopment && new URLSearchParams(search).get("fixture") === "populated";
}

export function inboxFixtureVariant(search: string): InboxFixtureVariant | undefined {
  const value = new URLSearchParams(search).get("inboxFixture");
  return value === "empty" || value === "unknown" || value === "partial"
    ? value
    : undefined;
}

export function relayFixtureVariant(search: string): RelayFixtureVariant | undefined {
  const value = new URLSearchParams(search).get("relayFixture");
  return value === "empty"
    || value === "closed"
    || value === "missing"
    || value === "partial"
    || value === "legacy"
    ? value
    : undefined;
}

export function activityFixtureVariant(search: string): ActivityFixtureVariant | undefined {
  const value = new URLSearchParams(search).get("activityFixture");
  return value === "empty" || value === "legacy" || value === "partial"
    ? value
    : undefined;
}

export function memberFixtureVariant(search: string): MemberFixtureVariant | undefined {
  const value = new URLSearchParams(search).get("memberFixture");
  return value === "configured"
    || value === "git-alias"
    || value === "git-fallback"
    || value === "unknown"
    || value === "stale"
    || value === "inactive"
    || value === "ambiguous"
    || value === "partial"
    ? value
    : undefined;
}

export function overviewFixtureVariant(search: string): OverviewFixtureVariant | undefined {
  const value = new URLSearchParams(search).get("overviewFixture");
  return value === "established"
    || value === "caught-up"
    || value === "pending-review"
    || value === "relay-ready"
    || value === "relay-in-hand"
    || value === "identity-unresolved"
    || value === "indexes-stale"
    || value === "indexes-degraded"
    || value === "indexes-missing"
    || value === "job-determinate"
    || value === "job-indeterminate"
    || value === "failure"
    || value === "partial"
    || value === "unavailable"
    ? value
    : undefined;
}

export async function resolveApi(): Promise<HubApi> {
  if (
    createFixtureApi !== null
    && fixturesEnabled(import.meta.env.DEV, window.location.search)
  ) {
    const inboxVariant = inboxFixtureVariant(window.location.search);
    const relayVariant = relayFixtureVariant(window.location.search);
    const activityVariant = activityFixtureVariant(window.location.search);
    const memberVariant = memberFixtureVariant(window.location.search);
    const overviewVariant = overviewFixtureVariant(window.location.search);
    return createFixtureApi({
      ...(inboxVariant === undefined ? {} : { inboxFixture: inboxVariant }),
      ...(relayVariant === undefined ? {} : { relayFixture: relayVariant }),
      ...(activityVariant === undefined ? {} : { activityFixture: activityVariant }),
      ...(memberVariant === undefined ? {} : { memberFixture: memberVariant }),
      ...(overviewVariant === undefined ? {} : { overviewFixture: overviewVariant }),
    });
  }
  return new HttpHubApi();
}
