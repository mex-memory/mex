// One agent session in a prepared checkout, plus its post-session measurements.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAdapter } from "../../adapters/agents/claude.mjs";
import { ANSWER_SCHEMA } from "../../compare/lib/answer.mjs";
import { runSync, runTimed } from "../../compare/lib/process.mjs";
import { forcedCompliance, summarizeCalls } from "./classify.mjs";
import { git, runMex } from "./workspace.mjs";

export const CHANGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 20, description: "What you changed and why." },
    filesChanged: { type: "array", items: { type: "string", minLength: 1 }, description: "Repository-relative paths you changed." },
    testsRun: { type: "string", description: "The test commands you ran and their outcome." },
  },
  required: ["summary", "filesChanged", "testsRun"],
};

const QA_SUFFIX = "\n\nAnswer from the repository in the current directory. Return the required JSON: answer, symbols (exact declaration names), evidence (repository-relative path and line) and complete.";
const CHANGE_SUFFIX = "\n\nMake the change in the repository in the current directory. Do not commit. When you are done, return the required JSON: a summary, the files you changed, and the tests you ran.";

// Prompt policies for the MEX arm. "none" tests unprompted adoption: the
// scaffold's CLAUDE.md is the only pointer. "steered" names MEX in the prompt,
// as evaluate/compare's forced-first graph arm did. The files arm never sees it.
// "forced" orders the work: routed knowledge first, then Scope before any
// source read; compliance is checked from the transcript afterwards.
export const MEX_PROMPTS = ["none", "steered", "forced"];
const MEX_FORCE_COMMON = "This repository has MEX installed: project knowledge in `.mex/` and a CLI, `mex`, on PATH. Work in this order. First, read `.mex/ROUTER.md`. Then find the relevant knowledge with `mex wiki query \"<key terms>\"` and read the facts you need with `mex wiki show <id>`; they explain how this code works. Do not skip this step. Only then run `mex graph scope \"<task>\"` before reading or searching any source file. When you know an exact symbol name, use `mex graph query <where-defined|who-calls|what-calls> <symbol>` and `mex graph get <id...>`. Treat source returned by the graph as already read.";
const MEX_FORCE_CHANGE = " Before editing, run `mex impact <symbol|file>` for what you will change. After your change, run `mex graph refresh` and then `mex check`, and update any `.mex` knowledge that drifted.";
const MEX_STEER_COMMON = "This repository has MEX installed: project knowledge in `.mex/` (start at `.mex/ROUTER.md` and read the files it routes you to) and a code graph CLI, `mex`, on PATH. Start with `mex graph scope \"<task>\"`. When you know an exact symbol name, use `mex graph query <where-defined|who-calls|what-calls> <symbol>` and `mex graph get <id...>`. Treat source returned by the graph as already read.";
const MEX_STEER_CHANGE = " Before editing a symbol, run `mex impact <symbol|file>`. After your change, run `mex graph refresh` and then `mex check` to see whether any `.mex` knowledge drifted.";

export function buildPrompt(task, { mexPrompt = "none", withMex = false } = {}) {
  const change = task.type === "change";
  const steer = !withMex ? ""
    : mexPrompt === "steered" ? `\n\n${MEX_STEER_COMMON}${change ? MEX_STEER_CHANGE : ""}`
    : mexPrompt === "forced" ? `\n\n${MEX_FORCE_COMMON}${change ? MEX_FORCE_CHANGE : ""}`
    : "";
  return `${task.prompt}${steer}${task.type === "change" ? CHANGE_SUFFIX : QA_SUFFIX}`;
}

export function claudeInvocation({ task, model, claudeCommand = ["claude"], mexPrompt = "none", withMex = false }) {
  const tools = task.type === "change" ? ["Read", "Grep", "Glob", "Bash", "Edit", "Write"] : ["Read", "Grep", "Glob", "Bash"];
  const [command, ...prefix] = claudeCommand;
  return {
    command,
    args: [
      ...prefix,
      "-p", buildPrompt(task, { mexPrompt, withMex }),
      "--output-format", "stream-json", "--verbose",
      // Project sources load the checkout's CLAUDE.md (the MEX arm's entry
      // point); user settings, plugins and hooks stay out of both arms.
      "--setting-sources", "project",
      "--strict-mcp-config", "--no-chrome", "--disable-slash-commands",
      "--no-session-persistence", "--exclude-dynamic-system-prompt-sections",
      "--permission-mode", "dontAsk",
      "--model", model,
      "--json-schema", JSON.stringify(task.type === "change" ? CHANGE_SCHEMA : ANSWER_SCHEMA),
      "--tools", tools.join(","),
      "--allowedTools", ...tools,
    ],
  };
}

/**
 * Added grounding lines (fingerprint, bodyHash, codeHash, node) in the .mex part
 * of a patch, however they were written: Edit, sed, a script or `mex sync`.
 */
export function groundingLinesChanged(patch) {
  let inKnowledge = false, count = 0;
  for (const line of String(patch ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) inKnowledge = / a\/\.mex\//.test(line);
    else if (inKnowledge && /^\+\s*(?:-\s*)?(?:fingerprint|bodyHash|codeHash|node):/.test(line)) count += 1;
  }
  return count;
}

function parseChangeResult(raw) {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return { ok: false, error: "change result is not JSON", value: null }; }
  }
  const ok = value && typeof value === "object" && typeof value.summary === "string" && Array.isArray(value.filesChanged);
  return ok ? { ok: true, value } : { ok: false, error: "change result does not match the schema", value: null };
}

function vitestCounts(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const line = clean.match(/Tests\s+([^\n]+)/)?.[1] ?? "";
  const pick = (word) => Number(line.match(new RegExp(`(\\d+)\\s+${word}`))?.[1] ?? 0);
  return { passed: pick("passed"), failed: pick("failed"), total: Number(line.match(/\((\d+)\)/)?.[1] ?? 0) };
}

/** Restore the hidden tests over the agent's version and run them. */
export function runHiddenTests(workspace, hiddenTests, env) {
  if (!hiddenTests) return null;
  if (hiddenTests.fromCommit) git(workspace, ["checkout", hiddenTests.fromCommit, "--", ...hiddenTests.files]);
  const vitest = join(workspace, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) return { ok: false, error: "vitest is not installed in the workspace" };
  const result = runSync(process.execPath, [vitest, "--run", "--coverage.enabled=false", ...hiddenTests.files], { cwd: workspace, env });
  const counts = vitestCounts(`${result.stdout}\n${result.stderr}`);
  return { ok: result.code === 0 && counts.failed === 0 && counts.passed > 0, exitCode: result.code, ...counts, output: `${result.stdout}\n${result.stderr}`.slice(-20_000) };
}

function agentDiff(workspace) {
  git(workspace, ["add", "-A"]);
  const nameStatus = git(workspace, ["diff", "--cached", "--name-status", "HEAD"]).stdout.trim();
  const patch = git(workspace, ["diff", "--cached", "HEAD"]).stdout;
  const files = nameStatus ? nameStatus.split("\n").map((line) => line.split("\t").slice(1).join("\t")) : [];
  return { files, patch };
}

function summarizeCheck(stdout) {
  try {
    const report = JSON.parse(stdout);
    const counts = {};
    for (const issue of report.issues ?? []) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    const grounding = (report.issues ?? []).filter((issue) => String(issue.code).startsWith("GROUNDING_"))
      .map(({ code, severity, file, message }) => ({ code, severity, file, message }));
    return { score: report.score ?? null, counts, grounding };
  } catch {
    return { score: null, counts: {}, grounding: [], error: "mex check output was not JSON" };
  }
}

/**
 * Run one session. `armSpec.withMex` decides the scaffold and `armSpec.withCli`
 * the frozen CLI on PATH (defaulting to the scaffold); policy is
 * validated afterwards from the transcript, as nothing can enforce it inside
 * the session.
 */
export async function runAgentSession({ task, armId, armSpec, workspace, env, cliBin, model, timeoutMs, outputPrefix, claudeCommand, mexPrompt = "none" }) {
  const invocation = claudeInvocation({ task, model, claudeCommand, mexPrompt, withMex: armSpec.withMex });
  const processResult = await runTimed(invocation.command, invocation.args, { cwd: workspace, env, timeoutMs });
  writeFileSync(`${outputPrefix}.jsonl`, processResult.stdout);
  const parsed = claudeAdapter.parseTranscript(processResult.stdout, { ...task, gold: [] });
  const calls = summarizeCalls(parsed.toolCalls, workspace);
  writeFileSync(`${outputPrefix}.calls.json`, `${JSON.stringify(calls.classified, null, 2)}\n`);

  const violations = [];
  if (processResult.timedOut) violations.push("session timeout");
  if (processResult.code !== 0) violations.push(`agent exited ${processResult.code}`);
  if (parsed.malformedLines) violations.push(`${parsed.malformedLines} malformed stream line(s)`);
  if (!parsed.usage.accountingValid) violations.push(`token accounting: ${parsed.usage.accountingReason}`);
  if (calls.npxMex) violations.push("npx mex-agent invoked (unpinned CLI)");
  const withCli = armSpec.withCli ?? armSpec.withMex;
  if (armSpec.withMex && !withCli) {
    const cliCalls = calls.classified.filter((entry) => entry.category.startsWith("mex:"));
    if (cliCalls.length) violations.push(`markdown-only arm invoked the mex CLI ${cliCalls.length} time(s)`);
  }
  if (!armSpec.withMex) {
    const leaked = calls.classified.filter((entry) => entry.category.startsWith("mex:") || entry.category.startsWith("knowledge-"));
    if (leaked.length) violations.push(`files arm used MEX ${leaked.length} time(s)`);
  }
  const outsideReads = calls.classified.filter((entry) => entry.outside && /hono-mex|[\\/]\.mex[\\/]|mex-test-tmp[\\/]arm/i.test(entry.path ?? ""));
  if (outsideReads.length) violations.push(`${outsideReads.length} call(s) touched another checkout`);

  let result;
  if (task.type === "change") {
    const structured = parseChangeResult(parsed.rawResult);
    if (!structured.ok) violations.push(structured.error);
    result = { change: structured.value };
  } else {
    if (!parsed.structured.ok) violations.push(parsed.structured.error);
    result = { answer: parsed.structured.ok ? parsed.structured.value : null };
  }

  const diff = agentDiff(workspace);
  writeFileSync(`${outputPrefix}.patch`, diff.patch);
  let mexCheck = null;
  if (withCli) {
    runMex(cliBin, ["graph", "refresh"], workspace, env);
    const check = runMex(cliBin, ["check", "--json"], workspace, env);
    writeFileSync(`${outputPrefix}.check.json`, check.stdout);
    mexCheck = summarizeCheck(check.stdout);
  }
  const hiddenTests = task.type === "change" ? runHiddenTests(workspace, task.hiddenTests, env) : null;
  if (hiddenTests?.output) writeFileSync(`${outputPrefix}.tests.txt`, hiddenTests.output);

  const usage = parsed.usage;
  return {
    agent: "claude",
    process: { code: processResult.code, signal: processResult.signal, timedOut: processResult.timedOut, elapsedMs: processResult.elapsedMs, stderr: String(processResult.stderr ?? "").slice(-4000) },
    providerFailure: parsed.providerFailure ?? null,
    metrics: {
      newTokens: usage.newTokens, processed: usage.reportedTotal, uncachedInput: usage.uncachedInput,
      cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead, output: usage.output,
      cacheUseRatio: usage.cacheUseRatio, costUsd: usage.reportedCostUsd,
      elapsedMs: processResult.elapsedMs, turns: parsed.turns, toolCalls: calls.totalCalls,
      mexCalls: calls.mexCalls, fallbacks: calls.fallbacks, handHashEdits: calls.handHashEdits,
      // False in the MEX arm means the agent never touched the scaffold or CLI;
      // check the pilot for this before trusting the instructions were loaded.
      mexEngaged: calls.classified.some((entry) => entry.category.startsWith("mex:") || entry.category.startsWith("knowledge-")),
      permissionDenials: parsed.permissionDenials,
    },
    allocation: calls.allocation,
    compliance: armSpec.withMex && mexPrompt === "forced" ? forcedCompliance(parsed.toolCalls, task.type) : null,
    ...result,
    diff: { files: diff.files, knowledgeFiles: diff.files.filter((file) => file.startsWith(".mex/")), groundingLinesChanged: groundingLinesChanged(diff.patch) },
    hiddenTests: hiddenTests ? { ok: hiddenTests.ok, exitCode: hiddenTests.exitCode, passed: hiddenTests.passed, failed: hiddenTests.failed, total: hiddenTests.total, error: hiddenTests.error ?? null } : null,
    mexCheck,
    valid: violations.length === 0,
    violations,
  };
}
