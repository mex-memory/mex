/**
 * Wire types for the `mex ui` JSON API.
 *
 * These mirror the payloads produced by the server modules in the root package
 * (`src/ui/snapshot.ts`, `src/ui/graph-stats.ts`, `src/ui/grounding.ts`,
 * `src/ui/jobs.ts`, `src/ui/api.ts`). They are declared here rather than imported so the frontend
 * builds without pulling Node types into its program; the response shapes are
 * pinned on the server side by `test/ui-api.test.ts`.
 */

export type ProjectStatus = "empty" | "ready" | "error";

export interface ScaffoldIdentity {
  scaffold_id: string;
  scaffold_name: string;
  origin: string | null;
  upstream: string | null;
}

export interface ScaffoldFileStatus {
  file: string;
  exists: boolean;
  populated: boolean;
  lastUpdated: string | null;
  bytes: number;
}

export interface GraphFileStatus {
  present: boolean;
  path: string;
  bytes: number;
  modifiedAt: string | null;
}

export interface SnapshotError {
  message: string;
  hint: string | null;
  canRunSetup: boolean;
}

export type AiTool = "claude" | "cursor" | "windsurf" | "copilot" | "opencode" | "codex";

export interface ProjectSnapshot {
  status: ProjectStatus;
  version: string;
  root: string;
  projectRoot: string;
  projectName: string;
  isGitRepo: boolean;
  scaffoldRoot: string | null;
  identity: ScaffoldIdentity | null;
  aiTools: AiTool[];
  scaffold: {
    files: ScaffoldFileStatus[];
    total: number;
    present: number;
    populated: number;
  };
  graph: GraphFileStatus;
  capturedAt: string;
  error: SnapshotError | null;
}

export type SetupMode = "code-repo" | "agent-memory";

export type ProjectState = "existing" | "fresh" | "partial";

export interface SetupPlan {
  projectRoot: string;
  projectName: string;
  isGitRepo: boolean;
  hasScaffold: boolean;
  state: ProjectState;
  scaffoldFiles: string[];
  isMexRepo: boolean;
  populationPrompt: string;
}

export type Severity = "error" | "warning" | "info";

export interface DriftIssue {
  code: string;
  severity: Severity;
  file: string;
  line: number | null;
  message: string;
}

export interface DriftReport {
  score: number;
  issues: DriftIssue[];
  filesChecked: number;
  timestamp: string;
}

export interface DriftPayload {
  report: DriftReport;
  warnings: string[];
}

export interface EventEntry {
  timestamp: string;
  kind: "decision" | "note" | "risk" | "todo";
  message: string;
  files: string[];
  cwd: string;
  source?: string;
  status?: string;
}

export interface HeartbeatResult {
  ok: boolean;
  staleFiles: Array<{ file: string; days: number }>;
  memoryCleanupDue: boolean;
  oldDailyMemoryFiles: string[];
}

export interface ActivityPayload {
  events: EventEntry[];
  heartbeat: HeartbeatResult;
}

export interface CountByKind {
  kind: string;
  count: number;
}

export interface LanguageStats {
  language: string;
  files: number;
  nodes: number;
}

export interface IndexedFileSummary {
  path: string;
  language: string;
  nodeCount: number;
  parseStatus: "ok" | "partial" | "failed";
  modifiedAt: string;
  indexedAt: string;
}

export type GraphUnavailableReason = "missing" | "needs-rebuild" | "error";

export interface GraphStats {
  available: boolean;
  unavailable: { reason: GraphUnavailableReason; message: string } | null;
  totals: { nodes: number; edges: number; files: number };
  health: {
    indexedFiles: number;
    okFiles: number;
    partialFiles: number;
    failedFiles: number;
  };
  nodesByKind: CountByKind[];
  edgesByKind: CountByKind[];
  languages: LanguageStats[];
  recentFiles: IndexedFileSummary[];
  manifestHash: string | null;
}

export interface GroundingFileCoverage {
  file: string;
  authored: number;
  captured: number;
}

export interface GroundingCoverage {
  graphAvailable: boolean;
  authored: number;
  captured: number;
  needsCapture: boolean;
  files: GroundingFileCoverage[];
  error: string | null;
}

export interface GroundingCaptureResult {
  projectRoot: string;
  captured: number;
  skipped: number;
  warnings: string[];
}

export type JobStatus = "running" | "succeeded" | "failed";

export type JobStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface JobStep {
  id: string;
  label: string;
  status: JobStepStatus;
  detail: string | null;
  progress: { done: number; total: number } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobLogEntry {
  at: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
}

export interface Job<TResult = unknown> {
  id: string;
  kind: "setup" | "graph-build" | "grounding-capture";
  status: JobStatus;
  steps: JobStep[];
  log: JobLogEntry[];
  result: TResult | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ScaffoldFileResult {
  file: string;
  action: "copied" | "skipped" | "would-copy";
}

export interface ToolConfigResult {
  tool: AiTool;
  dest: string;
  action: "copied" | "exists" | "would-copy" | "would-overwrite";
}

export interface BuildResult {
  filesIndexed: number;
  nodesCreated: number;
  edgesCreated: number;
  durationMs: number;
}

export interface SetupResult {
  projectRoot: string;
  mode: SetupMode;
  state: ProjectState;
  scaffold: ScaffoldFileResult[];
  toolConfigs: ToolConfigResult[];
  identity: ScaffoldIdentity | null;
  scanned: boolean;
  graph: BuildResult | null;
  graphError: string | null;
  prompt: string;
}

export interface SetupRequest {
  mode: SetupMode;
  tools: AiTool[];
  buildGraph: boolean;
}

export interface HealthPayload {
  ok: true;
  version: string;
  root: string;
}
