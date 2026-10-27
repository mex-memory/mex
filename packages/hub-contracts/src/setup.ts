import { z } from "zod";
import { HUB_LIMITS } from "./limits.js";
export * from "./contact.js";

export const SetupInstallationSchema = z.object({
  state: z.enum(["idle", "running", "succeeded", "failed"]),
  version: z.string().min(1).max(64),
  command: z.string().min(1).max(160),
  message: z.string().min(1).max(512),
}).strict();
export type SetupInstallation = z.infer<typeof SetupInstallationSchema>;

const isoTimestamp = z.string().datetime({ offset: true });
const boundedReason = z.string().min(1).max(512);
const aiTool = z.enum(["claude", "cursor", "windsurf", "copilot", "opencode", "codex"]);

export const SETUP_STAGES = [
  "needs_git",
  "needs_setup",
  "needs_population",
  "needs_finalize",
  "needs_commit",
  "complete",
  "ready",
] as const;

export const SETUP_PROGRESS_STEPS = [
  "detect",
  "scaffold",
  "tools",
  "skills",
  "identity",
  "scan",
  "graph",
  "population",
  "finalize",
] as const;

export const SetupStageSchema = z.enum(SETUP_STAGES);
export const SetupModeSchema = z.enum(["code-repo", "agent-memory"]);
export const SetupProgressStepSchema = z.enum(SETUP_PROGRESS_STEPS);

export const SetupToolStatusSchema = z.object({
  id: aiTool,
  name: z.string().min(1).max(64),
  selected: z.boolean(),
  cliAvailable: z.boolean(),
}).strict();

export const SetupStatusSchema = z.object({
  mode: SetupModeSchema,
  projectName: z.string().min(1).max(256),
  hasGit: z.boolean(),
  hasScaffold: z.boolean(),
  populated: z.boolean(),
  graphReady: z.boolean(),
  wikiReady: z.boolean(),
  state: z.enum(["existing", "fresh", "partial"]),
  stage: SetupStageSchema,
  configuredTools: z.array(aiTool).max(8),
  tools: z.array(SetupToolStatusSchema).max(8),
  ready: z.boolean(),
  commitCommands: z.array(z.string().min(1).max(512)).max(16),
  /** Setup stopped part-way: units settled, units in all, and the one line that continues it. */
  unfinished: z.object({
    done: z.number().int().nonnegative().max(1_024),
    total: z.number().int().positive().max(1_024),
    message: z.string().min(1).max(512),
  }).strict().optional(),
  /** Present when the checkout is already set up: the status-first rerun summary and drift notes. */
  setupHealth: z.object({
    summary: z.string().min(1).max(512),
    notes: z.array(z.string().min(1).max(512)).max(4),
  }).strict().optional(),
}).strict();

export const SetupStartRequestSchema = z.object({
  mode: SetupModeSchema.default("code-repo"),
  tools: z.array(aiTool).max(8).default([]),
  confirmPopulation: z.boolean().optional(),
  openHub: z.boolean().optional(),
}).strict();

export const SetupCancelRequestSchema = z.object({}).strict();

export const SETUP_COMMIT_MAX_FILES = 200;
/** One file's diff is fetched on demand; JSON escaping keeps it inside Hub's 1 MiB response bound. */
export const SETUP_COMMIT_MAX_FILE_DIFF_CHARACTERS = 131_072;
/** Server-retained review text. The preview itself carries only per-file metadata. */
export const SETUP_COMMIT_MAX_TOTAL_DIFF_CHARACTERS = 1_048_576;
export const SETUP_COMMIT_MAX_FILE_BYTES = 262_144;

const setupCommitPath = z.string().min(1).max(1_024)
  .refine((value) => !value.startsWith("/") && !/^[a-z]:/iu.test(value)
    && !/[\\\x00-\x1f\x7f]/u.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Expected a repository-relative path.");
const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

export const SetupCommitPreviewRequestSchema = z.object({}).strict();
const lineCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const SetupCommitFileSchema = z.object({
  path: setupCommitPath,
  status: z.enum(["added", "modified", "deleted"]),
  additions: lineCount,
  deletions: lineCount,
  diffCharacters: z.number().int().nonnegative().max(SETUP_COMMIT_MAX_FILE_DIFF_CHARACTERS),
  truncated: z.boolean(),
}).strict();

export const SetupCommitDiffRequestSchema = z.object({
  revision: z.string().uuid(),
  path: setupCommitPath,
}).strict();

/** One reviewed file's diff, served from the exact snapshot its revision names. */
export const SetupCommitDiffSchema = z.object({
  revision: z.string().uuid(),
  path: setupCommitPath,
  diff: z.string().max(SETUP_COMMIT_MAX_FILE_DIFF_CHARACTERS),
  truncated: z.boolean(),
}).strict();

export const SetupCommitPreviewSchema = z.object({
  revision: z.string().uuid(),
  expiresAt: isoTimestamp,
  branch: z.string().min(1).max(1_024).nullable(),
  head: gitObjectId.nullable(),
  defaultMessage: z.string().trim().min(1).max(2_000),
  files: z.array(SetupCommitFileSchema).max(SETUP_COMMIT_MAX_FILES),
  canCommit: z.boolean(),
  blockedReason: boundedReason.nullable(),
}).strict().superRefine((preview, context) => {
  if (preview.files.reduce((total, file) => total + file.diffCharacters, 0) > SETUP_COMMIT_MAX_TOTAL_DIFF_CHARACTERS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Setup diff exceeds the total review limit." });
  }
  if (new Set(preview.files.map((file) => file.path)).size !== preview.files.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Setup review paths must be unique." });
  }
  if (preview.canCommit && (preview.files.length === 0 || preview.blockedReason !== null || preview.files.some((file) => file.truncated))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A committable setup review must be complete and unblocked." });
  }
});

export const SetupCommitRequestSchema = z.object({
  revision: z.string().uuid(),
  message: z.string().trim().min(1).max(2_000).refine((value) => !value.includes("\0"), "Commit message cannot contain NUL."),
}).strict();

export const SetupCommitResultSchema = z.object({
  commit: gitObjectId,
  files: z.array(setupCommitPath).min(1).max(SETUP_COMMIT_MAX_FILES),
  message: z.string().min(1).max(2_048),
  recoveryRequired: z.boolean().optional(),
}).strict();

export const SetupProgressSchema = z.object({
  step: SetupProgressStepSchema,
  label: z.string().min(1).max(128),
  detail: z.string().min(1).max(HUB_LIMITS.maxIdentifierCharacters * 8).optional(),
}).strict();

export const SETUP_ACTIVITY_LIMIT = 40;

/** The agents MEX can run as background setup sessions (Windsurf has no such CLI). */
export const SETUP_BACKGROUND_AGENTS = ["claude", "codex", "cursor", "copilot", "opencode"] as const;

export const SetupPopulationEventSchema = z.object({
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  at: isoTimestamp,
  kind: z.enum(["starting", "started", "reading", "searching", "writing", "running_command", "delegating", "working", "completed", "failed"]),
  state: z.enum(["running", "completed", "failed"]),
  target: z.enum(["architecture", "stack", "conventions", "decisions", "setup", "router", "agents", "patterns"]).optional(),
}).strict();

/** Process-local action summaries only; no CLI text, paths, inputs, or output. */
export const SetupPopulationActivitySchema = z.object({
  tool: z.enum(SETUP_BACKGROUND_AGENTS),
  startedAt: isoTimestamp,
  lastActivityAt: isoTimestamp.nullable(),
  events: z.array(SetupPopulationEventSchema).max(SETUP_ACTIVITY_LIMIT),
  totalEvents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const SETUP_COVERAGE_SUBSYSTEM_LIMIT = 64;

/**
 * Per-subsystem population progress on larger repositories: how many planned
 * subsystems are done, skipped or running. Paths are repository-relative
 * folders from MEX's own plan, the same ones the population prompt names.
 */
export const SetupPopulationCoverageSchema = z.object({
  phase: z.enum(["shared", "subsystems", "final", "complete"]),
  total: z.number().int().nonnegative().max(SETUP_COVERAGE_SUBSYSTEM_LIMIT),
  done: z.number().int().nonnegative().max(SETUP_COVERAGE_SUBSYSTEM_LIMIT),
  skipped: z.number().int().nonnegative().max(SETUP_COVERAGE_SUBSYSTEM_LIMIT),
  subsystems: z.array(z.object({
    path: z.string().min(1).max(512),
    state: z.enum(["pending", "running", "done", "skipped"]),
  }).strict()).max(SETUP_COVERAGE_SUBSYSTEM_LIMIT),
}).strict();

export const SETUP_TRANSCRIPT_ENTRY_CHARACTERS = 4_096;
export const SETUP_TRANSCRIPT_BATCH_ENTRIES = 32;
export const SETUP_TRANSCRIPT_RETAINED_BYTES = 1_048_576;
export const SETUP_TRANSCRIPT_RETAINED_ENTRIES = 2_048;

/** Visible CLI output, only for the authenticated process-local setup session. */
export const SetupTranscriptEntrySchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  at: isoTimestamp,
  kind: z.enum(["assistant", "command", "output", "file", "tool", "notice"]),
  text: z.string().min(1).max(SETUP_TRANSCRIPT_ENTRY_CHARACTERS),
  truncated: z.boolean(),
}).strict();

export const SetupTranscriptBatchSchema = z.object({
  runId: z.string().uuid(),
  entries: z.array(SetupTranscriptEntrySchema).max(SETUP_TRANSCRIPT_BATCH_ENTRIES),
  cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  firstId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean(),
  done: z.boolean(),
}).strict();

export const SetupRunSchema = z.object({
  status: z.enum(["idle", "running", "succeeded", "failed", "paused", "cancelled"]),
  mode: SetupModeSchema,
  stage: SetupStageSchema,
  populated: z.boolean(),
  ready: z.boolean(),
  selectedTools: z.array(aiTool).max(8),
  prompt: z.string().max(HUB_LIMITS.maxJsonResponseBytes / 2).nullable(),
  populationTool: z.enum(SETUP_BACKGROUND_AGENTS).nullable(),
  populationCompleted: z.boolean(),
  populationActivity: SetupPopulationActivitySchema.optional(),
  populationCoverage: SetupPopulationCoverageSchema.optional(),
  transcriptId: z.string().uuid().optional(),
  commitCommands: z.array(z.string().min(1).max(512)).max(16),
  anchorNotes: z.array(z.string().min(1).max(1_024)).max(16),
  message: z.string().min(1).max(2_048),
  progress: SetupProgressSchema.nullable(),
  error: boundedReason.nullable(),
  startedAt: isoTimestamp.nullable(),
  finishedAt: isoTimestamp.nullable(),
}).strict();

export const SetupCommitResponseSchema = SetupCommitResultSchema.extend({ run: SetupRunSchema });

export type SetupStage = z.infer<typeof SetupStageSchema>;
export type SetupMode = z.infer<typeof SetupModeSchema>;
export type SetupProgressStep = z.infer<typeof SetupProgressStepSchema>;
export type SetupToolStatus = z.infer<typeof SetupToolStatusSchema>;
export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export type SetupStartRequest = z.infer<typeof SetupStartRequestSchema>;
export type SetupProgress = z.infer<typeof SetupProgressSchema>;
export type SetupPopulationEvent = z.infer<typeof SetupPopulationEventSchema>;
export type SetupPopulationActivity = z.infer<typeof SetupPopulationActivitySchema>;
export type SetupPopulationCoverage = z.infer<typeof SetupPopulationCoverageSchema>;
export type SetupTranscriptEntry = z.infer<typeof SetupTranscriptEntrySchema>;
export type SetupTranscriptBatch = z.infer<typeof SetupTranscriptBatchSchema>;
export type SetupRun = z.infer<typeof SetupRunSchema>;
export type SetupCommitFile = z.infer<typeof SetupCommitFileSchema>;
export type SetupCommitPreview = z.infer<typeof SetupCommitPreviewSchema>;
export type SetupCommitDiffRequest = z.infer<typeof SetupCommitDiffRequestSchema>;
export type SetupCommitDiff = z.infer<typeof SetupCommitDiffSchema>;
export type SetupCommitRequest = z.infer<typeof SetupCommitRequestSchema>;
export type SetupCommitResult = z.infer<typeof SetupCommitResultSchema>;
export type SetupCommitResponse = z.infer<typeof SetupCommitResponseSchema>;
