import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { ANSWER_SCHEMA, MIN_SUBSTANTIVE_ANSWER_LENGTH, parseStructuredAnswer } from "../lib/answer.mjs";
import { guardBashInput } from "../lib/bash-guard.mjs";
import { parseArgs } from "../index.mjs";
import { buildPrompt } from "../lib/prompt.mjs";
import { validateTranscriptPolicy } from "../lib/policy.mjs";
import { prepareEvaluation } from "../lib/prepare.mjs";
import { aggregateReleaseReports, buildReleaseGate, generateReport, pairedDeltas } from "../lib/report.mjs";
import { buildBashGuardHook, claudeArgs, runEvaluation, runSession, toolPolicyForArm } from "../lib/runner.mjs";
import { buildSchedule, SIX_ARM_ORDERS, TWO_ARM_ORDERS } from "../lib/schedule.mjs";
import { loadSuite, resolveSelectedArmIds, validateSuite } from "../lib/suite.mjs";
import { parseTranscript } from "../lib/transcript.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-claude.mjs");
const FAKE_CODEX = join(HERE, "fixtures", "fake-codex.mjs");
const ARMS = {
  grep: { kind: "grep", role: "control" },
  baseline: { kind: "graph", role: "released" },
  patched: { kind: "graph", role: "patched" },
};
const COMMANDS = { baseline: ["node", "/tmp/baseline.js"], patched: ["node", "/tmp/patched.js"] };
const SUITES = {
  mex: join(HERE, "..", "suites", "mex-graph.json"),
  hono: join(HERE, "..", "suites", "hono.json"),
  typescript: join(HERE, "..", "suites", "typescript.json"),
};

test("six tasks use all six arm permutations exactly once", () => {
  const tasks = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}` }));
  const schedule = buildSchedule(tasks, Object.keys(ARMS));
  const orders = tasks.map((_, index) => schedule.slice(index * 3, index * 3 + 3).map((row) => Object.keys(ARMS).indexOf(row.armId)));
  assert.deepEqual(orders, SIX_ARM_ORDERS);
});

test("repetitions balance all arm orders without losing pair identity", () => {
  const tasks = [{ id: "a" }, { id: "b" }];
  const schedule = buildSchedule(tasks, Object.keys(ARMS), 3);
  assert.equal(schedule.length, 18);
  const orders = [];
  for (let index = 0; index < schedule.length; index += 3) orders.push(schedule.slice(index, index + 3).map((row) => row.armId).join(","));
  assert.equal(new Set(orders).size, 6);
  assert.deepEqual(schedule.slice(0, 9).map((row) => row.repetition), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
});

test("two-arm schedules alternate both orders and keep matched run identity", () => {
  const tasks = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}` }));
  const armIds = ["grep", "patched"];
  const schedule = buildSchedule(tasks, armIds);
  assert.equal(schedule.length, 12);
  const orders = tasks.map((_, index) => schedule.slice(index * 2, index * 2 + 2)
    .map((row) => armIds.indexOf(row.armId)));
  assert.deepEqual(orders, Array.from({ length: 6 }, (_, index) => TWO_ARM_ORDERS[index % 2]));
  assert.equal(orders.filter((order) => order[0] === 0).length, 3);
  assert.throws(() => buildSchedule(tasks, ["grep", "grep"]), /unique/);
});

test("--arms selects a canonical validated two-arm pilot", () => {
  const args = parseArgs(["--run", "--suite", SUITES.mex, "--model", "fake", "--arms", "candidate,files"]);
  assert.deepEqual(args.arms, ["candidate", "files"]);
  const suite = loadSuite(SUITES.mex);
  assert.deepEqual(resolveSelectedArmIds(suite, args.arms), ["files", "candidate"]);
  assert.throws(() => resolveSelectedArmIds(suite, ["files", "files"]), /duplicate/);
  assert.throws(() => resolveSelectedArmIds(suite, ["files", "missing"]), /unknown arm/);
  assert.throws(() => resolveSelectedArmIds(suite, ["main", "candidate"]), /control and patched/);
  assert.throws(() => parseArgs(["--run", "--suite", SUITES.mex, "--model", "fake", "--arms"]), /requires/);
});

test("stream JSON accounting sums assistant usage and deduplicates tool payloads", () => {
  const assistant = (id, usage, content = []) => JSON.stringify({ type: "assistant", message: { id, usage, content } });
  const tool = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "same" }] } });
  const result = JSON.stringify({ type: "result", structured_output: { answer: "S is declared in the cited source and implements the requested behavior.", symbols: ["S"], evidence: [{ path: "a", line: 1 }], complete: true }, usage: { input_tokens: 6, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 10 }, total_cost_usd: 0.25, num_turns: 2 });
  const parsed = parseTranscript([assistant("m1", { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }, [{ type: "tool_use", id: "x", name: "Read", input: { file_path: "a" } }]), tool, assistant("m2", { input_tokens: 5, output_tokens: 6 }), tool, result].join("\n"));
  assert.deepEqual({
    uncachedInput: parsed.usage.uncachedInput,
    cacheCreation: parsed.usage.cacheCreation,
    cacheRead: parsed.usage.cacheRead,
    output: parsed.usage.output,
    processed: parsed.usage.processed,
    accountingValid: parsed.usage.accountingValid,
  }, { uncachedInput: 6, cacheCreation: 2, cacheRead: 3, output: 10, processed: 21, accountingValid: true });
  assert.equal(parsed.uniqueToolResultChars, 4);
  assert.equal(parsed.costUsd, 0.25);
});

test("structured answers reject placeholders and too-short answers", () => {
  const base = { symbols: ["TargetSymbol"], evidence: [{ path: "src/target.ts", line: 1 }], complete: true };
  assert.equal(parseStructuredAnswer({ answer: "test", ...base }).ok, false);
  assert.equal(parseStructuredAnswer({ answer: "x".repeat(MIN_SUBSTANTIVE_ANSWER_LENGTH - 1), ...base }).ok, false);
});

test("structured answers require non-empty symbols and evidence", () => {
  const validAnswer = "TargetSymbol handles the requested behavior in the cited source file.";
  assert.equal(parseStructuredAnswer({ answer: validAnswer, evidence: [{ path: "src/target.ts", line: 1 }], complete: true }).ok, false);
  assert.equal(parseStructuredAnswer({ answer: validAnswer, symbols: [], evidence: [{ path: "src/target.ts", line: 1 }], complete: true }).ok, false);
  assert.equal(parseStructuredAnswer({ answer: validAnswer, symbols: ["TargetSymbol"], complete: true }).ok, false);
  assert.equal(parseStructuredAnswer({ answer: validAnswer, symbols: ["TargetSymbol"], evidence: [], complete: true }).ok, false);
});

test("structured answers accept a valid concise answer and reject malformed evidence", () => {
  const valid = {
    answer: "TargetSymbol handles the requested behavior in the cited source file.",
    symbols: ["TargetSymbol"],
    evidence: [{ path: "src/target.ts", line: 1 }],
    complete: true,
  };
  assert.deepEqual(parseStructuredAnswer(valid), { ok: true, value: valid });
  assert.equal(parseStructuredAnswer({ ...valid, evidence: [{ path: "src/target.ts", line: 0 }] }).ok, false);
});

test("policy rejects shell operators, SQLite, cross-arm binaries, and missing scope", () => {
  const bash = (command, output = null, status = "executed") => ({ name: "Bash", input: { command }, output, status });
  assert.match(validateTranscriptPolicy([bash('node /tmp/patched.js graph scope x && rg y')], "patched", ARMS.patched, COMMANDS).join("\n"), /control operator/);
  assert.match(validateTranscriptPolicy([{ name: "Read", input: { file_path: ".mex/graph.db" } }], "grep", ARMS.grep, COMMANDS).join("\n"), /SQLite/);
  assert.match(validateTranscriptPolicy([bash("sqlite3 .mex/graph.db 'select * from nodes'")], "grep", ARMS.grep, COMMANDS, { allowFileShell: true }).join("\n"), /SQLite/);
  assert.match(validateTranscriptPolicy([bash('node /tmp/baseline.js graph scope x')], "patched", ARMS.patched, COMMANDS).join("\n"), /cross-arm/);
  assert.match(validateTranscriptPolicy([
    bash("find /tmp -exec node /tmp/baseline.js graph scope x {} \\;"),
  ], "patched", ARMS.patched, COMMANDS, { allowFileShell: true }).join("\n"), /cross-arm/);
  assert.match(validateTranscriptPolicy([{ name: "Read", input: { file_path: "src/a.ts" } }], "patched", ARMS.patched, COMMANDS).join("\n"), /did not start/);
  assert.match(validateTranscriptPolicy([bash('node /tmp/patched.js graph vocab')], "patched", ARMS.patched, COMMANDS).join("\n"), /disallowed graph command/);
});

test("policy ignores graph database prose in final structured answers", () => {
  const answer = {
    name: "StructuredOutput",
    input: { answer: "The index is stored in .mex/graph.db; do not query it with sqlite3." },
    status: "executed",
  };
  assert.deepEqual(validateTranscriptPolicy([answer], "grep", ARMS.grep, COMMANDS), []);
  assert.match(validateTranscriptPolicy([
    { name: "Read", input: { file_path: ".mex/graph.db" }, status: "executed" },
  ], "grep", ARMS.grep, COMMANDS).join("\n"), /raw SQLite access through Read/);
});

test("policy permits single read-only file commands without permitting shell composition", () => {
  const bash = (command) => ({ name: "Bash", input: { command }, output: "", status: "executed" });
  const calls = [
    bash('node /tmp/baseline.js graph scope "question"'),
    bash("pwd"),
    bash("ls /repo/src"),
    bash('grep -n "first\\|second" /repo/src/a.ts'),
  ];
  assert.deepEqual(validateTranscriptPolicy(calls, "baseline", ARMS.baseline, COMMANDS, { allowFileShell: true }), []);
  assert.match(validateTranscriptPolicy([
    bash('node /tmp/baseline.js graph scope "question"'),
    bash("grep -n value /repo/src/a.ts | head -10"),
  ], "baseline", ARMS.baseline, COMMANDS, { allowFileShell: true }).join("\n"), /shell control operator/);
});

test("candidate graph follow-ups require an executed non-ok Scope with an appropriate status", () => {
  const bash = (command, status, execution = "executed") => ({
    name: "Bash", input: { command }, status: execution,
    output: status === null ? '{"type":"summary"}\n' : `{"type":"summary","status":"${status}"}\n`,
  });
  for (const status of ["partial", "degraded", "no-match"]) {
    const calls = [bash('node /tmp/patched.js graph scope "question"', status), bash("node /tmp/patched.js graph query symbol Target", null)];
    assert.equal(validateTranscriptPolicy(calls, "patched", ARMS.patched, COMMANDS).some((entry) => entry.includes("graph query requires")), false, status);
  }
  for (const status of ["partial", "degraded"]) {
    const calls = [bash('node /tmp/patched.js graph scope "question"', status), bash("node /tmp/patched.js graph get node:target", null)];
    assert.equal(validateTranscriptPolicy(calls, "patched", ARMS.patched, COMMANDS).some((entry) => entry.includes("graph get requires")), false, status);
  }
  for (const [command, status, execution] of [
    ["graph query symbol Target", "ok", "executed"],
    ["graph query symbol Target", null, "executed"],
    ["graph query symbol Target", "partial", "error"],
    ["graph get node:target", "no-match", "executed"],
  ]) {
    const calls = [bash('node /tmp/patched.js graph scope "question"', status, execution), bash(`node /tmp/patched.js ${command}`, null)];
    assert.match(validateTranscriptPolicy(calls, "patched", ARMS.patched, COMMANDS).join("\n"), /requires a preceding scope summary/);
  }
  const released = [bash('node /tmp/baseline.js graph scope "question"', null), bash("node /tmp/baseline.js graph get node:target", null)];
  assert.equal(validateTranscriptPolicy(released, "baseline", ARMS.baseline, COMMANDS).some((entry) => entry.includes("requires a preceding")), false);

  const nonTerminalSummary = [{
    name: "Bash", status: "executed", input: { command: 'node /tmp/patched.js graph scope "question"' },
    output: '{"type":"summary","status":"partial"}\n{"type":"fact"}\n',
  }, bash("node /tmp/patched.js graph query symbol Target", null)];
  assert.match(validateTranscriptPolicy(nonTerminalSummary, "patched", ARMS.patched, COMMANDS).join("\n"), /got missing/);
});

test("candidate policy permits one normalized Scope query and rejects a second distinct request", () => {
  const scope = (question) => ({
    name: "Bash", status: "executed", input: { command: `node /tmp/patched.js graph scope "${question}"` },
    output: '{"type":"summary","status":"ok"}\n',
  });
  assert.equal(validateTranscriptPolicy([scope("Same Question"), scope("same   question")], "patched", ARMS.patched, COMMANDS).some((entry) => entry.includes("distinct graph scope")), false);
  assert.match(validateTranscriptPolicy([scope("first"), scope("second")], "patched", ARMS.patched, COMMANDS).join("\n"), /maximum is 1/);
});

test("candidate prompt exposes one-Scope and status-gated follow-ups without vocabulary retry guidance", () => {
  const prompt = buildPrompt({ question: "Where?" }, "patched", ARMS.patched, COMMANDS.patched, "/repo");
  assert.match(prompt, /only one distinct Scope/);
  assert.match(prompt, /partial, degraded, or no-match/);
  assert.doesNotMatch(prompt, /vocab|VOCABULARY|1-12 project terms/i);
  const released = buildPrompt({ question: "Where?" }, "baseline", ARMS.baseline, COMMANDS.baseline, "/repo");
  assert.doesNotMatch(released, /summary status|only one distinct Scope/);
});

test("answer contract requires exact source declaration names rather than graph node IDs", () => {
  const prompt = buildPrompt({ question: "Where?" }, "patched", ARMS.patched, COMMANDS.patched, "/repo");
  assert.match(prompt, /exact source declaration names/i);
  assert.match(prompt, /never graph node IDs/i);
  assert.match(ANSWER_SCHEMA.properties.symbols.description, /exact source declaration names/i);
  assert.match(ANSWER_SCHEMA.properties.symbols.description, /never graph node IDs/i);
});

test("answer contract requires substantive output and every non-empty field", () => {
  const prompt = buildPrompt({ question: "Where?" }, "patched", ARMS.patched, COMMANDS.patched, "/repo");
  assert.equal(ANSWER_SCHEMA.properties.answer.minLength, MIN_SUBSTANTIVE_ANSWER_LENGTH);
  assert.equal(ANSWER_SCHEMA.properties.symbols.minItems, 1);
  assert.equal(ANSWER_SCHEMA.properties.evidence.minItems, 1);
  for (const key of ANSWER_SCHEMA.required) assert.match(ANSWER_SCHEMA.properties[key].description, /required/i);
  assert.match(prompt, /all four required root keys: answer, symbols, evidence, and complete/i);
  assert.match(prompt, /substantive, source-grounded explanation/i);
  assert.match(prompt, /never return a placeholder/i);
  assert.match(prompt, /symbols and evidence fields must each be non-empty arrays/i);
});

test("Claude arm capabilities keep file tools equal and narrowly allow only the graph wrapper", () => {
  const files = toolPolicyForArm(ARMS.grep, []);
  const graph = toolPolicyForArm(ARMS.patched, COMMANDS.patched);
  assert.equal(files.tools, "Read,Grep,Glob");
  assert.deepEqual(files.allowed, ["Read", "Grep", "Glob"]);
  assert.equal(graph.tools, "Read,Grep,Glob,Bash");
  assert.deepEqual(graph.allowed.slice(0, 3), files.allowed);
  assert.deepEqual(graph.allowed.slice(3), [
    "Bash(node /tmp/patched.js graph scope *)",
    "Bash(node /tmp/patched.js graph query *)",
    "Bash(node /tmp/patched.js graph get *)",
    "Bash(node /tmp/patched.js impact *)",
  ]);
  assert.equal(graph.allowed.includes("Bash"), false);

  const args = claudeArgs({
    prompt: "p", model: "m", arm: ARMS.patched, command: COMMANDS.patched,
    settingsPath: "/tmp/claude-settings.json",
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.equal(args[args.indexOf("--settings") + 1], "/tmp/claude-settings.json");
  assert.equal(args.includes("--include-hook-events"), true);
  assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1), graph.allowed);
});

test("Claude Bash guard admits only direct fixed-wrapper graph operations", () => {
  const input = (command, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, ...extra } });
  assert.equal(guardBashInput(input('node /tmp/patched.js graph scope "question"'), COMMANDS.patched).allowed, true);
  assert.equal(guardBashInput(input("node /tmp/patched.js graph get function:abc"), COMMANDS.patched).allowed, true);
  assert.equal(guardBashInput(input("node /tmp/patched.js impact function:abc"), COMMANDS.patched).allowed, true);
  for (const command of [
    'cd /repo && grep -R "Target" src | head -20',
    'node /tmp/patched.js graph scope "question" && grep Target src/a.ts',
    "node /tmp/patched.js graph vocab",
    "bash -lc 'node /tmp/patched.js graph scope question'",
  ]) {
    const decision = guardBashInput(input(command), COMMANDS.patched);
    assert.equal(decision.allowed, false, command);
    assert.ok(decision.violations.length > 0, command);
  }
  for (const forbidden of [
    { run_in_background: true },
    { run_in_background: false },
    { dangerouslyDisableSandbox: true },
    { bypassPermissions: true },
    { sandbox: false },
  ]) {
    const decision = guardBashInput(input('node /tmp/patched.js graph scope "question"', forbidden), COMMANDS.patched);
    assert.equal(decision.allowed, false, JSON.stringify(forbidden));
    assert.match(decision.violations.join("\n"), /forbidden Bash input field/);
  }
  assert.equal(guardBashInput({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/repo/src/a.ts" } }, COMMANDS.patched).allowed, false);
});

test("Claude Bash guard launcher maps guard startup failures to blocking exit 2", () => {
  const hook = buildBashGuardHook({
    nodePath: process.execPath,
    guardPath: "/definitely/missing/mex-bash-guard.mjs",
    configPath: "/definitely/missing/mex-bash-guard.json",
  });
  assert.equal(hook.command, "/bin/sh");
  assert.equal(Array.isArray(hook.args), true);
  const result = spawnSync(hook.command, hook.args, {
    input: `${JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } })}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MEX_EVAL_BASH_DENIED/);
});

test("comparison suites configure repetitions and reject obsolete vocabulary retry options", () => {
  const suites = Object.fromEntries(Object.entries(SUITES).map(([id, path]) => [id, loadSuite(path)]));
  assert.deepEqual(Object.fromEntries(Object.entries(suites).map(([id, suite]) => [id, suite.requiredRepetitions])), {
    mex: 3, hono: 3, typescript: 1,
  });
  for (const suite of Object.values(suites)) {
    for (const arm of Object.values(suite.arms)) assert.equal(Object.hasOwn(arm, "vocabRetry"), false);
    assert.deepEqual(Object.values(suite.arms).map((arm) => arm.role).sort(), ["control", "patched", "released"]);
  }
  const obsolete = JSON.parse(readFileSync(SUITES.typescript, "utf8"));
  obsolete.arms.patched.vocabRetry = true;
  assert.throws(() => validateSuite(obsolete), /obsolete/);

  const missingRole = JSON.parse(readFileSync(SUITES.typescript, "utf8"));
  delete missingRole.arms.patched.role;
  assert.throws(() => validateSuite(missingRole), /role must be a non-empty string/);

  const duplicateRole = JSON.parse(readFileSync(SUITES.typescript, "utf8"));
  duplicateRole.arms.patched.role = "released";
  assert.throws(() => validateSuite(duplicateRole), /exactly one released role/);

  const misleadingScopeLimit = JSON.parse(readFileSync(SUITES.typescript, "utf8"));
  misleadingScopeLimit.releaseGates.maxDistinctScopeQueries = 2;
  assert.throws(() => validateSuite(misleadingScopeLimit), /must be exactly 1/);
});

test("paired deltas are matched within each task", () => {
  const row = (taskId, arm, processed) => ({ taskId, arm, metrics: { processed, costUsd: 0, uniqueToolResultChars: 0, uniqueToolResultTokens: 0, elapsedMs: 0, turns: 0, toolCalls: 0, graphCalls: 0, fallbacks: 0 } });
  const pairs = pairedDeltas([row("a", "grep", 10), row("a", "baseline", 7), row("b", "grep", 100), row("b", "baseline", 90)], ["grep", "baseline"]);
  assert.deepEqual(pairs[0].perTask.map((entry) => entry.processed), [-3, -10]);
  assert.equal(pairs[0].mean.processed, -6.5);
});

test("paired token accounting keeps cache reads separate from new-token deltas", () => {
  const metrics = (newTokens, cacheRead) => ({ newTokens, cacheRead });
  const rows = [
    { taskId: "a", repetition: 1, arm: "grep", valid: true, metrics: metrics(100, 500) },
    { taskId: "a", repetition: 1, arm: "baseline", valid: true, metrics: metrics(70, 900) },
  ];
  const pair = pairedDeltas(rows, ["grep", "baseline"])[0];
  assert.equal(pair.mean.newTokens, -30);
  assert.equal(pair.mean.cacheRead, 400);
});

test("paired token decisions exclude mismatched usage while retaining non-token deltas", () => {
  const rows = [
    { taskId: "a", repetition: 1, arm: "grep", valid: true, metrics: { tokenAccountingValid: true, newTokens: 100, cacheRead: 500, costUsd: 1, fallbacks: 2 } },
    { taskId: "a", repetition: 1, arm: "baseline", valid: true, metrics: { tokenAccountingValid: false, newTokens: 10, cacheRead: 900, costUsd: 0.1, fallbacks: 0 } },
  ];
  const pair = pairedDeltas(rows, ["grep", "baseline"])[0];
  assert.equal(pair.mean.newTokens, null);
  assert.equal(pair.mean.cacheRead, null);
  assert.equal(pair.mean.costUsd, null);
  assert.equal(pair.mean.fallbacks, -2);
  assert.equal(pair.tokenEligiblePairs, 0);
  assert.equal(pair.costEligiblePairs, 0);
});

test("paired deltas report task-macro percentage changes and a task-level bootstrap interval", () => {
  const rows = [
    { taskId: "a", arm: "files", valid: true, metrics: { tokenAccountingValid: true, newTokens: 100 } },
    { taskId: "a", arm: "candidate", valid: true, metrics: { tokenAccountingValid: true, newTokens: 60 } },
    { taskId: "b", arm: "files", valid: true, metrics: { tokenAccountingValid: true, newTokens: 200 } },
    { taskId: "b", arm: "candidate", valid: true, metrics: { tokenAccountingValid: true, newTokens: 100 } },
  ];
  const pair = pairedDeltas(rows, ["files", "candidate"])[0];
  assert.deepEqual(pair.perTask.map((entry) => entry.percentChange.newTokens), [-40, -50]);
  assert.equal(pair.percentChange.macroMedian.newTokens, -45);
  assert.equal(pair.percentChange.confidence95.newTokens.tasks, 2);
  assert.ok(pair.percentChange.confidence95.newTokens.high < 0);
});

function gateRows(candidateMetrics = {}) {
  const rows = [];
  for (const taskId of ["a", "b"]) {
    rows.push({ taskId, arm: "files", valid: true, metrics: { tokenAccountingValid: true, newTokens: 100, processed: 200, costUsd: 1, fallbacks: 0 } });
    rows.push({ taskId, arm: "main", valid: true, metrics: { tokenAccountingValid: true, newTokens: 90, processed: 220, costUsd: 1.1, fallbacks: 5 } });
    rows.push({ taskId, arm: "candidate", valid: true, metrics: {
      tokenAccountingValid: true, newTokens: 60, processed: 190, costUsd: 0.9, fallbacks: 2, ...candidateMetrics,
    } });
  }
  return rows;
}

function releaseGate(rows, finalCorrectness = { files: 2, main: 2, candidate: 2 }, pilotValid = true) {
  return buildReleaseGate({
    candidateVsFiles: pairedDeltas(rows, ["files", "candidate"])[0],
    rows,
    releasedId: "main",
    candidateId: "candidate",
    controlIds: ["files", "main"],
    finalCorrectness,
    pilotValid,
  });
}

function configuredGateRows(suite) {
  const armByRole = Object.fromEntries(Object.entries(suite.arms).map(([id, arm]) => [arm.role, id]));
  const rows = [];
  for (const task of suite.tasks) {
    const requiredFiles = [...new Set((task.gold ?? []).map((entry) => entry.path))];
    for (let repetition = 1; repetition <= suite.requiredRepetitions; repetition++) {
      rows.push({ taskId: task.id, repetition, arm: armByRole.control, valid: true, metrics: {
        tokenAccountingValid: true, newTokens: 100, processed: 200, costUsd: 1, fallbacks: 0,
      } });
      rows.push({ taskId: task.id, repetition, arm: armByRole.released, valid: true, metrics: {
        tokenAccountingValid: true, newTokens: 90, processed: 220, costUsd: 1.1, fallbacks: 5,
      } });
      rows.push({ taskId: task.id, repetition, arm: armByRole.patched, valid: true, metrics: {
        tokenAccountingValid: true, newTokens: 60, processed: 190, costUsd: 0.9, fallbacks: 2,
        distinctScopeQueries: 1, firstResponseFileHitAt5: true, firstResponseSourceSpanRecall: 0.8,
        firstResponseReturnedFiles: requiredFiles,
      } });
    }
  }
  return rows;
}

function configuredReleaseGate(suite, rows) {
  const idByRole = Object.fromEntries(Object.entries(suite.arms).map(([id, arm]) => [arm.role, id]));
  const expectedCorrect = suite.tasks.length * suite.requiredRepetitions;
  return buildReleaseGate({
    candidateVsFiles: pairedDeltas(rows, [idByRole.control, idByRole.patched])[0],
    rows,
    releasedId: idByRole.released,
    candidateId: idByRole.patched,
    controlIds: [idByRole.control, idByRole.released],
    finalCorrectness: Object.fromEntries(Object.values(idByRole).map((id) => [id, expectedCorrect])),
    pilotValid: true,
    suite,
  });
}

test("hard release gate enforces token, processed, cost, fallback, and correctness thresholds", () => {
  const passing = releaseGate(gateRows());
  assert.equal(passing.status, "pass");
  assert.equal(passing.passed, true);
  assert.equal(passing.criteria.newTokensVsFiles.observedPercent, -40);
  assert.ok(passing.criteria.newTokensVsFiles.bootstrapMean95Percent.high < 0);
  assert.equal(passing.criteria.fallbacksVsReleased.observedReductionPercent, 60);

  const failing = releaseGate(
    gateRows({ newTokens: 71, processed: 201, costUsd: 1.01, fallbacks: 3 }),
    { files: 2, main: 2, candidate: 1 },
  );
  assert.equal(failing.status, "fail");
  assert.equal(failing.passed, false);
  assert.deepEqual(failing.failures, [
    "newTokensVsFiles", "processedTokensVsFiles", "costVsFiles", "fallbacksVsReleased", "correctnessVsControls",
  ]);
});

test("two-arm gate evaluates candidate versus files without an absent released arm", () => {
  const rows = gateRows().filter((row) => row.arm !== "main");
  const suite = {
    requiredRepetitions: 1,
    arms: {
      files: { kind: "grep", role: "control" },
      main: { kind: "graph", role: "released" },
      candidate: { kind: "graph", role: "patched" },
    },
    tasks: [{ id: "a" }, { id: "b" }],
  };
  const gate = buildReleaseGate({
    candidateVsFiles: pairedDeltas(rows, ["files", "candidate"])[0],
    rows,
    releasedId: null,
    candidateId: "candidate",
    controlIds: ["files"],
    finalCorrectness: { files: 2, candidate: 2 },
    pilotValid: true,
    suite,
    selectedArmIds: ["files", "candidate"],
  });
  assert.equal(gate.kind, "candidate-vs-files-gate");
  assert.equal(gate.passed, true);
  assert.equal(Object.hasOwn(gate.criteria, "fallbacksVsReleased"), false);
  assert.deepEqual(gate.criteria.correctnessVsControls.controls, { files: 2 });
  assert.equal(gate.criteria.repetitions.expectedRuns, 4);
  assert.equal(gate.criteria.repetitions.actualRuns, 4);
});

test("hard release gate rejects a 30% macro token win when its bootstrap interval crosses zero", () => {
  const rows = [];
  for (const [taskId, newTokens] of [["a", 20], ["b", 60], ["c", 200]]) {
    rows.push({ taskId, arm: "files", valid: true, metrics: { tokenAccountingValid: true, newTokens: 100, processed: 200, costUsd: 1, fallbacks: 0 } });
    rows.push({ taskId, arm: "main", valid: true, metrics: { tokenAccountingValid: true, newTokens: 90, processed: 220, costUsd: 1.1, fallbacks: 5 } });
    rows.push({ taskId, arm: "candidate", valid: true, metrics: { tokenAccountingValid: true, newTokens, processed: 190, costUsd: 0.9, fallbacks: 2 } });
  }
  const gate = releaseGate(rows, { files: 3, main: 3, candidate: 3 });
  assert.equal(gate.criteria.newTokensVsFiles.observedPercent, -40);
  assert.ok(gate.criteria.newTokensVsFiles.bootstrapMean95Percent.high > 0);
  assert.equal(gate.criteria.newTokensVsFiles.passed, false);
  assert.equal(gate.passed, false);
});

test("processed and cost guards reject aggregate regressions hidden by a favorable task median", () => {
  const rows = [];
  for (const [taskId, processed, costUsd] of [["a", 190, 0.9], ["b", 190, 0.9], ["c", 500, 4]]) {
    rows.push({ taskId, arm: "files", valid: true, metrics: { tokenAccountingValid: true, newTokens: 100, processed: 200, costUsd: 1, fallbacks: 0 } });
    rows.push({ taskId, arm: "main", valid: true, metrics: { tokenAccountingValid: true, newTokens: 90, processed: 220, costUsd: 1.1, fallbacks: 5 } });
    rows.push({ taskId, arm: "candidate", valid: true, metrics: { tokenAccountingValid: true, newTokens: 60, processed, costUsd, fallbacks: 2 } });
  }
  const gate = releaseGate(rows, { files: 3, main: 3, candidate: 3 });
  assert.equal(gate.criteria.processedTokensVsFiles.observedMacroMedianDelta, -10);
  assert.ok(gate.criteria.processedTokensVsFiles.observedMeanDelta > 0);
  assert.equal(gate.criteria.processedTokensVsFiles.passed, false);
  assert.equal(gate.criteria.costVsFiles.observedMacroMedianDelta, -0.1);
  assert.ok(gate.criteria.costVsFiles.observedMeanDelta > 0);
  assert.equal(gate.criteria.costVsFiles.passed, false);
});

test("hard release gate returns stable insufficient-sample nulls", () => {
  const rows = gateRows().filter((row) => row.taskId === "a");
  const gate = releaseGate(rows);
  assert.equal(gate.status, "insufficient-sample");
  assert.equal(gate.passed, null);
  assert.equal(gate.criteria.newTokensVsFiles.observedPercent, null);
  assert.deepEqual(gate.criteria.newTokensVsFiles.bootstrapMean95Percent, { low: null, high: null, samples: 0 });
  assert.equal(gate.criteria.costVsFiles.observedDelta, null);
  assert.equal(gate.criteria.fallbacksVsReleased.observedReductionPercent, null);
});

test("Hono hard gates require configured repetitions and first-Scope retrieval quality", () => {
  const suite = loadSuite(SUITES.hono);
  const rows = configuredGateRows(suite);
  const passing = configuredReleaseGate(suite, rows);
  assert.equal(suite.tasks.length, 6);
  assert.equal(passing.status, "pass");
  assert.deepEqual(passing.criteria.repetitions.observed, [1, 2, 3]);
  assert.equal(passing.criteria.repetitions.expectedRuns, 54);
  assert.equal(passing.criteria.candidateDistinctScopes.observedMaximum, 1);
  assert.equal(passing.criteria.firstResponseFileHitAt5.observed, 1);
  assert.equal(passing.criteria.firstResponseSourceSpanRecall.observed, 0.8);
  assert.equal(passing.criteria.allRequiredFilesInFirstScope.requiredTasks, 6);
  assert.equal(passing.criteria.allRequiredFilesInFirstScope.expectedSamples, 18);

  const retrievalFailureRows = structuredClone(rows);
  const candidates = retrievalFailureRows.filter((row) => row.arm === "candidate");
  candidates[0].metrics.distinctScopeQueries = 2;
  candidates[0].metrics.firstResponseSourceSpanRecall = 0;
  candidates[0].metrics.firstResponseReturnedFiles = [];
  candidates[1].metrics.firstResponseFileHitAt5 = false;
  candidates[2].metrics.firstResponseFileHitAt5 = false;
  const failing = configuredReleaseGate(suite, retrievalFailureRows);
  assert.equal(failing.criteria.candidateDistinctScopes.passed, false);
  assert.equal(failing.criteria.firstResponseFileHitAt5.observed, 0.8889);
  assert.equal(failing.criteria.firstResponseFileHitAt5.passed, false);
  assert.equal(failing.criteria.firstResponseSourceSpanRecall.passed, false);
  assert.equal(failing.criteria.allRequiredFilesInFirstScope.passed, false);
  assert.deepEqual(failing.criteria.allRequiredFilesInFirstScope.failures[0], {
    taskId: suite.tasks[0].id,
    repetition: 1,
    missingFiles: [...new Set(suite.tasks[0].gold.map((entry) => entry.path))],
  });
  assert.equal(failing.status, "fail");
});

test("configured retrieval gates use stable insufficient-sample nulls", () => {
  const suite = loadSuite(SUITES.hono);
  const rows = configuredGateRows(suite);
  rows.splice(rows.findIndex((row) => row.arm === "candidate"), 1);
  const gate = configuredReleaseGate(suite, rows);
  for (const name of [
    "repetitions", "candidateDistinctScopes", "firstResponseFileHitAt5",
    "firstResponseSourceSpanRecall", "allRequiredFilesInFirstScope",
  ]) {
    assert.equal(gate.criteria[name].status, "insufficient-sample", name);
    assert.equal(gate.criteria[name].passed, null, name);
  }
  assert.equal(gate.status, "insufficient-sample");
  assert.equal(gate.passed, null);
});

test("multi-suite release aggregation enforces MEX, Hono, and TypeScript repetition contracts", () => {
  const suites = Object.values(SUITES).map(loadSuite);
  const passingReport = (suite) => ({
    suiteId: suite.id,
    requiredRepetitions: suite.requiredRepetitions,
    gate: {
      status: "pass",
      passed: true,
      criteria: { repetitions: {
        required: suite.requiredRepetitions,
        observed: Array.from({ length: suite.requiredRepetitions }, (_, index) => index + 1),
        passed: true,
      } },
    },
  });
  const entries = suites.map((suite) => ({ suite, report: passingReport(suite) }));
  const passing = aggregateReleaseReports(entries);
  assert.equal(passing.status, "pass");
  assert.deepEqual(Object.fromEntries(Object.entries(passing.criteria).map(([id, criterion]) => [id, criterion.requiredRepetitions])), {
    "mex-graph-agent-pilot": 3,
    "hono-graph-agent-pilot": 3,
    "typescript-pinned-pilot": 1,
  });

  const missing = aggregateReleaseReports(entries.map((entry, index) => index === 1 ? { suite: entry.suite, report: null } : entry));
  assert.equal(missing.status, "insufficient-sample");
  assert.deepEqual(missing.insufficient, ["hono-graph-agent-pilot"]);

  const wrongCount = structuredClone(entries);
  wrongCount[0].report.requiredRepetitions = 2;
  const failing = aggregateReleaseReports(wrongCount);
  assert.equal(failing.status, "fail");
  assert.deepEqual(failing.failures, ["mex-graph-agent-pilot"]);

  const incompleteMetadata = structuredClone(entries);
  delete incompleteMetadata[2].report.gate.criteria.repetitions.observed;
  const insufficient = aggregateReleaseReports(incompleteMetadata);
  assert.equal(insufficient.status, "insufficient-sample");
  assert.deepEqual(insufficient.insufficient, ["typescript-pinned-pilot"]);
});

test("report fails execution closed without a manifest while keeping role-oriented deltas descriptive", () => {
  const output = mkdtempSync(join(tmpdir(), "mex-role-gate-"));
  const suite = {
    id: "role-gate",
    arms: {
      candidate: { kind: "graph", role: "patched" },
      main: { kind: "graph", role: "released" },
      files: { kind: "grep", role: "control" },
    },
    tasks: [{ id: "a" }, { id: "b" }],
  };
  const rows = gateRows().map((row, index) => ({
    ...row,
    runId: `run-${index}`,
    grade: { correct: true },
    answer: { complete: true },
  }));
  const report = generateReport({ suite, outputDir: output, rows });
  assert.equal(report.executionValid, false);
  assert.deepEqual([report.primaryPair.from, report.primaryPair.to], ["files", "candidate"]);
  assert.deepEqual([report.releasedPair.from, report.releasedPair.to], ["main", "candidate"]);
  assert.equal(report.gate.criteria.newTokensVsFiles.status, "pass");
  assert.equal(report.gate.criteria.correctnessVsControls.status, "insufficient-sample");
  assert.equal(report.gate.passed, null);
  assert.equal(report.decision.releasedComparisonDescriptive, true);
});

test("report derives two-arm execution and candidate gate from the run manifest", () => {
  const output = mkdtempSync(join(tmpdir(), "mex-two-arm-report-"));
  const suite = {
    id: "two-arm-report",
    requiredRepetitions: 3,
    arms: {
      files: { kind: "grep", role: "control" },
      main: { kind: "graph", role: "released" },
      candidate: { kind: "graph", role: "patched" },
    },
    tasks: [{ id: "a" }, { id: "b" }],
  };
  const runIdentity = "two-arm-run";
  const rows = gateRows().filter((row) => row.arm !== "main").map((row, index) => ({
    ...row,
    runIdentity,
    runId: `run-${index}`,
    repetition: 1,
    grade: { correct: true },
    answer: { answer: "x", symbols: ["x"], evidence: [], complete: true },
  }));
  const manifest = {
    schemaVersion: 3,
    runIdentity,
    status: "complete",
    selectedArmIds: ["files", "candidate"],
    repetitions: 1,
    schedule: rows.map((row) => ({ runId: row.runId, armId: row.arm })),
  };
  writeFileSync(join(output, "run-manifest.json"), JSON.stringify(manifest));
  const report = generateReport({ suite, outputDir: output, rows });
  assert.equal(report.executionValid, true);
  assert.equal(report.runCount, 4);
  assert.equal(report.expectedRunCount, 4);
  assert.equal(report.requiredRepetitions, 3);
  assert.equal(report.runRepetitions, 1);
  assert.deepEqual(report.selectedArmIds, ["files", "candidate"]);
  assert.deepEqual(Object.keys(report.byArm), ["files", "candidate"]);
  assert.deepEqual([report.primaryPair.from, report.primaryPair.to], ["files", "candidate"]);
  assert.equal(report.releasedPair, null);
  assert.equal(report.gate.kind, "candidate-vs-files-gate");
  assert.equal(report.gate.criteria.repetitions.required, 1);
  assert.equal(report.gate.criteria.repetitions.expectedRuns, 4);
  assert.equal(Object.hasOwn(report.gate.criteria, "fallbacksVsReleased"), false);
  assert.deepEqual(Object.keys(report.finalCorrectness), ["files", "candidate"]);
  assert.equal(report.decision.descriptivePilotOnly, true);
  assert.equal(report.decision.releasedComparisonDescriptive, false);
  for (const status of ["running", "aborted"]) {
    writeFileSync(join(output, "run-manifest.json"), JSON.stringify({ ...manifest, status }));
    assert.equal(generateReport({ suite, outputDir: output, rows }).executionValid, false, status);
  }
  writeFileSync(join(output, "run-manifest.json"), JSON.stringify(manifest));
  assert.throws(() => generateReport({
    suite, outputDir: output, rows, selectedArmIds: ["files", "main", "candidate"],
  }), /does not match the run manifest/);
});

test("fake agent exercises success, failure, and timeout without model usage", { concurrency: false }, async () => {
  const task = { id: "fake", question: "Where?", expectedSymbols: ["FakeSymbol"] };
  const original = process.env.FAKE_CLAUDE_MODE;
  try {
    process.env.FAKE_CLAUDE_MODE = "ok";
    const success = await runSession({ agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task, armId: "patched", arm: ARMS.patched, armCommands: COMMANDS, timeoutMs: 2_000 });
    assert.equal(success.valid, true); assert.equal(success.metrics.processed, 50); assert.equal(success.grade.correct, true);
    process.env.FAKE_CLAUDE_MODE = "failure";
    const failure = await runSession({ agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task, armId: "grep", arm: ARMS.grep, armCommands: COMMANDS, timeoutMs: 2_000 });
    assert.equal(failure.valid, false); assert.match(failure.violations.join("\n"), /exited 7/);
    process.env.FAKE_CLAUDE_MODE = "timeout";
    const timeout = await runSession({ agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task, armId: "grep", arm: ARMS.grep, armCommands: COMMANDS, timeoutMs: 30 });
    assert.equal(timeout.process.timedOut, true);
  } finally {
    if (original === undefined) delete process.env.FAKE_CLAUDE_MODE; else process.env.FAKE_CLAUDE_MODE = original;
  }
});

test("Claude classifies rejected 429 limits as retryable without misclassifying warnings or schema errors", { concurrency: false }, async () => {
  const task = { id: "fake", question: "Where?", expectedSymbols: ["FakeSymbol"] };
  const originalMode = process.env.FAKE_CLAUDE_MODE;
  const originalQuestion = process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION;
  try {
    delete process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION;
    process.env.FAKE_CLAUDE_MODE = "allowed-warning";
    const warning = await runSession({
      agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task,
      armId: "grep", arm: ARMS.grep, armCommands: COMMANDS, timeoutMs: 2_000,
    });
    assert.equal(warning.valid, true);
    assert.equal(warning.providerFailure, null);
    assert.match(warning.transcript, /"status":"allowed_warning"/);

    process.env.FAKE_CLAUDE_MODE = "schema-invalid";
    const schemaInvalid = await runSession({
      agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task,
      armId: "grep", arm: ARMS.grep, armCommands: COMMANDS, timeoutMs: 2_000,
    });
    assert.equal(schemaInvalid.valid, false);
    assert.equal(schemaInvalid.providerFailure, null);
    assert.match(schemaInvalid.violations.join("\n"), /answer must be a substantive string/);

    process.env.FAKE_CLAUDE_MODE = "rate-limit";
    const rejected = await runSession({
      agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task,
      armId: "grep", arm: ARMS.grep, armCommands: COMMANDS, timeoutMs: 2_000,
    });
    assert.equal(rejected.valid, false);
    assert.deepEqual(rejected.providerFailure, {
      provider: "claude",
      type: "rate_limit",
      retryable: true,
      rateLimitStatus: "rejected",
      rateLimitType: "five_hour",
      resetsAt: 1_787_160_600,
      apiErrorStatus: 429,
      terminalReason: "api_error",
    });
    assert.match(rejected.violations.join("\n"), /retryable claude provider rate_limit/);
  } finally {
    if (originalMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = originalMode;
    if (originalQuestion === undefined) delete process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION;
    else process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION = originalQuestion;
  }
});

test("runSession installs the isolated fail-closed Claude Bash guard", { concurrency: false }, async () => {
  const task = { id: "fake", question: "Where?", expectedSymbols: ["FakeSymbol"] };
  const original = process.env.FAKE_CLAUDE_MODE;
  try {
    process.env.FAKE_CLAUDE_MODE = "permission-config";
    const result = await runSession({
      agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task,
      armId: "patched", arm: ARMS.patched, armCommands: COMMANDS, timeoutMs: 2_000,
    });
    assert.equal(result.process.code, 0, result.process.stderr);
    assert.equal(result.valid, true);
    assert.equal(result.guardPreflight.valid, true);
    assert.deepEqual(result.guardPreflight.probes, { allow: true, deny: true, malformed: true });
    assert.equal(result.metrics.bashGuardLifecycle.valid, true);
    assert.equal(result.metrics.bashGuardLifecycle.bashCalls, 1);
    assert.equal(result.metrics.bashGuardLifecycle.complete, 1);
    const lifecycle = result.transcript.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "system" && event.subtype.startsWith("hook_"));
    assert.equal(lifecycle.length, 2);
    assert.equal(lifecycle.every((event) => event.hook_name === "PreToolUse:Bash"), true);
  } finally {
    if (original === undefined) delete process.env.FAKE_CLAUDE_MODE; else process.env.FAKE_CLAUDE_MODE = original;
  }
});

test("Claude sessions reject missing or failed Bash guard lifecycle evidence", { concurrency: false }, async () => {
  const task = { id: "fake", question: "Where?", expectedSymbols: ["FakeSymbol"] };
  const original = process.env.FAKE_CLAUDE_MODE;
  try {
    for (const mode of ["missing-hook-events", "guard-hook-error"]) {
      process.env.FAKE_CLAUDE_MODE = mode;
      const result = await runSession({
        agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task,
        armId: "patched", arm: ARMS.patched, armCommands: COMMANDS, timeoutMs: 2_000,
      });
      assert.equal(result.valid, false, mode);
      assert.equal(result.metrics.bashGuardLifecycle.valid, false, mode);
      assert.match(result.violations.join("\n"), /Claude Bash guard lifecycle/, mode);
    }
  } finally {
    if (original === undefined) delete process.env.FAKE_CLAUDE_MODE; else process.env.FAKE_CLAUDE_MODE = original;
  }
});

test("a denied file-shell attempt can fall back to Read without invalidating the run", { concurrency: false }, async () => {
  const task = { id: "fake", question: "Where?", expectedSymbols: ["FakeSymbol"] };
  const original = process.env.FAKE_CLAUDE_MODE;
  try {
    process.env.FAKE_CLAUDE_MODE = "denied-file-shell";
    const result = await runSession({
      agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task,
      armId: "patched", arm: ARMS.patched, armCommands: COMMANDS, timeoutMs: 2_000,
    });
    assert.equal(result.valid, true);
    assert.equal(result.grade.correct, true);
    assert.equal(result.metrics.permissionDenials, 1);
    assert.equal(result.metrics.deniedFileShellAttempts, 1);
    assert.equal(result.metrics.unexplainedPermissionDenials, 0);
    assert.equal(result.metrics.fallbacks, 1);
    const denied = JSON.parse(result.transcript.split("\n")
      .find((line) => line.includes("tool-denied-file-shell") && line.includes("tool_use")));
    assert.match(denied.message.content[0].input.command, /^cd \/repo && grep .* \| head/);
  } finally {
    if (original === undefined) delete process.env.FAKE_CLAUDE_MODE; else process.env.FAKE_CLAUDE_MODE = original;
  }
});

test("fake Codex adapter runs headlessly with cached-token accounting", { concurrency: false }, async () => {
  const task = { id: "fake", question: "Where?", expectedSymbols: ["FakeSymbol"] };
  const result = await runSession({
    agentCommand: [process.execPath, FAKE_CODEX], agentId: "codex", subjectRoot: tmpdir(), model: "fake",
    task, armId: "patched", arm: ARMS.patched, armCommands: COMMANDS, timeoutMs: 2_000,
  });
  assert.equal(result.valid, true);
  assert.equal(result.metrics.uncachedInput, 40);
  assert.equal(result.metrics.cacheRead, 60);
  assert.equal(result.metrics.newTokens, 50);
});

test("stale manual review files cannot attach to a different run", () => {
  const output = mkdtempSync(join(tmpdir(), "mex-review-output-"));
  const suite = { id: "review", arms: ARMS, tasks: [{ id: "task" }] };
  const baseMetrics = { newTokens: 1, uncachedInput: 1, cacheWrite: 0, cacheRead: 1, output: 0, reportedTotal: 2, costUsd: 0, uniqueToolResultChars: 0, uniqueToolResultTokens: 0, elapsedMs: 1, turns: 1, toolCalls: 1, graphCalls: 1, scopeCalls: 1, distinctScopeQueries: 1, fallbacks: 0, cacheUseRatio: 0.5, expectedSymbolInitialScopeRank: 1 };
  const rows = Object.keys(ARMS).map((arm) => ({ runIdentity: "run-1", runId: `task-${arm}`, taskId: "task", repetition: 1, arm, valid: true, metrics: baseMetrics, answer: { answer: "x", symbols: ["x"], evidence: [], complete: true }, grade: { correct: true } }));
  writeFileSync(join(output, "run-manifest.json"), JSON.stringify({ runIdentity: "run-1", schedule: rows.map((row) => ({ runId: row.runId })) }));
  generateReport({ suite, outputDir: output, rows });
  const reviewPath = join(output, "blind-review.json");
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  review.reviewIdentity = "stale";
  writeFileSync(reviewPath, JSON.stringify(review));
  const report = generateReport({ suite, outputDir: output, rows });
  assert.equal(report.reviewIdentityValid, false);
  assert.equal(report.manuallyScored, false);
});

test("two-arm runs persist selection in their identity and manifest", { concurrency: false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-two-arm-root-"));
  const output = mkdtempSync(join(tmpdir(), "mex-two-arm-output-"));
  mkdirSync(join(root, ".mex"), { recursive: true });
  const patchedIndex = join(output, "patched.db");
  writeFileSync(patchedIndex, "fake-patched");
  writeFileSync(join(output, "prepare.json"), JSON.stringify({
    selectedArmIds: ["grep", "patched"],
    indices: { patched: { path: patchedIndex } },
  }));
  const suite = {
    id: "two-arm-run",
    requiredRepetitions: 1,
    arms: ARMS,
    tasks: [{ id: "task", question: "Where?", expectedSymbols: ["FakeSymbol"] }],
  };
  const result = await runEvaluation({
    suite,
    subjectRoot: root,
    outputDir: output,
    armCommands: COMMANDS,
    model: "fake",
    timeoutMs: 2_000,
    agentCommand: [process.execPath, FAKE],
    selectedArmIds: ["grep", "patched"],
  });
  assert.equal(result.rows.length, 2);
  assert.deepEqual([...new Set(result.rows.map((row) => row.arm))].sort(), ["grep", "patched"]);
  assert.deepEqual(result.manifest.selectedArmIds, ["grep", "patched"]);
  assert.equal(result.manifest.schedule.length, 2);
  assert.equal(result.manifest.schedule.some((row) => row.armId === "baseline"), false);
  assert.ok(result.manifest.runIdentity);
});

test("compare run preflight accepts a PATH-resolved Node launcher prepared with the same command", { concurrency: false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-path-node-root-"));
  const output = mkdtempSync(join(tmpdir(), "mex-path-node-output-"));
  const bundle = mkdtempSync(join(tmpdir(), "mex-path-node-cli-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "fake.ts"), "export function FakeSymbol() {}\n");
  for (const args of [["init", "-q"], ["config", "user.email", "eval@example.invalid"], ["config", "user.name", "Eval Test"], ["add", "src/fake.ts"], ["commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const graphCli = join(bundle, "fake-graph.mjs");
  writeFileSync(graphCli, 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(".mex", { recursive: true }); writeFileSync(".mex/graph.db", "patched"); console.log("{}");\n');
  const armCommands = { patched: ["node", graphCli] };
  const suite = {
    id: "path-node-run",
    requiredRepetitions: 1,
    subject: { name: "fixture" },
    arms: ARMS,
    tasks: [{ id: "task", question: "Where?", expectedSymbols: ["FakeSymbol"] }],
  };
  const selectedArmIds = ["grep", "patched"];
  prepareEvaluation({
    suite,
    subjectRoot: root,
    harnessRoot: resolve(HERE, "..", "..", ".."),
    armCommands,
    outputDir: output,
    selectedArmIds,
  });

  const result = await runEvaluation({
    suite,
    subjectRoot: root,
    outputDir: output,
    armCommands,
    model: "fake",
    timeoutMs: 2_000,
    agentCommand: [process.execPath, FAKE],
    selectedArmIds,
  });
  assert.equal(result.manifest.status, "complete");
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.every((row) => row.valid), true);
});

test("compare schedules abort before persisting rows when source or CLI identity drifts", { concurrency: false }, async () => {
  const previousPath = process.env.FAKE_CLAUDE_DRIFT_PATH;
  const previousQuestion = process.env.FAKE_CLAUDE_DRIFT_QUESTION;
  try {
    for (const scenario of ["subject", "bundle"]) {
      const root = mkdtempSync(join(tmpdir(), `mex-compare-${scenario}-drift-root-`));
      const output = mkdtempSync(join(tmpdir(), `mex-compare-${scenario}-drift-output-`));
      const bundle = mkdtempSync(join(tmpdir(), `mex-compare-${scenario}-drift-cli-`));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "fake.ts"), "export function FakeSymbol() {}\n");
        for (const args of [["init", "-q"], ["config", "user.email", "eval@example.invalid"], ["config", "user.name", "Eval Test"], ["add", "src/fake.ts"], ["commit", "-qm", "fixture"]]) {
          const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr);
        }
        mkdirSync(join(root, ".mex"), { recursive: true });
        writeFileSync(join(root, ".mex", "graph.db"), "original-graph");

        const graphCli = join(bundle, "fake-graph.mjs");
        writeFileSync(graphCli, [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync(".mex", { recursive: true });',
          'writeFileSync(".mex/graph.db", "candidate-graph");',
          'console.log("{}");',
        ].join("\n"));
        const armCommands = { patched: [process.execPath, graphCli] };
        const suite = {
          id: `compare-${scenario}-drift`,
          requiredRepetitions: 1,
          subject: { name: "fixture" },
          arms: ARMS,
          tasks: [
            { id: "stable", question: "Stable question", expectedSymbols: ["FakeSymbol"] },
            { id: "drift", question: "Trigger comparison drift", expectedSymbols: ["FakeSymbol"] },
          ],
        };
        const selectedArmIds = ["grep", "patched"];
        prepareEvaluation({
          suite,
          subjectRoot: root,
          harnessRoot: root,
          armCommands,
          outputDir: output,
          selectedArmIds,
        });

        process.env.FAKE_CLAUDE_DRIFT_QUESTION = "Trigger comparison drift";
        process.env.FAKE_CLAUDE_DRIFT_PATH = scenario === "subject"
          ? join(root, "src", "fake.ts")
          : join(bundle, "drift-marker.txt");
        await assert.rejects(
          runEvaluation({
            suite,
            subjectRoot: root,
            outputDir: output,
            armCommands,
            model: "fake",
            timeoutMs: 2_000,
            agentCommand: [process.execPath, FAKE],
            selectedArmIds,
          }),
          scenario === "subject"
            ? /identity drift after 02-drift-patched: subject repository no longer matches/
            : /identity drift after 02-drift-patched: CLI bundle changed after prepare for patched/,
        );

        const manifest = JSON.parse(readFileSync(join(output, "run-manifest.json"), "utf8"));
        assert.equal(manifest.status, "aborted");
        assert.equal(manifest.failedRunId, "02-drift-patched");
        assert.equal(manifest.resultCount, 2);
        assert.match(manifest.error, scenario === "subject" ? /subject repository/ : /CLI bundle changed/);
        assert.equal(existsSync(join(output, "runs", "01-stable-grep.json")), true);
        assert.equal(existsSync(join(output, "runs", "01-stable-patched.json")), true);
        assert.equal(existsSync(join(output, "transcripts", "02-drift-patched.jsonl")), true);
        assert.equal(existsSync(join(output, "runs", "02-drift-patched.json")), false);
        assert.equal(readFileSync(join(root, ".mex", "graph.db"), "utf8"), "original-graph");
        assert.equal(generateReport({ suite, outputDir: output }).executionValid, false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(output, { recursive: true, force: true });
        rmSync(bundle, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousPath === undefined) delete process.env.FAKE_CLAUDE_DRIFT_PATH;
    else process.env.FAKE_CLAUDE_DRIFT_PATH = previousPath;
    if (previousQuestion === undefined) delete process.env.FAKE_CLAUDE_DRIFT_QUESTION;
    else process.env.FAKE_CLAUDE_DRIFT_QUESTION = previousQuestion;
  }
});

test("compare aborts on a provider rate limit without a failed row and resume retries missing work", { concurrency: false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-compare-rate-limit-root-"));
  const output = mkdtempSync(join(tmpdir(), "mex-compare-rate-limit-output-"));
  const originalMode = process.env.FAKE_CLAUDE_MODE;
  const originalQuestion = process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION;
  try {
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "graph.db"), "original-graph");
    const patchedIndex = join(output, "patched.db");
    writeFileSync(patchedIndex, "fake-patched");
    writeFileSync(join(output, "prepare.json"), JSON.stringify({
      selectedArmIds: ["grep", "patched"],
      indices: { patched: { path: patchedIndex } },
    }));
    const suite = {
      id: "rate-limit-resume",
      requiredRepetitions: 1,
      arms: ARMS,
      tasks: [
        { id: "stable", question: "Stable question", expectedSymbols: ["FakeSymbol"] },
        { id: "limited", question: "Trigger rate limit", expectedSymbols: ["FakeSymbol"] },
      ],
    };
    const options = {
      suite,
      subjectRoot: root,
      outputDir: output,
      armCommands: COMMANDS,
      model: "fake",
      timeoutMs: 2_000,
      agentCommand: [process.execPath, FAKE],
      selectedArmIds: ["grep", "patched"],
    };

    process.env.FAKE_CLAUDE_MODE = "rate-limit";
    process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION = "Trigger rate limit";
    await assert.rejects(runEvaluation(options), /retryable claude provider rate limit \(429\)/);

    const manifest = JSON.parse(readFileSync(join(output, "run-manifest.json"), "utf8"));
    assert.equal(manifest.status, "aborted");
    assert.equal(manifest.failedRunId, "02-limited-patched");
    assert.equal(manifest.resultCount, 2);
    assert.match(manifest.error, /resume after the provider limit resets/);
    const priorPaths = [
      join(output, "runs", "01-stable-grep.json"),
      join(output, "runs", "01-stable-patched.json"),
    ];
    assert.equal(priorPaths.every(existsSync), true);
    const priorRows = priorPaths.map((path) => readFileSync(path, "utf8"));
    assert.equal(priorRows.every((row) => JSON.parse(row).valid), true);
    const failedTranscript = join(output, "transcripts", "02-limited-patched.jsonl");
    assert.equal(existsSync(failedTranscript), true);
    assert.match(readFileSync(failedTranscript, "utf8"), /"status":"rejected"/);
    assert.match(readFileSync(failedTranscript, "utf8"), /"api_error_status":429/);
    assert.equal(existsSync(join(output, "runs", "02-limited-patched.json")), false);
    assert.equal(existsSync(join(output, "runs", "02-limited-grep.json")), false);
    assert.equal(readFileSync(join(root, ".mex", "graph.db"), "utf8"), "original-graph");

    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION;
    const resumed = await runEvaluation({ ...options, resume: true });
    assert.equal(resumed.manifest.status, "complete");
    assert.equal(resumed.rows.length, 4);
    assert.equal(resumed.rows.every((row) => row.valid), true);
    assert.deepEqual(priorPaths.map((path) => readFileSync(path, "utf8")), priorRows);
    assert.equal(existsSync(join(output, "runs", "02-limited-patched.json")), true);
    assert.equal(existsSync(join(output, "runs", "02-limited-grep.json")), true);
  } finally {
    if (originalMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = originalMode;
    if (originalQuestion === undefined) delete process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION;
    else process.env.FAKE_CLAUDE_RATE_LIMIT_QUESTION = originalQuestion;
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("resume skips completed run IDs", { concurrency: false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-compare-root-"));
  const output = mkdtempSync(join(tmpdir(), "mex-compare-output-"));
  mkdirSync(join(root, ".mex"), { recursive: true });
  const indices = {};
  for (const armId of ["baseline", "patched"]) {
    const path = join(output, `${armId}.db`); writeFileSync(path, `fake-${armId}`); indices[armId] = { path };
  }
  writeFileSync(join(output, "prepare.json"), JSON.stringify({ indices }));
  const suite = { id: "fake", requiredRepetitions: 2, arms: ARMS, tasks: [{ id: "task", question: "Where?", expectedSymbols: ["FakeSymbol"] }] };
  const first = await runEvaluation({ suite, subjectRoot: root, outputDir: output, armCommands: COMMANDS, model: "fake", timeoutMs: 2_000, agentCommand: [process.execPath, FAKE] });
  assert.equal(first.rows.length, 6);
  assert.deepEqual([...new Set(first.rows.map((row) => row.repetition))], [1, 2]);
  process.env.FAKE_CLAUDE_MODE = "failure";
  try {
    const resumed = await runEvaluation({ suite, subjectRoot: root, outputDir: output, armCommands: COMMANDS, model: "fake", timeoutMs: 2_000, resume: true, agentCommand: [process.execPath, FAKE] });
    assert.equal(resumed.rows.every((row) => row.valid), true);
  } finally { delete process.env.FAKE_CLAUDE_MODE; }
});

test("prepare verifies gold evidence, snapshots both graph indices, and restores the subject graph", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-compare-prepare-root-"));
  const output = mkdtempSync(join(tmpdir(), "mex-compare-prepare-output-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex"), { recursive: true });
  writeFileSync(join(root, "src", "fake.ts"), "export function FakeSymbol() {}\n");
  writeFileSync(join(root, ".mex", "graph.db"), "original");
  for (const args of [["init", "-q"], ["config", "user.email", "eval@example.invalid"], ["config", "user.name", "Eval Test"], ["add", "src/fake.ts"], ["commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const graphCli = join(output, "fake-graph.mjs");
  writeFileSync(graphCli, 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(".mex", { recursive: true }); writeFileSync(".mex/graph.db", process.argv[2]); console.log("{}");\n');
  const suite = { id: "prepare", subject: { name: "fixture" }, arms: ARMS, tasks: [{ id: "task", question: "Where?", expectedSymbols: ["FakeSymbol"] }] };
  const armCommands = { baseline: [process.execPath, graphCli, "baseline"], patched: [process.execPath, graphCli, "patched"] };
  const harnessRoot = resolve(HERE, "..", "..", "..");
  const manifest = prepareEvaluation({ suite, subjectRoot: root, harnessRoot, armCommands, outputDir: output });
  assert.equal(readFileSync(join(root, ".mex", "graph.db"), "utf8"), "original");
  assert.equal(readFileSync(manifest.indices.baseline.path, "utf8"), "baseline");
  assert.equal(readFileSync(manifest.indices.patched.path, "utf8"), "patched");
  assert.equal(manifest.goldEvidence[0].symbols[0].path, "src/fake.ts");
  assert.equal(manifest.goldEvidence[0].symbols[0].line, 1);

  const twoArmOutput = mkdtempSync(join(tmpdir(), "mex-compare-prepare-two-arm-"));
  const twoArm = prepareEvaluation({
    suite,
    subjectRoot: root,
    harnessRoot,
    armCommands,
    outputDir: twoArmOutput,
    selectedArmIds: ["grep", "patched"],
  });
  assert.deepEqual(twoArm.selectedArmIds, ["grep", "patched"]);
  assert.deepEqual(Object.keys(twoArm.cli), ["patched"]);
  assert.deepEqual(Object.keys(twoArm.indices), ["patched"]);
  assert.deepEqual(Object.keys(twoArm.graphCoverage), ["grep", "patched"]);
  assert.equal(readFileSync(join(root, ".mex", "graph.db"), "utf8"), "original");
});
