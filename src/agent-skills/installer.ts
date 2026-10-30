import { spawnSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type BigIntStats,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  planManagedInstructionEdit,
} from "./instructions.js";
import {
  AGENT_SKILL_TARGETS,
  OFFICIAL_MEX_SKILLS,
  SUPPORTED_AGENT_SKILL_CLIENTS,
  type AgentAssetAction,
  type AgentAssetWarning,
  type AgentAssetsApplyOptions,
  type AgentAssetsPlan,
  type AgentAssetsReport,
  type AgentAssetsSyncOptions,
  type AgentSkillClient,
  type AgentSkillIgnoreChecker,
  type OfficialMexSkill,
} from "./types.js";

export const MEX_MANAGED_SKILL_METADATA = ".mex-managed.json";
export const MEX_MANAGED_SKILL_SCHEMA_VERSION = 1 as const;

export interface MexManagedSkillMetadata {
  readonly schemaVersion: typeof MEX_MANAGED_SKILL_SCHEMA_VERSION;
  readonly owner: "mex-agent";
  readonly skill: OfficialMexSkill;
  readonly packageVersion: string;
  /** SHA-256 by project-portable, forward-slash path. */
  readonly files: Readonly<Record<string, string>>;
}

export type AgentAssetsErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_PACKAGED_SKILL"
  | "UNKNOWN_PLAN"
  | "DRY_RUN_PLAN"
  | "IGNORE_CHECK_FAILED"
  | "CONCURRENT_MODIFICATION"
  | "PATH_IDENTITY_CHANGED"
  | "REPLACEMENT_ACTIVE_BACKUP_RETAINED"
  | "APPLY_FAILED";

export class AgentAssetsError extends Error {
  readonly code: AgentAssetsErrorCode;

  constructor(code: AgentAssetsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentAssetsError";
    this.code = code;
  }
}

interface DesiredFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mode: number;
}

interface DesiredSkill {
  readonly skill: OfficialMexSkill;
  readonly files: readonly DesiredFile[];
  readonly metadata: MexManagedSkillMetadata;
  readonly metadataBytes: Uint8Array;
}

interface SkillWriteOperation {
  readonly kind: "skill";
  readonly action: "install" | "update";
  readonly client: AgentSkillClient;
  readonly skill: OfficialMexSkill;
  readonly relativePath: string;
  readonly expected: { readonly kind: "missing" } | {
    readonly kind: "tree";
    readonly fingerprint: string;
  };
  readonly desired: DesiredSkill;
}

interface InstructionWriteOperation {
  readonly kind: "instructions";
  readonly action: "create" | "migrate" | "update";
  readonly client: AgentSkillClient;
  readonly relativePath: string;
  readonly expected: { readonly kind: "missing" } | {
    readonly kind: "file";
    readonly sha256: string;
    readonly mode: number;
  };
  readonly desiredBytes: Uint8Array;
}

type WriteOperation = SkillWriteOperation | InstructionWriteOperation;

interface PlanState {
  readonly canonicalProjectRoot: string;
  readonly rootIdentity: PathIdentity;
  readonly operations: readonly WriteOperation[];
}

interface PathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly kind: "directory" | "file";
}

interface ActivationPathGuard {
  readonly rootPath: string;
  readonly rootIdentity: PathIdentity;
  readonly parentPath: string;
  readonly parentIdentity: PathIdentity;
  readonly stagePath: string;
  readonly stageIdentity: PathIdentity;
}

const planStates = new WeakMap<AgentAssetsPlan, PlanState>();
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_PACKAGED_SKILL_FILES = 256;
const MAX_MANAGED_METADATA_BYTES = 1024 * 1024;

/**
 * Resolve `skills/` both from unbundled source (`src/agent-skills/`) and the
 * published bundle (`dist/`). Tests and embedders should inject a root instead.
 */
export function resolvePackagedSkillsRoot(moduleUrl = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDirectory, "../skills"),
    resolve(moduleDirectory, "../../skills"),
  ];
  for (const candidate of candidates) {
    try {
      const candidateStat = lstatSync(candidate);
      if (!candidateStat.isSymbolicLink() && candidateStat.isDirectory()) return candidate;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  throw new AgentAssetsError(
    "INVALID_PACKAGED_SKILL",
    `Could not locate the packaged skills directory from ${moduleDirectory}.`,
  );
}

/** Build the exact JSON-safe action/warning preview. Performs no writes. */
export function planAgentAssets(options: AgentAssetsSyncOptions): AgentAssetsPlan {
  const canonicalProjectRoot = canonicalizeProjectRoot(options.projectRoot);
  const rootIdentity = capturePathIdentity(canonicalProjectRoot, "directory", "project root");
  const clients = normalizeClients(options.clients);
  const packageVersion = normalizePackageVersion(options.packageVersion);
  const packagedSkillsRoot = options.packagedSkillsRoot ?? resolvePackagedSkillsRoot();
  const desiredSkills = new Map<OfficialMexSkill, DesiredSkill>();
  for (const skill of OFFICIAL_MEX_SKILLS) {
    desiredSkills.set(skill, readPackagedSkill(packagedSkillsRoot, skill, packageVersion));
  }

  const actions: AgentAssetAction[] = [];
  const warnings: AgentAssetWarning[] = [];
  const operations: WriteOperation[] = [];
  const ignoreChecker = options.ignoreChecker ?? gitCheckIgnored;

  for (const client of clients) {
    const target = AGENT_SKILL_TARGETS[client];
    for (const skill of OFFICIAL_MEX_SKILLS) {
      const relativePath = `${target.skillsDirectory}/${skill}`;
      const desired = desiredSkills.get(skill)!;
      const skillPlan = planSkill(canonicalProjectRoot, client, skill, relativePath, desired);
      actions.push(skillPlan.action);
      if (skillPlan.warning) warnings.push(skillPlan.warning);
      if (skillPlan.operation) operations.push(skillPlan.operation);

      let ignoredPath: string | null = null;
      try {
        ignoredPath = options.checkIgnored === false
          ? null
          : firstIgnoredSkillPath(canonicalProjectRoot, relativePath, desired, ignoreChecker);
      } catch (error) {
        warnings.push({
          code: "ignore-check-failed",
          client,
          skill,
          path: relativePath,
          message: `MEX could not verify whether ${relativePath} is ignored by Git: ${boundedErrorMessage(error)}`,
          resolution: `Run git check-ignore --no-index -- ${relativePath}/SKILL.md from the repository root, repair the Git configuration or installation, and rerun MEX. No ignore rule was changed automatically.`,
        });
      }
      if (ignoredPath) {
        warnings.push({
          code: "ignored-skill-path",
          client,
          skill,
          path: ignoredPath,
          message: `${ignoredPath} is ignored by Git, so teammates will not receive the complete installed ${skill} skill by default.`,
          resolution: renderNarrowIgnoreResolution(target.skillsDirectory),
        });
      }
    }

    const instructionPlan = planInstructions(
      canonicalProjectRoot,
      client,
      target.instructionsPath,
      options.legacyInstructionHashes?.[client] ?? [],
    );
    actions.push(instructionPlan.action);
    if (instructionPlan.warning) warnings.push(instructionPlan.warning);
    if (instructionPlan.operation) operations.push(instructionPlan.operation);
  }

  const plan: AgentAssetsPlan = {
    schemaVersion: 1,
    packageVersion,
    clients,
    dryRun: options.dryRun === true,
    applied: false,
    changed: actions.some((action) => isWriteAction(action.action)),
    conflicted: actions.some((action) => action.action === "conflict"),
    actions,
    warnings,
  };
  planStates.set(plan, { canonicalProjectRoot, rootIdentity, operations });
  return plan;
}

/** Apply the exact in-memory preview, revalidating every target before replacement. */
export function applyAgentAssetsPlan(
  plan: AgentAssetsPlan,
  options: AgentAssetsApplyOptions = {},
): AgentAssetsReport {
  const state = planStates.get(plan);
  if (!state) {
    throw new AgentAssetsError(
      "UNKNOWN_PLAN",
      "This agent-assets plan was not created in the current process and cannot be replayed.",
    );
  }
  if (plan.dryRun) {
    throw new AgentAssetsError("DRY_RUN_PLAN", "A dry-run agent-assets plan cannot be applied.");
  }

  for (const operation of state.operations) {
    assertPathIdentity(
      state.canonicalProjectRoot,
      state.rootIdentity,
      "project root",
    );
    if (operation.kind === "skill") {
      applySkillOperation(
        state.canonicalProjectRoot,
        state.rootIdentity,
        operation,
        options,
      );
    } else {
      applyInstructionOperation(
        state.canonicalProjectRoot,
        state.rootIdentity,
        operation,
        options,
      );
    }
  }
  planStates.delete(plan);

  return {
    ...plan,
    applied: true,
  };
}

/** Plan and, unless `dryRun`, apply official skills and managed instructions. */
export function syncAgentAssets(options: AgentAssetsSyncOptions): AgentAssetsReport {
  const plan = planAgentAssets(options);
  return plan.dryRun ? plan : applyAgentAssetsPlan(plan);
}

export const defaultAgentSkillIgnoreChecker = gitCheckIgnored;

function normalizeClients(clients: readonly AgentSkillClient[]): AgentSkillClient[] {
  const supplied = new Set<string>(clients);
  for (const client of supplied) {
    if (!(SUPPORTED_AGENT_SKILL_CLIENTS as readonly string[]).includes(client)) {
      throw new AgentAssetsError("INVALID_OPTIONS", `Unsupported agent skill client: ${client}`);
    }
  }
  return SUPPORTED_AGENT_SKILL_CLIENTS.filter((client) => supplied.has(client));
}

function normalizePackageVersion(version: string): string {
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    version.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(version)
  ) {
    throw new AgentAssetsError("INVALID_OPTIONS", "packageVersion must be a non-empty printable string.");
  }
  return version;
}

function canonicalizeProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new AgentAssetsError("INVALID_OPTIONS", "projectRoot is required.");
  }
  let canonical: string;
  try {
    canonical = realpathSync(projectRoot);
  } catch (error) {
    throw new AgentAssetsError("INVALID_OPTIONS", `Project root does not exist: ${projectRoot}`, {
      cause: error,
    });
  }
  if (!statSync(canonical).isDirectory()) {
    throw new AgentAssetsError("INVALID_OPTIONS", `Project root is not a directory: ${projectRoot}`);
  }
  return canonical;
}

function readPackagedSkill(
  packagedSkillsRoot: string,
  skill: OfficialMexSkill,
  packageVersion: string,
): DesiredSkill {
  const rootStat = safeLstat(packagedSkillsRoot);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw invalidPackagedSkill(skill, `Packaged skills root is missing, linked, or not a directory: ${packagedSkillsRoot}`);
  }
  const skillRoot = resolve(packagedSkillsRoot, skill);
  const skillStat = safeLstat(skillRoot);
  if (!skillStat || skillStat.isSymbolicLink() || !skillStat.isDirectory()) {
    throw invalidPackagedSkill(skill, `Packaged skill directory is missing, linked, or not a directory: ${skillRoot}`);
  }

  const files: DesiredFile[] = [];
  readPackagedDirectory(skillRoot, "", skill, files);
  files.sort((left, right) => comparePortableText(left.relativePath, right.relativePath));
  if (files.length > MAX_PACKAGED_SKILL_FILES) {
    throw invalidPackagedSkill(
      skill,
      `Packaged skill has ${files.length} files; the supported maximum is ${MAX_PACKAGED_SKILL_FILES}.`,
    );
  }
  if (!files.some((file) => file.relativePath === "SKILL.md")) {
    throw invalidPackagedSkill(skill, `${skill}/SKILL.md is missing.`);
  }
  if (files.some((file) => file.relativePath === MEX_MANAGED_SKILL_METADATA)) {
    throw invalidPackagedSkill(skill, `${skill}/${MEX_MANAGED_SKILL_METADATA} is reserved for installed ownership metadata.`);
  }

  const hashes = Object.fromEntries(files.map((file) => [file.relativePath, file.sha256]));
  const metadata: MexManagedSkillMetadata = {
    schemaVersion: MEX_MANAGED_SKILL_SCHEMA_VERSION,
    owner: "mex-agent",
    skill,
    packageVersion,
    files: hashes,
  };
  const metadataBytes = serializeMetadata(metadata);
  return { skill, files, metadata, metadataBytes };
}

function readPackagedDirectory(
  skillRoot: string,
  relativeDirectory: string,
  skill: OfficialMexSkill,
  files: DesiredFile[],
): void {
  const absoluteDirectory = relativeDirectory
    ? absoluteFromPortable(skillRoot, relativeDirectory)
    : skillRoot;
  const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
    .sort((left, right) => comparePortableText(left.name, right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (!isSafePortableRelativePath(relativePath)) {
      throw invalidPackagedSkill(skill, `Unsafe packaged path: ${relativePath}`);
    }
    const absolutePath = absoluteFromPortable(skillRoot, relativePath);
    const entryStat = lstatSync(absolutePath);
    if (entryStat.isSymbolicLink()) {
      throw invalidPackagedSkill(skill, `Packaged skills cannot contain symlinks: ${relativePath}`);
    }
    if (entryStat.isDirectory()) {
      readPackagedDirectory(skillRoot, relativePath, skill, files);
      continue;
    }
    if (!entryStat.isFile()) {
      throw invalidPackagedSkill(skill, `Packaged skills may contain only regular files: ${relativePath}`);
    }
    const bytes = readRegularFileNoFollow(absolutePath);
    files.push({
      relativePath,
      bytes,
      sha256: sha256(bytes),
      mode: entryStat.mode & 0o777,
    });
  }
}

function planSkill(
  projectRoot: string,
  client: AgentSkillClient,
  skill: OfficialMexSkill,
  relativePath: string,
  desired: DesiredSkill,
): {
  action: AgentAssetAction;
  warning?: AgentAssetWarning;
  operation?: SkillWriteOperation;
} {
  const pathSafety = inspectFixedTarget(projectRoot, relativePath);
  if (!pathSafety.safe) {
    return skillConflict(
      client,
      skill,
      relativePath,
      "unsafe-path",
      pathSafety.message,
      `Remove the symlink or non-directory path component yourself, then run mex skills sync again.`,
    );
  }

  if (!pathSafety.exists) {
    return {
      action: {
        kind: "skill",
        action: "install",
        client,
        skill,
        path: relativePath,
        message: `Install the packaged ${skill} skill at ${relativePath}.`,
      },
      operation: {
        kind: "skill",
        action: "install",
        client,
        skill,
        relativePath,
        expected: { kind: "missing" },
        desired,
      },
    };
  }

  const targetPath = absoluteFromPortable(projectRoot, relativePath);
  const targetStat = lstatSync(targetPath);
  if (!targetStat.isDirectory()) {
    return skillConflict(
      client,
      skill,
      relativePath,
      "unmanaged-skill-conflict",
      `${relativePath} already exists and is not a MEX-managed skill directory.`,
      `Move or rename ${relativePath}, or keep it and skip the official ${skill} skill. MEX will never overwrite it.`,
    );
  }

  const metadataPath = resolve(targetPath, MEX_MANAGED_SKILL_METADATA);
  const metadataStat = safeLstat(metadataPath);
  if (!metadataStat) {
    return skillConflict(
      client,
      skill,
      relativePath,
      "unmanaged-skill-conflict",
      `${relativePath} already exists without ${MEX_MANAGED_SKILL_METADATA}.`,
      `Move or rename ${relativePath}, or keep it and skip the official ${skill} skill. MEX will never overwrite it.`,
    );
  }
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
    return skillConflict(
      client,
      skill,
      relativePath,
      "unsafe-path",
      `${relativePath}/${MEX_MANAGED_SKILL_METADATA} is linked or is not a regular file.`,
      `Replace the unsafe metadata path yourself, then run mex skills sync again.`,
    );
  }

  if (metadataStat.size > MAX_MANAGED_METADATA_BYTES) {
    return skillConflict(
      client,
      skill,
      relativePath,
      "malformed-ownership",
      `${relativePath}/${MEX_MANAGED_SKILL_METADATA} is too large to be valid ownership metadata.`,
      `Restore the ownership file from the installed package or move ${relativePath} aside; MEX will not guess ownership.`,
    );
  }

  const metadataBytes = readRegularFileNoFollow(metadataPath);
  const metadataLineFeeds = withLineFeeds(metadataBytes);
  const metadata = parseMetadata(metadataBytes, skill);
  if (!metadata) {
    return skillConflict(
      client,
      skill,
      relativePath,
      "malformed-ownership",
      `${relativePath}/${MEX_MANAGED_SKILL_METADATA} is malformed or does not identify this MEX skill.`,
      `Restore the ownership file from the installed package or move ${relativePath} aside; MEX will not guess ownership.`,
    );
  }
  if (!bytesEqual(metadataLineFeeds, serializeMetadata(metadata))) {
    return skillConflict(
      client,
      skill,
      relativePath,
      "managed-skill-modified",
      `${relativePath}/${MEX_MANAGED_SKILL_METADATA} differs from MEX's recorded ownership format.`,
      `Preserve or move the edited metadata, then restore the managed copy before syncing. MEX will not overwrite it.`,
    );
  }

  let snapshot: DirectorySnapshot;
  try {
    snapshot = snapshotDirectory(targetPath);
  } catch (error) {
    if (error instanceof UnsafeTreeError) {
      return skillConflict(
        client,
        skill,
        relativePath,
        "unsafe-path",
        `${relativePath} contains a symlink or non-regular filesystem entry at ${error.relativePath}.`,
        `Remove the unsafe entry yourself, then run mex skills sync again.`,
      );
    }
    throw error;
  }

  if (!matchesRecordedFiles(snapshot, metadata.files)) {
    return skillConflict(
      client,
      skill,
      relativePath,
      "managed-skill-modified",
      `${relativePath} has changes relative to its recorded MEX-managed hashes.`,
      `Preserve or move your changes, then restore the managed copy before syncing. MEX will not overwrite modified files.`,
    );
  }

  // Older Windows installs recorded CRLF hashes. If the verified copy still
  // matches this package's content and version, keep its bytes and ownership
  // record rather than rewriting it only to canonicalize those hashes.
  if (metadata.packageVersion === desired.metadata.packageVersion &&
    matchesRecordedFiles(snapshot, desired.metadata.files)) {
    return {
      action: {
        kind: "skill",
        action: "noop",
        client,
        skill,
        path: relativePath,
        message: `${relativePath} already matches packaged ${skill} (allowing checkout line endings).`,
      },
    };
  }

  return {
    action: {
      kind: "skill",
      action: "update",
      client,
      skill,
      path: relativePath,
      message: `Update the unmodified MEX-managed ${skill} skill at ${relativePath}.`,
    },
    operation: {
      kind: "skill",
      action: "update",
      client,
      skill,
      relativePath,
      expected: { kind: "tree", fingerprint: snapshot.fingerprint },
      desired,
    },
  };
}

function planInstructions(
  projectRoot: string,
  client: AgentSkillClient,
  relativePath: string,
  additionalLegacyHashes: readonly string[],
): {
  action: AgentAssetAction;
  warning?: AgentAssetWarning;
  operation?: InstructionWriteOperation;
} {
  const pathSafety = inspectFixedTarget(projectRoot, relativePath);
  if (!pathSafety.safe) {
    return instructionConflict(
      client,
      relativePath,
      "unsafe-path",
      pathSafety.message,
      `Replace the unsafe instruction path yourself, then run mex skills sync again.`,
    );
  }

  let currentBytes: Uint8Array | null = null;
  let currentMode = 0o644;
  if (pathSafety.exists) {
    const absolutePath = absoluteFromPortable(projectRoot, relativePath);
    const currentStat = lstatSync(absolutePath);
    if (!currentStat.isFile()) {
      return instructionConflict(
        client,
        relativePath,
        "unsafe-path",
        `${relativePath} exists but is not a regular file.`,
        `Move the non-file path yourself, then run mex skills sync again.`,
      );
    }
    currentBytes = readRegularFileNoFollow(absolutePath);
    currentMode = currentStat.mode & 0o777;
  }

  const edit = planManagedInstructionEdit(client, currentBytes, additionalLegacyHashes);
  if (edit.action === "conflict") {
    if (edit.reason === "invalid-encoding") {
      return instructionConflict(
        client,
        relativePath,
        "invalid-instruction-encoding",
        `${relativePath} is not valid UTF-8, so its bytes were preserved.`,
        `Convert ${relativePath} to UTF-8 yourself, then run mex skills sync again.`,
      );
    }
    if (edit.reason === "managed-block-too-large") {
      return instructionConflict(
        client,
        relativePath,
        "malformed-instruction-markers",
        `${relativePath} has a MEX managed block that exceeds the bounded preview limit.`,
        `Shorten or repair the managed block yourself, then run mex skills sync again.`,
      );
    }
    return instructionConflict(
      client,
      relativePath,
      "malformed-instruction-markers",
      `${relativePath} has duplicate, nested, partial, or non-standalone MEX managed-block markers.`,
      `Repair the <!-- mex-agent:skills:start --> / <!-- mex-agent:skills:end --> managed-block markers yourself, then run mex skills sync again.`,
    );
  }

  if (edit.action === "noop") {
    return {
      action: {
        kind: "instructions",
        action: "noop",
        client,
        path: relativePath,
        message: `${relativePath} already contains the exact MEX-managed instruction block.`,
      },
    };
  }

  const verbs = {
    create: `Create ${relativePath} with the minimal MEX-managed instruction block.`,
    migrate: `Migrate the exact legacy MEX-generated ${relativePath} to the minimal managed block.`,
    update: edit.reason === "append"
      ? `Append the MEX-managed instruction block to ${relativePath} without changing its existing bytes.`
      : `Replace only the existing MEX-managed block in ${relativePath}.`,
  } as const;
  return {
    action: {
      kind: "instructions",
      action: edit.action,
      client,
      path: relativePath,
      message: verbs[edit.action],
      instructionChange: edit.instructionChange!,
    },
    operation: {
      kind: "instructions",
      action: edit.action,
      client,
      relativePath,
      expected: currentBytes === null
        ? { kind: "missing" }
        : { kind: "file", sha256: sha256(currentBytes), mode: currentMode },
      desiredBytes: edit.desiredBytes!,
    },
  };
}

function skillConflict(
  client: AgentSkillClient,
  skill: OfficialMexSkill,
  path: string,
  code: AgentAssetWarning["code"],
  message: string,
  resolution: string,
): { action: AgentAssetAction; warning: AgentAssetWarning } {
  return {
    action: { kind: "skill", action: "conflict", client, skill, path, message },
    warning: { code, client, skill, path, message, resolution },
  };
}

function instructionConflict(
  client: AgentSkillClient,
  path: string,
  code: AgentAssetWarning["code"],
  message: string,
  resolution: string,
): { action: AgentAssetAction; warning: AgentAssetWarning } {
  return {
    action: { kind: "instructions", action: "conflict", client, path, message },
    warning: { code, client, path, message, resolution },
  };
}

function applySkillOperation(
  projectRoot: string,
  rootIdentity: PathIdentity,
  operation: SkillWriteOperation,
  options: AgentAssetsApplyOptions,
): void {
  assertPathIdentity(projectRoot, rootIdentity, "project root");
  const targetPath = absoluteFromPortable(projectRoot, operation.relativePath);
  const parentPath = ensureSafeDirectoryChain(projectRoot, dirnamePortable(operation.relativePath));
  assertPathIdentity(projectRoot, rootIdentity, "project root");
  const parentIdentity = capturePathIdentity(parentPath, "directory", "skill parent");
  const stagePath = uniqueSiblingPath(parentPath, basename(targetPath), "stage");
  const backupPath = uniqueSiblingPath(parentPath, basename(targetPath), "backup");
  assertPathIdentity(projectRoot, rootIdentity, "project root");
  assertPathIdentity(parentPath, parentIdentity, "skill parent");
  mkdirSync(stagePath, { mode: 0o700 });
  const stageIdentity = capturePathIdentity(stagePath, "directory", "staged skill");
  const guard: ActivationPathGuard = {
    rootPath: projectRoot,
    rootIdentity,
    parentPath,
    parentIdentity,
    stagePath,
    stageIdentity,
  };
  let backedUp = false;
  let activated = false;
  let backupIdentity: PathIdentity | null = null;

  try {
    assertActivationGuard(guard);
    writeDesiredSkill(stagePath, operation.desired, guard);
    assertActivationGuard(guard);
    assertExpectedSkill(projectRoot, operation);

    if (operation.action === "update") {
      assertActivationGuard(guard);
      renameSync(targetPath, backupPath);
      backedUp = true;
      backupIdentity = capturePathIdentity(backupPath, "directory", "skill backup");
      assertExpectedSkillBackup(operation, backupPath, backupIdentity);
    }

    try {
      options.hooks?.beforeSkillActivation?.(operation.relativePath);
      assertActivationGuard(guard);
      if (operation.action === "update") {
        assertExpectedSkillBackup(operation, backupPath, backupIdentity!);
        assertActivationTargetAbsent(projectRoot, operation.relativePath);
      } else {
        // Close the hook-sized race before the atomic rename. The remaining
        // syscall-sized window cannot be removed portably for directories.
        assertExpectedSkill(projectRoot, operation);
      }
      assertActivationGuard(guard);
      renameSync(stagePath, targetPath);
      activated = true;
      assertPathIdentity(targetPath, stageIdentity, "activated skill");
      assertBaseGuard(guard);
    } catch (error) {
      if (backedUp) {
        try {
          assertBaseGuard(guard);
          assertPathIdentity(backupPath, backupIdentity!, "skill backup");
          if (safeLstat(targetPath)) {
            throw new Error(`A new destination prevented rollback; the original remains at ${backupPath}.`);
          }
          renameSync(backupPath, targetPath);
          backedUp = false;
        } catch (rollbackError) {
          throw new AgentAssetsError(
            "APPLY_FAILED",
            `Failed to activate ${operation.relativePath} and failed to restore its backup at ${backupPath}.`,
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
      }
      throw error;
    }

    options.hooks?.afterSkillActivation?.(
      operation.relativePath,
      backedUp ? backupPath : null,
    );
    assertBaseGuard(guard);
    assertPathIdentity(targetPath, stageIdentity, "activated skill");
    if (backedUp) {
      // Never delete a backup that changed while activation was in flight.
      assertExpectedSkillBackupAfterActivation(operation, backupPath, backupIdentity!);
      rmSync(backupPath, { recursive: true, force: false });
      backedUp = false;
    }
    fsyncDirectory(parentPath);
  } catch (error) {
    if (error instanceof AgentAssetsError) throw error;
    throw new AgentAssetsError(
      "APPLY_FAILED",
      `Could not ${operation.action} ${operation.relativePath}.`,
      { cause: error },
    );
  } finally {
    if (!activated) safeCleanupStageDirectory(guard);
    if (
      backedUp
      && backupIdentity !== null
      && baseGuardMatches(guard)
      && pathIdentityMatches(backupPath, backupIdentity)
      && !safeLstat(targetPath)
    ) {
      try {
        renameSync(backupPath, targetPath);
        backedUp = false;
      } catch {
        // The primary error already reports failed recovery when this matters.
      }
    }
  }
}

function assertExpectedSkillBackup(
  operation: SkillWriteOperation,
  backupPath: string,
  backupIdentity: PathIdentity,
): void {
  if (operation.expected.kind !== "tree") {
    throw new AgentAssetsError("APPLY_FAILED", `Unexpected backup for ${operation.relativePath}.`);
  }
  assertPathIdentity(backupPath, backupIdentity, "skill backup");
  let snapshot: DirectorySnapshot;
  try {
    snapshot = snapshotDirectory(backupPath);
  } catch (error) {
    throw concurrentModification(
      operation.relativePath,
      `Its retained backup at ${backupPath} became unsafe.`,
      error,
    );
  }
  if (snapshot.fingerprint !== operation.expected.fingerprint) {
    throw concurrentModification(
      operation.relativePath,
      `Its retained backup at ${backupPath} changed during activation.`,
    );
  }
}

function assertExpectedSkillBackupAfterActivation(
  operation: SkillWriteOperation,
  backupPath: string,
  backupIdentity: PathIdentity,
): void {
  try {
    assertExpectedSkillBackup(operation, backupPath, backupIdentity);
  } catch (error) {
    throw activeReplacementBackupRetained(operation.relativePath, backupPath, error);
  }
}

function writeDesiredSkill(
  stagePath: string,
  desired: DesiredSkill,
  guard: ActivationPathGuard,
): void {
  for (const file of desired.files) {
    assertActivationGuard(guard);
    const destination = absoluteFromPortable(stagePath, file.relativePath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    assertActivationGuard(guard);
    assertSafeStageAncestors(stagePath, file.relativePath);
    writeExclusiveFile(destination, file.bytes, file.mode);
    assertActivationGuard(guard);
  }
  assertActivationGuard(guard);
  writeExclusiveFile(
    resolve(stagePath, MEX_MANAGED_SKILL_METADATA),
    desired.metadataBytes,
    0o644,
  );
  assertActivationGuard(guard);
  fsyncDirectory(stagePath);
  assertActivationGuard(guard);
}

function assertExpectedSkill(projectRoot: string, operation: SkillWriteOperation): void {
  const safety = inspectFixedTarget(projectRoot, operation.relativePath);
  if (!safety.safe) throw concurrentModification(operation.relativePath, safety.message);
  if (operation.expected.kind === "missing") {
    if (safety.exists) throw concurrentModification(operation.relativePath, "The destination appeared after preview.");
    return;
  }
  if (!safety.exists) throw concurrentModification(operation.relativePath, "The destination disappeared after preview.");
  const targetPath = absoluteFromPortable(projectRoot, operation.relativePath);
  let snapshot: DirectorySnapshot;
  try {
    snapshot = snapshotDirectory(targetPath);
  } catch (error) {
    throw concurrentModification(operation.relativePath, "The installed tree became unsafe after preview.", error);
  }
  if (snapshot.fingerprint !== operation.expected.fingerprint) {
    throw concurrentModification(operation.relativePath, "The installed tree changed after preview.");
  }
}

function applyInstructionOperation(
  projectRoot: string,
  rootIdentity: PathIdentity,
  operation: InstructionWriteOperation,
  options: AgentAssetsApplyOptions,
): void {
  assertPathIdentity(projectRoot, rootIdentity, "project root");
  const targetPath = absoluteFromPortable(projectRoot, operation.relativePath);
  const parentPath = ensureSafeDirectoryChain(projectRoot, dirnamePortable(operation.relativePath));
  assertPathIdentity(projectRoot, rootIdentity, "project root");
  const parentIdentity = capturePathIdentity(parentPath, "directory", "instruction parent");
  const stagePath = uniqueSiblingPath(parentPath, basename(targetPath), "stage");
  const backupPath = uniqueSiblingPath(parentPath, basename(targetPath), "backup");
  const mode = operation.expected.kind === "file" ? operation.expected.mode : 0o644;
  let backedUp = false;
  let activated = false;
  let stageIdentity: PathIdentity | null = null;
  let backupIdentity: PathIdentity | null = null;
  let guard: ActivationPathGuard | null = null;
  try {
    assertPathIdentity(projectRoot, rootIdentity, "project root");
    assertPathIdentity(parentPath, parentIdentity, "instruction parent");
    writeExclusiveFile(stagePath, operation.desiredBytes, mode);
    stageIdentity = capturePathIdentity(stagePath, "file", "staged instructions");
    guard = {
      rootPath: projectRoot,
      rootIdentity,
      parentPath,
      parentIdentity,
      stagePath,
      stageIdentity,
    };
    assertActivationGuard(guard);
    assertExpectedInstruction(projectRoot, operation);

    if (operation.expected.kind === "missing") {
      options.hooks?.beforeInstructionActivation?.(operation.relativePath);
      assertActivationGuard(guard);
      activateInstructionNoClobber(stagePath, targetPath, operation.relativePath);
      activated = true;
      assertPathIdentity(targetPath, stageIdentity, "activated instructions");
      assertBaseGuard(guard);
      safeUnlinkStageFile(guard);
      options.hooks?.afterInstructionActivation?.(operation.relativePath, null);
      assertBaseGuard(guard);
      assertPathIdentity(targetPath, stageIdentity, "activated instructions");
      fsyncDirectory(parentPath);
      return;
    }

    assertActivationGuard(guard);
    renameSync(targetPath, backupPath);
    backedUp = true;
    backupIdentity = capturePathIdentity(backupPath, "file", "instruction backup");
    assertExpectedInstructionBackup(operation, backupPath, backupIdentity);

    try {
      options.hooks?.beforeInstructionActivation?.(operation.relativePath);
      assertActivationGuard(guard);
      assertExpectedInstructionBackup(operation, backupPath, backupIdentity);
      assertActivationTargetAbsent(projectRoot, operation.relativePath);
      activateInstructionNoClobber(stagePath, targetPath, operation.relativePath);
      activated = true;
      assertPathIdentity(targetPath, stageIdentity, "activated instructions");
      assertBaseGuard(guard);
      safeUnlinkStageFile(guard);
    } catch (error) {
      if (backedUp) {
        try {
          assertBaseGuard(guard);
          assertPathIdentity(backupPath, backupIdentity, "instruction backup");
          if (safeLstat(targetPath)) {
            throw new Error(`A new destination prevented rollback; the original remains at ${backupPath}.`);
          }
          renameSync(backupPath, targetPath);
          backedUp = false;
        } catch (rollbackError) {
          throw new AgentAssetsError(
            "APPLY_FAILED",
            `Failed to activate ${operation.relativePath} and failed to restore its backup at ${backupPath}.`,
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
      }
      throw error;
    }

    options.hooks?.afterInstructionActivation?.(operation.relativePath, backupPath);
    assertBaseGuard(guard);
    assertPathIdentity(targetPath, stageIdentity, "activated instructions");
    if (backedUp) {
      assertExpectedInstructionBackupAfterActivation(
        operation,
        backupPath,
        backupIdentity!,
      );
      rmSync(backupPath, { force: false });
      backedUp = false;
    }
    fsyncDirectory(parentPath);
  } catch (error) {
    if (error instanceof AgentAssetsError) throw error;
    throw new AgentAssetsError(
      "APPLY_FAILED",
      `Could not ${operation.action} ${operation.relativePath}.`,
      { cause: error },
    );
  } finally {
    if (!activated && guard !== null) safeCleanupStageFile(guard);
    if (
      backedUp
      && guard !== null
      && backupIdentity !== null
      && baseGuardMatches(guard)
      && pathIdentityMatches(backupPath, backupIdentity)
      && !safeLstat(targetPath)
    ) {
      try {
        renameSync(backupPath, targetPath);
        backedUp = false;
      } catch {
        // The primary error reports the failed recovery and retained backup.
      }
    }
  }
}

function assertExpectedInstructionBackup(
  operation: InstructionWriteOperation,
  backupPath: string,
  backupIdentity: PathIdentity,
): void {
  if (operation.expected.kind !== "file") {
    throw new AgentAssetsError("APPLY_FAILED", `Unexpected backup for ${operation.relativePath}.`);
  }
  assertPathIdentity(backupPath, backupIdentity, "instruction backup");
  const backupStat = safeLstat(backupPath);
  if (!backupStat || backupStat.isSymbolicLink() || !backupStat.isFile()) {
    throw concurrentModification(
      operation.relativePath,
      `Its retained backup at ${backupPath} is missing or unsafe.`,
    );
  }
  if ((Number(backupStat.mode) & 0o777) !== operation.expected.mode) {
    throw concurrentModification(
      operation.relativePath,
      `Its retained backup at ${backupPath} changed mode during activation.`,
    );
  }
  if (sha256(readRegularFileNoFollow(backupPath)) !== operation.expected.sha256) {
    throw concurrentModification(
      operation.relativePath,
      `Its retained backup at ${backupPath} changed during activation.`,
    );
  }
}

function assertExpectedInstructionBackupAfterActivation(
  operation: InstructionWriteOperation,
  backupPath: string,
  backupIdentity: PathIdentity,
): void {
  try {
    assertExpectedInstructionBackup(operation, backupPath, backupIdentity);
  } catch (error) {
    throw activeReplacementBackupRetained(operation.relativePath, backupPath, error);
  }
}

function activateInstructionNoClobber(
  stagePath: string,
  targetPath: string,
  relativePath: string,
): void {
  try {
    // A same-directory hard link is atomic and fails with EEXIST. Unlike
    // rename, it can never replace a user file created after the preview.
    linkSync(stagePath, targetPath);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw concurrentModification(
        relativePath,
        "The file appeared during activation and was preserved.",
      );
    }
    throw error;
  }
}

function assertActivationTargetAbsent(projectRoot: string, relativePath: string): void {
  const safety = inspectFixedTarget(projectRoot, relativePath);
  if (!safety.safe) throw concurrentModification(relativePath, safety.message);
  if (safety.exists) {
    throw concurrentModification(
      relativePath,
      "A new destination appeared during activation and was preserved.",
    );
  }
}

function assertExpectedInstruction(
  projectRoot: string,
  operation: InstructionWriteOperation,
): void {
  const safety = inspectFixedTarget(projectRoot, operation.relativePath);
  if (!safety.safe) throw concurrentModification(operation.relativePath, safety.message);
  if (operation.expected.kind === "missing") {
    if (safety.exists) throw concurrentModification(operation.relativePath, "The file appeared after preview.");
    return;
  }
  if (!safety.exists) throw concurrentModification(operation.relativePath, "The file disappeared after preview.");
  const absolutePath = absoluteFromPortable(projectRoot, operation.relativePath);
  const currentStat = lstatSync(absolutePath);
  if (!currentStat.isFile()) throw concurrentModification(operation.relativePath, "The path is no longer a regular file.");
  if ((currentStat.mode & 0o777) !== operation.expected.mode) {
    throw concurrentModification(operation.relativePath, "The file mode changed after preview.");
  }
  const bytes = readRegularFileNoFollow(absolutePath);
  if (sha256(bytes) !== operation.expected.sha256) {
    throw concurrentModification(operation.relativePath, "The file changed after preview.");
  }
}

interface DirectorySnapshot {
  readonly files: Readonly<Record<string, string>>;
  /**
   * The hash of each file's bytes with CRLF line endings turned back into LF,
   * for the files that have any. Git checks text files out with CRLF under
   * core.autocrlf=true, the Windows default, so a committed managed skill
   * cloned on Windows differs from its recorded hashes in line endings only.
   * That is not a modification: the content is the content MEX installed.
   */
  readonly lineFeedFiles: Readonly<Record<string, string>>;
  /** Compatibility with ownership hashes recorded from older CRLF packages. */
  readonly crlfFiles: Readonly<Record<string, string>>;
  readonly directories: readonly string[];
  readonly fingerprint: string;
}

class UnsafeTreeError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string) {
    super(`Unsafe directory entry: ${relativePath}`);
    this.relativePath = relativePath;
  }
}

function snapshotDirectory(root: string): DirectorySnapshot {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new UnsafeTreeError(".");
  const entries: SnapshotEntry[] = [];
  const directories: string[] = [];
  snapshotDirectoryInto(root, "", entries, directories);
  entries.sort((left, right) => comparePortableText(left.path, right.path));
  directories.sort();
  const files = Object.fromEntries(entries.map((entry) => [entry.path, entry.hash]));
  const lineFeedFiles = Object.fromEntries(entries
    .filter((entry) => entry.lineFeedHash !== null)
    .map((entry) => [entry.path, entry.lineFeedHash as string]));
  const crlfFiles = Object.fromEntries(entries
    .filter((entry) => entry.crlfHash !== null)
    .map((entry) => [entry.path, entry.crlfHash as string]));
  const fingerprintHash = createHash("sha256");
  for (const directory of directories) {
    fingerprintHash.update("directory:");
    fingerprintHash.update(directory);
    fingerprintHash.update("\n");
  }
  for (const entry of entries) {
    fingerprintHash.update(String(Buffer.byteLength(entry.path, "utf8")));
    fingerprintHash.update(":");
    fingerprintHash.update(entry.path);
    fingerprintHash.update(":");
    fingerprintHash.update(entry.hash);
    fingerprintHash.update("\n");
  }
  return { files, lineFeedFiles, crlfFiles, directories, fingerprint: fingerprintHash.digest("hex") };
}

interface SnapshotEntry {
  path: string;
  hash: string;
  lineFeedHash: string | null;
  crlfHash: string | null;
}

function snapshotDirectoryInto(
  root: string,
  relativeDirectory: string,
  entries: SnapshotEntry[],
  directories: string[],
): void {
  const directory = relativeDirectory ? absoluteFromPortable(root, relativeDirectory) : root;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (!isSafePortableRelativePath(relativePath)) throw new UnsafeTreeError(relativePath);
    const absolutePath = absoluteFromPortable(root, relativePath);
    const entryStat = lstatSync(absolutePath);
    if (entryStat.isSymbolicLink()) throw new UnsafeTreeError(relativePath);
    if (entryStat.isDirectory()) {
      directories.push(relativePath);
      snapshotDirectoryInto(root, relativePath, entries, directories);
    } else if (entryStat.isFile()) {
      const bytes = readRegularFileNoFollow(absolutePath);
      const lineFeeds = withLineFeeds(bytes);
      entries.push({
        path: relativePath,
        hash: sha256(bytes),
        lineFeedHash: lineFeeds === bytes ? null : sha256(lineFeeds),
        crlfHash: isTextBytes(lineFeeds)
          ? sha256(Buffer.from(Buffer.from(lineFeeds).toString("utf8").replace(/\n/gu, "\r\n")))
          : null,
      });
    } else {
      throw new UnsafeTreeError(relativePath);
    }
  }
}

function parseMetadata(
  bytes: Uint8Array,
  expectedSkill: OfficialMexSkill,
): MexManagedSkillMetadata | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  if (!arraysEqual(Object.keys(raw).sort(), ["files", "owner", "packageVersion", "schemaVersion", "skill"])) {
    return null;
  }
  if (
    raw.schemaVersion !== MEX_MANAGED_SKILL_SCHEMA_VERSION ||
    raw.owner !== "mex-agent" ||
    raw.skill !== expectedSkill ||
    typeof raw.packageVersion !== "string" ||
    raw.packageVersion.length === 0 ||
    !isPlainObject(raw.files)
  ) {
    return null;
  }
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [path, hash] of Object.entries(raw.files).sort(
    ([left], [right]) => comparePortableText(left, right),
  )) {
    if (
      !isSafePortableRelativePath(path) ||
      path === MEX_MANAGED_SKILL_METADATA ||
      typeof hash !== "string" ||
      !HASH_PATTERN.test(hash)
    ) {
      return null;
    }
    files[path] = hash;
  }
  if (!("SKILL.md" in files)) return null;
  return {
    schemaVersion: MEX_MANAGED_SKILL_SCHEMA_VERSION,
    owner: "mex-agent",
    skill: expectedSkill,
    packageVersion: raw.packageVersion,
    files,
  };
}

function serializeMetadata(metadata: MexManagedSkillMetadata): Uint8Array {
  return Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function matchesRecordedFiles(
  actualTree: DirectorySnapshot,
  recorded: Readonly<Record<string, string>>,
): boolean {
  const actual = { ...actualTree.files };
  delete actual[MEX_MANAGED_SKILL_METADATA];
  const actualKeys = Object.keys(actual).sort();
  const recordedKeys = Object.keys(recorded).sort();
  return actualKeys.length === recordedKeys.length &&
    actualKeys.every((key, index) => key === recordedKeys[index] &&
      (actual[key] === recorded[key] || actualTree.lineFeedFiles[key] === recorded[key] ||
        actualTree.crlfFiles[key] === recorded[key])) &&
    arraysEqual(actualTree.directories, directoriesFromFiles(Object.keys(recorded)));
}

/**
 * The bytes with every CRLF turned into LF, or the same array when there is
 * none. Only UTF-8 text without NUL bytes is eligible; binary assets stay exact.
 * BOMs, bare CRs and trailing-newline differences are deliberately retained.
 */
function withLineFeeds(bytes: Uint8Array): Uint8Array {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.includes("\r\n") || !isTextBytes(bytes)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue;
    out[length++] = bytes[index]!;
  }
  return out.subarray(0, length);
}

function isTextBytes(bytes: Uint8Array): boolean {
  return !bytes.includes(0) && isUtf8(bytes);
}

function inspectFixedTarget(
  projectRoot: string,
  relativePath: string,
): { safe: true; exists: boolean } | { safe: false; exists: boolean; message: string } {
  if (!isSafePortableRelativePath(relativePath)) {
    return { safe: false, exists: false, message: `Unsafe project-relative path: ${relativePath}` };
  }
  const segments = relativePath.split("/");
  let current = projectRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    const currentStat = safeLstat(current);
    if (!currentStat) return { safe: true, exists: false };
    if (currentStat.isSymbolicLink()) {
      return {
        safe: false,
        exists: true,
        message: `${segments.slice(0, index + 1).join("/")} is a symlink; MEX will not follow it.`,
      };
    }
    if (index < segments.length - 1 && !currentStat.isDirectory()) {
      return {
        safe: false,
        exists: true,
        message: `${segments.slice(0, index + 1).join("/")} is not a directory.`,
      };
    }
  }
  return { safe: true, exists: true };
}

function ensureSafeDirectoryChain(projectRoot: string, relativeDirectory: string): string {
  if (relativeDirectory === "." || relativeDirectory === "") return projectRoot;
  if (!isSafePortableRelativePath(relativeDirectory)) {
    throw new AgentAssetsError("APPLY_FAILED", `Unsafe directory path: ${relativeDirectory}`);
  }
  let current = projectRoot;
  const segments = relativeDirectory.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    let currentStat = safeLstat(current);
    if (!currentStat) {
      mkdirSync(current, { mode: 0o755 });
      currentStat = lstatSync(current);
    }
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw concurrentModification(
        relativeDirectory,
        `${segments.slice(0, index + 1).join("/")} became a symlink or non-directory.`,
      );
    }
  }
  return current;
}

function writeExclusiveFile(path: string, bytes: Uint8Array, mode: number): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readRegularFileNoFollow(path: string): Uint8Array {
  const beforePath = lstatSync(path);
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw new UnsafeTreeError(path);
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new UnsafeTreeError(path);
    const bytes = readFileSync(descriptor);
    const afterPath = lstatSync(path);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      opened.dev !== afterPath.dev ||
      opened.ino !== afterPath.ino
    ) {
      throw new UnsafeTreeError(path);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    // Windows and some filesystems do not permit directory fsync. The file or
    // staged tree itself has already been fsynced before this durability hint.
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function uniqueSiblingPath(
  parent: string,
  targetName: string,
  purpose: "stage" | "backup" | "cleanup",
): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const token = randomBytes(8).toString("hex");
    const candidate = resolve(parent, `.${targetName}.mex-${purpose}-${token}`);
    if (!safeLstat(candidate)) return candidate;
  }
  throw new AgentAssetsError("APPLY_FAILED", `Could not allocate a temporary ${purpose} path for ${targetName}.`);
}

function gitCheckIgnored(projectRoot: string, relativePath: string): boolean {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "-q", "--", relativePath],
    { cwd: projectRoot, stdio: "ignore", windowsHide: true },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = result.error?.message
    ?? (result.signal ? `git check-ignore stopped by ${result.signal}` : `git check-ignore exited ${result.status ?? "without a status"}`);
  throw new AgentAssetsError(
    "IGNORE_CHECK_FAILED",
    detail,
    result.error === undefined ? undefined : { cause: result.error },
  );
}

function firstIgnoredSkillPath(
  projectRoot: string,
  skillPath: string,
  desired: DesiredSkill,
  checker: AgentSkillIgnoreChecker,
): string | null {
  const candidates = [
    ...desired.files.map((file) => `${skillPath}/${file.relativePath}`),
    `${skillPath}/${MEX_MANAGED_SKILL_METADATA}`,
  ];
  for (const candidate of candidates) {
    if (checker(projectRoot, candidate)) return candidate;
  }
  return null;
}

function renderNarrowIgnoreResolution(skillsDirectory: string): string {
  const clientDirectory = skillsDirectory.slice(0, skillsDirectory.indexOf("/"));
  const officialSkillPaths = OFFICIAL_MEX_SKILLS.map(
    (skill) => `${skillsDirectory}/${skill}`,
  );
  const lines = [
    `!/${clientDirectory}/`,
    `/${clientDirectory}/*`,
    `!/${skillsDirectory}/`,
    `/${skillsDirectory}/*`,
    ...officialSkillPaths.flatMap((skillPath) => [
      `!/${skillPath}/`,
      `!/${skillPath}/**`,
    ]),
  ];
  return [
    "Add these rules after the broad ignore rule in the root .gitignore:",
    ...lines,
    `They re-open only ${officialSkillPaths.join(" and ")}; do not unignore unrelated ${clientDirectory} files. MEX never edits, stages, or commits ignore rules automatically.`,
  ].join("\n");
}

function isSafePortableRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    path.startsWith("/") ||
    isAbsolute(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function absoluteFromPortable(root: string, portablePath: string): string {
  if (!isSafePortableRelativePath(portablePath)) {
    throw new AgentAssetsError("APPLY_FAILED", `Unsafe relative path: ${portablePath}`);
  }
  const absolutePath = resolve(root, ...portablePath.split("/"));
  const fromRoot = relative(root, absolutePath);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new AgentAssetsError("APPLY_FAILED", `Path escapes its root: ${portablePath}`);
  }
  return absolutePath;
}

function dirnamePortable(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function directoriesFromFiles(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return [...directories].sort();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Locale-independent ordering keeps ownership bytes identical on every client OS. */
function comparePortableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function capturePathIdentity(
  path: string,
  expectedKind: PathIdentity["kind"],
  label: string,
): PathIdentity {
  let pathStat: BigIntStats;
  try {
    pathStat = lstatSync(path, { bigint: true });
  } catch (error) {
    throw pathIdentityChanged(path, `${label} is missing or cannot be inspected.`, error);
  }
  if (pathStat.isSymbolicLink()) {
    throw pathIdentityChanged(path, `${label} became a symlink.`);
  }
  const actualKind = pathStat.isDirectory()
    ? "directory"
    : pathStat.isFile()
      ? "file"
      : null;
  if (actualKind !== expectedKind) {
    throw pathIdentityChanged(path, `${label} is no longer a ${expectedKind}.`);
  }
  return {
    device: pathStat.dev,
    inode: pathStat.ino,
    kind: expectedKind,
  };
}

function pathIdentityMatches(path: string, identity: PathIdentity): boolean {
  try {
    const pathStat = lstatSync(path, { bigint: true });
    return !pathStat.isSymbolicLink()
      && (identity.kind === "directory" ? pathStat.isDirectory() : pathStat.isFile())
      && pathStat.dev === identity.device
      && pathStat.ino === identity.inode;
  } catch {
    return false;
  }
}

function assertPathIdentity(path: string, identity: PathIdentity, label: string): void {
  if (!pathIdentityMatches(path, identity)) {
    throw pathIdentityChanged(path, `${label} changed identity during activation.`);
  }
}

function assertBaseGuard(guard: ActivationPathGuard): void {
  assertPathIdentity(guard.rootPath, guard.rootIdentity, "project root");
  assertPathIdentity(guard.parentPath, guard.parentIdentity, "destination parent");
}

function assertActivationGuard(guard: ActivationPathGuard): void {
  assertBaseGuard(guard);
  assertPathIdentity(guard.stagePath, guard.stageIdentity, "staged asset");
}

function baseGuardMatches(guard: ActivationPathGuard): boolean {
  return pathIdentityMatches(guard.rootPath, guard.rootIdentity)
    && pathIdentityMatches(guard.parentPath, guard.parentIdentity);
}

function assertSafeStageAncestors(stageRoot: string, relativeFile: string): void {
  const segments = relativeFile.split("/");
  let current = stageRoot;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = resolve(current, segments[index]!);
    const currentStat = safeLstat(current);
    if (!currentStat || currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw pathIdentityChanged(
        current,
        `A staged directory for ${relativeFile} became missing, linked, or non-directory.`,
      );
    }
  }
}

/**
 * Detach a still-owned stage to a new sibling name before recursive cleanup.
 * Rechecking the root, parent, and inode on both sides closes hook-sized path
 * swaps. Node does not expose openat(2)/unlinkat(2), so a syscall-sized race is
 * not portable to eliminate; on any observed mismatch we retain the stage.
 */
function detachOwnedStageForCleanup(
  guard: ActivationPathGuard,
): string | null {
  if (!baseGuardMatches(guard) || !pathIdentityMatches(guard.stagePath, guard.stageIdentity)) {
    return null;
  }
  let cleanupPath: string;
  try {
    cleanupPath = uniqueSiblingPath(
      guard.parentPath,
      basename(guard.stagePath),
      "cleanup",
    );
    assertActivationGuard(guard);
    renameSync(guard.stagePath, cleanupPath);
    assertBaseGuard(guard);
    assertPathIdentity(cleanupPath, guard.stageIdentity, "detached staged asset");
  } catch {
    return null;
  }
  return cleanupPath;
}

function safeCleanupStageDirectory(guard: ActivationPathGuard): void {
  const cleanupPath = detachOwnedStageForCleanup(guard);
  if (cleanupPath === null) return;
  try {
    assertBaseGuard(guard);
    assertPathIdentity(cleanupPath, guard.stageIdentity, "detached staged directory");
    rmSync(cleanupPath, { recursive: true, force: false });
  } catch {
    // Safety beats tidiness: retain anything whose parent or inode changed.
  }
}

function safeCleanupStageFile(guard: ActivationPathGuard): void {
  const cleanupPath = detachOwnedStageForCleanup(guard);
  if (cleanupPath === null) return;
  try {
    assertBaseGuard(guard);
    assertPathIdentity(cleanupPath, guard.stageIdentity, "detached staged file");
    rmSync(cleanupPath, { force: false });
  } catch {
    // Safety beats tidiness: retain anything whose parent or inode changed.
  }
}

function safeUnlinkStageFile(guard: ActivationPathGuard): void {
  assertActivationGuard(guard);
  const cleanupPath = uniqueSiblingPath(
    guard.parentPath,
    basename(guard.stagePath),
    "cleanup",
  );
  assertActivationGuard(guard);
  renameSync(guard.stagePath, cleanupPath);
  assertBaseGuard(guard);
  assertPathIdentity(cleanupPath, guard.stageIdentity, "detached staged instructions");
  rmSync(cleanupPath, { force: false });
  assertBaseGuard(guard);
}

function pathIdentityChanged(path: string, detail: string, cause?: unknown): AgentAssetsError {
  return new AgentAssetsError(
    "PATH_IDENTITY_CHANGED",
    `${detail} MEX stopped rather than following or removing a replaced path: ${path}`,
    cause === undefined ? undefined : { cause },
  );
}

function activeReplacementBackupRetained(
  path: string,
  backupPath: string,
  cause: unknown,
): AgentAssetsError {
  return new AgentAssetsError(
    "REPLACEMENT_ACTIVE_BACKUP_RETAINED",
    `${path} replacement is active, but its original changed during final verification and was retained at ${backupPath}. Inspect and reconcile that exact backup manually; MEX did not delete it.`,
    { cause },
  );
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWriteAction(action: AgentAssetAction["action"]): boolean {
  return action === "install" || action === "update" || action === "create" || action === "migrate";
}

function invalidPackagedSkill(skill: OfficialMexSkill, message: string): AgentAssetsError {
  return new AgentAssetsError("INVALID_PACKAGED_SKILL", `${skill}: ${message}`);
}

function concurrentModification(path: string, detail: string, cause?: unknown): AgentAssetsError {
  return new AgentAssetsError(
    "CONCURRENT_MODIFICATION",
    `${path} changed after preview. No replacement was made. ${detail}`,
    cause === undefined ? undefined : { cause },
  );
}
