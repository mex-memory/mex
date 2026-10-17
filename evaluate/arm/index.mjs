#!/usr/bin/env node
// Agent-arm test: the same Claude Code sessions with and without MEX on a
// pinned subject. See evaluate/arm/README.md.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchedule } from "../compare/lib/schedule.mjs";
import { runSync } from "../compare/lib/process.mjs";
import { aliasCoverage, installProductHooks } from "./lib/hooks.mjs";
import { buildBlindReview, generateReport, loadRows } from "./lib/report.mjs";
import { MEX_PROMPTS, runAgentSession } from "./lib/session.mjs";
import { armPath, buildIndexCache, createWorkspace, git, installContextIndex, installIndexes, mexEntrypoint, refreshContextIndexCache, removeWorkspace, resolveCommit } from "./lib/workspace.mjs";

const fileSha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function parseArgs(argv) {
  const args = { mode: null, tasks: null, arms: null, repetition: null, resume: false, timeoutQaMs: 900_000, timeoutChangeMs: 1_800_000, claude: ["claude"] };
  const value = (i) => { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--prepare", "--run", "--blind", "--report", "--refresh-context-index"].includes(arg)) args.mode = arg.slice(2);
    else if (arg === "--suite") args.suite = resolve(value(i++));
    else if (arg === "--subject") args.subject = resolve(value(i++));
    else if (arg === "--cli-bin") args.cliBin = resolve(value(i++));
    else if (arg === "--deps") args.deps = resolve(value(i++));
    else if (arg === "--aliases") args.aliases = resolve(value(i++));
    else if (arg === "--output") args.output = resolve(value(i++));
    else if (arg === "--model") args.model = value(i++);
    else if (arg === "--tasks") args.tasks = value(i++).split(",").map((id) => id.trim());
    else if (arg === "--arms") args.arms = value(i++).split(",").map((id) => id.trim());
    else if (arg === "--repetition") args.repetition = Number(value(i++));
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--timeout-qa-ms") args.timeoutQaMs = Number(value(i++));
    else if (arg === "--timeout-change-ms") args.timeoutChangeMs = Number(value(i++));
    else if (arg === "--fake-agent") args.claude = [process.execPath, resolve(value(i++))];
    else if (arg === "--mex-prompt") args.mexPrompt = value(i++);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.mexPrompt !== undefined && !MEX_PROMPTS.includes(args.mexPrompt)) throw new Error(`--mex-prompt must be one of ${MEX_PROMPTS.join(", ")}`);
  if (!args.mode) throw new Error("choose --prepare, --run, --blind, --report or --refresh-context-index");
  for (const key of args.mode === "refresh-context-index" ? ["output"] : ["suite", "output"]) if (!args[key]) throw new Error(`--${key} is required`);
  if (["prepare", "run"].includes(args.mode)) {
    // --deps is checked against the suite later: a subject without node_modules (Python) sets "requiresDeps": false.
    for (const key of ["subject", "cliBin", "model"]) if (!args[key]) throw new Error(`--${key === "cliBin" ? "cli-bin" : key} is required for --${args.mode}`);
  }
  return args;
}

// An arm may carry the scaffold without the CLI (Markdown only); `cli` defaults to `scaffold`.
// `push` arms deliver knowledge through the earlier prototype's hooks (kept for old suites).
// `hooks` arms install the product's hooks (`mex hooks install`); `lexical` sets MEX_HOOK_LEXICAL=1 for the
// session, and `semantic` expects the semantic extra, so the prompt recipe is R3 instead of R2w.
export function armSpecFor(arm) {
  const withMex = Boolean(arm.scaffold);
  const withHooks = withMex && arm.hooks === true;
  if (arm.hooks && !withMex) throw new Error("a hooks arm needs the scaffold");
  if ((arm.lexical || arm.semantic) && !withHooks) throw new Error("lexical and semantic only apply to hooks arms");
  if (arm.lexical && arm.semantic) throw new Error("an arm is lexical or semantic, not both");
  return { withMex, withCli: withMex && arm.cli !== false, withPush: withMex && arm.push === true, withHooks, lexical: withHooks && arm.lexical === true, semantic: withHooks && arm.semantic === true };
}

/** Environment variables the product's hooks read; an arm gets exactly the ones it is meant to have. */
const HOOK_ENV = ["MEX_HOOK_LEXICAL", "MEX_CLI", "MEX_PUSH_LOG"];

/** The environment of one session (or of the index builds for it). */
export function sessionEnv({ baseEnv = process.env, cliBin, armSpec, pushLog = null }) {
  const env = { ...baseEnv, PATH: armPath(baseEnv.PATH, { cliBin, withMex: armSpec.withCli }) };
  for (const name of HOOK_ENV) delete env[name];
  if (armSpec.withPush && pushLog) env.MEX_PUSH_LOG = pushLog;
  if (armSpec.withHooks) {
    env.MEX_CLI = mexEntrypoint(cliBin);
    if (armSpec.lexical) env.MEX_HOOK_LEXICAL = "1";
  }
  return env;
}

/** The folder name of every checkout of the subject. It feeds the project stop words, so it is neutral and constant. */
export const projectNameOf = (suite) => suite.projectName ?? "project";

const PUSH_HOOK = join(".claude", "hooks", "mex-push.mjs");

/** Build the push index in a session checkout, after its Graph and Wiki indexes are in place. */
function preparePush(workspace, env) {
  const result = runSync(process.execPath, [join(workspace, PUSH_HOOK), "index"], { cwd: workspace, env: { ...env, CLAUDE_PROJECT_DIR: workspace } });
  if (result.code !== 0) throw new Error(`push index failed in ${workspace}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

/** What the hooks delivered in one session, from the log they append to. */
export function summarizePushLog(path) {
  if (!existsSync(path)) return null;
  const summary = { prompt: 0, read: 0, edit: 0, stopBlock: 0, regrounded: 0, regroundFailed: 0, injectedChars: 0, hookMs: 0, stopMs: 0, settleMs: 0, refreshFailed: 0, errors: 0 };
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    // The index is built before the session starts; only in-session hook time counts.
    // The settle worker runs detached after the agent is done; it is not hook time.
    if (entry.event === "settle") { summary.settleMs += entry.ms ?? 0; if (entry.refresh) summary.refreshFailed += 1; }
    else if (entry.event !== "index") summary.hookMs += entry.ms ?? 0;
    if (String(entry.event).startsWith("stop")) summary.stopMs += entry.ms ?? 0;
    summary.injectedChars += entry.chars ?? 0;
    if (entry.event === "error" || entry.error) summary.errors += 1;
    if (["prompt", "read", "edit"].includes(entry.event) && entry.injected) summary[entry.event] += 1;
    if (entry.event === "stop-block") summary.stopBlock += 1;
    if (entry.event === "stop-reground" || entry.event === "settle") { summary.regrounded += entry.ok; summary.regroundFailed += entry.drifted - entry.ok; }
  }
  return summary;
}

const indexKey = (base, scaffold) => `${base.slice(0, 12)}-${scaffold.slice(0, 12)}`;

function prepare(args, suite) {
  mkdirSync(args.output, { recursive: true });
  const projectName = projectNameOf(suite);
  const mexEnv = sessionEnv({ cliBin: args.cliBin, armSpec: { withCli: true, withHooks: false } });
  const scaffolds = Object.fromEntries(Object.entries(suite.scaffolds).map(([name, ref]) => [name, resolveCommit(args.subject, ref)]));
  const tasks = {};
  const baselines = {};
  const coverage = {};
  const specs = Object.values(suite.arms).map(armSpecFor);
  // Graph and Wiki indexes only matter when some arm has the CLI; the context index when some arm has hooks.
  const needsIndexes = specs.some((spec) => spec.withCli);
  const needsHooks = specs.some((spec) => spec.withHooks);
  const semantic = needsHooks ? semanticStatus(args.cliBin, mexEnv) : null;
  if (specs.some((spec) => spec.semantic) && semantic?.state !== "installed") throw new Error(`a semantic arm needs the semantic extra (mex context semantic install); status: ${semantic?.state ?? "unknown"}`);
  let aliasesFile = null, aliasIds = null;
  if (needsHooks && args.aliases) {
    aliasesFile = join(args.output, "context-aliases.json");
    copyFileSync(args.aliases, aliasesFile);
    aliasIds = Object.keys(JSON.parse(readFileSync(aliasesFile, "utf8")));
  }
  const hooks = needsHooks ? { aliasesFile } : null;
  for (const task of suite.tasks) {
    const base = resolveCommit(args.subject, task.base);
    const scaffold = scaffolds[task.scaffold];
    const key = indexKey(base, scaffold);
    const cachePath = !needsIndexes ? null : buildIndexCache({ subjectRoot: args.subject, cacheDir: join(args.output, "index-cache"), key, base, scaffoldCommit: scaffold, cliBin: args.cliBin, env: mexEnv, depsDir: args.deps, projectName, hooks });
    if (cachePath) baselines[key] = JSON.parse(readFileSync(join(cachePath, "check-baseline.json"), "utf8"));
    if (cachePath && hooks && !coverage[key]) coverage[key] = aliasCoverage(join(cachePath, "context-index.json"), aliasIds ?? []);
    tasks[task.id] = { base, scaffold, indexKey: key, cachePath, hiddenFrom: task.hiddenTests?.fromCommit ? resolveCommit(args.subject, task.hiddenTests.fromCommit) : null };
  }
  const entry = mexEntrypoint(args.cliBin);
  const prepared = {
    schemaVersion: 1, suiteId: suite.id, suiteSha256: fileSha(args.suite), preparedAt: new Date().toISOString(),
    subject: { root: args.subject, scaffolds, autocrlf: git(args.subject, ["config", "--get", "core.autocrlf"], { allowFailure: true }).stdout.trim() || null },
    cli: { bin: args.cliBin, entrypoint: entry, sha256: fileSha(entry), version: runSync(process.execPath, [entry, "--version"]).stdout.trim() },
    deps: args.deps ?? null, indexedWithDeps: Boolean(args.deps), model: args.model, mexPrompt: args.mexPrompt ?? "none", projectName,
    ...(suite.python ? { python: { path: suite.python, version: runSync(suite.python, ["--version"]).stdout.trim() } } : {}),
    ...(needsHooks ? { hooks: { hookBin: join(args.cliBin, process.platform === "win32" ? "mex-hook.cmd" : "mex-hook"), semantic, aliases: aliasesFile ? { file: aliasesFile, sha256: fileSha(aliasesFile), ids: aliasIds.length } : null, aliasCoverage: coverage } } : {}),
    agent: { claudeVersion: runSync(args.claude[0], [...args.claude.slice(1), "--version"]).stdout.trim() },
    node: process.version, platform: `${process.platform}-${process.arch}`,
    tasks,
  };
  writeJson(join(args.output, "prepare.json"), prepared);
  writeJson(join(args.output, "baselines.json"), baselines);
  process.stdout.write(`prepared ${suite.tasks.length} tasks; index caches in ${join(args.output, "index-cache")}\n`);
}

/**
 * `--refresh-context-index`: rebuild the cached context indexes of a prepared output with the
 * current frozen CLI (graphs and Wiki indexes are reused), and re-pin the CLI in prepare.json.
 */
function refreshContextIndexes(args) {
  const path = join(args.output, "prepare.json");
  const prepared = JSON.parse(readFileSync(path, "utf8"));
  const cliBin = args.cliBin ?? prepared.cli.bin;
  const env = sessionEnv({ cliBin, armSpec: { withCli: true, withHooks: false } });
  const aliasesFile = prepared.hooks?.aliases?.file ?? null;
  const done = new Set();
  for (const info of Object.values(prepared.tasks)) {
    if (!info.cachePath || done.has(info.cachePath)) continue;
    done.add(info.cachePath);
    const { contextIndexMs } = refreshContextIndexCache({ subjectRoot: prepared.subject.root, cachePath: info.cachePath, base: info.base, scaffoldCommit: info.scaffold, cliBin, env, depsDir: prepared.deps, projectName: prepared.projectName, aliasesFile });
    process.stdout.write(`refreshed ${info.indexKey} in ${contextIndexMs} ms
`);
  }
  copyFileSync(path, join(args.output, `prepare.before-index-refresh-${Date.now()}.json`));
  const entry = mexEntrypoint(cliBin);
  prepared.cli = { bin: cliBin, entrypoint: entry, sha256: fileSha(entry), version: runSync(process.execPath, [entry, "--version"]).stdout.trim() };
  if (prepared.hooks) {
    prepared.hooks.hookBin = join(cliBin, process.platform === "win32" ? "mex-hook.cmd" : "mex-hook");
    prepared.hooks.semantic = semanticStatus(cliBin, env);
    if (aliasesFile) {
      const aliasIds = Object.keys(JSON.parse(readFileSync(aliasesFile, "utf8")));
      prepared.hooks.aliasCoverage = Object.fromEntries([...done].map((cachePath) => [basename(cachePath), aliasCoverage(join(cachePath, "context-index.json"), aliasIds)]));
    }
  }
  prepared.contextIndexRefreshedAt = new Date().toISOString();
  writeJson(path, prepared);
}

/** `mex context semantic status`: the machine-level extra the R3 recipe needs. */
function semanticStatus(cliBin, env) {
  const result = runSync(process.execPath, [mexEntrypoint(cliBin), "context", "semantic", "status", "--json"], { env });
  try { return JSON.parse(result.stdout).data; } catch { return { state: "unknown" }; }
}

function loadPrepared(args, suite) {
  const path = join(args.output, "prepare.json");
  if (!existsSync(path)) throw new Error("run --prepare first");
  const prepared = JSON.parse(readFileSync(path, "utf8"));
  if (prepared.suiteSha256 !== fileSha(args.suite)) throw new Error("suite changed after --prepare");
  if (fileSha(prepared.cli.entrypoint) !== prepared.cli.sha256) throw new Error("frozen MEX CLI changed after --prepare");
  if (prepared.model !== args.model) throw new Error(`model differs from the prepared run (${prepared.model})`);
  // Runs prepared before the option existed used no MEX prompt.
  const mexPrompt = prepared.mexPrompt ?? "none";
  if (args.mexPrompt !== undefined && args.mexPrompt !== mexPrompt) throw new Error(`--mex-prompt differs from the prepared run (${mexPrompt})`);
  for (const [name, commit] of Object.entries(prepared.subject.scaffolds)) {
    if (resolveCommit(args.subject, suite.scaffolds[name]) !== commit) throw new Error(`scaffold ${name} moved after --prepare`);
  }
  return prepared;
}

async function run(args, suite) {
  const prepared = loadPrepared(args, suite);
  const armIds = Object.keys(suite.arms);
  const schedule = buildSchedule(suite.tasks, armIds, suite.repetitions)
    .filter((item) => !args.tasks || args.tasks.includes(item.task.id))
    .filter((item) => !args.arms || args.arms.includes(item.armId))
    .filter((item) => !args.repetition || item.repetition === args.repetition);
  const runsDir = join(args.output, "runs"), artifacts = join(args.output, "artifacts");
  mkdirSync(runsDir, { recursive: true }); mkdirSync(artifacts, { recursive: true });
  for (const item of schedule) {
    const resultPath = join(runsDir, `${item.runId}.json`);
    if (existsSync(resultPath)) {
      const existing = JSON.parse(readFileSync(resultPath, "utf8"));
      if (!args.resume) throw new Error(`${item.runId} already exists; use --resume`);
      if (existing.valid) continue;
      renameSync(resultPath, join(runsDir, `${item.runId}.invalid-${Date.now()}.json.txt`));
    }
    const task = item.task, info = prepared.tasks[task.id], armSpec = armSpecFor(suite.arms[item.armId]);
    const pushLog = join(artifacts, `${item.runId}.push.jsonl`);
    const env = sessionEnv({ cliBin: args.cliBin, armSpec, pushLog });
    // <run>/<project name>: the folder name is the same in every arm and in the index template.
    const workspace = join(args.output, "ws", item.runId, projectNameOf(suite));
    removeWorkspace(args.subject, workspace, { removeParent: true });
    process.stderr.write(`[arm] ${item.runId}\n`);
    let row;
    try {
      const created = createWorkspace({ subjectRoot: args.subject, workspace, base: info.base, scaffoldCommit: armSpec.withMex ? info.scaffold : null, depsDir: args.deps, appendInstructions: suite.appendInstructions === true, basePatches: suite.basePatches ?? [], stripPrototype: armSpec.withHooks });
      const indexes = armSpec.withCli ? installIndexes({ workspace, cachePath: info.cachePath, cliBin: args.cliBin, env }) : null;
      if (armSpec.withHooks) {
        indexes.context = installContextIndex({ workspace, cachePath: info.cachePath });
        indexes.hooks = installProductHooks({ workspace, cliBin: args.cliBin, env });
      }
      if (armSpec.withPush) { if (existsSync(pushLog)) renameSync(pushLog, `${pushLog}.old-${Date.now()}`); indexes.push = preparePush(workspace, env); }
      const session = await runAgentSession({
        task: { ...task, hiddenTests: task.hiddenTests ? { ...task.hiddenTests, fromCommit: info.hiddenFrom, ...(suite.python ? { python: task.hiddenTests.python ?? suite.python } : {}) } : null },
        armId: item.armId, armSpec, workspace, env, cliBin: args.cliBin, model: args.model,
        timeoutMs: task.type === "change" ? args.timeoutChangeMs : args.timeoutQaMs,
        outputPrefix: join(artifacts, item.runId), claudeCommand: args.claude, mexPrompt: prepared.mexPrompt ?? "none", appendPrompt: suite.appendPrompt ?? null,
      });
      row = { runId: item.runId, taskId: task.id, taskType: task.type, arm: item.armId, repetition: item.repetition, orderIndex: item.orderIndex, indexKey: info.indexKey, workspaceHead: created.head, indexes, startedFrom: info.base, ...session, ...(armSpec.withPush ? { push: summarizePushLog(pushLog) } : {}) };
    } finally {
      if (row) writeJson(resultPath, row);
      try { removeWorkspace(args.subject, workspace, { removeParent: true }); } catch (error) { process.stderr.write(`[arm] cleanup of ${item.runId} failed, continuing: ${error.message}\n`); }
    }
    if (row.providerFailure?.type === "rate_limit") {
      throw new Error(`usage limit reached during ${item.runId}; rerun with --resume after it resets`);
    }
  }
  process.stdout.write(`ran ${schedule.length} scheduled session(s)\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === "refresh-context-index") return refreshContextIndexes(args);
  const suite = JSON.parse(readFileSync(args.suite, "utf8"));
  if (["prepare", "run"].includes(args.mode) && !args.deps && suite.requiresDeps !== false) throw new Error(`--deps is required for --${args.mode} (a suite without node_modules sets "requiresDeps": false)`);
  if (args.mode === "prepare") return prepare(args, suite);
  if (args.mode === "run") return run(args, suite);
  const prepared = JSON.parse(readFileSync(join(args.output, "prepare.json"), "utf8"));
  const salt = prepared.preparedAt;
  const rows = loadRows(args.output);
  if (args.mode === "blind") {
    const { review, reveal } = buildBlindReview(suite, rows, salt);
    writeJson(join(args.output, "blind-review.json"), review);
    writeJson(join(args.output, "blind-reveal.json"), reveal);
    return;
  }
  const gradesPath = join(args.output, "grades.json");
  const grades = existsSync(gradesPath) ? JSON.parse(readFileSync(gradesPath, "utf8")) : null;
  const baselines = JSON.parse(readFileSync(join(args.output, "baselines.json"), "utf8"));
  const report = generateReport({ suite, rows, grades, salt, baselines: Object.fromEntries(Object.entries(baselines).map(([key, value]) => [key, { grounding: (value.issues ?? []).filter((issue) => String(issue.code).startsWith("GROUNDING_")) }])) });
  writeFileSync(join(args.output, "report.md"), report);
  process.stdout.write(report);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
