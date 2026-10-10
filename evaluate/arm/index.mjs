#!/usr/bin/env node
// Agent-arm test: the same Claude Code sessions with and without MEX on a
// pinned subject. See evaluate/arm/README.md.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchedule } from "../compare/lib/schedule.mjs";
import { runSync } from "../compare/lib/process.mjs";
import { buildBlindReview, generateReport, loadRows } from "./lib/report.mjs";
import { MEX_PROMPTS, runAgentSession } from "./lib/session.mjs";
import { armPath, buildIndexCache, createWorkspace, git, installIndexes, mexEntrypoint, removeWorkspace, resolveCommit } from "./lib/workspace.mjs";

const fileSha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function parseArgs(argv) {
  const args = { mode: null, tasks: null, repetition: null, resume: false, timeoutQaMs: 900_000, timeoutChangeMs: 1_800_000, claude: ["claude"] };
  const value = (i) => { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--prepare", "--run", "--blind", "--report"].includes(arg)) args.mode = arg.slice(2);
    else if (arg === "--suite") args.suite = resolve(value(i++));
    else if (arg === "--subject") args.subject = resolve(value(i++));
    else if (arg === "--cli-bin") args.cliBin = resolve(value(i++));
    else if (arg === "--deps") args.deps = resolve(value(i++));
    else if (arg === "--output") args.output = resolve(value(i++));
    else if (arg === "--model") args.model = value(i++);
    else if (arg === "--tasks") args.tasks = value(i++).split(",").map((id) => id.trim());
    else if (arg === "--repetition") args.repetition = Number(value(i++));
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--timeout-qa-ms") args.timeoutQaMs = Number(value(i++));
    else if (arg === "--timeout-change-ms") args.timeoutChangeMs = Number(value(i++));
    else if (arg === "--fake-agent") args.claude = [process.execPath, resolve(value(i++))];
    else if (arg === "--mex-prompt") args.mexPrompt = value(i++);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.mexPrompt !== undefined && !MEX_PROMPTS.includes(args.mexPrompt)) throw new Error(`--mex-prompt must be one of ${MEX_PROMPTS.join(", ")}`);
  if (!args.mode) throw new Error("choose --prepare, --run, --blind or --report");
  for (const key of ["suite", "output"]) if (!args[key]) throw new Error(`--${key} is required`);
  if (["prepare", "run"].includes(args.mode)) {
    for (const key of ["subject", "cliBin", "deps", "model"]) if (!args[key]) throw new Error(`--${key === "cliBin" ? "cli-bin" : key} is required for --${args.mode}`);
  }
  return args;
}

// An arm may carry the scaffold without the CLI (Markdown only); `cli` defaults to `scaffold`.
export const armSpecFor = (arm) => ({ withMex: Boolean(arm.scaffold), withCli: Boolean(arm.scaffold) && arm.cli !== false });

const indexKey = (base, scaffold) => `${base.slice(0, 12)}-${scaffold.slice(0, 12)}`;

function prepare(args, suite) {
  mkdirSync(args.output, { recursive: true });
  const mexEnv = { ...process.env, PATH: armPath(process.env.PATH, { cliBin: args.cliBin, withMex: true }) };
  const scaffolds = Object.fromEntries(Object.entries(suite.scaffolds).map(([name, ref]) => [name, resolveCommit(args.subject, ref)]));
  const tasks = {};
  const baselines = {};
  // Graph and Wiki indexes only matter when some arm has the CLI.
  const needsIndexes = Object.values(suite.arms).some((arm) => armSpecFor(arm).withCli);
  for (const task of suite.tasks) {
    const base = resolveCommit(args.subject, task.base);
    const scaffold = scaffolds[task.scaffold];
    const key = indexKey(base, scaffold);
    const cachePath = !needsIndexes ? null : buildIndexCache({ subjectRoot: args.subject, cacheDir: join(args.output, "index-cache"), key, base, scaffoldCommit: scaffold, cliBin: args.cliBin, env: mexEnv, depsDir: args.deps });
    if (cachePath) baselines[key] = JSON.parse(readFileSync(join(cachePath, "check-baseline.json"), "utf8"));
    tasks[task.id] = { base, scaffold, indexKey: key, cachePath, hiddenFrom: task.hiddenTests?.fromCommit ? resolveCommit(args.subject, task.hiddenTests.fromCommit) : null };
  }
  const entry = mexEntrypoint(args.cliBin);
  const prepared = {
    schemaVersion: 1, suiteId: suite.id, suiteSha256: fileSha(args.suite), preparedAt: new Date().toISOString(),
    subject: { root: args.subject, scaffolds, autocrlf: git(args.subject, ["config", "--get", "core.autocrlf"], { allowFailure: true }).stdout.trim() || null },
    cli: { bin: args.cliBin, entrypoint: entry, sha256: fileSha(entry), version: runSync(process.execPath, [entry, "--version"]).stdout.trim() },
    deps: args.deps, indexedWithDeps: true, model: args.model, mexPrompt: args.mexPrompt ?? "none",
    agent: { claudeVersion: runSync("claude", ["--version"]).stdout.trim() },
    node: process.version, platform: `${process.platform}-${process.arch}`,
    tasks,
  };
  writeJson(join(args.output, "prepare.json"), prepared);
  writeJson(join(args.output, "baselines.json"), baselines);
  process.stdout.write(`prepared ${suite.tasks.length} tasks; index caches in ${join(args.output, "index-cache")}\n`);
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
    const env = { ...process.env, PATH: armPath(process.env.PATH, { cliBin: args.cliBin, withMex: armSpec.withCli }) };
    const workspace = join(args.output, "ws", item.runId);
    removeWorkspace(args.subject, workspace);
    process.stderr.write(`[arm] ${item.runId}\n`);
    let row;
    try {
      const created = createWorkspace({ subjectRoot: args.subject, workspace, base: info.base, scaffoldCommit: armSpec.withMex ? info.scaffold : null, depsDir: args.deps });
      const indexes = armSpec.withCli ? installIndexes({ workspace, cachePath: info.cachePath, cliBin: args.cliBin, env }) : null;
      const session = await runAgentSession({
        task: { ...task, hiddenTests: task.hiddenTests ? { ...task.hiddenTests, fromCommit: info.hiddenFrom } : null },
        armId: item.armId, armSpec, workspace, env, cliBin: args.cliBin, model: args.model,
        timeoutMs: task.type === "change" ? args.timeoutChangeMs : args.timeoutQaMs,
        outputPrefix: join(artifacts, item.runId), claudeCommand: args.claude, mexPrompt: prepared.mexPrompt ?? "none",
      });
      row = { runId: item.runId, taskId: task.id, taskType: task.type, arm: item.armId, repetition: item.repetition, orderIndex: item.orderIndex, indexKey: info.indexKey, workspaceHead: created.head, indexes, startedFrom: info.base, ...session };
    } finally {
      removeWorkspace(args.subject, workspace);
    }
    writeJson(resultPath, row);
    if (row.providerFailure?.type === "rate_limit") {
      throw new Error(`usage limit reached during ${item.runId}; rerun with --resume after it resets`);
    }
  }
  process.stdout.write(`ran ${schedule.length} scheduled session(s)\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const suite = JSON.parse(readFileSync(args.suite, "utf8"));
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
