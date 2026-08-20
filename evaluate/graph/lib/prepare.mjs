import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandBundleIdentity, fileHash, objectHash, repositoryIdentity } from "../../core/hash.mjs";
import { graphSuiteHash } from "../../schemas/graph-suite.mjs";
import { GraphDbGuard } from "../../core/artifacts.mjs";
import { assertProcessSucceeded, runProcessSync } from "../../core/process.mjs";
import { validateSubjectFixture } from "./fixture.mjs";
import { inspectGraphDatabase } from "./integrity.mjs";
import { inspectGoldCoverage } from "./coverage.mjs";

function parseBuildSummary(stdout, systemId) {
  try {
    const summary = JSON.parse(String(stdout));
    for (const field of ["filesIndexed", "nodesCreated", "edgesCreated", "durationMs"]) {
      if (!Number.isFinite(Number(summary?.[field]))) throw new Error(`missing ${field}`);
    }
    return summary;
  } catch (error) {
    throw new Error(`system ${systemId} emitted invalid graph build JSON: ${error.message}`);
  }
}

function environmentManifest() {
  const allowed = ["CI", "NODE_ENV", "MEX_GRAPH_MAX_NODES", "MEX_GRAPH_MAX_OUTPUT_TOKENS", "MEX_GRAPH_MAX_SOURCE_LINES"];
  return Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

function ensureNewOutput(outputDir) {
  const existing = existsSync(outputDir) ? readdirSync(outputDir).filter((name) => name !== "artifacts") : [];
  if (existing.length > 0) {
    throw new Error(`output directory is not empty: ${outputDir}; choose a new immutable run directory or use --resume`);
  }
  mkdirSync(outputDir, { recursive: true });
}

export function prepareGraphEvaluation({ suite, subjectRoot, harnessRoot, outputDir, systemCommands, artifactMetadata = {}, invocation = {} }) {
  ensureNewOutput(outputDir);
  const fixture = validateSubjectFixture(suite, subjectRoot);
  const currentHarness = repositoryIdentity(harnessRoot);
  const suiteSha256 = graphSuiteHash(suite);
  const indexDir = join(outputDir, "indices");
  const rawDir = join(outputDir, "raw", "builds");
  const scratch = join(outputDir, ".prepare-scratch");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const guard = new GraphDbGuard(subjectRoot, scratch);
  const systems = {};
  try {
    for (const [systemId, command] of Object.entries(systemCommands)) {
      const rebuilds = [];
      const count = suite.determinismRebuilds ?? 1;
      for (let rebuild = 0; rebuild < count; rebuild++) {
        guard.clear();
        const [executable, ...prefix] = command;
        const result = runProcessSync(executable, [...prefix, "graph", "--json"], {
          cwd: subjectRoot,
          maxOutputBytes: 256 * 1024 * 1024,
        });
        writeFileSync(join(rawDir, `${systemId}-${rebuild + 1}.stdout.json`), String(result.stdout));
        writeFileSync(join(rawDir, `${systemId}-${rebuild + 1}.stderr.txt`), String(result.stderr));
        assertProcessSucceeded(result, `graph build for ${systemId} (rebuild ${rebuild + 1})`);
        const buildSummary = parseBuildSummary(result.stdout, systemId);
        const graphPath = join(subjectRoot, ".mex", "graph.db");
        if (!existsSync(graphPath)) throw new Error(`system ${systemId} did not create ${graphPath}`);
        const integrity = inspectGraphDatabase(graphPath, buildSummary);
        rebuilds.push({ buildSummary, integrity, process: { elapsedMs: result.elapsedMs, code: result.code } });
      }
      const graphPath = join(subjectRoot, ".mex", "graph.db");
      const snapshot = join(indexDir, `${systemId}.graph.db`);
      copyFileSync(graphPath, snapshot);
      const normalizedHashes = rebuilds.map((entry) => entry.integrity.normalizedGraphSha256);
      systems[systemId] = {
        command,
        cli: commandBundleIdentity(command),
        artifact: artifactMetadata[systemId] ?? null,
        index: { path: snapshot, sha256: fileHash(snapshot), normalizedSha256: normalizedHashes.at(-1) },
        rebuilds,
        deterministic: new Set(normalizedHashes).size === 1,
        goldCoverage: inspectGoldCoverage(snapshot, fixture.tasks.map((task) => ({
          ...suite.tasks.find((entry) => entry.id === task.taskId),
          gold: task.gold,
          acceptableAlternates: task.acceptableAlternates,
          mustNotReturn: task.mustNotReturn,
        }))),
      };
    }
  } finally {
    guard.restore();
    rmSync(scratch, { recursive: true, force: true });
  }
  const identity = {
    schemaVersion: 3,
    suiteId: suite.id,
    suiteSha256,
    subject: fixture.subject,
    harness: currentHarness,
    systems: Object.fromEntries(Object.entries(systems).map(([id, system]) => [id, {
      command: system.command,
      bundleSha256: system.cli.bundleSha256,
      indexSha256: system.index.sha256,
      normalizedIndexSha256: system.index.normalizedSha256,
    }])),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    environment: environmentManifest(),
    invocation,
  };
  const manifest = {
    ...identity,
    runIdentity: objectHash(identity),
    preparedAt: new Date().toISOString(),
    goldEvidence: fixture.tasks,
    graphCoverage: Object.fromEntries(Object.entries(systems).map(([id, system]) => [id, system.goldCoverage])),
    systems,
  };
  writeFileSync(join(outputDir, "prepare.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function loadPreparedGraphEvaluation(outputDir) {
  const path = join(outputDir, "prepare.json");
  if (!existsSync(path)) throw new Error(`missing prepared evaluation: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}
