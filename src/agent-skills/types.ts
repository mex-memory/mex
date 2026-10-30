export const SUPPORTED_AGENT_SKILL_CLIENTS = ["claude", "codex"] as const;

export type AgentSkillClient = (typeof SUPPORTED_AGENT_SKILL_CLIENTS)[number];

export const OFFICIAL_MEX_SKILLS = ["mex-inbox", "mex-relay", "mex-statechart"] as const;

export type OfficialMexSkill = (typeof OFFICIAL_MEX_SKILLS)[number];

export interface AgentSkillTarget {
  readonly displayName: string;
  readonly skillsDirectory: string;
  readonly instructionsPath: string;
  readonly invocationPrefix: "/" | "$";
}

/** Fixed destinations: callers cannot redirect a managed install through user input. */
export const AGENT_SKILL_TARGETS: Readonly<Record<AgentSkillClient, AgentSkillTarget>> = {
  claude: {
    displayName: "Claude Code",
    skillsDirectory: ".claude/skills",
    instructionsPath: "CLAUDE.md",
    invocationPrefix: "/",
  },
  codex: {
    displayName: "Codex",
    skillsDirectory: ".agents/skills",
    instructionsPath: "AGENTS.md",
    invocationPrefix: "$",
  },
};

export type AgentAssetActionName =
  | "install"
  | "update"
  | "create"
  | "migrate"
  | "noop"
  | "conflict";

export type AgentInstructionChangeScope =
  | "create"
  | "append"
  | "replace"
  | "known-legacy-migration";

/** Bounded exact managed-block preview; never contains arbitrary user-file bytes. */
export interface AgentInstructionChange {
  readonly scope: AgentInstructionChangeScope;
  /** Exact previous marker-delimited block, or null when no managed block exists. */
  readonly before: string | null;
  /** Exact marker-delimited block that will be installed. */
  readonly after: string;
}

export interface AgentAssetAction {
  readonly kind: "skill" | "instructions";
  readonly action: AgentAssetActionName;
  readonly client: AgentSkillClient;
  readonly skill?: OfficialMexSkill;
  /** Project-relative, forward-slash path suitable for human and JSON output. */
  readonly path: string;
  readonly message: string;
  readonly instructionChange?: AgentInstructionChange;
}

export type AgentAssetWarningCode =
  | "ignored-skill-path"
  | "ignore-check-failed"
  | "managed-skill-modified"
  | "unmanaged-skill-conflict"
  | "malformed-ownership"
  | "unsafe-path"
  | "malformed-instruction-markers"
  | "invalid-instruction-encoding";

export interface AgentAssetWarning {
  readonly code: AgentAssetWarningCode;
  readonly client: AgentSkillClient;
  readonly skill?: OfficialMexSkill;
  /** Project-relative, forward-slash path suitable for human and JSON output. */
  readonly path: string;
  readonly message: string;
  readonly resolution?: string;
}

export interface AgentAssetsReport {
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  readonly clients: readonly AgentSkillClient[];
  readonly dryRun: boolean;
  /** True only after all non-conflicting planned writes completed. */
  readonly applied: boolean;
  /** True when this plan contains at least one write, whether or not it was a dry run. */
  readonly changed: boolean;
  readonly conflicted: boolean;
  readonly actions: readonly AgentAssetAction[];
  readonly warnings: readonly AgentAssetWarning[];
}

/**
 * A JSON-safe report plus private in-process apply state. A plan cannot be
 * serialized and replayed: apply always consumes the exact in-memory preview.
 */
export interface AgentAssetsPlan extends AgentAssetsReport {}

export interface AgentAssetsSyncOptions {
  /** Existing repository root. It is canonicalized before any path is resolved. */
  readonly projectRoot: string;
  /** Version written into each `.mex-managed.json` ownership record. */
  readonly packageVersion: string;
  /** Only selected supported clients are installed; duplicates are ignored. */
  readonly clients: readonly AgentSkillClient[];
  /** Defaults to the package's published `skills/` directory. */
  readonly packagedSkillsRoot?: string;
  readonly dryRun?: boolean;
  /** Set false to skip the read-only `git check-ignore` probe. Defaults to true. */
  readonly checkIgnored?: boolean;
  /** Injectable read-only probe, primarily for embedders and deterministic tests. */
  readonly ignoreChecker?: AgentSkillIgnoreChecker;
  /** Additional exact legacy-file SHA-256 values that may be replaced wholesale. */
  readonly legacyInstructionHashes?: Partial<
    Readonly<Record<AgentSkillClient, readonly string[]>>
  >;
}

export type AgentSkillIgnoreChecker = (
  projectRoot: string,
  projectRelativePath: string,
) => boolean;

export interface AgentAssetsApplyHooks {
  /** Fault-injection seam used to prove rollback after the old tree is backed up. */
  readonly beforeSkillActivation?: (path: string) => void;
  /** Fault-injection seam used to prove instruction temp files never replace early. */
  readonly beforeInstructionActivation?: (path: string) => void;
  /** Fault-injection seam for detecting changes after a replacement is active. */
  readonly afterSkillActivation?: (path: string, backupPath: string | null) => void;
  /** Fault-injection seam for detecting changes after a replacement is active. */
  readonly afterInstructionActivation?: (path: string, backupPath: string | null) => void;
}

export interface AgentAssetsApplyOptions {
  readonly hooks?: AgentAssetsApplyHooks;
}
