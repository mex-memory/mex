import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeInvocation, agentDiff, runHiddenTests, sharedInstructions } from "../lib/session.mjs";
import { git, createWorkspace, removeWorkspace, linkDependencies, unlinkDependencies } from "../lib/workspace.mjs";
import { assertInstructionParity, instructionSnapshot, withoutMexBlocks } from "../lib/instructions.mjs";
import { selectedSchedule, main } from "../index.mjs";
import { calibrationSummary } from "../lib/calibration.mjs";
import { measureSession } from "../lib/measures.mjs";
import { parseSession, testCommandTime } from "../lib/telemetry.mjs";
import { pairedRatio, wilcoxon } from "../lib/statistics.mjs";
import { validateSuite } from "../lib/suite.mjs";
import { patchComplexity, annotateComplexity } from "../complexity.mjs";
import { prepareDependencies } from "../prepare-deps.mjs";
import { generateReport } from "../lib/report.mjs";
import { settleTelemetry, summarizeContextLog } from "../lib/hooks.mjs";
import { runTimed } from "../../compare/lib/process.mjs";

const fixture = () => mkdtempSync(join(tmpdir(), "heavy-harness-"));
function commit(root) { git(root, ["add", "."]); git(root, ["commit", "-qm", "fixture"]); return git(root, ["rev-parse", "HEAD"]).stdout.trim(); }
function repository(root) { mkdirSync(root, { recursive: true }); git(root, ["init", "-q"]); writeFileSync(join(root, "README.md"), "fixture\n"); return commit(root); }

test("shared instructions stay out of the user prompt in every arm", () => {
  for (const type of ["qa", "change"]) {
    const task = { type, prompt: "Trace the boundary." }, suffix = { [type]: "Keep it concise." };
    const invocations = [false, true].map((withMex) => claudeInvocation({ task, model: "fake", withMex, appendPrompt: suffix }));
    for (const invocation of invocations) assert.equal(invocation.args[invocation.args.indexOf("-p") + 1], task.prompt);
    const system = (i) => i.args[i.args.indexOf("--append-system-prompt") + 1];
    assert.equal(system(invocations[0]), system(invocations[1]));
    assert.match(system(invocations[0]), /targeted tests/);
    assert.match(sharedInstructions(task, suffix), /Keep it concise/);
  }
});

test("instruction parity permits managed blocks only, including nested instruction files", () => {
  assert.equal(withoutMexBlocks("Read AGENTS.md.\r\n\r\n<!-- mex:hooks:start -->\r\nmanaged\r\n<!-- mex:hooks:end -->\r\n"), "Read AGENTS.md.");
  assert.deepEqual(assertInstructionParity({ "AGENTS.md": "base" }, { "AGENTS.md": "base" }).identical, true);
  assert.throws(() => assertInstructionParity({ "pkg/CLAUDE.md": "base" }, { "pkg/CLAUDE.md": "changed" }), /mismatch/);
  assert.throws(() => assertInstructionParity({}, { "CLAUDE.md": "new instructions" }), /mismatch/);
  const root = fixture(), subject = join(root, "subject"), ws = join(root, "ws");
  try {
    repository(subject); writeFileSync(join(subject, "CLAUDE.md"), "Read AGENTS.md.\n"); writeFileSync(join(subject, "AGENTS.md"), "base\n");
    const base = commit(subject);
    mkdirSync(join(subject, ".mex")); writeFileSync(join(subject, ".mex/fact.md"), "fact\n");
    writeFileSync(join(subject, "CLAUDE.md"), "<!-- mex-agent:skills:start -->\nmanaged\n<!-- mex-agent:skills:end -->\n");
    const scaffold = commit(subject);
    createWorkspace({ subjectRoot: subject, workspace: ws, base, scaffoldCommit: scaffold, workerConfig: { file: "test.config", values: { workerCount: 3 } } });
    assert.deepEqual(instructionSnapshot(ws), { "AGENTS.md": "base", "CLAUDE.md": "Read AGENTS.md." });
    assert.equal(JSON.parse(readFileSync(join(ws, "test.config"))).workerCount, 3);
    assert.match(readFileSync(join(ws, "CLAUDE.md"), "utf8"), /Read AGENTS.md/);
  } finally { removeWorkspace(subject, ws); rmSync(root, { recursive: true, force: true }); }
});

test("main schedule is paired, balanced and three reps; calibration overrides task repetitions", () => {
  const suite = { arms: { files: {}, "mex-r2w": {}, "mex-r3": {} }, repetitions: 1,
    tasks: [{ id: "a", type: "qa", repetitions: 7 }, { id: "b", type: "change", fullRun: false }] };
  const main = selectedSchedule(suite);
  assert.equal(main.length, 6); assert.ok(main.every((r) => r.armId !== "mex-r2w"));
  assert.deepEqual(main.filter((r) => r.orderIndex === 0).map((r) => r.armId), ["files", "mex-r3", "files"]);
  const calibration = selectedSchedule(suite, { calibration: true });
  assert.equal(calibration.length, 4); assert.ok(calibration.every((r) => r.armId === "files"));
  assert.equal(new Set(calibration.map((r) => r.runId)).size, 4);
});

test("calibration requires every repetition, both inclusive thresholds, and valid rows", () => {
  const suite = { id: "fixture", tasks: [{ id: "a" }] };
  const row = (repetition, processed = 150_000, turns = 20) => ({ taskId: "a", arm: "files", valid: true, repetition, metrics: { processed, turns } });
  const select = (rows, options) => calibrationSummary(suite, rows, options).tasks[0].selected;
  assert.equal(select([row(1), row(2)]), true);
  for (const rows of [[row(1)], [row(1), row(2, 149_999)], [row(1), row(2, 150_000, 19)], [row(1), { ...row(2), valid: false }]]) assert.equal(select(rows), false);
  assert.equal(select([row(1, 4, 2)], { repetitions: 1, tokenThreshold: 4, turnThreshold: 2 }), true);
});

test("graph uptake needs a novel location or symbol within five calls, never just final citation", () => {
  const read = (path) => ({ name: "Read", input: { file_path: path }, output: "" });
  const entry = { event: "graph", kind: "graph", chars: 30, text: "src/a.ts #freshSymbol", toolCallIndex: 1 };
  const used = (calls, answer = "") => measureSession({ raw: "", calls, entries: [entry], task: {}, answer }).injectionsUsed;
  assert.equal(used([read("src/a.ts"), read("src/a.ts")]), 0);
  assert.equal(used([read("src/old.ts"), read("src/a.ts")]), 1);
  assert.equal(used([read("src/a.ts")], "src/a.ts freshSymbol"), 0);
  assert.equal(used([read("old"), ...Array.from({ length: 5 }, () => read("other")), read("src/a.ts")]), 0);
  const knownOutput = { name: "Grep", input: { pattern: "other" }, output: "src/a.ts #freshSymbol" };
  assert.equal(used([knownOutput, read("src/a.ts")]), 0);
  const m = measureSession({ raw: "", calls: [], entries: [{ event: "prompt", ids: ["mx_expected"], chars: 10, text: "fact", toolCallIndex: 0 }], task: { gold: { knowledge: ["mx_expected"] } } });
  assert.equal(m.offGoldInjections.length, 0);
});

test("capture drains a large final write before returning; incomplete accounting is clearly marked", async () => {
  const data = "x".repeat(1024 * 1024);
  const result = await runTimed(process.execPath, ["-e", `process.stdout.write('x'.repeat(1024*1024),()=>process.stdout.write('FINAL\\n'));`]);
  assert.equal(result.stdout, `${data}FINAL\n`);
  const raw = JSON.stringify({ type: "result", num_turns: 2, usage: { input_tokens: 10 }, structured_output: {} });
  const parsed = parseSession(raw, {});
  assert.equal(parsed.accounting.status, "incomplete-usage-invalid"); assert.equal(parsed.accounting.countMismatch, true);
});

test("test intervals use wall-time union; absent timestamps never imply zero test time", () => {
  const calls = ["a", "b"].map((id) => ({ id, name: "Bash", input: { command: "pnpm test focused" } }));
  const event = (type, id, time) => ({ type: type === "tool_use" ? "assistant" : "user", timestamp: `2026-01-01T00:00:${time}.000Z`, message: { content: [{ type, ...(type === "tool_use" ? { id } : { tool_use_id: id }) }] } });
  const raw = [event("tool_use", "a", "00"), event("tool_use", "b", "02"), event("tool_result", "a", "04"), event("tool_result", "b", "06")].map(JSON.stringify).join("\n");
  assert.equal(testCommandTime(raw, calls).ms, 6000);
  assert.equal(testCommandTime("", calls).ms, null);
});

test("paired ratios bootstrap tasks, preserve repetition clusters, and signed-rank handles ties", () => {
  const pair = (taskId, ratio) => ({ taskId, control: { metrics: { processed: 100 } }, treatment: { metrics: { processed: 100 * ratio } } });
  const pairs = [pair("a", .5), pair("a", .5), pair("b", 2)];
  const r = pairedRatio(pairs, "processed");
  assert.equal(r.ratio, 1); assert.equal(r.tasks, 2); assert.equal(r.pairs, 3);
  assert.equal(r.low, .5); assert.equal(r.high, 2);
  assert.equal(wilcoxon([1, 1, 1]).p, .25); assert.equal(wilcoxon([0, 0]).p, 1);
  assert.equal(pairedRatio([pair("a", 0)], "processed").ratio, null);
});

test("complexity counts files, directories, packages, changed lines and prompt leakage", () => {
  const patch = "diff --git a/p/a.ts b/p/a.ts\n@@ -1 +1 @@\n-function hiddenSymbol() { return 1; }\n+function hiddenSymbol() { return 2; }\ndiff --git a/q/b.ts b/q/b.ts\n+const anotherSymbol = 1;\n";
  const c = patchComplexity(patch, "Trace the boundary.", ["p/package.json", "q/package.json"]);
  assert.deepEqual([c.goldFiles, c.directories, c.packages, c.goldLinesChanged, c.promptNamesGold], [2, 2, 2, 3, false]);
  assert.equal(patchComplexity(patch, "Explain hiddenSymbol", []).promptNamesGold, true);
  assert.equal(patchComplexity(patch, "Fix a.ts", []).promptNamesGold, true);
});

test("complexity annotation reads the gold commit, stores LOC, and rejects named heavy tasks", () => {
  const root = fixture();
  try {
    repository(root); writeFileSync(join(root, "a.ts"), "export function hiddenSymbol() { return 1; }\n"); const base = commit(root);
    writeFileSync(join(root, "a.ts"), "export function hiddenSymbol() { return 2; }\n"); const fix = commit(root);
    const suite = { tasks: [{ id: "a", type: "change", heavy: true, base, goldCommit: fix, prompt: "Fix the boundary." }] };
    assert.equal(annotateComplexity(suite, root).tasks[0].complexity.repoSourceLoc, 1);
    suite.tasks[0].prompt = "Fix hiddenSymbol";
    assert.throws(() => annotateComplexity(suite, root), /names gold/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("package hidden tests run in one package with worker cap and require actual passes", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, "packages/one"), { recursive: true });
    const script = join(root, "runner.cjs");
    writeFileSync(script, "console.log(process.cwd());console.log(process.argv.slice(2).join(' '));console.log('Tests: 2 passed, 2 total');");
    const spec = { runner: "pnpm", cwd: "packages/one", command: ["pnpm", "exec", "jest", "focused"], pnpmEntry: script, workerCount: 3 };
    const result = runHiddenTests(root, spec, process.env);
    assert.equal(result.ok, true); assert.match(result.output, /maxWorkers=3/); assert.match(result.output, /packages[\\/]one/);
    writeFileSync(script, "console.log('startup completed');");
    assert.equal(runHiddenTests(root, spec, process.env).ok, false);
    assert.throws(() => runHiddenTests(root, { ...spec, cwd: "../outside" }, process.env), /relative/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared dependency install links package dependencies and unlinks without deleting shared files", () => {
  const root = fixture(), subject = join(root, "subject"), install = join(root, "install"), ws = join(root, "ws");
  try {
    repository(subject); writeFileSync(join(subject, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
    mkdirSync(join(subject, "packages/one"), { recursive: true }); writeFileSync(join(subject, "packages/one/package.json"), "{}");
    mkdirSync(join(subject, "packages/two"), { recursive: true }); writeFileSync(join(subject, "packages/two/package.json"), "{}"); const base = commit(subject);
    const installer = join(root, "installer.cjs");
    writeFileSync(installer, "const f=require('node:fs');for(const p of ['node_modules','packages/one/node_modules']){f.mkdirSync(p,{recursive:true});f.writeFileSync(p+'/keep','keep');}f.mkdirSync('packages/one/node_modules/@local',{recursive:true});f.symlinkSync(require('node:path').resolve('packages/two'),'packages/one/node_modules/@local/two','junction');");
    const deps = prepareDependencies({ subject, base, output: install, installer: [process.execPath, installer] });
    createWorkspace({ subjectRoot: subject, workspace: ws, base, depsDir: deps });
    assert.equal(readFileSync(join(ws, "packages/one/node_modules/keep"), "utf8"), "keep");
    assert.equal(realpathSync(join(ws, "packages/one/node_modules/@local/two")), realpathSync(join(ws, "packages/two")));
    unlinkDependencies(ws); assert.equal(existsSync(join(ws, "packages/one/node_modules")), false);
    assert.equal(readFileSync(join(install, "project/packages/one/node_modules/keep"), "utf8"), "keep");
    linkDependencies(ws, deps);
  } finally { removeWorkspace(subject, ws); rmSync(root, { recursive: true, force: true }); }
});

test("CRLF committed blobs produce only changed-line hunks", () => {
  const root = fixture();
  try {
    repository(root); git(root, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(root, "a.ts"), "one\r\ntwo\r\nthree\r\n"); commit(root);
    writeFileSync(join(root, "a.ts"), "one\r\nchanged\r\nthree\r\n");
    const diff = agentDiff(root);
    assert.equal(diff.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("package-suite validation accepts knowledge ids and rejects escaping paths", () => {
  const suite = { id: "fixture", subjectType: "pnpm", workerCount: 3, arms: { files: {} }, tasks: [{ id: "a", base: "base", type: "change", prompt: "Fix the boundary", gold: { knowledge: ["mx_A"] }, hiddenTests: { runner: "pnpm", cwd: "packages/one", files: ["packages/one/a.test.ts"], command: ["pnpm", "exec", "jest", "a.test.ts"] } }] };
  assert.equal(validateSuite(suite), suite);
  suite.tasks[0].hiddenTests.cwd = "../outside";
  assert.throws(() => validateSuite(suite), /relative/);
});

test("calibration rows cannot feed reports", () => {
  assert.throws(() => generateReport({ suite: {}, rows: [{ mode: "calibration" }] }), /calibration/);
});

test("reports include all tasks, separate control strata, paid cost per success and missing-hook audit", () => {
  const tasks = ["a", "b", "control", "missing"].map((id) => ({ id, type: "change", heavy: id !== "control" }));
  const rows = tasks.slice(0, 3).flatMap((task) => ["files", "mex-r3"].map((arm) => ({
    runId: `${task.id}-${arm}`, taskId: task.id, taskType: "change", arm, repetition: 1, valid: true,
    hiddenTests: { ok: arm === "files" || task.id !== "b" }, diff: { knowledgeFiles: [] },
    metrics: { processed: arm === "files" ? 100 : 200, costUsd: arm === "files" ? 1 : 2, elapsedMs: 100, agentMinusTestMs: 80, handHashEdits: 0 },
  })));
  const report = generateReport({ suite: { id: "fixture", arms: { "mex-r3": {}, files: {} }, tasks }, rows, salt: "fixture" });
  assert.match(report, /\| mex-r3 \| heavy \| processed \| 2 \/ 2 \| 2\.000/);
  assert.match(report, /\| mex-r3 \| light \| processed \| 1 \/ 1 \| 2\.000/);
  assert.match(report, /\| mex-r3 \| change \| 2 \/ 3 \| 3\.0000/);
  assert.match(report, /\| missing \| heavy \| 0 \|/);
  assert.match(report, /\| a-mex-r3 \| MISSING \|/);
});

test("settle telemetry distinguishes launch, completion, failure and timeout at zero wait", () => {
  const root = fixture(), path = join(root, "log.jsonl");
  try {
    const summary = (entries) => { writeFileSync(path, entries.map(JSON.stringify).join("\n")); return summarizeContextLog(path); };
    assert.equal(settleTelemetry(null, null).settleOutcome, "not-launched");
    const launched = summary([{ event: "stop", settleLaunched: true }]);
    assert.equal(settleTelemetry(launched, { waitMs: 0 }).settleOutcome, "launched-no-outcome");
    const complete = summary([{ event: "settle", refresh: { code: 0 } }]);
    assert.deepEqual(settleTelemetry(complete, { waitMs: 0 }), { settleLaunched: true, settleOutcome: "completed" });
    assert.equal(settleTelemetry(summary([{ event: "settle", refresh: { code: 1 } }]), {}).settleOutcome, "failed");
    assert.equal(settleTelemetry(launched, { timedOut: true }).settleOutcome, "timed-out");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
