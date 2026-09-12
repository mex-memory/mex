// ── Shared Types ──

// ── AI Tool ──

export type AiTool = "claude" | "cursor" | "windsurf" | "copilot" | "opencode" | "codex";

export interface AiToolMeta {
  name: string;
  cli: string | null;
  /** CLI flag to pass a prompt string directly */
  promptFlag: string[];
}

export const AI_TOOLS: Record<AiTool, AiToolMeta> = {
  claude:   { name: "Claude Code", cli: "claude",   promptFlag: [] },
  cursor:   { name: "Cursor",      cli: null,       promptFlag: [] },
  windsurf: { name: "Windsurf",    cli: null,       promptFlag: [] },
  copilot:  { name: "Copilot",     cli: null,       promptFlag: [] },
  opencode: { name: "OpenCode",    cli: "opencode", promptFlag: ["run"] },
  codex:    { name: "Codex",       cli: "codex",    promptFlag: [] },
};

// ── Config ──

export interface StalenessThresholds {
  /** Days since last change that trigger a warning */
  warnDays: number;
  /** Days since last change that trigger an error */
  errorDays: number;
  /** Commits since last change that trigger a warning */
  warnCommits: number;
  /** Commits since last change that trigger an error */
  errorCommits: number;
}

export interface WatchConfig {
  /** Default interval, in minutes, for `mex watch --interval` */
  intervalMinutes?: number;
}

export interface HeartbeatConfig {
  /**
   * Days since `last_updated` before heartbeat reports stale context. `0`
   * means stale as soon as a file is older than today (#42); negatives and
   * other garbage fall back to the default.
   */
  staleDays?: number;
  /**
   * Days since memory cleanup before heartbeat reports cleanup due. `0`
   * means due every day; negatives fall back to the default.
   */
  memoryCleanupDays?: number;
  /**
   * Daily memory files older than this are considered cleanup candidates.
   * `0` flags yesterday's file; negatives fall back to the default.
   */
  dailyMemoryRetentionDays?: number;
}

/**
 * Wiki engine indexing scope (implementation plan, D10).
 *
 * Both lists are ordered globs matched against scaffold-relative POSIX paths.
 * They are always present on a loaded config, with the D10 defaults, so no
 * consumer has to remember what the default was — that is how a default drifts
 * between the two places that apply it.
 */
/**
 * Scope knobs for §12's synthesis pipeline.
 *
 * **Every field here changes what mex *looks at*. None of them changes what
 * mex *accepts*.** The confidence gates and the relationship thresholds are
 * deliberately absent: a setting that lowers the bar for writing into a user's
 * files has exactly one use, and it would make two checkouts of one repository
 * disagree about what counts as knowledge with no record of why. Those numbers
 * live in `src/wiki/synthesis/` as constants and are asserted by tests.
 */
export interface WikiSynthesisConfig {
  /** Source files a folder needs before it is worth proposing knowledge about. */
  minFiles: number;
  /** Token ceiling for one cluster context. Supporting evidence is dropped first. */
  maxTokens: number;
  /** Lines of surrounding context around a primary symbol's span. */
  primaryContextLines: number;
  /** Upper bound on lines in any file-level code block. */
  maxFileLines: number;
  /** Tighter bound for supporting file-level blocks. */
  supportingMaxLines: number;
  /** Cap on relationship candidate pairs proposed in one pass. */
  maxCandidates: number;
  /** Cap on candidates referencing any one entity, so a hub cannot flood the batch. */
  maxPerUnit: number;
  /** Cap on consolidation groups proposed in one pass. */
  maxGroups: number;
  /** Cap on symbols listed in one cluster context — what may be grounded to. */
  maxNodes: number;
}

export interface WikiConfig {
  /** Paths never indexed. Default: node_modules anywhere under the scaffold. */
  exclude: string[];
  /**
   * Reserved read-only prefixes. Files matching these are parsed, indexed,
   * queried and grounded exactly like any other; what changes is that P5
   * rejects any operation whose patch plan targets one. Loaded and exposed
   * here, enforced there.
   */
  readOnly: string[];
  /** §12 scope knobs. Always present, with defaults, like the two lists above. */
  synthesis: WikiSynthesisConfig;
}

/**
 * Stable identity for a mex scaffold. Persisted in the scaffold's `config.json` and used
 * as the grouping key for anonymous telemetry (one scaffold = one project).
 * `scaffold_id` is a random UUID v4 — never derived from path, repo, or git.
 */
export interface ScaffoldIdentity {
  /** Random UUID v4. Stable for the life of the scaffold. */
  scaffold_id: string;
  /** Human-readable name. Defaults to the project directory basename. */
  scaffold_name: string;
  /** Where this scaffold originated from, if known. Nullable. */
  origin: string | null;
  /** Upstream this scaffold tracks, if any. Nullable. */
  upstream: string | null;
}

export interface MexConfig {
  /** Absolute path to project root (where .git lives) */
  projectRoot: string;
  /** Absolute path to scaffold root (.mex/ directory) */
  scaffoldRoot: string;
  /** Which AI tool(s) the user selected during setup */
  aiTools: AiTool[];
  /** Staleness thresholds (warn/error for days and commits). Optional. */
  stalenessThresholds?: StalenessThresholds;
  /** Scheduled check defaults. Optional. */
  watch?: WatchConfig;
  /** Agent heartbeat defaults. Optional. */
  heartbeat?: HeartbeatConfig;
  /** Scaffold identity, when present in config.json. See {@link getScaffoldIdentity}. */
  identity?: ScaffoldIdentity;
  /** Wiki indexing scope. Always populated with D10's defaults. */
  wiki?: WikiConfig;
}

// ── Claims (extracted from markdown) ──

export type ClaimKind = "path" | "command" | "dependency" | "version";

export interface Claim {
  kind: ClaimKind;
  value: string;
  /** Source file (relative to project root) */
  source: string;
  /** Line number in source file */
  line: number;
  /** Section heading the claim was found under */
  section: string | null;
  /** If true, this claim is negated (e.g. "does NOT use X") */
  negated: boolean;
}

// ── Drift ──

export type Severity = "error" | "warning" | "info";

export type IssueCode =
  | "STALE_FILE"
  | "MISSING_PATH"
  | "DEAD_COMMAND"
  | "DEPENDENCY_MISSING"
  | "VERSION_MISMATCH"
  | "CROSS_FILE_CONFLICT"
  | "DEAD_EDGE"
  | "INDEX_MISSING_ENTRY"
  | "INDEX_ORPHAN_ENTRY"
  | "UNDOCUMENTED_SCRIPT"
  | "TOOL_CONFIG_DRIFT"
  | "TODO_FIXME"
  | "BROKEN_LINK"
  | "MISSING_FRONTMATTER_FIELD"
  | "STALE_PATTERN"
  // Populated scaffold that no always-loaded tool config points at, so no
  // agent ever reads it. See src/drift/checkers/anchor-link.ts and #106.
  | "SCAFFOLD_ORPHANED"
  // ── Code-graph grounding (checker #12; emitted by src/drift/checkers/grounding.ts) ──
  // Added in Phase 0 so the grounding-checker contract typechecks and Track B
  // never has to reopen this shared union. See src/graph/grounding.ts.
  | "GROUNDING_GONE" //      grounded node deleted / unrecoverable (error)
  | "GROUNDING_DRIFT" //     grounded node still exists but its body changed (warning)
  | "GROUNDING_AMBIGUOUS"; // reconciler found an uncertain move candidate (warning)

export interface DriftIssue {
  code: IssueCode;
  severity: Severity;
  file: string;
  line: number | null;
  message: string;
  /** The claim that triggered this issue, if any */
  claim?: Claim;
}

export interface DriftReport {
  score: number;
  issues: DriftIssue[];
  filesChecked: number;
  timestamp: string;
  verboseLog?: string[];
}

// ── Frontmatter ──

/**
 * A code-graph grounding: a scaffold prose block asserting against a specific
 * code node (not just a file path). Net-new in 0.7.0 (spec §5), AGENT-AUTHORED
 * ONLY — written by the agent during setup + sync, never hand-written. The
 * grounding checker (#12) resolves each entry against the graph and reports
 * drift when the node changes, moves, or vanishes.
 *
 * ```yaml
 * grounds_to:
 *   - node: "function:a3f8...c21"
 *     fingerprint: "mh:64:9f2a..."
 *     bodyHash: "sha256:7c1d..."
 * ```
 */
export interface Grounding {
  /** The grounded node's Tier-1 id, `${kind}:sha256(filePath:kind:name)[:32]`. */
  node: string;
  /**
   * Serialized Tier-2 fingerprint (`mh:<K>:<hex>`) captured when grounded.
   *
   * An **identity** signal, not a change signal: it is what finds the symbol
   * again after it moves. It is deliberately insensitive to an edited constant
   * or a renamed local, so it must never be asked "did this change?".
   */
  fingerprint: string;
  /**
   * The grounded node's body hash when the baseline was captured.
   *
   * **The change signal, and canonical because it is committed in Markdown.**
   * The same value is cached in `_mex_grounded_source` inside `.mex/graph.db`,
   * but that index is gitignored and disposable by invariant — a rebuild
   * re-captures it from the current code, so comparing against the cache
   * compares current against current and drift disappears. Only the copy in
   * Git survives a rebuild and reaches a teammate who clones.
   *
   * Optional, and it has to be: every grounding written before this field
   * existed lacks it, and requiring it would turn each of those scaffolds into
   * a parse error. A grounding without it still resolves, through the coarser
   * structural comparator, and `mex sync` backfills it on the next capture.
   */
  bodyHash?: string;
}

export interface ScaffoldFrontmatter {
  name?: string;
  description?: string;
  edges?: FrontmatterEdge[];
  last_updated?: string;
  /**
   * Code nodes this scaffold grounds to (spec §5). Net-new, backward-compatible:
   * files without it skip the grounding checker entirely. Agent-authored only.
   */
  grounds_to?: Grounding[];
  [key: string]: unknown;
}

export interface FrontmatterEdge {
  target: string;
  condition?: string;
}

// ── Scanner ──

export interface ManifestInfo {
  type: "package.json" | "pyproject.toml" | "go.mod" | "Cargo.toml";
  name: string | null;
  version: string | null;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}

export interface EntryPoint {
  path: string;
  type: "main" | "binary" | "test" | "config";
}

export interface FolderCategory {
  name: string;
  path: string;
  fileCount: number;
  category: "routes" | "models" | "services" | "tests" | "config" | "utils" | "views" | "other";
}

export interface ToolingInfo {
  testRunner: string | null;
  buildTool: string | null;
  linter: string | null;
  formatter: string | null;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | null;
}

export interface ScannerBrief {
  manifest: ManifestInfo | null;
  entryPoints: EntryPoint[];
  folderTree: FolderCategory[];
  tooling: ToolingInfo;
  readme: string | null;
  timestamp: string;
}

// ── Sync ──

export interface SyncTarget {
  file: string;
  issues: DriftIssue[];
  gitDiff: string | null;
}

export interface SyncResult {
  file: string;
  action: "updated" | "skipped" | "failed";
  reason?: string;
}
