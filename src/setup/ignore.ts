import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { classifySetupFileSystemError, SetupError } from "./errors.js";

export const SETUP_IGNORE_PATH = ".mex/.gitignore" as const;
export const SETUP_IGNORE_RULES = ["graph.db*", "wiki.db*", "local/"] as const;

export type SetupIgnoreAction = "create" | "update" | "unchanged";

export interface SetupIgnoreProtectionOptions {
  readonly projectRoot: string;
  readonly dryRun?: boolean;
}

export interface SetupIgnoreProtectionResult {
  readonly path: typeof SETUP_IGNORE_PATH;
  readonly action: SetupIgnoreAction;
  readonly dryRun: boolean;
  /** True only when this invocation wrote the missing rules. */
  readonly applied: boolean;
  /** True when rules need to be written, including during a dry run. */
  readonly changed: boolean;
  readonly addedRules: readonly string[];
}

export class SetupIgnoreProtectionError extends SetupError {
  constructor(message: string, options?: ErrorOptions & { userMessage?: string }) {
    super(message, options);
    this.name = "SetupIgnoreProtectionError";
  }
}

/**
 * Ensure checkout-local MEX databases and state cannot be staged accidentally.
 * Existing bytes are left untouched; only missing rules are appended.
 */
export function ensureSetupIgnoreProtection(
  options: SetupIgnoreProtectionOptions,
): SetupIgnoreProtectionResult {
  const dryRun = options.dryRun === true;
  const projectRoot = resolve(options.projectRoot);
  const mexDirectory = resolve(projectRoot, ".mex");
  const ignorePath = resolve(projectRoot, SETUP_IGNORE_PATH);

  requireSafeDirectory(projectRoot, "project root");

  const mexStats = lstatIfExists(mexDirectory);
  if (mexStats && (mexStats.isSymbolicLink() || !mexStats.isDirectory())) {
    throw new SetupIgnoreProtectionError(
      `Cannot protect local MEX data: ${mexDirectory} is not a safe directory.`,
      { userMessage: "The .mex path must be a regular directory, not a symlink. Fix that path, then rerun setup." },
    );
  }

  const ignoreStats = lstatIfExists(ignorePath);
  if (ignoreStats && (ignoreStats.isSymbolicLink() || !ignoreStats.isFile())) {
    throw new SetupIgnoreProtectionError(
      `Cannot protect local MEX data: ${ignorePath} is not a regular file.`,
      { userMessage: "The .mex/.gitignore path must be a regular file, not a symlink. Fix that path, then rerun setup." },
    );
  }

  let existing: Buffer;
  try {
    existing = ignoreStats ? readFileSync(ignorePath) : Buffer.alloc(0);
  } catch (error) {
    throw new SetupIgnoreProtectionError(
      error instanceof Error ? error.message : `Could not read local MEX ignore rules at ${ignorePath}.`,
      {
        cause: error,
        userMessage: classifySetupFileSystemError(error, "Could not read .mex/.gitignore.")?.userMessage
          ?? "Could not read .mex/.gitignore. Check its permissions, then rerun setup.",
      },
    );
  }
  const content = existing.toString("utf8");
  const presentRules = new Set(splitLines(content));
  const addedRules = SETUP_IGNORE_RULES.filter((rule) => !presentRules.has(rule));
  const changed = addedRules.length > 0;
  const action: SetupIgnoreAction = changed
    ? ignoreStats ? "update" : "create"
    : "unchanged";

  const result: SetupIgnoreProtectionResult = {
    path: SETUP_IGNORE_PATH,
    action,
    dryRun,
    applied: changed && !dryRun,
    changed,
    addedRules,
  };

  if (!changed || dryRun) return result;

  if (!mexStats) {
    try {
      mkdirSync(mexDirectory);
    } catch (error) {
      throw new SetupIgnoreProtectionError(
        `Could not create the MEX directory at ${mexDirectory}.`,
        {
          cause: error,
          userMessage: classifySetupFileSystemError(error, "Could not create .mex.")?.userMessage
            ?? "Could not create .mex. Check write permissions for the project directory, then rerun setup.",
        },
      );
    }
    requireSafeDirectory(mexDirectory, ".mex directory");
  }

  const eol = detectEol(content);
  const needsLeadingEol = existing.length > 0 && !endsWithEol(content);
  const suffix = `${needsLeadingEol ? eol : ""}${addedRules.join(eol)}${eol}`;

  try {
    if (ignoreStats) {
      appendFileSync(ignorePath, suffix, { encoding: "utf8" });
    } else {
      writeFileSync(ignorePath, suffix, { encoding: "utf8", flag: "wx" });
    }
  } catch (error) {
    throw new SetupIgnoreProtectionError(
      `Could not write local MEX data protection to ${ignorePath}.`,
      {
        cause: error,
        userMessage: classifySetupFileSystemError(error, "Could not write .mex/.gitignore.")?.userMessage
          ?? "Could not write .mex/.gitignore. Check write permissions for .mex and its ignore file, then rerun setup.",
      },
    );
  }

  return result;
}

/**
 * Best-effort variant for the commands that create a local store outside
 * `mex setup` — `mex graph rebuild/refresh/repair` and `mex wiki rebuild-index`.
 *
 * Issue #110 reported the consequence of not doing this: `mex graph` in a
 * checkout that had never run setup left `graph.db`, `-wal` and `-shm`
 * untracked, so the next `git add -A` committed a database. Setup writes these
 * rules at step 2, long before it builds anything, but a store writer invoked
 * on its own never passed through setup.
 *
 * Never throws. A store build must not fail because a `.gitignore` could not be
 * written — the store is still valid, the user is merely unprotected — so the
 * caller is handed the reason and decides how loudly to say so.
 */
export function tryEnsureSetupIgnoreProtection(
  projectRoot: string,
): { ok: true; result: SetupIgnoreProtectionResult } | { ok: false; reason: string } {
  try {
    return { ok: true, result: ensureSetupIgnoreProtection({ projectRoot }) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Render one concise setup status line without coupling the helper to the CLI. */
export function renderSetupIgnoreProtection(result: SetupIgnoreProtectionResult): string {
  if (!result.changed) {
    return `Local MEX data is already ignored by ${result.path}`;
  }

  const verb = result.dryRun
    ? result.action === "create" ? "Would create" : "Would update"
    : result.action === "create" ? "Created" : "Updated";
  return `${verb} ${result.path} with ${result.addedRules.join(", ")}`;
}

/** Verify Git sees derived state as ignored while canonical config stays trackable. */
export function verifySetupIgnoreProtection(projectRoot: string): void {
  const root = resolve(projectRoot);
  if (isIgnored(root, ".mex/config.json")) {
    throw new SetupIgnoreProtectionError(
      "A Git ignore rule hides .mex/config.json. Remove the broad .mex ignore so canonical MEX files can be committed.",
    );
  }
  for (const path of [
    ".mex/graph.db",
    ".mex/graph.db-wal",
    ".mex/wiki.db",
    ".mex/wiki.db-shm",
    ".mex/local/setup-state.json",
  ]) {
    if (!isIgnored(root, path)) {
      throw new SetupIgnoreProtectionError(`Local MEX path is not ignored by Git: ${path}`, {
        userMessage: "Local MEX data is not ignored by Git. Check .mex/.gitignore and conflicting negation rules, then retry setup.",
      });
    }
  }
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r\n|\n|\r/u);
  if (lines[0]?.startsWith("\uFEFF")) lines[0] = lines[0].slice(1);
  return lines;
}

function detectEol(content: string): "\r\n" | "\n" | "\r" {
  return /\r\n|\n|\r/u.exec(content)?.[0] as "\r\n" | "\n" | "\r" | undefined ?? "\n";
}

function endsWithEol(content: string): boolean {
  return content.endsWith("\n") || content.endsWith("\r");
}

function requireSafeDirectory(path: string, label: string): void {
  const stats = lstatIfExists(path);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SetupIgnoreProtectionError(
      `Cannot protect local MEX data: ${label} at ${path} is not a safe directory.`,
      { userMessage: label === "project root"
        ? "The project root must be a regular directory, not a symlink. Run setup from a valid project directory."
        : "The .mex path must be a regular directory, not a symlink. Fix that path, then rerun setup." },
    );
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new SetupIgnoreProtectionError(
      `Could not inspect setup path ${path}.`,
      {
        cause: error,
        userMessage: classifySetupFileSystemError(error, "Could not inspect the setup paths.")?.userMessage
          ?? "Could not inspect the setup paths. Check permissions for the project directory, .mex, and .mex/.gitignore, then rerun setup.",
      },
    );
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isIgnored(projectRoot: string, path: string): boolean {
  const checked = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", "--", path],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (checked.error) {
    throw new SetupIgnoreProtectionError("Could not run Git to verify local MEX data protection.", {
      cause: checked.error,
      userMessage: "Could not run Git to verify ignore rules. Make sure Git is installed and available on PATH, then rerun setup.",
    });
  }
  if (checked.status === 0) return true;
  if (checked.status === 1) return false;
  throw new SetupIgnoreProtectionError(
    `Git could not verify local MEX data protection: ${checked.stderr.trim() || `exit ${checked.status}`}`,
    { userMessage: "Git could not verify ignore rules. Check that this project is a valid Git repository and run git status to diagnose it, then rerun setup." },
  );
}
