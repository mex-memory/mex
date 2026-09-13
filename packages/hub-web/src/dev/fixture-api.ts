import { isInboxCreate, isInboxUpdate } from "../lib/inbox-change";
import type { FixtureApiOptions, HubApi, JobSubscription } from "../api/client";
import type {
  AgentLoggingPolicy,
  AgentLoggingUpdateRequest,
  HubOnboardingState,
  ActivityItem,
  ActivityRequest,
  ActivityResponse,
  CapabilitiesResponse,
  CodeKnowledgeRequest,
  CodeKnowledgeResponse,
  CodeWorkspaceRequest,
  CodeWorkspaceResponse,
  GraphSourceProjection,
  GraphSymbol,
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
  SearchRequest,
  SearchResponse,
  SessionResponse,
  SpecDetailResponse,
  SpecListRequest,
  SpecListResponse,
  SpecSummaryProjection,
  StartJobRequest,
  TeamActivityEvent,
  TeamActivitySubjectInput,
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
  WikiBacklinksRequest,
  WikiBacklinksResponse,
  WikiEntityDetailResponse,
  WikiEntityListRequest,
  WikiGraphResponse,
  WikiGroundedCodeResponse,
  WikiEntityListResponse,
  WikiEntitySummary,
  WikiRelationsRequest,
  WikiRelationsResponse,
} from "../api/types";

const now = new Date("2026-08-23T08:45:00.000Z");
const timestamp = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const revision = (character: string) => character.repeat(64);
const fixtureMemberIds = [
  "member_01K36WVM6H7JK8M9NPQRSTVVWX",
  "member_01K36R3X4A5BC6DE7FGHJKMNPQ",
  "member_01K35Z2A3B4C5D6E7FGHJKMNPQ",
] as const;

const fixtureMembers: TeamMember[] = [
  {
    schemaVersion: 1,
    id: fixtureMemberIds[0],
    displayName: "Ada Lovelace",
    gitAliases: [{ name: "Ada", email: "ada@example.test" }],
    active: true,
    sourcePath: `.mex/team/members/${fixtureMemberIds[0]}.md`,
    revision: revision("a"),
  },
  {
    schemaVersion: 1,
    id: fixtureMemberIds[1],
    displayName: "Grace Hopper",
    gitAliases: [{ name: "Grace", email: "grace@example.test" }],
    active: true,
    sourcePath: `.mex/team/members/${fixtureMemberIds[1]}.md`,
    revision: revision("b"),
  },
  {
    schemaVersion: 1,
    id: fixtureMemberIds[2],
    displayName: "Lin Chen",
    gitAliases: [],
    active: false,
    sourcePath: `.mex/team/members/${fixtureMemberIds[2]}.md`,
    revision: revision("c"),
  },
];

const fixtureWorkstreamIds = [
  "ws_01K37WVM6H7JK8M9NPQRSTVVW0",
  "ws_01K37R3X4A5BC6DE7FGHJKMNPQ",
  "ws_01K36Z2A3B4C5D6E7FGHJKMNPQ",
] as const;

const fixtureWorkstreamActor = {
  kind: "member" as const,
  memberId: fixtureMemberIds[0],
  displayName: "Ada Lovelace",
};

const fixtureWorkstreams: TeamWorkstream[] = [
  {
    schemaVersion: 1,
    id: fixtureWorkstreamIds[0],
    entityRevision: 4,
    title: "Human-team memory",
    goal: "Make repository memory reliable and useful for a collaborating engineering team.",
    summary: "Identity and Activity are live; Workstreams are the next canonical planning layer.",
    state: "active",
    owners: [fixtureWorkstreamActor],
    contributors: [{
      kind: "member",
      memberId: fixtureMemberIds[1],
      displayName: "Grace Hopper",
    }],
    paths: ["packages/hub-web", "src/team"],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: [],
    currentState: "Checkpoint C is merged and the D workbench is under review.",
    nextMilestone: "Merge Workstreams and read-only Specs.",
    createdBy: fixtureWorkstreamActor,
    createdAt: timestamp(4_320),
    updatedBy: fixtureWorkstreamActor,
    updatedAt: timestamp(18),
    sourcePath: `.mex/workstreams/${fixtureWorkstreamIds[0]}.md`,
    revision: revision("4"),
  },
  {
    schemaVersion: 1,
    id: fixtureWorkstreamIds[1],
    entityRevision: 2,
    title: "Release evidence",
    goal: "Keep every checkpoint merge backed by reproducible evidence.",
    summary: "Performance confirmation and post-merge checks are recorded at the exact SHA.",
    state: "blocked",
    owners: [fixtureWorkstreamActor],
    contributors: [],
    paths: ["scripts/release-benchmark"],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: ["Pinned cross-platform evidence is collected only at release hardening."],
    currentState: "Linux enforcement is active; the release matrix remains later scope.",
    nextMilestone: "Run the full release matrix in Checkpoint I.",
    createdBy: fixtureWorkstreamActor,
    createdAt: timestamp(2_880),
    updatedBy: fixtureWorkstreamActor,
    updatedAt: timestamp(95),
    sourcePath: `.mex/workstreams/${fixtureWorkstreamIds[1]}.md`,
    revision: revision("5"),
  },
  {
    schemaVersion: 1,
    id: fixtureWorkstreamIds[2],
    entityRevision: 3,
    title: "Hub foundations",
    goal: "Provide a bounded local operational view of the repository.",
    summary: "The authenticated local Hub and its read-only foundations are complete.",
    state: "done",
    owners: [fixtureWorkstreamActor],
    contributors: [],
    paths: ["src/hub", "packages/hub-contracts"],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: [],
    currentState: "Complete and retained as canonical history.",
    nextMilestone: "Archive after the human-team release.",
    createdBy: fixtureWorkstreamActor,
    createdAt: timestamp(8_640),
    updatedBy: fixtureWorkstreamActor,
    updatedAt: timestamp(2_000),
    sourcePath: `.mex/workstreams/${fixtureWorkstreamIds[2]}.md`,
    revision: revision("6"),
  },
];

const jobs: JobSummary[] = [
  {
    id: "job_01K36WVM6H7JK8M9NPQRSTVVWX",
    scaffoldId: "scf_mex",
    kind: "graph_refresh",
    generation: 14,
    phase: "parse",
    progress: { completed: 124, total: 183 },
    state: "running",
    cancelRequested: false,
    createdAt: timestamp(9),
    startedAt: timestamp(8),
    revision: revision("a"),
  },
  {
    id: "job_01K36R3X4A5BC6DE7FGHJKMNPQ",
    scaffoldId: "scf_mex",
    kind: "wiki_refresh",
    generation: 8,
    phase: "complete",
    progress: { completed: 42, total: 42 },
    state: "succeeded",
    cancelRequested: false,
    createdAt: timestamp(145),
    startedAt: timestamp(144),
    finishedAt: timestamp(141),
    summary: "Indexed 42 durable knowledge entities.",
    revision: revision("b"),
  },
  {
    id: "job_01K35Z2A3B4C5D6E7FGHJKMNPQ",
    scaffoldId: "scf_mex",
    kind: "graph_rebuild",
    generation: 13,
    phase: "validate",
    progress: { completed: 390 },
    state: "interrupted",
    cancelRequested: false,
    createdAt: timestamp(930),
    startedAt: timestamp(929),
    finishedAt: timestamp(900),
    interruptedReason: "process_restart",
    revision: revision("c"),
  },
  {
    id: "job_01K34P2A3B4C5D6E7FGHJKMNPQ",
    scaffoldId: "scf_mex",
    kind: "wiki_rebuild",
    generation: 7,
    phase: "validate",
    progress: { completed: 91, total: 100 },
    state: "failed",
    cancelRequested: false,
    createdAt: timestamp(1880),
    startedAt: timestamp(1879),
    finishedAt: timestamp(1872),
    problem: { type: "about:blank", code: "JOB_FAILED", status: 500, title: "Replacement index did not validate", detail: "The previous trustworthy index was preserved." },
    revision: revision("d"),
  },
];

const activityItems: ActivityItem[] = [
  {
    source: "activity",
    id: "event_01K36WVM6H7JK8M9NPQRSTVVWX",
    timestamp: timestamp(7),
    action: "inbox.published",
    recordOrigin: { kind: "workflow", operation: "inbox.publish" },
    label: "Keep approval consequences explicit",
    subjects: [
      {
        kind: "entity",
        entity: {
          id: "proposal_01000000000000000000001721",
          entityKind: "proposal",
          title: "Keep approval consequences explicit",
        },
      },
    ],
    subjectCount: 1,
    subjectsTruncated: false,
    sourcePath: ".mex/events/activity/2026-08/event_01K36WVM6H7JK8M9NPQRSTVVWX.md",
    recordedActor: {
      kind: "member",
      memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX",
      displayName: "Ada Lovelace",
    },
    effectiveActor: {
      kind: "member",
      memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX",
      displayName: "Ada Lovelace",
    },
    actorDiagnostics: [],
    workstream: null,
    repository: {
      branch: "codex/hub-ux",
      head: "aeaf0ab0022ac5d704404585d981b4da5f2c1cbf",
      dirty: true,
      observedAt: timestamp(7),
    },
    revision: revision("1"),
  },
  {
    source: "activity",
    id: "event_01K36R3X4A5BC6DE7FGHJKMNPQ",
    timestamp: timestamp(38),
    action: "relay.acknowledged",
    recordOrigin: { kind: "workflow", operation: "relay.acknowledge" },
    label: "Carry the release evidence through the final cross-platform gate.",
    subjects: [
      {
        kind: "entity",
        entity: {
          id: "relay_01000000000000000000000001",
          entityKind: "relay",
          title: "Carry the release evidence through the final cross-platform gate.",
        },
      },
    ],
    subjectCount: 1,
    subjectsTruncated: false,
    sourcePath: ".mex/events/activity/2026-08/event_01K36R3X4A5BC6DE7FGHJKMNPQ.md",
    recordedActor: {
      kind: "member",
      memberId: "member_01K36R3X4A5BC6DE7FGHJKMNPQ",
      displayName: "Grace Hopper",
    },
    effectiveActor: {
      kind: "member",
      memberId: "member_01K36R3X4A5BC6DE7FGHJKMNPQ",
      displayName: "Grace Hopper",
    },
    actorDiagnostics: [],
    workstream: null,
    repository: {
      branch: "codex/hub-ux",
      head: "aeaf0ab0022ac5d704404585d981b4da5f2c1cbf",
      dirty: false,
      observedAt: timestamp(38),
    },
    revision: revision("2"),
  },
  {
    source: "legacy",
    id: `legacy_${revision("3")}`,
    timestamp: timestamp(63),
    action: "decision",
    subjects: [
      { kind: "file", path: "src/team/activity/timeline.ts" },
      { kind: "file", path: "packages/hub-contracts/src/index.ts" },
    ],
    subjectCount: 2,
    subjectsTruncated: false,
    sourcePath: ".mex/events/decisions.jsonl",
    recordedActor: null,
    effectiveActor: null,
    actorDiagnostics: [],
    workstream: null,
    repository: null,
    revision: null,
    sourceLine: 18,
    message: "Keep activity immutable and preserve Project notes as a read-only projection.",
    messageTruncated: false,
  },
  {
    source: "activity",
    id: "event_01K35Z2A3B4C5D6E7FGHJKMNPQ",
    timestamp: timestamp(1_510),
    action: "member.updated",
    recordOrigin: { kind: "workflow", operation: "member.update" },
    label: "Daksh Jaitly",
    subjects: [
      {
        kind: "entity",
        entity: {
          id: "member_01K35Z2A3B4C5D6E7FGHJKMNPQ",
          entityKind: "member",
          title: "Daksh Jaitly",
        },
      },
    ],
    subjectCount: 1,
    subjectsTruncated: false,
    sourcePath: ".mex/events/activity/2026-08/event_01K35Z2A3B4C5D6E7FGHJKMNPQ.md",
    recordedActor: { kind: "git", name: "Daksh Jaitly", email: "daksh@example.test" },
    effectiveActor: {
      kind: "member",
      memberId: "member_01K35Z2A3B4C5D6E7FGHJKMNPQ",
      displayName: "Daksh Jaitly",
    },
    actorDiagnostics: [{
      code: "ACTOR_ALIAS_REMAPPED",
      severity: "info",
      message: "The recorded Git identity currently resolves to member Daksh Jaitly.",
    }],
    workstream: null,
    repository: {
      branch: null,
      head: "6484dd00022ac5d704404585d981b4da5f2c1cbf",
      dirty: false,
      observedAt: timestamp(1_510),
    },
    revision: revision("4"),
  },
  {
    source: "activity",
    id: "event_01K34P2A3B4C5D6E7FGHJKMNPQ",
    timestamp: timestamp(2_930),
    action: "relay.closed",
    recordOrigin: { kind: "custom" },
    label: "Imported closure note",
    subjects: [
      { kind: "file", path: "docs/handovers/imported-closure.md" },
      { kind: "commit", hash: "6484dd0" },
    ],
    subjectCount: 2,
    subjectsTruncated: false,
    sourcePath: ".mex/events/activity/2026-08/event_01K34P2A3B4C5D6E7FGHJKMNPQ.md",
    recordedActor: { kind: "git", name: "MEX Maintainer", email: "maintainer@example.test" },
    effectiveActor: { kind: "git", name: "MEX Maintainer", email: "maintainer@example.test" },
    actorDiagnostics: [],
    workstream: null,
    repository: {
      branch: null,
      head: "6484dd00022ac5d704404585d981b4da5f2c1cbf",
      dirty: false,
      observedAt: timestamp(2_930),
    },
    revision: revision("5"),
  },
  {
    source: "activity",
    id: "event_01K34P2A3B4C5D6E7FGHJKMNPR",
    timestamp: timestamp(3_100),
    action: "repository.initialized",
    recordOrigin: { kind: "unknown" },
    label: null,
    subjects: [],
    subjectCount: 0,
    subjectsTruncated: false,
    sourcePath: ".mex/events/activity/2026-08/event_01K34P2A3B4C5D6E7FGHJKMNPR.md",
    recordedActor: { kind: "unknown" },
    effectiveActor: { kind: "unknown" },
    actorDiagnostics: [],
    workstream: null,
    repository: {
      branch: "feat/wiki-port-contract-lock",
      head: null,
      dirty: false,
      observedAt: timestamp(3_100),
    },
    revision: revision("7"),
  },
  {
    source: "legacy",
    id: `legacy_${revision("6")}`,
    timestamp: timestamp(4_400),
    action: "note",
    subjects: [{ kind: "file", path: "PLAN.md" }],
    subjectCount: 1,
    subjectsTruncated: false,
    sourcePath: ".mex/events/decisions.jsonl",
    recordedActor: null,
    effectiveActor: null,
    actorDiagnostics: [],
    workstream: null,
    repository: null,
    revision: null,
    sourceLine: 7,
    message: "Project Hub foundations remain independent of the Wiki engine.",
    messageTruncated: false,
  },
];

const unavailable = (reason: string) => ({ availability: "unavailable" as const, reason });
const available = { availability: "available" as const };

const capabilities: CapabilitiesResponse = {
  apiVersion: "v1",
  git: available,
  activity: available,
  activityRecord: available,
  members: {
    read: available,
    canonicalMutation: available,
    localSelection: available,
  },
  workstreams: { read: available, canonicalMutation: available },
  specs: { read: available },
  inbox: {
    read: available,
    draftMutation: available,
    proposalMutation: available,
    specApproval: available,
  },
  relays: {
    read: available,
    draftMutation: available,
    publish: available,
    lifecycleMutation: available,
  },
  jobs: available,
  graph: { read: available, refresh: available, rebuild: available },
  wiki: {
    read: available,
    refresh: available,
    rebuild: available,
  },
};

const session: SessionResponse = {
  csrfToken: "a".repeat(43),
  expiresAt: timestamp(-650),
};

const home: HomeResponse = {
  observedAt: timestamp(0),
  repository: {
    scaffoldId: "scf_mex",
    name: "mex",
    branch: "codex/hub-ux",
    head: "aeaf0ab0022ac5d704404585d981b4da5f2c1cbf",
    dirty: true,
  },
  actor: { kind: "member", memberId: fixtureMemberIds[0], displayName: fixtureMembers[0].displayName },
  attention: {
    inbox: { availability: "available", teamReviewCount: 3 },
    relays: { availability: "available", readyToTakeCount: 1, inYourHandsCount: 1 },
  },
  jobs: { availability: "available", activeCount: 1 },
};

const health: HealthResponse = {
  status: "degraded",
  observedAt: timestamp(0),
  components: [
    { id: "git", label: "Git repository", status: "healthy", summary: "Branch and working tree are readable.", diagnostics: [] },
    {
      id: "graph",
      label: "Code graph",
      status: "degraded",
      summary: "The graph is stale against the current branch; a bounded refresh is recommended.",
      diagnostics: [{ code: "GRAPH_STALE", severity: "warning", message: "The indexed HEAD differs from the current repository HEAD." }],
      repairJobKind: "graph_refresh",
      graph: {
        observedAt: timestamp(0),
        indexStatus: "stale",
        lastSuccessfulIndexAt: timestamp(190),
        indexedAt: timestamp(190),
        indexedBranch: "feat/project-hub-foundation",
        indexedHead: "6484dd00022ac5d704404585d981b4da5f2c1cbf",
        currentBranch: "codex/hub-ux",
        currentHead: "aeaf0ab0022ac5d704404585d981b4da5f2c1cbf",
        schemaVersion: 3,
        extractorVersion: "0.7.2",
        grammarVersion: "tree-sitter-2026.08",
        parseHealth: {
          total: 183,
          ok: 179,
          partial: 3,
          failed: 1,
          failedPaths: ["src/legacy/parser.ts"],
          failedPathsTruncated: false,
        },
        changes: {
          total: 7,
          added: ["packages/hub-web/src/pages/SymbolPage.tsx"],
          modified: [
            "packages/hub-web/src/pages/SearchPage.tsx",
            "packages/hub-web/src/pages/HealthPage.tsx",
            "packages/hub-web/src/pages/JobsPage.tsx",
            "src/hub/services/graph.ts",
            "packages/hub-contracts/src/index.ts",
          ],
          deleted: ["packages/hub-web/src/pages/LegacyCodePlaceholder.tsx"],
          truncated: false,
          branchChanged: true,
          manifestChanged: false,
          configChanged: false,
          grammarChanged: false,
        },
        allowedJobKinds: ["graph_refresh", "graph_rebuild"],
        recommendedJobKind: "graph_refresh",
        activeJobId: jobs[0].id,
      },
    },
    {
      id: "wiki",
      label: "Project Wiki",
      status: "healthy",
      summary: "The exact-byte Wiki index is fresh and available for read-only Knowledge views.",
      diagnostics: [],
      wiki: {
        indexStatus: "fresh",
        observedAt: timestamp(0),
        indexedAt: timestamp(61),
        schemaVersion: 3,
        indexedRevision: revision("6"),
        allowedJobKinds: ["wiki_refresh", "wiki_rebuild"],
        recommendedJobKind: null,
        activeJobId: null,
      },
    },
    { id: "local_state", label: "Local Hub state", status: "healthy", summary: "Schema v3 jobs, graph phases, and team state are readable.", diagnostics: [] },
  ],
};

type OverviewVariant = NonNullable<FixtureApiOptions["overviewFixture"]>;
type HealthComponent = HealthResponse["components"][number];

function fixtureHealthComponent(id: "graph" | "wiki"): HealthComponent {
  const component = health.components.find((candidate) => candidate.id === id);
  if (component === undefined) throw new Error(`Missing fixture ${id} health component.`);
  return structuredClone(component);
}

function freshGraphComponent(activeJobId: string | null = null): HealthComponent {
  const component = fixtureHealthComponent("graph");
  component.status = "healthy";
  component.summary = "The code Graph matches the current repository snapshot.";
  component.diagnostics = [];
  delete component.repairJobKind;
  component.graph = {
    ...component.graph!,
    indexStatus: "fresh",
    indexedAt: timestamp(61),
    lastSuccessfulIndexAt: timestamp(61),
    indexedBranch: home.repository.branch,
    indexedHead: home.repository.head,
    currentBranch: home.repository.branch,
    currentHead: home.repository.head,
    parseHealth: {
      total: 183,
      ok: 183,
      partial: 0,
      failed: 0,
      failedPaths: [],
      failedPathsTruncated: false,
    },
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
    recommendedJobKind: null,
    activeJobId,
  };
  return component;
}

function staleGraphComponent(activeJobId: string | null = null): HealthComponent {
  const component = fixtureHealthComponent("graph");
  component.graph = { ...component.graph!, activeJobId };
  return component;
}

function degradedGraphComponent(): HealthComponent {
  const component = freshGraphComponent();
  component.status = "degraded";
  component.summary = "The indexed snapshot is usable, but some source files parsed only partially or failed.";
  component.diagnostics = [{
    code: "GRAPH_PARSE_DEGRADED",
    severity: "warning",
    message: "Five indexed sources did not parse completely.",
  }];
  component.repairJobKind = "graph_rebuild";
  component.graph = {
    ...component.graph!,
    indexStatus: "degraded",
    parseHealth: {
      total: 183,
      ok: 178,
      partial: 4,
      failed: 1,
      failedPaths: ["src/legacy/parser.ts"],
      failedPathsTruncated: false,
    },
    recommendedJobKind: "graph_rebuild",
  };
  return component;
}

function missingGraphComponent(): HealthComponent {
  const component = freshGraphComponent();
  component.status = "degraded";
  component.summary = "No trustworthy code Graph index exists yet.";
  component.diagnostics = [{
    code: "GRAPH_INDEX_MISSING",
    severity: "warning",
    message: "Build the code Graph before using indexed code context.",
  }];
  component.repairJobKind = "graph_rebuild";
  component.graph = {
    ...component.graph!,
    indexStatus: "missing",
    lastSuccessfulIndexAt: null,
    indexedAt: null,
    indexedBranch: null,
    indexedHead: null,
    schemaVersion: null,
    extractorVersion: null,
    grammarVersion: null,
    parseHealth: {
      total: 0,
      ok: 0,
      partial: 0,
      failed: 0,
      failedPaths: [],
      failedPathsTruncated: false,
    },
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
    recommendedJobKind: "graph_rebuild",
    activeJobId: null,
  };
  return component;
}

function freshWikiComponent(activeJobId: string | null = null): HealthComponent {
  const component = fixtureHealthComponent("wiki");
  component.wiki = { ...component.wiki!, activeJobId };
  return component;
}

function missingWikiComponent(): HealthComponent {
  const component = freshWikiComponent();
  component.status = "degraded";
  component.summary = "No trustworthy Knowledge index exists yet.";
  component.diagnostics = [{
    code: "WIKI_INDEX_MISSING",
    severity: "warning",
    message: "Build the Knowledge index before using indexed project memory.",
  }];
  component.repairJobKind = "wiki_rebuild";
  component.wiki = {
    ...component.wiki!,
    indexStatus: "missing",
    indexedAt: null,
    schemaVersion: null,
    indexedRevision: null,
    recommendedJobKind: "wiki_rebuild",
    activeJobId: null,
  };
  return component;
}

function unavailableHealthComponent(id: "graph" | "wiki"): HealthComponent {
  return {
    id,
    label: id === "graph" ? "Code graph" : "Project Wiki",
    status: "unavailable",
    summary: id === "graph"
      ? "Code Graph health could not be read."
      : "Knowledge index health could not be read.",
    diagnostics: [{
      code: id === "graph" ? "GRAPH_HEALTH_UNAVAILABLE" : "WIKI_HEALTH_UNAVAILABLE",
      severity: "error",
      message: "The local health source is unavailable.",
    }],
  };
}

function overviewContext(variant: OverviewVariant): OverviewResponse["context"] {
  if (variant === "unavailable") {
    return {
      availability: "unavailable",
      observedAt: timestamp(0),
      reason: "Graph and Knowledge health are unavailable in this Hub process.",
    };
  }
  if (variant === "indexes-missing") {
    return {
      availability: "available",
      observedAt: timestamp(0),
      graph: overviewGraphSource(missingGraphComponent()),
      wiki: overviewWikiSource(missingWikiComponent()),
    };
  }
  if (variant === "indexes-stale") {
    return {
      availability: "available",
      observedAt: timestamp(0),
      graph: overviewGraphSource(staleGraphComponent()),
      wiki: overviewWikiSource(freshWikiComponent()),
    };
  }
  if (variant === "indexes-degraded") {
    return {
      availability: "available",
      observedAt: timestamp(0),
      graph: overviewGraphSource(degradedGraphComponent()),
      wiki: overviewWikiSource(freshWikiComponent()),
    };
  }
  if (variant === "partial") {
    return {
      availability: "available",
      observedAt: timestamp(0),
      graph: {
        availability: "unavailable",
        observedAt: timestamp(0),
        reason: unavailableHealthComponent("graph").summary,
      },
      wiki: overviewWikiSource(freshWikiComponent()),
    };
  }
  if (variant === "established") {
    return {
      availability: "available",
      observedAt: timestamp(0),
      graph: overviewGraphSource(staleGraphComponent(jobs[0].id)),
      wiki: overviewWikiSource(freshWikiComponent()),
    };
  }
  const activeJobId = variant === "job-determinate" ? jobs[0].id : null;
  const wikiJobId = variant === "job-indeterminate" ? "job_01K39WVM6H7JK8M9NPQRSTVVWX" : null;
  return {
    availability: "available",
    observedAt: timestamp(0),
    graph: overviewGraphSource(freshGraphComponent(activeJobId)),
    wiki: overviewWikiSource(freshWikiComponent(wikiJobId)),
  };
}

function overviewGraphSource(
  component: HealthComponent,
): Extract<OverviewResponse["context"], { availability: "available" }>["graph"] {
  if (component.graph === undefined) throw new Error("Fixture graph details are required.");
  if (component.status === "unavailable") {
    throw new Error("An unavailable graph component must use the Overview unavailable-source branch.");
  }
  const { activeJobId: _activeJobId, ...details } = component.graph;
  return {
    availability: "available",
    observedAt: component.graph.observedAt,
    status: component.status,
    summary: component.summary,
    diagnostics: structuredClone(component.diagnostics),
    diagnosticsTruncated: false,
    repairJobKind: component.repairJobKind === "graph_refresh" || component.repairJobKind === "graph_rebuild"
      ? component.repairJobKind
      : null,
    details,
  };
}

function overviewWikiSource(
  component: HealthComponent,
): Extract<OverviewResponse["context"], { availability: "available" }>["wiki"] {
  if (component.wiki === undefined) throw new Error("Fixture Wiki details are required.");
  if (component.status === "unavailable") {
    throw new Error("An unavailable Wiki component must use the Overview unavailable-source branch.");
  }
  const { activeJobId: _activeJobId, ...details } = component.wiki;
  return {
    availability: "available",
    observedAt: component.wiki.observedAt,
    status: component.status,
    summary: component.summary,
    diagnostics: structuredClone(component.diagnostics),
    diagnosticsTruncated: false,
    repairJobKind: component.repairJobKind === "wiki_refresh" || component.repairJobKind === "wiki_rebuild"
      ? component.repairJobKind
      : null,
    details,
  };
}

const indeterminateJob: JobSummary = {
  id: "job_01K39WVM6H7JK8M9NPQRSTVVWX",
  scaffoldId: "scf_mex",
  kind: "wiki_refresh",
  generation: 9,
  phase: "discover",
  progress: { completed: 37 },
  state: "running",
  cancelRequested: false,
  createdAt: timestamp(5),
  startedAt: timestamp(4),
  revision: revision("e"),
};

const relevantFailedJob: JobSummary = {
  id: "job_01K39R3X4A5BC6DE7FGHJKMNPQ",
  scaffoldId: "scf_mex",
  kind: "graph_refresh",
  generation: 15,
  phase: "failed",
  progress: { completed: 176, total: 183 },
  state: "failed",
  cancelRequested: false,
  createdAt: timestamp(6),
  startedAt: timestamp(5),
  finishedAt: timestamp(2),
  problem: {
    type: "about:blank",
    code: "JOB_FAILED",
    status: 500,
    title: "Graph refresh failed",
    detail: "The previous trustworthy Graph index was preserved.",
  },
  revision: revision("f"),
};

const graphRevision = revision("7");
const wikiRevision = revision("6");
const wikiIds = {
  hub: "mx_01K36WVM6H7JK8M9NPQRSTVVWX",
  graph: "mx_01K36R3X4A5BC6DE7FGHJKMNPQ",
  activity: "mx_01K35Z2A3B4C5D6E7FGHJKMNPQ",
} as const;
const fixtureInboxSpecId = "mx_01000000000000000000000001";

const wikiEntities: WikiEntitySummary[] = [
  {
    id: wikiIds.hub,
    kind: "architecture",
    title: "Project Hub read boundaries",
    summary: "The Hub reads canonical project state through revision-bound internal ports and never mutates during ordinary browsing.",
    lifecycleState: "promoted",
    groundingHealth: "fresh",
    topics: [wikiIds.graph],
    topicsTruncated: false,
    sourceTypes: ["file", "symbol"],
    sourceTypesTruncated: false,
    location: { path: ".mex/wiki/architecture/project-hub.md", startLine: 1, endLine: 48 },
    version: { semanticRevision: 4, contentHash: revision("1") },
    diagnostics: [],
    diagnosticsTruncated: false,
    route: `/knowledge/${wikiIds.hub}`,
  },
  {
    id: wikiIds.graph,
    kind: "decision",
    title: "One snapshot per graph request",
    summary: "Search and symbol reads revalidate the database, repository snapshot, and exact source bytes before returning data.",
    lifecycleState: "promoted",
    groundingHealth: "changed",
    topics: [],
    topicsTruncated: false,
    sourceTypes: ["file", "commit"],
    sourceTypesTruncated: false,
    location: { path: ".mex/wiki/decisions/graph-snapshot.md", startLine: 1, endLine: 35 },
    version: { semanticRevision: 2, contentHash: revision("2") },
    diagnostics: [{ code: "WIKI_GROUNDING_CHANGED", severity: "warning", message: "The grounded symbol changed after this entry was indexed." }],
    diagnosticsTruncated: false,
    route: `/knowledge/${wikiIds.graph}`,
  },
  {
    id: wikiIds.activity,
    kind: "runbook",
    title: "Review immutable activity",
    summary: "Use the Activity workbench to inspect canonical and legacy history without advancing cursors or creating events.",
    lifecycleState: "in_flight",
    groundingHealth: "unverified",
    topics: [wikiIds.hub],
    topicsTruncated: false,
    sourceTypes: ["manual"],
    sourceTypesTruncated: false,
    location: { path: ".mex/wiki/runbooks/activity-review.md", startLine: 1, endLine: 24 },
    version: { semanticRevision: 1, contentHash: revision("3") },
    diagnostics: [],
    diagnosticsTruncated: false,
    route: `/knowledge/${wikiIds.activity}`,
  },
];

const detailOnlyWikiEntities = new Map<string, WikiEntitySummary>([[
  fixtureInboxSpecId,
  {
    id: fixtureInboxSpecId,
    kind: "spec",
    title: "Human-team memory release",
    summary: "The reviewed Spec for Git-authoritative team memory and the Hub surfaces that explain it.",
    lifecycleState: "in_flight",
    groundingHealth: "fresh",
    topics: [wikiIds.hub],
    topicsTruncated: false,
    sourceTypes: ["manual", "file"],
    sourceTypesTruncated: false,
    location: { path: `.mex/specs/${fixtureInboxSpecId}.md`, startLine: 1, endLine: 72 },
    version: { semanticRevision: 4, contentHash: revision("3") },
    diagnostics: [],
    diagnosticsTruncated: false,
    route: `/knowledge/${fixtureInboxSpecId}`,
  },
]]);

function wikiDetail(id: string): WikiEntityDetailResponse {
  const entity = wikiEntities.find((item) => item.id === id) ?? detailOnlyWikiEntities.get(id);
  if (entity === undefined) throw new Error("Fixture Wiki entity not found.");
  const grounded = entity.id === wikiIds.hub;
  const body = entity.id === wikiIds.hub
    ? "# Project Hub read boundaries\n\nThe Hub is a local, read-only projection of canonical project state.\n\nEvery indexed response belongs to one stable revision. Pagination never combines revisions, and maintenance runs only after an explicit user action."
    : entity.id === fixtureInboxSpecId
      ? "# Human-team memory release\n\nThe release gate records bounded evidence before a durable team-memory change is accepted.\n\nReview remains explicit, and Git distribution remains a separate human action."
    : `# ${entity.title}\n\n${entity.summary ?? "No additional narrative is recorded."}`;
  return {
    indexedRevision: wikiRevision,
    observedAt: timestamp(0),
    entity,
    body: {
      content: body,
      totalBytes: new TextEncoder().encode(body).byteLength,
      truncated: false,
    },
    provenance: { kind: "human", id: "daksh", capturedAt: timestamp(2_880) },
    sources: {
      items: [{ type: "file", ref: entity.location.path, note: "Canonical Wiki source", repository: "mex", commit: "4f52336", capturedAt: timestamp(61) }],
      total: 1,
      truncated: false,
    },
    groundings: {
      items: grounded ? [{ state: "fresh", health: "fresh", requestedNode: "sym.createHubServer", resolvedNode: "sym.createHubServer", fingerprint: revision("4"), file: "src/hub/server.ts", commit: "4f52336", verifiedAt: timestamp(61), reason: null, candidates: [], candidatesTruncated: false }] : [{ state: "ungrounded", health: "unverified", requestedNode: null, resolvedNode: null, fingerprint: null, file: null, commit: null, verifiedAt: null, reason: "No explicit code grounding is recorded.", candidates: [], candidatesTruncated: false }],
      total: 1,
      truncated: false,
    },
    relationCount: entity.id === wikiIds.hub ? 1 : 0,
    backlinkCount: entity.id === wikiIds.hub ? 1 : 0,
  };
}

function wikiRelations(id: string): WikiRelationsResponse {
  const target = wikiEntities.find((item) => item.id !== id) ?? wikiEntities[1];
  const root = wikiEntities.find((item) => item.id === id) ?? wikiEntities[0];
  return {
    indexedRevision: wikiRevision,
    observedAt: timestamp(0),
    items: id === wikiIds.hub ? [{ direction: "outgoing", relation: { type: "depends_on", source: { id: root.id, kind: root.kind, title: root.title }, target: { id: target.id, kind: target.kind, title: target.title }, note: "Graph reads provide explicit code context." }, entity: target }] : [],
    nextCursor: null,
    truncated: false,
  };
}

function wikiBacklinks(id: string): WikiBacklinksResponse {
  const source = wikiEntities[2];
  const target = wikiEntities.find((item) => item.id === id) ?? wikiEntities[0];
  return {
    indexedRevision: wikiRevision,
    observedAt: timestamp(0),
    items: id === wikiIds.hub ? [{ type: "related_to", source: { id: source.id, kind: source.kind, title: source.title }, target: { id: target.id, kind: target.kind, title: target.title }, note: "The activity runbook is reviewed from the Hub." }] : [],
    nextCursor: null,
    truncated: false,
  };
}

const fixtureSpecIds = {
  root: "mx_01K38WVM6H7JK8M9NPQRSTVVWX",
  requirement: "mx_01K38R3X4A5BC6DE7FGHJKMNPQ",
  criterion: "mx_01K38Z2A3B4C5D6E7FGHJKMNPQ",
  constraint: "mx_01K38P2A3B4C5D6E7FGHJKMNPQ",
} as const;

const fixtureSpecSummaries: SpecSummaryProjection[] = [
  {
    schemaVersion: 1,
    id: fixtureSpecIds.root,
    kind: "spec",
    title: "Human-team memory release",
    summary: "Ship a Git-authoritative workflow for identity, Workstreams, reviewed knowledge, and release memory.",
    lifecycleState: "in_flight",
    groundingHealth: "fresh",
    sourcePath: ".mex/wiki/specs/human-team-memory.md",
    version: { semanticRevision: 5, contentHash: revision("a") },
    topics: [],
    sourceTypes: ["manual", "file"],
    diagnostics: [],
    diagnosticsTruncated: false,
  },
  {
    schemaVersion: 1,
    id: fixtureSpecIds.requirement,
    kind: "requirement",
    title: "Canonical Workstream review",
    summary: "Every Workstream mutation must preview and apply one exact revision-bound envelope.",
    lifecycleState: "promoted",
    groundingHealth: "fresh",
    sourcePath: ".mex/wiki/specs/human-team-memory.md",
    version: { semanticRevision: 2, contentHash: revision("b") },
    topics: [],
    sourceTypes: ["manual"],
    diagnostics: [],
    diagnosticsTruncated: false,
  },
  {
    schemaVersion: 1,
    id: fixtureSpecIds.criterion,
    kind: "acceptance_criterion",
    title: "Stale previews never apply",
    summary: "Editing a form after preview forces a new preview before apply.",
    lifecycleState: "promoted",
    groundingHealth: "unverified",
    sourcePath: ".mex/wiki/specs/human-team-memory.md",
    version: { semanticRevision: 1, contentHash: revision("c") },
    topics: [],
    sourceTypes: ["manual"],
    diagnostics: [],
    diagnosticsTruncated: false,
  },
  {
    schemaVersion: 1,
    id: fixtureSpecIds.constraint,
    kind: "constraint",
    title: "No inferred satisfaction",
    summary: "The Spec reader reports only explicit Wiki relationships and evidence.",
    lifecycleState: "promoted",
    groundingHealth: "unverified",
    sourcePath: ".mex/wiki/specs/human-team-memory.md",
    version: { semanticRevision: 1, contentHash: revision("d") },
    topics: [],
    sourceTypes: ["manual"],
    diagnostics: [],
    diagnosticsTruncated: false,
  },
];

const fixtureSpecIndex = {
  state: "fresh" as const,
  observedAt: timestamp(0),
  indexedRevision: wikiRevision,
  indexedAt: timestamp(61),
  diagnostics: [],
  diagnosticsTruncated: false,
};

function fixtureSpecDetail(id: string): SpecDetailResponse {
  const spec = fixtureSpecSummaries.find((item) => item.id === id && item.kind === "spec");
  if (spec === undefined) throw new Error("Fixture Spec not found.");
  return {
    availability: "ready",
    index: fixtureSpecIndex,
    detail: {
      schemaVersion: 1,
      spec,
      body: "# Human-team memory release\n\nThis specification binds repository-owned team workflows to exact, reviewable evidence.\n",
      bodyTruncated: false,
      provenance: { kind: "human", id: "daksh", capturedAt: timestamp(4_320) },
      sources: [{
        type: "file",
        ref: spec.sourcePath,
        note: "Canonical specification source",
        repository: "mex",
        commit: "b46209e",
        capturedAt: timestamp(61),
      }],
      sourcesTruncated: false,
      groundings: [{
        state: "fresh",
        health: "fresh",
        requestedNode: "TeamWorkflowPort",
        resolvedNode: "TeamWorkflowPort",
        fingerprint: revision("e"),
        file: "src/team/contracts/workflow.ts",
        commit: "b46209e",
        verifiedAt: timestamp(61),
        reason: null,
        candidates: [],
        candidatesTruncated: false,
      }],
      groundingsTruncated: false,
      hierarchy: {
        requirements: [fixtureSpecSummaries[1]!],
        acceptanceCriteria: [fixtureSpecSummaries[2]!],
        constraints: [fixtureSpecSummaries[3]!],
        relations: [
          {
            type: "derived_from",
            source: { id: fixtureSpecIds.requirement, kind: "requirement" },
            target: { id: fixtureSpecIds.root, kind: "spec" },
            note: null,
          },
          {
            type: "verified_by",
            source: { id: fixtureSpecIds.requirement, kind: "requirement" },
            target: { id: fixtureSpecIds.criterion, kind: "acceptance_criterion" },
            note: "The criterion records the explicit review invariant.",
          },
          {
            type: "constrained_by",
            source: { id: fixtureSpecIds.root, kind: "spec" },
            target: { id: fixtureSpecIds.constraint, kind: "constraint" },
            note: null,
          },
        ],
        estimatedTokens: 360,
      },
      deterministicRevision: revision("f"),
    },
  };
}

const graphSymbols: GraphSymbol[] = [
  {
    id: "sym.createHubServer",
    symbolKind: "function",
    name: "createHubServer",
    qualifiedName: "hub.server.createHubServer",
    language: "TypeScript",
    path: "src/hub/server.ts",
    startLine: 74,
    endLine: 126,
    signature: "createHubServer(options: HubServerOptions): Promise<RunningHub>",
    route: "/code/symbols/sym.createHubServer",
  },
  {
    id: "sym.GraphPort.searchNodes",
    symbolKind: "method",
    name: "searchNodes",
    qualifiedName: "GraphPort.searchNodes",
    language: "TypeScript",
    path: "src/team/contracts/graph.ts",
    startLine: 249,
    endLine: 252,
    signature: "searchNodes(query: string, options?: GraphSearchOptions): Promise<GraphPage<CodeSymbol>>",
    route: "/code/symbols/sym.GraphPort.searchNodes",
  },
] as GraphSymbol[];

const sourcePages: GraphSourceProjection[] = [
  {
    path: "src/hub/server.ts",
    startLine: 74,
    endLine: 84,
    content: "export async function createHubServer(options: HubServerOptions) {\n  const app = createHubApp(options);\n  const server = await listenOnLoopback(app, options.port);\n  return { server, address: server.address() };\n}",
    contentHash: revision("8"),
    symbolIds: ["sym.createHubServer"],
  },
  {
    path: "src/hub/server.ts",
    startLine: 85,
    endLine: 92,
    content: "\nfunction listenOnLoopback(app: Hono, port: number) {\n  return serve({ fetch: app.fetch, hostname: \"127.0.0.1\", port });\n}",
    contentHash: revision("9"),
    symbolIds: ["sym.createHubServer"],
  },
];

const searchResponse = (request: SearchRequest): SearchResponse => ({
  query: request.q,
  observedAt: timestamp(0),
  groups: {
    wiki: {
      status: "available",
      items: wikiEntities.filter((entity) => `${entity.title} ${entity.summary ?? ""}`.toLowerCase().includes(request.q.toLowerCase()) || request.q.toLowerCase().includes("hub")).map((entity) => ({
        id: entity.id,
        kind: "wiki" as const,
        entityKind: entity.kind,
        title: entity.title,
        summary: entity.summary,
        lifecycleState: entity.lifecycleState,
        groundingHealth: entity.groundingHealth,
        topics: entity.topics,
        topicsTruncated: entity.topicsTruncated,
        sourceTypes: entity.sourceTypes,
        sourceTypesTruncated: entity.sourceTypesTruncated,
        path: entity.location.path,
        matchedFields: ["title" as const, "summary" as const],
        route: entity.route,
      })),
      nextCursor: null,
      truncated: false,
      revision: wikiRevision,
    },
    symbols: {
      status: "available",
      items: graphSymbols.map((symbol) => ({ ...symbol, kind: "code_symbol" as const })),
      nextCursor: null,
      truncated: false,
      revision: graphRevision,
    },
    sources: {
      status: "available",
      items: [{
        id: "source_hub_server",
        kind: "source_chunk",
        path: "src/hub/server.ts",
        startLine: 74,
        endLine: 84,
        preview: `export async function createHubServer(options: HubServerOptions) {\n  const app = createHubApp(options);\n}`,
        previewTruncated: true,
        matchedTerms: request.q.split(/\s+/).filter(Boolean).slice(0, 4),
        symbolIds: ["sym.createHubServer"],
        route: "/code/symbols/sym.createHubServer",
      }],
      nextCursor: null,
      truncated: false,
      revision: graphRevision,
    },
  },
});

function codeWorkspace(id: string, request: CodeWorkspaceRequest): CodeWorkspaceResponse {
  const symbol = graphSymbols.find((item) => item.id === id) ?? graphSymbols[0];
  const sourceOffset = request.sourceCursor === "fixture_source_2" ? 1 : 0;
  const source = sourcePages[sourceOffset];
  const sourceHasMore = sourceOffset === 0;
  if (request.view === "callers" || request.view === "callees") {
    const relation = request.view === "callers"
      ? { kind: "calls", sourceId: "sym.GraphPort.searchNodes", targetId: symbol.id, path: "src/hub/services/graph.ts", line: 141, confidence: 0.96, provenance: "ast" }
      : { kind: "calls", sourceId: symbol.id, targetId: "sym.GraphPort.searchNodes", path: "src/hub/server.ts", line: 102, confidence: 0.93, provenance: "ast" };
    return {
      revision: graphRevision,
      symbol,
      source: { items: [source], nextCursor: sourceHasMore ? "fixture_source_2" : null, truncated: false },
      view: request.view,
      traversal: { view: request.view, items: [relation], nextCursor: null, truncated: false },
    };
  }
  if (request.view === "impact") {
    return {
      revision: graphRevision,
      symbol,
      source: { items: [source], nextCursor: sourceHasMore ? "fixture_source_2" : null, truncated: false },
      view: "impact",
      traversal: {
        view: "impact",
        targetId: symbol.id,
        roots: [graphSymbols[1]],
        impacted: [{ symbol: graphSymbols[1], depth: Math.min(request.depth ?? 2, 2), rootId: graphSymbols[1].id }],
        relations: [{ kind: "calls", sourceId: graphSymbols[1].id, targetId: symbol.id, confidence: 0.93, provenance: "ast" }],
        truncated: false,
      },
    };
  }
  return {
    revision: graphRevision,
    symbol,
    source: { items: [source], nextCursor: sourceHasMore ? "fixture_source_2" : null, truncated: false },
    view: "overview",
    traversal: { view: "overview" },
  };
}

function fixtureOperationId(prefix: "event" | "member" | "ws", sequence: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `${prefix}_01K37WVM6H7JK8M9NPQRSTVVW${alphabet[sequence % alphabet.length]}`;
}

const fixtureInboxDraftId = "inbox_00000000000000000000000000000001";
const fixtureInboxProposalId = "proposal_01000000000000000000001720";
const fixtureInboxOwnProposalId = "proposal_01000000000000000000001721";
const fixtureInboxStaleProposalId = "proposal_01000000000000000000001722";
const fixtureInboxCreatedSpecId = "mx_02000000000000000000000001";
const fixtureInboxTeammateActor = {
  kind: "member" as const,
  memberId: fixtureMemberIds[1],
  displayName: fixtureMembers[1].displayName,
};

const fixtureInboxDrafts: InboxDraftDetail[] = [{
  id: fixtureInboxDraftId,
  revision: revision("1"),
  updatedAt: timestamp(16),
  changeKind: "spec.create",
  entityKind: "requirement",
  title: "Keep Inbox review focused on meaningful changes",
  rationaleExcerpt: "An agent prepared this private draft so a human can review the durable intent before publication.",
  input: {
    change: {
      kind: "spec.create",
      entityKind: "requirement",
      title: "Keep Inbox review focused on meaningful changes",
      summary: "Reviewers see the proposed Spec meaning before implementation metadata.",
      body: "Inbox must help a reviewer understand what will change, why it matters, and what evidence supports it before approval.\n\nExact revisions and machine identifiers remain available for audit without controlling the reading experience.",
      status: "in_flight",
      topics: [fixtureInboxSpecId],
      relation: {
        type: "derived_from",
        target: {
          id: fixtureInboxSpecId,
          kind: "spec",
          title: "Human-team memory release",
        },
      },
    },
    rationale: "An agent prepared this private draft so a human can review the durable intent before publication.",
    evidence: [
      {
        kind: "entity",
        entity: {
          id: fixtureInboxSpecId,
          kind: "spec",
          title: "Human-team memory release",
        },
      },
      { kind: "code", code: { kind: "symbol", symbolId: "sym.createHubServer" } },
      { kind: "file", path: "packages/hub-web/src/pages/InboxPage.tsx" },
      { kind: "commit", hash: "cbc42c867dbd4ad675c8353e9921d5c653508c58" },
      {
        kind: "external",
        uri: "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/",
        label: "Accessible dialog guidance",
      },
      { kind: "manual", note: "Prepared from a checkout-local review of the existing Inbox workbench." },
    ],
    targetRevisions: [{
      target: { kind: "entity", id: fixtureInboxSpecId },
      revision: revision("3"),
      semanticRevision: 4,
    }],
  },
}];

const fixtureInboxProposals: InboxProposalDetail[] = [
  {
    schemaVersion: 1,
    ref: {
      id: fixtureInboxProposalId,
      kind: "proposal",
      title: "Clarify release evidence review",
    },
    sourcePath: `.mex/inbox/${fixtureInboxProposalId}.md`,
    revision: revision("2"),
    state: "pending",
    author: fixtureInboxTeammateActor,
    changeKind: "spec.update",
    entityKind: "spec",
    title: "Clarify release evidence review",
    rationaleExcerpt: "Clarify the exact evidence boundary for the release gate.",
    change: {
      kind: "spec.update",
      target: {
        id: fixtureInboxSpecId,
        kind: "spec",
        title: "Human-team memory release",
      },
      patch: {
        body: "The release gate records exact, bounded evidence before approval.\n\nPrivate proposal prose remains outside durable Specs until approval.",
        summary: "Require exact evidence review before release approval.",
      },
    },
    rationale: "Clarify the exact evidence boundary for the release gate.",
    evidence: [
      { kind: "file", path: "scripts/release-benchmark/run.mjs" },
      { kind: "manual", note: "Grace reviewed the release evidence boundary with the team." },
    ],
    targetRevisions: [{
      target: { kind: "entity", id: fixtureInboxSpecId },
      revision: revision("3"),
      semanticRevision: 4,
    }],
  },
  {
    schemaVersion: 1,
    ref: {
      id: fixtureInboxOwnProposalId,
      kind: "proposal",
      title: "Keep approval consequences explicit",
    },
    sourcePath: `.mex/inbox/${fixtureInboxOwnProposalId}.md`,
    revision: revision("5"),
    state: "pending",
    author: fixtureWorkstreamActor,
    changeKind: "spec.create",
    entityKind: "constraint",
    title: "Keep approval consequences explicit",
    rationaleExcerpt: "Reviewers should know which working-tree artifacts an approval writes.",
    change: {
      kind: "spec.create",
      entityKind: "constraint",
      title: "Keep approval consequences explicit",
      summary: "Approval copy names the Spec, proposal, and Activity effects.",
      body: "Every approval confirmation must explain the durable Spec change, proposal transition, and Activity record before apply.",
      status: "in_flight",
    },
    rationale: "Reviewers should know which working-tree artifacts an approval writes.",
    evidence: [{ kind: "manual", note: "Prepared while reviewing the current actor's Hub workflow." }],
    targetRevisions: [],
  },
  {
    schemaVersion: 1,
    ref: {
      id: fixtureInboxStaleProposalId,
      kind: "proposal",
      title: "Refresh the stale review boundary",
    },
    sourcePath: `.mex/inbox/${fixtureInboxStaleProposalId}.md`,
    revision: revision("6"),
    state: "stale",
    author: fixtureInboxTeammateActor,
    changeKind: "spec.update",
    entityKind: "spec",
    title: "Refresh the stale review boundary",
    rationaleExcerpt: "The referenced Spec content changed after this proposal was published.",
    change: {
      kind: "spec.update",
      target: {
        id: fixtureInboxSpecId,
        kind: "spec",
        title: "Human-team memory release",
      },
      patch: {
        title: "Human-team memory review release",
      },
    },
    rationale: "Make the review boundary unmistakable, once the dependency is refreshed.",
    evidence: [{ kind: "commit", hash: "d34db33fd34db33fd34db33fd34db33fd34db33f" }],
    targetRevisions: [{
      target: { kind: "entity", id: fixtureInboxSpecId },
      revision: revision("8"),
      semanticRevision: 3,
    }],
  },
];

const fixtureRelayDraftId = "relay-draft-01";
const fixtureSparseRelayDraftId = "relay-draft-02";
const fixtureRelayIds = {
  ready: "relay_01000000000000000000000001",
  claimed: "relay_01000000000000000000000002",
  sentWaiting: "relay_01000000000000000000000003",
  sentTaken: "relay_01000000000000000000000004",
  closed: "relay_01000000000000000000000005",
  legacy: "relay_01000000000000000000000006",
  legacyV2: "relay_01000000000000000000000007",
} as const;
const fixtureMissingMemberId = "member_01K39WVM6H7JK8M9NPQRSTVVWX";
const fixtureLegacyRelayWarning = "One or more legacy schema-v1 Relays have no canonical publication timestamp.";
const fixtureDirtyRelayPublicationWarning = "MEX recorded that local changes existed when this Relay was published; it did not record their paths, diff, or contents.";
const fixtureCurrentMemberActor = {
  kind: "member" as const,
  memberId: fixtureMemberIds[0],
  displayName: fixtureMembers[0].displayName,
};
const fixtureTeammateMemberActor = {
  kind: "member" as const,
  memberId: fixtureMemberIds[1],
  displayName: fixtureMembers[1].displayName,
};
const fixtureRelayRepoStates = {
  clean: {
    branch: "codex/hub-ux",
    head: "1a2b3c4d5e6f78900123456789abcdef01234567",
    dirty: false,
    observedAt: timestamp(70),
  },
  dirty: {
    branch: "feature/relay-accessibility",
    head: "23456789abcdef0123456789abcdef0123456789",
    dirty: true,
    observedAt: timestamp(55),
  },
  detached: {
    branch: null,
    head: "3456789abcdef0123456789abcdef0123456789a",
    dirty: false,
    observedAt: timestamp(90),
  },
  nullHead: {
    branch: "feature/unborn-relay",
    head: null,
    dirty: false,
    observedAt: timestamp(180),
  },
} satisfies Record<string, NonNullable<RelayDetail["publishedRepoState"]>>;

const fixtureRelayDrafts: RelayDraftDetail[] = [
  {
    id: fixtureRelayDraftId,
    revision: revision("7"),
    updatedAt: timestamp(11),
    summary: "Carry the release evidence through the final cross-platform gate.",
    recipients: [fixtureTeammateMemberActor],
    input: {
      recipients: [fixtureTeammateMemberActor],
      summary: "Carry the release evidence through the final cross-platform gate.",
      completed: ["The deterministic benchmark fixture is stable."],
      inProgress: ["Collect the final pinned runner evidence."],
      decisions: [{
        id: fixtureInboxSpecId,
        kind: "spec",
        title: "Human-team memory release",
      }],
      blockers: ["Windows packed-install evidence is not yet recorded."],
      unresolvedQuestions: ["Does the Windows packed-install run retain the same digest?"],
      changedFiles: ["scripts/release-benchmark/run.mjs"],
      code: [
        { kind: "symbol", symbolId: "sym.createHubServer", fingerprint: revision("1") },
        { kind: "file", path: "scripts/release-benchmark/run.mjs", fingerprint: revision("2") },
      ],
      evidence: [
        {
          kind: "entity",
          entity: {
            kind: "workstream",
            id: fixtureWorkstreamIds[0],
            title: fixtureWorkstreams[0].title,
          },
        },
        { kind: "entity", entity: { id: fixtureInboxSpecId, kind: "spec", title: "Human-team memory release" } },
        { kind: "code", code: { kind: "symbol", symbolId: "sym.createHubServer", fingerprint: revision("1") } },
        { kind: "file", path: "scripts/release-benchmark/run.mjs" },
        { kind: "commit", hash: "d34db33fd34db33fd34db33fd34db33fd34db33f" },
        { kind: "external", uri: "https://nodejs.org/en/download", label: "Node.js release matrix" },
        { kind: "manual", note: "Translated from a pre-v3 checkout-local Relay draft." },
      ],
      nextActions: ["Run the cross-platform storage matrix."],
    },
  },
  {
    id: fixtureSparseRelayDraftId,
    revision: revision("6"),
    updatedAt: timestamp(12),
    summary: "Hand off the standalone Relay follow-up.",
    recipients: [fixtureTeammateMemberActor],
    input: {
      recipients: [fixtureTeammateMemberActor],
      summary: "Hand off the standalone Relay follow-up.",
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
    },
  },
];

const fixtureRelays: RelayDetail[] = [
  {
    schemaVersion: 3,
    ref: { kind: "relay", id: fixtureRelayIds.ready },
    sourcePath: `.mex/relays/${fixtureRelayIds.ready}.md`,
    revision: revision("8"),
    state: "published",
    sender: fixtureTeammateMemberActor,
    recipients: [fixtureCurrentMemberActor],
    workstream: null,
    summary: "Release evidence is ready for the final cross-platform gate.",
    completed: ["Linux Node 22 characterization is captured."],
    inProgress: ["Cross-platform storage portability is awaiting claim."],
    decisions: [{ id: fixtureInboxSpecId, kind: "spec", title: "Human-team memory release" }],
    blockers: ["The Windows packed-install run still needs pinned evidence."],
    unresolvedQuestions: ["Does the Windows run retain the same archive digest?"],
    changedFiles: ["scripts/release-benchmark/run.mjs"],
    code: [
      { kind: "symbol", symbolId: "sym.createHubServer", fingerprint: revision("1") },
      { kind: "file", path: "scripts/release-benchmark/run.mjs" },
    ],
    evidence: [
      { kind: "entity", entity: { id: fixtureInboxSpecId, kind: "spec", title: "Human-team memory release" } },
      { kind: "code", code: { kind: "symbol", symbolId: "sym.createHubServer" } },
      { kind: "file", path: "scripts/release-benchmark/run.mjs" },
      { kind: "commit", hash: "d34db33fd34db33fd34db33fd34db33fd34db33f" },
      { kind: "external", uri: "https://nodejs.org/en/download", label: "Node.js release matrix" },
      { kind: "manual", note: "Exact fixture evidence for Relay UI validation." },
    ],
    nextActions: ["Take the handoff and run the remaining matrix."],
    diagnostics: [],
    diagnosticsTruncated: false,
    publishedAt: timestamp(70),
    publishedRepoState: fixtureRelayRepoStates.clean,
    acknowledgedBy: null,
    acknowledgedAt: null,
    closedBy: null,
    closedAt: null,
  },
  {
    schemaVersion: 3,
    ref: { kind: "relay", id: fixtureRelayIds.claimed },
    sourcePath: `.mex/relays/${fixtureRelayIds.claimed}.md`,
    revision: revision("9"),
    state: "acknowledged",
    sender: fixtureTeammateMemberActor,
    recipients: [fixtureCurrentMemberActor],
    workstream: null,
    summary: "Finish the keyboard and screen-reader pass for the Hub review surfaces.",
    completed: ["Route focus and skip-link behavior are covered by unit tests."],
    inProgress: ["The two supported desktop viewports still need a final keyboard pass."],
    decisions: [],
    blockers: [],
    unresolvedQuestions: ["Should the queue announce its new selection through the existing live region?"],
    changedFiles: ["packages/hub-web/src/pages/InboxPage.tsx"],
    code: [{ kind: "file", path: "packages/hub-web/src/pages/InboxPage.tsx" }],
    evidence: [{ kind: "manual", note: "The focused accessibility tests pass in both themes." }],
    nextActions: ["Verify keyboard selection at 1024×768 and 1440×900."],
    diagnostics: [],
    diagnosticsTruncated: false,
    publishedAt: timestamp(55),
    publishedRepoState: fixtureRelayRepoStates.dirty,
    acknowledgedBy: fixtureCurrentMemberActor,
    acknowledgedAt: timestamp(24),
    closedBy: null,
    closedAt: null,
  },
  {
    schemaVersion: 3,
    ref: { kind: "relay", id: fixtureRelayIds.sentWaiting },
    sourcePath: `.mex/relays/${fixtureRelayIds.sentWaiting}.md`,
    revision: revision("a"),
    state: "published",
    sender: fixtureCurrentMemberActor,
    recipients: [fixtureTeammateMemberActor],
    workstream: null,
    summary: "Run the final Relay contract regression suite against the merged branch.",
    completed: ["The local fixture matrix is deterministic."],
    inProgress: [],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: [],
    code: [],
    evidence: [{ kind: "manual", note: "All focused contract tests pass locally." }],
    nextActions: ["Take the handoff after pulling the latest integration branch."],
    diagnostics: [],
    diagnosticsTruncated: false,
    publishedAt: timestamp(90),
    publishedRepoState: fixtureRelayRepoStates.detached,
    acknowledgedBy: null,
    acknowledgedAt: null,
    closedBy: null,
    closedAt: null,
  },
  {
    schemaVersion: 3,
    ref: { kind: "relay", id: fixtureRelayIds.sentTaken },
    sourcePath: `.mex/relays/${fixtureRelayIds.sentTaken}.md`,
    revision: revision("b"),
    state: "acknowledged",
    sender: fixtureCurrentMemberActor,
    recipients: [fixtureTeammateMemberActor],
    workstream: null,
    summary: "Grace is carrying the final performance evidence into release review.",
    completed: ["Route budgets are recorded at the checkpoint SHA."],
    inProgress: ["Grace is comparing the production chunks with the pinned budget."],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: ["packages/hub-web/scripts/assert-route-budgets.mjs"],
    code: [{ kind: "file", path: "packages/hub-web/scripts/assert-route-budgets.mjs" }],
    evidence: [{ kind: "manual", note: "The release benchmark log is attached to the checkpoint evidence." }],
    nextActions: ["Close the handoff after the production build is recorded."],
    diagnostics: [],
    diagnosticsTruncated: false,
    publishedAt: timestamp(180),
    publishedRepoState: fixtureRelayRepoStates.nullHead,
    acknowledgedBy: fixtureTeammateMemberActor,
    acknowledgedAt: timestamp(130),
    closedBy: null,
    closedAt: null,
  },
  {
    schemaVersion: 3,
    ref: { kind: "relay", id: fixtureRelayIds.closed },
    sourcePath: `.mex/relays/${fixtureRelayIds.closed}.md`,
    revision: revision("c"),
    state: "closed",
    sender: fixtureCurrentMemberActor,
    recipients: [fixtureTeammateMemberActor],
    workstream: null,
    summary: "The Sidebar verification handoff no longer needs team attention.",
    completed: ["Keyboard, overflow, routing, and visual checks are recorded."],
    inProgress: [],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: ["packages/hub-web/src/app/HubSidebar.tsx"],
    code: [{ kind: "file", path: "packages/hub-web/src/app/HubSidebar.tsx" }],
    evidence: [{ kind: "manual", note: "The sender closed this handoff after the verification pass." }],
    nextActions: [],
    diagnostics: [],
    diagnosticsTruncated: false,
    publishedAt: timestamp(420),
    publishedRepoState: fixtureRelayRepoStates.clean,
    acknowledgedBy: fixtureTeammateMemberActor,
    acknowledgedAt: timestamp(330),
    closedBy: fixtureCurrentMemberActor,
    closedAt: timestamp(210),
  },
];

const fixtureLegacyRelay: RelayDetail = {
  schemaVersion: 1,
  ref: { kind: "relay", id: fixtureRelayIds.legacy },
  sourcePath: `.mex/relays/${fixtureRelayIds.legacy}.md`,
  revision: revision("e"),
  state: "published",
  sender: { kind: "git", name: "Grace", email: "grace@example.test" },
  recipients: [fixtureCurrentMemberActor],
  workstream: { kind: "workstream", id: "historical-release", title: "Historical release" },
  summary: "Review a legacy handoff whose original publication time was not recorded.",
  completed: ["The original release notes were recovered."],
  inProgress: [],
  decisions: [],
  blockers: [],
  unresolvedQuestions: [],
  changedFiles: ["docs/releases/legacy-handoff.md"],
  code: [],
  evidence: [{ kind: "manual", note: "Imported from a schema-v1 Relay document." }],
  nextActions: ["Review the legacy warning before acting on this handoff."],
  diagnostics: [{
    code: "RELAY_LEGACY_PUBLICATION_TIME",
    severity: "warning",
    message: fixtureLegacyRelayWarning,
  }],
  diagnosticsTruncated: false,
  publishedAt: null,
  publishedRepoState: null,
  acknowledgedBy: null,
  acknowledgedAt: null,
  closedBy: null,
  closedAt: null,
};

const fixtureLegacyRelayV2: RelayDetail = {
  schemaVersion: 2,
  ref: { kind: "relay", id: fixtureRelayIds.legacyV2 },
  sourcePath: `.mex/relays/${fixtureRelayIds.legacyV2}.md`,
  revision: revision("f"),
  state: "published",
  sender: fixtureTeammateMemberActor,
  recipients: [fixtureCurrentMemberActor],
  workstream: {
    kind: "workstream",
    id: fixtureWorkstreamIds[0],
    title: fixtureWorkstreams[0].title,
  },
  summary: "Review a timestamped legacy handoff with recorded Workstream context.",
  completed: ["The publication time and Workstream were preserved exactly."],
  inProgress: [],
  decisions: [],
  blockers: [],
  unresolvedQuestions: [],
  changedFiles: ["docs/design/relay-handoff-contract.md"],
  code: [],
  evidence: [{ kind: "manual", note: "Imported from a schema-v2 Relay document." }],
  nextActions: ["Use the Workstream only as legacy related context."],
  diagnostics: [],
  diagnosticsTruncated: false,
  publishedAt: timestamp(150),
  publishedRepoState: null,
  acknowledgedBy: null,
  acknowledgedAt: null,
  closedBy: null,
  closedAt: null,
};

type FixtureGitIdentity = { name: string | null; email: string | null };

const fixtureAdaGitIdentity: FixtureGitIdentity = {
  name: "Ada",
  email: "ada@example.test",
};

function fixtureCurrentActor(
  members: readonly TeamMember[],
  selection: TeamCurrentActorResponse["selection"],
  gitIdentity: FixtureGitIdentity | null,
): TeamCurrentActorResponse {
  const candidate = selection === null
    ? null
    : members.find((member) => member.id === selection.memberId) ?? null;
  if (candidate?.active === true) {
    return {
      actor: { kind: "member", memberId: candidate.id, displayName: candidate.displayName },
      source: "configured-member",
      selection,
      diagnostics: [],
      diagnosticsTruncated: false,
    };
  }

  const selectionDiagnostic: TeamCurrentActorResponse["diagnostics"][number] | null = selection === null
    ? null
    : candidate === null
      ? {
          code: "ACTOR_MEMBER_MISSING",
          severity: "warning",
          message: "The referenced member no longer exists.",
        }
      : {
          code: "ACTOR_MEMBER_INACTIVE",
          severity: "warning",
          message: "The referenced member is currently inactive.",
          path: candidate.sourcePath,
        };
  if (gitIdentity === null) {
    return {
      actor: { kind: "unknown" },
      source: "unknown",
      selection,
      diagnostics: [
        ...(selectionDiagnostic === null ? [] : [selectionDiagnostic]),
        {
          code: "GIT_IDENTITY_UNAVAILABLE",
          severity: "warning",
          message: "Git identity could not be inspected safely.",
        },
      ],
      diagnosticsTruncated: false,
    };
  }

  const normalizedName = gitIdentity.name?.trim().normalize("NFC") ?? null;
  const normalizedEmail = gitIdentity.email?.trim().normalize("NFC").toLowerCase() ?? null;
  const matchingMembers = members.filter((member) => member.active && member.gitAliases.some((alias) => (
    (normalizedEmail !== null && alias.email?.trim().normalize("NFC").toLowerCase() === normalizedEmail)
    || (normalizedName !== null && alias.name?.trim().normalize("NFC") === normalizedName)
  )));
  const resolutionDiagnostic: TeamCurrentActorResponse["diagnostics"][number] | null = matchingMembers.length > 1
    ? {
        code: "ACTOR_ALIAS_AMBIGUOUS",
        severity: "warning",
        message: "The recorded Git identity matches multiple active members and was not remapped.",
      }
    : null;
  const diagnostics = [
    ...(selectionDiagnostic === null ? [] : [selectionDiagnostic]),
    ...(resolutionDiagnostic === null ? [] : [resolutionDiagnostic]),
  ];
  if (matchingMembers.length === 1) {
    const member = matchingMembers[0]!;
    return {
      actor: { kind: "member", memberId: member.id, displayName: member.displayName },
      source: "git-alias",
      selection,
      diagnostics,
      diagnosticsTruncated: false,
    };
  }
  return {
    actor: { kind: "git", ...gitIdentity },
    source: "git-fallback",
    selection,
    diagnostics,
    diagnosticsTruncated: false,
  };
}

function fixtureTeamSubject(
  subject: TeamActivitySubjectInput,
): ActivityItem["subjects"][number] {
  if (subject.kind === "entity") {
    return {
      kind: "entity",
      entity: {
        id: subject.entity.id,
        entityKind: subject.entity.kind,
        title: subject.entity.title ?? null,
      },
    };
  }
  if (subject.kind === "code") {
    return subject.code.kind === "symbol"
      ? { kind: "symbol", symbolId: subject.code.symbolId }
      : { kind: "file", path: subject.code.path };
  }
  return subject;
}

function fixtureTimelineEvent(event: TeamActivityEvent): ActivityItem {
  const subjects = event.subjects.map(fixtureTeamSubject);
  const recordedActor = event.actor.kind === "member"
    ? { ...event.actor, displayName: event.actor.displayName ?? event.actor.memberId }
    : event.actor;
  return {
    source: "activity",
    id: event.id,
    timestamp: event.timestamp,
    action: event.action,
    recordOrigin: event.schemaVersion === 1
      ? { kind: "unknown" }
      : structuredClone(event.origin),
    label: event.schemaVersion === 1 ? null : event.label ?? null,
    subjects,
    subjectCount: subjects.length,
    subjectsTruncated: false,
    sourcePath: `.mex/events/activity/${event.timestamp.slice(0, 7)}/${event.id}.md`,
    recordedActor,
    effectiveActor: recordedActor,
    actorDiagnostics: [],
    workstream: event.workstream === null ? null : {
      id: event.workstream.id,
      entityKind: "workstream",
      title: event.workstream.title ?? null,
    },
    repository: event.repoState,
    revision: revision("9"),
  };
}

type OverviewFocusAvailable = Extract<OverviewResponse["focus"], { availability: "available" }>;
type OverviewInboxItem = Extract<OverviewFocusAvailable["inbox"], { availability: "available" }>["items"][number];
type OverviewRelayItem = Extract<OverviewFocusAvailable["relays"], { availability: "available" }>["readyToTake"][number];

function fixtureInboxProposalSummary(proposal: InboxProposalDetail): OverviewInboxItem {
  const {
    change: _change,
    rationale: _rationale,
    evidence: _evidence,
    targetRevisions: _targetRevisions,
    reviewRationale: _reviewRationale,
    ...summary
  } = proposal;
  return structuredClone(summary);
}

function fixtureRelaySummary(relay: RelayDetail): OverviewRelayItem {
  const {
    completed: _completed,
    inProgress: _inProgress,
    decisions: _decisions,
    blockers: _blockers,
    unresolvedQuestions: _unresolvedQuestions,
    changedFiles: _changedFiles,
    code: _code,
    evidence: _evidence,
    nextActions: _nextActions,
    diagnostics: _diagnostics,
    diagnosticsTruncated: _diagnosticsTruncated,
    ...summary
  } = relay;
  return structuredClone(summary);
}

class FixtureHubApi implements HubApi {
  #loggingPolicy: AgentLoggingPolicy = { mode: "significant", source: "default", revision: null };
  #loggingRevision = 0;

  getLoggingPolicy(): Promise<AgentLoggingPolicy> {
    return Promise.resolve(structuredClone(this.#loggingPolicy));
  }

  async setLoggingPolicy(request: AgentLoggingUpdateRequest): Promise<AgentLoggingPolicy> {
    if (request.expectedRevision !== this.#loggingPolicy.revision) throw new Error("Logging preference changed. Reload and try again.");
    this.#loggingPolicy = {
      mode: request.mode, source: "local", revision: (++this.#loggingRevision).toString(16).padStart(64, "0"),
    };
    return structuredClone(this.#loggingPolicy);
  }

  // Existing flows run as a returning checkout; onboarding tests opt into a first run.
  #onboardingCompleted = true;

  getOnboardingState(): Promise<HubOnboardingState> {
    return Promise.resolve({ completed: this.#onboardingCompleted });
  }

  completeOnboarding(): Promise<HubOnboardingState> {
    this.#onboardingCompleted = true;
    return Promise.resolve({ completed: true });
  }
  readonly #jobs = structuredClone(jobs);
  readonly #members: TeamMember[];
  readonly #workstreams = structuredClone(fixtureWorkstreams);
  readonly #inboxFixture: FixtureApiOptions["inboxFixture"];
  readonly #relayFixture: FixtureApiOptions["relayFixture"];
  readonly #activityFixture: FixtureApiOptions["activityFixture"];
  readonly #memberFixture: NonNullable<FixtureApiOptions["memberFixture"]>;
  readonly #overviewFixture: OverviewVariant;
  readonly #gitIdentity: FixtureGitIdentity | null;
  readonly #inboxDrafts: InboxDraftDetail[];
  readonly #inboxProposals: InboxProposalDetail[];
  readonly #relayDrafts: RelayDraftDetail[];
  readonly #relays: RelayDetail[];
  readonly #activityItems: ActivityItem[];
  #selection: TeamCurrentActorResponse["selection"];
  #previewSequence = 0;

  constructor(options: FixtureApiOptions = {}) {
    this.#onboardingCompleted = options.onboardingFixture !== "first-run";
    this.#inboxFixture = options.inboxFixture;
    this.#relayFixture = options.relayFixture;
    this.#activityFixture = options.activityFixture;
    this.#overviewFixture = options.overviewFixture ?? "established";
    this.#memberFixture = options.memberFixture
      ?? (options.overviewFixture === "identity-unresolved"
        ? "unknown"
        : options.inboxFixture === "unknown"
        ? "unknown"
        : options.relayFixture === "missing"
          ? "stale"
          : "configured");
    this.#members = structuredClone(fixtureMembers);
    this.#gitIdentity = this.#memberFixture === "unknown"
      ? null
      : this.#memberFixture === "git-fallback"
        ? { name: "MEX Contributor", email: "contributor@example.test" }
        : this.#memberFixture === "ambiguous"
          ? { name: "Grace", email: "ada@example.test" }
          : fixtureAdaGitIdentity;
    this.#selection = this.#memberFixture === "configured" || this.#memberFixture === "partial"
      ? {
          memberId: fixtureMemberIds[0],
          updatedAt: timestamp(12),
          revision: revision("d"),
        }
      : this.#memberFixture === "stale"
        ? {
            memberId: fixtureMissingMemberId,
            updatedAt: timestamp(12),
            revision: revision("d"),
          }
        : this.#memberFixture === "inactive"
          ? {
              memberId: fixtureMemberIds[2],
              updatedAt: timestamp(12),
              revision: revision("d"),
            }
          : null;
    this.#inboxDrafts = structuredClone(
      options.inboxFixture === "empty" ? [] : fixtureInboxDrafts,
    );
    this.#inboxProposals = structuredClone(
      options.inboxFixture === "empty" ? [] : fixtureInboxProposals,
    );
    this.#relayDrafts = structuredClone(
      options.relayFixture === "empty" ? [] : fixtureRelayDrafts,
    );
    this.#relays = structuredClone(
      options.relayFixture === "empty"
        ? []
        : options.relayFixture === "closed"
          ? fixtureRelays.filter((relay) => relay.state === "closed")
          : options.relayFixture === "legacy"
            ? [fixtureLegacyRelayV2, fixtureLegacyRelay]
            : fixtureRelays,
    );
    this.#activityItems = structuredClone(
      options.activityFixture === "empty"
        ? []
        : options.activityFixture === "legacy"
          ? activityItems.filter((item) => item.source === "legacy")
          : activityItems,
    );
  }

  #currentActor(): TeamCurrentActorResponse {
    return fixtureCurrentActor(this.#members, this.#selection, this.#gitIdentity);
  }

  #homeForCurrent(current: TeamCurrentActorResponse): HomeResponse {
    const actor = current.actor;
    const teamReviewCount = this.#inboxProposals.filter((item) => (
      item.state === "pending" || item.state === "stale"
    )).length;
    const readyToTakeCount = actor.kind !== "member" ? null : this.#relays.filter((relay) => (
      relay.state === "published"
      && (relay.audience === "team" || relay.recipients.some((recipient) => (
        recipient.kind === "member" && recipient.memberId === actor.memberId
      )))
    )).length;
    const inYourHandsCount = actor.kind !== "member" ? null : this.#relays.filter((relay) => (
      relay.state === "acknowledged"
      && relay.acknowledgedBy?.kind === "member"
      && relay.acknowledgedBy.memberId === actor.memberId
    )).length;
    return {
      ...home,
      actor: actor.kind === "member"
        ? { ...actor, displayName: actor.displayName ?? actor.memberId }
        : actor,
      attention: {
        inbox: {
          availability: "available",
          teamReviewCount,
        },
        relays: actor.kind !== "member"
          ? {
              availability: "unavailable",
              reason: "Select an active Member to see your personal Relay handoffs.",
            }
          : {
              availability: "available",
              readyToTakeCount: readyToTakeCount!,
              inYourHandsCount: inYourHandsCount!,
            },
      },
      jobs: {
        availability: "available",
        activeCount: this.#jobs.filter((job) => job.state === "queued" || job.state === "running").length,
      },
    };
  }

  bootstrap() { return Promise.resolve({ expiresAt: session.expiresAt }); }
  getSession() { return Promise.resolve(session); }
  getCapabilities() {
    const projected = structuredClone(capabilities);
    if (this.#inboxFixture === "partial") {
      projected.inbox = {
        ...projected.inbox,
        proposalMutation: unavailable("Inbox proposal writes are not connected in this Hub process."),
        specApproval: unavailable("Inbox Spec approval requires exact Wiki planning and apply."),
      };
    }
    if (this.#relayFixture === "partial") {
      projected.relays = {
        ...projected.relays,
        publish: unavailable("Relay publication is not connected in this Hub process."),
        lifecycleMutation: unavailable("Relay lifecycle writes are not connected in this Hub process."),
      };
    }
    if (this.#memberFixture === "partial") {
      projected.members = {
        ...projected.members,
        canonicalMutation: unavailable("Canonical Member writes are not connected in this Hub process."),
      };
    }
    return Promise.resolve(projected);
  }
  getHome(): Promise<HomeResponse> {
    return Promise.resolve(this.#homeForCurrent(this.#currentActor()));
  }
  async getOverview(): Promise<OverviewResponse> {
    const current = this.#currentActor();
    const baseShell = this.#homeForCurrent(current);
    const variant = this.#overviewFixture;
    let inbox: HomeResponse["attention"]["inbox"] = baseShell.attention.inbox;
    let relays: HomeResponse["attention"]["relays"] = baseShell.attention.relays;
    let jobsProjection: HomeResponse["jobs"] = baseShell.jobs;

    if (variant === "caught-up"
      || variant === "indexes-stale"
      || variant === "indexes-degraded"
      || variant === "indexes-missing"
      || variant === "job-determinate"
      || variant === "job-indeterminate"
      || variant === "failure") {
      inbox = { availability: "available", teamReviewCount: 0 };
      relays = { availability: "available", readyToTakeCount: 0, inYourHandsCount: 0 };
    } else if (variant === "pending-review") {
      inbox = { availability: "available", teamReviewCount: 3 };
      relays = { availability: "available", readyToTakeCount: 0, inYourHandsCount: 0 };
    } else if (variant === "relay-ready") {
      inbox = { availability: "available", teamReviewCount: 0 };
      relays = { availability: "available", readyToTakeCount: 1, inYourHandsCount: 0 };
    } else if (variant === "relay-in-hand") {
      inbox = { availability: "available", teamReviewCount: 0 };
      relays = { availability: "available", readyToTakeCount: 0, inYourHandsCount: 1 };
    } else if (variant === "identity-unresolved") {
      inbox = { availability: "available", teamReviewCount: 0 };
      relays = {
        availability: "unavailable",
        reason: "Select an active Member to see your personal Relay handoffs.",
      };
    } else if (variant === "partial") {
      inbox = { availability: "available", teamReviewCount: 2 };
      relays = {
        availability: "unavailable",
        reason: "Relay attention could not be read from the bounded source.",
      };
    } else if (variant === "unavailable") {
      inbox = {
        availability: "unavailable",
        reason: "Inbox attention could not be read from the bounded source.",
      };
      relays = {
        availability: "unavailable",
        reason: "Relay attention could not be read from the bounded source.",
      };
    }

    if (variant === "job-determinate" || variant === "job-indeterminate" || variant === "established") {
      jobsProjection = { availability: "available", activeCount: 1 };
    } else if (variant === "unavailable") {
      jobsProjection = {
        availability: "unavailable",
        reason: "Job state is unavailable in this Hub process.",
      };
    } else {
      jobsProjection = { availability: "available", activeCount: 0 };
    }

    const shell: HomeResponse = {
      ...baseShell,
      attention: { inbox, relays },
      jobs: jobsProjection,
    };
    const currentMemberId = current.actor.kind === "member" ? current.actor.memberId : null;
    const identityNeedsAttention = current.actor.kind !== "member"
      || current.diagnostics.some((diagnostic) => (
        diagnostic.code === "ACTOR_MEMBER_MISSING"
        || diagnostic.code === "ACTOR_MEMBER_INACTIVE"
        || diagnostic.code === "ACTOR_ALIAS_AMBIGUOUS"
      ));
    const identity: OverviewResponse["identity"] = variant === "unavailable"
      ? {
          availability: "unavailable",
          observedAt: timestamp(0),
          reason: "Current team identity could not be resolved in this Hub process.",
        }
      : {
          availability: "available",
          observedAt: timestamp(0),
          current: structuredClone(current),
        };
    const focusIdentity: OverviewFocusAvailable["identity"] = variant === "unavailable"
      ? {
          availability: "unavailable",
          observedAt: timestamp(0),
          reason: "Current team identity could not be resolved in this Hub process.",
        }
      : {
          availability: "available",
          observedAt: timestamp(0),
          requiresAttention: identityNeedsAttention,
        };
    const proposalItems = this.#inboxProposals
      .filter((proposal) => proposal.state === "pending" || proposal.state === "stale")
      .slice(0, 3)
      .map(fixtureInboxProposalSummary);
    const readyRelayItems = currentMemberId === null ? [] : this.#relays
      .filter((relay) => (
        relay.state === "published"
        && (relay.audience === "team" || relay.recipients.some((recipient) => (
          recipient.kind === "member" && recipient.memberId === currentMemberId
        )))
      ))
      .slice(0, 3)
      .map(fixtureRelaySummary);
    const inHandRelayItems = currentMemberId === null ? [] : this.#relays
      .filter((relay) => (
        relay.state === "acknowledged"
        && relay.acknowledgedBy?.kind === "member"
        && relay.acknowledgedBy.memberId === currentMemberId
      ))
      .slice(0, 3)
      .map(fixtureRelaySummary);
    const focusInbox: OverviewFocusAvailable["inbox"] = inbox.availability === "unavailable"
      ? {
          availability: "unavailable",
          observedAt: timestamp(0),
          reason: inbox.reason,
        }
      : {
          availability: "available",
          observedAt: timestamp(0),
          teamReviewCount: inbox.teamReviewCount,
          items: inbox.teamReviewCount === 0
            ? []
            : proposalItems.slice(0, inbox.teamReviewCount),
          deterministicRevision: revision("5"),
          sourceTruncated: false,
          diagnostics: [],
          diagnosticsTruncated: false,
        };
    const focusRelays: OverviewFocusAvailable["relays"] = relays.availability === "unavailable"
      ? {
          availability: "unavailable",
          observedAt: timestamp(0),
          reason: relays.reason,
        }
      : {
          availability: "available",
          observedAt: timestamp(0),
          readyToTakeCount: relays.readyToTakeCount,
          inYourHandsCount: relays.inYourHandsCount,
          readyToTake: relays.readyToTakeCount === 0
            ? []
            : readyRelayItems.slice(0, relays.readyToTakeCount),
          inYourHands: relays.inYourHandsCount === 0
            ? []
            : inHandRelayItems.slice(0, relays.inYourHandsCount),
          deterministicRevision: revision("b"),
          sourceTruncated: false,
          diagnostics: [],
          diagnosticsTruncated: false,
        };
    const focus: OverviewResponse["focus"] = focusIdentity.availability === "unavailable"
      && focusInbox.availability === "unavailable"
      && focusRelays.availability === "unavailable"
      ? {
          availability: "unavailable",
          observedAt: timestamp(0),
          reason: "Identity, Inbox, and Relay attention are unavailable in this Hub process.",
        }
      : {
          availability: "available",
          observedAt: timestamp(0),
          identity: focusIdentity,
          inbox: focusInbox,
          relays: focusRelays,
        };
    const activityPreview = variant === "indexes-missing"
      ? []
      : this.#activityItems.slice(0, 5);
    const activity: OverviewResponse["activity"] = variant === "partial" || variant === "unavailable"
      ? {
          availability: "unavailable",
          observedAt: timestamp(0),
          reason: "Recent team Activity could not be read from the bounded source.",
        }
      : {
          availability: "available",
          observedAt: timestamp(0),
          items: structuredClone(activityPreview),
          nextCursor: activityPreview.length < this.#activityItems.length
            ? `fixture_${activityPreview.length}`
            : null,
          hasMore: activityPreview.length < this.#activityItems.length,
          sourceTruncated: this.#activityFixture === "partial",
          deterministicRevision: revision("7"),
          diagnostics: this.#activityFixture === "empty" || this.#activityFixture === "legacy"
            ? []
            : [{
                code: "LEGACY_ACTIVITY_MALFORMED",
                severity: "warning",
                message: "One malformed project-note row was excluded while valid history was retained.",
                path: ".mex/events/decisions.jsonl",
              }],
          diagnosticsTruncated: this.#activityFixture === "partial",
        };
    const operation: OverviewResponse["operation"] = variant === "unavailable"
      ? {
          availability: "unavailable",
          observedAt: timestamp(0),
          reason: "Job state is unavailable in this Hub process.",
        }
      : {
          availability: "available",
          observedAt: timestamp(0),
          active: variant === "established" || variant === "job-determinate"
            ? structuredClone(this.#jobs.find((job) => job.state === "running") ?? jobs[0])
            : variant === "job-indeterminate"
              ? structuredClone(indeterminateJob)
              : null,
          latestRelevantFailure: variant === "failure" ? structuredClone(relevantFailedJob) : null,
        };

    return {
      observedAt: timestamp(0),
      shell,
      identity,
      focus,
      activity,
      context: overviewContext(variant),
      operation,
    };
  }
  getMembers(request: TeamMemberListRequest): Promise<TeamMemberListResponse> {
    const filtered = this.#members.filter((member) => (
      request.active === undefined || member.active === request.active
    ));
    const parsedOffset = request.cursor?.match(/^fixture_members_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const items = filtered.slice(offset, offset + request.limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length ? `fixture_members_${nextOffset}` : null;
    return Promise.resolve({
      items: structuredClone(items),
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("8"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getMember(id: string): Promise<TeamMember> {
    const member = this.#members.find((candidate) => candidate.id === id);
    return member === undefined
      ? Promise.reject(new Error("Fixture member not found."))
      : Promise.resolve(structuredClone(member));
  }
  getCurrentActor(): Promise<TeamCurrentActorResponse> {
    return Promise.resolve(structuredClone(this.#currentActor()));
  }
  getWorkstreams(request: TeamWorkstreamListRequest): Promise<TeamWorkstreamListResponse> {
    const filtered = this.#workstreams.filter((workstream) => (
      (request.state === undefined || workstream.state === request.state)
      && (request.includeArchived === true || workstream.state !== "archived")
    ));
    const parsedOffset = request.cursor?.match(/^fixture_workstreams_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const items = filtered.slice(offset, offset + request.limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length ? `fixture_workstreams_${nextOffset}` : null;
    return Promise.resolve({
      items: structuredClone(items),
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("3"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getWorkstream(id: string): Promise<TeamWorkstream> {
    const workstream = this.#workstreams.find((candidate) => candidate.id === id);
    return workstream === undefined
      ? Promise.reject(new Error("Fixture Workstream not found."))
      : Promise.resolve(structuredClone(workstream));
  }
  getRelayDrafts(request: RelayDraftListRequest): Promise<RelayDraftListResponse> {
    const parsedOffset = request.cursor?.match(/^fixture_relay_drafts_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const orderedDrafts = [...this.#relayDrafts].sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
    ));
    const details = orderedDrafts.slice(offset, offset + request.limit);
    const items = details.map(({ input: _input, ...summary }) => summary);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < orderedDrafts.length ? `fixture_relay_drafts_${nextOffset}` : null;
    return Promise.resolve({
      items: structuredClone(items),
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("a"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getRelayDraft(id: string): Promise<RelayDraftDetail> {
    const draft = this.#relayDrafts.find((candidate) => candidate.id === id);
    return draft === undefined
      ? Promise.reject(new Error("Fixture Relay draft not found."))
      : Promise.resolve(structuredClone(draft));
  }
  getRelays(request: RelayListRequest): Promise<RelayListResponse> {
    const current = this.#currentActor().actor;
    if ((request.perspective === "mine" || request.perspective === "sent") && current.kind !== "member") {
      return Promise.reject(new Error("Select an active Member to use this Relay perspective."));
    }
    const filtered = this.#relays.filter((relay) => {
      if (request.states !== undefined && !request.states.includes(relay.state)) return false;
      if (request.workstreamId !== undefined && relay.workstream?.id !== request.workstreamId) return false;
      if (request.perspective === "all") return true;
      if (current.kind !== "member") return false;
      if (request.perspective === "sent") {
        return relay.sender.kind === "member" && relay.sender.memberId === current.memberId;
      }
      return relay.state === "published"
        ? relay.audience === "team" || relay.recipients.some((recipient) => recipient.kind === "member" && recipient.memberId === current.memberId)
        : relay.acknowledgedBy?.kind === "member" && relay.acknowledgedBy.memberId === current.memberId;
    }).sort((left, right) => {
      if (left.publishedAt === null && right.publishedAt !== null) return 1;
      if (left.publishedAt !== null && right.publishedAt === null) return -1;
      const publishedOrder = right.publishedAt?.localeCompare(left.publishedAt ?? "") ?? 0;
      return publishedOrder || right.ref.id.localeCompare(left.ref.id);
    });
    const parsedOffset = request.cursor?.match(/^fixture_relays_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const details = filtered.slice(offset, offset + request.limit);
    const items = details.map(({
      completed: _completed,
      inProgress: _inProgress,
      decisions: _decisions,
      blockers: _blockers,
      unresolvedQuestions: _unresolvedQuestions,
      changedFiles: _changedFiles,
      code: _code,
      evidence: _evidence,
      nextActions: _nextActions,
      diagnostics: _diagnostics,
      diagnosticsTruncated: _diagnosticsTruncated,
      ...summary
    }) => summary);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length ? `fixture_relays_${nextOffset}` : null;
    return Promise.resolve({
      items: structuredClone(items),
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("b"),
      diagnostics: filtered.some((relay) => relay.schemaVersion === 1)
        ? structuredClone(fixtureLegacyRelay.diagnostics)
        : [],
      diagnosticsTruncated: false,
    });
  }
  getRelay(id: string): Promise<RelayDetail> {
    const relay = this.#relays.find((candidate) => candidate.ref.id === id);
    return relay === undefined
      ? Promise.reject(new Error("Fixture Relay not found."))
      : Promise.resolve(structuredClone(relay));
  }
  previewRelayOperation(
    request: RelayOperationPreviewRequest,
  ): Promise<RelayOperationPreviewResponse> {
    const action = request.action;
    const sequence = this.#previewSequence++;
    const eventId = fixtureOperationId("event", sequence);
    const draft = "draftId" in action && action.draftId !== undefined
      ? this.#relayDrafts.find((candidate) => candidate.id === action.draftId)
      : undefined;
    const relay = "relayId" in action
      ? this.#relays.find((candidate) => candidate.ref.id === action.relayId)
      : undefined;
    const createdDraftId = action.kind === "relay.draft.save"
      ? action.draftId ?? "relay-draft-02"
      : null;
    const publishedRelayId = "relay_02000000000000000000000001";
    const localChanges: RelayOperationPreviewResponse["preview"]["localChanges"] = action.kind === "relay.draft.save"
      ? [{
          namespace: "relay-draft",
          id: createdDraftId!,
          beforeRevision: draft?.revision ?? null,
          afterRevision: revision("c"),
          summary: draft === undefined ? "Create checkout-local Relay draft." : "Update checkout-local Relay draft.",
        }]
      : action.kind === "relay.draft.delete" || action.kind === "relay.publish"
        ? [{
            namespace: "relay-draft",
            id: action.draftId,
            beforeRevision: draft?.revision ?? revision("7"),
            afterRevision: null,
            summary: action.kind === "relay.publish" ? "Remove local draft after publication." : "Delete checkout-local Relay draft.",
          }]
        : [];
    const activityAction = action.kind === "relay.publish" ? "relay.published"
      : action.kind === "relay.acknowledge" ? "relay.acknowledged"
        : action.kind === "relay.close" ? "relay.closed"
          : null;
    const primaryChange: RelayOperationPreviewResponse["preview"]["changes"][number] | null = action.kind === "relay.publish"
      ? {
          kind: "create",
          path: `.mex/relays/${publishedRelayId}.md`,
          diff: `--- /dev/null\n+++ b/.mex/relays/${publishedRelayId}.md\n+state: published\n+summary: ${draft?.summary ?? "Relay handoff"}\n`,
          beforeRevision: null,
          afterRevision: revision("d"),
        }
      : action.kind === "relay.acknowledge" || action.kind === "relay.close"
        ? {
            kind: "update",
            path: relay?.sourcePath ?? `.mex/relays/${action.relayId}.md`,
            diff: `--- relay\n+++ relay\n-state: ${relay?.state ?? "published"}\n+state: ${action.kind === "relay.acknowledge" ? "acknowledged" : "closed"}\n`,
            beforeRevision: relay?.revision ?? revision("8"),
            afterRevision: revision("e"),
          }
        : null;
    const activityChange: RelayOperationPreviewResponse["preview"]["changes"][number] | null = activityAction === null ? null : {
      kind: "create",
      path: `.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md`,
      diff: `--- /dev/null\n+++ b/.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md\n+action: ${activityAction}\n`,
      beforeRevision: null,
      afterRevision: revision("f"),
    };
    const changes = [primaryChange, activityChange].filter((change): change is NonNullable<typeof change> => change !== null);
    const purposeIds: RelayOperationPreviewResponse["receipt"]["purposeIds"] = action.kind === "relay.draft.save"
      ? draft === undefined ? [{ purpose: "relay-draft", id: createdDraftId! }] : []
      : action.kind === "relay.draft.delete" ? []
        : action.kind === "relay.publish"
          ? [{ purpose: "activity", id: eventId }, { purpose: "relay", id: publishedRelayId }]
          : [{ purpose: "activity", id: eventId }];
    return Promise.resolve({
      schemaVersion: 1,
      request: structuredClone(request),
      preview: {
        valid: true,
        scope: action.kind === "relay.draft.save" || action.kind === "relay.draft.delete" ? "local" : action.kind === "relay.publish" ? "mixed" : "canonical",
        changes,
        localChanges,
        diagnostics: action.kind === "relay.publish" && home.repository.dirty
          ? [{
              code: "RELAY_DIRTY_PUBLICATION_STATE",
              severity: "warning",
              message: fixtureDirtyRelayPublicationWarning,
            }]
          : [],
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: this.#currentActor().actor,
          occurredAt: timestamp(0),
          repoState: { branch: home.repository.branch, head: home.repository.head, dirty: home.repository.dirty, observedAt: timestamp(0) },
        },
        purposeIds,
        requestRevision: revision("1"),
        presentationRevision: revision("2"),
        previewRevision: revision("3"),
      },
    });
  }
  applyRelayOperation(
    envelope: RelayOperationApplyRequest,
  ): Promise<RelayOperationApplyResponse> {
    const action = envelope.request.action;
    let relays: RelayDetail[] = [];
    if (action.kind === "relay.draft.save") {
      const id = action.draftId ?? envelope.receipt.purposeIds.find((item) => item.purpose === "relay-draft")?.id;
      if (id !== undefined) {
        const next: RelayDraftDetail = {
          id,
          revision: envelope.preview.localChanges[0]?.afterRevision ?? revision("c"),
          updatedAt: envelope.receipt.authority.occurredAt,
          summary: action.draft.summary,
          ...(action.draft.audience === undefined ? {} : { audience: action.draft.audience }),
          recipients: structuredClone(action.draft.recipients),
          input: structuredClone(action.draft),
        };
        const index = this.#relayDrafts.findIndex((candidate) => candidate.id === id);
        if (index === -1) this.#relayDrafts.unshift(next);
        else this.#relayDrafts[index] = next;
      }
    } else if (action.kind === "relay.draft.delete") {
      const index = this.#relayDrafts.findIndex((candidate) => candidate.id === action.draftId);
      if (index !== -1) this.#relayDrafts.splice(index, 1);
    } else if (action.kind === "relay.publish") {
      const draft = this.#relayDrafts.find((candidate) => candidate.id === action.draftId);
      const id = envelope.receipt.purposeIds.find((item) => item.purpose === "relay")?.id;
      if (draft !== undefined && id !== undefined) {
        const next: RelayDetail = {
          schemaVersion: draft.input.audience === "team" ? 4 : 3,
          ref: { kind: "relay", id },
          sourcePath: `.mex/relays/${id}.md`,
          revision: envelope.preview.changes[0]?.afterRevision ?? revision("d"),
          state: "published",
          sender: structuredClone(envelope.receipt.authority.actor),
          ...structuredClone(draft.input),
          audience: draft.input.audience === "team" ? "team" : undefined,
          workstream: null,
          publishedAt: envelope.receipt.authority.occurredAt,
          publishedRepoState: structuredClone(envelope.receipt.authority.repoState),
          acknowledgedBy: null,
          acknowledgedAt: null,
          closedBy: null,
          closedAt: null,
          diagnostics: [],
          diagnosticsTruncated: false,
        };
        this.#relays.unshift(next);
        this.#relayDrafts.splice(this.#relayDrafts.indexOf(draft), 1);
        relays = [next];
      }
    } else {
      const index = this.#relays.findIndex((candidate) => candidate.ref.id === action.relayId);
      const current = this.#relays[index];
      if (current !== undefined) {
        const next: RelayDetail = action.kind === "relay.acknowledge"
          ? {
              ...current,
              state: "acknowledged",
              revision: envelope.preview.changes[0]?.afterRevision ?? revision("e"),
              acknowledgedBy: structuredClone(envelope.receipt.authority.actor),
              acknowledgedAt: envelope.receipt.authority.occurredAt,
            }
          : {
              ...current,
              state: "closed",
              revision: envelope.preview.changes[0]?.afterRevision ?? revision("e"),
              closedBy: structuredClone(envelope.receipt.authority.actor),
              closedAt: envelope.receipt.authority.occurredAt,
            };
        this.#relays[index] = next;
        relays = [next];
      }
    }
    const eventId = envelope.receipt.purposeIds.find((item) => item.purpose === "activity")?.id;
    const events: TeamActivityEvent[] = eventId === undefined ? [] : [{
      schemaVersion: 2,
      id: eventId,
      timestamp: envelope.receipt.authority.occurredAt,
      actor: structuredClone(envelope.receipt.authority.actor),
      action: action.kind === "relay.publish" ? "relay.published" : action.kind === "relay.acknowledge" ? "relay.acknowledged" : "relay.closed",
      origin: { kind: "workflow", operation: action.kind },
      ...(relays[0]?.summary === undefined ? {} : { label: relays[0].summary }),
      subjects: relays[0] ? [{ kind: "entity", entity: { ...relays[0].ref } }] : [],
      workstream: relays[0]?.workstream ?? null,
      repoState: structuredClone(envelope.receipt.authority.repoState),
    }];
    return Promise.resolve({
      operationId: envelope.request.operationId,
      previewRevision: envelope.receipt.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: structuredClone(envelope.preview.changes),
      localChanges: structuredClone(envelope.preview.localChanges),
      relays: structuredClone(relays),
      events,
    });
  }
  getInboxDrafts(request: InboxDraftListRequest): Promise<InboxDraftListResponse> {
    const parsedOffset = request.cursor?.match(/^fixture_inbox_drafts_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const details = this.#inboxDrafts.slice(offset, offset + request.limit);
    const items = details.map(({ input: _input, ...summary }) => summary);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < this.#inboxDrafts.length
      ? `fixture_inbox_drafts_${nextOffset}`
      : null;
    return Promise.resolve({
      items,
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("4"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getInboxDraft(id: string): Promise<InboxDraftDetail> {
    const draft = this.#inboxDrafts.find((candidate) => candidate.id === id);
    return draft === undefined
      ? Promise.reject(new Error("Fixture Inbox draft not found."))
      : Promise.resolve(structuredClone(draft));
  }
  getInboxProposals(request: InboxProposalListRequest): Promise<InboxProposalListResponse> {
    const filtered = this.#inboxProposals.filter((proposal) => (
      request.states === undefined || request.states.includes(proposal.state)
    ));
    const parsedOffset = request.cursor?.match(/^fixture_inbox_proposals_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const details = filtered.slice(offset, offset + request.limit);
    const items = details.map(({
      change: _change,
      rationale: _rationale,
      evidence: _evidence,
      targetRevisions: _targetRevisions,
      reviewRationale: _reviewRationale,
      ...summary
    }) => summary);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length
      ? `fixture_inbox_proposals_${nextOffset}`
      : null;
    return Promise.resolve({
      items,
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("5"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getInboxProposal(id: string): Promise<InboxProposalDetail> {
    const proposal = this.#inboxProposals.find((candidate) => candidate.ref.id === id);
    return proposal === undefined
      ? Promise.reject(new Error("Fixture Inbox proposal not found."))
      : Promise.resolve(structuredClone(proposal));
  }
  previewInboxOperation(
    request: InboxOperationPreviewRequest,
  ): Promise<InboxOperationPreviewResponse> {
    const action = request.action;
    const sequence = this.#previewSequence++;
    const eventId = fixtureOperationId("event", sequence);
    const activityAction = action.kind === "inbox.publish" ? "inbox.published"
      : action.kind === "inbox.approve" ? "inbox.approved"
        : action.kind === "inbox.reject" ? "inbox.rejected"
          : action.kind === "inbox.withdraw" ? "inbox.withdrawn"
            : action.kind === "inbox.mark-stale" ? "inbox.marked-stale"
              : action.kind === "inbox.repair" ? "inbox.repaired"
                : null;
    const draft = "draftId" in action
      ? this.#inboxDrafts.find((candidate) => candidate.id === action.draftId)
      : undefined;
    const proposal = "proposalId" in action
      ? this.#inboxProposals.find((candidate) => candidate.ref.id === action.proposalId)
      : undefined;
    if ("proposalId" in action && proposal === undefined) {
      return Promise.reject(new Error("Fixture Inbox proposal not found."));
    }
    if ((action.kind === "inbox.approve"
      || action.kind === "inbox.reject"
      || action.kind === "inbox.withdraw"
      || action.kind === "inbox.mark-stale")
      && proposal?.state !== "pending") {
      return Promise.reject(new Error(`Fixture ${action.kind} requires a pending proposal.`));
    }
    if (action.kind === "inbox.repair" && proposal?.state !== "stale") {
      return Promise.reject(new Error("Fixture inbox.repair requires a stale proposal."));
    }
    const createdDraftId = action.kind === "inbox.draft.save"
      ? action.draftId ?? "inbox_00000000000000000000000000000002"
      : null;
    const publishedProposalId = "proposal_02000000000000000000001720";
    const localChanges = action.kind === "inbox.draft.save"
      ? [{
          namespace: "inbox-draft" as const,
          id: createdDraftId!,
          beforeRevision: draft?.revision ?? null,
          afterRevision: revision("6"),
          summary: draft === undefined ? "Create checkout-local Inbox draft." : "Update checkout-local Inbox draft.",
        }]
      : action.kind === "inbox.draft.delete" || action.kind === "inbox.publish"
        ? [{
            namespace: "inbox-draft" as const,
            id: action.draftId,
            beforeRevision: draft?.revision ?? revision("1"),
            afterRevision: null,
            summary: action.kind === "inbox.publish"
              ? "Remove the checkout-local draft after publishing."
              : "Remove the checkout-local Inbox draft.",
          }]
        : [];
    const changedKnowledge = proposal?.change;
    const knowledgePath = changedKnowledge?.kind === "knowledge.create"
      ? changedKnowledge.entityKind === "pattern"
        ? `.mex/patterns/${fixtureInboxCreatedSpecId}.md`
        : `.mex/context/${changedKnowledge.entityKind}-${fixtureInboxCreatedSpecId}.md`
      : changedKnowledge?.kind === "knowledge.update"
        ? wikiEntities.find((entity) => entity.id === changedKnowledge.target.id)?.location.path
          ?? `.mex/context/${changedKnowledge.target.kind}-${changedKnowledge.target.id}.md`
        : undefined;
    const primaryChanges: InboxOperationPreviewResponse["preview"]["changes"] = action.kind === "inbox.draft.save" || action.kind === "inbox.draft.delete"
      ? []
      : action.kind === "inbox.publish"
        ? [{
            kind: "create" as const,
            path: `.mex/inbox/${publishedProposalId}.md`,
            diff: `--- /dev/null\n+++ b/.mex/inbox/${publishedProposalId}.md\n+state: pending\n+title: ${draft?.title ?? "Published Spec proposal"}\n`,
            beforeRevision: null,
            afterRevision: revision("7"),
          }]
        : action.kind === "inbox.approve"
          ? [
            ...(isInboxCreate(proposal?.change) ? [{
              kind: "create" as const,
              path: knowledgePath ?? `.mex/specs/${fixtureInboxCreatedSpecId}.md`,
              diff: `--- /dev/null\n+++ b/${knowledgePath ?? `.mex/specs/${fixtureInboxCreatedSpecId}.md`}\n+title: ${proposal!.title}\n`,
              beforeRevision: null,
              afterRevision: revision("8"),
            }] : [{
              kind: "update" as const,
              path: knowledgePath ?? `.mex/specs/${fixtureInboxSpecId}.md`,
              diff: `--- a/${knowledgePath ?? `.mex/specs/${fixtureInboxSpecId}.md`}\n+++ b/${knowledgePath ?? `.mex/specs/${fixtureInboxSpecId}.md`}\n+The release gate records exact reviewed evidence.\n`,
              beforeRevision: revision("3"),
              afterRevision: revision("8"),
            }]), {
              kind: "update" as const,
              path: ".mex/events/operations.jsonl",
              diff: "--- a/.mex/events/operations.jsonl\n+++ b/.mex/events/operations.jsonl\n+{\"phase\":\"complete\",\"operation\":\"spec-authoring\"}\n",
              beforeRevision: revision("4"),
              afterRevision: revision("5"),
            }, {
              kind: "update" as const,
              path: proposal?.sourcePath ?? `.mex/inbox/${action.proposalId}.md`,
              diff: "--- proposal\n+++ proposal\n-state: pending\n+state: approved\n",
              beforeRevision: proposal?.revision ?? revision("2"),
              afterRevision: revision("9"),
            }]
          : [{
              kind: "update" as const,
              path: proposal?.sourcePath ?? `.mex/inbox/${action.proposalId}.md`,
              diff: `--- proposal\n+++ proposal\n-state: ${proposal?.state ?? "pending"}\n+state: ${action.kind === "inbox.reject" ? "rejected" : action.kind === "inbox.withdraw" ? "withdrawn" : action.kind === "inbox.mark-stale" ? "stale" : "pending"}\n`,
              beforeRevision: proposal?.revision ?? revision("2"),
              afterRevision: revision("9"),
            }];
    const activityChange: InboxOperationPreviewResponse["preview"]["changes"][number] | null = activityAction === null
      ? null
      : {
          kind: "create",
          path: `.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md`,
          diff: `--- /dev/null\n+++ b/.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md\n+action: ${activityAction}\n`,
          beforeRevision: null,
          afterRevision: revision("d"),
        };
    const changes = activityChange === null
      ? primaryChanges
      : [...primaryChanges, activityChange];
    const purposeIds: InboxOperationPreviewResponse["receipt"]["purposeIds"] = action.kind === "inbox.draft.save"
      ? draft === undefined
        ? [{ purpose: "inbox-draft", id: createdDraftId! }]
        : []
      : action.kind === "inbox.draft.delete"
        ? []
        : action.kind === "inbox.publish"
          ? [{ purpose: "activity", id: eventId }, { purpose: "proposal", id: publishedProposalId }]
          : action.kind === "inbox.approve"
            ? isInboxCreate(proposal?.change)
              ? [{ purpose: "activity", id: eventId }, { purpose: "spec-entity", id: fixtureInboxCreatedSpecId }]
              : [{ purpose: "activity", id: eventId }]
            : [{ purpose: "activity", id: eventId }];
    return Promise.resolve({
      schemaVersion: 1,
      request: structuredClone(request),
      preview: {
        valid: true,
        scope: action.kind === "inbox.draft.save" || action.kind === "inbox.draft.delete"
          ? "local"
          : action.kind === "inbox.publish"
            ? "mixed"
            : "canonical",
        changes,
        localChanges,
        diagnostics: [],
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: this.#currentActor().actor,
          occurredAt: timestamp(0),
          repoState: {
            branch: home.repository.branch,
            head: home.repository.head,
            dirty: home.repository.dirty,
            observedAt: timestamp(0),
          },
        },
        purposeIds,
        requestRevision: revision("a"),
        presentationRevision: revision("b"),
        previewRevision: revision("c"),
      },
    });
  }
  applyInboxOperation(
    envelope: InboxOperationApplyRequest,
  ): Promise<InboxOperationApplyResponse> {
    const action = envelope.request.action;
    let proposals: InboxProposalDetail[] = [];
    const activityId = envelope.receipt.purposeIds.find((item) => item.purpose === "activity")?.id;
    let event: TeamActivityEvent | null = null;
    if (action.kind === "inbox.draft.save") {
      const id = action.draftId ?? envelope.receipt.purposeIds.find((item) => item.purpose === "inbox-draft")?.id;
      if (id !== undefined) {
        const descriptor = isInboxCreate(action.draft.change)
          ? { entityKind: action.draft.change.entityKind, title: action.draft.change.title }
          : { entityKind: action.draft.change.target.kind, title: action.draft.change.target.title ?? action.draft.change.target.id };
        const next: InboxDraftDetail = {
          id,
          revision: envelope.preview.localChanges[0]?.afterRevision ?? revision("6"),
          updatedAt: envelope.receipt.authority.occurredAt,
          changeKind: action.draft.change.kind,
          ...descriptor,
          rationaleExcerpt: action.draft.rationale.slice(0, 240),
          input: structuredClone(action.draft),
        };
        const index = this.#inboxDrafts.findIndex((candidate) => candidate.id === id);
        if (index === -1) this.#inboxDrafts.unshift(next);
        else this.#inboxDrafts[index] = next;
      }
    } else if (action.kind === "inbox.draft.delete") {
      const index = this.#inboxDrafts.findIndex((candidate) => candidate.id === action.draftId);
      if (index !== -1) this.#inboxDrafts.splice(index, 1);
    } else if (action.kind === "inbox.publish") {
      const draft = this.#inboxDrafts.find((candidate) => candidate.id === action.draftId);
      const id = envelope.receipt.purposeIds.find((item) => item.purpose === "proposal")?.id;
      if (draft !== undefined && id !== undefined) {
        const proposal: InboxProposalDetail = {
          schemaVersion: 1,
          ref: { id, kind: "proposal", title: draft.title },
          sourcePath: `.mex/inbox/${id}.md`,
          revision: envelope.preview.changes[0]?.afterRevision ?? revision("7"),
          state: "pending",
          author: envelope.receipt.authority.actor,
          changeKind: draft.changeKind,
          entityKind: draft.entityKind,
          title: draft.title,
          rationaleExcerpt: draft.rationaleExcerpt,
          change: structuredClone(draft.input.change),
          rationale: draft.input.rationale,
          evidence: structuredClone(draft.input.evidence),
          targetRevisions: structuredClone(draft.input.targetRevisions),
        };
        this.#inboxProposals.unshift(proposal);
        proposals = [proposal];
        this.#inboxDrafts.splice(this.#inboxDrafts.indexOf(draft), 1);
      }
    } else {
      const index = this.#inboxProposals.findIndex((candidate) => candidate.ref.id === action.proposalId);
      const current = this.#inboxProposals[index];
      if (current !== undefined) {
        const { reviewer: _reviewer, reviewedAt: _reviewedAt, reviewRationale: _reviewRationale, ...withoutReview } = current;
        const proposalRevision = envelope.preview.changes.find((change) => (
          change.path === current.sourcePath
        ))?.afterRevision ?? revision("9");
        let updated: InboxProposalDetail;
        if (action.kind === "inbox.repair") {
          const descriptor = isInboxCreate(action.replacement.change)
            ? {
                entityKind: action.replacement.change.entityKind,
                title: action.replacement.change.title,
              }
            : {
                entityKind: action.replacement.change.target.kind,
                title: action.replacement.change.target.title ?? action.replacement.change.target.id,
              };
          updated = {
            ...withoutReview,
            state: "pending",
            revision: proposalRevision,
            changeKind: action.replacement.change.kind,
            ...descriptor,
            rationaleExcerpt: action.replacement.rationale.slice(0, 240),
            change: structuredClone(action.replacement.change),
            rationale: action.replacement.rationale,
            evidence: structuredClone(action.replacement.evidence),
            targetRevisions: structuredClone(action.replacement.targetRevisions),
          };
        } else if (action.kind === "inbox.mark-stale") {
          updated = {
            ...withoutReview,
            state: "stale",
            revision: proposalRevision,
          };
        } else {
          updated = {
            ...withoutReview,
            state: action.kind === "inbox.approve" ? "approved"
              : action.kind === "inbox.reject" ? "rejected"
                : "withdrawn",
            revision: proposalRevision,
            reviewer: envelope.receipt.authority.actor,
            reviewedAt: envelope.receipt.authority.occurredAt,
            ...((action.kind === "inbox.reject" || action.kind === "inbox.withdraw")
              && action.rationale !== undefined
              ? { reviewRationale: action.rationale }
              : {}),
          };
        }
        this.#inboxProposals[index] = updated;
        proposals = [updated];
      }
    }
    if (activityId !== undefined) {
      const actionName = action.kind === "inbox.publish" ? "inbox.published"
        : action.kind === "inbox.approve" ? "inbox.approved"
          : action.kind === "inbox.reject" ? "inbox.rejected"
            : action.kind === "inbox.withdraw" ? "inbox.withdrawn"
              : action.kind === "inbox.mark-stale" ? "inbox.marked-stale"
                : action.kind === "inbox.repair" ? "inbox.repaired"
                  : null;
      const proposalId = action.kind === "inbox.publish"
        ? envelope.receipt.purposeIds.find((item) => item.purpose === "proposal")?.id
        : "proposalId" in action ? action.proposalId : undefined;
      const subjectProposal = proposalId === undefined
        ? []
        : [{ kind: "entity" as const, entity: { id: proposalId, kind: "proposal" } }];
      const approvalTarget = action.kind !== "inbox.approve"
        ? []
        : isInboxCreate(proposals[0]?.change)
          ? [{
              kind: "entity" as const,
              entity: {
                id: envelope.receipt.purposeIds.find((item) => item.purpose === "spec-entity")?.id
                  ?? fixtureInboxCreatedSpecId,
                kind: proposals[0].change.entityKind,
              },
            }]
          : isInboxUpdate(proposals[0]?.change)
            ? [{ kind: "entity" as const, entity: structuredClone(proposals[0].change.target) }]
            : [];
      if (actionName !== null) {
        event = {
          schemaVersion: 2,
          id: activityId,
          timestamp: envelope.receipt.authority.occurredAt,
          actor: envelope.receipt.authority.actor,
          action: actionName,
          origin: { kind: "workflow", operation: action.kind },
          ...(proposals[0]?.title === undefined ? {} : { label: proposals[0].title }),
          subjects: [...subjectProposal, ...approvalTarget],
          workstream: null,
          repoState: envelope.receipt.authority.repoState,
        };
        this.#activityItems.unshift(fixtureTimelineEvent(event));
      }
    }
    return Promise.resolve({
      operationId: envelope.request.operationId,
      previewRevision: envelope.receipt.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: envelope.preview.changes,
      localChanges: envelope.preview.localChanges,
      proposals,
      events: event === null ? [] : [event],
    });
  }
  previewTeamOperation(
    request: TeamOperationPreviewRequest,
  ): Promise<TeamOperationPreviewResponse> {
    const sequence = this.#previewSequence++;
    const eventId = fixtureOperationId("event", sequence);
    const memberId = request.action.kind === "member.add"
      ? fixtureOperationId("member", sequence)
      : request.action.kind === "member.update"
        || request.action.kind === "member.deactivate"
        || request.action.kind === "member.reactivate"
        || request.action.kind === "member.select"
        ? request.action.memberId
        : null;
    const workstreamId = request.action.kind === "workstream.create"
      ? fixtureOperationId("ws", sequence)
      : request.action.kind === "workstream.update" || request.action.kind === "workstream.archive"
        ? request.action.workstreamId
        : null;
    const currentMember = memberId === null
      ? null
      : this.#members.find((member) => member.id === memberId) ?? null;
    const currentWorkstream = workstreamId === null
      ? null
      : this.#workstreams.find((workstream) => workstream.id === workstreamId) ?? null;
    const canonical = request.action.kind === "member.add"
      || request.action.kind === "member.update"
      || request.action.kind === "member.deactivate"
      || request.action.kind === "member.reactivate"
      || request.action.kind === "workstream.create"
      || request.action.kind === "workstream.update"
      || request.action.kind === "workstream.archive"
      || request.action.kind === "activity.record";
    const sourcePath = request.action.kind === "activity.record"
      ? `.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md`
      : workstreamId !== null ? `.mex/workstreams/${workstreamId}.md`
      : memberId === null ? null : `.mex/team/members/${memberId}.md`;
    const afterRevision = request.action.kind === "member.add" || request.action.kind === "workstream.create"
      ? revision("e")
      : request.action.kind === "member.update" || request.action.kind === "member.deactivate"
        || request.action.kind === "member.reactivate"
        || request.action.kind === "workstream.update" || request.action.kind === "workstream.archive"
        ? revision("f")
        : revision("9");
    const createsArtifact = request.action.kind === "member.add"
      || request.action.kind === "workstream.create"
      || request.action.kind === "activity.record";
    const diff = request.action.kind === "activity.record"
      ? `--- /dev/null\n+++ b/${sourcePath}\n+action: ${request.action.activity.action}\n`
      : workstreamId !== null
        ? `--- a/${sourcePath}\n+++ b/${sourcePath}\n+reviewed Workstream change\n`
      : `--- a/${sourcePath}\n+++ b/${sourcePath}\n+reviewed member change\n`;
    const changes: TeamOperationPreviewResponse["preview"]["changes"] = !canonical || sourcePath === null
      ? []
      : createsArtifact
        ? [{ kind: "create", path: sourcePath, beforeRevision: null, afterRevision, diff }]
        : [{
          kind: "update",
          path: sourcePath,
          beforeRevision: currentWorkstream?.revision ?? currentMember?.revision ?? revision("0"),
          afterRevision,
          diff,
        }];
    const localChanges = request.action.kind === "member.select" ? [{
      namespace: "member-selection" as const,
      id: "current" as const,
      beforeRevision: this.#selection?.revision ?? null,
      afterRevision: revision("e"),
      summary: `Select ${currentMember?.displayName ?? memberId} for this checkout`,
    }] : request.action.kind === "member.clear" ? [{
      namespace: "member-selection" as const,
      id: "current" as const,
      beforeRevision: this.#selection?.revision ?? null,
      afterRevision: null,
      summary: "Clear the configured member for this checkout",
    }] : [];
    const purposeIds = [
      ...(canonical ? [{ purpose: "activity" as const, id: eventId }] : []),
      ...(request.action.kind === "member.add" && memberId !== null
        ? [{ purpose: "member" as const, id: memberId }] : []),
      ...(request.action.kind === "workstream.create" && workstreamId !== null
        ? [{ purpose: "workstream" as const, id: workstreamId }] : []),
    ];
    return Promise.resolve({
      schemaVersion: 1,
      request: structuredClone(request),
      preview: {
        valid: true,
        scope: canonical ? "canonical" : "local",
        changes,
        localChanges,
        diagnostics: [],
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: this.#currentActor().actor,
          occurredAt: timestamp(0),
          repoState: {
            branch: home.repository.branch,
            head: home.repository.head,
            dirty: home.repository.dirty,
            observedAt: timestamp(0),
          },
        },
        purposeIds,
        requestRevision: revision("1"),
        presentationRevision: revision("2"),
        previewRevision: revision("3"),
      },
    });
  }
  applyTeamOperation(
    envelope: TeamOperationApplyRequest,
  ): Promise<TeamOperationApplyResponse> {
    const { action } = envelope.request;
    const memberPurpose = envelope.receipt.purposeIds.find((item) => item.purpose === "member");
    const workstreamPurpose = envelope.receipt.purposeIds.find((item) => item.purpose === "workstream");
    const eventPurpose = envelope.receipt.purposeIds.find((item) => item.purpose === "activity");
    let member: TeamMember | null = null;
    let workstream: TeamWorkstream | null = null;
    if (action.kind === "member.add" && memberPurpose?.purpose === "member") {
      member = {
        schemaVersion: 1,
        id: memberPurpose.id,
        displayName: action.member.displayName,
        gitAliases: action.member.gitAliases,
        active: true,
        sourcePath: `.mex/team/members/${memberPurpose.id}.md`,
        revision: envelope.preview.changes[0]?.afterRevision ?? revision("e"),
      };
      this.#members.push(member);
    } else if (action.kind === "member.update" || action.kind === "member.deactivate" || action.kind === "member.reactivate") {
      const index = this.#members.findIndex((candidate) => candidate.id === action.memberId);
      const current = this.#members[index];
      if (current !== undefined) {
        member = {
          ...current,
          ...(action.kind === "member.update" ? action.patch : { active: action.kind === "member.reactivate" }),
          revision: envelope.preview.changes[0]?.afterRevision ?? revision("f"),
        };
        this.#members[index] = member;
      }
    } else if (action.kind === "member.select") {
      this.#selection = {
        memberId: action.memberId,
        updatedAt: envelope.receipt.authority.occurredAt,
        revision: envelope.preview.localChanges[0]?.afterRevision ?? revision("e"),
      };
    } else if (action.kind === "member.clear") {
      this.#selection = null;
    } else if (action.kind === "workstream.create" && workstreamPurpose?.purpose === "workstream") {
      workstream = {
        schemaVersion: 1,
        id: workstreamPurpose.id,
        entityRevision: 1,
        title: action.workstream.title,
        goal: action.workstream.goal,
        summary: action.workstream.summary,
        state: "planned",
        owners: action.workstream.owners,
        contributors: action.workstream.contributors ?? [],
        paths: action.workstream.paths ?? [],
        code: action.workstream.code ?? [],
        topics: action.workstream.topics ?? [],
        components: action.workstream.components ?? [],
        related: action.workstream.related ?? [],
        blockers: [],
        currentState: "Planned",
        nextMilestone: action.workstream.nextMilestone,
        createdBy: envelope.receipt.authority.actor,
        createdAt: envelope.receipt.authority.occurredAt,
        updatedBy: envelope.receipt.authority.actor,
        updatedAt: envelope.receipt.authority.occurredAt,
        sourcePath: `.mex/workstreams/${workstreamPurpose.id}.md`,
        revision: envelope.preview.changes[0]?.afterRevision ?? revision("e"),
      };
      this.#workstreams.unshift(workstream);
    } else if (action.kind === "workstream.update" || action.kind === "workstream.archive") {
      const index = this.#workstreams.findIndex((candidate) => candidate.id === action.workstreamId);
      const current = this.#workstreams[index];
      if (current !== undefined) {
        const patch = action.kind === "workstream.update"
          ? action.patch
          : { state: "archived" as const, blockers: [] };
        workstream = {
          ...current,
          ...patch,
          entityRevision: current.entityRevision + 1,
          updatedBy: envelope.receipt.authority.actor,
          updatedAt: envelope.receipt.authority.occurredAt,
          revision: envelope.preview.changes[0]?.afterRevision ?? revision("f"),
        };
        this.#workstreams[index] = workstream;
      }
    }

    let event: TeamActivityEvent | null = null;
    if (eventPurpose?.purpose === "activity") {
      const direct = action.kind === "activity.record" ? action.activity : null;
      const eventMember = member ?? (
        action.kind === "member.update" || action.kind === "member.deactivate" || action.kind === "member.reactivate"
          ? this.#members.find((candidate) => candidate.id === action.memberId) ?? null
          : null
      );
      const eventAction = action.kind === "member.add" ? "member.added"
        : action.kind === "member.update" ? "member.updated"
          : action.kind === "member.deactivate" ? "member.deactivated"
          : action.kind === "member.reactivate" ? "member.reactivated"
            : action.kind === "workstream.create" ? "workstream.created"
              : action.kind === "workstream.update" ? "workstream.updated"
                : action.kind === "workstream.archive" ? "workstream.archived"
            : direct?.action ?? "activity.recorded";
      const eventSubjects: TeamActivitySubjectInput[] = direct?.subjects ?? (
        workstream !== null ? [{
          kind: "entity",
          entity: { id: workstream.id, kind: "workstream", title: workstream.title },
        }] : eventMember === null ? [] : [{
          kind: "entity",
          entity: { id: eventMember.id, kind: "member", title: eventMember.displayName },
        }]
      );
      event = {
        schemaVersion: 2,
        id: eventPurpose.id,
        timestamp: envelope.receipt.authority.occurredAt,
        actor: envelope.receipt.authority.actor,
        action: eventAction,
        origin: direct === null
          ? { kind: "workflow", operation: action.kind }
          : { kind: "custom" },
        ...(
          direct !== null
            ? {}
            : eventMember !== null
              ? { label: eventMember.displayName }
              : workstream !== null
                ? { label: workstream.title }
                : {}
        ),
        subjects: eventSubjects,
        workstream: direct?.workstream ?? (workstream === null
          ? null
          : { id: workstream.id, kind: "workstream", title: workstream.title }),
        repoState: envelope.receipt.authority.repoState,
      };
      this.#activityItems.unshift(fixtureTimelineEvent(event));
    }
    return Promise.resolve({
      operationId: envelope.request.operationId,
      previewRevision: envelope.receipt.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: envelope.preview.changes,
      localChanges: envelope.preview.localChanges,
      members: member === null ? [] : [member],
      workstreams: workstream === null ? [] : [workstream],
      events: event === null ? [] : [event],
    });
  }
  getActivity(request: ActivityRequest): Promise<ActivityResponse> {
    const since = request.since ? Date.parse(request.since) : null;
    const filtered = this.#activityItems.filter((item) => (
      (request.source === undefined || item.source === request.source)
      && (since === null || Date.parse(item.timestamp) >= since)
    ));
    const parsedOffset = request.cursor?.match(/^fixture_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const pageSize = Math.min(request.limit, 4);
    const items = filtered.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length ? `fixture_${nextOffset}` : null;
    const includeLegacyDiagnostic = request.source !== "activity"
      && this.#activityFixture !== "empty"
      && this.#activityFixture !== "legacy";
    return Promise.resolve({
      items,
      nextCursor,
      hasMore: nextCursor !== null,
      sourceTruncated: this.#activityFixture === "partial",
      deterministicRevision: revision(request.source === "legacy" ? "8" : request.source === "activity" ? "9" : "7"),
      diagnostics: includeLegacyDiagnostic
        ? [{
            code: "LEGACY_ACTIVITY_MALFORMED",
            severity: "warning",
            message: "One malformed legacy row was excluded while valid history was retained.",
            path: ".mex/events/decisions.jsonl",
          }]
        : [],
      diagnosticsTruncated: this.#activityFixture === "partial",
    });
  }
  search(request: SearchRequest) { return Promise.resolve(searchResponse(request)); }
  getCodeSymbol(id: string, request: CodeWorkspaceRequest) { return Promise.resolve(codeWorkspace(id, request)); }
  listSpecs(request: SpecListRequest): Promise<SpecListResponse> {
    const roots = fixtureSpecSummaries.filter((item) => (
      item.kind === "spec"
      && (request.includeArchived === true || item.lifecycleState !== "archived")
      && (request.lifecycleStates === undefined || request.lifecycleStates.includes(item.lifecycleState))
      && (request.groundingHealth === undefined || request.groundingHealth.includes(item.groundingHealth))
      && (request.topics === undefined || request.topics.every((topic) => item.topics.includes(topic)))
    ));
    const parsedOffset = request.cursor?.match(/^fixture_specs_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const items = roots.slice(offset, offset + request.limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < roots.length ? `fixture_specs_${nextOffset}` : null;
    return Promise.resolve({
      availability: "ready",
      index: fixtureSpecIndex,
      page: {
        schemaVersion: 1,
        items: structuredClone(items),
        nextCursor,
        truncated: nextCursor !== null,
        estimatedTokens: 180 * items.length,
        deterministicRevision: revision("f"),
      },
    });
  }
  getSpec(id: string): Promise<SpecDetailResponse> {
    try {
      return Promise.resolve(fixtureSpecDetail(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  wikiGraph(): Promise<WikiGraphResponse> {
    const relations = wikiEntities.flatMap((entity) => [...wikiRelations(entity.id).items.map((hit) => hit.relation), ...wikiBacklinks(entity.id).items]);
    return Promise.resolve({ indexedRevision: wikiRevision, observedAt: timestamp(0), nodes: wikiEntities,
      relations: [...new Map(relations.map((edge) => [`${edge.source.id}:${edge.target.id}:${edge.type}`, edge])).values()],
      coverage: { nodeLimit: 100, relationLimit: 500, nodesTruncated: false, relationsTruncated: false } });
  }
  getWikiGroundedCode(id: string): Promise<WikiGroundedCodeResponse> {
    const detail = wikiDetail(id);
    return Promise.resolve({ indexedRevision: wikiRevision, observedAt: timestamp(0), entityId: id, graphRevision,
      groundings: detail.groundings.items.flatMap((grounding) => grounding.requestedNode ? [{
        requestedNode: grounding.requestedNode, resolvedNode: grounding.resolvedNode, health: grounding.health,
        symbol: graphSymbols.find((symbol) => symbol.id === grounding.resolvedNode) ?? null,
      }] : []), truncated: detail.groundings.truncated });
  }
  listWikiEntities(request: WikiEntityListRequest): Promise<WikiEntityListResponse> {
    const filtered = wikiEntities.filter((entity) => (
      (!request.kind || entity.kind === request.kind)
      && (!request.topic || entity.topics.includes(request.topic))
      && (!request.lifecycle || entity.lifecycleState === request.lifecycle)
      && (!request.grounding || entity.groundingHealth === request.grounding)
      && (!request.sourceType || entity.sourceTypes.includes(request.sourceType))
    ));
    const offset = request.cursor === "fixture_wiki_2" ? 2 : 0;
    const pageSize = Math.min(request.limit, 2);
    const items = filtered.slice(offset, offset + pageSize);
    const hasMore = offset + items.length < filtered.length;
    return Promise.resolve({
      indexedRevision: wikiRevision,
      observedAt: timestamp(0),
      items,
      nextCursor: hasMore ? "fixture_wiki_2" : null,
      truncated: hasMore,
    });
  }
  getWikiEntity(id: string): Promise<WikiEntityDetailResponse> {
    try {
      return Promise.resolve(wikiDetail(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  getWikiRelations(id: string, _request: WikiRelationsRequest) { return Promise.resolve(wikiRelations(id)); }
  getWikiBacklinks(id: string, _request: WikiBacklinksRequest) { return Promise.resolve(wikiBacklinks(id)); }
  getCodeKnowledge(id: string, _request: CodeKnowledgeRequest): Promise<CodeKnowledgeResponse> {
    return Promise.resolve({
      indexedRevision: wikiRevision,
      observedAt: timestamp(0),
      items: id === "sym.createHubServer" ? [{ entity: wikiEntities[0], matchedNodes: [id] }] : [],
      nextCursor: null,
      truncated: false,
    });
  }
  getHealth() { return Promise.resolve(health); }
  getJobs(): Promise<JobsResponse> { return Promise.resolve({ items: [...this.#jobs], nextCursor: null }); }
  getJob(id: string) { return Promise.resolve(this.#jobs.find((job) => job.id === id) ?? this.#jobs[0]); }
  startJob(request: StartJobRequest) {
    const job: JobSummary = {
      id: "job_01K36ZZZ6H7JK8M9NPQRSTVVWX",
      scaffoldId: "scf_mex",
      kind: request.kind,
      generation: 15,
      phase: "queued",
      progress: null,
      state: "queued",
      cancelRequested: false,
      createdAt: new Date().toISOString(),
      revision: revision("e"),
    };
    this.#jobs.unshift(job);
    return Promise.resolve(job);
  }
  cancelJob(id: string) {
    const job = this.#jobs.find((candidate) => candidate.id === id) ?? this.#jobs[0];
    Object.assign(job, { cancelRequested: true, phase: "running" });
    return Promise.resolve(job);
  }
  subscribeToJob(): JobSubscription { return { close() {} }; }
}

export function createFixtureApi(options: FixtureApiOptions = {}): HubApi {
  return new FixtureHubApi(options);
}
