import { z } from "zod";
import {
  GraphSymbolIdSchema,
  InboxProposalIdSchema,
  RelayIdSchema,
  TeamMemberIdSchema,
  WikiEntityIdSchema,
} from "./ids.js";

export {
  GraphSymbolIdSchema,
  InboxProposalIdSchema,
  RelayIdSchema,
  TeamMemberIdSchema,
  WikiEntityIdSchema,
} from "./ids.js";

export const HUB_API_VERSION = "v1" as const;

export const HUB_LIMITS = {
  maxMutationBodyBytes: 64 * 1024,
  maxQueryCharacters: 256,
  maxCursorBytes: 4 * 1024,
  maxQueryStringBytes: 16 * 1024,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxSearchGroupSize: 50,
  maxJsonResponseBytes: 1024 * 1024,
  maxIdentifierCharacters: 128,
  maxDiagnosticCount: 50,
} as const;

export const HUB_PROBLEM_CODES = [
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "REVISION_CONFLICT",
  "INDEX_MISSING",
  "INDEX_STALE",
  "INDEX_CORRUPT",
  "MIGRATION_REQUIRED",
  "PATH_OUTSIDE_PROJECT",
  "JOB_ALREADY_RUNNING",
  "JOB_FAILED",
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "ORIGIN_REJECTED",
  "CAPABILITY_UNAVAILABLE",
  "OPERATION_INTERRUPTED",
  "RATE_LIMITED",
  "RESPONSE_TOO_LARGE",
  "INTERNAL_ERROR",
] as const;

export const HUB_JOB_KINDS = [
  "graph_refresh",
  "graph_rebuild",
  "wiki_refresh",
  "wiki_rebuild",
] as const;

export const HUB_JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
] as const;

export const HUB_JOB_PHASES = [
  "queued",
  "running",
  "refreshing",
  "rebuilding",
  "finalizing",
  "discover",
  "stage",
  "parse",
  "resolve",
  "validate",
  "publish",
  "complete",
  "failed",
  "interrupted",
] as const;

const isoTimestamp = z.string().datetime({ offset: true });
const boundedReason = z.string().trim().min(1).max(512);
const cursor = z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= HUB_LIMITS.maxCursorBytes,
  "Cursor exceeds the maximum encoded size.",
);
const identifier = z.string().min(1).max(HUB_LIMITS.maxIdentifierCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Identifier contains unsafe characters.");
const scaffoldId = z.string().min(1).max(512)
  .refine((value) => !/[\0-\x1f\x7f]/.test(value), "Scaffold ID contains control characters.");
const hubJobId = z.string()
  .regex(/^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Hub job ID.");
const revision = z.string().regex(/^[a-f0-9]{64}$/, "Invalid SHA-256 revision.");

export const AgentLoggingModeSchema = z.enum(["significant", "checkpoints", "manual"]);
export const AgentLoggingPolicySchema = z.discriminatedUnion("source", [
  z.object({ mode: z.literal("significant"), revision: z.null(), source: z.literal("default") }).strict(),
  z.object({ mode: AgentLoggingModeSchema, revision, source: z.literal("local") }).strict(),
]);
export const AgentLoggingUpdateRequestSchema = z.object({
  mode: AgentLoggingModeSchema,
  expectedRevision: revision.nullable(),
}).strict();
export type AgentLoggingMode = z.infer<typeof AgentLoggingModeSchema>;
export type AgentLoggingPolicy = z.infer<typeof AgentLoggingPolicySchema>;
export type AgentLoggingUpdateRequest = z.infer<typeof AgentLoggingUpdateRequestSchema>;
export const HubOnboardingStateSchema = z.object({ completed: z.boolean() }).strict();
export const HubOnboardingCompleteRequestSchema = z.object({ completed: z.literal(true) }).strict();
export type HubOnboardingState = z.infer<typeof HubOnboardingStateSchema>;
export type HubOnboardingCompleteRequest = z.infer<typeof HubOnboardingCompleteRequestSchema>;

/** Shared primitives for route-private contract entry points. */
export const HubIsoTimestampSchema = isoTimestamp;
export const HubBoundedReasonSchema = boundedReason;
export const HubRevisionSchema = revision;
const utf8Text = (maximum: number, minimum = 1) => z.string().min(minimum).max(maximum).refine(
  (value) => new TextEncoder().encode(value).byteLength <= maximum,
  `Text exceeds the ${maximum}-byte display limit.`,
);
const activityDisplayPath = utf8Text(384).refine((value) => {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;
  if (value.normalize("NFC") !== value || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "Path must be a safe repository-relative POSIX path.");
const repositoryDisplayPath = utf8Text(1_024).refine((value) => {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;
  if (value.normalize("NFC") !== value || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "Path must be a safe repository-relative POSIX path.");

export const HubProblemCodeSchema = z.enum(HUB_PROBLEM_CODES);

export const HubDiagnosticSchema = z.object({
  code: z.string().min(1).max(128),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().min(1).max(2_048),
  path: z.string().min(1).max(4_096).optional(),
}).strict();

/** RFC 9457 problem details plus stable local MEX fields. */
export const HubProblemDetailsSchema = z.object({
  type: z.string().min(1).max(2_048).default("about:blank"),
  title: z.string().min(1).max(256),
  status: z.number().int().min(400).max(599),
  code: HubProblemCodeSchema,
  detail: z.string().min(1).max(4_096),
  instance: z.string().min(1).max(4_096).optional(),
  requestId: z.string().uuid(),
  activeJobId: hubJobId.optional(),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount).optional(),
}).strict();

export const CapabilityStatusSchema = z.object({
  availability: z.enum(["available", "unavailable"]),
  reason: boundedReason.optional(),
}).strict().superRefine((value, context) => {
  if (value.availability === "unavailable" && value.reason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "Unavailable capabilities require a reason.",
    });
  }
  if (value.availability === "available" && value.reason !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "Available capabilities cannot carry an unavailable reason.",
    });
  }
});

export const HubCapabilitiesSchema = z.object({
  apiVersion: z.literal(HUB_API_VERSION),
  git: CapabilityStatusSchema,
  activity: CapabilityStatusSchema,
  activityRecord: CapabilityStatusSchema,
  members: z.object({
    read: CapabilityStatusSchema,
    canonicalMutation: CapabilityStatusSchema,
    localSelection: CapabilityStatusSchema,
  }).strict(),
  workstreams: z.object({
    read: CapabilityStatusSchema,
    canonicalMutation: CapabilityStatusSchema,
  }).strict(),
  specs: z.object({
    read: CapabilityStatusSchema,
  }).strict(),
  inbox: z.object({
    read: CapabilityStatusSchema,
    draftMutation: CapabilityStatusSchema,
    proposalMutation: CapabilityStatusSchema,
    specApproval: CapabilityStatusSchema,
  }).strict(),
  relays: z.object({
    read: CapabilityStatusSchema,
    draftMutation: CapabilityStatusSchema,
    publish: CapabilityStatusSchema,
    lifecycleMutation: CapabilityStatusSchema,
  }).strict(),
  jobs: CapabilityStatusSchema,
  graph: z.object({
    read: CapabilityStatusSchema,
    refresh: CapabilityStatusSchema,
    rebuild: CapabilityStatusSchema,
  }).strict(),
  wiki: z.object({
    read: CapabilityStatusSchema,
    refresh: CapabilityStatusSchema,
    rebuild: CapabilityStatusSchema,
  }).strict(),
}).strict();

export const HubActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("member"),
    memberId: identifier,
    displayName: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("git"),
    name: z.string().min(1).max(256).nullable(),
    email: z.string().min(1).max(320).nullable(),
  }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "git" && value.name === null && value.email === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Git actor requires a name or email.",
    });
  }
});

export const HubRepositoryContextSchema = z.object({
  scaffoldId,
  name: z.string().min(1).max(256),
  branch: z.string().min(1).max(1_024).nullable(),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  dirty: z.boolean(),
}).strict();

export const HubSectionSummarySchema = z.object({
  availability: z.enum(["available", "unavailable"]),
  count: z.number().int().nonnegative().nullable(),
  reason: boundedReason.optional(),
}).strict().superRefine((value, context) => {
  if (value.availability === "unavailable") {
    if (value.count !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["count"],
        message: "Unavailable sections cannot report a count.",
      });
    }
    if (value.reason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Unavailable sections require a reason.",
      });
    }
  } else if (value.count === null || value.reason !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Available sections require a count and no unavailable reason.",
    });
  }
});

export const HubAttentionItemSchema = z.object({
  id: identifier,
  kind: z.enum(["health", "job", "activity"]),
  title: z.string().min(1).max(256),
  summary: z.string().min(1).max(1_024),
  tone: z.enum(["neutral", "warning", "critical"]),
  route: z.string().startsWith("/").max(2_048),
}).strict();

const homeUnavailable = z.object({
  availability: z.literal("unavailable"),
  reason: boundedReason,
}).strict();

const homeAvailable = <Shape extends z.ZodRawShape>(shape: Shape) => (
  z.discriminatedUnion("availability", [
    z.object({ availability: z.literal("available"), ...shape }).strict(),
    homeUnavailable,
  ])
);

export const HomeInboxAttentionSchema = homeAvailable({
  teamReviewCount: z.number().int().nonnegative(),
});

export const HomeRelayAttentionSchema = homeAvailable({
  readyToTakeCount: z.number().int().nonnegative(),
  inYourHandsCount: z.number().int().nonnegative(),
});

export const HomeJobsSummarySchema = homeAvailable({
  activeCount: z.number().int().nonnegative(),
});

/** Lightweight shell projection used by HubLayout on non-Overview routes. */
export const HomeResponseSchema = z.object({
  observedAt: isoTimestamp,
  repository: HubRepositoryContextSchema,
  actor: HubActorSchema,
  attention: z.object({
    inbox: HomeInboxAttentionSchema,
    relays: HomeRelayAttentionSchema,
  }).strict(),
  jobs: HomeJobsSummarySchema,
}).strict();

const teamMemberId = TeamMemberIdSchema;
const teamEventId = z.string()
  .regex(/^event_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Activity event ID.");
const teamWorkstreamId = z.string()
  .regex(/^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Workstream ID.");
const teamOperationId = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "Invalid team operation ID.");
const gitObjectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const teamText = (maximum: number) => utf8Text(maximum).refine(
  (value) => value.trim() === value
    && value.normalize("NFC") === value
    && !/[\u0000-\u001f\u007f]/.test(value),
  "Text must be trimmed canonical Unicode without control characters.",
);
const jsonByteLength = (value: unknown) => new TextEncoder()
  .encode(JSON.stringify(value)).byteLength;
const teamActivityAction = teamText(128).refine(
  (value) => /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value),
  "Activity action must be a lower-case namespaced identifier.",
);
const teamRepositoryPath = utf8Text(4_096).refine((value) => {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;
  if (value.normalize("NFC") !== value
    || inboxHasLoneSurrogate(value)
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    return false;
  }
  return value.split("/").every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}, "Path must be a safe repository-relative POSIX path.");

export const TeamWorkstreamIdSchema = teamWorkstreamId;

export const TeamGitAliasSchema = z.object({
  name: teamText(200).nullable(),
  email: teamText(320).nullable(),
}).strict().superRefine((value, context) => {
  if (value.name === null && value.email === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Git alias requires a name or email.",
    });
  }
  if (value.email !== null && (!value.email.includes("@") || /\s/.test(value.email))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["email"],
      message: "The Git alias email is invalid.",
    });
  }
});

export const TeamMemberSchema = z.object({
  schemaVersion: z.literal(1),
  id: teamMemberId,
  displayName: teamText(200),
  gitAliases: z.array(TeamGitAliasSchema).max(32),
  active: z.boolean(),
  sourcePath: teamRepositoryPath,
  revision,
}).strict().superRefine((value, context) => {
  if (value.sourcePath !== `.mex/team/members/${value.id}.md`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourcePath"],
      message: "Member source path must match its ID.",
    });
  }
});

const teamActiveFilter = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const TeamMemberListRequestSchema = z.object({
  active: teamActiveFilter.optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const TeamMemberListResponseSchema = z.object({
  items: z.array(TeamMemberSchema).max(HUB_LIMITS.maxPageSize),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
  sourceTruncated: z.boolean(),
  deterministicRevision: revision,
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.truncated !== (value.nextCursor !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["truncated"],
      message: "Member page truncation must match cursor presence.",
    });
  }
});

export const TeamActorRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("member"),
    memberId: teamMemberId,
    displayName: teamText(200).optional(),
  }).strict(),
  z.object({
    kind: z.literal("git"),
    name: teamText(200).nullable(),
    email: teamText(320).nullable(),
  }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "git" && value.name === null && value.email === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Git actor requires a name or email.",
    });
  }
});

export const TeamCurrentActorResponseSchema = z.object({
  actor: TeamActorRefSchema,
  source: z.enum(["configured-member", "git-alias", "git-fallback", "unknown"]),
  selection: z.object({
    memberId: teamMemberId,
    updatedAt: isoTimestamp,
    revision,
  }).strict().nullable(),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
}).strict();

const teamEntityRef = z.object({
  id: teamText(256),
  kind: teamText(64),
  title: teamText(512).optional(),
}).strict();

const teamWorkstreamRef = z.object({
  id: teamWorkstreamId,
  kind: z.literal("workstream"),
  title: teamText(512).optional(),
}).strict();

const teamCodeRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("symbol"),
    symbolId: teamText(1_024),
    fingerprint: teamText(1_024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("file"),
    path: teamRepositoryPath,
    fingerprint: teamText(1_024).optional(),
  }).strict(),
]);

export const TeamWorkstreamStateSchema = z.enum([
  "planned",
  "active",
  "blocked",
  "done",
  "archived",
]);

const teamActorSet = z.array(TeamActorRefSchema).max(64);
const teamEntitySet = z.array(teamEntityRef).max(64);
const teamCodeSet = z.array(teamCodeRef).max(64);
const teamPathSet = z.array(teamRepositoryPath).max(64);
const teamTextSet = z.array(teamText(4 * 1024)).max(64);

export const TeamWorkstreamSchema = z.object({
  schemaVersion: z.literal(1),
  id: teamWorkstreamId,
  entityRevision: z.number().int().positive(),
  title: teamText(512),
  goal: teamText(4 * 1024),
  summary: teamText(4 * 1024),
  state: TeamWorkstreamStateSchema,
  owners: teamActorSet.min(1),
  contributors: teamActorSet,
  paths: teamPathSet,
  code: teamCodeSet,
  topics: teamEntitySet,
  components: teamEntitySet,
  related: teamEntitySet,
  blockers: teamTextSet,
  currentState: teamText(8 * 1024),
  nextMilestone: teamText(4 * 1024),
  createdBy: TeamActorRefSchema,
  createdAt: isoTimestamp,
  updatedBy: TeamActorRefSchema,
  updatedAt: isoTimestamp,
  sourcePath: teamRepositoryPath,
  revision,
}).strict().superRefine((value, context) => {
  if (value.sourcePath !== `.mex/workstreams/${value.id}.md`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourcePath"],
      message: "Workstream source path must match its ID.",
    });
  }
  if ((value.state === "blocked") !== (value.blockers.length > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blockers"],
      message: "Blocked Workstreams require blockers, and other states cannot retain them.",
    });
  }
  if (value.createdAt > value.updatedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["updatedAt"],
      message: "Workstream update time cannot precede its creation time.",
    });
  }
});

const teamBooleanFilter = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const TeamWorkstreamListRequestSchema = z.object({
  state: TeamWorkstreamStateSchema.optional(),
  includeArchived: teamBooleanFilter.optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const TeamWorkstreamListResponseSchema = z.object({
  items: z.array(TeamWorkstreamSchema).max(HUB_LIMITS.maxPageSize),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
  sourceTruncated: z.boolean(),
  deterministicRevision: revision,
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.truncated !== (value.nextCursor !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["truncated"],
      message: "Workstream page truncation must match cursor presence.",
    });
  }
});

export const TeamActivitySubjectInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entity: teamEntityRef }).strict(),
  z.object({ kind: z.literal("code"), code: teamCodeRef }).strict(),
  z.object({ kind: z.literal("file"), path: teamRepositoryPath }).strict(),
  z.object({ kind: z.literal("commit"), hash: gitObjectId }).strict(),
]);

const teamMemberAddAction = z.object({
  kind: z.literal("member.add"),
  member: z.object({
    displayName: teamText(200),
    gitAliases: z.array(TeamGitAliasSchema).max(32),
  }).strict(),
}).strict();

const teamMemberUpdateAction = z.object({
  kind: z.literal("member.update"),
  memberId: teamMemberId,
  patch: z.object({
    displayName: teamText(200).optional(),
    gitAliases: z.array(TeamGitAliasSchema).max(32).optional(),
  }).strict().refine(
    (value) => value.displayName !== undefined || value.gitAliases !== undefined,
    "A member update requires at least one supported field.",
  ),
}).strict();

const teamWorkstreamCreateInput = z.object({
  title: teamText(512),
  goal: teamText(4 * 1024),
  summary: teamText(4 * 1024),
  owners: teamActorSet.min(1),
  contributors: teamActorSet.optional(),
  paths: teamPathSet.optional(),
  code: teamCodeSet.optional(),
  topics: teamEntitySet.optional(),
  components: teamEntitySet.optional(),
  related: teamEntitySet.optional(),
  nextMilestone: teamText(4 * 1024),
}).strict();

const teamWorkstreamUpdatePatch = z.object({
  title: teamText(512).optional(),
  goal: teamText(4 * 1024).optional(),
  summary: teamText(4 * 1024).optional(),
  state: z.enum(["planned", "active", "blocked", "done"]).optional(),
  owners: teamActorSet.min(1).optional(),
  contributors: teamActorSet.optional(),
  paths: teamPathSet.optional(),
  code: teamCodeSet.optional(),
  topics: teamEntitySet.optional(),
  components: teamEntitySet.optional(),
  related: teamEntitySet.optional(),
  blockers: teamTextSet.optional(),
  currentState: teamText(8 * 1024).optional(),
  nextMilestone: teamText(4 * 1024).optional(),
}).strict().refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  "A Workstream update requires at least one supported field.",
);

const teamIdentityActivityAction = z.discriminatedUnion("kind", [
  teamMemberAddAction,
  teamMemberUpdateAction,
  z.object({ kind: z.literal("member.deactivate"), memberId: teamMemberId }).strict(),
  z.object({ kind: z.literal("member.reactivate"), memberId: teamMemberId }).strict(),
  z.object({ kind: z.literal("member.select"), memberId: teamMemberId }).strict(),
  z.object({ kind: z.literal("member.clear") }).strict(),
  z.object({
    kind: z.literal("workstream.create"),
    workstream: teamWorkstreamCreateInput,
  }).strict(),
  z.object({
    kind: z.literal("workstream.update"),
    workstreamId: teamWorkstreamId,
    patch: teamWorkstreamUpdatePatch,
  }).strict(),
  z.object({
    kind: z.literal("workstream.archive"),
    workstreamId: teamWorkstreamId,
  }).strict(),
  z.object({
    kind: z.literal("activity.record"),
    activity: z.object({
      action: teamActivityAction,
      subjects: z.array(TeamActivitySubjectInputSchema).max(64),
      workstream: teamWorkstreamRef.optional(),
    }).strict(),
  }).strict(),
]);

const teamRevisionExpectation = z.union([
  z.object({
    target: z.object({ kind: z.literal("artifact"), path: teamRepositoryPath }).strict(),
    revision: revision.nullable(),
  }).strict(),
  z.object({
    target: z.object({
      kind: z.literal("local"),
      namespace: z.literal("member-selection"),
      id: z.literal("current"),
    }).strict(),
    revision: revision.nullable(),
  }).strict(),
]);

export const TeamOperationPreviewRequestSchema = z.object({
  operationId: teamOperationId,
  action: teamIdentityActivityAction,
  expectedRevisions: z.array(teamRevisionExpectation).max(64),
}).strict().superRefine((value, context) => {
  if (
    value.action.kind !== "member.add"
    && value.action.kind !== "activity.record"
    && value.action.kind !== "workstream.create"
    && value.expectedRevisions.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedRevisions"],
      message: "Existing-target operations require a revision expectation.",
    });
  }
});

const teamFileChangeBase = {
  path: teamRepositoryPath,
  diff: utf8Text(64 * 1024, 0),
} as const;

export const TeamFileChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    ...teamFileChangeBase,
    beforeRevision: z.null(),
    afterRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal("update"),
    ...teamFileChangeBase,
    beforeRevision: revision,
    afterRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal("delete"),
    ...teamFileChangeBase,
    beforeRevision: revision,
    afterRevision: z.null(),
  }).strict(),
  z.object({
    kind: z.literal("move"),
    ...teamFileChangeBase,
    previousPath: teamRepositoryPath,
    beforeRevision: revision,
    afterRevision: revision,
  }).strict(),
]);

export const TeamLocalChangeSchema = z.object({
  namespace: z.literal("member-selection"),
  id: z.literal("current"),
  beforeRevision: revision.nullable(),
  afterRevision: revision.nullable(),
  summary: teamText(2_048),
}).strict();

const teamPublicPreview = z.object({
  valid: z.boolean(),
  scope: z.enum(["canonical", "local", "mixed"]),
  changes: z.array(TeamFileChangeSchema).max(16),
  localChanges: z.array(TeamLocalChangeSchema).max(16),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
}).strict();

const teamRepositoryState = z.object({
  branch: teamText(1_024).nullable(),
  head: gitObjectId.nullable(),
  dirty: z.boolean(),
  observedAt: isoTimestamp,
}).strict();

const teamPurposeId = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("activity"), id: teamEventId }).strict(),
  z.object({ purpose: z.literal("member"), id: teamMemberId }).strict(),
  z.object({ purpose: z.literal("workstream"), id: teamWorkstreamId }).strict(),
]);

export const TeamOperationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.object({
    actor: TeamActorRefSchema,
    occurredAt: isoTimestamp,
    repoState: teamRepositoryState,
  }).strict(),
  purposeIds: z.array(teamPurposeId).max(2),
  requestRevision: revision,
  presentationRevision: revision,
  previewRevision: revision,
}).strict().superRefine((value, context) => {
  const keys = value.purposeIds.map(({ purpose, id }) => `${purpose}\0${id}`);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => (
    index > 0 && key <= keys[index - 1]!
  ))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["purposeIds"],
      message: "Purpose IDs must be unique and sorted.",
    });
  }
  if (jsonByteLength(value) > 8 * 1024) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The team operation receipt exceeds 8 KiB.",
    });
  }
});

export const TeamOperationPreviewResponseSchema = z.object({
  schemaVersion: z.literal(1),
  request: TeamOperationPreviewRequestSchema,
  preview: teamPublicPreview,
  receipt: TeamOperationReceiptSchema,
}).strict().superRefine((value, context) => {
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The team operation preview exceeds 64 KiB.",
    });
  }
});

export const TeamOperationApplyRequestSchema = TeamOperationPreviewResponseSchema;

const TeamPersistedActivityOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workflow"),
    operation: teamActivityAction,
  }).strict(),
  z.object({ kind: z.literal("custom") }).strict(),
]);

const teamActivityEventFields = {
  id: teamEventId,
  timestamp: isoTimestamp,
  actor: TeamActorRefSchema,
  action: teamActivityAction,
  subjects: z.array(TeamActivitySubjectInputSchema).max(64),
  workstream: teamWorkstreamRef.nullable(),
  repoState: teamRepositoryState,
} as const;

export const TeamActivityEventSchema = z.union([z.object({
  schemaVersion: z.literal(1),
  ...teamActivityEventFields,
}).strict(), z.object({
  schemaVersion: z.literal(2),
  ...teamActivityEventFields,
  origin: TeamPersistedActivityOriginSchema,
  label: teamText(512).optional(),
}).strict()]);

export const TeamOperationApplyResponseSchema = z.object({
  operationId: teamOperationId,
  previewRevision: revision,
  applied: z.literal(true),
  idempotentReplay: z.boolean(),
  changes: z.array(TeamFileChangeSchema).max(16),
  localChanges: z.array(TeamLocalChangeSchema).max(16),
  members: z.array(TeamMemberSchema).max(1),
  workstreams: z.array(TeamWorkstreamSchema).max(1),
  events: z.array(TeamActivityEventSchema).max(1),
}).strict();

export const InboxSpecKindSchema = z.enum([
  "spec",
  "requirement",
  "constraint",
  "acceptance_criterion",
]);

export const InboxKnowledgeKindSchema = z.enum([
  "architecture", "component", "convention", "decision", "pattern", "guide",
]);
export const InboxEntityKindSchema = z.union([InboxKnowledgeKindSchema, InboxSpecKindSchema]);
const inboxChangeKind = z.enum(["spec.create", "spec.update", "knowledge.create", "knowledge.update"]);

export const InboxProposalStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "stale",
]);

export const InboxDraftIdSchema = z.string().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value),
  "Invalid Inbox draft ID.",
);
const inboxSpecEntityId = z.string()
  .regex(/^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Spec entity ID.");

function inboxHasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const inboxCanonicalText = (maximum: number, required: boolean) => z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= maximum
    && value.normalize("NFC") === value
    && !inboxHasLoneSurrogate(value)
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    && (!required || value.trim().length > 0),
  `Text is invalid or exceeds the ${maximum}-byte canonical limit.`,
);
const inboxText = (maximum: number) => inboxCanonicalText(maximum, true);
const inboxOptionalText = (maximum: number) => inboxCanonicalText(maximum, false);

const inboxSpecRef = z.object({
  id: inboxSpecEntityId,
  kind: InboxSpecKindSchema,
  title: inboxText(512).optional(),
}).strict();

const inboxCreateRelation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("derived_from"),
    target: inboxSpecRef.extend({ kind: z.literal("spec") }),
  }).strict(),
  z.object({
    type: z.literal("verified_by"),
    target: inboxSpecRef.extend({ kind: z.enum(["spec", "requirement"]) }),
  }).strict(),
  z.object({
    type: z.literal("constrained_by"),
    target: inboxSpecRef.extend({ kind: z.literal("constraint") }),
  }).strict(),
  z.object({
    type: z.literal("refines"),
    target: inboxSpecRef.extend({ kind: z.literal("requirement") }),
  }).strict(),
]);

const inboxSpecCreateChangeObject = z.object({
  kind: z.literal("spec.create"),
  entityKind: InboxSpecKindSchema,
  title: inboxText(512),
  body: inboxText(16 * 1024),
  summary: inboxOptionalText(2 * 1024).optional(),
  status: z.enum(["in_flight", "promoted"]),
  topics: z.array(inboxSpecEntityId).max(64).refine(
    (values) => new Set(values).size === values.length,
    "Spec topic references must be unique.",
  ).optional(),
  relation: inboxCreateRelation.optional(),
}).strict();

export const InboxSpecCreateChangeSchema = inboxSpecCreateChangeObject.superRefine((value, context) => {
  if (value.relation === undefined) return;
  const accepted = value.relation.type === "derived_from"
    ? value.entityKind === "requirement"
    : value.relation.type === "verified_by"
      ? value.entityKind === "acceptance_criterion"
      : value.relation.type === "refines"
        ? value.entityKind === "requirement"
        : true;
  if (!accepted) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relation"],
      message: "The create-time relation direction is invalid for this Spec kind.",
    });
  }
});

const inboxSpecUpdatePatch = z.object({
  title: inboxText(512).optional(),
  summary: inboxOptionalText(2 * 1024).optional(),
  body: inboxText(16 * 1024).optional(),
}).strict().refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  "A Spec update requires at least one title, summary, or body field.",
);

export const InboxSpecUpdateChangeSchema = z.object({
  kind: z.literal("spec.update"),
  target: inboxSpecRef,
  patch: inboxSpecUpdatePatch,
}).strict();

export const InboxKnowledgeCreateChangeSchema = inboxSpecCreateChangeObject
  .omit({ relation: true })
  .extend({ kind: z.literal("knowledge.create"), entityKind: InboxKnowledgeKindSchema })
  .strict();

export const InboxKnowledgeUpdateChangeSchema = z.object({
  kind: z.literal("knowledge.update"),
  target: inboxSpecRef.extend({ kind: InboxKnowledgeKindSchema }),
  patch: inboxSpecUpdatePatch,
}).strict();

// Compatibility name: existing Spec envelopes retain their exact discriminators.
export const InboxSpecChangeSchema = z.union([
  InboxSpecCreateChangeSchema,
  InboxSpecUpdateChangeSchema,
  InboxKnowledgeCreateChangeSchema,
  InboxKnowledgeUpdateChangeSchema,
]);

const inboxEntityRevisionExpectation = z.object({
  target: z.object({ kind: z.literal("entity"), id: inboxSpecEntityId }).strict(),
  revision,
  semanticRevision: z.number().int().positive(),
}).strict();

const inboxSingleLineText = (maximum: number) => utf8Text(maximum).refine(
  (value) => value.length > 0
    && value.trim() === value
    && value.normalize("NFC") === value
    && !inboxHasLoneSurrogate(value)
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value),
  "Text must be trimmed canonical Unicode without control or line-separator characters.",
);

const inboxEvidenceEntityRef = z.object({
  id: inboxSingleLineText(256),
  kind: inboxSingleLineText(64),
  title: inboxSingleLineText(512).optional(),
}).strict();
const inboxEvidenceCodeRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("symbol"),
    symbolId: inboxSingleLineText(1_024),
    fingerprint: inboxSingleLineText(1_024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("file"),
    path: teamRepositoryPath,
    fingerprint: inboxSingleLineText(1_024).optional(),
  }).strict(),
]);
const inboxExternalUri = inboxSingleLineText(4 * 1024).refine((value) => {
  if (!/^https?:\/\/\S+$/u.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && parsed.username === ""
    && parsed.password === "";
}, "External evidence must be an HTTP(S) URL without credentials.");

export const InboxEvidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entity: inboxEvidenceEntityRef }).strict(),
  z.object({ kind: z.literal("code"), code: inboxEvidenceCodeRef }).strict(),
  z.object({ kind: z.literal("commit"), hash: gitObjectId }).strict(),
  z.object({ kind: z.literal("file"), path: teamRepositoryPath }).strict(),
  z.object({
    kind: z.literal("external"),
    uri: inboxExternalUri,
    label: inboxSingleLineText(512).optional(),
  }).strict(),
  z.object({ kind: z.literal("manual"), note: inboxText(4 * 1024) }).strict(),
]);

function inboxSpecDependencyIds(change: z.infer<typeof InboxSpecChangeSchema>): string[] {
  if (change.kind === "spec.update" || change.kind === "knowledge.update") return [change.target.id];
  return [...new Set([
    ...(change.topics ?? []),
    ...(change.kind === "spec.create" && change.relation ? [change.relation.target.id] : []),
  ])].sort();
}

function validateInboxDependencyCoverage(
  change: z.infer<typeof InboxSpecChangeSchema>,
  targetRevisions: readonly z.infer<typeof inboxEntityRevisionExpectation>[],
  context: z.RefinementCtx,
): void {
  const expected = inboxSpecDependencyIds(change);
  const actual = targetRevisions.map((item) => item.target.id).sort();
  if (
    new Set(actual).size !== actual.length
    || expected.length !== actual.length
    || expected.some((id, index) => id !== actual[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetRevisions"],
      message: "Exact revisions must cover every knowledge dependency once.",
    });
  }
}

export const InboxDraftInputSchema = z.object({
  change: InboxSpecChangeSchema,
  rationale: inboxText(8 * 1024),
  evidence: z.array(InboxEvidenceRefSchema).max(64),
  targetRevisions: z.array(inboxEntityRevisionExpectation).max(64),
}).strict().superRefine((value, context) => {
  validateInboxDependencyCoverage(value.change, value.targetRevisions, context);
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The Inbox draft input exceeds 64 KiB.",
    });
  }
});

export const InboxDraftSummarySchema = z.object({
  id: InboxDraftIdSchema,
  revision,
  updatedAt: isoTimestamp,
  changeKind: inboxChangeKind,
  entityKind: InboxEntityKindSchema,
  title: inboxText(512),
  rationaleExcerpt: utf8Text(240),
}).strict();

export const InboxDraftDetailSchema = InboxDraftSummarySchema.extend({
  input: InboxDraftInputSchema,
}).strict();

const inboxProposalRef = z.object({
  id: InboxProposalIdSchema,
  kind: z.literal("proposal"),
  title: inboxText(512).optional(),
}).strict();

const inboxProposalSummaryObject = z.object({
  schemaVersion: z.literal(1),
  ref: inboxProposalRef,
  sourcePath: teamRepositoryPath,
  revision,
  state: InboxProposalStateSchema,
  author: TeamActorRefSchema,
  changeKind: inboxChangeKind,
  entityKind: InboxEntityKindSchema,
  title: inboxText(512),
  rationaleExcerpt: utf8Text(240),
  reviewer: TeamActorRefSchema.optional(),
  reviewedAt: isoTimestamp.optional(),
}).strict();

function validateInboxProposalPath(
  value: z.infer<typeof inboxProposalSummaryObject>,
  context: z.RefinementCtx,
): void {
  if (value.sourcePath !== `.mex/inbox/${value.ref.id}.md`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourcePath"],
      message: "Proposal source path must match its ID.",
    });
  }
}

function validateInboxProposalReviewState(
  value: z.infer<typeof inboxProposalSummaryObject> & { reviewRationale?: string },
  context: z.RefinementCtx,
  requireRejectedRationale = false,
): void {
  const hasReviewer = value.reviewer !== undefined;
  const hasReviewedAt = value.reviewedAt !== undefined;
  if (hasReviewer !== hasReviewedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasReviewer ? "reviewedAt" : "reviewer"],
      message: "Proposal reviewer and review time must be recorded together.",
    });
  }
  const terminal = value.state === "approved"
    || value.state === "rejected"
    || value.state === "withdrawn";
  if (terminal && !hasReviewer) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewer"],
      message: "Terminal proposals require reviewer authority and review time.",
    });
  }
  if ((value.state === "pending" || value.state === "stale") && hasReviewer) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewer"],
      message: "Pending and stale proposals must not carry reviewer authority.",
    });
  }
  if (value.reviewRationale !== undefined && !hasReviewer) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewRationale"],
      message: "Proposal review rationale requires reviewer authority.",
    });
  }
  if (requireRejectedRationale
    && value.state === "rejected"
    && value.reviewRationale === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewRationale"],
      message: "Rejected proposals require review rationale.",
    });
  }
}

export const InboxProposalSummarySchema = inboxProposalSummaryObject.superRefine((value, context) => {
  validateInboxProposalPath(value, context);
  validateInboxProposalReviewState(value, context);
});

export const InboxProposalDetailSchema = inboxProposalSummaryObject.extend({
  change: InboxSpecChangeSchema,
  rationale: inboxText(8 * 1024),
  evidence: z.array(InboxEvidenceRefSchema).max(64),
  targetRevisions: z.array(inboxEntityRevisionExpectation).max(64),
  reviewRationale: inboxText(8 * 1024).optional(),
}).strict().superRefine((value, context) => {
  validateInboxProposalPath(value, context);
  validateInboxProposalReviewState(value, context, true);
  validateInboxDependencyCoverage(value.change, value.targetRevisions, context);
});

export const InboxDraftListRequestSchema = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const InboxProposalListRequestSchema = z.object({
  states: z.array(InboxProposalStateSchema).min(1).max(5).refine(
    (values) => new Set(values).size === values.length,
    "Proposal states must be unique.",
  ).optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

const inboxPageFields = {
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
  sourceTruncated: z.boolean(),
  deterministicRevision: revision,
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
} as const;

export const InboxDraftListResponseSchema = z.object({
  items: z.array(InboxDraftSummarySchema).max(HUB_LIMITS.maxPageSize),
  ...inboxPageFields,
}).strict().superRefine((value, context) => {
  if (value.truncated !== (value.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "Draft truncation must match cursor presence." });
  }
});

export const InboxProposalListResponseSchema = z.object({
  items: z.array(InboxProposalSummarySchema).max(HUB_LIMITS.maxPageSize),
  ...inboxPageFields,
}).strict().superRefine((value, context) => {
  if (value.truncated !== (value.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "Proposal truncation must match cursor presence." });
  }
});

const inboxCommandExpectation = z.union([
  z.object({
    target: z.object({
      kind: z.literal("local"),
      namespace: z.literal("inbox-draft"),
      id: InboxDraftIdSchema,
    }).strict(),
    revision,
  }).strict(),
  z.object({
    target: z.object({
      kind: z.literal("artifact"),
      path: teamRepositoryPath,
    }).strict(),
    revision,
  }).strict(),
]);

const inboxAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inbox.draft.save"),
    draftId: InboxDraftIdSchema.optional(),
    draft: InboxDraftInputSchema,
  }).strict(),
  z.object({ kind: z.literal("inbox.draft.delete"), draftId: InboxDraftIdSchema }).strict(),
  z.object({ kind: z.literal("inbox.publish"), draftId: InboxDraftIdSchema }).strict(),
  z.object({ kind: z.literal("inbox.approve"), proposalId: InboxProposalIdSchema }).strict(),
  z.object({
    kind: z.literal("inbox.reject"),
    proposalId: InboxProposalIdSchema,
    rationale: inboxText(8 * 1024),
  }).strict(),
  z.object({
    kind: z.literal("inbox.withdraw"),
    proposalId: InboxProposalIdSchema,
    rationale: inboxText(8 * 1024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("inbox.mark-stale"),
    proposalId: InboxProposalIdSchema,
    rationale: inboxText(8 * 1024),
  }).strict(),
  z.object({
    kind: z.literal("inbox.repair"),
    proposalId: InboxProposalIdSchema,
    replacement: InboxDraftInputSchema,
  }).strict(),
]);

export const InboxOperationPreviewRequestSchema = z.object({
  operationId: teamOperationId,
  action: inboxAction,
  expectedRevisions: z.array(inboxCommandExpectation).max(64),
}).strict().superRefine((value, context) => {
  let expectedTarget: string | null = null;
  if (value.action.kind === "inbox.draft.save") {
    expectedTarget = value.action.draftId === undefined
      ? null
      : `local:${value.action.draftId}`;
  } else if (value.action.kind === "inbox.draft.delete" || value.action.kind === "inbox.publish") {
    expectedTarget = `local:${value.action.draftId}`;
  } else {
    expectedTarget = `artifact:.mex/inbox/${value.action.proposalId}.md`;
  }
  const actual = value.expectedRevisions.map((item) => item.target.kind === "local"
    ? `local:${item.target.id}`
    : `artifact:${item.target.path}`);
  if (
    (expectedTarget === null && actual.length !== 0)
    || (expectedTarget !== null && (actual.length !== 1 || actual[0] !== expectedTarget))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedRevisions"],
      message: "The command requires the exact target revision once.",
    });
  }
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The Inbox command exceeds 64 KiB." });
  }
});

export const InboxLocalChangeSchema = z.object({
  namespace: z.literal("inbox-draft"),
  id: InboxDraftIdSchema,
  beforeRevision: revision.nullable(),
  afterRevision: revision.nullable(),
  summary: inboxText(2 * 1024),
}).strict();

const inboxPublicPreview = z.object({
  valid: z.boolean(),
  scope: z.enum(["canonical", "local", "mixed"]),
  changes: z.array(TeamFileChangeSchema).max(16),
  localChanges: z.array(InboxLocalChangeSchema).max(16),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
}).strict();

const inboxPurposeId = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("inbox-draft"), id: InboxDraftIdSchema }).strict(),
  z.object({ purpose: z.literal("proposal"), id: InboxProposalIdSchema }).strict(),
  z.object({ purpose: z.literal("activity"), id: teamEventId }).strict(),
  z.object({ purpose: z.literal("spec-entity"), id: inboxSpecEntityId }).strict(),
]);

export const InboxOperationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.object({
    actor: TeamActorRefSchema,
    occurredAt: isoTimestamp,
    repoState: teamRepositoryState,
  }).strict(),
  purposeIds: z.array(inboxPurposeId).max(2),
  requestRevision: revision,
  presentationRevision: revision,
  previewRevision: revision,
}).strict().superRefine((value, context) => {
  const keys = value.purposeIds.map(({ purpose, id }) => `${purpose}\0${id}`);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => (
    index > 0 && key <= keys[index - 1]!
  ))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["purposeIds"], message: "Purpose IDs must be unique and sorted." });
  }
  if (jsonByteLength(value) > 8 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The Inbox receipt exceeds 8 KiB." });
  }
});

export const InboxOperationPreviewResponseSchema = z.object({
  schemaVersion: z.literal(1),
  request: InboxOperationPreviewRequestSchema,
  preview: inboxPublicPreview,
  receipt: InboxOperationReceiptSchema,
}).strict().superRefine((value, context) => {
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The Inbox preview exceeds 64 KiB." });
  }
});

export const InboxOperationApplyRequestSchema = InboxOperationPreviewResponseSchema;

export const InboxOperationApplyResponseSchema = z.object({
  operationId: teamOperationId,
  previewRevision: revision,
  applied: z.literal(true),
  idempotentReplay: z.boolean(),
  changes: z.array(TeamFileChangeSchema).max(16),
  localChanges: z.array(InboxLocalChangeSchema).max(16),
  proposals: z.array(InboxProposalDetailSchema).max(1),
  events: z.array(TeamActivityEventSchema).max(1),
}).strict();

const relayContracts = /* @__PURE__ */ (() => {
const RelayStateSchema = z.enum(["published", "acknowledged", "closed"]);
const RelayPerspectiveSchema = z.enum(["mine", "sent", "all"]);
const RelayDraftIdSchema = z.string().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value),
  "Invalid Relay draft ID.",
);
const relaySingleLineText = (maximum: number) => utf8Text(maximum).refine(
  (value) => value.trim() === value
    && value.normalize("NFC") === value
    && !inboxHasLoneSurrogate(value)
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value),
  "Relay text must be trimmed, single-line canonical Unicode.",
);

const relayMemberRef = z.object({
  kind: z.literal("member"),
  memberId: teamMemberId,
  displayName: relaySingleLineText(512).optional(),
}).strict();
const relayRecordedActorRef = z.discriminatedUnion("kind", [
  relayMemberRef,
  z.object({
    kind: z.literal("git"),
    name: relaySingleLineText(512).nullable(),
    email: relaySingleLineText(512).nullable(),
  }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]).superRefine((value, context) => {
  if (value.kind !== "git") return;
  if (value.name === null && value.email === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A recorded Relay Git actor requires a name or email." });
  }
  if (value.email !== null && (!value.email.includes("@") || /\s/u.test(value.email))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "The recorded Relay Git email is invalid." });
  }
});
const relayServiceActorRef = z.discriminatedUnion("kind", [
  relayMemberRef,
  z.object({
    kind: z.literal("git"),
    name: teamText(200).nullable(),
    email: teamText(320).nullable(),
  }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "git" && value.name === null && value.email === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A Relay service Git actor requires a name or email." });
  }
});
const relayMemberSet = z.array(relayMemberRef).max(32).refine(
  (values) => new Set(values.map((value) => value.memberId)).size === values.length,
  "Relay recipients must be unique Members.",
);
const relayRecordedRecipientSet = z.array(relayRecordedActorRef).max(64).refine(
  (values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length,
  "Recorded Relay recipients must be unique Actor references.",
);
const relayTextList = z.array(relaySingleLineText(4 * 1024)).max(64).refine(
  (values) => new Set(values).size === values.length,
  "Relay text collections must be unique.",
);
const relayEntityRef = z.object({
  id: relaySingleLineText(256),
  kind: relaySingleLineText(64),
  title: relaySingleLineText(512).optional(),
}).strict();
const relayDecisionSet = z.array(relayEntityRef).max(64).refine(
  (values) => new Set(values.map((value) => `${value.kind}\0${value.id}`)).size === values.length,
  "Relay decisions must be unique by kind and ID.",
);
const relayRecordedWorkstreamRef = z.object({
  id: relaySingleLineText(256),
  kind: z.literal("workstream"),
  title: relaySingleLineText(512).optional(),
}).strict();
const relayCodeRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("symbol"),
    symbolId: relaySingleLineText(1_024),
    fingerprint: relaySingleLineText(1_024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("file"),
    path: teamRepositoryPath,
    fingerprint: relaySingleLineText(1_024).optional(),
  }).strict(),
]);
const relayRecordedRepositoryPath = utf8Text(4_096).refine((value) => {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;
  if (value.normalize("NFC") !== value
    || inboxHasLoneSurrogate(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "Recorded Relay paths must be safe canonical repository-relative POSIX paths.");
const relayRecordedCodeRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("symbol"),
    symbolId: relaySingleLineText(1_024),
    fingerprint: relaySingleLineText(1_024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("file"),
    path: relayRecordedRepositoryPath,
    fingerprint: relaySingleLineText(1_024).optional(),
  }).strict(),
]);
const relayCodeSet = z.array(relayCodeRef).max(64).refine(
  (values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length,
  "Relay code references must be unique.",
);
const relayRecordedCodeSet = z.array(relayRecordedCodeRef).max(64).refine(
  (values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length,
  "Recorded Relay code references must be unique.",
);
const relayPathSet = z.array(teamRepositoryPath).max(64).refine(
  (values) => new Set(values).size === values.length,
  "Relay changed files must be unique.",
);
const relayRecordedPathSet = z.array(relayRecordedRepositoryPath).max(64).refine(
  (values) => new Set(values).size === values.length,
  "Recorded Relay changed files must be unique.",
);
const RelayEvidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entity: relayEntityRef }).strict(),
  z.object({ kind: z.literal("code"), code: relayCodeRef }).strict(),
  z.object({ kind: z.literal("commit"), hash: gitObjectId }).strict(),
  z.object({ kind: z.literal("file"), path: teamRepositoryPath }).strict(),
  z.object({
    kind: z.literal("external"),
    uri: relaySingleLineText(4 * 1024).refine(
      (value) => {
        try {
          const parsed = new URL(value);
          return (parsed.protocol === "https:" || parsed.protocol === "http:")
            && parsed.username === ""
            && parsed.password === "";
        } catch {
          return false;
        }
      },
      "External Relay evidence must use HTTP or HTTPS.",
    ),
    label: relaySingleLineText(512).optional(),
  }).strict(),
  z.object({ kind: z.literal("manual"), note: relaySingleLineText(4 * 1024) }).strict(),
]);
const relayEvidenceList = z.array(RelayEvidenceRefSchema).max(65).superRefine(
  (values, context) => {
    if (values.length <= 64) return;
    const first = values[0];
    if (
      first?.kind !== "entity"
      || first.entity.kind !== "workstream"
      || !teamWorkstreamId.safeParse(first.entity.id).success
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A 65th Relay evidence entry is reserved for translated legacy Workstream evidence.",
      });
    }
  },
);
const relayRecordedEvidenceRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entity: relayEntityRef }).strict(),
  z.object({ kind: z.literal("code"), code: relayRecordedCodeRef }).strict(),
  z.object({ kind: z.literal("commit"), hash: gitObjectId }).strict(),
  z.object({ kind: z.literal("file"), path: relayRecordedRepositoryPath }).strict(),
  z.object({
    kind: z.literal("external"),
    uri: relaySingleLineText(4 * 1024).refine(
      (value) => {
        try {
          const parsed = new URL(value);
          return (parsed.protocol === "https:" || parsed.protocol === "http:")
            && parsed.username === ""
            && parsed.password === "";
        } catch {
          return false;
        }
      },
      "External Relay evidence must use HTTP or HTTPS.",
    ),
    label: relaySingleLineText(512).optional(),
  }).strict(),
  z.object({ kind: z.literal("manual"), note: relaySingleLineText(4 * 1024) }).strict(),
]);
const relayRecordedEvidenceList = z.array(relayRecordedEvidenceRef).max(65);

const relayDraftInputObject = z.object({
  audience: z.enum(["team", "members"]).optional(),
  recipients: relayMemberSet,
  summary: relaySingleLineText(8 * 1024).refine((value) => value.length > 0, "Relay summary is required."),
  completed: relayTextList.default([]),
  inProgress: relayTextList.default([]),
  decisions: relayDecisionSet.default([]),
  blockers: relayTextList.default([]),
  unresolvedQuestions: relayTextList.default([]),
  changedFiles: relayPathSet.default([]),
  code: relayCodeSet.default([]),
  evidence: relayEvidenceList.default([]),
  nextActions: relayTextList.default([]),
}).strict();

function validateRelayDraftAudience(value: { audience?: "team" | "members"; recipients: readonly unknown[] }, context: z.RefinementCtx): void {
  if (value.audience === "team" && value.recipients.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients"], message: "Open-to-team Relays cannot also name recipients." });
  }
}

const RelayDraftInputSchema = relayDraftInputObject.superRefine((value, context) => {
  validateRelayDraftAudience(value, context);
  if (value.evidence.length > 64) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Caller-authored Relay drafts accept at most 64 evidence entries.",
    });
  }
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The Relay draft input exceeds 64 KiB." });
  }
});

const relayDraftSummaryObject = z.object({
  audience: z.enum(["team", "members"]).optional(),
  id: RelayDraftIdSchema,
  revision,
  updatedAt: isoTimestamp,
  summary: relaySingleLineText(8 * 1024),
  recipients: relayMemberSet,
}).strict();

const RelayDraftSummarySchema = relayDraftSummaryObject.superRefine(validateRelayDraftAudience);

const RelayDraftDetailSchema = relayDraftSummaryObject.extend({
  // Stored legacy drafts can grow slightly when sparse defaults are expanded
  // and Workstream is projected into reserved evidence. Reads stay field-
  // bounded; only caller-authored mutation input retains the 64 KiB ceiling.
  input: relayDraftInputObject,
}).strict().superRefine((value, context) => {
  validateRelayDraftAudience(value, context);
  validateRelayDraftAudience(value.input, context);
  if (value.audience !== value.input.audience) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["audience"], message: "The draft audience must match its input." });
  }
});

const relayDetailObject = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  audience: z.enum(["team", "members"]).optional(),
  ref: z.object({
    id: RelayIdSchema,
    kind: z.literal("relay"),
    title: relaySingleLineText(512).optional(),
  }).strict(),
  sourcePath: teamRepositoryPath,
  revision,
  state: RelayStateSchema,
  sender: relayRecordedActorRef,
  recipients: relayRecordedRecipientSet,
  workstream: relayRecordedWorkstreamRef.nullable(),
  summary: relaySingleLineText(8 * 1024),
  completed: relayTextList,
  inProgress: relayTextList,
  decisions: relayDecisionSet,
  blockers: relayTextList,
  unresolvedQuestions: relayTextList,
  changedFiles: relayRecordedPathSet,
  code: relayRecordedCodeSet,
  evidence: relayRecordedEvidenceList,
  nextActions: relayTextList,
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
  publishedAt: isoTimestamp.nullable(),
  publishedRepoState: teamRepositoryState.nullable(),
  acknowledgedBy: relayRecordedActorRef.nullable(),
  acknowledgedAt: isoTimestamp.nullable(),
  closedBy: relayRecordedActorRef.nullable(),
  closedAt: isoTimestamp.nullable(),
}).strict();

function validateRelayLifecycle(
  value: {
    schemaVersion: 1 | 2 | 3 | 4;
    audience?: "team" | "members";
    ref: { id: string };
    sourcePath: string;
    state: "published" | "acknowledged" | "closed";
    publishedAt: string | null;
    publishedRepoState: z.infer<typeof teamRepositoryState> | null;
    sender: z.infer<typeof relayRecordedActorRef>;
    recipients: readonly z.infer<typeof relayRecordedActorRef>[];
    workstream: z.infer<typeof relayRecordedWorkstreamRef> | null;
    changedFiles?: readonly string[];
    code?: readonly z.infer<typeof relayRecordedCodeRef>[];
    evidence?: readonly z.infer<typeof relayRecordedEvidenceRef>[];
    acknowledgedBy: z.infer<typeof relayRecordedActorRef> | null;
    acknowledgedAt: string | null;
    closedBy: z.infer<typeof relayRecordedActorRef> | null;
    closedAt: string | null;
  },
  context: z.RefinementCtx,
): void {
  if (value.sourcePath !== `.mex/relays/${value.ref.id}.md`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourcePath"], message: "Relay source path must match its ID." });
  }
  if (value.schemaVersion === 4) {
    if (value.audience !== "team" || value.recipients.length !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["audience"], message: "Schema-v4 Relays must be open to team with no named recipients." });
    }
  } else if (value.audience !== undefined || value.recipients.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients"], message: "Legacy Relays require named recipients and omit audience." });
  }
  if (value.schemaVersion === 1) {
    if (value.publishedAt !== null || value.publishedRepoState !== null || value.workstream === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Schema-v1 Relays require a Workstream and omit publication time and repository state." });
    }
  } else if (value.schemaVersion === 2) {
    if (value.publishedAt === null || value.publishedRepoState !== null || value.workstream === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Schema-v2 Relays require publication time and a Workstream, without publication repository state." });
    } else if (!teamWorkstreamId.safeParse(value.workstream.id).success) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workstream", "id"], message: "Schema-v2 Relays require a canonical Workstream ID." });
    }
  } else if (value.publishedAt === null || value.publishedRepoState === null || value.workstream !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Schema-v3 Relays require publication time and repository state, without a Workstream." });
  }
  if (value.schemaVersion >= 2) {
    const v2MemberIds = value.recipients.flatMap((recipient) => recipient.kind === "member" ? [recipient.memberId] : []);
    if (value.recipients.length > 32
      || v2MemberIds.length !== value.recipients.length
      || new Set(v2MemberIds).size !== v2MemberIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients"], message: "Schema-v2 Relays require 1-32 Member recipients." });
    }
    if (value.sender.kind !== "member"
      || (value.acknowledgedBy !== null && value.acknowledgedBy.kind !== "member")
      || (value.closedBy !== null && value.closedBy.kind !== "member")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sender"], message: "Schema-v2 Relay lifecycle principals must be Members." });
    }
    const recordedPaths = [
      ...(value.changedFiles ?? []),
      ...(value.code ?? []).flatMap((code) => code.kind === "file" ? [code.path] : []),
      ...(value.evidence ?? []).flatMap((evidence) => {
        if (evidence.kind === "file") return [evidence.path];
        if (evidence.kind === "code" && evidence.code.kind === "file") return [evidence.code.path];
        return [];
      }),
    ];
    if (recordedPaths.some((path) => !teamRepositoryPath.safeParse(path).success)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["changedFiles"], message: "Current Relay schemas require canonical repository paths." });
    }
  }
  if ((value.evidence?.length ?? 0) > 64) {
    const first = value.evidence?.[0];
    if (
      (value.schemaVersion !== 3 && value.schemaVersion !== 4)
      || first?.kind !== "entity"
      || first.entity.kind !== "workstream"
      || !teamWorkstreamId.safeParse(first.entity.id).success
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "Only schema-v3 translated drafts may use the reserved legacy Workstream evidence slot." });
    }
  }
  const acknowledged = value.acknowledgedBy !== null && value.acknowledgedAt !== null;
  const closed = value.closedBy !== null && value.closedAt !== null;
  if ((value.acknowledgedBy === null) !== (value.acknowledgedAt === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Relay acknowledgement actor and time must be paired." });
  }
  if ((value.closedBy === null) !== (value.closedAt === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Relay close actor and time must be paired." });
  }
  if (value.state === "published" && (acknowledged || closed)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "Published Relays cannot carry lifecycle authority." });
  }
  if (value.state === "acknowledged" && (!acknowledged || closed)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "Acknowledged Relays require only acknowledgement authority." });
  }
  if (value.state === "closed" && (!acknowledged || !closed)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "Closed Relays require acknowledgement and close authority." });
  }
  if (value.publishedAt !== null
    && value.acknowledgedAt !== null
    && Date.parse(value.publishedAt) > Date.parse(value.acknowledgedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["acknowledgedAt"], message: "Relay acknowledgement cannot precede publication." });
  }
  if (value.acknowledgedAt !== null
    && value.closedAt !== null
    && Date.parse(value.acknowledgedAt) > Date.parse(value.closedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["closedAt"], message: "Relay closure cannot precede acknowledgement." });
  }
}

const RelayDetailSchema = relayDetailObject.superRefine(validateRelayLifecycle);
const RelaySummarySchema = relayDetailObject.pick({
  schemaVersion: true,
  audience: true,
  ref: true,
  sourcePath: true,
  revision: true,
  state: true,
  sender: true,
  recipients: true,
  workstream: true,
  summary: true,
  publishedAt: true,
  publishedRepoState: true,
  acknowledgedBy: true,
  acknowledgedAt: true,
  closedBy: true,
  closedAt: true,
}).strict().superRefine(validateRelayLifecycle);

const RelayDraftListRequestSchema = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

const RelayListRequestSchema = z.object({
  perspective: RelayPerspectiveSchema.default("all"),
  states: z.array(RelayStateSchema).min(1).max(3).refine(
    (values) => new Set(values).size === values.length,
    "Relay states must be unique.",
  ).optional(),
  workstreamId: teamWorkstreamId.optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

const relayPageFields = {
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
  sourceTruncated: z.boolean(),
  deterministicRevision: revision,
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
} as const;

const RelayDraftListResponseSchema = z.object({
  items: z.array(RelayDraftSummarySchema).max(HUB_LIMITS.maxPageSize),
  ...relayPageFields,
}).strict().superRefine((value, context) => {
  if (value.truncated !== (value.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "Relay draft truncation must match cursor presence." });
  }
});

const RelayListResponseSchema = z.object({
  items: z.array(RelaySummarySchema).max(HUB_LIMITS.maxPageSize),
  ...relayPageFields,
}).strict().superRefine((value, context) => {
  if (value.truncated !== (value.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "Relay truncation must match cursor presence." });
  }
});

const relayCommandExpectation = z.union([
  z.object({
    target: z.object({
      kind: z.literal("local"),
      namespace: z.literal("relay-draft"),
      id: RelayDraftIdSchema,
    }).strict(),
    revision,
  }).strict(),
  z.object({
    target: z.object({ kind: z.literal("artifact"), path: teamRepositoryPath }).strict(),
    revision,
  }).strict(),
]);

const relayAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("relay.draft.save"),
    draftId: RelayDraftIdSchema.optional(),
    draft: relayDraftInputObject,
  }).strict(),
  z.object({ kind: z.literal("relay.draft.delete"), draftId: RelayDraftIdSchema }).strict(),
  z.object({ kind: z.literal("relay.publish"), draftId: RelayDraftIdSchema }).strict(),
  z.object({ kind: z.literal("relay.acknowledge"), relayId: RelayIdSchema }).strict(),
  z.object({ kind: z.literal("relay.close"), relayId: RelayIdSchema }).strict(),
]);

const RelayOperationPreviewRequestSchema = z.object({
  operationId: teamOperationId,
  action: relayAction,
  expectedRevisions: z.array(relayCommandExpectation).max(33),
}).strict().superRefine((value, context) => {
  const targets = value.expectedRevisions.map((item) => item.target.kind === "local"
    ? `local:${item.target.id}`
    : `artifact:${item.target.path}`);
  if (new Set(targets).size !== targets.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedRevisions"], message: "Relay revision targets must be unique." });
  }
  const localTarget = "draftId" in value.action && value.action.draftId !== undefined
    ? `local:${value.action.draftId}`
    : null;
  if (value.action.kind === "relay.draft.save") {
    validateRelayDraftAudience(value.action.draft, context);
    if (value.action.draft.evidence.length > 64 && value.action.draftId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action", "draft", "evidence"],
        message: "A new Relay draft accepts at most 64 caller-authored evidence entries.",
      });
    }
    if ((localTarget === null && targets.length !== 0)
      || (localTarget !== null && (targets.length !== 1 || targets[0] !== localTarget))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedRevisions"], message: "Relay draft save requires only its exact local revision." });
    }
  } else if (value.action.kind === "relay.draft.delete") {
    if (targets.length !== 1 || targets[0] !== localTarget) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedRevisions"], message: "Relay draft delete requires only its exact local revision." });
    }
  } else if (value.action.kind === "relay.publish") {
    const localTargets = targets.filter((target) => target === localTarget);
    const memberTargets = targets.filter((target) => /^artifact:\.mex\/team\/members\/member_[0-7][0-9A-HJKMNP-TV-Z]{25}\.md$/.test(target));
    const legacyWorkstreamTargets = targets.filter((target) =>
      /^artifact:\.mex\/workstreams\/ws_[0-7][0-9A-HJKMNP-TV-Z]{25}\.md$/.test(target));
    if (localTargets.length !== 1
      || memberTargets.length > 32
      || targets.length !== localTargets.length + memberTargets.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedRevisions"],
        message: legacyWorkstreamTargets.length > 0
          ? "This pre-v3 Relay publication preview includes a Workstream dependency. Preview again with the current MEX version before applying it."
          : "Relay publication requires exactly the draft and recipient Member revisions.",
      });
    }
  } else {
    const relayPath = `artifact:.mex/relays/${value.action.relayId}.md`;
    if (targets.length !== 1 || targets[0] !== relayPath) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedRevisions"], message: "Relay lifecycle mutations require only the exact Relay revision." });
    }
  }
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The Relay command exceeds 64 KiB." });
  }
});

const RelayLocalChangeSchema = z.object({
  namespace: z.literal("relay-draft"),
  id: RelayDraftIdSchema,
  beforeRevision: revision.nullable(),
  afterRevision: revision.nullable(),
  summary: relaySingleLineText(2_048),
}).strict();

const relayPublicPreview = z.object({
  valid: z.boolean(),
  scope: z.enum(["canonical", "local", "mixed"]),
  changes: z.array(TeamFileChangeSchema).max(16),
  localChanges: z.array(RelayLocalChangeSchema).max(16),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
}).strict();

const relayPurposeId = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("relay-draft"), id: RelayDraftIdSchema }).strict(),
  z.object({ purpose: z.literal("relay"), id: RelayIdSchema }).strict(),
  z.object({ purpose: z.literal("activity"), id: teamEventId }).strict(),
]);

const RelayOperationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.object({
    actor: relayServiceActorRef,
    occurredAt: isoTimestamp,
    repoState: teamRepositoryState,
  }).strict(),
  purposeIds: z.array(relayPurposeId).max(2),
  requestRevision: revision,
  presentationRevision: revision,
  previewRevision: revision,
}).strict().superRefine((value, context) => {
  const keys = value.purposeIds.map(({ purpose, id }) => `${purpose}\0${id}`);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= keys[index - 1]!)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["purposeIds"], message: "Relay purpose IDs must be unique and sorted." });
  }
  if (jsonByteLength(value) > 8 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The Relay receipt exceeds 8 KiB." });
  }
});

const RelayOperationPreviewResponseSchema = z.object({
  schemaVersion: z.literal(1),
  request: RelayOperationPreviewRequestSchema,
  preview: relayPublicPreview,
  receipt: RelayOperationReceiptSchema,
}).strict().superRefine((value, context) => {
  const actualPurposes = value.receipt.purposeIds.map(({ purpose }) => purpose);
  const expectedPurposes = value.request.action.kind === "relay.draft.save"
    ? (value.request.action.draftId === undefined ? ["relay-draft"] : [])
    : value.request.action.kind === "relay.publish"
      ? ["activity", "relay"]
      : value.request.action.kind === "relay.acknowledge" || value.request.action.kind === "relay.close"
        ? ["activity"]
        : [];
  if (actualPurposes.length !== expectedPurposes.length
    || actualPurposes.some((purpose, index) => purpose !== expectedPurposes[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receipt", "purposeIds"],
      message: "Relay purpose IDs must exactly match the requested action.",
    });
  }
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The Relay preview exceeds 64 KiB." });
  }
});

const relayLegacyPublishRequest = z.object({
  operationId: teamOperationId,
  action: z.object({
    kind: z.literal("relay.publish"),
    draftId: RelayDraftIdSchema,
  }).strict(),
  expectedRevisions: z.array(relayCommandExpectation).max(34),
}).strict().superRefine((value, context) => {
  const draftTarget = `local:${value.action.draftId}`;
  const targets = value.expectedRevisions.map((item) => item.target.kind === "local"
    ? `local:${item.target.id}`
    : `artifact:${item.target.path}`);
  const draftCount = targets.filter((target) => target === draftTarget).length;
  const workstreamCount = targets.filter((target) =>
    /^artifact:\.mex\/workstreams\/ws_[0-7][0-9A-HJKMNP-TV-Z]{25}\.md$/.test(target)).length;
  const memberCount = targets.filter((target) =>
    /^artifact:\.mex\/team\/members\/member_[0-7][0-9A-HJKMNP-TV-Z]{25}\.md$/.test(target)).length;
  if (
    new Set(targets).size !== targets.length
    || draftCount !== 1
    || workstreamCount !== 1
    || memberCount < 1
    || memberCount > 32
    || targets.length !== draftCount + workstreamCount + memberCount
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedRevisions"],
      message: "A legacy Relay apply requires exactly its draft, Workstream, and recipient Member revisions.",
    });
  }
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The Relay command exceeds 64 KiB." });
  }
});

const relayLegacyPublishEnvelope = z.object({
  schemaVersion: z.literal(1),
  request: relayLegacyPublishRequest,
  preview: relayPublicPreview,
  receipt: RelayOperationReceiptSchema,
}).strict().superRefine((value, context) => {
  const purposes = value.receipt.purposeIds.map(({ purpose }) => purpose);
  if (purposes.length !== 2 || purposes[0] !== "activity" || purposes[1] !== "relay") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receipt", "purposeIds"],
      message: "A legacy Relay publication receipt requires Activity and Relay purpose IDs.",
    });
  }
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The Relay preview exceeds 64 KiB." });
  }
});

const RelayOperationApplyRequestSchema = z.union([
  RelayOperationPreviewResponseSchema,
  relayLegacyPublishEnvelope,
]);

const relayActivityEventFields = {
  id: teamEventId,
  timestamp: isoTimestamp,
  actor: relayServiceActorRef,
  action: teamActivityAction,
  subjects: z.array(TeamActivitySubjectInputSchema).max(64),
  workstream: teamWorkstreamRef.nullable(),
  repoState: teamRepositoryState,
} as const;
const relayActivityEventSchema = z.union([z.object({
  schemaVersion: z.literal(1),
  ...relayActivityEventFields,
}).strict(), z.object({
  schemaVersion: z.literal(2),
  ...relayActivityEventFields,
  origin: TeamPersistedActivityOriginSchema,
  label: teamText(512).optional(),
}).strict()]);

const RelayOperationApplyResponseSchema = z.object({
  operationId: teamOperationId,
  previewRevision: revision,
  applied: z.literal(true),
  idempotentReplay: z.boolean(),
  changes: z.array(TeamFileChangeSchema).max(16),
  localChanges: z.array(RelayLocalChangeSchema).max(16),
  relays: z.array(RelayDetailSchema).max(1),
  events: z.array(relayActivityEventSchema).max(1),
}).strict();

return {
  RelayStateSchema,
  RelayPerspectiveSchema,
  RelayDraftIdSchema,
  RelayEvidenceRefSchema,
  RelayDraftInputSchema,
  RelayDraftSummarySchema,
  RelayDraftDetailSchema,
  RelayDetailSchema,
  RelaySummarySchema,
  RelayDraftListRequestSchema,
  RelayListRequestSchema,
  RelayDraftListResponseSchema,
  RelayListResponseSchema,
  RelayOperationPreviewRequestSchema,
  RelayLocalChangeSchema,
  RelayOperationReceiptSchema,
  RelayOperationPreviewResponseSchema,
  RelayOperationApplyRequestSchema,
  RelayOperationApplyResponseSchema,
};
})();

export const {
  RelayStateSchema,
  RelayPerspectiveSchema,
  RelayDraftIdSchema,
  RelayEvidenceRefSchema,
  RelayDraftInputSchema,
  RelayDraftSummarySchema,
  RelayDraftDetailSchema,
  RelayDetailSchema,
  RelaySummarySchema,
  RelayDraftListRequestSchema,
  RelayListRequestSchema,
  RelayDraftListResponseSchema,
  RelayListResponseSchema,
  RelayOperationPreviewRequestSchema,
  RelayLocalChangeSchema,
  RelayOperationReceiptSchema,
  RelayOperationPreviewResponseSchema,
  RelayOperationApplyRequestSchema,
  RelayOperationApplyResponseSchema,
} = relayContracts;

export const GraphSymbolSchema = z.object({
  id: GraphSymbolIdSchema,
  symbolKind: utf8Text(128),
  name: utf8Text(512),
  qualifiedName: utf8Text(1_024),
  language: utf8Text(128),
  path: repositoryDisplayPath,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  signature: utf8Text(2_048).optional(),
  route: z.string().startsWith("/code/symbols/").max(2_048),
}).strict();

export const WikiLifecycleStateSchema = z.enum([
  "in_flight",
  "promoted",
  "deprecated",
  "archived",
]);

export const WikiGroundingHealthSchema = z.enum([
  "fresh",
  "changed",
  "missing",
  "ambiguous",
  "unverified",
]);

const wikiDisplayText = (maximum: number, minimum = 1) => utf8Text(maximum, minimum)
  .refine(
    (value) => value.normalize("NFC") === value
      && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value),
    "Wiki display text contains unsafe characters.",
  );
const wikiKind = wikiDisplayText(128)
  .refine((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value), "Invalid Wiki entity kind.");
const wikiSourceType = wikiDisplayText(128)
  .refine((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value), "Invalid Wiki source type.");

export const WikiEntityRefSchema = z.object({
  id: WikiEntityIdSchema,
  kind: wikiKind,
  title: wikiDisplayText(512).nullable(),
}).strict();

export const WikiEntitySummarySchema = z.object({
  id: WikiEntityIdSchema,
  kind: wikiKind,
  title: wikiDisplayText(512),
  summary: wikiDisplayText(2_048, 0).nullable(),
  lifecycleState: WikiLifecycleStateSchema,
  groundingHealth: WikiGroundingHealthSchema,
  topics: z.array(WikiEntityIdSchema).max(50),
  topicsTruncated: z.boolean(),
  sourceTypes: z.array(wikiSourceType).max(50),
  sourceTypesTruncated: z.boolean(),
  location: z.object({
    path: repositoryDisplayPath,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }).strict(),
  version: z.object({
    semanticRevision: z.number().int().nonnegative(),
    contentHash: revision,
  }).strict(),
  diagnostics: z.array(HubDiagnosticSchema).max(10),
  diagnosticsTruncated: z.boolean(),
  route: z.string().startsWith("/knowledge/").max(2_048),
}).strict().superRefine((value, context) => {
  if (value.location.endLine < value.location.startLine) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["location"], message: "A Wiki source range cannot end before it starts." });
  }
  if (value.route !== `/knowledge/${encodeURIComponent(value.id)}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["route"], message: "A Knowledge route must identify its entity." });
  }
});

export const WikiSearchResultSchema = z.object({
  id: WikiEntityIdSchema,
  kind: z.literal("wiki"),
  entityKind: wikiKind,
  title: wikiDisplayText(512),
  summary: wikiDisplayText(2_048, 0).nullable(),
  lifecycleState: WikiLifecycleStateSchema,
  groundingHealth: WikiGroundingHealthSchema,
  topics: z.array(WikiEntityIdSchema).max(50),
  topicsTruncated: z.boolean(),
  sourceTypes: z.array(wikiSourceType).max(50),
  sourceTypesTruncated: z.boolean(),
  path: repositoryDisplayPath,
  matchedFields: z.array(z.enum(["id", "title", "summary", "body"])).max(4),
  route: z.string().startsWith("/knowledge/").max(2_048),
}).strict();

export const SymbolSearchResultSchema = GraphSymbolSchema.extend({
  kind: z.literal("code_symbol"),
}).strict();

export const SourceSearchResultSchema = z.object({
  id: identifier,
  kind: z.literal("source_chunk"),
  path: repositoryDisplayPath,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  preview: utf8Text(2_048, 0),
  previewTruncated: z.boolean(),
  matchedTerms: z.array(utf8Text(128)).max(32),
  symbolIds: z.array(GraphSymbolIdSchema).max(8),
  route: z.string().startsWith("/code").max(2_048).optional(),
}).strict();

export const SearchResultSchema = z.discriminatedUnion("kind", [
  WikiSearchResultSchema,
  SymbolSearchResultSchema,
  SourceSearchResultSchema,
]);

export const SearchGroupSchema = z.object({
  status: z.enum(["available", "unavailable", "failed"]),
  items: z.array(SearchResultSchema).max(HUB_LIMITS.maxSearchGroupSize),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
  revision: revision.nullable(),
  code: HubProblemCodeSchema.optional(),
  detail: z.string().min(1).max(2_048).optional(),
}).strict().superRefine((value, context) => {
  if (value.status !== "available") {
    if (
      value.items.length !== 0
      || value.nextCursor !== null
      || value.truncated
      || value.revision !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unavailable or failed search groups cannot contain results.",
      });
    }
    if (value.detail === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["detail"],
        message: "Unavailable or failed search groups require detail.",
      });
    }
    if (value.status === "failed" && value.code === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "Failed search groups require a stable problem code." });
    }
  } else {
    if (value.revision === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: "Available search groups require a snapshot revision." });
    }
    if (value.detail !== undefined || value.code !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Available search groups cannot carry failure details.",
      });
    }
  }
});

export const SearchRequestSchema = z.object({
  q: z.string().trim().min(1).max(HUB_LIMITS.maxQueryCharacters),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
  wikiCursor: cursor.optional(),
  symbolCursor: cursor.optional(),
  sourceCursor: cursor.optional(),
}).strict();

export const SearchResponseSchema = z.object({
  query: z.string().min(1).max(HUB_LIMITS.maxQueryCharacters),
  observedAt: isoTimestamp,
  groups: z.object({
    wiki: SearchGroupSchema,
    symbols: SearchGroupSchema,
    sources: SearchGroupSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const expectedKinds = { wiki: "wiki", symbols: "code_symbol", sources: "source_chunk" } as const;
  for (const group of Object.keys(expectedKinds) as Array<keyof typeof expectedKinds>) {
    if (value.groups[group].items.some((item) => item.kind !== expectedKinds[group])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups", group, "items"],
        message: `The ${group} group contains a result from another search domain.`,
      });
    }
    for (const [index, item] of value.groups[group].items.entries()) {
      if (item.kind !== "wiki" && item.endLine < item.startLine) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["groups", group, "items", index],
          message: "A graph search range cannot end before it starts.",
        });
      }
      if (
        item.kind === "code_symbol"
        && item.route !== `/code/symbols/${encodeURIComponent(item.id)}`
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["groups", group, "items", index, "route"],
          message: "A graph symbol route must identify the projected symbol.",
        });
      }
    }
  }
});

export const CodeWorkspaceViewSchema = z.enum(["overview", "callers", "callees", "impact"]);

export const CodeWorkspaceRequestSchema = z.object({
  view: CodeWorkspaceViewSchema.default("overview"),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  depth: z.coerce.number().int().min(1).max(4).optional(),
  sourceCursor: cursor.optional(),
}).strict().superRefine((value, context) => {
  const relationView = value.view === "callers" || value.view === "callees";
  if (!relationView && (value.cursor !== undefined || value.limit !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Traversal cursors and limits are valid only for callers or callees." });
  }
  if (value.view !== "impact" && value.depth !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["depth"], message: "Impact depth is valid only for the impact view." });
  }
});

export const GraphSourceProjectionSchema = z.object({
  path: repositoryDisplayPath,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  content: utf8Text(128 * 1_024, 0),
  contentHash: revision,
  symbolIds: z.array(GraphSymbolIdSchema).max(100),
}).strict().refine((value) => value.endLine >= value.startLine, {
  message: "A source range cannot end before it starts.",
});

export const GraphSourcePageSchema = z.object({
  items: z.array(GraphSourceProjectionSchema).max(100),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
}).strict();

export const GraphRelationSchema = z.object({
  kind: utf8Text(128),
  sourceId: GraphSymbolIdSchema,
  targetId: GraphSymbolIdSchema,
  path: repositoryDisplayPath.optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
  provenance: utf8Text(128).optional(),
}).strict();

export const GraphOverviewTraversalSchema = z.object({
  view: z.literal("overview"),
}).strict();

export const GraphRelationTraversalSchema = z.object({
  view: z.enum(["callers", "callees"]),
  items: z.array(GraphRelationSchema).max(50),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
}).strict();

export const GraphImpactTraversalSchema = z.object({
  view: z.literal("impact"),
  targetId: GraphSymbolIdSchema,
  roots: z.array(GraphSymbolSchema).max(100),
  impacted: z.array(z.object({
    symbol: GraphSymbolSchema,
    depth: z.number().int().nonnegative().max(4),
    rootId: GraphSymbolIdSchema,
  }).strict()).max(100),
  relations: z.array(GraphRelationSchema).max(500),
  truncated: z.boolean(),
}).strict();

export const CodeWorkspaceTraversalSchema = z.discriminatedUnion("view", [
  GraphOverviewTraversalSchema,
  GraphRelationTraversalSchema,
  GraphImpactTraversalSchema,
]);

export const CodeWorkspaceResponseSchema = z.object({
  revision,
  symbol: GraphSymbolSchema,
  source: GraphSourcePageSchema,
  view: CodeWorkspaceViewSchema,
  traversal: CodeWorkspaceTraversalSchema,
}).strict().superRefine((value, context) => {
  if (value.view !== value.traversal.view) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["traversal"], message: "The traversal payload must match the requested view." });
  }
  if (value.symbol.endLine < value.symbol.startLine) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["symbol"], message: "A graph symbol range cannot end before it starts." });
  }
  if (value.symbol.route !== `/code/symbols/${encodeURIComponent(value.symbol.id)}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["symbol", "route"], message: "The symbol route must identify the projected symbol." });
  }
  for (const [index, source] of value.source.items.entries()) {
    if (source.endLine < source.startLine) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "items", index], message: "A source range cannot end before it starts." });
    }
  }
});

export const WikiEntityListRequestSchema = z.object({
  kind: wikiKind.optional(),
  topic: WikiEntityIdSchema.optional(),
  lifecycle: WikiLifecycleStateSchema.optional(),
  grounding: WikiGroundingHealthSchema.optional(),
  sourceType: wikiSourceType.optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const WikiEntityListResponseSchema = z.object({
  indexedRevision: revision,
  observedAt: isoTimestamp,
  items: z.array(WikiEntitySummarySchema).max(HUB_LIMITS.maxSearchGroupSize),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.nextCursor !== null && !value.truncated) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "A paginated Wiki response must report truncation." });
  }
});

export const WikiProvenanceSchema = z.object({
  kind: z.enum(["human", "agent", "system", "migration", "unknown"]),
  id: wikiDisplayText(256).nullable(),
  capturedAt: isoTimestamp.nullable(),
}).strict();

export const WikiSourceSchema = z.object({
  type: wikiSourceType,
  ref: wikiDisplayText(2_048, 0).nullable(),
  note: wikiDisplayText(2_048, 0).nullable(),
  repository: wikiDisplayText(512, 0).nullable(),
  commit: wikiDisplayText(128, 0).nullable(),
  capturedAt: isoTimestamp.nullable(),
}).strict();

export const WikiGroundingCandidateSchema = z.object({
  node: wikiDisplayText(512),
  fingerprint: wikiDisplayText(256, 0).nullable(),
  file: repositoryDisplayPath.nullable(),
  score: z.number().finite().nullable(),
}).strict();

export const WikiGroundingSchema = z.object({
  state: z.enum(["fresh", "stale", "missing", "unresolved", "ungrounded"]),
  health: WikiGroundingHealthSchema,
  requestedNode: wikiDisplayText(512, 0).nullable(),
  resolvedNode: wikiDisplayText(512, 0).nullable(),
  fingerprint: wikiDisplayText(256, 0).nullable(),
  file: repositoryDisplayPath.nullable(),
  commit: wikiDisplayText(128, 0).nullable(),
  verifiedAt: isoTimestamp.nullable(),
  reason: wikiDisplayText(1_024, 0).nullable(),
  candidates: z.array(WikiGroundingCandidateSchema).max(8),
  candidatesTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  const validHealth = value.state === "fresh" ? value.health === "fresh"
    : value.state === "stale" ? value.health === "changed"
      : value.state === "missing" ? value.health === "missing"
        : value.state === "unresolved" ? ["ambiguous", "unverified"].includes(value.health)
          : value.health === "unverified";
  if (!validHealth) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["health"], message: "Wiki grounding state and health contradict one another." });
  }
  if (value.state === "ungrounded") {
    if (value.requestedNode !== null || value.fingerprint !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestedNode"], message: "Ungrounded Wiki entries cannot identify a requested code node." });
    }
  } else if (value.requestedNode === null || value.fingerprint === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestedNode"], message: "A grounded Wiki entry requires its canonical node and fingerprint." });
  }
  if (value.state === "fresh" && value.resolvedNode === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["resolvedNode"], message: "A fresh Wiki grounding requires its resolved code node." });
  }
});

export const WikiEntityDetailResponseSchema = z.object({
  indexedRevision: revision,
  observedAt: isoTimestamp,
  entity: WikiEntitySummarySchema,
  body: z.object({
    content: utf8Text(128 * 1_024, 0),
    totalBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
  provenance: WikiProvenanceSchema.nullable(),
  sources: z.object({
    items: z.array(WikiSourceSchema).max(50),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
  groundings: z.object({
    items: z.array(WikiGroundingSchema).max(50),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
  relationCount: z.number().int().nonnegative(),
  backlinkCount: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.sources.total < value.sources.items.length || value.groundings.total < value.groundings.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Wiki detail totals cannot be smaller than their bounded previews." });
  }
  if (value.sources.truncated !== (value.sources.total > value.sources.items.length)
    || value.groundings.truncated !== (value.groundings.total > value.groundings.items.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Wiki detail preview truncation must match its exact totals." });
  }
  if (value.body.truncated !== (value.body.totalBytes > new TextEncoder().encode(value.body.content).byteLength)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "truncated"], message: "Wiki body truncation must match its exact byte count." });
  }
});

export const SpecEntityKindSchema = z.enum([
  "spec",
  "requirement",
  "constraint",
  "acceptance_criterion",
]);

export const SpecIndexStateSchema = z.enum([
  "missing",
  "fresh",
  "stale",
  "degraded",
  "rebuild_required",
  "corrupt",
  "migration_required",
]);

const specListFilter = <T extends z.ZodTypeAny>(schema: T, maximum: number) => z.array(schema)
  .min(1)
  .max(maximum)
  .refine(
    (values) => new Set(values as unknown[]).size === values.length,
    "Spec list filters must not contain duplicates.",
  );

export const SpecListRequestSchema = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
  includeArchived: teamBooleanFilter.optional(),
  lifecycleStates: specListFilter(WikiLifecycleStateSchema, 4).optional(),
  groundingHealth: specListFilter(WikiGroundingHealthSchema, 5).optional(),
  topics: specListFilter(WikiEntityIdSchema, 50).optional(),
}).strict();

export const SpecIndexProjectionSchema = z.object({
  state: SpecIndexStateSchema,
  observedAt: isoTimestamp,
  indexedRevision: revision.nullable(),
  indexedAt: isoTimestamp.nullable(),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.state === "fresh" && (value.indexedRevision === null || value.indexedAt === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A fresh Spec index requires its indexed revision and timestamp.",
    });
  }
});

export const SpecSummaryProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  id: WikiEntityIdSchema,
  kind: SpecEntityKindSchema,
  title: wikiDisplayText(512),
  summary: wikiDisplayText(2_048, 0).nullable(),
  lifecycleState: WikiLifecycleStateSchema,
  groundingHealth: WikiGroundingHealthSchema,
  sourcePath: repositoryDisplayPath,
  version: z.object({
    semanticRevision: z.number().int().nonnegative(),
    contentHash: revision,
  }).strict(),
  topics: z.array(WikiEntityIdSchema).max(50),
  sourceTypes: z.array(wikiSourceType).max(50),
  diagnostics: z.array(HubDiagnosticSchema).max(10),
  diagnosticsTruncated: z.boolean(),
}).strict();

export const SpecListPageProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(SpecSummaryProjectionSchema).max(HUB_LIMITS.maxPageSize),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
  estimatedTokens: z.number().int().nonnegative(),
  deterministicRevision: revision,
}).strict().superRefine((value, context) => {
  if (value.items.some((item) => item.kind !== "spec")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: "The Spec list can contain only root Spec entities.",
    });
  }
  if (value.nextCursor !== null && !value.truncated) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["truncated"],
      message: "A paginated Spec response must report truncation.",
    });
  }
});

const specNonReadyIndex = SpecIndexProjectionSchema.refine(
  (value) => value.state !== "fresh",
  "A non-ready Spec response cannot report a fresh index.",
);

export const SpecListResponseSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("ready"),
    index: SpecIndexProjectionSchema.refine(
      (value) => value.state === "fresh",
      "A ready Spec response requires a fresh index.",
    ),
    page: SpecListPageProjectionSchema,
  }).strict(),
  z.object({
    availability: z.enum(["stale", "unavailable"]),
    index: specNonReadyIndex,
    page: z.null(),
  }).strict(),
]).superRefine((value, context) => {
  const staleState = value.index.state === "stale" || value.index.state === "rebuild_required";
  if (value.availability === "stale" && !staleState) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["availability"],
      message: "Only stale or rebuild-required indexes can return stale Spec availability.",
    });
  }
  if (value.availability === "unavailable" && staleState) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["availability"],
      message: "A stale Spec index must use stale availability.",
    });
  }
});

export const SpecHierarchyRelationSchema = z.object({
  type: z.enum(["derived_from", "verified_by", "constrained_by", "refines"]),
  source: z.object({ id: WikiEntityIdSchema, kind: SpecEntityKindSchema }).strict(),
  target: z.object({ id: WikiEntityIdSchema, kind: SpecEntityKindSchema }).strict(),
  note: wikiDisplayText(2_048, 0).nullable(),
}).strict();

export const SpecDetailProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  spec: SpecSummaryProjectionSchema.refine(
    (value) => value.kind === "spec",
    "A Spec detail root must be a Spec entity.",
  ),
  body: utf8Text(64 * 1_024, 0),
  bodyTruncated: z.boolean(),
  provenance: WikiProvenanceSchema.nullable(),
  sources: z.array(WikiSourceSchema).max(HUB_LIMITS.maxPageSize),
  sourcesTruncated: z.boolean(),
  groundings: z.array(WikiGroundingSchema).max(HUB_LIMITS.maxPageSize),
  groundingsTruncated: z.boolean(),
  hierarchy: z.object({
    requirements: z.array(SpecSummaryProjectionSchema).max(HUB_LIMITS.maxPageSize),
    acceptanceCriteria: z.array(SpecSummaryProjectionSchema).max(HUB_LIMITS.maxPageSize),
    constraints: z.array(SpecSummaryProjectionSchema).max(HUB_LIMITS.maxPageSize),
    relations: z.array(SpecHierarchyRelationSchema).max(HUB_LIMITS.maxPageSize),
    estimatedTokens: z.number().int().nonnegative(),
  }).strict(),
  deterministicRevision: revision,
}).strict().superRefine((value, context) => {
  const groups = [
    ["requirements", "requirement"],
    ["acceptanceCriteria", "acceptance_criterion"],
    ["constraints", "constraint"],
  ] as const;
  for (const [group, expectedKind] of groups) {
    if (value.hierarchy[group].some((item) => item.kind !== expectedKind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hierarchy", group],
        message: `Spec ${group} must contain only ${expectedKind} entities.`,
      });
    }
  }
  const hierarchyEntries = value.hierarchy.requirements.length
    + value.hierarchy.acceptanceCriteria.length
    + value.hierarchy.constraints.length
    + value.hierarchy.relations.length;
  if (hierarchyEntries > HUB_LIMITS.maxPageSize) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hierarchy"],
      message: "The bounded Spec hierarchy cannot exceed 100 entries.",
    });
  }
});

export const SpecDetailResponseSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("ready"),
    index: SpecIndexProjectionSchema.refine(
      (value) => value.state === "fresh",
      "A ready Spec response requires a fresh index.",
    ),
    detail: SpecDetailProjectionSchema,
  }).strict(),
  z.object({
    availability: z.enum(["stale", "unavailable"]),
    index: specNonReadyIndex,
    detail: z.null(),
  }).strict(),
]).superRefine((value, context) => {
  const staleState = value.index.state === "stale" || value.index.state === "rebuild_required";
  if (value.availability === "stale" && !staleState) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["availability"],
      message: "Only stale or rebuild-required indexes can return stale Spec availability.",
    });
  }
  if (value.availability === "unavailable" && staleState) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["availability"],
      message: "A stale Spec index must use stale availability.",
    });
  }
});

export const WikiRelationSchema = z.object({
  type: wikiDisplayText(128),
  source: WikiEntityRefSchema,
  target: WikiEntityRefSchema,
  note: wikiDisplayText(2_048, 0).nullable(),
}).strict();

/** A bounded whole-Context view, never a join of separately observed pages. */
export const WikiGraphResponseSchema = z.object({
  indexedRevision: revision,
  observedAt: isoTimestamp,
  nodes: z.array(WikiEntitySummarySchema).max(100),
  relations: z.array(WikiRelationSchema).max(500),
  coverage: z.object({
    nodeLimit: z.literal(100),
    relationLimit: z.literal(500),
    nodesTruncated: z.boolean(),
    relationsTruncated: z.boolean(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.nodes.map((node) => node.id));
  if (ids.size !== value.nodes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: "Context nodes must have distinct identities." });
  }
  if (value.relations.some((relation) => !ids.has(relation.source.id) || !ids.has(relation.target.id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["relations"], message: "Context relationships must connect included nodes." });
  }
});

export const WikiGroundedCodeResponseSchema = z.object({
  indexedRevision: revision,
  observedAt: isoTimestamp,
  entityId: WikiEntityIdSchema,
  graphRevision: revision.nullable(),
  groundings: z.array(z.object({
    requestedNode: wikiDisplayText(512),
    resolvedNode: wikiDisplayText(512).nullable(),
    health: WikiGroundingHealthSchema,
    symbol: GraphSymbolSchema.nullable(),
  }).strict()).max(50),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  for (const grounding of value.groundings) {
    if (grounding.symbol !== null && (value.graphRevision === null || grounding.symbol.id !== grounding.resolvedNode)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["groundings"], message: "A code symbol requires its matching resolved identity and Graph revision." });
    }
  }
});

export const WikiRelationHitSchema = z.object({
  direction: z.enum(["outgoing", "incoming"]),
  relation: WikiRelationSchema,
  entity: WikiEntitySummarySchema,
}).strict();

export const WikiRelationsRequestSchema = z.object({
  direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
  type: wikiDisplayText(128).optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const WikiBacklinksRequestSchema = z.object({
  type: wikiDisplayText(128).optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

const wikiPageEnvelope = {
  indexedRevision: revision,
  observedAt: isoTimestamp,
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
} as const;

export const WikiRelationsResponseSchema = z.object({
  ...wikiPageEnvelope,
  items: z.array(WikiRelationHitSchema).max(HUB_LIMITS.maxSearchGroupSize),
}).strict();

export const WikiBacklinksResponseSchema = z.object({
  ...wikiPageEnvelope,
  items: z.array(WikiRelationSchema).max(HUB_LIMITS.maxSearchGroupSize),
}).strict();

export const CodeKnowledgeRequestSchema = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const CodeKnowledgeHitSchema = z.object({
  entity: WikiEntitySummarySchema,
  matchedNodes: z.array(GraphSymbolIdSchema).min(1).max(50),
}).strict();

export const CodeKnowledgeResponseSchema = z.object({
  ...wikiPageEnvelope,
  items: z.array(CodeKnowledgeHitSchema).max(HUB_LIMITS.maxSearchGroupSize),
}).strict();

export const ActivitySourceSchema = z.enum(["activity", "legacy"]);

export const ActivityRequestSchema = z.object({
  source: ActivitySourceSchema.optional(),
  since: isoTimestamp.optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

/** Actor as immutably recorded or currently resolved for an activity row. */
export const ActivityActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("member"),
    memberId: identifier,
    displayName: utf8Text(256).nullable(),
  }).strict(),
  z.object({
    kind: z.literal("git"),
    name: utf8Text(256).nullable(),
    email: utf8Text(320).nullable(),
  }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "git" && value.name === null && value.email === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Git actor requires a name or email.",
    });
  }
});

export const ActivityEntityRefSchema = z.object({
  id: utf8Text(256),
  entityKind: utf8Text(64),
  title: utf8Text(256).nullable(),
}).strict();

export const ActivitySubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entity"),
    entity: ActivityEntityRefSchema,
  }).strict(),
  z.object({
    kind: z.literal("symbol"),
    symbolId: utf8Text(512),
  }).strict(),
  z.object({
    kind: z.literal("file"),
    path: activityDisplayPath,
  }).strict(),
  z.object({
    kind: z.literal("commit"),
    hash: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  }).strict(),
]);

export const ActivityRepositorySnapshotSchema = z.object({
  branch: utf8Text(1_024).nullable(),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  dirty: z.boolean(),
  observedAt: isoTimestamp,
}).strict();

export const ActivityDiagnosticSchema = z.object({
  code: utf8Text(128),
  severity: z.enum(["error", "warning", "info"]),
  message: utf8Text(256),
  path: activityDisplayPath.optional(),
}).strict();

export const ActivityRecordOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workflow"),
    operation: teamActivityAction,
  }).strict(),
  z.object({ kind: z.literal("custom") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);

const activityItemBase = {
  timestamp: isoTimestamp,
  action: utf8Text(128),
  subjects: z.array(ActivitySubjectSchema).max(8),
  subjectCount: z.number().int().nonnegative(),
  subjectsTruncated: z.boolean(),
  sourcePath: activityDisplayPath,
} as const;

export const CanonicalActivityItemSchema = z.object({
  source: z.literal("activity"),
  id: z.string().regex(/^event_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  ...activityItemBase,
  recordedActor: ActivityActorSchema,
  effectiveActor: ActivityActorSchema,
  actorDiagnostics: z.array(ActivityDiagnosticSchema).max(2),
  recordOrigin: ActivityRecordOriginSchema,
  label: teamText(512).nullable(),
  workstream: ActivityEntityRefSchema.nullable(),
  repository: ActivityRepositorySnapshotSchema,
  revision,
}).strict().superRefine((value, context) => {
  if (value.subjectCount < value.subjects.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectCount"], message: "Subject count cannot be smaller than its preview." });
  }
  if (value.subjectsTruncated !== (value.subjectCount > value.subjects.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectsTruncated"], message: "Subject truncation must match the preview size." });
  }
});

export const LegacyActivityItemSchema = z.object({
  source: z.literal("legacy"),
  id: z.string().regex(/^legacy_[a-f0-9]{64}$/),
  ...activityItemBase,
  recordedActor: z.null(),
  effectiveActor: z.null(),
  actorDiagnostics: z.array(ActivityDiagnosticSchema).length(0),
  workstream: z.null(),
  repository: z.null(),
  revision: z.null(),
  sourceLine: z.number().int().positive(),
  message: utf8Text(2_048, 0),
  messageTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.subjectCount < value.subjects.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectCount"], message: "Subject count cannot be smaller than its preview." });
  }
  if (value.subjectsTruncated !== (value.subjectCount > value.subjects.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectsTruncated"], message: "Subject truncation must match the preview size." });
  }
});

export const ActivityItemSchema = z.union([
  CanonicalActivityItemSchema,
  LegacyActivityItemSchema,
]);

export const ActivityResponseSchema = z.object({
  items: z.array(ActivityItemSchema).max(HUB_LIMITS.maxPageSize),
  nextCursor: cursor.nullable(),
  hasMore: z.boolean(),
  sourceTruncated: z.boolean(),
  deterministicRevision: revision,
  diagnostics: z.array(ActivityDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.hasMore !== (value.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hasMore"], message: "hasMore must match nextCursor presence." });
  }
});

export const HubHealthStatusSchema = z.enum(["healthy", "degraded", "unavailable"]);

export const GraphIndexStatusSchema = z.enum([
  "missing",
  "fresh",
  "stale",
  "degraded",
  "rebuild_required",
  "corrupt",
]);

export const GraphHealthDetailsSchema = z.object({
  indexStatus: GraphIndexStatusSchema,
  observedAt: isoTimestamp,
  lastSuccessfulIndexAt: isoTimestamp.nullable(),
  indexedAt: isoTimestamp.nullable(),
  indexedBranch: utf8Text(1_024).nullable(),
  indexedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  currentBranch: utf8Text(1_024).nullable(),
  currentHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  schemaVersion: z.number().int().nonnegative().nullable(),
  extractorVersion: utf8Text(128).nullable(),
  grammarVersion: utf8Text(128).nullable(),
  parseHealth: z.object({
    total: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failedPaths: z.array(repositoryDisplayPath).max(25),
    failedPathsTruncated: z.boolean(),
  }).strict(),
  changes: z.object({
    total: z.number().int().nonnegative(),
    added: z.array(repositoryDisplayPath).max(25),
    modified: z.array(repositoryDisplayPath).max(25),
    deleted: z.array(repositoryDisplayPath).max(25),
    truncated: z.boolean(),
    branchChanged: z.boolean(),
    manifestChanged: z.boolean(),
    configChanged: z.boolean(),
    grammarChanged: z.boolean(),
  }).strict(),
  allowedJobKinds: z.array(z.enum(["graph_refresh", "graph_rebuild"])).max(2),
  recommendedJobKind: z.enum(["graph_refresh", "graph_rebuild"]).nullable(),
  activeJobId: hubJobId.nullable(),
}).strict().superRefine((value, context) => {
  if (
    value.recommendedJobKind !== null
    && !value.allowedJobKinds.includes(value.recommendedJobKind)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendedJobKind"],
      message: "A recommended graph operation must also be allowed.",
    });
  }
  const parseTotal = value.parseHealth.ok + value.parseHealth.partial + value.parseHealth.failed;
  if (parseTotal !== value.parseHealth.total) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["parseHealth"], message: "Graph parse-health counts must sum to the total." });
  }
});

export const WikiIndexStatusSchema = z.enum([
  "missing",
  "fresh",
  "stale",
  "degraded",
  "rebuild_required",
  "corrupt",
  "migration_required",
]);

export const WikiHealthDetailsSchema = z.object({
  indexStatus: WikiIndexStatusSchema,
  observedAt: isoTimestamp,
  indexedAt: isoTimestamp.nullable(),
  schemaVersion: z.number().int().nonnegative().nullable(),
  indexedRevision: revision.nullable(),
  allowedJobKinds: z.array(z.enum(["wiki_refresh", "wiki_rebuild"])).max(2),
  recommendedJobKind: z.enum(["wiki_refresh", "wiki_rebuild"]).nullable(),
  activeJobId: hubJobId.nullable(),
}).strict().superRefine((value, context) => {
  if (
    value.recommendedJobKind !== null
    && !value.allowedJobKinds.includes(value.recommendedJobKind)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendedJobKind"],
      message: "A recommended Wiki operation must also be allowed.",
    });
  }
});

export const HealthComponentSchema = z.object({
  id: z.enum(["git", "graph", "wiki", "migration", "local_state"]),
  label: z.string().min(1).max(128),
  status: HubHealthStatusSchema,
  summary: z.string().min(1).max(1_024),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  repairJobKind: z.enum(HUB_JOB_KINDS).optional(),
  graph: GraphHealthDetailsSchema.optional(),
  wiki: WikiHealthDetailsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.id !== "graph" && value.graph !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["graph"], message: "Only the graph health component can carry graph details." });
  }
  if (
    value.id === "graph"
    && value.graph !== undefined
    && value.repairJobKind !== undefined
    && value.repairJobKind !== value.graph.recommendedJobKind
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["repairJobKind"], message: "The graph repair action must match its recommended operation." });
  }
  if (value.id !== "wiki" && value.wiki !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["wiki"], message: "Only the Wiki health component can carry Wiki details." });
  }
  if (
    value.id === "wiki"
    && value.wiki !== undefined
    && value.repairJobKind !== undefined
    && value.repairJobKind !== value.wiki.recommendedJobKind
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["repairJobKind"], message: "The Wiki repair action must match its recommended operation." });
  }
});

export const HealthResponseSchema = z.object({
  status: HubHealthStatusSchema,
  observedAt: isoTimestamp,
  components: z.array(HealthComponentSchema).min(1).max(16),
}).strict();

export const HubJobKindSchema = z.enum(HUB_JOB_KINDS);
export const HubJobStateSchema = z.enum(HUB_JOB_STATES);
export const HubJobPhaseSchema = z.enum(HUB_JOB_PHASES);
export const HubJobIdSchema = hubJobId;

export const HubJobProgressSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive().optional(),
}).strict().refine(
  (value) => value.total === undefined || value.completed <= value.total,
  { message: "Completed work cannot exceed total work." },
);

export const HubJobSnapshotSchema = z.object({
  id: HubJobIdSchema,
  scaffoldId,
  kind: HubJobKindSchema,
  generation: z.number().int().positive(),
  phase: HubJobPhaseSchema,
  progress: HubJobProgressSchema.nullable(),
  state: HubJobStateSchema,
  cancelRequested: z.boolean(),
  createdAt: isoTimestamp,
  startedAt: isoTimestamp.optional(),
  finishedAt: isoTimestamp.optional(),
  interruptedReason: z.enum(["user_cancelled", "process_restart", "process_shutdown"])
    .optional(),
  problem: HubProblemDetailsSchema.omit({ requestId: true }).optional(),
  summary: z.string().min(1).max(2_048).optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const JobPageRequestSchema = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const JobPageResponseSchema = z.object({
  items: z.array(HubJobSnapshotSchema).max(HUB_LIMITS.maxPageSize),
  nextCursor: cursor.nullable(),
}).strict();

export const JobStartRequestSchema = z.object({
  kind: HubJobKindSchema,
}).strict();

export const JobCancelRequestSchema = z.object({}).strict();

export const BootstrapRequestSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid bootstrap token."),
}).strict();

export const BootstrapResponseSchema = z.object({
  expiresAt: isoTimestamp,
}).strict();

export const SessionResponseSchema = z.object({
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: isoTimestamp,
}).strict();

export type HubProblemCode = z.infer<typeof HubProblemCodeSchema>;
export type HubProblemDetails = z.infer<typeof HubProblemDetailsSchema>;
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
export type HubCapabilities = z.infer<typeof HubCapabilitiesSchema>;
export type HubActor = z.infer<typeof HubActorSchema>;
export type HomeResponse = z.infer<typeof HomeResponseSchema>;
export type HomeInboxAttention = z.infer<typeof HomeInboxAttentionSchema>;
export type HomeRelayAttention = z.infer<typeof HomeRelayAttentionSchema>;
export type HomeJobsSummary = z.infer<typeof HomeJobsSummarySchema>;
export type TeamMemberId = z.infer<typeof TeamMemberIdSchema>;
export type TeamGitAlias = z.infer<typeof TeamGitAliasSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamMemberListRequest = z.infer<typeof TeamMemberListRequestSchema>;
export type TeamMemberListResponse = z.infer<typeof TeamMemberListResponseSchema>;
export type TeamActorRef = z.infer<typeof TeamActorRefSchema>;
export type TeamCurrentActorResponse = z.infer<typeof TeamCurrentActorResponseSchema>;
export type TeamWorkstreamId = z.infer<typeof TeamWorkstreamIdSchema>;
export type TeamWorkstreamState = z.infer<typeof TeamWorkstreamStateSchema>;
export type TeamWorkstream = z.infer<typeof TeamWorkstreamSchema>;
export type TeamWorkstreamListRequest = z.infer<typeof TeamWorkstreamListRequestSchema>;
export type TeamWorkstreamListResponse = z.infer<typeof TeamWorkstreamListResponseSchema>;
export type TeamActivitySubjectInput = z.infer<typeof TeamActivitySubjectInputSchema>;
export type TeamOperationPreviewRequest = z.infer<typeof TeamOperationPreviewRequestSchema>;
export type TeamFileChange = z.infer<typeof TeamFileChangeSchema>;
export type TeamLocalChange = z.infer<typeof TeamLocalChangeSchema>;
export type TeamOperationReceipt = z.infer<typeof TeamOperationReceiptSchema>;
export type TeamOperationPreviewResponse = z.infer<typeof TeamOperationPreviewResponseSchema>;
export type TeamOperationApplyRequest = z.infer<typeof TeamOperationApplyRequestSchema>;
export type TeamActivityEvent = z.infer<typeof TeamActivityEventSchema>;
export type TeamOperationApplyResponse = z.infer<typeof TeamOperationApplyResponseSchema>;
export type InboxSpecKind = z.infer<typeof InboxSpecKindSchema>;
export type InboxKnowledgeKind = z.infer<typeof InboxKnowledgeKindSchema>;
export type InboxEntityKind = z.infer<typeof InboxEntityKindSchema>;
export type InboxKnowledgeCreateChange = z.infer<typeof InboxKnowledgeCreateChangeSchema>;
export type InboxKnowledgeUpdateChange = z.infer<typeof InboxKnowledgeUpdateChangeSchema>;
export type InboxProposalState = z.infer<typeof InboxProposalStateSchema>;
export type InboxDraftId = z.infer<typeof InboxDraftIdSchema>;
export type InboxProposalId = z.infer<typeof InboxProposalIdSchema>;
export type InboxEvidenceRef = z.infer<typeof InboxEvidenceRefSchema>;
export type InboxSpecCreateChange = z.infer<typeof InboxSpecCreateChangeSchema>;
export type InboxSpecUpdateChange = z.infer<typeof InboxSpecUpdateChangeSchema>;
export type InboxSpecChange = z.infer<typeof InboxSpecChangeSchema>;
export type InboxDraftInput = z.infer<typeof InboxDraftInputSchema>;
export type InboxDraftSummary = z.infer<typeof InboxDraftSummarySchema>;
export type InboxDraftDetail = z.infer<typeof InboxDraftDetailSchema>;
export type InboxProposalSummary = z.infer<typeof InboxProposalSummarySchema>;
export type InboxProposalDetail = z.infer<typeof InboxProposalDetailSchema>;
export type InboxDraftListRequest = z.infer<typeof InboxDraftListRequestSchema>;
export type InboxProposalListRequest = z.infer<typeof InboxProposalListRequestSchema>;
export type InboxDraftListResponse = z.infer<typeof InboxDraftListResponseSchema>;
export type InboxProposalListResponse = z.infer<typeof InboxProposalListResponseSchema>;
export type InboxOperationPreviewRequest = z.infer<typeof InboxOperationPreviewRequestSchema>;
export type InboxLocalChange = z.infer<typeof InboxLocalChangeSchema>;
export type InboxOperationReceipt = z.infer<typeof InboxOperationReceiptSchema>;
export type InboxOperationPreviewResponse = z.infer<typeof InboxOperationPreviewResponseSchema>;
export type InboxOperationApplyRequest = z.infer<typeof InboxOperationApplyRequestSchema>;
export type InboxOperationApplyResponse = z.infer<typeof InboxOperationApplyResponseSchema>;
export type RelayState = z.infer<typeof RelayStateSchema>;
export type RelayPerspective = z.infer<typeof RelayPerspectiveSchema>;
export type RelayId = z.infer<typeof RelayIdSchema>;
export type RelayDraftId = z.infer<typeof RelayDraftIdSchema>;
export type RelayEvidenceRef = z.infer<typeof RelayEvidenceRefSchema>;
export type RelayDraftInput = z.infer<typeof RelayDraftInputSchema>;
export type RelayDraftSummary = z.infer<typeof RelayDraftSummarySchema>;
export type RelayDraftDetail = z.infer<typeof RelayDraftDetailSchema>;
export type RelaySummary = z.infer<typeof RelaySummarySchema>;
export type RelayDetail = z.infer<typeof RelayDetailSchema>;
export type RelayDraftListRequest = z.infer<typeof RelayDraftListRequestSchema>;
export type RelayListRequest = z.infer<typeof RelayListRequestSchema>;
export type RelayDraftListResponse = z.infer<typeof RelayDraftListResponseSchema>;
export type RelayListResponse = z.infer<typeof RelayListResponseSchema>;
export type RelayOperationPreviewRequest = z.infer<typeof RelayOperationPreviewRequestSchema>;
export type RelayLocalChange = z.infer<typeof RelayLocalChangeSchema>;
export type RelayOperationReceipt = z.infer<typeof RelayOperationReceiptSchema>;
export type RelayOperationPreviewResponse = z.infer<typeof RelayOperationPreviewResponseSchema>;
export type RelayOperationApplyRequest = z.infer<typeof RelayOperationApplyRequestSchema>;
export type RelayOperationApplyResponse = z.infer<typeof RelayOperationApplyResponseSchema>;
export type GraphSymbolId = z.infer<typeof GraphSymbolIdSchema>;
export type GraphSymbol = z.infer<typeof GraphSymbolSchema>;
export type WikiEntityId = z.infer<typeof WikiEntityIdSchema>;
export type WikiLifecycleState = z.infer<typeof WikiLifecycleStateSchema>;
export type WikiGroundingHealth = z.infer<typeof WikiGroundingHealthSchema>;
export type WikiEntityRef = z.infer<typeof WikiEntityRefSchema>;
export type WikiEntitySummary = z.infer<typeof WikiEntitySummarySchema>;
export type WikiSearchResult = z.infer<typeof WikiSearchResultSchema>;
export type SymbolSearchResult = z.infer<typeof SymbolSearchResultSchema>;
export type SourceSearchResult = z.infer<typeof SourceSearchResultSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type CodeWorkspaceView = z.infer<typeof CodeWorkspaceViewSchema>;
export type CodeWorkspaceRequest = z.infer<typeof CodeWorkspaceRequestSchema>;
export type GraphSourceProjection = z.infer<typeof GraphSourceProjectionSchema>;
export type GraphSourcePage = z.infer<typeof GraphSourcePageSchema>;
export type GraphRelation = z.infer<typeof GraphRelationSchema>;
export type CodeWorkspaceTraversal = z.infer<typeof CodeWorkspaceTraversalSchema>;
export type CodeWorkspaceResponse = z.infer<typeof CodeWorkspaceResponseSchema>;
export type WikiEntityListRequest = z.infer<typeof WikiEntityListRequestSchema>;
export type WikiEntityListResponse = z.infer<typeof WikiEntityListResponseSchema>;
export type WikiProvenance = z.infer<typeof WikiProvenanceSchema>;
export type WikiSource = z.infer<typeof WikiSourceSchema>;
export type WikiGroundingCandidate = z.infer<typeof WikiGroundingCandidateSchema>;
export type WikiGrounding = z.infer<typeof WikiGroundingSchema>;
export type WikiEntityDetailResponse = z.infer<typeof WikiEntityDetailResponseSchema>;
export type SpecEntityKind = z.infer<typeof SpecEntityKindSchema>;
export type SpecIndexState = z.infer<typeof SpecIndexStateSchema>;
export type SpecListRequest = z.infer<typeof SpecListRequestSchema>;
export type SpecIndexProjection = z.infer<typeof SpecIndexProjectionSchema>;
export type SpecSummaryProjection = z.infer<typeof SpecSummaryProjectionSchema>;
export type SpecListPageProjection = z.infer<typeof SpecListPageProjectionSchema>;
export type SpecListResponse = z.infer<typeof SpecListResponseSchema>;
export type SpecHierarchyRelation = z.infer<typeof SpecHierarchyRelationSchema>;
export type SpecDetailProjection = z.infer<typeof SpecDetailProjectionSchema>;
export type SpecDetailResponse = z.infer<typeof SpecDetailResponseSchema>;
export type WikiRelation = z.infer<typeof WikiRelationSchema>;
export type WikiRelationHit = z.infer<typeof WikiRelationHitSchema>;
export type WikiRelationsRequest = z.infer<typeof WikiRelationsRequestSchema>;
export type WikiBacklinksRequest = z.infer<typeof WikiBacklinksRequestSchema>;
export type WikiRelationsResponse = z.infer<typeof WikiRelationsResponseSchema>;
export type WikiGraphResponse = z.infer<typeof WikiGraphResponseSchema>;
export type WikiGroundedCodeResponse = z.infer<typeof WikiGroundedCodeResponseSchema>;
export type WikiBacklinksResponse = z.infer<typeof WikiBacklinksResponseSchema>;
export type CodeKnowledgeRequest = z.infer<typeof CodeKnowledgeRequestSchema>;
export type CodeKnowledgeHit = z.infer<typeof CodeKnowledgeHitSchema>;
export type CodeKnowledgeResponse = z.infer<typeof CodeKnowledgeResponseSchema>;
export type ActivitySource = z.infer<typeof ActivitySourceSchema>;
export type ActivityRequest = z.infer<typeof ActivityRequestSchema>;
export type ActivityActor = z.infer<typeof ActivityActorSchema>;
export type ActivityEntityRef = z.infer<typeof ActivityEntityRefSchema>;
export type ActivitySubject = z.infer<typeof ActivitySubjectSchema>;
export type ActivityRepositorySnapshot = z.infer<typeof ActivityRepositorySnapshotSchema>;
export type ActivityDiagnostic = z.infer<typeof ActivityDiagnosticSchema>;
export type ActivityRecordOrigin = z.infer<typeof ActivityRecordOriginSchema>;
export type CanonicalActivityItem = z.infer<typeof CanonicalActivityItemSchema>;
export type LegacyActivityItem = z.infer<typeof LegacyActivityItemSchema>;
export type ActivityItem = z.infer<typeof ActivityItemSchema>;
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;
export type GraphIndexStatus = z.infer<typeof GraphIndexStatusSchema>;
export type GraphHealthDetails = z.infer<typeof GraphHealthDetailsSchema>;
export type WikiIndexStatus = z.infer<typeof WikiIndexStatusSchema>;
export type WikiHealthDetails = z.infer<typeof WikiHealthDetailsSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type HubJobKind = z.infer<typeof HubJobKindSchema>;
export type HubJobState = z.infer<typeof HubJobStateSchema>;
export type HubJobPhase = z.infer<typeof HubJobPhaseSchema>;
export type HubJobProgress = z.infer<typeof HubJobProgressSchema>;
export type HubJobSnapshot = z.infer<typeof HubJobSnapshotSchema>;
export type {
  OverviewActivityPanel,
  OverviewContextPanel,
  OverviewFocusIdentitySource,
  OverviewFocusInboxSource,
  OverviewFocusPanel,
  OverviewFocusRelaySource,
  OverviewGraphHealthDetails,
  OverviewIdentityPanel,
  OverviewOperationPanel,
  OverviewResponse,
  OverviewWikiHealthDetails,
} from "./overview.js";
export type JobPageRequest = z.infer<typeof JobPageRequestSchema>;
export type JobPageResponse = z.infer<typeof JobPageResponseSchema>;
export type JobStartRequest = z.infer<typeof JobStartRequestSchema>;
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
