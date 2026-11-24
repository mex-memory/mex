import assert from "node:assert/strict";
import { currentGraphPath } from "../dist/graph-storage.js";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createBenchmarkEnvironment } from "./release-benchmark/environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OFFICIAL_SKILLS = ["mex-statechart"];
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("The packed Hub smoke must run through npm so its CLI entry is known.");
}
const work = mkdtempSync(join(tmpdir(), "mex-hub-pack-smoke-"));
const smokeEnv = createBenchmarkEnvironment(work);
let retainWorkspace = false;
// Reuse npm's configured cache (setup-node restores it in CI). The consumer
// projects and node_modules remain fresh; cached registry tarballs do not carry
// project state. Prefer cached metadata while allowing uncached dependencies.
try {
  const npmCache = runNpm(["config", "get", "cache"], root).trim();
  const packOutput = runNpm([
    "pack",
    "--json",
    "--cache",
    npmCache,
    "--pack-destination",
    work,
  ], root);
  const packResult = parsePackResult(packOutput);
  const tarball = join(work, basename(packResult.filename));
  verifyPackedSkillTrees(packResult);
  await verifyFreshCodeRepoSetup(tarball, work, npmCache, packResult.version);
  const project = join(work, "project");
  mkdirSync(join(project, ".mex"), { recursive: true });
  writeFileSync(join(project, "package.json"), "{\n  \"private\": true\n}\n");
  writeFileSync(join(project, ".gitignore"), "node_modules/\n.mex/graph.db*\n.mex/local/\n");
  writeFileSync(join(project, "CLAUDE.md"), [
    "# Consumer Claude instructions",
    "",
    "Keep this line byte-for-byte.",
    "",
  ].join("\n"));
  writeFileSync(join(project, "AGENTS.md"), [
    "# Consumer Codex instructions",
    "",
    "Keep this line byte-for-byte.",
    "",
  ].join("\n"));
  mkdirSync(join(project, ".claude", "skills", "consumer-owned"), { recursive: true });
  writeFileSync(join(project, ".claude", "skills", "consumer-owned", "SKILL.md"), [
    "---",
    "name: consumer-owned",
    "description: A consumer-owned Claude skill that MEX must never inspect or rewrite.",
    "---",
    "",
  ].join("\n"));
  mkdirSync(join(project, ".agents", "skills", "consumer-owned"), { recursive: true });
  writeFileSync(join(project, ".agents", "skills", "consumer-owned", "SKILL.md"), [
    "---",
    "name: consumer-owned",
    "description: A consumer-owned Codex skill that MEX must never inspect or rewrite.",
    "---",
    "",
  ].join("\n"));
  writeFileSync(join(project, ".mex", "ROUTER.md"), "# Project Router\n");
  writeFileSync(
    join(project, ".mex", "config.json"),
    JSON.stringify({
      scaffold_id: "11111111-1111-4111-8111-111111111111",
      scaffold_name: "packed-hub-smoke",
      wiki: {
        exclude: ["excluded/**"],
        readOnly: ["context/read-only/**"],
      },
    }, null, 2) + "\n",
  );
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "packed.ts"), [
    "export function packedService(input: number): number {",
    "  return input * 2;",
    "}",
    "",
    "export function packedCaller(): number {",
    "  return packedService(21);",
    "}",
    "",
  ].join("\n"));
  run("git", ["init", "--quiet"], project);
  run("git", ["config", "user.name", "Packed Ada"], project);
  run("git", ["config", "user.email", "packed@example.test"], project);
  run("git", [
    "add",
    ".gitignore",
    "package.json",
    "CLAUDE.md",
    "AGENTS.md",
    ".claude",
    ".agents",
    ".mex",
    "src",
  ], project);
  run("git", ["commit", "--quiet", "-m", "test fixture"], project);
  const beforeInstallAgentSurfaces = snapshotAgentSurfaces(project);
  runNpm([
    "install",
    tarball,
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--prefer-offline",
    "--cache",
    npmCache,
  ], project);
  const afterInstallAgentSurfaces = snapshotAgentSurfaces(project);
  if (
    JSON.stringify(afterInstallAgentSurfaces) !== JSON.stringify(beforeInstallAgentSurfaces)
    || [".claude", ".agents"].some((clientRoot) => OFFICIAL_SKILLS.some((skill) => (
      existsSync(join(project, clientRoot, "skills", skill))
    )))
    || ["CLAUDE.md", "AGENTS.md"].some((name) => (
      readFileSync(join(project, name), "utf8").includes("<!-- mex-agent:skills:start -->")
    ))
  ) {
    throw new Error("Plain npm install mutated project skills or root agent instructions.");
  }

  const installed = join(project, "node_modules", "mex-agent");
  const assets = verifyPackedHubAssets(installed, packResult);
  const installedPackageVersion = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  ).version;
  if (installedPackageVersion !== packResult.version) {
    throw new Error("The installed package version did not match the npm pack result.");
  }
  verifyInstalledPackageSkillTrees(installed);
  const declaration = readFileSync(join(installed, "dist", "index.d.ts"), "utf8");
  if (
    /StatechartArtifact|DiagramRepository|DiagramDetail|Hub(?:Job|Api|Session|Capabilities|Activity|Wiki)|Activity(?:Request|Response|Item|Diagnostic)|CodeWorkspace|CodeKnowledge(?:Request|Response)|GraphHealthDetails|WikiHealthDetails|WikiEntity(?:List|Detail)(?:Request|Response)|Wiki(?:Relations|Backlinks)(?:Request|Response)|WikiSearchResult|RepositoryGraphPort|RepositoryWiki|createRepositoryWikiPort|runHubCommand|TeamRelay|RelayHandoff/.test(
      declaration,
    )
  ) {
    throw new Error("Private Hub or Relay declarations leaked through the package root.");
  }

  const cli = join(installed, "dist", "cli.js");
  const cliHelp = run(process.execPath, [cli, "--help"], project);
  if (/^\s*skills\s+/mu.test(cliHelp)) throw new Error("The packed help exposed a removed command.");

  const beforeSetupHead = run("git", ["rev-parse", "HEAD"], project).trim();
  const setupOutput = runNoninteractiveAgentSetup(cli, project, work);
  verifyPackedSetupOutput(setupOutput);
  verifySetupConfig(project);
  verifySetupIgnoreProtection(project);
  verifyInstalledAgentAssets(project, installed, installedPackageVersion);
  if (
    run("git", ["rev-parse", "HEAD"], project).trim() !== beforeSetupHead
    || run("git", ["diff", "--cached", "--name-only"], project).trim().length !== 0
  ) {
    throw new Error("The packed setup staged or committed project changes automatically.");
  }

  // Team workflows intentionally require the current config bytes to be
  // tracked. The product setup must not commit them, so the smoke fixture does
  // that explicitly before exercising the packed Relay CLI.
  run("git", ["add", ".mex/config.json"], project);
  run("git", ["commit", "--quiet", "-m", "record packed setup selection"], project);

  const relayContractOutput = run(
    process.execPath,
    [cli, "relay", "contract", "--json"],
    work,
  );
  if (Buffer.byteLength(relayContractOutput, "utf8") > 65_536) {
    throw new Error("The packed Relay resolver exceeded its 64 KiB output ceiling.");
  }
  const relayContract = JSON.parse(relayContractOutput);
  if (
    relayContract?.command !== "relay.contract"
    || relayContract?.ok !== true
    || relayContract?.data?.requestFile?.schemaRef
      !== "https://mex.dev/contracts/team-relay-request-v1.json"
    || relayContract?.data?.applyFile?.schemaRef
      !== "https://mex.dev/contracts/team-relay-preview-envelope-v1.json"
  ) {
    throw new Error("The packed install omitted the static Relay command contract.");
  }
  const relayExamples = relayContract?.data?.requestFile?.examples;
  const sparseRelayDraft = relayExamples?.[0]?.request?.action?.draft;
  if (
    !Array.isArray(relayExamples)
    || relayExamples.length === 0
    || relayExamples[0]?.command !== "relay.draft.save"
    || JSON.stringify(Object.keys(sparseRelayDraft ?? {}).sort())
      !== JSON.stringify(["audience", "recipients", "summary"])
    || sparseRelayDraft?.audience !== "team"
    || JSON.stringify(sparseRelayDraft?.recipients) !== "[]"
    || !relayExamples.some((example) => (
      Array.isArray(example?.request?.action?.draft?.evidence)
      && example.request.action.draft.evidence.some((item) => item?.kind === "commit")
      && example.request.action.draft.evidence.some((item) => item?.kind === "external")
    ))
  ) {
    throw new Error("The packed Relay resolver did not lead with the sparse standalone v1 request contract.");
  }
  const sparseRelayRequest = join(work, "relay-sparse-request.json");
  writeFileSync(sparseRelayRequest, JSON.stringify(relayExamples[0].request));
  const sparseRelayPreview = JSON.parse(run(
    process.execPath,
    [cli, "relay", "draft", "save", sparseRelayRequest, "--json"],
    project,
  ));
  const normalizedSparseDraft = sparseRelayPreview?.data?.request?.action?.draft;
  if (
    sparseRelayPreview?.ok !== true
    || normalizedSparseDraft?.audience !== "team"
    || JSON.stringify(normalizedSparseDraft?.recipients) !== "[]"
    || Object.hasOwn(normalizedSparseDraft ?? {}, "workstream")
    || ![
      "completed",
      "inProgress",
      "decisions",
      "blockers",
      "unresolvedQuestions",
      "changedFiles",
      "code",
      "evidence",
      "nextActions",
    ].every((key) => Array.isArray(normalizedSparseDraft?.[key]))
  ) {
    throw new Error("The packed Relay CLI did not normalize the sparse standalone draft.");
  }
  const relaySaveHelp = run(process.execPath, [cli, "relay", "draft", "save", "--help"], project);
  if (!relaySaveHelp.includes("--from <draft-file>") || !relaySaveHelp.includes("--operation-id <id>")) {
    throw new Error("The packed Relay help omitted the sparse local quick-save surface.");
  }
  const packedCapabilitiesOutput = run(
    process.execPath,
    [cli, "capabilities", "--json"],
    project,
  );
  if (Buffer.byteLength(packedCapabilitiesOutput, "utf8") > 32_768) {
    throw new Error("The packed capability manifest exceeded its 32 KiB output ceiling.");
  }
  const packedCapabilities = JSON.parse(packedCapabilitiesOutput);
  const packedRelayCommands = Object.values(packedCapabilities?.data?.commands ?? {})
    .flat()
    .filter((entry) => typeof entry?.id === "string" && entry.id.startsWith("relay."));
  if (
    packedRelayCommands.length !== 1
    || packedRelayCommands[0]?.id !== "relay.contract"
    || packedRelayCommands[0]?.contractResolver !== "relay.contract"
    || packedCapabilitiesOutput.includes("team-relay-request-v1.json")
    || packedCapabilitiesOutput.includes("team-relay-preview-envelope-v1.json")
  ) {
    throw new Error("The packed capability manifest expanded the compact Relay resolver descriptor.");
  }
  const foregroundHome = join(work, "foreground-home");
  const backgroundHome = join(work, "background-home");
  run(process.execPath, [cli, "index", "status", "--json"], project, { ...smokeEnv, MEX_HOME: foregroundHome });
  const beforeReads = snapshotProtectedProjectState(project);
  await verifyForegroundHub({ cli, project, home: foregroundHome, assets, version: installedPackageVersion });
  await verifyBackgroundHub({ cli, project, home: backgroundHome, version: installedPackageVersion });
  assert(
    JSON.stringify(snapshotProtectedProjectState(project)) === JSON.stringify(beforeReads),
    "The packaged Hub mutated protected project state.",
  );

  // The Relay shortcut may only change checkout-local Relay state.
  const beforeQuickSave = snapshotProtectedProjectState(project, {
    includeRuntimeState: false,
  });
  const quickDraftFile = join(work, "relay-quick-draft.json");
  const quickSummary = "Resume the packed-install investigation when a teammate joins.";
  writeFileSync(quickDraftFile, JSON.stringify({ summary: quickSummary }));
  const quickSave = JSON.parse(run(process.execPath, [
    cli, "relay", "draft", "save", "--from", quickDraftFile,
    "--operation-id", "packed-relay-quick-save", "--json",
  ], project));
  const savedLocal = quickSave?.data?.localChanges?.[0];
  if (
    quickSave?.ok !== true
    || quickSave?.command !== "relay.draft.save"
    || quickSave?.mode !== "apply"
    || quickSave?.data?.applied !== true
    || quickSave?.data?.localChanges?.length !== 1
    || savedLocal?.namespace !== "relay-draft"
    || savedLocal?.beforeRevision !== null
    || typeof savedLocal?.id !== "string"
    || !/^[a-f0-9]{64}$/.test(savedLocal?.afterRevision ?? "")
    || JSON.stringify(quickSave?.data?.changes) !== "[]"
    || JSON.stringify(quickSave?.data?.relays) !== "[]"
    || JSON.stringify(quickSave?.data?.events) !== "[]"
  ) {
    throw new Error("The packed Relay shortcut did not save exactly one local draft without publication.");
  }
  const savedDraft = JSON.parse(run(process.execPath, [
    cli, "relay", "draft", "show", savedLocal.id, "--json",
  ], project));
  if (
    savedDraft?.ok !== true
    || savedDraft?.data?.id !== savedLocal.id
    || savedDraft?.data?.revision !== savedLocal.afterRevision
    || savedDraft?.data?.summary !== quickSummary
    || savedDraft?.data?.input?.audience !== "team"
    || JSON.stringify(savedDraft?.data?.input?.recipients) !== "[]"
    || JSON.stringify(snapshotProtectedProjectState(project, {
      includeRuntimeState: false,
      })) !== JSON.stringify(beforeQuickSave)
  ) {
    throw new Error("The packed Relay shortcut lost its draft or changed protected project state.");
  }
  process.stdout.write("Packed machine Hub (foreground and background) and official agent-skills smoke test passed.\n");
} finally {
  if (retainWorkspace || process.env.MEX_KEEP_SMOKE_WORK === "1") {
    process.stdout.write(`Retained packed smoke workspace: ${work}\n`);
  } else {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function parsePackResult(output) {
  let parsed;
  const trimmed = output.trim();
  const jsonStart = trimmed.lastIndexOf("\n[");
  const candidate = jsonStart === -1 ? trimmed : trimmed.slice(jsonStart + 1);
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error("npm pack --json did not emit strict JSON.", { cause: error });
  }
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (
    !result
    || typeof result.filename !== "string"
    || result.filename.length === 0
    || typeof result.version !== "string"
    || !Array.isArray(result.files)
  ) {
    throw new Error("npm pack --json omitted its filename, version, or file inventory.");
  }
  return result;
}

async function verifyFreshCodeRepoSetup(tarball, workRoot, cache, version) {
  const project = join(workRoot, "fresh-setup-project");
  mkdirSync(join(project, "src", "setup"), { recursive: true });
  writeFileSync(join(project, "package.json"), [
    "{",
    '  "name": "mex-agent",',
    '  "private": true,',
    '  "bin": { "mex": "src/index.ts" }',
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(project, ".gitignore"), "node_modules/\n");
  writeFileSync(join(project, "src", "index.ts"), [
    "export function freshSetupValue(): number {",
    "  return 42;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(project, "src", "setup", "index.ts"), [
    "export function setupFixtureValue(): number {",
    "  return 8;",
    "}",
    "",
  ].join("\n"));
  run("git", ["init", "--quiet"], project);
  run("git", ["config", "user.name", "Fresh Setup"], project);
  run("git", ["config", "user.email", "fresh-setup@example.test"], project);
  run("git", ["add", ".gitignore", "package.json", "src"], project);
  run("git", ["commit", "--quiet", "-m", "initial fixture"], project);

  runNpm([
    "install",
    tarball,
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--prefer-offline",
    "--cache",
    cache,
  ], project);
  if (existsSync(join(project, ".mex")) || existsSync(join(project, "AGENTS.md"))) {
    throw new Error("Plain packed install mutated the fresh setup project.");
  }

  const installed = join(project, "node_modules", "mex-agent");
  const installedVersion = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version;
  if (installedVersion !== version) throw new Error("Fresh setup installed the wrong packed version.");
  const cli = join(installed, "dist", "cli.js");
  const agentBin = join(workRoot, "fresh-setup-agent-bin");
  mkdirSync(agentBin, { recursive: true });
  const agentInvocation = installSetupAgentGuards(agentBin, workRoot);

  const beforeHead = run("git", ["rev-parse", "HEAD"], project).trim();
  const output = runFreshCodeRepoSetup(cli, project, agentBin, agentInvocation);
  const normalized = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  for (const expected of [
    "Setup paused: scaffold population is still required.",
    "Population prompt:",
    "You are the population agent. Run `mex setup next --start` in this session and do exactly what it prints.",
    "Do not commit until setup reports complete.",
    "run `mex setup next --start` first, then do exactly what it prints.",
    "Wiki ids, links and index are ready.",
    "Graph and Wiki are ready. Review and commit the canonical MEX setup.",
  ]) {
    if (!normalized.includes(expected)) {
      throw new Error(`Packed fresh setup omitted: ${expected}\n${normalized}`);
    }
  }
  if (
    run("git", ["rev-parse", "HEAD"], project).trim() !== beforeHead
    || run("git", ["diff", "--cached", "--name-only"], project).trim().length !== 0
  ) {
    throw new Error("Fresh packed setup staged or committed changes automatically.");
  }

  const config = JSON.parse(readFileSync(join(project, ".mex", "config.json"), "utf8"));
  if (JSON.stringify(config.aiTools) !== JSON.stringify(["codex"])) {
    throw new Error("Fresh packed setup did not persist the selected Codex client.");
  }
  for (const file of [
    "AGENTS.md",
    "ROUTER.md",
    "context/architecture.md",
    "context/stack.md",
    "context/conventions.md",
    "context/decisions.md",
    "context/setup.md",
  ]) {
    const content = readFileSync(join(project, ".mex", file), "utf8");
    if (content.includes("[Project Name]") || content.includes("[YYYY-MM-DD]")) {
      throw new Error(`Manual fixture population left a required placeholder in ${file}.`);
    }
  }
  if (!existsSync(currentGraphPath(project, { home: join(smokeEnv.MEX_HOME, ".mex") })) || !existsSync(join(project, ".mex", "wiki.db"))) throw new Error("Fresh packed setup omitted a derived index.");
  verifySetupIgnoreProtection(project);
  const wiki = JSON.parse(run(process.execPath, [cli, "wiki", "list", "--json"], project));
  if (wiki?.ok !== true || !Array.isArray(wiki?.data?.entities) || wiki.data.entities.length === 0) {
    throw new Error("Fresh packed setup did not publish a readable Wiki index.");
  }

  run("git", ["add", ".mex", "AGENTS.md", ".agents"], project);
  const staged = run("git", ["diff", "--cached", "--name-only"], project);
  if (/\.mex\/(?:graph|wiki)\.db|\.mex\/local\//u.test(staged)) {
    throw new Error(`Fresh packed setup staged checkout-local state:\n${staged}`);
  }
  run("git", ["commit", "--quiet", "-m", "initialize MEX"], project);
  const committedConfig = run("git", ["show", "HEAD:.mex/config.json"], project);
  if (committedConfig !== readFileSync(join(project, ".mex", "config.json"), "utf8")) {
    throw new Error("Fresh packed setup config does not match current HEAD.");
  }
  const capabilities = JSON.parse(run(process.execPath, [cli, "capabilities", "--json"], project));
  for (const id of ["project_hub", "code_graph", "wiki"]) {
    const capability = capabilities?.data?.capabilities?.find((entry) => entry?.id === id);
    if (capability?.availability !== "available") {
      throw new Error(`Fresh packed setup left ${id} unavailable after the canonical commit.`);
    }
  }
}

function installSetupAgentGuards(directory, workRoot) {
  const invocation = join(workRoot, "unexpected-setup-agent.json");
  const script = join(workRoot, "unexpected-setup-agent.mjs");
  writeFileSync(script, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(invocation)}, JSON.stringify(process.argv));`,
    'process.stderr.write("Noninteractive setup must not launch an agent.\\n");',
    'process.exitCode = 99;',
    '',
  ].join("\n"), "utf8");
  for (const command of ["claude", "codex"]) {
    if (process.platform === "win32") {
      writeFileSync(join(directory, `${command}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`, "utf8");
    } else {
      const executable = join(directory, command);
      writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
      chmodSync(executable, 0o755);
    }
  }
  return invocation;
}

function populateSetupFixture(project) {
  // Stand in for an explicit user/agent edit after the plain CLI pauses. The
  // setup command itself must never invoke the available fake agent above.
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const before = readFileSync(path, "utf8");
        const after = before
          .replaceAll("[Project Name]", "Setup Fixture")
          .replaceAll("[YYYY-MM-DD]", "2026-09-02");
        if (after !== before || entry.name === "ROUTER.md") {
          // Setup counts project knowledge, not text appended to MEX-managed boilerplate.
          const note = "\nAuthored project guidance from source inspection.\n";
          const slot = /^## (?:What This Is|Current (?:Project|Operational) State)[^\n]*\r?\n/mu.exec(after);
          const at = slot ? slot.index + slot[0].length : after.length;
          writeFileSync(path, after.slice(0, at) + note + after.slice(at), "utf8");
        }
      }
    }
  };
  visit(join(project, ".mex"));
}

function runFreshCodeRepoSetup(cli, project, agentBin, agentInvocation) {
  const env = { ...smokeEnv };
  // Replace every spelling of PATH, including Path on Windows, so the sentinel
  // agents always win over any developer-machine installation.
  const originalPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = `${agentBin}${delimiter}${originalPath}`;
  const locatedAgent = spawnSync(
    locateSmokeExecutable(process.platform === "win32" ? "where.exe" : "which"),
    ["codex"],
    { cwd: project, env, encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  const expectedAgent = join(agentBin, process.platform === "win32" ? "codex.cmd" : "codex");
  // where.exe expands Windows short paths and normalizes their case.
  const canonical = (path) => {
    const real = realpathSync.native(path);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  const locatedPath = locatedAgent.stdout?.split(/\r?\n/u)[0].trim();
  if (locatedAgent.error || locatedAgent.status !== 0
    || !locatedPath || canonical(locatedPath) !== canonical(expectedAgent)) {
    throw new Error("The packed fresh setup smoke did not expose its guarded Codex CLI first on PATH.");
  }
  const assertNoAgent = () => {
    if (existsSync(agentInvocation)) {
      throw new Error("Packed noninteractive setup launched an agent instead of pausing for manual population.");
    }
  };
  return runManualPopulationSetup(cli, project, env, ["codex"], { assertNoAgent });
}

function runNoninteractiveAgentSetup(cli, project, workRoot) {
  const emptyPath = join(workRoot, "empty-agent-path");
  mkdirSync(emptyPath, { recursive: true });

  // Also exercise selected integrations when no corresponding agent CLI is
  // installed. Keep Node absolute and prove the restricted PATH still has Git.
  const env = { ...smokeEnv };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = installGitOnlyPath(emptyPath);
  verifyManualSetupEnvironment(project, env);
  return runManualPopulationSetup(cli, project, env, ["claude", "codex"], { legacyCli: true });
}

function runManualPopulationSetup(cli, project, env, tools, {
  legacyCli = false,
  assertNoAgent = () => {},
} = {}) {
  const entryOptions = legacyCli ? ["--cli"] : [];
  const paused = runPlainSetup(cli, project, env, [
    ...entryOptions, "--mode", "code-repo", ...tools.flatMap((tool) => ["--tool", tool]),
  ], 2);
  assertNoAgent();
  for (const expected of [
    "Setup paused: scaffold population is still required.",
    "Population prompt:",
    "You are the population agent. Run `mex setup next --start` in this session and do exactly what it prints.",
    "Do not commit until setup reports complete.",
    "run `mex setup next --start` first, then do exactly what it prints.",
  ]) {
    if (!paused.includes(expected)) {
      throw new Error(`Packed setup omitted its manual population checkpoint: ${expected}\n${paused}`);
    }
  }

  populateSetupFixture(project);
  // Omitting mode and tools on resume must retain the user's persisted choices.
  const completed = runPlainSetup(cli, project, env, entryOptions, 0);
  assertNoAgent();
  for (const expected of [
    "Wiki ids, links and index are ready.",
    "Graph and Wiki are ready. Review and commit the canonical MEX setup.",
    "Run `mex hub` to open the Hub.",
  ]) {
    if (!completed.includes(expected)) {
      throw new Error(`Packed setup did not finish preparation after manual population: ${expected}\n${completed}`);
    }
  }
  return `${paused}\n${completed}`;
}

function runPlainSetup(cli, project, env, options, expectedExit) {
  const args = [cli, "setup", "--yes", "--no-open", ...options];
  const result = spawnSync(process.execPath, args, {
    cwd: project,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== expectedExit || result.signal !== null) {
    throw new Error(
      `Packed plain setup expected exit ${expectedExit}, got ${String(result.status)}`
      + ` (signal ${String(result.signal)}).\n${result.stdout}\n${result.stderr}`,
      { cause: result.error },
    );
  }
  if (result.stdout.includes("\u001b[?1049h") || /Choice \[1-8\]|Enter tool numbers/u.test(result.stdout)) {
    throw new Error("Packed noninteractive setup rendered an interactive tool picker.");
  }
  return result.stdout;
}

function installGitOnlyPath(directory) {
  const executable = locateSmokeExecutable(process.platform === "win32" ? "git.exe" : "git");
  if (process.platform === "win32") {
    // Direct spawn cannot execute git.cmd. Keep native Git in its installation
    // directory so its runtime and helper paths remain valid.
    return dirname(executable);
  }
  symlinkSync(executable, join(directory, "git"));
  return directory;
}

function locateSmokeExecutable(command) {
  const located = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  const executable = located.status === 0
    ? located.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim()
    : undefined;
  if (!executable) throw new Error(`The packed setup smoke could not locate ${command}.`);
  return resolve(executable);
}

function verifyManualSetupEnvironment(project, env) {
  const options = { cwd: project, env, encoding: "utf8", timeout: 5_000, windowsHide: true };
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], options);
  if (git.error || git.status !== 0) {
    throw new Error("The packed setup smoke cannot run native Git in its restricted PATH.", {
      cause: git.error,
    });
  }
  // Locate the probe before restricting its environment. A missing `where` or
  // `which` must never count as evidence that Claude/Codex are unavailable.
  const locator = locateSmokeExecutable(process.platform === "win32" ? "where.exe" : "which");
  for (const command of ["claude", "codex"]) {
    const found = spawnSync(locator, [command], options);
    if (found.status === 0) {
      throw new Error(`The packed setup smoke unexpectedly exposes ${command} in its restricted PATH.`);
    }
    if (found.error || found.status !== 1) {
      throw new Error(`The packed setup smoke could not verify that ${command} is unavailable.`, {
        cause: found.error,
      });
    }
  }
}

function verifyPackedSetupOutput(output) {
  const normalized = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  const expectedMessages = [
    "Link AI tool instructions",
    "Install official MEX agent skills",
    "Setup paused: scaffold population is still required.",
    "Population prompt:",
    "You are the population agent. Run `mex setup next --start` in this session and do exactly what it prints.",
    "Do not commit until setup reports complete.",
    "run `mex setup next --start` first, then do exactly what it prints.",
    "Wiki ids, links and index are ready.",
    "Graph and Wiki are ready. Review and commit the canonical MEX setup.",
  ];
  // Installation itself is checked against the exact packaged trees, managed
  // instructions and both clients' idempotent sync reports below.
  if (!expectedMessages.every((message) => normalized.includes(message))) {
    throw new Error("The packed plain setup omitted its install, manual population, or completion status.");
  }
}

function verifySetupConfig(project) {
  const config = JSON.parse(readFileSync(join(project, ".mex", "config.json"), "utf8"));
  if (
    config.setupMode !== "code-repo"
    || JSON.stringify(config.aiTools) !== JSON.stringify(["claude", "codex"])
    || config.scaffold_id !== "11111111-1111-4111-8111-111111111111"
    || config.scaffold_name !== "packed-hub-smoke"
    || JSON.stringify(config.wiki) !== JSON.stringify({
      exclude: ["excluded/**"],
      readOnly: ["context/read-only/**"],
    })
  ) {
    throw new Error("The packed plain setup did not preserve code-repo intent, both clients, and existing config on resume.");
  }
}

function verifySetupIgnoreProtection(project) {
  const content = readFileSync(join(project, ".mex", ".gitignore"), "utf8");
  for (const rule of ["graph.db*", "wiki.db*", "local/"]) {
    if (!content.split(/\r?\n/u).includes(rule)) {
      throw new Error(`Packed setup omitted ${rule} from .mex/.gitignore.`);
    }
  }
  for (const path of [".mex/graph.db-wal", ".mex/wiki.db-shm", ".mex/local/team.db"]) {
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", path], {
      cwd: project, env: smokeEnv,
    });
    if (ignored.status !== 0) throw new Error(`Packed setup left ${path} trackable.`);
  }
}

function verifyPackedSkillTrees(packResult) {
  const packedFiles = new Set(packResult.files.map((file) => file?.path).filter((path) => (
    typeof path === "string"
  )));
  for (const skill of OFFICIAL_SKILLS) {
    const source = join(root, "skills", skill);
    const sourceFiles = collectTreeFiles(source);
    const expected = sourceFiles.map((file) => `skills/${skill}/${file.path}`);
    const actual = [...packedFiles]
      .filter((path) => path.startsWith(`skills/${skill}/`))
      .sort((left, right) => left.localeCompare(right, "en"));
    expected.sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`The npm pack tarball did not contain the complete ${skill} tree.`);
    }
    for (const required of ["SKILL.md", "agents/openai.yaml"]) {
      if (!sourceFiles.some((file) => file.path === required)) {
        throw new Error(`The canonical ${skill} source omitted ${required}.`);
      }
    }
    if (!sourceFiles.some((file) => file.path.startsWith("references/"))) {
      throw new Error(`The canonical ${skill} source omitted its progressive references.`);
    }
  }
}

function verifyInstalledPackageSkillTrees(installed) {
  for (const skill of OFFICIAL_SKILLS) {
    assertTreesEqual(
      join(root, "skills", skill),
      join(installed, "skills", skill),
      `installed package ${skill}`,
    );
  }
}

function parseSkillSyncReport(output, packageVersion, dryRun) {
  let report;
  try {
    report = JSON.parse(output.trim());
  } catch (error) {
    throw new Error("mex skills sync --json did not emit one strict JSON object.", { cause: error });
  }
  if (
    !report
    || Array.isArray(report)
    || report.schemaVersion !== 1
    || report.packageVersion !== packageVersion
    || report.dryRun !== dryRun
    || !Array.isArray(report.clients)
    || !Array.isArray(report.actions)
    || !Array.isArray(report.warnings)
    || typeof report.applied !== "boolean"
    || typeof report.changed !== "boolean"
    || typeof report.conflicted !== "boolean"
  ) {
    throw new Error("mex skills sync --json emitted an invalid agent-assets report.");
  }
  return report;
}

function verifyInstalledAgentAssets(project, installed, packageVersion) {
  const clients = [
    {
      name: "claude",
      skillsRoot: join(project, ".claude", "skills"),
      instructions: join(project, "CLAUDE.md"),
      originalInstructions: "# Consumer Claude instructions\n\nKeep this line byte-for-byte.\n",
      explicit: ["/mex-statechart"],
      foreignExplicit: ["$mex-statechart"],
    },
    {
      name: "codex",
      skillsRoot: join(project, ".agents", "skills"),
      instructions: join(project, "AGENTS.md"),
      originalInstructions: "# Consumer Codex instructions\n\nKeep this line byte-for-byte.\n",
      explicit: ["$mex-statechart"],
      foreignExplicit: ["/mex-statechart"],
    },
  ];

  for (const client of clients) {
    for (const skill of OFFICIAL_SKILLS) {
      const source = join(installed, "skills", skill);
      const destination = join(client.skillsRoot, skill);
      assertTreesEqual(source, destination, `${client.name} ${skill}`, {
        ignoredDestinationFiles: new Set([".mex-managed.json"]),
      });
      verifyOwnershipSidecar(destination, skill, packageVersion, source);
    }

    const instructions = readFileSync(client.instructions, "utf8");
    if (!instructions.startsWith(client.originalInstructions)) {
      throw new Error(`The ${client.name} setup did not preserve hand-written root instructions byte-for-byte.`);
    }
    if (
      countOccurrences(instructions, "<!-- mex-agent:skills:start -->") !== 1
      || countOccurrences(instructions, "<!-- mex-agent:skills:end -->") !== 1
      || !client.explicit.every((invocation) => instructions.includes(invocation))
      || client.foreignExplicit.some((invocation) => instructions.includes(invocation))
      || !instructions.includes("mention MEX and the relevant finding naturally in your explanation")
      || !instructions.includes("Skill activation is not approval for canonical actions.")
      || /mex-(?:inbox|relay)|mex (?:logging|timeline)/u.test(instructions)
    ) {
      throw new Error(`The ${client.name} setup instruction block was missing or not client-specific.`);
    }
  }

  const expectedConsumerOwned = {
    claude: "description: A consumer-owned Claude skill that MEX must never inspect or rewrite.",
    codex: "description: A consumer-owned Codex skill that MEX must never inspect or rewrite.",
  };
  for (const [client, expectedLine] of Object.entries(expectedConsumerOwned)) {
    const rootName = client === "claude" ? ".claude" : ".agents";
    const bytes = readFileSync(
      join(project, rootName, "skills", "consumer-owned", "SKILL.md"),
      "utf8",
    );
    if (!bytes.includes(expectedLine)) {
      throw new Error(`The ${client} setup rewrote an unrelated consumer-owned skill.`);
    }
  }
}

function verifyOwnershipSidecar(destination, skill, packageVersion, source) {
  const sidecarPath = join(destination, ".mex-managed.json");
  const bytes = readFileSync(sidecarPath, "utf8");
  if (!bytes.endsWith("\n")) {
    throw new Error(`${skill} ownership metadata was not deterministic newline-terminated JSON.`);
  }
  const metadata = JSON.parse(bytes);
  const sourceFiles = collectTreeFiles(source);
  const expectedFiles = Object.fromEntries(sourceFiles.map((file) => [
    file.path,
    createHash("sha256").update(file.bytes).digest("hex"),
  ]));
  const recordedPaths = Object.keys(metadata.files ?? {}).sort();
  const expectedPaths = Object.keys(expectedFiles).sort();
  if (
    metadata.schemaVersion !== 1
    || metadata.owner !== "mex-agent"
    || metadata.skill !== skill
    || metadata.packageVersion !== packageVersion
    || JSON.stringify(recordedPaths) !== JSON.stringify(expectedPaths)
    || expectedPaths.some((path) => metadata.files[path] !== expectedFiles[path])
    || JSON.stringify(Object.keys(metadata))
      !== JSON.stringify(["schemaVersion", "owner", "skill", "packageVersion", "files"])
  ) {
    throw new Error(`${skill} ownership metadata did not exactly describe the deployed payload.`);
  }
}

function assertTreesEqual(source, destination, label, { ignoredDestinationFiles = new Set() } = {}) {
  const sourceFiles = collectTreeFiles(source);
  const destinationFiles = collectTreeFiles(destination).filter((file) => (
    !ignoredDestinationFiles.has(file.path)
  ));
  const sourcePaths = sourceFiles.map((file) => file.path);
  const destinationPaths = destinationFiles.map((file) => file.path);
  if (JSON.stringify(destinationPaths) !== JSON.stringify(sourcePaths)) {
    throw new Error(`The ${label} file inventory did not match its packaged source.`);
  }
  for (let index = 0; index < sourceFiles.length; index += 1) {
    if (!sourceFiles[index].bytes.equals(destinationFiles[index].bytes)) {
      throw new Error(`The ${label} changed ${sourceFiles[index].path} while copying it.`);
    }
  }
}

function collectTreeFiles(directory, relativeRoot = "") {
  if (!existsSync(directory)) throw new Error(`Expected directory is missing: ${directory}`);
  const result = [];
  for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"))) {
    const absolute = join(directory, name);
    const relativePath = relativeRoot.length === 0 ? name : `${relativeRoot}/${name}`;
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`Packaged and managed skill trees must not contain symlinks: ${absolute}`);
    }
    if (stats.isDirectory()) {
      result.push(...collectTreeFiles(absolute, relativePath));
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Packaged and managed skill trees must contain regular files: ${absolute}`);
    }
    result.push({ path: relativePath, bytes: readFileSync(absolute) });
  }
  return result;
}

function snapshotAgentSurfaces(project) {
  const files = [];
  for (const path of [
    join(project, "CLAUDE.md"),
    join(project, "AGENTS.md"),
    join(project, ".claude"),
    join(project, ".agents"),
    join(project, ".mex"),
  ]) {
    collectSnapshotFiles(project, path, files);
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return files;
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function snapshotProtectedProjectState(
  project,
  {
    includeRuntimeState = true,
  } = {},
) {
  const status = run("git", [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ], project);
  const candidates = [
    join(project, ".mex", "events"),
    join(project, ".mex", "team"),
    join(project, ".mex", "context"),
    join(project, ".mex", "excluded"),
    join(project, ".mex", "topics"),
    join(project, ".mex", "ROUTER.md"),
    join(project, ".mex", "config.json"),
    join(project, "src"),
  ];
  if (includeRuntimeState) {
    const localRoot = join(project, ".mex", "local");
    if (existsSync(localRoot)) {
      for (const name of readdirSync(localRoot)) {
        if (name.startsWith("team.db")) candidates.push(join(localRoot, name));
      }
    }
  }
  for (const name of readdirSync(join(project, ".mex"))) {
    if (name.startsWith("wiki.db") || name.startsWith("graph.db")) {
      candidates.push(join(project, ".mex", name));
    }
  }
  candidates.push(
    join(project, ".git", "HEAD"),
    join(project, ".git", "index"),
    join(project, ".git", "refs", "heads"),
  );

  const files = [];
  for (const candidate of candidates) collectSnapshotFiles(project, candidate, files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    files,
    status,
  };
}

function collectSnapshotFiles(project, path, files) {
  if (!existsSync(path)) return;
  const stats = statSync(path, { bigint: true });
  if (stats.isDirectory()) {
    for (const name of readdirSync(path)) collectSnapshotFiles(project, join(path, name), files);
    return;
  }
  if (!stats.isFile()) return;
  files.push({
    path: path.slice(project.length + 1),
    bytes: readFileSync(path).toString("base64"),
    mtimeNs: stats.mtimeNs.toString(),
  });
}

function run(command, args, cwd, env = smokeEnv) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw new Error(
      `${command} ${args.join(" ")} could not start: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${String(result.status)}`
      + `${result.signal === null ? "" : ` (signal ${result.signal})`}:\n`
      + `${result.stderr || result.stdout || "The command produced no output."}`,
    );
  }
  return result.stdout;
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

function verifyPackedHubAssets(installed, packResult) {
  const hubRoot = join(installed, "dist", "hub");
  const files = new Map(collectTreeFiles(hubRoot).map(({ path, bytes }) => [path, bytes]));
  const packedPaths = new Set(packResult.files.map(({ path }) => path));
  assert(packedPaths.has("dist/hub-worker.js"), "The tarball omitted dist/hub-worker.js.");
  const worker = lstatSync(join(installed, "dist", "hub-worker.js"));
  assert(worker.isFile() && worker.size > 0, "The installed Hub worker is not a nonempty regular file.");
  for (const file of ["index.html", ".vite/manifest.json"]) {
    assert(files.get(file)?.length > 0 && packedPaths.has(`dist/hub/${file}`), `The packed Hub omitted ${file}.`);
  }
  const manifest = JSON.parse(files.get(".vite/manifest.json").toString("utf8"));
  assert(manifest["index.html"]?.isEntry === true, "The packed Hub has no application entry.");
  const hashedFiles = new Map();
  for (const entry of Object.values(manifest)) {
    for (const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) {
      assert(files.get(file)?.length > 0 && packedPaths.has(`dist/hub/${file}`), `The packed Hub omitted manifest asset ${file}.`);
      hashedFiles.set(`/${file}`, files.get(file));
    }
  }
  return { html: files.get("index.html"), hashedFiles };
}

async function verifyForegroundHub({ cli, project, home, assets, version }) {
  const port = await freePort();
  const child = startPackagedHub(cli, project, home, ["--foreground", "--no-open", "--port", String(port)]);
  try {
    const link = await readBootstrapUrl(child);
    assert.equal(link.origin, `http://127.0.0.1:${port}`, "The Hub did not bind the chosen loopback port.");
    const { origin } = link;
    const hello = await verifyHello(origin, "terminal", version);
    assertBound(home, { port, pid: child.pid, version, homeId: hello.homeId, mode: "terminal" });

    const readSession = (headers) => localFetch(origin, "/api/v1/session", { headers });
    const readProjects = (headers) => localFetch(origin, "/api/v1/projects", { headers });
    assert.equal((await readSession()).status, 401, "The session read must require a cookie.");
    assert.equal((await readProjects()).status, 401, "The projects read must require a cookie.");
    const token = new URLSearchParams(link.hash.slice(1)).get("token");
    assert(/^[A-Za-z0-9_-]{43}$/u.test(token ?? ""), "The packaged Hub omitted its sign-in token.");
    const exchange = () => localFetch(origin, "/api/v1/session/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ token }),
    });
    const bootstrap = await exchange();
    assert.equal(bootstrap.status, 201, "The bootstrap exchange failed.");
    const setCookie = bootstrap.headers.get("set-cookie");
    assert(setCookie?.startsWith("mex_hub_"), "The bootstrap exchange did not set a Hub cookie.");
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/api/v1"]) {
      assert(setCookie.split(/;\s*/u).includes(attribute), `The Hub cookie omitted ${attribute}.`);
    }
    const { csrfToken, expiresAt } = await bootstrap.json();
    const headers = { cookie: setCookie.split(";", 1)[0] };
    assert.equal((await exchange()).status, 401, "The bootstrap token was accepted twice.");
    const session = await readSession(headers);
    assert.equal(session.status, 200, "The packaged Hub session read failed.");
    const sessionBody = await session.json();
    assert(typeof csrfToken === "string" && csrfToken.length > 0 && sessionBody.csrfToken === csrfToken,
      "The packaged Hub session did not return its CSRF token.");
    assert.equal(sessionBody.expiresAt, expiresAt);
    assert.equal(sessionBody.version, version);
    assert.equal(sessionBody.mode, "terminal");
    assert.equal(realpathSync(sessionBody.homePath), realpathSync(join(home, ".mex")));

    const projects = await readProjects(headers);
    assert.equal(projects.status, 200, "The packaged Hub projects read failed.");
    const { projects: rows } = await projects.json();
    assert(
      Array.isArray(rows) && rows.length === 1 && rows[0].name === basename(project)
        && rows[0].kind === "git" && rows[0].checkouts?.length === 1
        && rows[0].checkouts[0].exists === true && realpathSync(rows[0].checkouts[0].path) === realpathSync(project),
      "The packed Hub did not return exactly the registered checkout from its own home.",
    );

    const heartbeat = (writeHeaders) => localFetch(origin, "/api/v1/session/heartbeat", {
      method: "POST", headers: { ...headers, ...writeHeaders },
    });
    const hubUntil = () => readRecord(home, (db) => db.prepare("SELECT hub_until FROM background WHERE id=1").get().hub_until);
    const beforeRejectedWrites = hubUntil();
    assert.equal((await heartbeat({ "x-mex-csrf": csrfToken })).status, 403, "A write without Origin succeeded.");
    assert.equal((await heartbeat({ origin })).status, 403, "A write without CSRF succeeded.");
    assert.equal(hubUntil(), beforeRejectedWrites, "A rejected heartbeat changed the Hub keepalive.");
    assert.equal(await requestWithBadHost(origin), 400, "The packaged Hub accepted a bad Host.");

    const page = await localFetch(origin, "/", { headers: { accept: "text/html" } });
    assert.equal(page.status, 200, "The packaged Hub did not serve its application shell.");
    assert.match(page.headers.get("content-type") ?? "", /^text\/html\b/u);
    assertLocalCsp(page);
    const html = await page.text();
    assert(html.includes('<div id="root"></div>') && Buffer.from(html).equals(assets.html),
      "The packaged Hub served different bytes from its installed HTML.");
    const references = [...html.matchAll(/\s(?:src|href)\s*=\s*(["'])(.*?)\1/giu)].map(([, , path]) => path);
    assert(references.some((file) => file.endsWith(".js")) && references.some((file) => file.endsWith(".css")),
      "The application shell omitted its built JS or CSS reference.");
    for (const file of references) {
      assert(assets.hashedFiles.has(file), `The application shell referenced an asset outside its packed manifest: ${file}`);
    }
    for (const [file, bytes] of assets.hashedFiles) {
      const response = await localFetch(origin, file);
      assert.equal(response.status, 200, `The packaged Hub did not serve ${file}.`);
      assert(Buffer.from(await response.arrayBuffer()).equals(bytes), `The packaged Hub changed the bytes of ${file}.`);
    }
    assert(child.exitCode === null && child.signalCode === null, "The foreground Hub exited before SIGTERM.");
  } finally {
    await stopPackagedHub(child);
  }
  assert.equal(readBound(home), undefined, "The foreground Hub left its hub.bound row behind.");
}

async function verifyBackgroundHub({ cli, project, home, version }) {
  const child = startPackagedHub(cli, project, home, ["--no-open"], { background: true });
  try {
    const link = await readBootstrapUrl(child);
    assertCleanExit(await waitForExit(child), "The background launcher");
    const hello = await verifyHello(link.origin, "background", version);
    const lease = readLease(home);
    assert(lease.owner && Number.isSafeInteger(lease.pid) && lease.pid > 0 && lease.pid !== child.pid,
      "The background Hub did not acquire a separate process lease.");
    assertBound(home, { port: Number(link.port), pid: lease.pid, version, homeId: hello.homeId, mode: "background" });
  } finally {
    try {
      await stopPackagedHub(child);
    } finally {
      try {
        await requestBackgroundExit(home);
      } catch (error) {
        retainWorkspace = true;
        throw error;
      }
    }
  }
}

function startPackagedHub(cli, project, home, args, { background = false } = {}) {
  const env = { ...smokeEnv, MEX_HOME: home };
  if (background) delete env.MEX_BACKGROUND;
  // Node's Windows ChildProcess.kill("SIGTERM") terminates immediately. Use
  // a private IPC channel to deliver SIGTERM to the same CLI handler there.
  const windows = process.platform === "win32";
  const signalBridge = "process.on('message', message => { if (message === 'SIGTERM') { process.emit('SIGTERM'); process.disconnect(); } }); process.channel?.unref();";
  const preload = windows ? ["--import", `data:text/javascript,${encodeURIComponent(signalBridge)}`] : [];
  return spawn(process.execPath, [...preload, cli, "hub", ...args], {
    cwd: project, env, windowsHide: true,
    stdio: windows ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  const closed = once(listener, "close");
  listener.close();
  await closed;
  return port;
}

function localFetch(origin, path, init) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, "The packed smoke attempted an outbound request.");
  return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) });
}

async function verifyHello(origin, mode, version) {
  const response = await localFetch(origin, "/api/v1/hello");
  assert.equal(response.status, 200, "The unauthenticated Hub handshake failed.");
  assertLocalCsp(response);
  const body = await response.json();
  assert.equal(body.app, "mex-hub");
  assert.equal(body.mode, mode);
  assert.equal(body.version, version);
  assert.match(body.homeId, /^[A-Za-z0-9_-]{22}$/u);
  return body;
}

function assertLocalCsp(response) {
  const csp = response.headers.get("content-security-policy");
  assert(csp, "The packaged Hub did not send a Content Security Policy.");
  const directives = new Map(csp.split(";").filter((part) => part.trim()).map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/u);
    assert(sources.every((source) => ["'self'", "'none'"].includes(source) || (name === "img-src" && source === "data:")),
      `The packaged Hub CSP permits a nonlocal source in ${name}.`);
    return [name, sources.join(" ")];
  }));
  assert.equal(directives.get("default-src"), "'self'");
  assert.equal(directives.get("frame-ancestors"), "'none'");
  assert.equal(directives.get("object-src"), "'none'");
}

async function requestWithBadHost(origin) {
  const status = await new Promise((resolveStatus, reject) => {
    const req = request(`${origin}/api/v1/hello`, {
      headers: { host: "outside.invalid" }, signal: AbortSignal.timeout(5_000),
    }, (res) => {
      res.resume();
      resolveStatus(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  return status;
}

function readRecord(home, use, { readOnly = true } = {}) {
  const path = join(home, ".mex", "record.db");
  assert(
    lstatSync(path).isFile() && realpathSync(path) === join(realpathSync(home), ".mex", "record.db"),
    "The smoke record.db must be a regular file inside its temporary home.",
  );
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    return use(db);
  } finally {
    db.close();
  }
}

function readLease(home) {
  return readRecord(home, (db) => db.prepare("SELECT owner, pid, request, spawned_at FROM background WHERE id=1").get());
}

function readBound(home) {
  return readRecord(home, (db) => db.prepare("SELECT value FROM settings WHERE scope='hub' AND key='bound'").get()?.value);
}

function assertBound(home, expected) {
  const value = readBound(home);
  assert(value, "The packaged Hub did not publish hub.bound.");
  const { at, ...bound } = JSON.parse(value);
  assert(Number.isFinite(Date.parse(at)), "The packaged Hub published an invalid bound timestamp.");
  assert.deepEqual(bound, expected);
}

async function requestBackgroundExit(home) {
  if (!existsSync(join(home, ".mex", "record.db"))) return;
  const deadline = Date.now() + 15_000;
  let requested = false;
  do {
    const lease = readLease(home);
    if (lease.owner === null && lease.pid === null && lease.request === null
      && (requested || (lease.spawned_at === null && readBound(home) === undefined))) {
      assert.equal(readBound(home), undefined, "The background Hub left its hub.bound row behind.");
      return;
    }
    if (lease.owner !== null && !requested) {
      readRecord(home, (db) => db.prepare("UPDATE background SET request='exit' WHERE id=1").run(), { readOnly: false });
      requested = true;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("The packaged background Hub did not clear its lease after the exit request.");
}

function readBootstrapUrl(child) {
  return new Promise((resolveLink, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for packaged Hub startup.\n${stderr}`)), 30_000);
    const append = (output, chunk) => (output + chunk.toString("utf8")).slice(-16_384);
    const onStdout = (chunk) => {
      stdout = append(stdout, chunk);
      const match = stdout.match(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+(?=\r?\n)/mu);
      if (match) finish(new URL(match[0]));
    };
    const onStderr = (chunk) => { stderr = append(stderr, chunk); };
    const onClose = (code, signal) => finish(new Error(`The packaged Hub exited before sign-in (${code ?? signal}).\n${stderr}`));

    function finish(result) {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("close", onClose);
      child.off("error", finish);
      child.stdout.resume();
      child.stderr.resume();
      if (result instanceof Error) reject(result);
      else resolveLink(result);
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("close", onClose);
    child.once("error", finish);
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode];
  return once(child, "exit", { signal: AbortSignal.timeout(8_000) });
}

async function stopPackagedHub(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.send("SIGTERM");
    else child.kill("SIGTERM");
    assertCleanExit(await waitForExit(child), "The packaged Hub");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function assertCleanExit([code, signal], label) {
  assert.equal(code, 0, `${label} did not exit cleanly (signal ${signal ?? "none"}).`);
  assert.equal(signal, null, `${label} stopped before cleanup.`);
}
