import { constants, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { prices } from "../../scripts/delivery-replay/cost.mjs";
import { exportReplay } from "./export-replay.mjs";
import { readSession, requireAdapter, runTurn, versionOf } from "./lib/agents.mjs";
import { checkBaseline, checkedRun, checkNoLearned, clearCredentials, copyCredential, exposeMex, isolatedPath, makeArm, platformPin, preflightMex, readLearned, seedLearned, useOAuthToken } from "./lib/arms.mjs";
import { grade } from "./lib/grader.mjs";
import { buildReport, renderReport } from "./lib/report.mjs";
import { startSampler } from "./lib/resources.mjs";
import { armOrder, loadSuite, taskPrompt } from "./lib/suite.mjs";
import { readModelCalls, recordPath } from "./lib/usage.mjs";
import { createWorkspace, resolveCommit, unlinkDependencies } from "./lib/workspace.mjs";

const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const fullHash = /^(?:[\da-f]{40}|[\da-f]{64})$/i;

function taskBases(suite, subjectRoot) {
  return suite.tasks.map(task => {
    const base = resolveCommit(subjectRoot, task.base);
    const fix = task.hiddenTests.fromCommit && resolveCommit(subjectRoot, task.hiddenTests.fromCommit);
    return { ...task, base, hiddenTests: { ...task.hiddenTests, fromCommit: fix } };
  });
}

export async function runChain(options) {
  const { agent, pin, command, suiteFile, subjectRoot, output, cli, depsDir, credentialFile, tokenFile, learnedDir,
    timeoutMs = 300000, sampleMs = 1000, fixtures = false } = options;
  const adapter = requireAdapter(agent);
  if (!pin || ![pin.model, pin.effort, pin.version, pin.mexVersion].every(value => typeof value === "string" && value)
      || !fullHash.test(pin.mexCommit) || !Array.isArray(command) || !command.length
      || !command.every(value => typeof value === "string" && value)
      || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(sampleMs) || sampleMs < 0) {
    throw new Error("Run needs a command, positive timeout, sample interval, and pinned versions, model, effort and MEX commit");
  }
  if (tokenFile && (agent !== "claude" || credentialFile)) throw new Error("A token file is for Claude Code, in place of a credential file");
  if (!fixtures && !credentialFile && !tokenFile) throw new Error("A file credential or a Claude Code token file is required for a real chain");
  const suite = loadSuite(suiteFile);
  // With learned entries, both arms run MEX and only "mex" holds them.
  const learned = learnedDir ? readLearned(learnedDir) : undefined;
  const runsMex = arm => arm === "mex" || learned !== undefined;
  const tasks = taskBases(suite, subjectRoot);
  const setupBase = suite.setupBase ? resolveCommit(subjectRoot, suite.setupBase) : tasks[0].base;
  const forbidden = tasks.map(task => task.hiddenTests.fromCommit).filter(Boolean);

  mkdirSync(output, { mode: 0o700 });
  const homes = join(output, "homes");
  const recordings = join(output, "recordings");
  const completed = join(output, "graded");
  for (const directory of [homes, recordings, completed]) mkdirSync(directory, { mode: 0o700 });
  const path = isolatedPath();
  const profiles = [];
  const rows = [];
  const manifest = {
    schemaVersion: 1, suite: suite.id, agent, model: pin.model, effort: pin.effort, timeoutMs,
    credential: tokenFile ? "oauth-token" : credentialFile ? "file" : "none",
    ...platformPin(), mexCommit: pin.mexCommit, mexVersion: pin.mexVersion, fixtures,
    mexCliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
    prices: { profile: prices.profile, date: prices.date, source: prices.source },
    contrast: learned ? "learned-rules" : "mex",
    ...(learned ? { learned: learned.map(({ name, bytes }) => ({ name, sha256: createHash("sha256").update(bytes).digest("hex") })) } : {}),
    order: tasks.map((task, index) => ({ task: task.id, arms: armOrder(index) })),
    sessions: [],
  };

  try {
    for (const arm of ["baseline", "mex"]) {
      const profile = makeArm(homes, arm, path);
      profiles.push(profile);
      const { root, env } = profile;
      if (fixtures) {
        env.MEX_SETUP_BACKGROUND_AGENTS = "0";
        env.MEX_OFFLINE = "1";
        env.MEX_BACKGROUND_IDLE_MS = "5000";
      }
      copyCredential(profile, agent, credentialFile);
      if (tokenFile) useOAuthToken(profile, tokenFile);
      adapter.configure(profile, pin);
      const version = await versionOf(command, profile, pin);
      manifest.agentVersion = version;
      if (!runsMex(arm)) {
        checkBaseline(profile);
      } else {
        const actual = await checkedRun(process.execPath, [cli, "--version"], { cwd: root, env, timeoutMs }, "MEX version check");
        if (actual.stdout.trim() !== pin.mexVersion) throw new Error("MEX version does not match the run pin");
        profile.hooks = await preflightMex(profile, cli, adapter.hookAgent, { requireNative: !fixtures });
        manifest.hookRuntime = profile.hooks.runtime;
        exposeMex(profile, cli);
      }
    }
    const mex = profiles[1];
    const setup = [];
    const cursors = {};
    for (const profile of profiles.filter(item => runsMex(item.arm))) {
      createWorkspace({ subjectRoot, workspace: profile.workspace, base: setupBase, forbidden, depsDir });
      await checkedRun(process.execPath, [cli], { cwd: profile.workspace, env: profile.env, timeoutMs }, "MEX repository setup");
      if (learned && profile.arm === "mex") {
        seedLearned(profile, learned);
        // The entries get their verdicts the way a person's would after learning.
        await checkedRun(process.execPath, [cli, "check", "--json"], { cwd: profile.workspace, env: profile.env, timeoutMs }, "MEX check of the learned entries");
      }
      unlinkDependencies(profile.workspace);
      renameSync(profile.workspace, join(completed, (learned ? profile.arm + "-" : "") + "mex-setup"));
      const calls = readModelCalls(profile);
      setup.push(...calls);
      cursors[profile.arm] = calls.at(-1)?.id ?? 0;
    }

    for (const [index, task] of tasks.entries()) {
      for (const arm of armOrder(index)) {
        const profile = profiles.find(item => item.arm === arm);
        const { workspace } = profile;
        createWorkspace({ subjectRoot, workspace, base: task.base, forbidden: task.hiddenTests.fromCommit ? [task.hiddenTests.fromCommit] : [], depsDir });
        if (!runsMex(arm)) checkBaseline(profile);
        else if (learned && arm === "baseline") checkNoLearned(profile, learned);
        const stem = [agent, arm, task.id].join("-");
        const sampler = sampleMs > 0 ? startSampler({ path: workspace, csv: join(output, stem + ".csv"),
          record: runsMex(arm) ? recordPath(profile) : "", intervalMs: sampleMs }) : null;
        let native;
        let resources;
        let wallMs;
        try {
          if (sampler && !await sampler.ready) throw new Error("Resource sampler could not start");
          const started = performance.now();
          const parameters = { adapter, command, profile, pin, timeoutMs };
          const session = await runTurn({ ...parameters, prompt: taskPrompt(task) });
          if (task.reviewerNotes !== undefined) await runTurn({ ...parameters, session, prompt: task.reviewerNotes });
          wallMs = Math.round(performance.now() - started);
          native = readSession(adapter, profile, session, pin.model);
        } finally {
          if (sampler) resources = await sampler.stop();
        }
        if (resources && resources.code !== 0) throw new Error("Resource sampler failed: " + resources.error);
        const file = stem + ".jsonl";
        copyFileSync(native.file, join(recordings, file), constants.COPYFILE_EXCL);
        manifest.sessions.push({ agent, file: "recordings/" + file, subjectRepo: suite.subjectRepo, commit: task.base, arm, task: task.id });

        const gradeResult = await grade({ task, profile, subjectRoot, path, transcript: join(recordings, file), timeoutMs });
        json(join(output, stem + ".grade.json"), gradeResult);
        const mexCalls = runsMex(arm) ? readModelCalls(profile, cursors[arm]) : [];
        if (runsMex(arm)) cursors[arm] = mexCalls.at(-1)?.id ?? cursors[arm];
        unlinkDependencies(workspace);
        renameSync(workspace, join(completed, stem));
        rows.push({ task: task.id, arm, accepted: gradeResult.accepted, agentUsage: native.usage, mexCalls, turns: task.reviewerNotes === undefined ? 1 : 2, wallMs, resources });
      }
    }
    for (const profile of profiles.filter(item => runsMex(item.arm))) {
      rows.findLast(row => row.arm === profile.arm).mexCalls.push(...readModelCalls(profile, cursors[profile.arm]));
    }
    const report = buildReport(rows, setup);
    const reportText = renderReport(report, manifest);
    const manifestPath = join(output, "run-manifest.json");
    json(manifestPath, manifest);
    json(join(output, "report.json"), report);
    writeFileSync(join(output, "report.md"), reportText, { mode: 0o600 });
    const replay = exportReplay(manifestPath, join(output, "replay"));
    return { manifest, report, reportText, replay };
  } finally {
    const failures = [];
    for (const profile of profiles) {
      try { clearCredentials(profile); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Could not remove every arm credential copy");
  }
}

export async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    agent: { type: "string" }, suite: { type: "string" }, subject: { type: "string" }, output: { type: "string" },
    pin: { type: "string" }, cli: { type: "string" }, deps: { type: "string" }, credentials: { type: "string" },
    "sample-ms": { type: "string" }, "timeout-ms": { type: "string" }, "oauth-token-file": { type: "string" },
    learned: { type: "string" },
  } });
  if (!values.agent || !values.suite || !values.subject || !values.output || !values.pin) {
    throw new Error("Usage: node evaluate/arm/index.mjs --agent <claude|codex> --suite <json> --subject <repo> --output <new-directory> --pin <json>");
  }
  const adapter = requireAdapter(values.agent);
  const pinFile = resolve(values.pin);
  const pin = JSON.parse(readFileSync(pinFile, "utf8"));
  const result = await runChain({
    agent: values.agent, suiteFile: resolve(values.suite), subjectRoot: resolve(values.subject), output: resolve(values.output),
    cli: values.cli ? resolve(values.cli) : fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
    depsDir: values.deps && resolve(values.deps),
    credentialFile: values.credentials && resolve(values.credentials),
    tokenFile: values["oauth-token-file"] && resolve(values["oauth-token-file"]),
    learnedDir: values.learned && resolve(values.learned),
    pin, command: pin.command ?? [adapter.executable], sampleMs: values["sample-ms"] === undefined ? undefined : Number(values["sample-ms"]),
    timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
  });
  process.stdout.write(result.reportText);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
