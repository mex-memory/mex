/**
 * Recipes from CI: GitHub Actions `run:` steps and GitLab CI `script:` lines,
 * matched to a purpose by what they run. A step is labelled when it can't run
 * on a laptop (it needs secrets or services) or never runs on a push or pull
 * request.
 */
import { pointer, record, strings, type Found, type Local, type Package, type Purpose, type RepoFiles } from "./source.js";
import { SCRIPT_PURPOSES } from "./node.js";

const MAX_WORKFLOWS = 64;

/** A keyword stands alone: `test`, `test:unit` or `run test`, never `test-results/` or `src/test`. */
const word = (names: string) => new RegExp(`(?:^|[\\s:])(?:${names})(?=$|[\\s:;&|)])`, "u");
const LINE_PURPOSES: ReadonlyArray<[Purpose, RegExp]> = [
  ["typecheck", word("typecheck|type-check|check-types|mypy|pyright|tsc(?! +(?:-b|--build))")],
  ["lint", word("lint|eslint|clippy|flake8|pylint|golangci-lint|stylelint|ruff +check")],
  ["format", word("format|prettier +--check|cargo +fmt|gofmt|black +--check")],
  ["test", word("test|tests|pytest|jest|vitest|tox|ctest|go +test|playwright +test")],
  ["build", word("build|compile|tsc +(?:-b|--build)")],
];
/** Installs, setup and shell plumbing have no purpose. */
const IGNORED = /^(?:echo|cd|export|set|git|curl|wget|apt(?:-get)?|brew|sudo|docker|mkdir|rm|cp|mv|cat|ls|source|if|then|for|while|\.)\b|^[A-Za-z_][A-Za-z0-9_]*=|^(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|add)\b|^pip3?\s+install\b|^(?:corepack|nvm)\b/u;

export function linePurpose(line: string): Purpose | undefined {
  const text = line.trim();
  if (!text || text.startsWith("#") || IGNORED.test(text)) return undefined;
  return LINE_PURPOSES.find(([, pattern]) => pattern.test(text))?.[0];
}

const GENERATE = word("generate|codegen");
/**
 * A line that regenerates code (`npm run generate`, `make codegen`). Kept apart from
 * the recipe purposes: recipes.json stays as it is, and only CI obligations read it.
 */
export function isGenerateLine(line: string): boolean {
  const text = line.trim();
  return !!text && !text.startsWith("#") && !IGNORED.test(text) && GENERATE.test(text);
}

/** The first line of a step that has a purpose. */
export function firstPurposeLine(run: string): { line: string; purpose: Purpose } | undefined {
  for (const raw of run.replace(/\r\n/gu, "\n").split("\n")) {
    const line = raw.trim().replace(/\s+\\$/u, "");
    const purpose = linePurpose(line);
    if (purpose) return { line, purpose };
  }
  return undefined;
}

/**
 * The key a CI line shares with the config entry it runs, so `pnpm test` in a
 * workflow and the `test` script in package.json become one recipe.
 */
export function ciMatch(line: string, packages: Package[], packagePath: string): string | undefined {
  const words = line.trim().split(/\s+/u);
  const [tool, ...rest] = words;
  if (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun") {
    let pkg = packagePath;
    const args: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i]!;
      const value = (flag: string) => word.startsWith(`${flag}=`) ? word.slice(flag.length + 1) : word === flag ? rest[++i] : undefined;
      const selector = value("--filter") ?? value("-F") ?? value("--workspace") ?? value("-w");
      if (selector !== undefined) { pkg = packages.find(item => item.name === selector || item.path === selector.replace(/^\.\//u, ""))?.path ?? pkg; continue; }
      if (tool === "yarn" && word === "workspace") { const name = rest[++i]; pkg = packages.find(item => item.name === name)?.path ?? pkg; continue; }
      if (word.startsWith("-")) continue;
      args.push(word);
    }
    const script = args[0] === "run" || args[0] === "run-script" ? args[1] : args[0];
    if (!script) return undefined;
    const known = SCRIPT_PURPOSES.flatMap(([, names]) => names);
    return known.includes(script) || args[0] === "run" ? `script:${pkg}:${script}` : undefined;
  }
  if (tool === "make") { const target = rest.find(word => !word.startsWith("-") && !word.includes("=")); return target ? `make::${target}` : undefined; }
  if (tool === "tox") { const env = rest[rest.indexOf("-e") + 1]; return rest.includes("-e") && env ? `tox:${env}` : undefined; }
  if (tool === "cargo") { const sub = rest.find(word => !word.startsWith("-") && !word.startsWith("+")); return sub ? `cargo::${sub}` : undefined; }
  if (tool === "./gradlew" || tool === "gradle" || tool === "gradlew") {
    const task = rest.find(word => !word.startsWith("-"));
    if (!task) return undefined;
    const at = task.lastIndexOf(":");
    return at > 0 ? `gradle:${task.slice(0, at).replace(/^:/u, "").replace(/:/gu, "/")}:${task.slice(at + 1)}` : `gradle::${task.replace(/^:/u, "")}`;
  }
  if (tool === "pytest" || tool === "flake8") return `python:${tool}`;
  return undefined;
}

const SECRET = /\$\{\{\s*secrets\./u;
function mentionsSecret(value: unknown): boolean {
  try { return SECRET.test(JSON.stringify(value ?? null)); } catch { return false; }
}
function secretVariables(env: unknown): string[] {
  return Object.entries(record(env) ?? {}).filter(([, value]) => mentionsSecret(value)).map(([name]) => name);
}
function usesVariable(run: string, names: string[]): boolean {
  return names.some(name => new RegExp(`\\$\\{?${name.replace(/[^A-Za-z0-9_]/gu, "")}\\b|env\\.${name.replace(/[^A-Za-z0-9_]/gu, "")}\\b`, "u").test(run));
}

/** Triggers that never fire on a push or pull request. */
function neverOnPush(on: unknown): boolean {
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? strings(on) : Object.keys(record(on) ?? {});
  return triggers.length > 0 && triggers.every(trigger => trigger === "workflow_dispatch");
}
/** A background process (`cmd &`) or containers started for later steps. */
const STARTS_SERVICES = /&\s*(?:$|\n)|\bdocker(?:-compose|\s+compose)\s+up\b|\bdocker\s+run\b/mu;
const DISABLED_IF = /^\s*(?:\$\{\{\s*)?false(?:\s*\}\})?\s*$/u;
/** A job's or step's `if:` that turns it off. */
export function disabledIf(value: unknown): boolean {
  return value !== undefined && (value === false || (typeof value === "string" && DISABLED_IF.test(value)));
}

export function packageFor(directory: unknown, packages: Package[]): string {
  if (typeof directory !== "string") return "";
  const path = directory.replace(/^\.\//u, "").replace(/\/+$/u, "");
  return packages.some(pkg => pkg.path === path) ? path : "";
}

export function readGitHub(files: RepoFiles, packages: Package[], disabled?: ReadonlySet<string>): Found[] {
  const directory = ".github/workflows";
  if (!files.isDirectory(directory)) return [];
  const found: Found[] = [];
  const workflows = files.filesIn(directory).filter(name => /\.ya?ml$/u.test(name)).slice(0, MAX_WORKFLOWS);
  for (const name of workflows) {
    const file = `${directory}/${name}`;
    const workflow = record(files.yaml(file));
    if (!workflow) continue;
    const off = disabled?.has(file) === true || neverOnPush(workflow.on ?? workflow.true);
    const workflowSecrets = secretVariables(workflow.env);
    for (const [jobName, rawJob] of Object.entries(record(workflow.jobs) ?? {})) {
      const job = record(rawJob);
      if (!job) continue;
      const jobOff = off || (job.if !== undefined && (job.if === false || (typeof job.if === "string" && DISABLED_IF.test(job.if))));
      const jobSecrets = [...workflowSecrets, ...secretVariables(job.env)];
      const services = record(job.services) !== undefined && Object.keys(record(job.services)!).length > 0;
      const credentials = record(record(job.container)?.credentials) !== undefined;
      const defaultDirectory = record(record(job.defaults)?.run)?.["working-directory"];
      const steps = Array.isArray(job.steps) ? job.steps : [];
      // A step after one that starts a server or containers needs them running too.
      let started = false;
      steps.forEach((rawStep, index) => {
        const step = record(rawStep);
        if (!step || typeof step.run !== "string") return;
        const hit = firstPurposeLine(step.run);
        const startsServices = STARTS_SERVICES.test(step.run);
        if (!hit) { started ||= startsServices; return; }
        const stepSecrets = [...jobSecrets, ...secretVariables(step.env)];
        let local: Local = "yes";
        if (jobOff || (step.if !== undefined && (step.if === false || (typeof step.if === "string" && DISABLED_IF.test(step.if))))) local = "from CI config, not running";
        else if (credentials || mentionsSecret(step.run) || mentionsSecret(step.with) || usesVariable(step.run, stepSecrets)) local = "needs secrets";
        else if (services || started) local = "needs services";
        started ||= startsServices;
        const pkg = packageFor(step["working-directory"] ?? defaultDirectory, packages);
        const at = pointer("jobs", jobName, "steps", index, "run");
        found.push({
          purpose: hit.purpose, package: pkg, command: hit.line, source: "ci", local, origin: { file, pointer: at },
          match: ciMatch(hit.line, packages, pkg),
          checks: [
            { kind: "key", role: "complete", target: { file, pointer: at } },
            { kind: "command", role: "supporting", target: { run: hit.line, file, pointer: at } },
          ],
        });
      });
    }
  }
  return found;
}

const GITLAB_RESERVED = new Set(["stages", "variables", "default", "include", "workflow", "image", "services", "before_script", "after_script", "cache", "pages"]);

export function readGitLab(files: RepoFiles, packages: Package[]): Found[] {
  const file = ".gitlab-ci.yml";
  const config = files.isFile(file) ? record(files.yaml(file)) : undefined;
  if (!config) return [];
  const sharedServices = Array.isArray(config.services) && config.services.length > 0;
  const found: Found[] = [];
  for (const [jobName, rawJob] of Object.entries(config)) {
    const job = record(rawJob);
    if (!job || jobName.startsWith(".") || GITLAB_RESERVED.has(jobName)) continue;
    const lines = typeof job.script === "string" ? [job.script] : strings(job.script);
    const index = lines.findIndex(line => firstPurposeLine(line));
    if (index < 0) continue;
    const hit = firstPurposeLine(lines[index]!)!;
    const rules = Array.isArray(job.rules) ? job.rules.map(record) : [];
    const never = job.when === "never" || (rules.length > 0 && rules.every(rule => rule?.when === "never"));
    const local: Local = never ? "from CI config, not running" : (Array.isArray(job.services) && job.services.length > 0) || sharedServices ? "needs services" : "yes";
    const at = typeof job.script === "string" ? pointer(jobName, "script") : pointer(jobName, "script", index);
    found.push({
      purpose: hit.purpose, package: "", command: hit.line, source: "ci", local, origin: { file, pointer: at },
      match: ciMatch(hit.line, packages, ""),
      checks: [
        { kind: "key", role: "complete", target: { file, pointer: at } },
        { kind: "command", role: "supporting", target: { run: hit.line, file, pointer: at } },
      ],
    });
  }
  return found;
}
