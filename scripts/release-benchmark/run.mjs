#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureBuiltAssets } from "./assets.mjs";
import { measureWorkbenchHeap } from "./browser.mjs";
import { createBenchmarkEnvironment } from "./environment.mjs";
import {
  copyReleaseFixture,
  createReleaseFixture,
  prepareReleaseFixtureTools,
  RELEASE_FIXTURE_PROFILES,
  snapshotReleaseReadState,
  sqliteFamilySize,
  toggleSourceRefreshMarker,
  toggleWikiRefreshMarker,
} from "./fixtures.mjs";
import {
  authenticateHub,
  hubJson,
  measureCommonReads,
  measureIdleProcess,
  measureMaintenance,
  startHub,
} from "./hub.mjs";
import { candidateRuntimeBudgets, evaluateRuntimeBudgets } from "./runtime-budgets.mjs";
import { round, summarize } from "./statistics.mjs";
import { PROCESS_MEASUREMENT } from "./process-tree.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "../..");
const budgetsPath = join(scriptRoot, "budgets.json");
const cliPath = join(repositoryRoot, "dist", "cli.js");
const hubOutputRoot = join(repositoryRoot, "dist", "hub");
const DEFAULT_REPORT_PATH = join(repositoryRoot, "test-results", "release-benchmark", "report.json");
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write([
    "Usage: node scripts/release-benchmark/run.mjs [--output <path>] [--assets-only]",
    "",
    "Runtime budgets are enforced only when MEX_ENFORCE_RELEASE_BUDGETS=1.",
    "Deterministic built-asset budgets are enforced on every invocation.",
    "",
  ].join("\n"));
  process.exit(0);
}

const budgets = loadBudgets();
const enforceRuntime = process.env.MEX_ENFORCE_RELEASE_BUDGETS === "1";
if (options.assetsOnly && enforceRuntime) {
  throw new Error("Runtime budget enforcement cannot be combined with --assets-only.");
}
if (enforceRuntime) assertPinnedEnvironment(budgets.environment);
assertBuildOutputs();

const assetMeasurement = measureBuiltAssets(hubOutputRoot, budgets.assets);
const startedAt = new Date().toISOString();
const workRoot = mkdtempSync(join(tmpdir(), "mex-release-benchmark-"));
const reportPath = resolve(options.output ?? DEFAULT_REPORT_PATH);
const report = {
  schemaVersion: 1,
  benchmark: "mex-release-performance",
  generatedAt: startedAt,
  environment: environmentRecord(budgets.environment, enforceRuntime),
  configuration: {
    fixtureProfiles: RELEASE_FIXTURE_PROFILES,
    processMeasurement: PROCESS_MEASUREMENT,
    maintenanceObservation: "job-event-stream",
    samples: budgets.samples,
    runtimeBudgetsEnforced: enforceRuntime,
    assetBudgetsEnforced: true,
    provisionalBudgets: budgets.provisional === true,
  },
  assets: assetMeasurement,
  profiles: {},
  budgetEvaluation: {
    assetViolations: assetMeasurement.violations,
    runtimeViolations: [],
    passed: false,
  },
  budgetCandidates: { assets: assetMeasurement.budgetCandidates, runtime: {} },
};

let activeServer;
let fixtureTools;
try {
  if (!options.assetsOnly) {
    const benchmarkEnvironment = createBenchmarkEnvironment(workRoot);
    fixtureTools = prepareReleaseFixtureTools({ cliPath, environment: benchmarkEnvironment });
    for (const profileName of Object.keys(RELEASE_FIXTURE_PROFILES)) {
      process.stderr.write(`Benchmarking ${profileName} release fixture...\n`);
      const baseFixture = createReleaseFixture({
        destination: join(workRoot, `${profileName}-base`),
        profileName,
        cliPath,
        environment: benchmarkEnvironment,
        fixtureTools,
      });

      const coldReadyMs = [];
      for (let sample = 0; sample < budgets.samples.timing; sample += 1) {
        const sampleRoot = copyReleaseFixture(
          baseFixture.root,
          join(workRoot, `${profileName}-cold-${sample}`),
        );
        activeServer = await startHub({ projectRoot: sampleRoot, cliPath, environment: benchmarkEnvironment });
        coldReadyMs.push(activeServer.readyMs);
        await activeServer.close();
        activeServer = undefined;
      }

      const idleRssBytes = [];
      const idleCpuMs = [];
      for (let sample = 0; sample < budgets.samples.idleMemory; sample += 1) {
        const sampleRoot = copyReleaseFixture(
          baseFixture.root,
          join(workRoot, `${profileName}-idle-${sample}`),
        );
        activeServer = await startHub({ projectRoot: sampleRoot, cliPath, environment: benchmarkEnvironment });
        const auth = await authenticateHub(activeServer);
        await hubJson(activeServer, "/api/v1/capabilities", auth);
        await hubJson(activeServer, "/api/v1/home", auth);
        const idle = await measureIdleProcess(activeServer);
        idleRssBytes.push(idle.rssBytes);
        idleCpuMs.push(idle.cpuMs);
        await activeServer.close();
        activeServer = undefined;
      }

      const workingRoot = copyReleaseFixture(
        baseFixture.root,
        join(workRoot, `${profileName}-working`),
      );
      activeServer = await startHub({ projectRoot: workingRoot, cliPath, environment: benchmarkEnvironment });
      const auth = await authenticateHub(activeServer);
      const beforeOrdinaryReads = snapshotReleaseReadState(workingRoot, benchmarkEnvironment);
      const commonReads = await measureCommonReads(
        activeServer,
        auth,
        budgets.samples.timing,
        {
          relayDraftId: baseFixture.firstRelayDraftId,
          relayDraftSummary: baseFixture.relayDraftSummary,
          relayId: baseFixture.firstRelayId,
          relaySummary: baseFixture.relaySummary,
        },
      );
      const apiLatency = commonReads.timings;
      const browser = await measureWorkbenchHeap({
        server: activeServer,
        auth,
        samples: budgets.samples.idleMemory,
        knowledgeEntityId: baseFixture.firstWikiEntityId,
        codeSymbolId: commonReads.codeSymbolId,
        relayDraftId: baseFixture.firstRelayDraftId,
        relayDraftSummary: baseFixture.relayDraftSummary,
        relayId: baseFixture.firstRelayId,
        relaySummary: baseFixture.relaySummary,
      });
      const afterOrdinaryReads = snapshotReleaseReadState(workingRoot, benchmarkEnvironment);
      if (JSON.stringify(afterOrdinaryReads) !== JSON.stringify(beforeOrdinaryReads)) {
        throw new Error(`${profileName} ordinary Hub/Relay reads mutated protected repository state.`);
      }
      const maintenance = await measureMaintenance({
        server: activeServer,
        auth,
        timingSamples: budgets.samples.timing,
        memorySamples: budgets.samples.idleMemory,
        beforeGraphRefresh: () => toggleSourceRefreshMarker(workingRoot),
        beforeWikiRefresh: () => toggleWikiRefreshMarker(workingRoot, baseFixture.mutableWikiPath),
      });
      const graphDatabaseBytes = sqliteFamilySize(join(workingRoot, ".mex", "graph.db"));
      const wikiDatabaseBytes = sqliteFamilySize(join(workingRoot, ".mex", "wiki.db"));
      await activeServer.close();
      activeServer = undefined;

      report.profiles[profileName] = summarizeProfile({
        profileName,
        fixture: baseFixture,
        coldReadyMs,
        idleRssBytes,
        idleCpuMs,
        apiLatency,
        maintenance,
        browser,
        graphDatabaseBytes,
        wikiDatabaseBytes,
        timingSamples: budgets.samples.timing,
        memorySamples: budgets.samples.idleMemory,
      });
    }
    report.budgetEvaluation.runtimeViolations = evaluateRuntimeBudgets(report.profiles, budgets.runtime);
    report.budgetCandidates.runtime = candidateRuntimeBudgets(report.profiles);
  }
  report.budgetEvaluation.passed = assetMeasurement.violations.length === 0
    && (!enforceRuntime || report.budgetEvaluation.runtimeViolations.length === 0);
  writeBoundedReport(reportPath, report);
} finally {
  if (activeServer) await activeServer.close().catch(() => undefined);
  fixtureTools?.cleanup();
  rmSync(workRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.budgetEvaluation.passed) process.exitCode = 1;

function summarizeProfile(input) {
  const maintenance = Object.fromEntries(Object.entries(input.maintenance).map(([kind, samples]) => [kind, {
    elapsedMs: summarize(samples.elapsedMs, input.timingSamples),
    peakRssBytes: summarize(samples.peakRssBytes, input.memorySamples),
    cpuMs: summarize(samples.cpuMs, input.timingSamples),
  }]));
  const browserHeap = input.browser === null ? null : {
    routes: Object.fromEntries(Object.entries(input.browser.measurements).map(([route, values]) => [
      route,
      summarize(values, input.memorySamples),
    ])),
    outboundRequestCount: input.browser.outboundRequestCount,
    observedLoopbackRequests: input.browser.observedLoopbackRequests,
  };
  const database = {
    graph: databaseMeasurement(input.graphDatabaseBytes, input.fixture.input.graphBytes),
    wiki: databaseMeasurement(input.wikiDatabaseBytes, input.fixture.input.wikiBytes),
  };
  return {
    fixture: {
      profile: input.profileName,
      ...input.fixture.profile,
      input: input.fixture.input,
    },
    coldHubReadyMs: summarize(input.coldReadyMs, input.timingSamples),
    idle: {
      rssBytes: summarize(input.idleRssBytes, input.memorySamples),
      cpuMs: summarize(input.idleCpuMs, input.memorySamples),
      cpuPercent: summarize(
        input.idleCpuMs.map((value) => value / 20),
        input.memorySamples,
      ),
      windowMs: 2_000,
    },
    apiLatencyMs: Object.fromEntries(Object.entries(input.apiLatency).map(([name, values]) => [
      name,
      summarize(values, input.timingSamples),
    ])),
    maintenance,
    browserHeap,
    database,
  };
}

function databaseMeasurement(databaseBytes, inputBytes) {
  if (databaseBytes <= 0 || inputBytes <= 0) throw new Error("Database ratio inputs must be positive.");
  return { databaseBytes, inputBytes, ratio: round(databaseBytes / inputBytes, 6) };
}

function loadBudgets() {
  const parsed = JSON.parse(readFileSync(budgetsPath, "utf8"));
  if (parsed?.schemaVersion !== 1 || parsed.samples?.timing !== 10 || parsed.samples?.idleMemory !== 5) {
    throw new Error("Release budgets must use schema version 1 with ten timing and five idle/memory samples.");
  }
  return parsed;
}

function assertBuildOutputs() {
  if (!existsSync(cliPath)) throw new Error(`Built CLI is missing: ${cliPath}`);
  if (!existsSync(join(hubOutputRoot, ".vite", "manifest.json"))) {
    throw new Error(`Built Hub manifest is missing below ${hubOutputRoot}.`);
  }
}

function assertPinnedEnvironment(expected) {
  const actual = environmentRecord(expected, true);
  const mismatches = [];
  if (actual.platform !== expected.platform) mismatches.push(`platform ${actual.platform}`);
  if (actual.architecture !== expected.architecture) mismatches.push(`architecture ${actual.architecture}`);
  if (actual.node !== expected.node) mismatches.push(`Node ${actual.node}`);
  if (actual.os !== expected.os) mismatches.push(`OS ${actual.os}`);
  if (mismatches.length > 0) {
    throw new Error(`Runtime release budgets require ${expected.os}/${expected.architecture}/${expected.node}; received ${mismatches.join(", ")}.`);
  }
}

function environmentRecord(expected, pinned) {
  return {
    os: detectOperatingSystem(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    pinnedBudgetEnvironment: pinned
      && process.platform === expected.platform
      && process.arch === expected.architecture
      && process.version === expected.node
      && detectOperatingSystem() === expected.os,
  };
}

function detectOperatingSystem() {
  if (process.platform === "linux" && existsSync("/etc/os-release")) {
    const fields = Object.fromEntries(readFileSync("/etc/os-release", "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/gu, "")];
      }));
    if (fields.ID === "ubuntu" && fields.VERSION_ID) return `ubuntu-${fields.VERSION_ID}`;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
    return result.status === 0 ? `macos-${result.stdout.trim()}` : "macos-unknown";
  }
  return `${process.platform}-unknown`;
}

function writeBoundedReport(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) {
    throw new Error(`Release benchmark report exceeded ${MAX_REPORT_BYTES} bytes.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialized, "utf8");
}

function parseArguments(args) {
  const parsed = { assetsOnly: false, help: false, output: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--assets-only") parsed.assetsOnly = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--output") {
      const output = args[index + 1];
      if (!output || output.startsWith("-")) throw new Error("--output requires a path.");
      parsed.output = output;
      index += 1;
    } else throw new Error(`Unknown release benchmark option: ${argument}`);
  }
  return parsed;
}
