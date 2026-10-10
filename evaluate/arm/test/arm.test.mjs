import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { classifyBash, classifyCall, isHandHashEdit, summarizeCalls } from "../lib/classify.mjs";
import { bootstrapMean, buildBlindReview } from "../lib/report.mjs";
import { buildPrompt, claudeInvocation } from "../lib/session.mjs";
import { armPath, createWorkspace, git, removeWorkspace } from "../lib/workspace.mjs";
import { parseArgs } from "../index.mjs";

test("classifies MEX invocations by subcommand, however they are spelled", () => {
  assert.equal(classifyBash('mex graph scope "router"').category, "mex:scope");
  assert.equal(classifyBash("mex graph get method:abc --detail source").category, "mex:exact");
  assert.equal(classifyBash("cd repo && mex impact compose").category, "mex:impact");
  assert.equal(classifyBash("mex timeline --query x --json").category, "mex:timeline");
  assert.equal(classifyBash("mex wiki query router").category, "mex:wiki");
  assert.equal(classifyBash("mex check --json").category, "mex:maint");
  const npx = classifyBash("npx mex-agent@0.8.3 graph query who-calls compose");
  assert.equal(npx.category, "mex:exact");
  assert.equal(npx.npxMex, true);
});

test("classifies shell reads, discovery, tests and edits", () => {
  assert.equal(classifyBash("cat .mex/ROUTER.md").category, "knowledge-read");
  assert.equal(classifyBash("sed -n 1,40p src/compose.ts").category, "source-read");
  assert.equal(classifyBash('rg -n "compose" src | head').category, "discovery");
  assert.equal(classifyBash("ls .mex/context").category, "knowledge-read");
  assert.equal(classifyBash("npx vitest --run src/compose.test.ts").category, "test");
  assert.equal(classifyBash("sed -i 's/a/b/' src/x.ts").category, "edit");
  assert.equal(classifyBash("git log --oneline -3").category, "other");
});

test("classifies Claude file tools, keeping knowledge separate", () => {
  assert.equal(classifyCall({ name: "Read", input: { file_path: "C:\\w\\.mex\\context\\routing.md" } }).category, "knowledge-read");
  assert.equal(classifyCall({ name: "Read", input: { file_path: "/w/src/hono.ts" } }).category, "source-read");
  assert.equal(classifyCall({ name: "Grep", input: { pattern: "x", path: "src" } }).category, "discovery");
  assert.equal(classifyCall({ name: "Edit", input: { file_path: "/w/.mex/patterns/a.md" } }).category, "knowledge-edit");
  assert.equal(classifyCall({ name: "Write", input: { file_path: "/w/src/a.ts" } }).category, "edit");
});

test("flags hand-written grounding hashes but not prose edits next to them", () => {
  assert.equal(isHandHashEdit({ name: "Edit", input: { file_path: "/w/.mex/a.md", old_string: "x", new_string: "bodyHash: 0123" } }), true);
  assert.equal(isHandHashEdit({ name: "Edit", input: { file_path: "/w/.mex/a.md", old_string: "prose\nbodyHash: 1", new_string: "better prose\nbodyHash: 1" } }), false);
  assert.equal(isHandHashEdit({ name: "Edit", input: { file_path: "/w/src/a.ts", new_string: "bodyHash: 1" } }), false);
  assert.equal(isHandHashEdit({ name: "Bash", input: { command: "sed -i 's/bodyHash: a/bodyHash: b/' .mex/x.md" } }), true);
});

test("counts fallbacks only after the first MEX retrieval", () => {
  const calls = [
    { name: "Read", input: { file_path: "/w/src/early.ts" }, output: "x" },
    { name: "Bash", input: { command: "mex graph scope dispatch" }, output: '{"filePath":"src/hono-base.ts"}' },
    { name: "Read", input: { file_path: "/w/src/hono-base.ts" }, output: "y" },
    { name: "Read", input: { file_path: "/w/src/other.ts" }, output: "z" },
    { name: "Grep", input: { pattern: "x" }, output: "" },
  ];
  const summary = summarizeCalls(calls, "/w");
  assert.equal(summary.mexCalls, 1);
  assert.equal(summary.fallbacks, 2);
  assert.equal(summary.allocation["source-read"].calls, 3);
});

test("arm PATH puts the frozen CLI first and drops the global npm directory", () => {
  const base = ["C:\\Windows", "C:\\Users\\u\\AppData\\Roaming\\npm", "C:\\Users\\u\\.local\\bin"].join(delimiter);
  assert.deepEqual(armPath(base, { cliBin: "C:\\cli\\.bin", withMex: true }).split(delimiter), ["C:\\cli\\.bin", "C:\\Windows", "C:\\Users\\u\\.local\\bin"]);
  assert.deepEqual(armPath(base, { cliBin: "C:\\cli\\.bin", withMex: false }).split(delimiter), ["C:\\Windows", "C:\\Users\\u\\.local\\bin"]);
});

test("invocations give change tasks edit tools and Q&A tasks none", () => {
  const qa = claudeInvocation({ task: { type: "qa", prompt: "Why?" }, model: "m" });
  const change = claudeInvocation({ task: { type: "change", prompt: "Fix" }, model: "m" });
  assert.equal(qa.args[qa.args.indexOf("--tools") + 1], "Read,Grep,Glob,Bash");
  assert.equal(change.args[change.args.indexOf("--tools") + 1], "Read,Grep,Glob,Bash,Edit,Write");
  assert.match(buildPrompt({ type: "change", prompt: "Fix" }), /Do not commit/);
  assert.ok(!qa.args.some((arg) => /mex/i.test(arg)), "prompts and flags never mention MEX");
});

test("the steered policy names MEX only in the MEX arm's prompt", () => {
  const qa = { type: "qa", prompt: "Why?" }, change = { type: "change", prompt: "Fix" };
  assert.match(buildPrompt(qa, { mexPrompt: "steered", withMex: true }), /mex graph scope/);
  assert.doesNotMatch(buildPrompt(qa, { mexPrompt: "steered", withMex: true }), /mex impact/);
  assert.match(buildPrompt(change, { mexPrompt: "steered", withMex: true }), /mex impact[\s\S]*Do not commit/);
  assert.doesNotMatch(buildPrompt(change, { mexPrompt: "steered", withMex: false }), /mex/i);
  assert.doesNotMatch(buildPrompt(change, { mexPrompt: "none", withMex: true }), /mex/i);
});

test("bootstrap interval brackets the mean and is deterministic", () => {
  const values = [-10, -5, -3, 0, 2, -8];
  const a = bootstrapMean(values), b = bootstrapMean(values);
  assert.deepEqual(a, b);
  assert.ok(a.low <= a.mean && a.mean <= a.high);
});

test("blind review hides arm identity", () => {
  const suite = { id: "s", tasks: [{ id: "t", type: "qa", prompt: "p", gold: { answerPoints: ["a"] } }] };
  const rows = [{ runId: "01-t-r01-mex", taskId: "t", arm: "mex", valid: true, answer: { answer: "x" } }];
  const { review, reveal } = buildBlindReview(suite, rows, "salt");
  assert.ok(!JSON.stringify(review).includes("mex\""));
  assert.equal(Object.values(reveal)[0].arm, "mex");
});

test("workspaces add the scaffold only for the MEX arm and leave dependency targets intact", () => {
  const root = mkdtempSync(join(tmpdir(), "arm-ws-"));
  try {
    const subject = join(root, "subject");
    mkdirSync(join(subject, "src"), { recursive: true });
    git(root, ["init", "-q", subject]);
    writeFileSync(join(subject, "src", "a.ts"), "export const a = 1\n");
    writeFileSync(join(subject, ".gitignore"), "node_modules/\n");
    git(subject, ["add", "-A"]); git(subject, ["commit", "-qm", "base"]);
    const base = git(subject, ["rev-parse", "HEAD"]).stdout.trim();
    mkdirSync(join(subject, ".mex"));
    writeFileSync(join(subject, ".mex", "ROUTER.md"), "# router\n");
    writeFileSync(join(subject, "CLAUDE.md"), "managed\n");
    git(subject, ["add", "-A"]); git(subject, ["commit", "-qm", "scaffold"]);
    const scaffold = git(subject, ["rev-parse", "HEAD"]).stdout.trim();
    const deps = join(root, "deps");
    mkdirSync(deps); writeFileSync(join(deps, "keep.txt"), "keep");

    const files = join(root, "ws-files"), mex = join(root, "ws-mex");
    createWorkspace({ subjectRoot: subject, workspace: files, base: scaffold, depsDir: deps });
    createWorkspace({ subjectRoot: subject, workspace: mex, base, scaffoldCommit: scaffold, depsDir: deps });
    assert.equal(existsSync(join(files, ".mex")), false);
    assert.equal(existsSync(join(files, "CLAUDE.md")), false);
    assert.equal(readFileSync(join(mex, ".mex", "ROUTER.md"), "utf8"), "# router\n");
    assert.equal(readFileSync(join(mex, "node_modules", "keep.txt"), "utf8"), "keep");
    assert.equal(git(mex, ["status", "--porcelain"]).stdout.trim(), "");
    removeWorkspace(subject, files); removeWorkspace(subject, mex);
    assert.equal(existsSync(mex), false);
    assert.equal(readFileSync(join(deps, "keep.txt"), "utf8"), "keep", "removing a workspace never deletes the shared dependencies");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argument parsing requires the pinned inputs for --run", () => {
  assert.throws(() => parseArgs(["--run", "--suite", "s.json", "--output", "o"]), /--subject/);
  const args = parseArgs(["--report", "--suite", "s.json", "--output", "o"]);
  assert.equal(args.mode, "report");
});
