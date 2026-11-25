import { z } from "zod";

const hubModeSchema = z.enum(["background", "terminal"]);
const versionSchema = z.string().min(1);

export const MachineHelloSchema = z.object({
  app: z.literal("mex-hub"),
  version: versionSchema,
  homeId: z.string().min(1),
  mode: hubModeSchema,
});

export const MachineBootstrapSchema = z.object({
  csrfToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

export const MachineSessionSchema = MachineBootstrapSchema.extend({
  version: versionSchema,
  mode: hubModeSchema,
});

const checkoutSchema = z.object({
  path: z.string().min(1),
  state: z.enum(["on", "off", "off until"]),
  offUntil: z.string().nullable(),
  exists: z.boolean(),
});

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["git", "folder"]),
  shared: z.boolean(),
  provisional: z.enum(["unborn", "shallow"]).nullable(),
  checkouts: z.array(checkoutSchema),
});

export const MachineProjectsSchema = z.object({ projects: z.array(projectSchema) });

export const MachineProblemSchema = z.object({
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
  requestId: z.string(),
});

export type MachineSession = z.infer<typeof MachineSessionSchema>;
export type MachineProject = z.infer<typeof projectSchema>;
export type MachineCheckout = z.infer<typeof checkoutSchema>;
export type MachineProblem = z.infer<typeof MachineProblemSchema>;

const countSchema = z.number().int().nonnegative();
const isoTimeSchema = z.string().datetime({ offset: true });

export const MachineKnowledgeKindSchema = z.enum(["rule", "recipe", "decision", "pitfall", "procedure", "fact", "hint"]);
export const MachineKnowledgeAudienceSchema = z.enum(["onlyYou", "team", "hint"]);
export const MachineKnowledgeStatusSchema = z.enum(["upToDate", "codeChanged", "outOfDate", "notChecked"]);
export const MachineKnowledgeStatusCountsSchema = z.object({
  upToDate: countSchema,
  codeChanged: countSchema,
  outOfDate: countSchema,
  notChecked: countSchema,
});

export const MachineKnowledgeSummarySchema = MachineKnowledgeStatusCountsSchema.extend({
  total: countSchema,
  onlyYou: countSchema,
  team: countSchema,
  updatingSince: isoTimeSchema.optional(),
  byKind: z.record(MachineKnowledgeKindSchema, MachineKnowledgeStatusCountsSchema),
});

const knowledgeRevisionSchema = z.string().min(1).max(256);
const knowledgeKeySchema = z.string().min(1).max(512);
const knowledgeContentSchema = z.object({
  oneLine: z.string().trim().min(1).max(1024).regex(/^[^\r\n]+$/u),
  text: z.string().trim().min(1).max(8192),
  kind: MachineKnowledgeKindSchema,
  scope: z.array(z.string().trim().min(1).max(512)).min(1).max(32),
});

export const MachineKnowledgeItemSchema = knowledgeContentSchema.pick({ oneLine: true, kind: true, scope: true }).extend({
  id: z.string().min(1),
  key: knowledgeKeySchema,
  repoId: z.string().min(1),
  audience: MachineKnowledgeAudienceSchema,
  status: MachineKnowledgeStatusSchema,
  lastUsedAt: isoTimeSchema.nullable(),
  revision: knowledgeRevisionSchema,
  checkout: z.string().min(1).optional(),
  useCount30Days: countSchema.optional(),
});

const knowledgeReadState = {
  generatedAt: isoTimeSchema,
  updatingSince: isoTimeSchema.optional(),
  partial: z.array(z.object({ repoId: z.string().optional(), note: z.string() })).optional(),
};

const knowledgeGroupSchema = z.object({
  count: countSchema,
  statusCounts: MachineKnowledgeStatusCountsSchema,
  topItems: z.array(MachineKnowledgeItemSchema).max(3),
});

export const MachineKnowledgeLandingSchema = z.object({
  ...knowledgeReadState,
  groups: z.object({
    byKind: z.array(knowledgeGroupSchema.extend({ kind: MachineKnowledgeKindSchema })).max(7),
    byArea: z.array(knowledgeGroupSchema.extend({
      pattern: z.string().min(1).max(512),
      repoId: z.string().min(1).optional(),
    })),
  }),
  needsLook: z.object({
    total: countSchema,
    items: z.array(MachineKnowledgeItemSchema.extend({ why: z.string().min(1) })).max(3),
  }),
});

const knowledgeSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recorded"), at: isoTimeSchema, description: z.string().min(1) }),
  z.object({ type: z.literal("note"), at: isoTimeSchema, via: z.enum(["cli", "hub"]).optional(), edited: z.boolean().optional() }),
  z.object({ type: z.literal("session"), at: isoTimeSchema, checkedByModel: z.boolean() }),
  z.object({ type: z.literal("team"), path: z.string().min(1), checkout: z.string().min(1) }),
  z.object({ type: z.literal("agent-memory"), agent: z.string().min(1), observations: countSchema.positive() }),
]);

const knowledgeHistorySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("added"), at: isoTimeSchema }),
  z.object({ type: z.literal("edited"), at: isoTimeSchema }),
  z.object({ type: z.literal("learned"), at: isoTimeSchema }),
  z.object({ type: z.literal("evidence"), at: isoTimeSchema }),
  z.object({ type: z.literal("model-check"), at: isoTimeSchema, outcome: z.enum(["still true", "needs attention", "couldn’t tell"]) }),
  z.object({ type: z.literal("git"), at: isoTimeSchema, action: z.enum(["added", "edited"]), actor: z.string(), sha: z.string() }),
]);

export const MachineKnowledgeDetailSchema = MachineKnowledgeItemSchema.merge(knowledgeContentSchema).extend({
  revision: knowledgeRevisionSchema,
  source: knowledgeSourceSchema,
  evidence: z.string().max(8192).optional(),
  checks: z.array(z.object({
    kind: z.enum(["key", "command", "section", "source", "value", "symbol", "legacy-grounding", "pattern", "relation"]),
    target: z.string().min(1).max(2048),
    result: z.enum(["held", "changed", "broken"]).nullable(),
    checkedAt: isoTimeSchema.nullable(),
  })).max(32),
  checkSummary: z.object({ status: MachineKnowledgeStatusSchema, checkedAt: isoTimeSchema.nullable() }).optional(),
  useCount30Days: countSchema,
  useNote: z.string().min(1).optional(),
  editBlocked: z.string().min(1).optional(),
  history: z.array(knowledgeHistorySchema).max(24),
});

export const MachineKnowledgePageSchema = z.object({
  ...knowledgeReadState,
  items: z.array(MachineKnowledgeItemSchema).max(100),
  total: countSchema,
  nextCursor: z.string().nullable(),
  counts: z.object({
    status: MachineKnowledgeStatusCountsSchema,
    kind: z.record(MachineKnowledgeKindSchema, countSchema),
    audience: z.record(MachineKnowledgeAudienceSchema, countSchema),
  }),
});

export const MachineForgottenItemSchema = MachineKnowledgeItemSchema.pick({ id: true, repoId: true, audience: true })
  .extend({ at: isoTimeSchema }).strict();

export const MachineForgottenPageSchema = z.object({
  ...knowledgeReadState,
  items: z.array(MachineForgottenItemSchema).max(50),
  nextCursor: z.string().nullable(),
});

const fileRevision = z.string().regex(/^[a-f0-9]{64}$/u);
const teamApply = {
  checkout: z.string().min(1).max(4_096).optional(),
  apply: z.literal(true).optional(),
  previewRevision: fileRevision.optional(),
};
export const MachineKnowledgeCreateRequestSchema = knowledgeContentSchema.partial({ oneLine: true, scope: true })
  .extend({ repoId: z.string().min(1).max(64) }).strict();
export const MachineKnowledgeEditRequestSchema = knowledgeContentSchema.partial({ oneLine: true, kind: true, scope: true })
  .extend({ expectedRevision: fileRevision, ...teamApply }).strict()
  .refine(({ apply, previewRevision }) => Boolean(apply) === Boolean(previewRevision));
export const MachineKnowledgeForgetRequestSchema = z.object({
  reason: z.string().trim().min(1).max(512).optional(), expectedRevision: fileRevision.optional(), ...teamApply,
}).strict()
  .refine(({ apply, previewRevision }) => Boolean(apply) === Boolean(previewRevision));
export const MachineKnowledgeWritePreviewSchema = z.object({
  diff: z.string(),
  path: z.string(),
  checkout: z.string(),
  revision: fileRevision,
});
export const MachineKnowledgePreviewReplySchema = z.object({ preview: MachineKnowledgeWritePreviewSchema });
export const MachineKnowledgeCreateResponseSchema = MachineKnowledgeDetailSchema;
export const MachineKnowledgeEditResponseSchema = z.union([MachineKnowledgeDetailSchema, MachineKnowledgePreviewReplySchema]);
export const MachineKnowledgeForgetResponseSchema = z.union([MachineForgottenItemSchema, MachineKnowledgePreviewReplySchema]);
export const MachineKnowledgeConflictSchema = MachineProblemSchema.extend({
  current: MachineKnowledgeDetailSchema,
  attempted: z.union([MachineKnowledgeEditRequestSchema, MachineKnowledgeForgetRequestSchema]),
});

const knowledgePathSchema = z.string().min(1).max(4096);
export const MachineKnowledgeCheckoutSchema = z.object({
  repoId: z.string().min(1).max(64),
  checkout: knowledgePathSchema,
}).strict();

const ruleAgentSchema = z.enum(["claude-code", "codex", "cursor", "copilot", "gemini", "opencode"]);
const ruleFileSchema = z.object({
  path: knowledgePathSchema,
  agents: z.array(ruleAgentSchema),
  scope: z.array(z.string().min(1)),
  entryCount: countSchema,
});

export const MachineKnowledgeRulesSchema = z.object({
  cache: z.discriminatedUnion("state", [
    z.object({ state: z.literal("missing") }),
    z.object({
      state: z.enum(["current", "stale"]),
      files: z.array(ruleFileSchema).max(200),
      findings: z.array(z.object({
        kind: z.enum(["conflict", "stale"]),
        paths: z.array(knowledgePathSchema).min(1),
        heading: z.string(),
        message: z.string().min(1),
      })),
    }),
  ]),
  generated: z.array(z.object({ path: knowledgePathSchema, sharing: z.enum(["shared", "local"]) })),
});

export const MachineKnowledgeBriefRequestSchema = MachineKnowledgeCheckoutSchema.extend({
  agent: z.enum(["claude-code", "codex"]),
  path: knowledgePathSchema.optional(),
}).strict();

export const MachineKnowledgeBriefSchema = z.object({
  text: z.string().max(512 * 1024),
  // Map native token_bound to the estimate of the entire text. The limit is supplied separately.
  tokenBound: countSchema,
  tokenLimit: z.number().int().positive(),
  items: z.array(z.object({
    id: z.string().min(1),
    line: z.string().min(1),
    level: z.enum(["personal", "team", "rule-file", "hint"]),
    verdict: z.enum(["held", "changed", "broken", "unknown"]),
    tokens: countSchema,
  })),
  coverage: z.object({ files: z.array(ruleFileSchema) }),
});

export type MachineKnowledgeCheckout = z.infer<typeof MachineKnowledgeCheckoutSchema>;
export type MachineKnowledgeRules = z.infer<typeof MachineKnowledgeRulesSchema>;
export type MachineKnowledgeBriefRequest = z.infer<typeof MachineKnowledgeBriefRequestSchema>;
export type MachineKnowledgeBrief = z.infer<typeof MachineKnowledgeBriefSchema>;

const reviewAction = z.enum(["share", "keep", "edit", "use", "keepCurrent", "retire"]);
const reviewContent = knowledgeContentSchema.omit({ oneLine: true }).extend({ claim: knowledgeContentSchema.shape.oneLine });
const reviewNote = z.object({ key: knowledgeKeySchema, audience: MachineKnowledgeAudienceSchema });

const reviewRowSchema = reviewContent.omit({ text: true }).extend({
  key: z.string().min(3).max(512),
  cardId: z.string().min(1),
  repoId: z.string().min(1),
  revision: knowledgeRevisionSchema,
  checkout: z.string().min(1),
  reason: z.string().min(1),
  checkedByModel: z.boolean(),
  sources: z.object({ count: countSchema, producer: z.string().min(1), checkouts: z.array(z.string().min(1)) }),
  createdAt: isoTimeSchema,
  expiresAt: isoTimeSchema,
  contradiction: z.object({ current: z.array(reviewNote.extend({ claim: reviewContent.shape.claim })).min(1) }).optional(),
  retireTarget: reviewNote.optional(),
  actions: z.array(reviewAction),
  disabled: z.record(reviewAction, z.string().min(1)).optional(),
});
const reviewKeyMatches = ({ key, repoId, cardId }: z.infer<typeof reviewRowSchema>) => key === `${repoId}:${cardId}`;
export const MachineReviewRowSchema = reviewRowSchema.refine(reviewKeyMatches);
export const MachineReviewCardSchema = reviewRowSchema.extend({ text: reviewContent.shape.text }).refine(reviewKeyMatches);

export const MachineReviewCountsSchema = z.object({ total: countSchema, byRepo: z.record(countSchema) });
export const MachineReviewQueueSchema = MachineReviewCountsSchema.extend({
  cards: z.array(MachineReviewRowSchema).max(100).readonly(),
  nextCursor: z.string().nullable(),
  oldest: isoTimeSchema.nullable(),
  updatingSince: isoTimeSchema.optional(),
  partial: knowledgeReadState.partial,
});

export const MachineReviewActionRequestSchema = z.object({
  action: reviewAction,
  expectedRevision: knowledgeRevisionSchema,
  edited: reviewContent.strict().optional(),
  then: z.enum(["keep", "share"]).optional(),
  apply: z.literal(true).optional(),
  previewRevision: knowledgeRevisionSchema.optional(),
  reason: z.string().trim().min(1).max(512).optional(),
}).strict();

const reviewEffectsSchema = z.object({
  save: reviewNote.extend({ audience: z.literal("onlyYou"), claim: reviewContent.shape.claim }),
  retire: z.array(reviewNote.extend({ claim: reviewContent.shape.claim })).max(129),
  cost: z.literal(0),
});

export const MachineReviewPreviewReplySchema = z.object({
  preview: MachineKnowledgeWritePreviewSchema.extend({
    revision: knowledgeRevisionSchema,
    effects: reviewEffectsSchema.optional(),
    checks: z.array(z.object({
      id: z.enum(["secrets", "repository", "checks"]),
      status: z.enum(["pass", "warn", "fail"]),
      label: z.string().min(1),
    })).max(3),
  }),
});
export type MachineReviewPreviewReply = z.infer<typeof MachineReviewPreviewReplySchema>;

export const MachineReviewPreviewSchema = MachineKnowledgeWritePreviewSchema.extend({
  type: z.literal("preview"),
  revision: knowledgeRevisionSchema,
  effects: reviewEffectsSchema.optional(),
  checks: z.array(z.object({
    id: z.enum(["privacy", "repository", "checks"]),
    status: z.enum(["passed", "warning", "blocked"]),
    message: z.string().min(1),
  })),
});
const reviewApplied = z.object({
  type: z.literal("applied"),
  outcome: z.enum(["kept", "shared", "used", "keptCurrent", "retired"]),
  toast: z.string().min(1),
  knowledgeKey: knowledgeKeySchema,
});
const reviewHandled = z.object({
  type: z.literal("alreadyHandled"),
  outcome: z.enum(["Kept", "Shared", "Used"]).optional(),
});
export const MachineReviewActionResponseSchema = z.discriminatedUnion("type", [MachineReviewPreviewSchema, reviewApplied, reviewHandled]);

export type MachineReviewRow = z.infer<typeof MachineReviewRowSchema>;
export type MachineReviewCard = z.infer<typeof MachineReviewCardSchema>;
export type MachineReviewQueue = z.infer<typeof MachineReviewQueueSchema>;
export type MachineReviewActionRequest = z.infer<typeof MachineReviewActionRequestSchema>;
export type MachineReviewActionResponse = z.infer<typeof MachineReviewActionResponseSchema>;

export const MachineDailyActivitySchema = z.object({
  day: z.string().date(),
  sessions: countSchema,
  gave: countSchema,
  heldBack: countSchema,
  replaced: countSchema,
});

const homeMetricsSchema = z.object({
  activity: z.array(MachineDailyActivitySchema).length(7).readonly(),
  agents: z.array(z.string()).readonly(),
  week: z.object({ percent: z.number().finite().nonnegative().nullable(), capPercent: z.number().positive() }),
});

export const MachineHomeSchema = homeMetricsSchema.extend({
  generatedAt: isoTimeSchema,
  pending: z.boolean().optional(),
  byRepo: z.record(homeMetricsSchema).readonly(),
  needs: z.array(z.object({
    id: z.string(),
    repoId: z.string(),
    rule: z.string(),
    waitingSince: isoTimeSchema,
    kind: z.enum(["rule", "missingFolder"]).optional(),
  })).max(20).readonly(),
  needsCount: z.record(z.object({ count: countSchema, oldest: isoTimeSchema })).readonly(),
  knowledge: z.record(MachineKnowledgeSummarySchema).readonly(),
  sessions: z.array(z.object({
    id: z.string(),
    repoId: z.string(),
    agent: z.string(),
    at: isoTimeSchema,
    gave: countSchema,
    heldBack: countSchema,
    replaced: countSchema,
  })).max(20).readonly(),
});

const hubJobStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("running"), pausing: z.boolean().optional(), stopping: z.boolean().optional() }),
  z.object({ phase: z.enum(["paused", "queued", "done", "doneWithGaps", "stopped"]) }),
  z.object({ phase: z.literal("waiting"), reason: z.string() }),
  z.object({ phase: z.literal("failed"), cause: z.string(), identicalFailures: countSchema }),
]);

export const MachineJobSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  label: z.string(),
  kind: z.string(),
  state: hubJobStateSchema,
  activity: z.string().optional(),
  progress: z.object({ completed: countSchema, total: countSchema.positive() }).optional(),
  result: z.object({ count: countSchema, unit: z.enum(["rule", "file"]), verb: z.enum(["Learned", "Mapped", "Checked"]) }).optional(),
  cost: z.object({ estimatedTokens: countSchema, usedTokens: countSchema.optional(), startsWhenIdle: z.boolean().optional() }).nullable(),
  started: isoTimeSchema.optional(),
});

export const MachineJobsSchema = z.array(MachineJobSchema).max(100).readonly();
export const MachineJobActionRequestSchema = z.object({
  action: z.enum(["pause", "resume", "stop", "reset"]),
  expectedState: z.enum(["queued", "running", "paused", "waiting", "done", "done with gaps", "failed", "cancelled"]),
}).strict();
export const MachineJobActionResponseSchema = MachineJobSchema;
export const MachineJobConflictSchema = MachineProblemSchema.extend({ job: MachineJobSchema });

const setupRevision = z.string().regex(/^[a-f0-9]{64}$/u);
const setupJobState = MachineJobActionRequestSchema.shape.expectedState;
export const MachineSetupRepoIdSchema = z.string().regex(/^[gf]-[a-f0-9]{24}$/u);

export const MachineSetupStepKindSchema = z.enum(["file-index", "code-facts", "graph-build", "learn-deeper"]);
export const MachineSetupStepSchema = z.object({
  kind: MachineSetupStepKindSchema,
  jobId: z.string().min(1),
  label: z.string().min(1),
  scope: z.string().nullable(),
  state: setupJobState,
  revision: setupRevision.optional(),
  pending: z.enum(["pause", "cancel"]).optional(),
  estimate: z.object({ tokens: countSchema.optional(), seconds: countSchema.optional() }).optional(),
  progress: z.object({
    done: countSchema.optional(),
    total: countSchema.optional(),
    unit: z.string().optional(),
    message: z.string(),
  }).optional(),
  summary: z.string().optional(),
  cost: z.object({ uncachedInput: countSchema, cacheWrite: countSchema, cacheRead: countSchema, output: countSchema }),
  startedAt: isoTimeSchema,
  finishedAt: isoTimeSchema.nullable(),
  error: z.string().optional(),
});

export const MachineSetupQuoteSchema = z.object({
  agent: z.enum(["Claude Code", "Codex"]),
  revision: setupRevision.optional(),
  tokens: z.number().int().positive(),
  seconds: z.number().int().positive(),
  ceilingTokens: z.number().int().positive(),
  recentUse: z.string().optional(),
  weekly: z.boolean(),
  privateRepo: z.boolean(),
});

export const MachineSetupLearningSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("offered"), quote: MachineSetupQuoteSchema }),
  z.object({ state: z.literal("no-review-remote") }),
  z.object({ state: z.literal("unavailable"), reason: z.string().min(1) }),
  z.object({ state: z.literal("skipped") }),
]);

export const MachineSetupQuestionSchema = z.object({
  id: z.string().min(1),
  revision: setupRevision.optional(),
  type: z.enum(["rule-conflict", "test-command", "layer-exception", "hand-edited"]),
  question: z.string().min(1),
  details: z.array(z.string()),
  choices: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) })).min(2).max(3),
  suggested: z.string().optional(),
  outcome: z.discriminatedUnion("status", [
    z.object({ status: z.literal("skipped") }),
    z.object({ status: z.literal("saved"), line: z.string() }),
    z.object({ status: z.literal("noted"), line: z.string() }),
    z.object({ status: z.literal("not saved"), line: z.string() }),
  ]).optional(),
});

export const MachineSetupSummarySchema = z.object({
  elapsedMs: countSchema.optional(),
  findings: z.array(z.object({ label: z.string(), text: z.string() })).max(16),
  commandsSaved: z.boolean().optional(),
});

export const MachineRepoSetupSchema = z.object({
  repoId: z.string().min(1),
  checkout: z.string().min(1),
  steps: z.array(MachineSetupStepSchema).max(4),
  unavailableSteps: z.array(z.object({
    kind: MachineSetupStepKindSchema.exclude(["learn-deeper"]),
    reason: z.string().min(1),
  })).max(3).optional(),
  learnDeeper: MachineSetupLearningSchema.optional(),
  offerRevision: setupRevision.optional(),
  missingCheckout: z.boolean().optional(),
  questions: z.array(MachineSetupQuestionSchema).max(5),
  summary: MachineSetupSummarySchema,
});

export const MachineSetupSchema = z.object({ repos: z.array(MachineRepoSetupSchema).max(128).readonly() });
export type MachineSetup = z.infer<typeof MachineSetupSchema>;
export type MachineRepoSetup = z.infer<typeof MachineRepoSetupSchema>;
export type MachineSetupStep = z.infer<typeof MachineSetupStepSchema>;
export type MachineSetupQuote = z.infer<typeof MachineSetupQuoteSchema>;
export type MachineSetupQuestion = z.infer<typeof MachineSetupQuestionSchema>;

export const MachineSetupRepoStatusSchema = z.object({
  repoId: MachineSetupRepoIdSchema,
  checkout: z.string().optional(),
  status: z.enum(["missing", "notStarted", "failed", "running", "stopped", "doneWithGaps", "done"]),
});

export const MachineSetupSnapshotSchema = z.object({
  repos: z.array(MachineSetupRepoStatusSchema).max(128).readonly().optional(),
  repo: MachineRepoSetupSchema.nullable().optional(),
  updatingSince: isoTimeSchema.optional(),
  issue: z.string().optional(),
});

export const MachineSetupStepActionSchema = z.object({
  action: z.enum(["pause", "resume", "cancel"]),
  expectedRevision: setupRevision,
}).strict();

export const MachineSetupQuoteRequestSchema = z.object({ expectedRevision: setupRevision }).strict();
export const MachineSetupLearningDecisionSchema = z.object({ quoteRevision: setupRevision }).strict();
export const MachineSetupSavedSchema = z.object({ saved: z.literal(true) });

const setupQuestionRef = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/u), revision: setupRevision }).strict();
export const MachineSetupAnswerRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("answer"), question: setupQuestionRef, choice: z.enum(["1", "2", "3", "skip"]) }).strict(),
  z.object({ action: z.literal("skipAll"), questions: z.array(setupQuestionRef).min(1).max(5) }).strict(),
]);
export const MachineSetupAnswerResultSchema = z.object({ questions: z.array(MachineSetupQuestionSchema).max(5) });

export type MachineSetupRepoStatus = z.infer<typeof MachineSetupRepoStatusSchema>;
export type MachineSetupSnapshot = z.infer<typeof MachineSetupSnapshotSchema>;
export type MachineSetupLearning = z.infer<typeof MachineSetupLearningSchema>;
export type MachineSetupStepAction = z.infer<typeof MachineSetupStepActionSchema>;
export type MachineSetupAnswerRequest = z.infer<typeof MachineSetupAnswerRequestSchema>;

export const MachineChangeEventSchema = z.object({ topics: z.array(z.enum(["jobs", "home", "knowledge", "review", "agents", "settings", "setup"])).min(1).max(7) });

export type MachineHome = z.infer<typeof MachineHomeSchema>;
export type MachineJob = z.infer<typeof MachineJobSchema>;
export type MachineJobActionRequest = z.infer<typeof MachineJobActionRequestSchema>;
export type MachineChangeEvent = z.infer<typeof MachineChangeEventSchema>;

export const MachineAgentIdSchema = z.enum(["claude-code", "codex", "copilot", "opencode"]);
const machinePathSchema = z.string().min(1).max(4096);
const machineLabelSchema = z.string().min(1).max(512);
const agentFileSchema = z.object({
  path: machinePathSchema,
  kind: z.enum(["hookConfig", "rule", "gitExclude", "agentSettings"]),
  hiddenFromGit: z.boolean().nullable(),
  repo: machineLabelSchema.optional(),
});

export const MachineAgentSchema = z.object({
  id: MachineAgentIdSchema,
  name: machineLabelSchema,
  detected: z.boolean().optional(),
  statusNote: machineLabelSchema.optional(),
  state: z.enum(["working", "needsRepair", "needsApproval", "notSetUp", "notFound"]),
  hooks: z.object({
    canVerify: z.boolean(),
    events: z.array(z.object({
      name: machineLabelSchema,
      status: z.enum(["installed", "missing", "unverified"]),
    })).max(32),
  }),
  trust: z.enum(["approved", "needsApproval", "unknown"]),
  lastFiredAt: isoTimeSchema.nullable(),
  errors: z.array(z.object({ at: isoTimeSchema, message: machineLabelSchema })).max(5),
  files: z.array(agentFileSchema).max(128),
  repair: z.enum(["browser", "terminal", "unavailable"]),
});

const machineSnapshot = {
  updatingSince: isoTimeSchema.optional(),
  issue: machineLabelSchema.optional(),
};
export const MachineAgentsSnapshotSchema = z.object({
  ...machineSnapshot,
  agents: z.array(MachineAgentSchema).max(4).optional(),
  pathWarning: z.object({
    paths: z.array(machinePathSchema).min(1).max(8),
    hubEntry: machinePathSchema,
  }).optional(),
});
export const MachineAgentSnapshotSchema = MachineAgentsSnapshotSchema.omit({ agents: true }).extend({ agent: MachineAgentSchema.optional() });

const repairChangeSchema = z.object({ path: machinePathSchema }).and(z.union([
  z.object({ diff: z.string().min(1).max(64 * 1024) }),
  z.object({ description: machineLabelSchema }),
]));

export const MachineAgentRepairPreviewSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser"),
    agentId: MachineAgentIdSchema,
    revision: z.string().min(1).max(256),
    previewToken: z.string().uuid().optional(),
    changes: z.array(repairChangeSchema).min(1).max(16),
  }),
  z.object({
    type: z.literal("terminal"),
    agentId: MachineAgentIdSchema,
    reason: machineLabelSchema,
    command: machineLabelSchema,
  }),
]);

export const MachineAgentRepairRequestSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  previewToken: z.string().uuid(),
}).strict();

export const MachineAgentRepairResultSchema = z.object({ agent: MachineAgentSchema });

const settingSourceSchema = z.enum(["default", "global", "repo", "checkout", "environment", "policy"]);
const settingAvailabilitySchema = z.object({
  source: settingSourceSchema,
  disabledReason: machineLabelSchema.optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});
const machineToggleSchema = settingAvailabilitySchema.extend({ enabled: z.boolean() });
const checkoutPowerSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("on") }).strict(),
  z.object({ state: z.literal("off") }).strict(),
  z.object({ state: z.literal("offUntil"), until: isoTimeSchema }).strict(),
]);
const sharingModeSchema = z.enum(["automatic", "manual"]);

export const MachineStorageSchema = z.object({
  recordBytes: countSchema,
  hooksBytes: countSchema,
  indexes: z.array(z.object({ repoId: machineLabelSchema, repo: machineLabelSchema, bytes: countSchema, path: machinePathSchema.optional() })).max(128),
  notesBytes: countSchema,
  telemetryBytes: countSchema,
  totalBytes: countSchema,
  paths: z.object({
    record: machinePathSchema, hooks: machinePathSchema, indexes: machinePathSchema,
    notes: machinePathSchema, telemetry: z.array(machinePathSchema).max(2),
  }).optional(),
  partial: z.boolean().optional(),
  retention: z.object({
    deliveryDays: countSchema.positive(),
    captureDays: countSchema.positive(),
    captureMegabytes: countSchema.positive(),
  }),
});

export const MachineOutboundSchema = z.object({
  telemetry: z.array(z.object({
    id: machineLabelSchema,
    at: isoTimeSchema,
    event: machineLabelSchema,
    fields: z.array(machineLabelSchema).max(32),
  })).max(100),
  modelCalls: z.array(z.object({
    id: machineLabelSchema,
    at: isoTimeSchema,
    purpose: machineLabelSchema,
    agent: machineLabelSchema,
    tokens: countSchema,
    estimated: z.boolean(),
  })).max(100),
});

export const MachineSettingsSchema = z.object({
  browser: z.object({
    signOut: settingAvailabilitySchema,
    signOutEverywhere: settingAvailabilitySchema,
  }),
  everywhere: machineToggleSchema,
  capture: machineToggleSchema,
  repos: z.array(z.object({
    id: machineLabelSchema,
    name: machineLabelSchema,
    checkouts: z.array(settingAvailabilitySchema.extend({
      path: machinePathSchema,
      power: checkoutPowerSchema,
    })).max(64),
    capture: machineToggleSchema,
    sharing: settingAvailabilitySchema.extend({ mode: sharingModeSchema }),
    weekly: z.object({ nextRunAt: isoTimeSchema }).nullable(),
    weeklyUnavailable: z.boolean().optional(),
  })).max(128),
  ai: homeMetricsSchema.shape.week,
  telemetry: machineToggleSchema.extend({ explanation: machineLabelSchema.optional() }),
  outbound: MachineOutboundSchema,
  hints: z.object({
    active: countSchema.nullable(),
    confirmed: countSchema.nullable(),
    expiryMonths: z.number().int().min(1).max(120).nullable(),
    source: settingSourceSchema,
    repos: z.array(z.object({
      id: machineLabelSchema, name: machineLabelSchema, expiryMonths: z.number().int().min(1).max(120),
    })).max(128).optional(),
  }),
  storage: MachineStorageSchema,
  about: z.object({
    version: versionSchema,
    homePath: machinePathSchema,
    background: z.object({ startedAt: isoTimeSchema, version: versionSchema }).nullable(),
    hubMode: hubModeSchema,
    backgroundUnavailable: z.boolean().optional(),
  }),
});

export const MachineSignOutRequestSchema = z.object({
  type: z.literal("signOut"),
  scope: z.enum(["thisBrowser", "everywhere"]),
}).strict();
export const MachineGlobalPowerRequestSchema = z.object({
  type: z.literal("globalPower"),
  enabled: z.boolean(),
}).strict();
export const MachineCheckoutPowerRequestSchema = z.object({
  type: z.literal("checkoutPower"),
  path: machinePathSchema,
  power: checkoutPowerSchema,
}).strict();
export const MachineCaptureRequestSchema = z.object({
  type: z.literal("capture"),
  enabled: z.boolean(),
  repoId: machineLabelSchema.optional(),
}).strict();
export const MachineSharingRequestSchema = z.object({
  type: z.literal("sharing"),
  repoId: machineLabelSchema,
  mode: sharingModeSchema,
}).strict();
export const MachineTelemetryRequestSchema = z.object({
  type: z.literal("telemetry"),
  enabled: z.boolean(),
}).strict();
export const MachineSettingsWriteRequestSchema = z.discriminatedUnion("type", [
  MachineSignOutRequestSchema,
  MachineGlobalPowerRequestSchema,
  MachineCheckoutPowerRequestSchema,
  MachineCaptureRequestSchema,
  MachineSharingRequestSchema,
  MachineTelemetryRequestSchema,
]);

export const MachineSettingsSnapshotSchema = z.object({
  ...machineSnapshot,
  settings: MachineSettingsSchema.optional(),
});

export const MachineSettingsApplyRequestSchema = z.object({
  change: z.discriminatedUnion("type", [
    MachineGlobalPowerRequestSchema, MachineCheckoutPowerRequestSchema, MachineCaptureRequestSchema,
    MachineSharingRequestSchema, MachineTelemetryRequestSchema,
  ]),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const MachineSettingsApplyResultSchema = z.object({ saved: z.literal(true), notice: machineLabelSchema.optional() });

export const MachineUninstallPreviewSchema = z.object({
  changes: z.array(z.object({
    id: machineLabelSchema,
    group: machineLabelSchema,
    path: machinePathSchema,
    entry: machineLabelSchema,
    before: z.string().max(4096).nullable(),
    mexValue: z.string().min(1).max(4096),
    note: machineLabelSchema.optional(),
    restores: z.string().max(4096).nullable(),
  })).max(512),
  notRemoved: z.array(z.object({ path: machinePathSchema, kind: z.enum(["personalRule", "gitExclude", "teamRule", "teamKnowledge"]) })).max(512),
  dataPath: machinePathSchema,
  dataSize: countSchema,
  additionalDataPath: machinePathSchema.optional(),
  partial: z.boolean().optional(),
});

export const MachineUninstallSnapshotSchema = z.object({
  ...machineSnapshot,
  preview: MachineUninstallPreviewSchema.optional(),
});
