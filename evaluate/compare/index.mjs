#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGraphOutputIsolation } from "../core/artifacts.mjs";
import { buildConfiguredArmArtifacts, prepareEvaluation, validateSubjectFixture } from "./lib/prepare.mjs";
import { generateReport } from "./lib/report.mjs";
import { runEvaluation } from "./lib/runner.mjs";
import { loadSuite, resolveArmCommands, resolveSelectedArmIds, suiteContext } from "./lib/suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..");

export function parseArgs(argv) {
  const args = { mode: null, repo: process.cwd(), model: null, agent: "claude", policy: "forced-first", repetitions: null, timeoutMs: 300_000, resume: false, armCli: {}, arms: null, noIndex: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--validate", "--prepare", "--run", "--report"].includes(arg)) {
      if (args.mode) throw new Error("choose exactly one of --validate, --prepare, --run, or --report");
      args.mode = arg.slice(2);
    } else if (arg === "--suite") args.suite = resolve(argv[++i]);
    else if (arg === "--repo") args.repo = resolve(argv[++i]);
    else if (arg === "--output") args.output = resolve(argv[++i]);
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--agent") args.agent = argv[++i];
    else if (arg === "--policy") args.policy = argv[++i];
    else if (arg === "--repetitions") args.repetitions = Number(argv[++i]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--no-index") args.noIndex = true;
    else if (arg === "--arms") {
      if (args.arms !== null) throw new Error("--arms may be specified only once");
      const value = argv[++i];
      if (typeof value !== "string" || value.trim() === "") throw new Error("--arms requires a comma-separated list of arm IDs");
      args.arms = value.split(",").map((id) => id.trim());
    }
    else if (arg === "--arm-cli") {
      const value = argv[++i] ?? "", split = value.indexOf("=");
      if (split < 1) throw new Error("--arm-cli must be id=/path/to/cli.js");
      args.armCli[value.slice(0, split)] = resolve(value.slice(split + 1));
    } else if (arg === "--baseline-cli") args.armCli.baseline = resolve(argv[++i]);
    else if (arg === "--patched-cli") args.armCli.patched = resolve(argv[++i]);
    else if (arg === "--claude") { args.agent = "claude"; args.agentCli = resolve(argv[++i]); }
    else if (arg === "--agent-cli") args.agentCli = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.mode) throw new Error("choose one of --validate, --prepare, --run, or --report");
  if (!args.suite) throw new Error("--suite <file> is required");
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  if (args.repetitions !== null && (!Number.isInteger(args.repetitions) || args.repetitions < 1)) throw new Error("--repetitions must be a positive integer");
  if (!["claude", "codex"].includes(args.agent)) throw new Error("--agent must be claude or codex");
  if (!["forced-first", "optional"].includes(args.policy)) throw new Error("--policy must be forced-first or optional");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const suite = loadSuite(args.suite);
  const selectedArmIds = resolveSelectedArmIds(suite, args.arms);
  const outputDir = args.output ?? join(HARNESS_ROOT, ".mex", "eval-results", "compare", suite.id);
  if (args.mode === "validate") {
    console.log(`valid suite: ${suite.id} (${suite.tasks.length} tasks, ${selectedArmIds.length} selected arms: ${selectedArmIds.join(", ")})`);
    return;
  }
  if (args.mode === "report") {
    const report = generateReport({ suite, outputDir, selectedArmIds: args.arms === null ? null : selectedArmIds });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!existsSync(args.repo)) throw new Error(`subject repository does not exist: ${args.repo}`);
  assertGraphOutputIsolation(args.repo, outputDir);
  const context = suiteContext(suite, HARNESS_ROOT, args.repo);
  if (args.mode === "prepare") {
    const subjectFixture = validateSubjectFixture(suite, args.repo);
    const artifacts = buildConfiguredArmArtifacts({
      suite, context, outputDir, overrides: args.armCli, selectedArmIds,
    });
    const armCommands = resolveArmCommands(suite, context, artifacts.overrides, selectedArmIds);
    const manifest = prepareEvaluation({
      suite,
      subjectRoot: args.repo,
      harnessRoot: HARNESS_ROOT,
      armCommands,
      outputDir,
      index: !args.noIndex,
      subjectFixture,
      artifactMetadata: artifacts.metadata,
      selectedArmIds,
    });
    console.log(`prepared ${suite.id} at ${outputDir} (${manifest.goldEvidence.length} tasks; no repository was cloned)`);
    return;
  }
  const existingOverrides = { ...args.armCli };
  for (const armId of selectedArmIds) {
    const arm = suite.arms[armId];
    if (!existingOverrides[armId] && arm.buildFromGit) {
      const artifactCli = join(outputDir, "artifacts", armId, arm.buildFromGit.cli);
      if (existsSync(artifactCli)) existingOverrides[armId] = artifactCli;
    }
  }
  const armCommands = resolveArmCommands(suite, context, existingOverrides, selectedArmIds);
  if (args.mode === "run") {
    if (!args.model) throw new Error("--run requires --model <name>");
    const agentCommand = args.agentCli ? [args.agentCli] : undefined;
    const result = await runEvaluation({
      suite, subjectRoot: args.repo, outputDir, armCommands, model: args.model,
      timeoutMs: args.timeoutMs, resume: args.resume, agentCommand,
      agentId: args.agent, policy: args.policy, repetitions: args.repetitions, selectedArmIds,
    });
    const report = generateReport({ suite, outputDir, rows: result.rows, selectedArmIds });
    console.log(JSON.stringify(report, null, 2));
    if (!report.executionValid) process.exitCode = 1;
    return;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[eval:compare] ${error.message}`); process.exitCode = 1; });
}
