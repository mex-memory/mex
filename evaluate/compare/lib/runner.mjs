import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentAdapter } from "../../adapters/agents/index.mjs";
import { restoreGraphDbAndRemoveScratch } from "../../core/artifacts.mjs";
import { commandBundleIdentity, objectHash } from "../../core/hash.mjs";
import { ANSWER_SCHEMA, gradeAnswer } from "./answer.mjs";
import { BASH_GUARD_DENIAL, BASH_GUARD_HOOK_NAME } from "./bash-guard.mjs";
import { isDeniedFileShellAttempt, shellQuote, validateTranscriptPolicy } from "./policy.mjs";
import { buildPrompt } from "./prompt.mjs";
import { runTimed } from "./process.mjs";
import { fileHash, GraphDbGuard, repositoryIdentity, worktreeDiffHash } from "./prepare.mjs";
import { buildSchedule } from "./schedule.mjs";
import { resolveSelectedArmIds, suiteHash } from "./suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH_COMMAND = join(HERE, "graph-command.mjs");
const BASH_GUARD_SOURCE = join(HERE, "bash-guard.mjs");
const POLICY_SOURCE = join(HERE, "policy.mjs");
const BASH_GUARD_LAUNCHER_COMMAND = "/bin/sh";
const BASH_GUARD_LAUNCHER_SCRIPT = [
  '"$1" "$2" "$3"',
  "guard_status=$?",
  'if [ "$guard_status" -ne 0 ]; then',
  `  printf '%s\\n' '${BASH_GUARD_DENIAL}: guard process failed before a decision' >&2`,
  "  exit 2",
  "fi",
  "exit 0",
].join("\n");

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function privateWrite(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function pinFile(source, destination) {
  const before = fileHash(source);
  copyFileSync(source, destination);
  chmodSync(destination, 0o400);
  const sourceAfter = fileHash(source);
  const pinned = fileHash(destination);
  if (sourceAfter !== before || pinned !== before) throw new Error(`guard source changed while pinning ${source}`);
  return pinned;
}

export function buildBashGuardHook({ nodePath = process.execPath, guardPath, configPath }) {
  if (![nodePath, guardPath, configPath].every((value) => typeof value === "string" && value)) {
    throw new Error("Bash guard hook requires exact node, guard, and configuration paths");
  }
  return {
    type: "command",
    command: BASH_GUARD_LAUNCHER_COMMAND,
    args: ["-c", BASH_GUARD_LAUNCHER_SCRIPT, BASH_GUARD_HOOK_NAME, nodePath, guardPath, configPath],
    timeout: 5,
    statusMessage: BASH_GUARD_HOOK_NAME,
  };
}

function preToolInput(command, extra = {}) {
  return {
    session_id: "mex-eval-guard-preflight",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, ...extra },
    tool_use_id: "mex-eval-guard-preflight-tool",
  };
}

function invokeGuardProbe(hook, input, label) {
  const result = spawnSync(hook.command, hook.args, {
    input,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
    throw new Error(`Claude Bash guard ${label} probe failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`Claude Bash guard ${label} probe returned invalid JSON: ${error.message}`);
  }
}

function assertDeniedProbe(output, label) {
  const decision = output?.hookSpecificOutput;
  if (decision?.hookEventName !== "PreToolUse" || decision.permissionDecision !== "deny"
    || !String(decision.permissionDecisionReason ?? "").includes(BASH_GUARD_DENIAL)) {
    throw new Error(`Claude Bash guard ${label} probe did not return the expected denial`);
  }
}

export function preflightClaudeBashGuard({ settingsPath, configPath, guardPath, policyPath, command }) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const expectedHook = buildBashGuardHook({ guardPath, configPath });
  const configured = settings?.hooks?.PreToolUse;
  if (!Array.isArray(configured) || configured.length !== 1 || configured[0]?.matcher !== "Bash"
    || !Array.isArray(configured[0]?.hooks) || configured[0].hooks.length !== 1
    || !sameJson(configured[0].hooks[0], expectedHook)) {
    throw new Error("Claude Bash guard settings do not match the pinned exec-form hook");
  }
  if (!sameJson(config.command, command)) throw new Error("Claude Bash guard configuration changed before preflight");

  const hashes = {
    settings: fileHash(settingsPath),
    config: fileHash(configPath),
    guard: fileHash(guardPath),
    policy: fileHash(policyPath),
    launcher: objectHash(BASH_GUARD_LAUNCHER_SCRIPT),
  };
  const prefix = command.map(shellQuote).join(" ");
  const allowed = invokeGuardProbe(expectedHook, `${JSON.stringify(preToolInput(`${prefix} graph scope "guard preflight"`))}\n`, "allow");
  if (!allowed || typeof allowed !== "object" || Array.isArray(allowed) || Object.keys(allowed).length !== 0) {
    throw new Error("Claude Bash guard allow probe did not return an empty decision");
  }
  assertDeniedProbe(invokeGuardProbe(expectedHook, `${JSON.stringify(preToolInput("git status"))}\n`, "deny"), "deny");
  assertDeniedProbe(invokeGuardProbe(expectedHook, "{malformed\n", "malformed"), "malformed");

  for (const [name, path] of Object.entries({ settings: settingsPath, config: configPath, guard: guardPath, policy: policyPath })) {
    if (fileHash(path) !== hashes[name]) throw new Error(`Claude Bash guard ${name} changed during preflight`);
  }
  return { valid: true, hashes, probes: { allow: true, deny: true, malformed: true } };
}

export function toolPolicyForArm(arm, command) {
  if (arm.kind === "grep") return { tools: "Read,Grep,Glob", allowed: ["Read", "Grep", "Glob"] };
  const prefix = command.map(shellQuote).join(" ");
  return {
    tools: "Read,Grep,Glob,Bash",
    allowed: [
      "Read", "Grep", "Glob",
      `Bash(${prefix} graph scope *)`,
      `Bash(${prefix} graph query *)`,
      `Bash(${prefix} graph get *)`,
      `Bash(${prefix} impact *)`,
    ],
  };
}

export function claudeArgs({ prompt, model, arm, command, settingsPath = null }) {
  const tools = toolPolicyForArm(arm, command);
  return [
    "-p", prompt, "--output-format", "stream-json", "--verbose",
    ...(settingsPath
      ? ["--settings", settingsPath, "--strict-mcp-config", "--no-chrome", "--disable-slash-commands", "--include-hook-events"]
      : ["--safe-mode"]),
    "--setting-sources", "",
    "--no-session-persistence", "--exclude-dynamic-system-prompt-sections",
    "--permission-mode", "dontAsk", "--model", model, "--json-schema", JSON.stringify(ANSWER_SCHEMA),
    "--tools", tools.tools, "--allowedTools", ...tools.allowed,
  ];
}

function assertPreparedIdentity({
  suite,
  subjectRoot,
  selectedArmCommands,
  armIds,
  prepared,
  preparePath,
  prepareSha256,
  manifestPath = null,
  runningManifestSha256 = null,
}) {
  if (!existsSync(preparePath) || fileHash(preparePath) !== prepareSha256) {
    throw new Error("prepared comparison manifest changed during evaluation");
  }
  if (prepared.suiteSha256 && prepared.suiteSha256 !== suiteHash(suite)) {
    throw new Error("suite changed after preparation");
  }
  if (manifestPath && runningManifestSha256
    && (!existsSync(manifestPath) || fileHash(manifestPath) !== runningManifestSha256)) {
    throw new Error("active comparison run manifest changed during evaluation");
  }

  const preparedArmIds = resolveSelectedArmIds(suite, prepared.selectedArmIds ?? null);
  const unpreparedArmIds = armIds.filter((armId) => !preparedArmIds.includes(armId));
  if (unpreparedArmIds.length) {
    throw new Error(`selected arm(s) were not prepared: ${unpreparedArmIds.join(", ")}`);
  }

  if (prepared.subject) {
    const currentSubject = repositoryIdentity(subjectRoot);
    const currentDiff = worktreeDiffHash(subjectRoot);
    if ((prepared.subject.root && currentSubject.root !== prepared.subject.root)
      || currentSubject.sha !== prepared.subject.sha
      || currentDiff !== prepared.subject.diffSha256) {
      throw new Error("subject repository no longer matches the prepared fixture");
    }
  }
  if (prepared.harness?.root) {
    const currentHarness = repositoryIdentity(prepared.harness.root);
    const currentDiff = worktreeDiffHash(prepared.harness.root);
    if (currentHarness.root !== prepared.harness.root
      || currentHarness.sha !== prepared.harness.sha
      || currentDiff !== prepared.harness.diffSha256) {
      throw new Error("evaluation harness no longer matches the prepared fixture");
    }
  }

  for (const armId of armIds) {
    if (suite.arms[armId].kind !== "graph") continue;
    const command = selectedArmCommands[armId];
    if (!command) throw new Error(`missing CLI command for selected graph arm ${armId}`);
    const preparedCli = prepared.cli?.[armId];
    if (!preparedCli) {
      if (prepared.schemaVersion >= 3) throw new Error(`missing prepared CLI identity for ${armId}`);
      continue;
    }
    if (JSON.stringify(command) !== JSON.stringify(preparedCli.command)) {
      throw new Error(`CLI command changed after prepare for ${armId}`);
    }
    const bundle = commandBundleIdentity(command);
    const script = bundle.entrypoint;
    if (preparedCli.sha256 && (!script || !existsSync(script) || fileHash(script) !== preparedCli.sha256)) {
      throw new Error(`CLI bytes changed after prepare for ${armId}`);
    }
    if (preparedCli.bundleSha256 && bundle.bundleSha256 !== preparedCli.bundleSha256) {
      throw new Error(`CLI bundle changed after prepare for ${armId}`);
    }
  }
  for (const armId of armIds) {
    const index = prepared.indices?.[armId];
    if (!index) {
      if (prepared.schemaVersion >= 3 && suite.arms[armId].kind === "graph") {
        throw new Error(`missing prepared graph index for ${armId}`);
      }
      continue;
    }
    if (index.sha256 && (!existsSync(index.path) || fileHash(index.path) !== index.sha256)) {
      throw new Error(`prepared graph index changed for ${armId}`);
    }
  }
}

function assertScheduleIdentity(context, checkpoint) {
  try {
    assertPreparedIdentity(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`comparison evaluation identity drift ${checkpoint}: ${message}`, { cause: error });
  }
}

export async function runSession({ agentCommand, agentId = "claude", policy = "forced-first", subjectRoot, model, task, armId, arm, armCommands, timeoutMs, graphCoverage = null }) {
  const adapter = getAgentAdapter(agentId);
  const sessionRoot = mkdtempSync(join(tmpdir(), `mex-agent-${agentId}-`));
  const sessionCommands = {};
  try {
    for (const [id, realCommand] of Object.entries(armCommands)) {
      const configPath = join(sessionRoot, `${id}-graph-command.json`);
      privateWrite(configPath, `${JSON.stringify({ subjectRoot, command: realCommand }, null, 2)}\n`);
      sessionCommands[id] = [process.execPath, GRAPH_COMMAND, configPath];
    }
    const command = sessionCommands[armId] ?? [];
    const prompt = buildPrompt(task, armId, arm, command, subjectRoot, policy);
    const schemaPath = join(sessionRoot, "answer-schema.json");
    privateWrite(schemaPath, `${JSON.stringify(ANSWER_SCHEMA, null, 2)}\n`);
    let settingsPath = null;
    let guardPreflight = null;
    if (agentId === "claude") {
      const pinnedGuardPath = join(sessionRoot, "bash-guard.mjs");
      const pinnedPolicyPath = join(sessionRoot, "policy.mjs");
      pinFile(BASH_GUARD_SOURCE, pinnedGuardPath);
      pinFile(POLICY_SOURCE, pinnedPolicyPath);
      const guardCommand = command.length ? command : [join(sessionRoot, "bash-disabled")];
      const guardConfigPath = join(sessionRoot, "bash-guard.json");
      privateWrite(guardConfigPath, `${JSON.stringify({ command: guardCommand }, null, 2)}\n`);
      settingsPath = join(sessionRoot, "claude-settings.json");
      const guardHook = buildBashGuardHook({ guardPath: pinnedGuardPath, configPath: guardConfigPath });
      privateWrite(settingsPath, `${JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [guardHook] }],
        },
      }, null, 2)}\n`);
      guardPreflight = preflightClaudeBashGuard({
        settingsPath,
        configPath: guardConfigPath,
        guardPath: pinnedGuardPath,
        policyPath: pinnedPolicyPath,
        command: guardCommand,
      });
    }
    const defaultCommand = agentId === "codex" ? ["codex"] : ["claude"];
    const [agent, ...agentPrefix] = agentCommand ?? defaultCommand;
    const toolPolicy = toolPolicyForArm(arm, command);
    const invocation = adapter.buildInvocation({
      executable: agent,
      prefix: agentPrefix,
      prompt,
      model,
      schema: ANSWER_SCHEMA,
      schemaPath,
      subjectRoot,
      tools: toolPolicy.tools,
      allowedTools: toolPolicy.allowed,
      settingsPath,
    });
    const processResult = await runTimed(invocation.command, invocation.args, { cwd: sessionRoot, timeoutMs });
    const parsed = adapter.parseTranscript(processResult.stdout, task);
    const violations = validateTranscriptPolicy(parsed.toolCalls, armId, arm, sessionCommands, {
      allowFileShell: agentId === "codex",
      requireGraphFirst: policy === "forced-first",
    });
  const deniedFileShellAttempts = parsed.toolCalls.filter((call) => isDeniedFileShellAttempt(call, sessionCommands)).length;
  const permissionDenials = Number(parsed.permissionDenials ?? 0);
  const unexplainedPermissionDenials = Math.max(0, permissionDenials - deniedFileShellAttempts);
  if (agentId === "claude" && !parsed.bashGuardLifecycle?.valid) {
    for (const violation of parsed.bashGuardLifecycle?.violations ?? ["missing Bash guard lifecycle audit"]) {
      violations.push(`Claude Bash guard lifecycle: ${violation}`);
    }
  }
  if (unexplainedPermissionDenials) violations.push(`${unexplainedPermissionDenials} unexplained permission denial(s)`);
  if (parsed.malformedLines) violations.push(`${parsed.malformedLines} malformed stream line(s)`);
  if (!parsed.structured.ok) violations.push(parsed.structured.error);
  if (parsed.providerFailure?.retryable) violations.push(`retryable ${parsed.providerFailure.provider} provider ${parsed.providerFailure.type}`);
  if (processResult.timedOut) violations.push("session timeout");
  if (processResult.code !== 0) violations.push(`agent exited ${processResult.code}`);
  const answer = parsed.structured.ok ? parsed.structured.value : null;
  const usage = parsed.usage;
  return {
    process: { code: processResult.code, signal: processResult.signal, timedOut: processResult.timedOut, elapsedMs: processResult.elapsedMs, stderr: processResult.stderr },
    promptSha256: objectHash(prompt),
    agent: agentId,
    policy,
    transcript: processResult.stdout,
    metrics: {
      uncachedInput: usage.uncachedInput, cacheCreation: usage.cacheWrite, cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead, output: usage.output, processed: usage.reportedTotal,
      reportedTotal: usage.reportedTotal, newTokens: usage.newTokens, cacheUseRatio: usage.cacheUseRatio,
      tokenAccountingValid: usage.accountingValid, tokenAccountingReason: usage.accountingReason,
      terminalUsage: usage.terminal, perMessageUsage: usage.perMessage, rawUsage: usage.raw,
      costUsd: usage.reportedCostUsd, elapsedMs: processResult.elapsedMs, turns: parsed.turns,
      toolCalls: parsed.toolCalls.length, graphCalls: parsed.graph.calls, scopeCalls: parsed.graph.scope,
      distinctScopeQueries: parsed.graph.distinctScopeQueries,
      fallbacks: arm.kind === "graph" ? parsed.graph.fallbacks : 0, expectedSymbolInitialScopeRank: parsed.graph.initialScopeRank,
      firstResponseFileRank: parsed.graph.initialFileRank, firstResponseFileRecallAt5: parsed.graph.initialFileRecallAt5,
      firstResponseFileHitAt5: parsed.graph.initialFileHitAt5, firstResponseSourceSpanRecall: parsed.graph.initialSourceSpanRecall,
      firstResponseDirectedFlowCoverage: parsed.graph.initialDirectedFlowCoverage, firstResponseReturnedFiles: parsed.graph.initialReturnedFiles,
      graphEvidenceCoverage: graphCoverage?.evidenceCoverage ?? null, graphMissingEvidence: graphCoverage?.missingEvidence ?? null,
      uniqueToolResultChars: parsed.toolResultChars, uniqueToolResultTokens: parsed.toolResultTokensApprox,
      toolErrors: parsed.toolErrors, permissionDenials,
      duplicatePermissionDenials: parsed.duplicatePermissionDenials ?? 0,
      deniedFileShellAttempts, unexplainedPermissionDenials,
      bashGuardLifecycle: parsed.bashGuardLifecycle ?? null,
    },
    graphCoverage,
    guardPreflight,
    providerFailure: parsed.providerFailure ?? null,
    answer, grade: answer ? gradeAnswer(answer, task, subjectRoot) : { correct: false, matchedSymbols: [], missingSymbols: task.expectedSymbols ?? task.gold?.map((entry) => entry.symbol) ?? [], answerSymbolRank: null },
    valid: violations.length === 0, violations,
  };
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
  }
}

export async function runEvaluation({
  suite, subjectRoot, outputDir, armCommands, model, timeoutMs = 300_000, resume = false,
  agentCommand, agentId = "claude", policy = "forced-first", repetitions = null, selectedArmIds = null,
}) {
  const armIds = resolveSelectedArmIds(suite, selectedArmIds);
  const selectedArmCommands = Object.fromEntries(armIds
    .filter((armId) => armCommands[armId])
    .map((armId) => [armId, armCommands[armId]]));
  const runRepetitions = repetitions ?? suite.requiredRepetitions ?? 1;
  const preparePath = join(outputDir, "prepare.json");
  if (!existsSync(preparePath)) throw new Error(`missing ${preparePath}; run --prepare first`);
  const prepareSha256 = fileHash(preparePath);
  const prepared = JSON.parse(readFileSync(preparePath, "utf8"));
  const identityContext = {
    suite,
    subjectRoot,
    selectedArmCommands,
    armIds,
    prepared,
    preparePath,
    prepareSha256,
  };
  assertPreparedIdentity(identityContext);
  const schedule = buildSchedule(suite.tasks, armIds, runRepetitions);
  const runsDir = join(outputDir, "runs"), transcriptsDir = join(outputDir, "transcripts");
  mkdirSync(runsDir, { recursive: true }); mkdirSync(transcriptsDir, { recursive: true });
  const manifestPath = join(outputDir, "run-manifest.json");
  const runIdentity = objectHash({
    prepare: fileHash(preparePath),
    suiteId: suite.id,
    model,
    agentId,
    policy,
    selectedArmIds: armIds,
    repetitions: runRepetitions,
    timeoutMs,
    agentCommand: agentCommand ?? null,
    schedule: schedule.map(({ runId, taskIndex, repetition, orderIndex, armId }) => ({ runId, taskIndex, repetition, orderIndex, armId })),
  });
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!resume) throw new Error(`run manifest already exists: ${manifestPath}`);
    if (existing.runIdentity !== runIdentity) throw new Error("resume run identity does not match model, agent, policy, repetitions, timeout, suite, or prepared artifacts");
  }
  const scratch = join(outputDir, ".run-scratch");
  const guard = new GraphDbGuard(subjectRoot, scratch);
  const rows = [];
  const startedAt = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).startedAt : new Date().toISOString();
  const baseManifest = {
    schemaVersion: 3, suiteId: suite.id, runIdentity, model, agent: agentId, policy,
    selectedArmIds: armIds, repetitions: runRepetitions, timeoutMs, startedAt, status: "running",
    schedule: schedule.map(({ runId, taskIndex, repetition, orderIndex, armId }) => ({ runId, taskIndex, repetition, orderIndex, armId })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(baseManifest, null, 2)}\n`);
  const runningManifestSha256 = fileHash(manifestPath);
  const scheduleIdentityContext = {
    ...identityContext,
    manifestPath,
    runningManifestSha256,
  };
  let activeRunId = null;
  try {
    try {
      for (const item of schedule) {
        activeRunId = item.runId;
        assertScheduleIdentity(scheduleIdentityContext, `before ${item.runId}`);
        const resultPath = join(runsDir, `${item.runId}.json`);
        if (resume && existsSync(resultPath)) {
          const existing = JSON.parse(readFileSync(resultPath, "utf8"));
          if (existing.runIdentity !== runIdentity || existing.runId !== item.runId) throw new Error(`resume identity mismatch: ${item.runId}`);
          if (!existsSync(join(transcriptsDir, `${item.runId}.jsonl`))) throw new Error(`resume transcript missing: ${item.runId}`);
          rows.push(existing);
          assertScheduleIdentity(scheduleIdentityContext, `after ${item.runId}`);
          continue;
        }
        if (!resume && existsSync(resultPath)) throw new Error(`run already exists: ${item.runId}; use --resume or a different --output`);
        const arm = suite.arms[item.armId];
        if (arm.kind === "graph") {
          const snapshot = prepared.indices?.[item.armId]?.path;
          if (!snapshot || !existsSync(snapshot)) throw new Error(`missing prepared graph index for ${item.armId}`);
          guard.activate(snapshot);
        } else guard.clear();
        process.stderr.write(`[eval:compare] ${item.runId}\n`);
        const preparedGold = prepared.goldEvidence?.find((entry) => entry.taskId === item.task.id);
        const evaluatedTask = preparedGold ? { ...item.task, gold: preparedGold.symbols } : item.task;
        const armCoverage = prepared.graphCoverage?.[item.armId] ?? prepared.indices?.[item.armId]?.goldCoverage ?? null;
        const graphCoverage = armCoverage?.tasks?.find((entry) => entry.taskId === item.task.id) ?? null;
        const session = await runSession({
          agentCommand, agentId, policy, subjectRoot, model, task: evaluatedTask,
          armId: item.armId, arm, armCommands: selectedArmCommands, timeoutMs, graphCoverage,
        });
        writeFileSync(join(transcriptsDir, `${item.runId}.jsonl`), session.transcript);
        // Restore the subject's original graph before hashing the live source tree.
        // The transcript remains useful for diagnosis, but a drifting session must
        // never become a graded row.
        guard.restore();
        assertScheduleIdentity(scheduleIdentityContext, `after ${item.runId}`);
        if (session.providerFailure?.retryable && session.providerFailure.type === "rate_limit") {
          const status = session.providerFailure.apiErrorStatus ?? session.providerFailure.rateLimitStatus ?? "unknown";
          throw new Error(`retryable ${session.providerFailure.provider} provider rate limit (${status}); resume after the provider limit resets`);
        }
        const row = { runIdentity, runId: item.runId, taskId: item.task.id, arm: item.armId, taskIndex: item.taskIndex, repetition: item.repetition, orderIndex: item.orderIndex, ...session };
        delete row.transcript;
        writeFileSync(resultPath, `${JSON.stringify(row, null, 2)}\n`);
        rows.push(row);
      }
      activeRunId = null;
      assertScheduleIdentity(scheduleIdentityContext, "after schedule");
    } finally {
      restoreGraphDbAndRemoveScratch(guard, scratch);
    }
    assertScheduleIdentity(scheduleIdentityContext, "before completion");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const manifest = {
      ...baseManifest,
      status: "aborted",
      completedAt: new Date().toISOString(),
      resultCount: rows.length,
      ...(activeRunId ? { failedRunId: activeRunId } : {}),
      error: message,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    throw error;
  }
  const manifest = { ...baseManifest, status: "complete", completedAt: new Date().toISOString(), resultCount: rows.length };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { rows, manifest };
}
