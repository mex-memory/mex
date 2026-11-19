/**
 * Recipes from config: test, build, lint, typecheck and format commands per
 * package, from package scripts, Makefiles, tox, pyproject/setup.cfg, Cargo,
 * Gradle and CI. Local reads only; checks are recorded through the native
 * evaluator in one batch, so every stored check passed when it was written.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CheckSchema, validateEntry, type EntryCheck, type KnowledgeEntry } from "../../knowledge/entry.js";
import { hasSecret } from "../../knowledge/gates.js";
import { readGitHub, readGitLab } from "./ci.js";
import { readNode, type Manager } from "./node.js";
import { readCargo, readGradle, readMake, readPython } from "./other.js";
import { RepoFiles, SCAN_LIMITS, type Found, type Local, type Origin, type Package, type PlannedCheck, type Purpose, type ReviewItem } from "./source.js";

export type { Purpose, Local, Package, ReviewItem } from "./source.js";

export interface Recipe {
  entry: KnowledgeEntry;
  purpose: Purpose;
  package: string;
  command: string;
  origin: Origin[];
  local: Local;
}
export interface RecipesFile {
  version: 1;
  scanned_at: string;
  root: string;
  manager: Manager | null;
  packages: Package[];
  build_order: string[];
  recipes: Recipe[];
  review: ReviewItem[];
  /** True when a scan bound was reached; some config was not read. */
  partial: boolean;
  /** Whether checks were recorded: "recorded", or why they weren't. */
  checks: "recorded" | "no evaluator" | "evaluator failed";
}

export interface ScanOptions {
  root: string;
  /** The native evaluator; null records no checks (readers treat verdicts as unknown). */
  binary: string | null;
  projectId?: string;
  recordDirectory?: string;
  now?: Date;
  disabledWorkflows?: ReadonlySet<string>;
}

const VERBS: Record<Purpose, string> = { test: "Test", build: "Build", lint: "Lint", typecheck: "Type-check", format: "Check formatting of" };
const MAX_COMMAND = 400;
const RECORD_TIMEOUT_MS = 30_000;

/** Fold CI finds into the config finds they run; equal CI steps share one recipe. */
function merge(found: Found[]): Array<Found & { origins: Origin[]; extra: PlannedCheck[] }> {
  const out: Array<Found & { origins: Origin[]; extra: PlannedCheck[] }> = [];
  const byMatch = new Map<string, typeof out[number]>();
  const byCommand = new Map<string, typeof out[number]>();
  for (const item of [...found.filter(f => f.source === "config"), ...found.filter(f => f.source === "ci")]) {
    const key = item.match ? `${item.match}` : undefined;
    const same = (key ? byMatch.get(key) : undefined) ?? (item.source === "ci" ? byCommand.get(`${item.package}\n${item.purpose}\n${item.command}`) : undefined);
    if (same && (same.purpose === item.purpose || same.source === "config")) {
      same.origins.push(item.origin);
      // A CI step that adds its own check strengthens the recipe; its label never weakens a config recipe.
      if (same.source === "ci" && same.local !== "yes" && item.local === "yes") same.local = "yes";
      same.extra.push(...item.checks.map(check => ({ ...check, role: "supporting" as const })));
      continue;
    }
    const recipe = { ...item, origins: [item.origin], extra: [] as PlannedCheck[] };
    out.push(recipe);
    if (key) byMatch.set(key, recipe);
    if (item.source === "ci") byCommand.set(`${item.package}\n${item.purpose}\n${item.command}`, recipe);
  }
  return out;
}

/** The language a command's tool belongs to; undefined for language-neutral tools such as make. */
export function toolFamily(command: string): string | undefined {
  const tool = command.trim().split(/\s+/u)[0] ?? "";
  if (["npm", "pnpm", "yarn", "bun", "npx"].includes(tool)) return "node";
  if (["tox", "pytest", "python", "python3", "flake8", "mypy", "ruff", "black", "nox"].includes(tool)) return "python";
  if (tool === "cargo") return "rust";
  if (["./gradlew", "gradlew", "gradle"].includes(tool)) return "gradle";
  return undefined;
}

/**
 * Test commands an agent can't choose between: two in one language, or a
 * language-neutral one (make) beside any other. Suites in different languages
 * (django's npm and tox) are not a conflict.
 */
export function conflictingTests(commands: string[]): boolean {
  const families = commands.map(toolFamily);
  if (commands.length > 1 && families.some(family => family === undefined)) return true;
  return new Set(families).size < families.length;
}

function twoTestCommands(recipes: Array<{ package: string; purpose: Purpose; command: string; origins: Origin[] }>): ReviewItem[] {
  const byPackage = new Map<string, Array<{ command: string; file: string }>>();
  for (const recipe of recipes) {
    if (recipe.purpose !== "test") continue;
    const list = byPackage.get(recipe.package) ?? [];
    if (!list.some(item => item.command === recipe.command)) list.push({ command: recipe.command, file: recipe.origins[0]!.file });
    byPackage.set(recipe.package, list);
  }
  const out: ReviewItem[] = [];
  for (const [pkg, list] of byPackage) {
    if (!conflictingTests(list.map(item => item.command))) continue;
    out.push({ kind: "two-test-commands", paths: [...new Set(list.map(item => item.file))], message: `${list.length} different test commands for ${pkg || "the root"}: ${list.slice(0, 3).map(item => `\`${item.command}\``).join(", ")}` });
  }
  return out.slice(0, 20);
}

export function entryId(pkg: string, purpose: Purpose, origin: Origin): string {
  return `mx_${createHash("sha256").update(`${pkg}\n${purpose}\n${origin.file}#${origin.pointer}`).digest("hex").slice(0, 32)}`;
}

function describe(origin: Origin): string {
  return `${origin.file} (${origin.pointer.slice(1).split("/").map(part => part.replace(/~1/gu, "/").replace(/~0/gu, "~")).join(".")})`;
}

interface RecordReply { ok: boolean; results?: Array<{ ok: boolean; check?: unknown }>; }
/** One evaluator process for every check; an item that can't be recorded is left out. */
export function recordChecks(binary: string, root: string, items: PlannedCheck[], context: { projectId?: string; recordDirectory?: string } = {}): Array<EntryCheck | undefined> {
  const result = spawnSync(binary, ["--check-run"], {
    input: JSON.stringify({ action: "record-batch", checkout: root, project_id: context.projectId, record_directory: context.recordDirectory, items }),
    encoding: "utf8", timeout: RECORD_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 << 20, env: { ...process.env, MEX_BACKGROUND: "1" },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `the evaluator exited with ${result.status}`);
  const reply = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as RecordReply;
  if (!reply.ok || !Array.isArray(reply.results) || reply.results.length !== items.length) throw new Error("the evaluator gave no answer");
  return reply.results.map(item => {
    if (!item.ok) return undefined;
    const parsed = CheckSchema.safeParse(item.check);
    return parsed.success ? parsed.data : undefined;
  });
}

export function scanRecipes(options: ScanOptions): RecipesFile {
  const files = new RepoFiles(options.root);
  const node = readNode(files);
  const make = readMake(files), python = readPython(files), cargo = readCargo(files), gradle = readGradle(files);
  const packages: Package[] = [...node.packages, ...cargo.packages, ...python.packages, ...gradle.packages, ...make.packages];
  const ci = [...readGitHub(files, packages, options.disabledWorkflows), ...readGitLab(files, packages)];
  const merged = merge([...node.found, ...make.found, ...python.found, ...cargo.found, ...gradle.found, ...ci])
    .filter(item => item.command.length <= MAX_COMMAND && !hasSecret(item.command) && !/[\x00-\x1f\x7f]/u.test(item.command))
    .slice(0, SCAN_LIMITS.recipes);

  // Record every planned check in one evaluator call.
  const planned = merged.map(item => [...item.checks, ...item.extra].slice(0, 32));
  let checks: Array<Array<EntryCheck | undefined>> = planned.map(list => list.map(() => undefined));
  let status: RecipesFile["checks"] = options.binary ? "recorded" : "no evaluator";
  if (options.binary && planned.some(list => list.length)) {
    try {
      const flat = recordChecks(options.binary, options.root, planned.flat(), options);
      let at = 0;
      checks = planned.map(list => list.map(() => flat[at++]));
    } catch { status = "evaluator failed"; }
  }

  const created = (options.now ?? new Date()).toISOString().slice(0, 10);
  const names = new Map(packages.map(pkg => [pkg.path, pkg.name]));
  const recipes: Recipe[] = [];
  const ids = new Set<string>();
  merged.forEach((item, index) => {
    const label = item.package === "" ? "the repo" : names.get(item.package) ?? item.package;
    const oneLine = `${VERBS[item.purpose]} ${label}: \`${item.command}\``;
    const lines = [oneLine, "", `Found in ${item.origins.map(describe).join("; ")}.`];
    if (item.local !== "yes") lines.push(`It can't run on this machine as written: ${item.local}.`);
    const id = entryId(item.package, item.purpose, item.origin);
    if (ids.has(id)) return;
    try {
      const entry = validateEntry({
        mex: {
          id, kind: "recipe", scope: [item.package === "" ? "**" : `${item.package}/**`],
          source: { type: item.source, ref: `${item.origin.file}#${item.origin.pointer}` },
          evidence: item.source === "ci" ? "ci" : "docs", one_line: oneLine,
          checks: checks[index]!.filter((check): check is EntryCheck => check !== undefined), status: "active", created,
        },
        text: lines.join("\n"),
      });
      ids.add(id);
      recipes.push({ entry, purpose: item.purpose, package: item.package, command: item.command, origin: item.origins, local: item.local });
    } catch { /* a recipe that isn't a valid entry is left out */ }
  });

  return {
    version: 1, scanned_at: (options.now ?? new Date()).toISOString(), root: options.root, manager: node.manager, packages,
    build_order: node.buildOrder, recipes,
    review: [...node.review, ...twoTestCommands(recipes.filter(r => r.entry.mex.source.type === "config").map(r => ({ ...r, origins: r.origin })))].slice(0, 32),
    partial: files.truncated, checks: status,
  };
}

/** The screen's recipe line and its notes. */
export function recipeSummary(file: RecipesFile): { line: string; notes: string[] } {
  const withRecipes = new Set(file.recipes.map(recipe => recipe.package));
  if (!file.recipes.length) return { line: "No test or build commands found in config", notes: file.review.map(item => item.message) };
  const names = new Map(file.packages.map(pkg => [pkg.path, pkg.name]));
  const first = file.build_order[0];
  const order = first !== undefined && file.build_order.length > 1 ? ` (build ${names.get(first) ?? first} first)` : "";
  const blocked = file.recipes.filter(recipe => recipe.local === "needs secrets" || recipe.local === "needs services").length;
  const count = withRecipes.size > 1 ? `${withRecipes.size} packages` : "this repo";
  const line = `Test and build commands for ${count}${order}${blocked ? `; ${blocked} CI ${blocked === 1 ? "step needs" : "steps need"} secrets or services` : ""}`;
  return { line, notes: file.review.map(item => item.message) };
}
