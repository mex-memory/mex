/**
 * The subsystem plan for setup coverage.
 *
 * MEX, not the population agent, decides which areas of a repository get
 * knowledge facts and how many. The plan is deterministic and pure given its
 * inputs: source folders are split by size at any depth until none is too big to
 * be one area, ranked by recent Git activity (size when there is no history),
 * trimmed to the target count, and given a fact budget by rank. Everything here
 * is cheap and bounded: one graph query for file paths (no source parsing) or a
 * bounded file listing, and one bounded `git log` call.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { resolve, posix } from "node:path";
import { openGraphDatabase } from "../graph/db/database.js";
import { AGENT_SKILL_TARGETS, OFFICIAL_MEX_SKILLS } from "../agent-skills/types.js";

const managedSkillRoots = Object.values(AGENT_SKILL_TARGETS).flatMap((target) =>
  OFFICIAL_MEX_SKILLS.map((skill) => `${target.skillsDirectory}/${skill}/`));

function isManagedSkillSource(path: string): boolean {
  return managedSkillRoots.some((root) => path.toLowerCase().startsWith(root));
}

export interface FactBudget {
  readonly min: number;
  readonly max: number;
}

export interface SubsystemCandidate {
  /** Repo-relative folder with `/` separators. */
  readonly path: string;
  readonly files: number;
  /** Recent commits touching the folder's files; `null` when no Git history was read. */
  readonly commits: number | null;
  /** Distinct files outside the folder with a dependency edge into it; `null` when no graph was read. */
  readonly fanIn?: number | null;
  /** The folder's own files and its small subfolders, beside the larger subfolders listed separately. */
  readonly remainder?: true;
}

/** One subsystem of the fixed plan: where it is, how big and active it is, and how many facts to write. */
export interface PlannedSubsystem extends SubsystemCandidate {
  readonly budget: FactBudget;
}

export interface SubsystemTarget {
  readonly min: number;
  readonly max: number;
}

export interface SubsystemPlan {
  /** Where the file list came from: the built graph, or a listing of the source tree. */
  readonly source: "graph" | "tree";
  /** What ranked the subsystems: recent Git activity, or size alone (no Git, or no history). */
  readonly ranking: "activity" | "size";
  /** Indexed source files in the whole project (tests included); the target count scales with this. */
  readonly sourceFiles: number;
  readonly target: SubsystemTarget;
  /** The subsystems to cover, in the order to cover them (best first), between the target minimum and maximum. */
  readonly candidates: readonly PlannedSubsystem[];
}

/** Folders whose files never make a subsystem. Matched against any path segment, case-insensitively. */
export const EXCLUDED_FOLDER_NAMES: ReadonlySet<string> = new Set([
  "test", "tests", "__tests__", "__test__", "__mocks__", "__snapshots__", "spec", "specs", "e2e", "integration-tests",
  "fixture", "fixtures", "testdata", "test-data", "testing", "mocks", "mock", "stubs", "snapshots",
  "generated", "__generated__", "gen", "codegen", "migrations",
  "vendor", "vendored", "third_party", "third-party", "thirdparty", "external", "node_modules", "bower_components",
  "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".turbo", ".cache", "__pycache__", "venv", ".venv",
  "docs", "doc", "documentation", "examples", "example", "samples", "sample", "demo", "demos", "benchmarks", "benchmark",
]);

/** Words that mark a folder as excluded wherever they appear in its hyphen, underscore or dot separated name (`runtime-tests`). */
const EXCLUDED_FOLDER_WORDS: ReadonlySet<string> = new Set([
  "test", "tests", "mock", "mocks", "fixture", "fixtures", "e2e", "benchmark", "benchmarks", "perf", "generated", "vendor", "vendored",
]);

function isExcludedFolderName(name: string): boolean {
  const lower = name.toLowerCase();
  return EXCLUDED_FOLDER_NAMES.has(lower) || lower.split(/[-_.]/u).some((word) => EXCLUDED_FOLDER_WORDS.has(word));
}

const EXCLUDED_FILE_PATTERNS: readonly RegExp[] = [
  /\.(test|spec)\.[a-z0-9]+$/iu, /(^|\/)test_[^/]*\.py$/iu, /_test\.(go|py|rs|rb|exs?)$/iu, /\.d\.ts$/iu,
  /\.min\.(js|css)$/iu, /\.(generated|gen)\.[a-z0-9]+$/iu, /\.pb\.go$/iu, /_pb2(_grpc)?\.py$/iu, /(^|\/)conftest\.py$/iu,
];

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".kts", ".cs", ".rb", ".php",
  ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".scala", ".dart", ".ex", ".exs", ".lua", ".vue", ".svelte",
]);

/** A folder needs this many files to be proposed on its own. */
const MIN_FOLDER_FILES = 3;
/** A folder is split into its children only when they hold at least this share of its files. */
const SPLIT_COVERAGE = 0.6;
/** A folder with fewer files than this and no recent commits is not worth a place in the plan. */
const PLAN_FLOOR_FILES = 5;
/** Never descend below this many path segments; far deeper than any real module (bounds the recursion). */
const MAX_DEPTH = 10;

/**
 * Folder names that mark non-product code. A candidate with one of these as a
 * path segment keeps its place in the list but its score is multiplied by
 * `LOW_VALUE_MULTIPLIER`, so real product areas rank above it. Nothing else is
 * pushed down by guess (`enterprise`, `utils`, `helpers` stay as they are).
 */
export const LOW_VALUE_FOLDER_NAMES: ReadonlySet<string> = new Set([
  "playground", "scripts", "tools", "tooling", "sandbox", "devtools", "bin", "config", "configs",
]);
export const LOW_VALUE_MULTIPLIER = 0.25;
/**
 * Score weights: share of recent commits, share of source files, share of
 * dependency fan-in. Tuned on the two reference repositories: with a flatter blend
 * (0.5 / 0.3 / 0.2) tiny, widely imported utility folders and one busy feature
 * crowd out whole workspaces; recent activity must lead, and the area cap does the rest. A term that is unavailable (no history, no graph) is left
 * out and the others are scaled to sum to one.
 */
export const SCORE_WEIGHTS = Object.freeze({ activity: 0.8, size: 0.1, fanIn: 0.1 });

/**
 * Top-level folders that hold one workspace per child (`apps/api`, `libs/dal`,
 * `packages/framework`). For a path under one of them the area is the workspace
 * (two segments); otherwise it is the top-level folder.
 */
export const WORKSPACE_CONTAINERS: ReadonlySet<string> = new Set([
  "apps", "libs", "packages", "services", "modules", "crates", "plugins", "projects", "workspaces",
]);

/** No area may take more than this share of the plan's slots (rounded up). */
export const AREA_SLOT_SHARE = 1 / 3;

/** The area a subsystem path belongs to; the diversity cap counts slots per area. */
export function areaOf(path: string): string {
  const segments = path.split("/");
  return segments.length >= 2 && WORKSPACE_CONTAINERS.has(segments[0]!.toLowerCase()) ? `${segments[0]}/${segments[1]}` : segments[0]!;
}

/** Bounds on the fallback listing, the graph read and the Git reads, so setup never stalls on a huge repository. */
export const SUBSYSTEM_LIMITS = Object.freeze({
  treeEntries: 40_000,
  treeDepth: 8,
  graphFiles: 200_000,
  graphEdgeRows: 1_500_000,
  gitListBytes: 32 * 1024 * 1024,
  gitLogCommits: 2000,
  gitLogBytes: 32 * 1024 * 1024,
  gitLogMonths: 12,
  gitTimeoutMs: 15_000,
});

/** How many subsystems to cover, by the number of source files. */
export function subsystemTarget(sourceFiles: number): SubsystemTarget {
  if (sourceFiles < 300) return { min: 3, max: 4 };
  if (sourceFiles <= 3000) return { min: 5, max: 8 };
  return { min: 8, max: 12 };
}

/** The fact budget for the subsystem at `index` of `count`: top third 10-15, middle third 6-10, the rest 4-6. */
export function factBudgetForRank(index: number, count: number): FactBudget {
  if (index < Math.ceil(count / 3)) return { min: 10, max: 15 };
  if (index < Math.ceil((2 * count) / 3)) return { min: 6, max: 10 };
  return { min: 4, max: 6 };
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

/** Whether a repo-relative file path belongs to tests, fixtures, generated, vendored or docs code. */
export function isExcludedSourcePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (isManagedSkillSource(normalized)) return true;
  const segments = normalized.split("/");
  if (segments.slice(0, -1).some(isExcludedFolderName)) return true;
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface SubsystemInputs {
  /** Every indexed or listed source file, repo-relative. */
  readonly files: readonly string[];
  /**
   * The files changed by each recent commit (repo-relative).
   * Omit when no history could be read; ranking then falls back to size.
   */
  readonly commits?: ReadonlyArray<readonly string[]>;
  /** Distinct (from file, to file) dependency pairs; omit when no graph was read. */
  readonly fileEdges?: ReadonlyArray<readonly [string, string]>;
}

interface Unit {
  path: string;
  files: string[];
  remainder?: true;
}

/** Units are keyed by path, except a folder's remainder, which shares its path with the subfolders split off it. */
function unitKey(unit: Unit): string {
  return unit.remainder ? `${unit.path}\0` : unit.path;
}

function folderOf(file: string, depth: number): string | null {
  const segments = file.split("/");
  if (segments.length - 1 < depth) return null;
  return segments.slice(0, depth).join("/");
}

function groupByFolder(files: readonly string[], depth: number): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const folder = folderOf(file, depth);
    if (folder === null) continue;
    const bucket = groups.get(folder);
    if (bucket === undefined) groups.set(folder, [file]);
    else bucket.push(file);
  }
  return groups;
}

/**
 * Replace a folder that holds more than `maxFiles` files by its qualifying
 * children, recursively, until every part is small enough or has no real parts.
 * A wrapper such as `src/` is looked through (its only child takes its place);
 * files that stay behind in a split folder are an area of their own.
 */
function expand(unit: Unit, depth: number, maxFiles: number): Unit[] {
  if (unit.files.length <= maxFiles || depth >= MAX_DEPTH) return [unit];
  const children = [...groupByFolder(unit.files, depth + 1)]
    .filter(([, files]) => files.length >= MIN_FOLDER_FILES)
    .map(([path, files]): Unit => ({ path, files }));
  const covered = children.reduce((sum, child) => sum + child.files.length, 0);
  if (children.length === 0 || covered < unit.files.length * SPLIT_COVERAGE) return [unit];
  const parts = children.flatMap((child) => expand(child, depth + 1, maxFiles));
  const taken = new Set(children.flatMap((child) => child.files));
  const rest = unit.files.filter((file) => !taken.has(file));
  if (rest.length >= MIN_FOLDER_FILES) parts.push({ path: unit.path, files: rest, remainder: true });
  return parts;
}

function isLowValuePath(path: string): boolean {
  return path.toLowerCase().split("/").some((segment) => LOW_VALUE_FOLDER_NAMES.has(segment));
}

/**
 * Plan the subsystems to cover. Pure and deterministic: the graph, tree listing
 * and Git history are read elsewhere.
 *
 * 1. Top-level folders are the first candidates. Any candidate holding more than
 *    `source files / target minimum` files is replaced by its parts, at any depth.
 * 2. Candidates are scored by a blend of normalized shares: recent commits (0.5),
 *    source files (0.3) and dependency fan-in (0.2); an unavailable term is left
 *    out. Folders named in `LOW_VALUE_FOLDER_NAMES` score a quarter as much.
 * 3. The best `target.max` are kept, skipping tiny folders with no recent
 *    activity unless that would leave fewer than `target.min`, and no area (a
 *    workspace folder such as `apps/dashboard`, else the top-level folder) takes
 *    more than a third of the slots.
 * 4. Each kept subsystem gets a fact budget by rank.
 */
export function rankSubsystemCandidates(inputs: SubsystemInputs): SubsystemPlan {
  // Installed agent runtimes are MEX's tooling, not the project's subsystems.
  // Git can list hidden managed assets that the source-tree/Graph walks omit.
  const indexed = [...new Set(inputs.files.map(normalizePath))].filter((file) => !isManagedSkillSource(file));
  const files = indexed.filter((file) => !isExcludedSourcePath(file)).sort();
  const total = files.length;
  const target = subsystemTarget(indexed.length);
  const maxFiles = Math.max(MIN_FOLDER_FILES, Math.floor(total / target.min));
  const top = [...groupByFolder(files, 1)]
    .filter(([, group]) => group.length >= MIN_FOLDER_FILES)
    .map(([path, group]): Unit => ({ path, files: group }));
  // A flat repository (everything in the root, or in one folder with no parts) has no real parts to propose.
  const units = top.flatMap((unit) => expand(unit, 1, maxFiles));

  const history = inputs.commits !== undefined && inputs.commits.length > 0 ? inputs.commits : null;
  const commitCount = new Map<string, number>();
  if (history !== null) {
    const owner = new Map<string, string>();
    for (const unit of units) for (const file of unit.files) owner.set(file, unitKey(unit));
    for (const changed of history) {
      const touched = new Set<string>();
      for (const file of changed) {
        const key = owner.get(normalizePath(file));
        if (key !== undefined) touched.add(key);
      }
      for (const key of touched) commitCount.set(key, (commitCount.get(key) ?? 0) + 1);
    }
  }
  const totalCommits = [...commitCount.values()].reduce((sum, count) => sum + count, 0);
  const byActivity = history !== null && totalCommits > 0;

  const fanInCount = new Map<string, number>();
  if (inputs.fileEdges !== undefined) {
    const owner = new Map<string, string>();
    for (const unit of units) for (const file of unit.files) owner.set(file, unitKey(unit));
    const sources = new Map<string, Set<string>>();
    for (const [from, to] of inputs.fileEdges) {
      const target = owner.get(normalizePath(to));
      if (target === undefined || owner.get(normalizePath(from)) === target) continue;
      const set = sources.get(target) ?? new Set<string>();
      set.add(normalizePath(from));
      sources.set(target, set);
    }
    for (const [key, set] of sources) fanInCount.set(key, set.size);
  }
  const totalFanIn = [...fanInCount.values()].reduce((sum, count) => sum + count, 0);
  const byFanIn = inputs.fileEdges !== undefined && totalFanIn > 0;
  const weightSum = SCORE_WEIGHTS.size + (byActivity ? SCORE_WEIGHTS.activity : 0) + (byFanIn ? SCORE_WEIGHTS.fanIn : 0);

  const scored = units.map((unit) => {
    const commits = history === null ? null : commitCount.get(unitKey(unit)) ?? 0;
    const fanIn = inputs.fileEdges === undefined ? null : fanInCount.get(unitKey(unit)) ?? 0;
    const blend = SCORE_WEIGHTS.size * (total === 0 ? 0 : unit.files.length / total)
      + (byActivity ? SCORE_WEIGHTS.activity * (commits ?? 0) / totalCommits : 0)
      + (byFanIn ? SCORE_WEIGHTS.fanIn * (fanIn ?? 0) / totalFanIn : 0);
    return { unit, commits, fanIn, area: areaOf(unit.path), score: (blend / weightSum) * (isLowValuePath(unit.path) ? LOW_VALUE_MULTIPLIER : 1) };
  }).sort((a, b) => b.score - a.score || b.unit.files.length - a.unit.files.length
    || a.unit.path.localeCompare(b.unit.path) || Number(a.unit.remainder === true) - Number(b.unit.remainder === true));

  const worthIt = (entry: (typeof scored)[number]): boolean => entry.unit.files.length >= PLAN_FLOOR_FILES || (entry.commits ?? 0) > 0;
  const eligible = scored.filter(worthIt);
  const slots = Math.min(target.max, eligible.length);
  // No area may take more than a third of the slots; the next best candidates of other areas fill what that frees.
  // With fewer than three areas the cap cannot be met, so it does not apply.
  const cap = new Set(eligible.map((entry) => entry.area)).size < 3 ? slots : Math.ceil(slots * AREA_SLOT_SHARE);
  const perArea = new Map<string, number>();
  const picked = new Set<(typeof scored)[number]>();
  for (const entry of eligible) {
    if (picked.size >= slots) break;
    if ((perArea.get(entry.area) ?? 0) >= cap) continue;
    perArea.set(entry.area, (perArea.get(entry.area) ?? 0) + 1);
    picked.add(entry);
  }
  // If the other areas ran out, the best of the rest take the remaining slots.
  for (const entry of eligible) {
    if (picked.size >= slots) break;
    picked.add(entry);
  }
  for (const entry of scored) {
    if (picked.size >= target.min) break;
    picked.add(entry);
  }
  const chosen = scored.filter((entry) => picked.has(entry));
  const candidates = chosen.map(({ unit, commits, fanIn }, index): PlannedSubsystem => ({
    path: unit.path, files: unit.files.length, commits, fanIn, ...(unit.remainder ? { remainder: true as const } : {}),
    budget: factBudgetForRank(index, chosen.length),
  }));
  return { source: "tree", ranking: byActivity ? "activity" : "size", sourceFiles: indexed.length, target, candidates };
}

/** Indexed source file paths and distinct file-to-file edges from the built graph; `null` when the graph cannot be read. */
export function readGraphSubsystemInputs(projectRoot: string): SubsystemInputs | null {
  const databasePath = resolve(projectRoot, ".mex", "graph.db");
  if (!existsSync(databasePath)) return null;
  let database: ReturnType<typeof openGraphDatabase> | undefined;
  try {
    database = openGraphDatabase(databasePath, { readOnly: true });
    const files = (database.prepare("SELECT path FROM files LIMIT ?").allArrays(SUBSYSTEM_LIMITS.graphFiles) as string[][])
      .map((row) => row[0]!);
    if (files.length === 0) return null;
    const fileEdges = database.prepare(
      `SELECT DISTINCT s.file_path, t.file_path FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE e.kind <> 'contains' AND s.file_path <> t.file_path LIMIT ?`,
    ).allArrays(SUBSYSTEM_LIMITS.graphEdgeRows) as Array<[string, string]>;
    return { files, fileEdges };
  } catch {
    return null;
  } finally {
    try { database?.close(); } catch { /* a close failure changes nothing */ }
  }
}

function isSourceFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") && SOURCE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Source files listed by Git (so ignore rules apply), or `null` outside a usable repository. */
function listFilesWithGit(projectRoot: string): string[] | null {
  try {
    const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: projectRoot, encoding: "utf8", maxBuffer: SUBSYSTEM_LIMITS.gitListBytes, timeout: SUBSYSTEM_LIMITS.gitTimeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\0").filter((path) => path !== "" && isSourceFile(path));
  } catch {
    return null;
  }
}

/** Bounded directory walk for a checkout Git cannot list. Excluded folders are never entered. */
function walkSourceTree(projectRoot: string): string[] {
  const found: string[] = [];
  let entries = 0;
  const visit = (relative: string, depth: number): void => {
    if (depth > SUBSYSTEM_LIMITS.treeDepth || entries > SUBSYSTEM_LIMITS.treeEntries) return;
    let children;
    try {
      children = readdirSync(resolve(projectRoot, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      entries += 1;
      if (entries > SUBSYSTEM_LIMITS.treeEntries) return;
      const path = relative === "" ? child.name : `${relative}/${child.name}`;
      if (child.isDirectory()) {
        if (!child.name.startsWith(".") && !isExcludedFolderName(child.name)) visit(path, depth + 1);
      } else if (child.isFile() && isSourceFile(path)) {
        found.push(path);
      }
    }
  };
  visit("", 0);
  return found;
}

export interface GitHistoryOptions {
  /** Plan while graph maintenance runs, without opening its database. */
  readonly useGraph?: boolean;
  /** Directory to run Git in (paths come back relative to it); defaults to the project root. */
  readonly gitRoot?: string;
  /** Commit to start from instead of HEAD. */
  readonly revision?: string;
  /** A Git date such as `2025-01-01` or `12 months ago`; defaults to twelve months back. */
  readonly since?: string;
}

const COMMIT_MARK = "\u0001";

/** Parse `git log --name-only` output whose commits are each introduced by a marker line. */
export function parseGitCommitFiles(output: string): string[][] {
  const commits: string[][] = [];
  let current: string[] | null = null;
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith(COMMIT_MARK)) {
      current = [];
      commits.push(current);
    } else if (line !== "" && current !== null) {
      current.push(line);
    }
  }
  return commits.filter((files) => files.length > 0);
}

/**
 * The files changed by each recent commit from one bounded `git log` call.
 * `null` outside a usable repository, when Git fails, or when there is no
 * history in the window, so ranking falls back to size.
 */
export function readGitCommitFiles(projectRoot: string, options: GitHistoryOptions = {}): string[][] | null {
  try {
    const revision = options.revision;
    if (revision !== undefined && (revision === "" || revision.startsWith("-"))) return null;
    const args = [
      "-c", "core.quotepath=false", "log", "--name-only", "--no-renames", "--relative", "--format=%x01",
      "-n", String(SUBSYSTEM_LIMITS.gitLogCommits), `--since=${options.since ?? `${SUBSYSTEM_LIMITS.gitLogMonths} months ago`}`,
      ...(revision === undefined ? [] : [revision]), "--",
    ];
    const output = execFileSync("git", args, {
      cwd: options.gitRoot ?? projectRoot, encoding: "utf8", maxBuffer: SUBSYSTEM_LIMITS.gitLogBytes,
      timeout: SUBSYSTEM_LIMITS.gitTimeoutMs, stdio: ["ignore", "pipe", "ignore"],
    });
    const commits = parseGitCommitFiles(output);
    return commits.length === 0 ? null : commits;
  } catch {
    return null;
  }
}

/**
 * The coverage plan for a project, or `null` when no source files can be found.
 * Never throws: setup must still produce a prompt when this cannot help.
 */
export function computeSubsystemPlan(projectRoot: string, options: GitHistoryOptions = {}): SubsystemPlan | null {
  try {
    const graph = options.useGraph === false ? null : readGraphSubsystemInputs(projectRoot);
    const files = graph?.files ?? listFilesWithGit(projectRoot) ?? walkSourceTree(projectRoot);
    const commits = readGitCommitFiles(projectRoot, options);
    const fileEdges = graph?.fileEdges ?? readTreeImportEdges(projectRoot, files);
    const plan = rankSubsystemCandidates({
      files, ...(commits === null ? {} : { commits }), ...(fileEdges.length === 0 ? {} : { fileEdges }),
    });
    return plan.candidates.length === 0 ? null : { ...plan, source: graph === null ? "tree" : "graph" };
  } catch {
    return null;
  }
}

/** Cheap ranking evidence while the graph builds: bounded literal relative imports, no parsing or DB reads. */
export function readTreeImportEdges(projectRoot: string, files: readonly string[]): Array<readonly [string, string]> {
  const known = new Set(files);
  const edges: Array<readonly [string, string]> = [];
  let bytes = 0;
  for (const file of [...files].sort()) {
    if (bytes >= 32 * 1024 * 1024 || edges.length >= 100_000) break;
    if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
    try {
      const path = resolve(projectRoot, file);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 256 * 1024 || bytes + stat.size > 32 * 1024 * 1024) continue;
      const source = readFileSync(path, "utf8"); bytes += stat.size;
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.[^"'\r\n]+)["']/gu)) {
        const base = posix.normalize(posix.join(posix.dirname(file), match[1]!));
        const stem = base.replace(/\.[cm]?js$/u, "");
        const target = [base, ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"].map((ext) => stem + ext)].find((candidate) => known.has(candidate));
        if (target && target !== file) edges.push([file, target]);
        if (edges.length >= 100_000) break;
      }
    } catch { /* Unreadable sources supply no ranking evidence. */ }
  }
  return edges;
}

/** The plan embedded in the prompt, one line per subsystem, in the order to cover them. */
export function renderSubsystemCandidates(plan: SubsystemPlan): string {
  return plan.candidates.map((candidate, index) =>
    `${String(index + 1).padStart(2)}. ${candidate.path}/${candidate.remainder ? " (its own files and small subfolders)" : ""}`
    + ` — ${candidate.files} files, ${candidate.budget.min} to ${candidate.budget.max} facts`).join("\n");
}
