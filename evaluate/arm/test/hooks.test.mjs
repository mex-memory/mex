import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { aliasCoverage, anyHookEntries, managedHookCommands, summarizeContextLog, waitForSettle } from "../lib/hooks.mjs";
import { generateReport } from "../lib/report.mjs";
import { appendedInstruction, buildPrompt, claudeInvocation, djangoCounts, runHiddenTests } from "../lib/session.mjs";
import { createWorkspace, git, removeWorkspace } from "../lib/workspace.mjs";
import { armSpecFor, projectNameOf, sessionEnv } from "../index.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "arm-hooks-"));

test("Django summaries become passed, failed and total", () => {
  assert.deepEqual(djangoCounts("Found 5 test(s).\nRan 5 tests in 0.012s\n\nOK\n"), { passed: 5, failed: 0, skipped: 0, total: 5, status: "OK" });
  assert.deepEqual(djangoCounts("Ran 6 tests in 1.2s\n\nFAILED (failures=2, errors=1, skipped=1)\n"), { passed: 2, failed: 3, skipped: 1, total: 6, status: "FAILED" });
  assert.deepEqual(djangoCounts("Ran 4 tests in 0.1s\n\nOK (skipped=1)\n"), { passed: 3, failed: 0, skipped: 1, total: 4, status: "OK" });
  assert.deepEqual(djangoCounts("Ran 3 tests in 0.1s\n\nOK (expected failures=1)\n"), { passed: 3, failed: 0, skipped: 0, total: 3, status: "OK" });
  assert.deepEqual(djangoCounts("Ran 1 test in 0.0s\n\nFAILED (errors=1)\n"), { passed: 0, failed: 1, skipped: 0, total: 1, status: "FAILED" });
  assert.equal(djangoCounts("ImportError: no module\n").total, 0);
});

test("the Django runner restores the hidden files, passes the labels and parses the result", () => {
  const root = tmp();
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "tests"), { recursive: true });
    git(root, ["init", "-q", repo]);
    // Node runs any file as a script, so a JS file stands in for tests/runtests.py and the Node binary for Python.
    const script = (summary) => `console.log(JSON.stringify({ argv: process.argv.slice(2), pythonpath: process.env.PYTHONPATH, cwd: process.cwd() })); console.error(${JSON.stringify(summary)}); process.exit(${summary.includes("FAILED") ? 1 : 0});\n`;
    writeFileSync(join(repo, "tests", "runtests.py"), script("Ran 3 tests in 0.1s\n\nFAILED (failures=1)"));
    writeFileSync(join(repo, "tests", "hidden.py"), "agent version\n");
    git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "base"]);
    writeFileSync(join(repo, "tests", "runtests.py"), script("Ran 3 tests in 0.1s\n\nOK"));
    writeFileSync(join(repo, "tests", "hidden.py"), "upstream version\n");
    git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "merge"]);
    const merge = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    git(repo, ["checkout", "-q", "HEAD~1", "--", "tests/runtests.py"]);

    const spec = { runner: "django", python: process.execPath, tests: "queries.tests.X composite_pk.test_filter", fromCommit: merge, files: ["tests/hidden.py"] };
    const failed = runHiddenTests(repo, spec, process.env);
    assert.equal(readFileSync(join(repo, "tests", "hidden.py"), "utf8"), "upstream version\n", "hidden files come from the upstream commit");
    assert.deepEqual([failed.ok, failed.passed, failed.failed, failed.total], [false, 2, 1, 3]);
    assert.match(failed.output, /"argv":\["queries\.tests\.X","composite_pk\.test_filter","--parallel","1"\]/);
    assert.match(failed.output, /"pythonpath":".*repo"/);

    git(repo, ["checkout", "-q", merge, "--", "tests/runtests.py"]);
    const passed = runHiddenTests(repo, spec, process.env);
    assert.deepEqual([passed.ok, passed.passed, passed.failed, passed.total], [true, 3, 0, 3]);
    assert.equal(runHiddenTests(repo, { ...spec, python: join(root, "missing.exe") }, process.env).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hooks arms are validated and get exactly the environment they are meant to have", () => {
  assert.deepEqual(armSpecFor({ scaffold: false }), { withMex: false, withCli: false, withPush: false, withHooks: false, lexical: false, semantic: false });
  const r2w = armSpecFor({ scaffold: true, hooks: true, lexical: true });
  const r3 = armSpecFor({ scaffold: true, hooks: true, semantic: true });
  assert.equal(r2w.withHooks && r2w.lexical && !r2w.semantic, true);
  assert.equal(r3.withHooks && r3.semantic && !r3.lexical, true);
  assert.throws(() => armSpecFor({ scaffold: false, hooks: true }), /needs the scaffold/);
  assert.throws(() => armSpecFor({ scaffold: true, lexical: true }), /only apply to hooks arms/);
  assert.throws(() => armSpecFor({ scaffold: true, hooks: true, lexical: true, semantic: true }), /not both/);

  const base = { PATH: ["C:\\Windows", "C:\\Users\\u\\AppData\\Roaming\\npm"].join(delimiter), MEX_HOOK_LEXICAL: "1", MEX_CLI: "stale", MEX_PUSH_LOG: "x" };
  const cliBin = "C:\\cli\\node_modules\\.bin";
  const files = sessionEnv({ baseEnv: base, cliBin, armSpec: armSpecFor({ scaffold: false }) });
  assert.equal(files.PATH.includes(cliBin), false);
  assert.deepEqual(["MEX_HOOK_LEXICAL", "MEX_CLI", "MEX_PUSH_LOG"].map((name) => name in files), [false, false, false], "ambient hook variables never reach the files arm");
  const lexical = sessionEnv({ baseEnv: { PATH: base.PATH }, cliBin, armSpec: r2w });
  assert.equal(lexical.PATH.split(delimiter)[0], cliBin, "the frozen bin comes first");
  assert.equal(lexical.MEX_HOOK_LEXICAL, "1");
  assert.match(lexical.MEX_CLI.replace(/\\/g, "/"), /\/mex-agent\/dist\/cli\.js$/);
  const semantic = sessionEnv({ baseEnv: base, cliBin, armSpec: r3 });
  assert.equal("MEX_HOOK_LEXICAL" in semantic, false, "the semantic arm never inherits the lexical switch");
  assert.ok(semantic.MEX_CLI.length > 0 && semantic.MEX_CLI !== "stale");
  assert.equal(projectNameOf({}), "project");
  assert.equal(projectNameOf({ projectName: "hono" }), "hono");
});

test("every arm gets the same appended instruction, and it never mentions MEX", () => {
  const appendPrompt = { qa: "Keep the answer concise.", change: "Keep the summary concise." };
  const qa = { type: "qa", prompt: "Why?" }, change = { type: "change", prompt: "Fix" };
  for (const withMex of [false, true]) {
    assert.match(buildPrompt(qa, { withMex, appendPrompt }), /Keep the answer concise\.$/);
    assert.match(buildPrompt(change, { withMex, appendPrompt }), /Keep the summary concise\.$/);
  }
  assert.equal(buildPrompt(qa, { withMex: false, appendPrompt }), buildPrompt(qa, { withMex: true, appendPrompt }));
  assert.equal(appendedInstruction("Short.", qa), "\n\nShort.");
  assert.equal(appendedInstruction(null, qa), "");
  assert.doesNotMatch(claudeInvocation({ task: qa, model: "m", appendPrompt }).args.join(" "), /mex/i);
});

test("the prototype hooks leave a hooks checkout, but a scaffold from setup is kept", () => {
  const root = tmp();
  try {
    const subject = join(root, "subject");
    mkdirSync(subject, { recursive: true });
    git(root, ["init", "-q", subject]);
    writeFileSync(join(subject, "a.txt"), "a\n");
    git(subject, ["add", "-A"]); git(subject, ["commit", "-qm", "base"]);
    const base = git(subject, ["rev-parse", "HEAD"]).stdout.trim();
    const scaffold = (name, claudeMd, withPrototype) => {
      mkdirSync(join(subject, ".mex"), { recursive: true });
      mkdirSync(join(subject, ".claude", "hooks"), { recursive: true });
      writeFileSync(join(subject, ".mex", "ROUTER.md"), "# router\n");
      writeFileSync(join(subject, ".claude", "skills.txt"), "skill\n");
      if (withPrototype) {
        writeFileSync(join(subject, ".claude", "hooks", "mex-push.mjs"), "// prototype\n");
        writeFileSync(join(subject, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node .claude/hooks/mex-push.mjs stop" }] }] } }));
      }
      writeFileSync(join(subject, "CLAUDE.md"), claudeMd);
      git(subject, ["add", "-A"]); git(subject, ["commit", "-qm", name]);
      return git(subject, ["rev-parse", "HEAD"]).stdout.trim();
    };
    const prototype = scaffold("prototype", "<!-- mex-agent:skills:start -->\nEntries are shown to you automatically.\n<!-- mex-agent:skills:end -->\n", true);
    const stripped = join(root, "ws-stripped");
    createWorkspace({ subjectRoot: subject, workspace: stripped, base, scaffoldCommit: prototype, stripPrototype: true });
    assert.equal(existsSync(join(stripped, ".claude", "hooks", "mex-push.mjs")), false);
    assert.equal(existsSync(join(stripped, ".claude", "settings.json")), false);
    assert.equal(existsSync(join(stripped, "CLAUDE.md")), false, "a file holding only the prototype block goes");
    assert.equal(existsSync(join(stripped, ".claude", "skills.txt")), true, "other scaffold files stay");
    assert.equal(git(stripped, ["status", "--porcelain"]).stdout.trim(), "", "the stripped state is committed");
    const kept = join(root, "ws-kept");
    createWorkspace({ subjectRoot: subject, workspace: kept, base, scaffoldCommit: prototype, stripPrototype: false });
    assert.equal(existsSync(join(kept, ".claude", "hooks", "mex-push.mjs")), true, "other suites keep the prototype");

    const setup = scaffold("setup", "<!-- mex-agent:skills:start -->\n## MEX agent skills\n- Read .mex/AGENTS.md first.\n<!-- mex-agent:skills:end -->\n", false);
    const standard = join(root, "ws-standard");
    createWorkspace({ subjectRoot: subject, workspace: standard, base, scaffoldCommit: setup, stripPrototype: true });
    assert.match(readFileSync(join(standard, "CLAUDE.md"), "utf8"), /Read \.mex\/AGENTS\.md first/);
    for (const workspace of [stripped, kept, standard]) removeWorkspace(subject, workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session folder has the project's name, and its run folder goes with it", () => {
  const root = tmp();
  try {
    const subject = join(root, "subject");
    mkdirSync(subject, { recursive: true });
    git(root, ["init", "-q", subject]);
    writeFileSync(join(subject, "a.txt"), "a\n");
    git(subject, ["add", "-A"]); git(subject, ["commit", "-qm", "base"]);
    const base = git(subject, ["rev-parse", "HEAD"]).stdout.trim();
    const workspace = join(root, "ws", "01-task-r01-files", "hono");
    createWorkspace({ subjectRoot: subject, workspace, base });
    assert.equal(existsSync(join(workspace, "a.txt")), true);
    removeWorkspace(subject, workspace, { removeParent: true });
    assert.equal(existsSync(join(root, "ws", "01-task-r01-files")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hook log becomes per-event counts, budget flags, Stop blocks and settle passes", () => {
  const root = tmp();
  try {
    const path = join(root, "context-log.jsonl");
    const lines = [
      { event: "prompt", ms: 170, injected: 1, ids: ["mx_A"], chars: 700, note: "R3/hybrid", text: "MEX knowledge ..." },
      { event: "read", ms: 25, injected: 2, ids: ["mx_A", "mx_B"], chars: 1000 },
      { event: "grep", ms: 30, injected: 0, ids: [], chars: 0 },
      { event: "edit", ms: 105, injected: 1, ids: ["mx_C"], chars: 800, note: "budget-pointers" },
      { event: "bash", ms: 12, injected: 0, ids: [], chars: 0, note: "unchanged" },
      { event: "stop-block", ms: 150, touched: 1, eligible: [], flagged: ["mx_C"], blocked: true, chars: 300, text: "- mx_C \"title\" ...\nrun `mex context confirm mx_C --session s1`" },
      { event: "stop", ms: 480, touched: 1, eligible: ["mx_C"], flagged: [], settle: "started" },
      { event: "settle", loop: 0, ms: 4000, touched: 1, eligible: 1, flagged: 0, refresh: { code: 0, ms: 3000, mode: "incremental", changed: 1, reextracted: 1 }, reground: { ids: 1, ok: 1, failed: 0, ms: 900 } },
      { event: "settle-refresh-failed", code: 1, ms: 10, stderr: "boom" },
      { event: "error", during: "read", ms: 3, error: "bad" },
    ];
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`);
    const summary = summarizeContextLog(path);
    assert.equal(summary.hookEvents, 7, "tool events and Stop entries; settle and errors are not hook events");
    assert.deepEqual([summary.perEvent.prompt.count, summary.perEvent.read.injected, summary.perEvent.grep.injected, summary.perEvent.stop.count], [1, 1, 0, 2]);
    assert.equal(summary.injectedChars, 700 + 1000 + 800 + 300);
    assert.equal(summary.hookMs, 170 + 25 + 30 + 105 + 12 + 150 + 480);
    assert.equal(summary.budgetHit, true);
    assert.deepEqual(summary.promptNotes, { "R3/hybrid": 1 });
    assert.equal(summary.stopBlocks.count, 1);
    assert.deepEqual(summary.stopBlocks.ids, ["mx_C"]);
    assert.deepEqual(summary.stopEligible, ["mx_C"]);
    assert.equal(summary.settle.regrounded, 1);
    assert.equal(summary.settle.passes[0].refresh.mode, "incremental");
    assert.deepEqual(summary.failures.map((entry) => entry.event), ["settle-refresh-failed", "error"]);
    assert.equal(summary.malformedLines, 1);
    assert.equal(summarizeContextLog(join(root, "absent.jsonl")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the settle wait ignores a missing or stale lock and waits for a live worker", async () => {
  const root = tmp();
  try {
    const local = join(root, ".mex", "local");
    mkdirSync(local, { recursive: true });
    assert.equal((await waitForSettle(root, 2000)).sawWorker, false, "no lock means no worker");
    writeFileSync(join(local, "context-settle.lock"), "2147483000\n");
    const stale = await waitForSettle(root, 2000);
    assert.deepEqual([stale.sawWorker, stale.timedOut], [false, false], "a dead pid is not a worker");
    writeFileSync(join(local, "context-settle.lock"), `${process.pid}\n`);
    setTimeout(() => rmSync(join(local, "context-settle.lock")), 700);
    const live = await waitForSettle(root, 5000);
    assert.equal(live.sawWorker, true);
    assert.equal(live.timedOut, false);
    assert.ok(live.waitMs >= 600);
    writeFileSync(join(local, "context-settle.lock"), `${process.pid}\n`);
    const capped = await waitForSettle(root, 800);
    assert.equal(capped.timedOut, true, "the cap applies");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook entries are found in project settings, MEX's separately from any", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    assert.equal(anyHookEntries(root), 0);
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "mex-hook --mex-managed" }] }],
      PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "mex-hook --mex-managed" }, { type: "command", command: "echo mine" }] }],
    } }));
    assert.equal(anyHookEntries(root), 3);
    assert.deepEqual(managedHookCommands(root).map((entry) => [entry.event, entry.matcher]), [["UserPromptSubmit", null], ["PostToolUse", "Read"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("alias coverage lists the ids a scaffold lacks", () => {
  const root = tmp();
  try {
    const path = join(root, "context-index.json");
    writeFileSync(path, JSON.stringify({ entities: [
      { id: "mx_A", type: "fact", aliases: ["a phrase"] },
      { id: "mx_B", type: "fact", aliases: [] },
      { id: "mx_C", type: "convention", aliases: ["c phrase"] },
    ] }));
    assert.deepEqual(aliasCoverage(path, ["mx_A", "mx_C", "mx_Z"]), { entities: 3, facts: 2, entitiesWithAliases: 2, factsWithAliases: 1, aliasIds: 3, present: 2, missing: ["mx_Z"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the report keeps token kinds apart, adds cost, and shows hook metrics per session", () => {
  const suite = {
    id: "s", tasks: [{ id: "t", type: "qa", prompt: "p" }],
    arms: { files: { scaffold: false }, "mex-r2w": { scaffold: true, hooks: true }, "mex-r3": { scaffold: true, hooks: true } },
  };
  const metrics = (extra) => ({ newTokens: 100, processed: 1000, uncachedInput: 10, cacheWrite: 20, cacheRead: 900, output: 70, costUsd: 0.25, elapsedMs: 5000, turns: 3, toolCalls: 4, mexCalls: 0, fallbacks: 0, handHashEdits: 0, ...extra });
  const hooks = { hookEvents: 5, hookMs: 400, injectedChars: 2100, budgetHit: false, stopBlocks: { count: 1, ids: ["mx_C"] }, failures: [], settle: { count: 1, regrounded: 1, passes: [{ refresh: { mode: "incremental" } }] },
    perEvent: Object.fromEntries(["prompt", "read", "edit", "grep", "bash", "stop"].map((kind) => [kind, { count: 1, injected: 1 }])) };
  const rows = [
    { runId: "01-t-r01-files", taskId: "t", taskType: "qa", arm: "files", repetition: 1, valid: true, metrics: metrics({}), allocation: {} },
    { runId: "01-t-r01-mex-r2w", taskId: "t", taskType: "qa", arm: "mex-r2w", repetition: 1, valid: true, metrics: metrics({ costUsd: 0.2 }), allocation: {}, hooks, settleWait: { waitMs: 12_000 } },
    { runId: "01-t-r01-mex-r3", taskId: "t", taskType: "qa", arm: "mex-r3", repetition: 1, valid: true, metrics: metrics({ costUsd: 0.3 }), allocation: {}, hooks, settleWait: { waitMs: 0 } },
  ];
  const report = generateReport({ suite, rows, salt: "x" });
  assert.match(report, /## Tokens and cost per task and arm/);
  assert.match(report, /\| Input \(uncached\) \| Cache write \| Cache read \| Output \| Cost \(USD\) \|/);
  assert.match(report, /## Paired deltas \(mex-r2w − files\)/);
  assert.match(report, /## Paired deltas \(mex-r3 − files\)/);
  assert.match(report, /## Hooks \(per session\)/);
  assert.match(report, /\| 01-t-r01-mex-r2w \| 1 \(1\) \| 1 \(1\) \| 1 \(1\) \| 1 \(1\) \| 1 \(1\) \| 400 \| 2100 \| no \| 1 \| mx_C \| 1 \| incremental \| 1 \| 0 \| 12\.0 \|/);
  assert.match(report, /0\.300/);
});
