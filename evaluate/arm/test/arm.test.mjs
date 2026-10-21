import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { classifyBash, classifyCall, forcedCompliance, isHandHashEdit, summarizeCalls } from "../lib/classify.mjs";
import { bootstrapMean, buildBlindReview } from "../lib/report.mjs";
import { buildPrompt, claudeInvocation, groundingLinesChanged } from "../lib/session.mjs";
import { armPath, createWorkspace, git, removeWorkspace } from "../lib/workspace.mjs";
import { armSpecFor, parseArgs } from "../index.mjs";

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
  assert.match(change.args[change.args.indexOf("--append-system-prompt") + 1], /Do not commit/);
  assert.ok(!qa.args.some((arg) => /mex/i.test(arg)), "prompts and flags never mention MEX");
});

test("the steered policy names MEX only in the MEX arm's prompt", () => {
  const qa = { type: "qa", prompt: "Why?" }, change = { type: "change", prompt: "Fix" };
  assert.match(buildPrompt(qa, { mexPrompt: "steered", withMex: true }), /mex graph scope/);
  assert.doesNotMatch(buildPrompt(qa, { mexPrompt: "steered", withMex: true }), /mex impact/);
  assert.match(buildPrompt(change, { mexPrompt: "steered", withMex: true }), /mex impact/);
  assert.doesNotMatch(buildPrompt(change, { mexPrompt: "steered", withMex: false }), /mex/i);
  assert.doesNotMatch(buildPrompt(change, { mexPrompt: "none", withMex: true }), /mex/i);
  assert.match(buildPrompt(qa, { mexPrompt: "forced", withMex: true }), /First, read `\.mex\/ROUTER\.md`[\s\S]*before reading or searching any source file/);
  assert.doesNotMatch(buildPrompt(change, { mexPrompt: "forced", withMex: false }), /mex/i);
});

test("forced compliance follows the prescribed order, splitting shell lines", () => {
  const bash = (command) => ({ name: "Bash", input: { command } });
  const read = (file_path) => ({ name: "Read", input: { file_path } });
  const good = [
    bash("cat .mex/ROUTER.md; mex logging --json"), read("C:/ws/.mex/patterns/debug-request-pipeline.md"),
    bash('mex graph scope "compose errors"'), read("C:/ws/src/compose.ts"),
    bash("mex impact compose"), { name: "Edit", input: { file_path: "C:/ws/src/compose.ts" } },
    bash("npx vitest --run src/compose.test.ts; mex graph refresh; mex check"),
  ];
  assert.deepEqual(forcedCompliance(good, "change"), { routerRead: true, knowledgeConsulted: true, scopeBeforeSource: true, impactBeforeEdit: true, checkAfterEdit: true, compliant: true });
  const sourceFirst = [read("C:/ws/.mex/ROUTER.md"), bash('grep -n compose src/hono-base.ts; mex graph scope "x"')];
  assert.deepEqual(forcedCompliance(sourceFirst, "qa"), { routerRead: true, knowledgeConsulted: false, scopeBeforeSource: false, compliant: false });
  const grepped = [{ name: "Grep", input: { pattern: "HTTPException", path: ".mex/context" } }, bash('mex graph scope "errors"')];
  assert.equal(forcedCompliance(grepped, "qa").knowledgeConsulted, true);
  assert.equal(forcedCompliance([bash("cd .mex/context; grep -n onError conventions.md decisions.md"), bash('mex graph scope "x"')], "qa").knowledgeConsulted, true);
  assert.equal(forcedCompliance([read("C:/ws/.mex/AGENTS.md"), bash("cat .mex/ROUTER.md")], "qa").knowledgeConsulted, false);
  const wiki = [bash("cat .mex/ROUTER.md"), bash('mex wiki query "dispatch compose"; mex wiki show mx_1'), bash('mex graph scope "x"')];
  assert.deepEqual(forcedCompliance(wiki, "qa"), { routerRead: true, knowledgeConsulted: true, scopeBeforeSource: true, compliant: true });
  const docsFirst = [bash('mex wiki show mx_1; grep -rn compose docs README.md'), bash('mex graph scope "x"'), read("C:/ws/src/compose.ts")];
  assert.equal(forcedCompliance(docsFirst, "qa").scopeBeforeSource, true, "a docs-only search is not a source read");
  const scriptEdit = [bash("mex impact compose"), bash("python - <<'E'\nopen('src/compose.ts','w').write(s)\nE"), bash("mex check")];
  const result = forcedCompliance(scriptEdit, "change");
  assert.equal(result.impactBeforeEdit, true);
  assert.equal(result.checkAfterEdit, true);
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
    assert.equal(readFileSync(join(files, "CLAUDE.md"), "utf8").trim(), "managed");
    assert.equal(readFileSync(join(mex, ".mex", "ROUTER.md"), "utf8").replace(/\r\n/g, "\n"), "# router\n", "line endings follow the machine");
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

test("grounding lines are counted only in the .mex part of a patch", () => {
  const patch = [
    "diff --git a/.mex/context/architecture.md b/.mex/context/architecture.md",
    "-      fingerprint: mh2:64:old", "+      fingerprint: mh2:64:new", "+      bodyHash: abc", "+  - file: src/compose.ts", "+    node: function:1",
    "diff --git a/src/compose.ts b/src/compose.ts",
    "+// fingerprint: not knowledge",
  ].join("\n");
  assert.equal(groundingLinesChanged(patch), 3);
  assert.equal(groundingLinesChanged(""), 0);
});

test("arm specs separate the scaffold from the CLI", () => {
  const pick = ({ withMex, withCli }) => ({ withMex, withCli });
  assert.deepEqual(pick(armSpecFor({ scaffold: false })), { withMex: false, withCli: false });
  assert.deepEqual(pick(armSpecFor({ scaffold: true })), { withMex: true, withCli: true });
  assert.deepEqual(pick(armSpecFor({ scaffold: true, cli: false })), { withMex: true, withCli: false });
});
