// One agent session in a prepared checkout, plus its post-session measurements.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeAdapter } from "../../adapters/agents/claude.mjs";
import { ANSWER_SCHEMA } from "../../compare/lib/answer.mjs";
import { runSync, runTimed } from "../../compare/lib/process.mjs";
import { forcedCompliance, summarizeCalls } from "./classify.mjs";
import { anyHookEntries, contextStatus, CONTEXT_LOG, readContextLog, settleTelemetry, summarizeContextLog, waitForSettle } from "./hooks.mjs";
import { firstCall, measureSession } from "./measures.mjs";
import { git, runMex } from "./workspace.mjs";
import { parseSession, testCommandTime } from "./telemetry.mjs";
import { relativePath } from "./suite.mjs";
import { runCodex, codexTestTime, listPriceEstimate } from "./codex.mjs";
import { historyViolations, restoreFiles } from "./history.mjs";
import { resourceGuard, startSampler } from "./resources.mjs";

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

/**
 * The suite's appended instruction, the same text in every arm, for example
 * `{ qa: "Keep the answer concise.", change: "Keep the summary concise." }`.
 */
export function appendedInstruction(appendPrompt, task) {
  if (!appendPrompt) return "";
  const text = typeof appendPrompt === "string" ? appendPrompt : appendPrompt[task.type === "change" ? "change" : "qa"];
  return text ? `\n\n${text}` : "";
}

export function buildPrompt(task, { mexPrompt = "none", withMex = false, appendPrompt = null } = {}) {
  const change = task.type === "change";
  const steer = !withMex ? ""
    : mexPrompt === "steered" ? `\n\n${MEX_STEER_COMMON}${change ? MEX_STEER_CHANGE : ""}`
    : mexPrompt === "forced" ? `\n\n${MEX_FORCE_COMMON}${change ? MEX_FORCE_CHANGE : ""}`
    : "";
  return `${task.prompt}${steer}`;
}

export function sharedInstructions(task, appendPrompt = null) {
  return `${task.type === "change" ? CHANGE_SUFFIX : QA_SUFFIX}${appendedInstruction(appendPrompt, task)}\nRun only targeted tests for this task; never run the full test suite. Use at most 3 test workers (workerCount=3 or --maxWorkers=3; vitest --maxWorkers=2).`;
}

export function claudeInvocation({ task, model, claudeCommand = ["claude"], mexPrompt = "none", withMex = false, appendPrompt = null }) {
  const tools = task.type === "change" ? ["Read", "Grep", "Glob", "Bash", "Edit", "Write"] : ["Read", "Grep", "Glob", "Bash"];
  const [command, ...prefix] = claudeCommand;
  return {
    command,
    args: [
      ...prefix,
      "-p", buildPrompt(task, { mexPrompt, withMex, appendPrompt }),
      "--append-system-prompt", sharedInstructions(task, appendPrompt),
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
  const line = clean.match(/Tests:?\s+([^\n]+)/)?.[1] ?? "";
  const pick = (word) => Number(line.match(new RegExp(`(\\d+)\\s+${word}`))?.[1] ?? 0);
  return { passed: pick("passed"), failed: pick("failed"), total: Number(line.match(/\((\d+)\)/)?.[1] ?? line.match(/(\d+)\s+total/)?.[1] ?? 0) || pick("passed") + pick("failed") + pick("skipped") };
}

/** Restore the hidden tests over the agent's version and run them. */
export function runHiddenTests(workspace, hiddenTests, env) {
  if (!hiddenTests) return null;
  if (hiddenTests.fromCommit) {
    if (hiddenTests.sourceRoot) restoreFiles(hiddenTests.sourceRoot, workspace, hiddenTests.fromCommit, hiddenTests.files);
    else git(workspace, ["checkout", hiddenTests.fromCommit, "--", ...hiddenTests.files]);
  }
  if (hiddenTests.command) return runPackageTests(workspace, hiddenTests, env);
  if (hiddenTests.runner === "hereby") return runHerebyTests(workspace, hiddenTests, env);
  if (hiddenTests.runner === "django") return runDjangoTests(workspace, hiddenTests, env);
  const vitest = join(workspace, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) return { ok: false, error: "vitest is not installed in the workspace" };
  const result = runSync(process.execPath, [vitest, "--run", "--maxWorkers=2", "--coverage.enabled=false", ...hiddenTests.files], { cwd: workspace, env });
  const counts = vitestCounts(`${result.stdout}\n${result.stderr}`);
  return { ok: result.code === 0 && counts.failed === 0 && counts.passed > 0, exitCode: result.code, ...counts, output: `${result.stdout}\n${result.stderr}`.slice(-20_000) };
}

/** TypeScript-style hidden tests: `hereby runtests --tests=<pattern>` (mocha; baselines must match). */
function runHerebyTests(workspace, hiddenTests, env) {
  const hereby = join(workspace, "node_modules", "hereby", "bin", "hereby.js");
  if (!existsSync(hereby)) return { ok: false, error: "hereby is not installed in the workspace" };
  const result = runSync(process.execPath, [hereby, "runtests", `--tests=${hiddenTests.tests}`], { cwd: workspace, env: { ...env, workerCount: String(hiddenTests.workerCount ?? 3) } });
  const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const pick = (word) => Number(output.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
  const passed = pick("passing"), failed = pick("failing");
  return { ok: result.code === 0 && failed === 0 && passed > 0, exitCode: result.code, passed, failed, total: passed + failed, output: output.slice(-20_000) };
}

export function runPackageTests(workspace, spec, env) {
  const cwd = spec.cwd ? join(workspace, relativePath(spec.cwd)) : workspace;
  const expand = (s) => s.replaceAll("{node}", process.execPath).replaceAll("{workspace}", workspace).replaceAll("{harness}", fileURLToPath(new URL("..", import.meta.url)));
  const [command, ...args] = spec.command.map(expand);
  const vitest = args.some((a) => /(?:^|\/)vitest(?:$|\.)/.test(a));
  const cap = Math.min(spec.workerCount ?? 3, vitest ? 2 : 3);
  const argv = [...args, `--maxWorkers=${cap}`];
  // Package-manager shims are scripts on this platform; use the installed JS entry.
  const pnpmEntry = spec.pnpmEntry ?? join(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js");
  const result = command === "pnpm"
    ? existsSync(pnpmEntry) ? runSync(process.execPath, [pnpmEntry, ...argv], { cwd, env: { ...env, JEST_WORKERS: String(cap), NX_PARALLEL: "1" }, timeoutMs: spec.timeoutMs ?? 300_000 }) : runSync("pnpm", argv, { cwd, env, timeoutMs: spec.timeoutMs ?? 300_000 })
    : runSync(command, argv, { cwd, env, timeoutMs: spec.timeoutMs ?? 300_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const counts = vitestCounts(output);
  return { ok: result.code === 0 && counts.failed === 0 && counts.passed > 0, exitCode: result.code, ...counts, output: output.slice(-20_000), command: [command, ...argv] };
}

/**
 * Read a Django test runner's summary: `Ran N tests`, then `OK` or
 * `FAILED (failures=a, errors=b, skipped=c)`. Skipped tests are neither passed nor failed.
 */
export function djangoCounts(output) {
  const clean = String(output).replace(/\x1b\[[0-9;]*m/g, "");
  const ran = clean.match(/^Ran (\d+) tests?\b/m);
  const total = ran ? Number(ran[1]) : 0;
  const detail = clean.match(/^(OK|FAILED)\s*(?:\(([^)\n]*)\))?\s*$/m);
  const parts = Object.fromEntries([...(detail?.[2] ?? "").matchAll(/([a-z ]+)=(\d+)/g)].map((match) => [match[1].trim(), Number(match[2])]));
  const failed = (parts.failures ?? 0) + (parts.errors ?? 0) + (parts["unexpected successes"] ?? 0);
  const skipped = parts.skipped ?? 0;
  return { passed: Math.max(0, total - failed - skipped), failed, skipped, total, status: detail?.[1] ?? null };
}

/** Django-style hidden tests: `runtests.py <labels> --parallel 1` from the checkout, with the checkout on PYTHONPATH. */
function runDjangoTests(workspace, hiddenTests, env) {
  const python = hiddenTests.python;
  if (!python || !existsSync(python)) return { ok: false, error: `python is not available (${python ?? "no interpreter set"})` };
  const runner = join(workspace, "tests", "runtests.py");
  if (!existsSync(runner)) return { ok: false, error: "tests/runtests.py is missing in the workspace" };
  const labels = String(hiddenTests.tests ?? "").split(/\s+/).filter(Boolean);
  const result = runSync(python, [runner, ...labels, "--parallel", "1"], { cwd: workspace, env: { ...env, PYTHONPATH: workspace, PYTHONDONTWRITEBYTECODE: "1" } });
  const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const counts = djangoCounts(output);
  return { ok: result.code === 0 && counts.status === "OK" && counts.failed === 0 && counts.passed > 0, exitCode: result.code, passed: counts.passed, failed: counts.failed, skipped: counts.skipped, total: counts.total, output: output.slice(-20_000) };
}

/**
 * The agent's work as one patch. Staged with `core.autocrlf=input`: the checkouts keep LF
 * (`core.autocrlf=false`), and a script the agent runs on Windows (Python's text mode) writes
 * whole files back with CRLF, which would otherwise make every such file a whole-file hunk.
 * A file committed with CRLF keeps it; only line ends the agent introduced are normalised.
 * The diff runs under the same setting: when the stat data is current, git reads the worktree
 * file in place of the staged blob, and without it that read sees the CRLF bytes again.
 */
export function agentDiff(workspace) {
  const lf = ["-c", "core.autocrlf=input", "-c", "core.safecrlf=false"];
  git(workspace, [...lf, "add", "-A"]);
  const nameStatus = git(workspace, [...lf, "diff", "--cached", "--ignore-cr-at-eol", "--name-status", "HEAD"]).stdout.trim();
  const patch = git(workspace, [...lf, "diff", "--cached", "--ignore-cr-at-eol", "HEAD"]).stdout;
  const files = nameStatus ? nameStatus.split("\n").map((line) => line.split("\t").slice(1).join("\t")) : [];
  return { files, patch };
}

function summarizeCheck(stdout) {
  try {
    const report = JSON.parse(stdout);
    const counts = {};
    for (const issue of report.issues ?? []) if (issue.code !== "SCAFFOLD_ORPHANED") counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    const grounding = (report.issues ?? []).filter((issue) => String(issue.code).startsWith("GROUNDING_"))
      .map(({ code, severity, file, message }) => ({ code, severity, file, message }));
    return { score: report.score ?? null, counts, grounding, excludedFromDeltas: ["SCAFFOLD_ORPHANED"] };
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
/**
 * Wait for the push layer's detached settle worker (graph refresh + re-recording),
 * so the diff, check and hidden tests see its writes. Its time is not session time.
 */
export async function waitForPushSettle(workspace, timeoutMs = 20 * 60 * 1000) {
  const lock = join(workspace, ".mex", "local", "push-settle.lock");
  const started = Date.now();
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (existsSync(lock) && Date.now() - started < timeoutMs) {
    let pid = NaN;
    try { pid = Number(readFileSync(lock, "utf8")); } catch { /* removed meanwhile */ }
    if (pid && !alive(pid)) break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  return { waitMs: Date.now() - started, timedOut: existsSync(lock) && Date.now() - started >= timeoutMs };
}

export async function runWarmup({ invocation, workspace, env, outputPrefix, timeoutMs = 120_000 }) {
  const local = join(workspace, ".mex", "local"), snapshot = `${outputPrefix}.warmup-local`;
  const hadLocal = existsSync(local);
  if (hadLocal) cpSync(local, snapshot, { recursive: true });
  const args = [...invocation.args];
  args[args.indexOf("-p") + 1] = "Reply with OK.";
  args.push("--max-turns", "1");
  let result;
  try {
    result = await runTimed(invocation.command, args, { cwd: workspace, env, timeoutMs });
    writeFileSync(`${outputPrefix}.warmup.jsonl`, result.stdout);
    const settle = await waitForSettle(workspace);
    // A structured answer may need more turns than the cap allows; one API call is enough to warm the cache.
    if (settle.timedOut || result.timedOut || !firstCall(result.stdout)) throw new Error("warm-up made no API call or settle timed out");
  } finally {
    // Includes context-sessions/{hash}.json and .stat.json (budget/shown state),
    // context-flags.json, context-log.jsonl, settle lock/again, and future local state.
    if (existsSync(local)) rmSync(local, { recursive: true, force: true });
    if (hadLocal) { mkdirSync(local, { recursive: true }); cpSync(snapshot, local, { recursive: true }); }
    rmSync(snapshot, { recursive: true, force: true });
  }
  if (git(workspace, ["status", "--porcelain"]).stdout.trim()) throw new Error("warm-up changed the prepared workspace");
  const parsed = claudeAdapter.parseTranscript(result.stdout, { gold: [] });
  return { usage: parsed.usage, costUsd: parsed.usage.reportedCostUsd, firstCall: firstCall(result.stdout), exitCode: result.code, elapsedMs: result.elapsedMs };
}

export async function runAgentSession(options) {
  const { resources = null, outputPrefix, workspace } = options;
  const guard = resources ? await resourceGuard({ ...resources, path: workspace, label: "session" }) : null;
  const sampler = resources ? startSampler({ path: workspace, csv: `${outputPrefix}.session.resources.csv` }) : null;
  try {
    const row = await measuredSession(options); row.resources = { guard, session: sampler ? await sampler.stop() : null };
    if (sampler && (row.resources.session.error || !row.resources.session.samples)) { row.valid = false; row.violations.push("session resource sampling failed"); }
    return row;
  }
  catch (error) { if (sampler) await sampler.stop(); throw error; }
}

async function measuredSession({ task, armId, armSpec, workspace, env, cliBin, model, timeoutMs, outputPrefix, claudeCommand, agent = "claude", codexCommand = ["codex"], effort = "high", sandbox = "workspace-write", writableDirs = [], listPrices = null, taskBase = task.base, resources = null, mexPrompt = "none", appendPrompt = null, warmup = false, validateCache = warmup, verifyWorkspace = null, sharedPrefixTokens = 5656 }) {
  const invocation = claudeInvocation({ task, model, claudeCommand, mexPrompt, withMex: armSpec.withMex, appendPrompt });
  let warmupResult = null;
  if (warmup && agent === "codex") {
    const local = join(workspace, ".mex", "local"), snapshot = `${outputPrefix}.warmup-local`, hadLocal = existsSync(local);
    if (hadLocal) cpSync(local, snapshot, { recursive: true });
    try {
      const warmed = await runCodex({ command: codexCommand, model, effort, sandbox, writableDirs, workspace, env, prompt: 'Reply with the required JSON and do not change files.', schema: task.type === "change" ? CHANGE_SCHEMA : ANSWER_SCHEMA, outputPrefix: `${outputPrefix}.warmup`, timeoutMs: 120_000, withHooks: armSpec.withHooks });
      const settled = await waitForSettle(workspace);
      if (warmed.code !== 0 || warmed.timedOut || settled.timedOut || !warmed.parsed.usage.accountingValid) throw new Error("Codex warm-up failed");
      warmupResult = { usage: warmed.parsed.usage, elapsedMs: warmed.elapsedMs };
    } finally {
      rmSync(local, { recursive: true, force: true });
      if (hadLocal) cpSync(snapshot, local, { recursive: true });
      rmSync(snapshot, { recursive: true, force: true });
    }
  } else if (warmup) warmupResult = await runWarmup({ invocation, workspace, env, outputPrefix });
  if (verifyWorkspace) verifyWorkspace();
  const processResult = agent === "codex"
    ? await runCodex({ command: codexCommand, model, effort, sandbox, writableDirs, workspace, env, prompt: `${buildPrompt(task, { mexPrompt, withMex: armSpec.withMex })}${sharedInstructions(task, appendPrompt)}`, schema: task.type === "change" ? CHANGE_SCHEMA : ANSWER_SCHEMA, outputPrefix, timeoutMs, withHooks: armSpec.withHooks })
    : await runTimed(invocation.command, invocation.args, { cwd: workspace, env, timeoutMs });
  writeFileSync(`${outputPrefix}.jsonl`, processResult.stdout);
  const parsed = agent === "codex" ? processResult.parsed : parseSession(processResult.stdout, task);
  const testTime = agent === "codex" ? codexTestTime(parsed.events, parsed.toolCalls) : testCommandTime(processResult.stdout, parsed.toolCalls);
  const calls = summarizeCalls(parsed.toolCalls, workspace);
  writeFileSync(`${outputPrefix}.calls.json`, `${JSON.stringify(calls.classified, null, 2)}\n`);

  const violations = taskBase ? historyViolations(parsed.toolCalls, workspace, taskBase) : [];
  const first = firstCall(processResult.stdout);
  if (agent === "claude" && validateCache && (!first || first.cacheRead < sharedPrefixTokens)) violations.push("cold-start");
  if (processResult.timedOut) violations.push("session timeout");
  if (processResult.code !== 0) violations.push(`agent exited ${processResult.code}`);
  if (processResult.error) violations.push(`agent capture failed: ${processResult.error.message}`);
  if (parsed.malformedLines) violations.push(`${parsed.malformedLines} malformed stream line(s)`);
  if (!parsed.usage.accountingValid) violations.push(`token accounting: ${parsed.usage.accountingReason}`);
  if (calls.npxMex) violations.push("npx mex-agent invoked (unpinned CLI)");
  const withCli = armSpec.withCli ?? armSpec.withMex;
  if (armSpec.withMex && !withCli) {
    const cliCalls = calls.classified.filter((entry) => entry.category.startsWith("mex:"));
    if (cliCalls.length) violations.push(`markdown-only arm invoked the mex CLI ${cliCalls.length} time(s)`);
  }
  if (!armSpec.withMex) {
    // This checkout has no .mex, so a .mex path (e.g. `ls .mex` probing for docs)
    // can return nothing; another checkout's .mex is caught as an outside touch below.
    const leaked = calls.classified.filter((entry) => entry.category.startsWith("mex:"));
    if (leaked.length) violations.push(`files arm used MEX ${leaked.length} time(s)`);
  }
  const outsideReads = calls.classified.filter((entry) => entry.outside && /(?:hono|ts|dj)-mex|[\\/]\.mex[\\/]|mex-test-tmp[\\/]arm/i.test(entry.path ?? ""));
  if (outsideReads.length) violations.push(`${outsideReads.length} call(s) touched another checkout`);

  let result;
  if (task.type === "change") {
    const structured = parseChangeResult(parsed.rawResult);
    if (agent === "codex" && !parsed.structured.ok) violations.push(parsed.structured.error);
    if (!structured.ok) violations.push(structured.error);
    result = { change: structured.value };
  } else {
    if (!parsed.structured.ok) violations.push(parsed.structured.error);
    result = { answer: parsed.structured.ok ? parsed.structured.value : null };
  }

  const settle = armSpec.withPush ? await waitForPushSettle(workspace) : armSpec.withHooks ? await waitForSettle(workspace) : null;
  if (settle?.timedOut) violations.push(armSpec.withHooks ? "settle worker did not finish within the cap" : "push settle worker did not finish");

  // The hooks' own record of the session, taken before the harness runs anything of its own.
  const contextLog = join(workspace, ".mex", "local", CONTEXT_LOG);
  let hooks = null;
  if (armSpec.withHooks) {
    if (existsSync(contextLog)) copyFileSync(contextLog, `${outputPrefix}.context-log.jsonl`);
    hooks = summarizeContextLog(contextLog);
    const status = contextStatus({ cliBin, workspace, env });
    writeFileSync(`${outputPrefix}.context-status.json`, status.raw);
    if (hooks) hooks.status = { ok: status.ok, flagged: status.flagged, eligible: status.eligible, flaggedIds: status.flaggedIds, eligibleIds: status.eligibleIds };
    if (!hooks || hooks.hookEvents === 0) violations.push("MEX arm session with zero hook events");
    const used = Object.keys(hooks?.promptNotes ?? {});
    // Each prompt line records the recipe it ran; notes such as `R3/hybrid` appear only when the gate sends.
    const recipes = new Set(used.map((note) => /^R3\//.test(note) ? "semantic" : /^R2w\//.test(note) ? "lexical" : null).filter(Boolean));
    try {
      for (const line of existsSync(contextLog) ? readFileSync(contextLog, "utf8").split(/\r?\n/) : []) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.event === "prompt" && (entry.recipe === "lexical" || entry.recipe === "semantic")) recipes.add(entry.recipe);
      }
    } catch { /* an unreadable log leaves the recipe unverified below */ }
    if (armSpec.lexical && recipes.has("semantic")) violations.push("lexical arm ran the semantic recipe");
    if (armSpec.semantic && recipes.has("lexical")) violations.push("semantic arm fell back to the lexical recipe");
    if (agent === "codex" && armSpec.lexical && !recipes.has("lexical")) violations.push("lexical recipe not verified in hook log");
    if (agent === "codex" && armSpec.semantic && !recipes.has("semantic")) violations.push("semantic recipe not verified in hook log");
  } else if (!armSpec.withMex) {
    if (existsSync(contextLog)) violations.push("files arm has a context log");
    if (anyHookEntries(workspace, agent) > 0) violations.push("files arm has hook entries");
  }
  const diff = agentDiff(workspace);
  writeFileSync(`${outputPrefix}.patch`, diff.patch);
  let mexCheck = null;
  if (withCli) {
    if (resources) await resourceGuard({ ...resources, path: workspace, label: "post-session graph refresh" });
    runMex(cliBin, ["graph", "refresh"], workspace, env);
    const check = runMex(cliBin, ["check", "--json"], workspace, env);
    writeFileSync(`${outputPrefix}.check.json`, check.stdout);
    mexCheck = summarizeCheck(check.stdout);
  }
  const gradingGuard = resources && task.type === "change" ? await resourceGuard({ ...resources, path: workspace, label: "grading" }) : null;
  const gradeSampler = resources && task.type === "change" ? startSampler({ path: workspace, csv: `${outputPrefix}.grade.resources.csv` }) : null;
  let hiddenTests, gradingResources;
  try { hiddenTests = task.type === "change" ? runHiddenTests(workspace, task.hiddenTests, env) : null; }
  finally { gradingResources = gradeSampler ? await gradeSampler.stop() : null; }
  if (gradeSampler && (gradingResources.error || !gradingResources.samples)) violations.push("grading resource sampling failed");
  if (hiddenTests?.output) writeFileSync(`${outputPrefix}.tests.txt`, hiddenTests.output);

  const usage = parsed.usage;
  const contextIndexPath = join(workspace, ".mex", "local", "context-index.json");
  const measures = measureSession({ raw: processResult.stdout, calls: parsed.toolCalls, entries: readContextLog(contextLog).entries, task,
    answer: JSON.stringify(parsed.rawResult), contextIndex: existsSync(contextIndexPath) ? JSON.parse(readFileSync(contextIndexPath, "utf8")) : null });
  return {
    accounting: parsed.accounting, testCommandTime: testTime,
    ...settleTelemetry(hooks, settle),
    firstCall: first, warmup: warmupResult, measures, cacheValidation: { enabled: validateCache, minimumReadTokens: sharedPrefixTokens },
    agent, ...(agent === "codex" ? { model, effort, sandbox, isolation: processResult.isolation, listPriceEstimate: listPriceEstimate(usage, listPrices) } : {}), gradingResources, gradingGuard,
    process: { code: processResult.code, signal: processResult.signal, timedOut: processResult.timedOut, elapsedMs: processResult.elapsedMs, stderr: String(processResult.stderr ?? "").slice(-4000) },
    ...(settle ? { settleWait: settle } : {}),
    ...(hooks ? { hooks } : {}),
    providerFailure: parsed.providerFailure ?? null,
    metrics: {
      newTokens: usage.newTokens, processed: usage.reportedTotal, uncachedInput: usage.uncachedInput,
      cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead, output: usage.output,
      ...(agent === "codex" ? { input: usage.input, reasoning: usage.reasoning } : {}),
      cacheUseRatio: usage.cacheUseRatio, costUsd: usage.reportedCostUsd,
      neutralCostUsd: first?.cacheRead > 0 ? usage.reportedCostUsd : null,
      elapsedMs: processResult.elapsedMs, turns: parsed.turns, toolCalls: calls.totalCalls,
      testCommandMs: testTime.ms, agentMinusTestMs: testTime.ms === null ? null : Math.max(0, processResult.elapsedMs - testTime.ms),
      mexCalls: calls.mexCalls, fallbacks: calls.fallbacks, handHashEdits: calls.handHashEdits,
      // False in the MEX arm means the agent never touched the scaffold or CLI;
      // check the pilot for this before trusting the instructions were loaded.
      mexEngaged: calls.classified.some((entry) => entry.category.startsWith("mex:") || entry.category.startsWith("knowledge-")),
      permissionDenials: parsed.permissionDenials,
      discoveryCalls: measures.discoveryCalls, redundantSearches: measures.redundantSearches, turnsToGoldFile: measures.turnsToGoldFile, wikiShowCalls: measures.wikiShowCalls,
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
