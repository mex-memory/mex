// ============================================================================
// Engine snapshot layer
// ============================================================================
//
// One read-only view of what mex knows about a project, assembled from the
// on-disk sources of truth (`.mex/` markdown, `.mex/config.json`,
// `.mex/graph.db`) via the existing engine APIs. Everything here is a pure
// read: no identity is minted, no config is written, no graph is built.
//
// `readSnapshot` never throws. A missing scaffold is `status: "empty"` and a
// broken one is `status: "error"` — both are states the UI renders, not
// exceptions it has to catch.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { findConfig, readScaffoldIdentity } from "../config.js";
import { parseFrontmatter } from "../drift/frontmatter.js";
import { VERSION } from "../version.js";
import { buildPopulationPrompt, detectProjectState, findProjectRoot, scaffoldFilesForMode, type ProjectState } from "../setup/steps.js";
import type { AiTool, ScaffoldIdentity } from "../types.js";

/**
 * `empty`  — no `.mex/` here yet; the setup wizard is the way forward.
 * `ready`  — a usable scaffold the dashboard can render.
 * `error`  — a scaffold exists but mex can't load it (incomplete, corrupt).
 */
export type ProjectStatus = "empty" | "ready" | "error";

export interface ScaffoldFileStatus {
  /** Scaffold-relative path, e.g. `context/stack.md`. */
  file: string;
  exists: boolean;
  /** False while the file still holds unfilled template placeholders. */
  populated: boolean;
  /** `last_updated` from frontmatter, when present. */
  lastUpdated: string | null;
  bytes: number;
}

export interface GraphFileStatus {
  present: boolean;
  /** Project-relative path to the graph database. */
  path: string;
  bytes: number;
  modifiedAt: string | null;
}

export interface SnapshotError {
  message: string;
  hint: string | null;
  /** True when running the setup wizard is a plausible repair. */
  canRunSetup: boolean;
}

export interface ProjectSnapshot {
  status: ProjectStatus;
  /** mex version serving this snapshot. */
  version: string;
  /** The directory the server was pointed at. */
  root: string;
  /** Resolved project root — the git root when one was found. */
  projectRoot: string;
  projectName: string;
  isGitRepo: boolean;
  /** Absolute path to `.mex/`, or null when there is none. */
  scaffoldRoot: string | null;
  /** Persisted identity. Null means none has been minted — we do not mint one. */
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

export interface ReadSnapshotOptions {
  /** Directory to inspect. Defaults to the process cwd. */
  root?: string;
}

const GRAPH_DB_RELATIVE = ".mex/graph.db";

/**
 * Assemble a {@link ProjectSnapshot} for `root`. Cheap by design — it stats the
 * graph database rather than opening it, and reads only the dozen small
 * scaffold markdown files. Richer views (drift, graph stats, activity) are
 * separate calls so a slow one never blocks the shell from rendering.
 */
export function readSnapshot(options: ReadSnapshotOptions = {}): ProjectSnapshot {
  const root = resolve(options.root ?? process.cwd());
  const capturedAt = new Date().toISOString();

  const base = {
    version: VERSION,
    root,
    capturedAt,
  };

  if (!existsSync(root)) {
    return {
      ...base,
      status: "error",
      projectRoot: root,
      projectName: basename(root),
      isGitRepo: false,
      scaffoldRoot: null,
      identity: null,
      aiTools: [],
      scaffold: emptyScaffoldSummary(),
      graph: { present: false, path: GRAPH_DB_RELATIVE, bytes: 0, modifiedAt: null },
      error: {
        message: `Directory not found: ${root}`,
        hint: "Start mex ui from a directory that exists, or pass --root <dir>.",
        canRunSetup: false,
      },
    };
  }

  const projectRoot = findProjectRoot(root);
  const isGitRepo = existsSync(resolve(projectRoot, ".git"));
  const mexDir = resolve(projectRoot, ".mex");
  const graph = readGraphFileStatus(projectRoot);

  const shell = {
    ...base,
    projectRoot,
    projectName: basename(projectRoot) || projectRoot,
    isGitRepo,
    graph,
  };

  if (!existsSync(mexDir)) {
    return {
      ...shell,
      status: "empty",
      scaffoldRoot: null,
      identity: null,
      aiTools: [],
      scaffold: emptyScaffoldSummary(),
      error: null,
    };
  }

  const scaffold = readScaffoldStatus(mexDir);

  // findConfig requires ROUTER.md — an incomplete `.mex/` is recoverable by
  // re-running setup, so report it as an error the UI can act on rather than
  // pretending the project is empty.
  if (!existsSync(resolve(mexDir, "ROUTER.md"))) {
    return {
      ...shell,
      status: "error",
      scaffoldRoot: mexDir,
      identity: readIdentitySafely(mexDir),
      aiTools: [],
      scaffold,
      error: {
        message: "The .mex/ directory exists but ROUTER.md is missing, so the scaffold can't be loaded.",
        hint: "Re-run setup to restore the missing scaffold files. Populated files are left untouched.",
        canRunSetup: true,
      },
    };
  }

  try {
    const config = findConfig(projectRoot);
    return {
      ...shell,
      status: "ready",
      scaffoldRoot: config.scaffoldRoot,
      identity: config.identity ?? null,
      aiTools: config.aiTools,
      scaffold,
      error: null,
    };
  } catch (error) {
    return {
      ...shell,
      status: "error",
      scaffoldRoot: mexDir,
      identity: readIdentitySafely(mexDir),
      aiTools: [],
      scaffold,
      error: {
        message: error instanceof Error ? error.message : String(error),
        hint: "Re-run setup to repair the scaffold, or fix .mex/ by hand and reload.",
        canRunSetup: true,
      },
    };
  }
}

/**
 * The extra detection the setup wizard needs, kept out of {@link readSnapshot}
 * because classifying a project globs the source tree.
 */
export interface SetupPlan {
  projectRoot: string;
  projectName: string;
  isGitRepo: boolean;
  /** Whether a `.mex/` already exists here. */
  hasScaffold: boolean;
  state: ProjectState;
  /** Files the chosen mode will place under `.mex/`. */
  scaffoldFiles: string[];
  /** True when this project root is a checkout of mex itself. */
  isMexRepo: boolean;
  /**
   * Prompt to paste into a coding agent to fill remaining template files.
   * Built without re-running setup or scanning — the wizard's last step, kept
   * here so closing that tab is not a dead end.
   */
  populationPrompt: string;
}

export function readSetupPlan(options: ReadSnapshotOptions = {}): SetupPlan {
  const root = resolve(options.root ?? process.cwd());
  const projectRoot = findProjectRoot(root);
  const mexDir = resolve(projectRoot, ".mex");
  const state = detectProjectState(projectRoot, mexDir);
  return {
    projectRoot,
    projectName: basename(projectRoot) || projectRoot,
    isGitRepo: existsSync(resolve(projectRoot, ".git")),
    hasScaffold: existsSync(mexDir),
    state,
    scaffoldFiles: scaffoldFilesForMode("code-repo"),
    isMexRepo: looksLikeMexRepo(projectRoot),
    populationPrompt: buildPopulationPrompt({ mode: "code-repo", state, scannerBrief: null }),
  };
}

function looksLikeMexRepo(projectRoot: string): boolean {
  if (!existsSync(resolve(projectRoot, "src", "setup", "index.ts"))) return false;
  const pkg = resolve(projectRoot, "package.json");
  if (!existsSync(pkg)) return false;
  try {
    const content = readFileSync(pkg, "utf-8");
    return content.includes('"promexeus"') || content.includes('"mex"');
  } catch {
    return false;
  }
}

function readIdentitySafely(mexDir: string): ScaffoldIdentity | null {
  try {
    return readScaffoldIdentity(mexDir) ?? null;
  } catch {
    return null;
  }
}

function readGraphFileStatus(projectRoot: string): GraphFileStatus {
  const dbPath = resolve(projectRoot, ".mex", "graph.db");
  try {
    const stats = statSync(dbPath);
    return {
      present: true,
      path: GRAPH_DB_RELATIVE,
      bytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return { present: false, path: GRAPH_DB_RELATIVE, bytes: 0, modifiedAt: null };
  }
}

function emptyScaffoldSummary(): ProjectSnapshot["scaffold"] {
  return { files: [], total: 0, present: 0, populated: 0 };
}

/**
 * Report per-file scaffold coverage. `populated` is the same "is this still a
 * template?" test setup uses to decide what it may overwrite, so the dashboard
 * and the wizard agree on which slots are still empty.
 */
function readScaffoldStatus(mexDir: string): ProjectSnapshot["scaffold"] {
  const files: ScaffoldFileStatus[] = scaffoldFilesForMode("code-repo").map((file) => {
    const absolute = resolve(mexDir, file);
    if (!existsSync(absolute)) {
      return { file, exists: false, populated: false, lastUpdated: null, bytes: 0 };
    }
    let content = "";
    let bytes = 0;
    try {
      content = readFileSync(absolute, "utf-8");
      bytes = statSync(absolute).size;
    } catch {
      return { file, exists: true, populated: false, lastUpdated: null, bytes: 0 };
    }
    const frontmatter = parseFrontmatter(absolute);
    const lastUpdated =
      typeof frontmatter?.last_updated === "string" ? frontmatter.last_updated : null;
    return {
      file,
      exists: true,
      populated: !isTemplatePlaceholder(content),
      lastUpdated,
      bytes,
    };
  });

  return {
    files,
    total: files.length,
    present: files.filter((f) => f.exists).length,
    populated: files.filter((f) => f.populated).length,
  };
}

function isTemplatePlaceholder(content: string): boolean {
  return content.includes("[Project Name]") || content.includes("[YYYY-MM-DD]");
}
