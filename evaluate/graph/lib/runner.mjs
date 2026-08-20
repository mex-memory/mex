import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GraphDbGuard, restoreGraphDbAndRemoveScratch } from "../../core/artifacts.mjs";
import { commandBundleIdentity, fileHash, objectHash, repositoryIdentity } from "../../core/hash.mjs";
import { parseJsonLines, validateGraphResponse } from "../../core/jsonl.mjs";
import { runProcess } from "../../core/process.mjs";
import { gradeRetrieval } from "../../graders/retrieval.mjs";
import { expectedGraphCommand, graphSuiteHash, graphTaskArgs } from "../../schemas/graph-suite.mjs";
import { loadPreparedGraphEvaluation } from "./prepare.mjs";
import { coverageForTask } from "./coverage.mjs";

function safeId(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function preparedRunIdentity(prepared) {
  const systems = Object.fromEntries(Object.entries(prepared.systems ?? {}).map(([id, system]) => [id, {
    command: system.command,
    bundleSha256: system.cli?.bundleSha256 ?? null,
    indexSha256: system.index?.sha256 ?? null,
    normalizedIndexSha256: system.index?.normalizedSha256 ?? null,
  }]));
  return objectHash({
    schemaVersion: prepared.schemaVersion,
    suiteId: prepared.suiteId,
    suiteSha256: prepared.suiteSha256,
    subject: prepared.subject,
    harness: prepared.harness,
    systems,
    runtime: prepared.runtime,
    environment: prepared.environment,
    invocation: prepared.invocation,
  });
}

export function buildGraphSchedule(suite) {
  const systems = Object.keys(suite.systems);
  return suite.tasks.flatMap((task, taskIndex) => {
    const offset = taskIndex % systems.length;
    const order = [...systems.slice(offset), ...systems.slice(0, offset)];
    return order.map((systemId, orderIndex) => ({
      runId: `${String(taskIndex + 1).padStart(3, "0")}-${safeId(task.id)}--${safeId(systemId)}`,
      taskIndex,
      orderIndex,
      task,
      systemId,
    }));
  });
}

function assertPreparedIdentity({
  suite, subjectRoot, systemCommands, prepared, preparePath, prepareSha256,
  runManifestPath, runningManifestSha256,
}) {
  if (prepared.schemaVersion === 3 && prepared.runIdentity
    && preparedRunIdentity(prepared) !== prepared.runIdentity) {
    throw new Error("prepared run identity is invalid");
  }
  if (preparePath && prepareSha256
    && (!existsSync(preparePath) || fileHash(preparePath) !== prepareSha256)) {
    throw new Error("prepared run manifest changed during graph evaluation");
  }
  if (runManifestPath && runningManifestSha256
    && (!existsSync(runManifestPath) || fileHash(runManifestPath) !== runningManifestSha256)) {
    throw new Error("active run manifest changed during graph evaluation");
  }
  if (graphSuiteHash(suite) !== prepared.suiteSha256) throw new Error("suite or task fixture changed after preparation");
  const subject = repositoryIdentity(subjectRoot);
  if (subject.sha !== prepared.subject.sha || subject.treeStateSha256 !== prepared.subject.treeStateSha256) {
    throw new Error("subject repository changed after preparation");
  }
  if (prepared.harness?.root) {
    const harness = repositoryIdentity(prepared.harness.root);
    if (harness.sha !== prepared.harness.sha
      || harness.treeStateSha256 !== prepared.harness.treeStateSha256) {
      throw new Error("evaluation harness changed after preparation");
    }
  }
  for (const [systemId, command] of Object.entries(systemCommands)) {
    const system = prepared.systems?.[systemId];
    if (!system) throw new Error(`system ${systemId} was not prepared`);
    if (JSON.stringify(command) !== JSON.stringify(system.command)) throw new Error(`system ${systemId} command changed after preparation`);
    const bundle = commandBundleIdentity(command);
    if (bundle.bundleSha256 !== system.cli.bundleSha256) throw new Error(`system ${systemId} CLI bundle changed after preparation`);
    if (!existsSync(system.index.path) || fileHash(system.index.path) !== system.index.sha256) {
      throw new Error(`system ${systemId} graph snapshot changed after preparation`);
    }
  }
}

function assertScheduleIdentity(context, checkpoint) {
  try {
    assertPreparedIdentity(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`graph evaluation identity drift ${checkpoint}: ${message}`, { cause: error });
  }
}

function existingResult(path, expected) {
  const row = JSON.parse(readFileSync(path, "utf8"));
  if (row.runIdentity !== expected.runIdentity || row.runId !== expected.runId || row.taskId !== expected.taskId || row.system !== expected.system) {
    throw new Error(`resume identity mismatch in ${path}`);
  }
  return row;
}

export async function runGraphEvaluation({
  suite,
  subjectRoot,
  outputDir,
  systemCommands,
  timeoutMs = 120_000,
  maxOutputBytes = 32 * 1024 * 1024,
  resume = false,
}) {
  const preparePath = join(outputDir, "prepare.json");
  const prepareSha256 = fileHash(preparePath);
  const prepared = loadPreparedGraphEvaluation(outputDir);
  const identityContext = {
    suite, subjectRoot, systemCommands, prepared, preparePath, prepareSha256,
  };
  assertPreparedIdentity(identityContext);
  const schedule = buildGraphSchedule(suite);
  const runConfig = { timeoutMs, maxOutputBytes };
  const runIdentity = objectHash({ preparedRunIdentity: prepared.runIdentity, runConfig, schedule: schedule.map(({ runId, taskIndex, orderIndex, systemId }) => ({ runId, taskIndex, orderIndex, systemId })) });
  const runsDir = join(outputDir, "runs");
  const rawDir = join(outputDir, "raw", "queries");
  const scratch = join(outputDir, ".run-scratch");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const manifestPath = join(outputDir, "run-manifest.json");
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!resume) throw new Error(`run manifest already exists: ${manifestPath}; use --resume or a new output directory`);
    if (previous.runIdentity !== runIdentity) throw new Error("resume run identity does not match the existing manifest");
  }
  const startedAt = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).startedAt : new Date().toISOString();
  const baseManifest = {
    schemaVersion: 2,
    suiteId: suite.id,
    preparedRunIdentity: prepared.runIdentity,
    runIdentity,
    runConfig,
    startedAt,
    status: "running",
    schedule: schedule.map(({ runId, taskIndex, orderIndex, systemId }) => ({ runId, taskIndex, orderIndex, systemId })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(baseManifest, null, 2)}\n`);
  const runningManifestSha256 = fileHash(manifestPath);
  const scheduleIdentityContext = {
    ...identityContext, runManifestPath: manifestPath, runningManifestSha256,
  };
  const guard = new GraphDbGuard(subjectRoot, scratch);
  const rows = [];
  let activeRunId = null;
  try {
    try {
      for (const item of schedule) {
        activeRunId = item.runId;
        assertScheduleIdentity(scheduleIdentityContext, `before ${item.runId}`);
        const resultPath = join(runsDir, `${item.runId}.json`);
        const expectedIdentity = { runIdentity, runId: item.runId, taskId: item.task.id, system: item.systemId };
        if (existsSync(resultPath)) {
          if (!resume) throw new Error(`result already exists: ${resultPath}`);
          const rawStdout = join(rawDir, `${item.runId}.stdout.jsonl`);
          const rawStderr = join(rawDir, `${item.runId}.stderr.txt`);
          if (!existsSync(rawStdout) || !existsSync(rawStderr)) throw new Error(`resume result is missing raw output: ${item.runId}`);
          rows.push(existingResult(resultPath, expectedIdentity));
          assertScheduleIdentity(scheduleIdentityContext, `after ${item.runId}`);
          continue;
        }
        const preparedSystem = prepared.systems[item.systemId];
        guard.activate(preparedSystem.index.path);
        const command = systemCommands[item.systemId];
        const args = [...command.slice(1), ...graphTaskArgs(item.task)];
        process.stderr.write(`[eval:graph] ${item.runId}\n`);
        const processResult = await runProcess(command[0], args, { cwd: subjectRoot, timeoutMs, maxOutputBytes });
        writeFileSync(join(rawDir, `${item.runId}.stdout.jsonl`), processResult.stdout);
        writeFileSync(join(rawDir, `${item.runId}.stderr.txt`), processResult.stderr);
        // A subject can be nested below the harness repository. Restore the
        // original graph before hashing either tree so the evaluator's own
        // temporary DB swap cannot appear as harness/source drift.
        guard.restore();
        // A query may overlap an editor/build process. Preserve its raw output
        // for diagnosis, but never grade it against a source tree, CLI bundle,
        // prepared snapshot, or run manifest that changed while it executed.
        assertScheduleIdentity(scheduleIdentityContext, `after ${item.runId}`);
        const parsed = parseJsonLines(processResult.stdout, item.runId);
        const allowError = item.task.expect?.noResult === true || (item.task.expect?.errorCodes?.length ?? 0) > 0;
        const violations = [...parsed.errors];
        if (processResult.timedOut) violations.push("command timed out");
        if (processResult.error) violations.push(`command error: ${processResult.error.message}`);
        if (processResult.code !== 0) violations.push(`command exited ${processResult.code}`);
        violations.push(...validateGraphResponse(parsed.records, expectedGraphCommand(item.task), {
          allowErrorRecords: allowError,
          allowTerminalError: allowError,
        }));
        const preparedGold = prepared.goldEvidence?.find((entry) => entry.taskId === item.task.id);
        const evaluatedTask = preparedGold ? {
          ...item.task,
          gold: preparedGold.gold,
          acceptableAlternates: preparedGold.acceptableAlternates,
          mustNotReturn: preparedGold.mustNotReturn,
        } : item.task;
        const graphCoverage = coverageForTask(prepared.graphCoverage?.[item.systemId] ?? preparedSystem.goldCoverage, item.task.id);
        const metrics = gradeRetrieval(evaluatedTask, parsed.records, processResult, graphCoverage);
        if (!metrics.errorExpectationMet) {
          violations.push(
            `unexpected error code(s) ${metrics.unexpectedErrorCodes.join(", ")}; allowed codes are `
            + `${(item.task.expect?.errorCodes ?? []).join(", ") || "none"}`,
          );
        }
        const row = {
          schemaVersion: 2,
          ...expectedIdentity,
          taskIndex: item.taskIndex,
          orderIndex: item.orderIndex,
          task: evaluatedTask,
          graphCoverage,
          command: processResult.command,
          process: {
            code: processResult.code,
            signal: processResult.signal,
            timedOut: processResult.timedOut,
            elapsedMs: processResult.elapsedMs,
            stdoutBytes: processResult.stdoutBytes,
            stderrBytes: processResult.stderrBytes,
          },
          metrics,
          valid: violations.length === 0,
          violations,
        };
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
  return { rows, manifest, prepared };
}

export function loadGraphRows(outputDir) {
  const manifestPath = join(outputDir, "run-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`missing run manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return manifest.schedule.map((item) => {
    const path = join(outputDir, "runs", `${item.runId}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }).filter(Boolean);
}
