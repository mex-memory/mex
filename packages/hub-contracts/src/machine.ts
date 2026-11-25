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

export const MachineReviewQueueSchema = z.object({
  cards: z.array(MachineReviewRowSchema).max(100).readonly(),
  nextCursor: z.string().nullable(),
  total: countSchema,
  byRepo: z.record(countSchema),
  oldest: isoTimeSchema.nullable(),
  updatingSince: isoTimeSchema.optional(),
  partial: knowledgeReadState.partial,
});

export const MachineReviewActionRequestSchema = z.object({
  action: reviewAction,
  expectedRevision: knowledgeRevisionSchema,
  edited: reviewContent.strict().optional(),
  previewRevision: knowledgeRevisionSchema.optional(),
  reason: z.string().trim().min(1).max(512).optional(),
}).strict();

export const MachineReviewPreviewSchema = MachineKnowledgeWritePreviewSchema.extend({
  type: z.literal("preview"),
  revision: knowledgeRevisionSchema,
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

export const MachineChangeEventSchema = z.object({ topics: z.array(z.enum(["jobs", "home", "knowledge"])).min(1).max(3) });

export type MachineHome = z.infer<typeof MachineHomeSchema>;
export type MachineJob = z.infer<typeof MachineJobSchema>;
export type MachineJobActionRequest = z.infer<typeof MachineJobActionRequestSchema>;
export type MachineChangeEvent = z.infer<typeof MachineChangeEventSchema>;
