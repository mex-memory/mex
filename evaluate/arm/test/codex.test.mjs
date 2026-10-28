import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGE_SCHEMA, runAgentSession } from "../lib/session.mjs";
import { codexInvocation, codexTestTime, listPriceEstimate, parseCodex, runCodex, unwrapCommand, validateOutput } from "../lib/codex.mjs";
import { classifyCall } from "../lib/classify.mjs";
import { clipRepository, historyViolations, verifyClippedHistory } from "../lib/history.mjs";
import { createWorkspace, git, installContextIndex, installIndexes, removeWorkspace, resolveCommit } from "../lib/workspace.mjs";
import { installProductHooks } from "../lib/hooks.mjs";
import { availableRam, parseMeminfo, parseProcessTable, parseVmStat, resourceGuard, resourceSnapshot, samplerSummary, startSampler, treeRss } from "../lib/resources.mjs";
import { cleanupPipeline, compareGraphTables, removeOwnedTree } from "../lib/pipeline.mjs";
import { captureScaffold } from "../capture-scaffold.mjs";
import { main, selectedSchedule, sessionEnv } from "../index.mjs";
import { loadRows } from "../lib/report.mjs";

const fake = fileURLToPath(new URL("fake-codex.mjs", import.meta.url));
const scratch = process.env.ARM_TEST_TMP ?? tmpdir();
function temp(t) { const root = mkdtempSync(join(scratch, "arm-codex-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function commit(root, message) { git(root, ["add", "-A"]); git(root, ["commit", "-qm", message]); return resolveCommit(root, "HEAD"); }
export function fixture(root, { twoBases = false } = {}) {
  const subject = join(root, "subject"), cliBin = join(root, "cli/node_modules/.bin"), home = join(root, "source-home"), output = join(root, "output");
  mkdirSync(subject, { recursive: true }); mkdirSync(cliBin, { recursive: true }); mkdirSync(join(cliBin, "../mex-agent/dist"), { recursive: true }); mkdirSync(home);
  writeFileSync(join(home, "auth.json"), '{"fixture":"credential-copy-test"}'); writeFileSync(join(home, "AGENTS.md"), "Must never be copied"); writeFileSync(join(home, "config.toml"), "Must never be copied");
  git(subject, ["init", "-q"]);
  writeFileSync(join(subject, ".gitignore"), ".mex/local/\n.mex/*.db*\nnode_modules/\n");
  writeFileSync(join(subject, "README.md"), "fixture\n"); writeFileSync(join(subject, "AGENTS.md"), "Own instructions.\n"); writeFileSync(join(subject, "CLAUDE.md"), "Own host instructions.\n");
  for (const dir of [".codex", ".claude", ".agents"]) { mkdirSync(join(subject, dir)); writeFileSync(join(subject, dir, "own.txt"), "Excluded uniformly"); }
  const base = commit(subject, "fixture base");
  writeFileSync(join(subject, "README.md"), "fixture second base\n"); const base2 = commit(subject, "fixture second base");
  writeFileSync(join(subject, "fixture.cjs"), "module.exports=42;\n");
  writeFileSync(join(subject, "hidden.cjs"), "require('node:assert/strict').equal(require('./fixture.cjs'),42);console.log('Tests 1 passed (1)');\n"); const merge = commit(subject, "fixture hidden oracle");
  mkdirSync(join(subject, ".mex")); writeFileSync(join(subject, ".mex/AGENTS.md"), "Canonical scaffold.\n"); writeFileSync(join(subject, ".mex/fact.md"), "Fact\n");
  writeFileSync(join(subject, "AGENTS.md"), "Own instructions.\n<!-- mex-agent:skills:start -->\nPull policy.\n<!-- mex-agent:skills:end -->\n"); const scaffold = commit(subject, "fixture scaffold");
  copyFileSync(new URL("fake-cli.cjs", import.meta.url), join(cliBin, "../mex-agent/dist/cli.js"));
  const suite = { id: "codex-fixture", agent: "codex", model: "gpt-6.1-sol", effort: "high", sandbox: "workspace-write", requiresDeps: false, mainRepetitions: 1, defaultArms: ["files", "mex-r2w", "mex-r3"], arms: { files: {}, "mex-r2w": { scaffold: true, hooks: true, lexical: true }, "mex-r3": { scaffold: true, hooks: true, semantic: true } }, scaffolds: { default: scaffold },
    tasks: (twoBases ? [base, base2] : [base]).map((b, i) => ({ id: `task-${i}`, type: "change", base: b, scaffold: "default", mergeCommit: merge, prompt: `Apply fixture task-${i}.`, complexity: { repoSourceLoc: 1, goldFiles: 1, directories: 1, packages: 1, goldLinesChanged: 1, promptNamesGold: false }, gold: { code: [{ path: "fixture.cjs" }] }, hiddenTests: { fromCommit: merge, files: ["hidden.cjs"], command: [process.execPath, "hidden.cjs"] } })) };
  const suitePath = join(root, "suite.json"); writeFileSync(suitePath, JSON.stringify(suite));
  const fixes = join(root, "fixes.json"); writeFileSync(fixes, JSON.stringify(suite.tasks.map((t) => ({ match: t.id, files: { "fixture.cjs": "module.exports=42;\n" } }))));
  return { subject, cliBin, home, output, base, base2, merge, scaffold, suite, suitePath, fixes,
    common: ["--suite", suitePath, "--subject", subject, "--cli-bin", cliBin, "--output", output, "--fake-agent", fake, "--min-ram-gb", "0", "--min-disk-gb", "0"] };
}

test("Codex probe parsing sums every turn, unwraps shells, and classifies reads/searches/edits/git/tests", () => {
  const probe = readFileSync(new URL("probe/exec.jsonl", import.meta.url), "utf8");
  const parsed = parseCodex(probe + '\n{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":2,"output_tokens":20,"reasoning_output_tokens":10}}');
  assert.equal(parsed.usage.input, 83740); assert.equal(parsed.usage.cacheRead, 62120); assert.equal(parsed.usage.uncachedInput, 21620); assert.equal(parsed.usage.reportedTotal, 84014); assert.equal(parsed.usage.reasoning, 10); assert.equal(parsed.usage.cacheWrite, 2); assert.equal(parsed.usage.reportedCostUsd, null);
  assert.deepEqual(parsed.toolCalls.map((c) => classifyCall(c).category), ["source-read", "edit", "discovery"]);
  for (const wrapper of ["bash -lc 'npm test -- target'", '"/bin/zsh" -lc "npm test -- target"', "powershell.exe -NoProfile -Command 'npm test -- target'"]) assert.equal(unwrapCommand(wrapper), "npm test -- target");
  assert.equal(classifyCall({ codex: true, name: "Bash", input: { command: "git status" } }).category, "git");
  assert.equal(classifyCall({ name: "Bash", input: { command: "Get-Content src/file.ts" } }).category, "source-read");
  assert.equal(parseCodex('{"type":"turn.started"}').usage.accountingValid, false);
  assert.equal(parseCodex('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":2,"output_tokens":0}}').usage.accountingValid, false);
  assert.equal(parseCodex('garbled').malformedLines, 1);
  const batch = parseCodex('{"type":"item.completed","item":{"id":"batch","type":"file_change","changes":[{"path":"a.ts"},{"path":"b.ts"}]}}');
  assert.equal(batch.toolCalls.length, 1); assert.equal(batch.toolCalls[0].name, "MultiEdit");
  assert.equal(listPriceEstimate(parsed.usage), null);
  assert.equal(listPriceEstimate({ uncachedInput: 60, cacheRead: 40, cacheWrite: 2, output: 20 }, { input: 1, cachedInput: 0.1, cacheWrite: 2, output: 5 }).usd, 166 / 1e6);
});
test("Codex schema validity includes required, extra, length, nested types, and test interval union", () => {
  assert.equal(validateOutput({ summary: "too short", filesChanged: [], testsRun: "" }, CHANGE_SCHEMA), false);
  assert.equal(validateOutput({ summary: "A sufficiently detailed change summary.", filesChanged: [], testsRun: "", extra: 1 }, CHANGE_SCHEMA), false);
  const calls = ["a", "b"].map((id) => ({ id, name: "Bash", input: { command: "pnpm exec vitest run target" } }));
  const events = [["item.started", "a", 0], ["item.started", "b", 100], ["item.completed", "a", 200], ["item.completed", "b", 300]].map(([type, id, ms]) => ({ type, item: { id }, timestamp: new Date(ms).toISOString() }));
  assert.equal(codexTestTime(events, calls).ms, 300); assert.equal(codexTestTime(events.slice(0, 3), calls).ms, null);
  const invocation = codexInvocation({ workspace: "work", model: "fixed", schemaFile: "schema", lastMessage: "last" });
  assert.ok(!invocation.args.includes("--dangerously-bypass-hook-trust")); assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
});
test("fake Codex honors stdin, -C, schema and -o, isolates auth only, preserves source, copies rollout and removes its home on success/failure", async (t) => {
  const root = temp(t), f = fixture(root), workspace = join(root, "work"); createWorkspace({ subjectRoot: f.subject, workspace, base: f.base, agent: "codex" });
  const before = readdirSync(f.home).map((name) => [name, readFileSync(join(f.home, name), "utf8")]);
  for (const mode of ["success", "invalid", "no-turn", "exit"]) {
    const prefix = join(root, mode), observe = join(root, `${mode}.observe.json`);
    const r = await runCodex({ command: [process.execPath, fake], model: "gpt-6.1-sol", effort: "xhigh", sandbox: "workspace-write", workspace, env: { ...process.env, CODEX_HOME: f.home, FAKE_CODEX_OBSERVE: observe, ...(mode === "invalid" ? { FAKE_CODEX_INVALID: "1" } : mode === "no-turn" ? { FAKE_CODEX_NO_TURN: "1" } : mode === "exit" ? { FAKE_CODEX_EXIT: "7" } : {}) }, prompt: "Apply fixture.", schema: CHANGE_SCHEMA, outputPrefix: prefix });
    assert.equal(existsSync(`${prefix}.codex-home`), false); assert.ok(existsSync(`${prefix}.rollout/rollout.jsonl`));
    const seen = JSON.parse(readFileSync(observe)); assert.equal(seen.authPresent, true); assert.deepEqual(seen.homeFiles.sort(), ["auth.json", "config.toml"]); assert.ok(seen.config.includes('model_reasoning_effort = "xhigh"'));
    assert.equal(r.parsed.structured.ok, mode !== "invalid"); assert.equal(r.parsed.usage.accountingValid, mode !== "no-turn"); assert.equal(r.code, mode === "exit" ? 7 : 0);
    assert.ok(r.parsed.events.every((e) => e.timestamp));
  }
  assert.deepEqual(readdirSync(f.home).map((name) => [name, readFileSync(join(f.home, name), "utf8")]), before);
});
test("clipped repositories on two bases contain real ancestor objects only, and all leak checks fire", (t) => {
  const root = temp(t), f = fixture(root);
  for (const base of [f.base, f.base2]) {
    const workspace = join(root, base.slice(0, 8)); clipRepository(f.subject, workspace, base);
    assert.equal(verifyClippedHistory(workspace, base, [f.merge, f.scaffold]).objectClosureVerified, true);
    assert.equal(git(workspace, ["cat-file", "-e", f.merge], { allowFailure: true }).code === 0, false);
    assert.equal(historyViolations(["git log --all", "git cat-file HEAD", "git fsck", "git reflog", `git show ${f.merge}`, `git log ${base}`].map((command) => ({ name: "Bash", input: { command } })), workspace, base).length, 5);
    git(workspace, ["remote", "add", "leak", f.subject]); assert.throws(() => verifyClippedHistory(workspace, base), /remote/); git(workspace, ["remote", "remove", "leak"]);
    git(workspace, ["branch", "leak", base]); assert.throws(() => verifyClippedHistory(workspace, base), /refs/); git(workspace, ["branch", "-D", "leak"]);
    writeFileSync(join(workspace, "new.txt"), "unapproved future"); commit(workspace, "future"); assert.throws(() => verifyClippedHistory(workspace, base), /beyond base/);
  }
});
test("recipe mismatch and transcript history probing invalidate complete Codex rows", async (t) => {
  const root = temp(t), f = fixture(root), workspace = join(root, "work"), task = { ...f.suite.tasks[0], hiddenTests: null };
  const semantic = { withMex: true, withCli: true, withHooks: true, semantic: true };
  createWorkspace({ subjectRoot: f.subject, workspace, base: f.base, scaffoldCommit: f.scaffold, agent: "codex" });
  installProductHooks({ workspace, cliBin: f.cliBin, env: { ...process.env, MEX_HOOK_LEXICAL: "1" }, tool: "codex" });
  const env = sessionEnv({ baseEnv: { ...process.env, CODEX_HOME: f.home }, cliBin: f.cliBin, armSpec: semantic });
  const row = await runAgentSession({ task, armId: "mex-r3", armSpec: semantic, workspace, env, cliBin: f.cliBin, agent: "codex", model: "gpt-6.1-sol", effort: "high", codexCommand: [process.execPath, fake], outputPrefix: join(root, "mismatch") });
  assert.equal(row.valid, false); assert.ok(row.violations.includes("semantic arm fell back to the lexical recipe")); assert.ok(row.violations.includes("semantic recipe not verified in hook log"));
  const files = join(root, "files"); createWorkspace({ subjectRoot: f.subject, workspace: files, base: f.base, agent: "codex" });
  const probe = await runAgentSession({ task, armId: "files", armSpec: { withMex: false, withCli: false }, workspace: files, env: { ...process.env, CODEX_HOME: f.home, FAKE_CODEX_HISTORY_PROBE: "1" }, agent: "codex", model: "gpt-6.1-sol", codexCommand: [process.execPath, fake], outputPrefix: join(root, "probe") });
  assert.equal(probe.valid, false); assert.ok(probe.violations.some((v) => v.startsWith("history probe:")));
});
test("graph comparison records every table and detects missing or changed rows", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = temp(t), a = join(root, "a.db"), b = join(root, "b.db");
  for (const path of [a, b]) { const db = new DatabaseSync(path); db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY, body TEXT); INSERT INTO nodes VALUES('one','body'); CREATE TABLE metadata(key TEXT, value TEXT)"); db.close(); }
  assert.equal((await compareGraphTables(a, b)).equal, true);
  const db = new DatabaseSync(b); db.exec("UPDATE nodes SET body='changed'; CREATE TABLE extra(id TEXT)"); db.close();
  const comparison = await compareGraphTables(a, b); assert.equal(comparison.equal, false); assert.deepEqual(comparison.tables.map((t) => [t.name, t.equal]), [["extra", false], ["metadata", true], ["nodes", false]]);
});
test("resource parsers, guard waiting without killing, process-tree RSS and live sampler", async (t) => {
  assert.equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 3.\n'), 33 * 16384);
  assert.equal(parseMeminfo("MemTotal: 999 kB\nMemAvailable: 1234 kB\n"), 1234 * 1024);
  assert.throws(() => parseMeminfo("MemFree: 1 kB")); assert.throws(() => parseVmStat("bad"));
  const table = parseProcessTable("1 0 10 init\n2 1 20 child\n3 2 30 grandchild\n4 0 90 other\n"); assert.equal(treeRss(table, 1), 60 * 1024);
  let snapshots = 0, waits = 0; const logs = [];
  await resourceGuard({ path: ".", label: "fixture", minRamGB: 1, minDiskGB: 1, snapshot: () => ({ availableRam: ++snapshots === 1 ? 0 : 2 ** 32, freeDisk: 2 ** 33 }), sleep: async () => waits++, log: (s) => logs.push(s) }); assert.equal(waits, 1); assert.ok(logs[0].includes("waiting"));
  const root = temp(t), csv = join(root, "samples.csv"), sampler = startSampler({ path: root, csv, intervalMs: 100 });
  const summary = await sampler.stop(); assert.ok(summary.samples >= 1, summary.error); assert.ok(summary.peakRss > 0); assert.ok(summary.minFreeDisk > 0);
  assert.throws(() => removeOwnedTree(root, root), /escaped/);
});
test("scaffold capture excludes local databases and credentials and leaves subject checkout/index untouched", (t) => {
  const root = temp(t), f = fixture(root); mkdirSync(join(f.subject, ".mex/local")); writeFileSync(join(f.subject, ".mex/local/private"), "excluded"); writeFileSync(join(f.subject, ".mex/graph.db"), "excluded");
  const before = git(f.subject, ["status", "--porcelain"]).stdout, head = resolveCommit(f.subject, "HEAD");
  const captured = captureScaffold({ workspace: f.subject, subject: f.subject, ref: "refs/eval/scaffold-test" });
  assert.ok(captured.files.includes("AGENTS.md")); assert.ok(!captured.files.some((p) => /local|graph.db/.test(p))); assert.equal(resolveCommit(f.subject, "HEAD"), head); assert.equal(git(f.subject, ["status", "--porcelain"]).stdout, before);
  assert.throws(() => captureScaffold({ workspace: f.subject, subject: f.subject, ref: "refs/eval/scaffold-test" }), /already exists/);
});
test("portable suite preserves 13 task bases and hidden selections; all three arms and pilot overrides are scheduled", () => {
  const suite = JSON.parse(readFileSync(new URL("../suites/novu-codex.json", import.meta.url)));
  assert.equal(suite.tasks.length, 13); assert.equal(selectedSchedule(suite).length, 39); assert.equal(selectedSchedule(suite, { tasks: suite.pilotTasks }).length, 6);
  for (const t of suite.tasks) { assert.ok(!JSON.stringify(t.hiddenTests.command).includes("C:")); assert.ok(t.hiddenTests.command.includes("{node}")); }
});
test("pipeline prepares, runs, grades, reports, enforces lexical switches/env, resumes rows, and cleans all big state", async (t) => {
  const root = temp(t), f = fixture(root, { twoBases: true });
  const previous = { CODEX_HOME: process.env.CODEX_HOME, FAKE_CODEX_FIXES: process.env.FAKE_CODEX_FIXES, FAKE_CODEX_INVALID: process.env.FAKE_CODEX_INVALID };
  Object.assign(process.env, { CODEX_HOME: f.home, FAKE_CODEX_FIXES: f.fixes });
  t.after(() => { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  // A deliberate invalid terminal answer leaves diagnostic rows; a reboot-like resume retains valid rows.
  process.env.FAKE_CODEX_INVALID = "1";
  await assert.rejects(() => main(["--pipeline", ...f.common]), /invalid rows/);
  delete process.env.FAKE_CODEX_INVALID;
  assert.equal(existsSync(join(f.output, "ws")), false); assert.equal(existsSync(join(f.output, "temp")), false);
  // Simulate a finished row from the interrupted run and prove it is not launched again.
  const firstRowFile = readdirSync(join(f.output, "runs")).find((n) => n.endsWith(".json"));
  const first = JSON.parse(readFileSync(join(f.output, "runs", firstRowFile)));
  const last = join(f.output, "artifacts", `${first.runId}.last-message.json`);
  writeFileSync(last, JSON.stringify({ summary: "Fixture terminal answer restored for resume verification.", filesChanged: ["fixture.cjs"], testsRun: "Targeted hidden oracle passed." }));
  first.valid = true; first.violations = []; writeFileSync(join(f.output, "runs", firstRowFile), JSON.stringify(first));
  const firstBytes = readFileSync(join(f.output, "runs", firstRowFile), "utf8");
  mkdirSync(join(f.output, "artifacts", "orphan.codex-home")); writeFileSync(join(f.output, "artifacts", "orphan.codex-home", "auth.json"), "orphan credential copy");
  await main(["--pipeline", "--resume", ...f.common]);
  const rows = loadRows(f.output, f.suite); assert.equal(rows.length, 6); assert.ok(rows.every((r) => r.valid && r.hiddenTests.ok), JSON.stringify(rows.map((r) => r.violations)));
  const preserved = JSON.parse(readFileSync(join(f.output, "runs", firstRowFile))); assert.equal(preserved.execution.restartCount, first.execution.restartCount);
  for (const row of rows) {
    assert.equal(row.metrics.costUsd, null); assert.equal(row.independence.history.objectClosureVerified, true);
    if (row.arm !== "files") {
      const log = readFileSync(join(f.output, "artifacts", `${row.runId}.context-log.jsonl`), "utf8").trim().split(/\r?\n/).map(JSON.parse);
      const prompt = log.find((e) => e.event === "prompt"); assert.equal(prompt.lexicalSwitch, row.arm === "mex-r2w"); assert.equal(prompt.lexicalEnv, row.arm === "mex-r2w" ? "1" : null);
    }
  }
  for (const dir of ["ws", "temp", "index-cache", "chain", "instruction-check"]) assert.equal(existsSync(join(f.output, dir)), false, dir);
  assert.ok(!readdirSync(join(f.output, "artifacts")).some((n) => n.endsWith(".codex-home")));
  assert.ok(readFileSync(join(f.output, "report.md"), "utf8").includes("No dollar cost"));
  const attempts = rows.map((r) => r.execution.restartCount); await main(["--pipeline", "--resume", ...f.common]); assert.deepEqual(loadRows(f.output).map((r) => r.execution.restartCount), attempts);
  await assert.rejects(() => main(["--pipeline", "--resume", "--effort", "xhigh", ...f.common]), /configuration changed/);
});
