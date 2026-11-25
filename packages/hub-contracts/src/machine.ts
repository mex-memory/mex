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

export const MachineKnowledgeKindSchema = z.enum(["rule", "recipe", "decision", "pitfall", "procedure", "fact"]);
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

export const MachineChangeEventSchema = z.object({ topics: z.array(z.enum(["jobs", "home"])).min(1).max(2) });

export type MachineHome = z.infer<typeof MachineHomeSchema>;
export type MachineJob = z.infer<typeof MachineJobSchema>;
export type MachineJobActionRequest = z.infer<typeof MachineJobActionRequestSchema>;
export type MachineChangeEvent = z.infer<typeof MachineChangeEventSchema>;
