#!/usr/bin/env node

import { currentGraphPath } from "../dist/graph-storage.js";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  availableParallelism,
  cpus,
  endianness,
  platform,
  release,
  tmpdir,
  totalmem,
  type,
  version as osVersion,
} from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const DEFAULT_SIZES = Object.freeze([100, 400]);
const DEFAULT_RUNS = 7;
const DEFAULT_WARMUPS = 2;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const FIXED_GIT_DATE = "2026-01-01T00:00:00Z";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI_PATH = resolve(SCRIPT_DIR, "..", "dist", "cli.js");

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exit(0);
}

assertBuiltCli(options.cliPath);

const temporaryRoot = mkdtempSync(join(tmpdir(), "mex-graph-status-benchmark-"));
const emptyGitConfig = join(temporaryRoot, "empty-gitconfig");
const mexHome = join(temporaryRoot, "mex-home");
writeFileSync(emptyGitConfig, "", "utf8");
mkdirSync(mexHome);

const childEnvironment = {
  ...process.env,
  DO_NOT_TRACK: "1",
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  LANG: "C",
  LC_ALL: "C",
  MEX_HOME: mexHome,
  MEX_TELEMETRY: "0",
  NO_COLOR: "1",
};
delete childEnvironment.NODE_OPTIONS;
delete childEnvironment.NODE_PATH;
for (const key of [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
]) {
  delete childEnvironment[key];
}
for (const key of Object.keys(childEnvironment)) {
  if (/^GIT_CONFIG_(KEY|VALUE)_[0-9]+$/u.test(key)) delete childEnvironment[key];
}

try {
  const results = [];
  for (const fileCount of options.sizes) {
    const fixture = createFixture(temporaryRoot, fileCount, childEnvironment);
    const rebuild = runMexJson(
      options.cliPath,
      ["graph", "rebuild", "--root", fixture.root, "--json"],
      fixture.root,
      childEnvironment,
      options.timeoutMs,
      `graph rebuild (${fileCount} files)`,
    );
    assertSuccessfulRebuild(rebuild, fileCount);

    for (let warmup = 0; warmup < options.warmups; warmup += 1) {
      const status = runStatus(
        options.cliPath,
        fixture.root,
        childEnvironment,
        options.timeoutMs,
      );
      assertFreshStatus(status, fileCount, `warm-up ${warmup + 1}`);
    }

    const samplesMs = [];
    for (let run = 0; run < options.runs; run += 1) {
      const startedAt = performance.now();
      const status = runStatus(
        options.cliPath,
        fixture.root,
        childEnvironment,
        options.timeoutMs,
      );
      const elapsedMs = performance.now() - startedAt;
      assertFreshStatus(status, fileCount, `measured run ${run + 1}`);
      samplesMs.push(elapsedMs);
    }

    const databasePath = currentGraphPath(fixture.root, { home: join(mexHome, ".mex") });
    const databaseBytes = statSync(databasePath).size;
    results.push({
      files: fileCount,
      sourceBytes: fixture.sourceBytes,
      databaseBytes,
      sqliteFilesBytes: sqliteFilesSize(databasePath),
      rebuild: {
        durationMs: numberField(rebuild, "durationMs"),
        nodesCreated: numberField(rebuild, "nodesCreated"),
        edgesCreated: numberField(rebuild, "edgesCreated"),
      },
      statusMs: summarizeTimings(samplesMs),
    });
  }

  const cpuList = cpus();
  const report = {
    benchmark: "mex graph status --json",
    note: "Characterization only: elapsed times are reported without a pass/fail budget.",
    environment: {
      node: process.version,
      v8: process.versions.v8,
      sqlite: {
        backend: "node:sqlite",
        version: process.versions.sqlite ?? null,
      },
      libuv: process.versions.uv,
      os: {
        type: type(),
        platform: platform(),
        release: release(),
        version: osVersion(),
        architecture: process.arch,
        endianness: endianness(),
      },
      cpu: {
        model: cpuList[0]?.model ?? "unknown",
        logicalCount: cpuList.length,
        availableParallelism: availableParallelism(),
      },
      totalMemoryBytes: totalmem(),
    },
    configuration: {
      cliPath: options.cliPath,
      fixture: "deterministic committed TypeScript repository",
      sizes: options.sizes,
      warmups: options.warmups,
      measuredRuns: options.runs,
      commandTimeoutMs: options.timeoutMs,
      maximumCapturedOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    },
    results,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Graph status benchmark failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function parseArguments(argv) {
  const parsed = {
    cliPath: DEFAULT_CLI_PATH,
    help: false,
    runs: DEFAULT_RUNS,
    sizes: [...DEFAULT_SIZES],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    warmups: DEFAULT_WARMUPS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }

    const [name, inlineValue] = splitOption(argument);
    if (!["--cli", "--runs", "--sizes", "--timeout-ms", "--warmups"].includes(name)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }

    if (name === "--cli") parsed.cliPath = resolve(value);
    if (name === "--runs") parsed.runs = boundedInteger(value, name, 1, 100);
    if (name === "--warmups") parsed.warmups = boundedInteger(value, name, 0, 20);
    if (name === "--timeout-ms") parsed.timeoutMs = boundedInteger(value, name, 1_000, 600_000);
    if (name === "--sizes") parsed.sizes = parseSizes(value);
  }

  return parsed;
}

function splitOption(argument) {
  const separator = argument.indexOf("=");
  return separator === -1
    ? [argument, undefined]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}

function boundedInteger(raw, name, minimum, maximum) {
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function parseSizes(raw) {
  const entries = raw.split(",");
  if (entries.length === 0 || entries.length > 8 || entries.some((entry) => entry.length === 0)) {
    throw new Error("--sizes must contain between one and eight comma-separated file counts.");
  }
  const sizes = entries.map((entry) => boundedInteger(entry, "--sizes", 1, 10_000));
  if (new Set(sizes).size !== sizes.length) {
    throw new Error("--sizes must not contain duplicate file counts.");
  }
  return sizes;
}

function printUsage() {
  process.stdout.write(
    "Usage: node scripts/benchmark-graph-status.mjs [options]\n\n"
      + "Characterize fresh `mex graph status --json` latency against deterministic Git fixtures.\n\n"
      + "Options:\n"
      + `  --sizes <counts>     Comma-separated source-file counts (default: ${DEFAULT_SIZES.join(",")})\n`
      + `  --warmups <n>        Warm-up status processes per fixture (default: ${DEFAULT_WARMUPS})\n`
      + `  --runs <n>           Measured status processes per fixture (default: ${DEFAULT_RUNS})\n`
      + `  --timeout-ms <n>     Per-process timeout (default: ${DEFAULT_TIMEOUT_MS})\n`
      + `  --cli <path>         Built CLI entry point (default: ${DEFAULT_CLI_PATH})\n`
      + "  -h, --help           Show this help\n",
  );
}

function assertBuiltCli(cliPath) {
  if (!existsSync(cliPath)) {
    throw new Error(`Built CLI not found at ${cliPath}. Run \`npm run build\` first.`);
  }
  const stats = statSync(cliPath);
  if (!stats.isFile()) throw new Error(`Built CLI path is not a regular file: ${cliPath}`);
}

function createFixture(parentRoot, fileCount, environment) {
  const fixtureRoot = join(parentRoot, `files-${String(fileCount).padStart(5, "0")}`);
  const sourceRoot = join(fixtureRoot, "src");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(
    join(fixtureRoot, ".gitignore"),
    ".mex/graph.db*\n.mex/recovery/graph/\n",
    "utf8",
  );
  writeFileSync(
    join(fixtureRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      include: ["src/**/*.ts"],
    }, null, 2)}\n`,
    "utf8",
  );

  const width = Math.max(4, String(fileCount - 1).length);
  let sourceBytes = 0;
  for (let index = 0; index < fileCount; index += 1) {
    const suffix = String(index).padStart(width, "0");
    const previousSuffix = String(Math.max(0, index - 1)).padStart(width, "0");
    const source = typescriptModule(index, suffix, previousSuffix);
    writeFileSync(join(sourceRoot, `module-${suffix}.ts`), source, "utf8");
    sourceBytes += Buffer.byteLength(source, "utf8");
  }

  runGit(fixtureRoot, ["init", "--quiet", "--initial-branch=benchmark"], environment);
  runGit(fixtureRoot, ["config", "user.name", "MEX Benchmark"], environment);
  runGit(fixtureRoot, ["config", "user.email", "benchmark@example.invalid"], environment);
  runGit(fixtureRoot, ["add", "--", ".gitignore", "tsconfig.json", "src"], environment);
  runGit(
    fixtureRoot,
    ["commit", "--quiet", "--no-gpg-sign", "--message", "benchmark fixture"],
    {
      ...environment,
      GIT_AUTHOR_DATE: FIXED_GIT_DATE,
      GIT_COMMITTER_DATE: FIXED_GIT_DATE,
    },
  );

  return { root: fixtureRoot, sourceBytes };
}

function typescriptModule(index, suffix, previousSuffix) {
  const dependency = index === 0
    ? ""
    : `import { service${previousSuffix} } from \"./module-${previousSuffix}.js\";\n\n`;
  const upstream = index === 0 ? "input + 17" : `service${previousSuffix}(input)`;
  return `${dependency}`
    + `export interface Payload${suffix} {\n`
    + "  readonly id: number;\n"
    + "  readonly label: string;\n"
    + "  readonly values: readonly number[];\n"
    + "}\n\n"
    + `export function normalize${suffix}(input: number): Payload${suffix} {\n`
    + `  const upstream = ${upstream};\n`
    + "  return {\n"
    + `    id: ${index},\n`
    + `    label: \"module-${suffix}\",\n`
    + "    values: [upstream, upstream + 1, upstream + 2],\n"
    + "  };\n"
    + "}\n\n"
    + `export class Worker${suffix} {\n`
    + `  constructor(private readonly offset = ${index + 3}) {}\n\n`
    + `  execute(payload: Payload${suffix}): number {\n`
    + "    return payload.values.reduce((total, value) => total + value, this.offset);\n"
    + "  }\n"
    + "}\n\n"
    + `export function service${suffix}(input: number): number {\n`
    + `  const payload = normalize${suffix}(input);\n`
    + `  return new Worker${suffix}().execute(payload);\n`
    + "}\n\n"
    + `export const descriptor${suffix} = Object.freeze({\n`
    + `  key: \"service-${suffix}\",\n`
    + `  run: service${suffix},\n`
    + "});\n";
}

function runGit(cwd, args, environment) {
  runProcess("git", args, {
    cwd,
    environment,
    label: `git ${args[0]}`,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    timeoutMs: 30_000,
  });
}

function runStatus(cliPath, root, environment, timeoutMs) {
  return runMexJson(
    cliPath,
    ["graph", "status", "--root", root, "--json"],
    root,
    environment,
    timeoutMs,
    "graph status",
  );
}

function runMexJson(cliPath, args, cwd, environment, timeoutMs, label) {
  const stdout = runProcess(process.execPath, [cliPath, ...args], {
    cwd,
    environment,
    label,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    timeoutMs,
  });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} did not emit valid JSON (${reason}); stdout: ${boundedText(stdout)}`);
  }
}

function runProcess(command, args, { cwd, environment, label, maxOutputBytes, timeoutMs }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    killSignal: "SIGKILL",
    maxBuffer: maxOutputBytes,
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    const code = typeof result.error === "object" && result.error !== null && "code" in result.error
      ? ` (${String(result.error.code)})`
      : "";
    throw new Error(`${label} could not complete${code}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited with status ${String(result.status)}${result.signal ? ` (${result.signal})` : ""}; `
        + `stderr: ${boundedText(result.stderr)}; stdout: ${boundedText(result.stdout)}`,
    );
  }
  return result.stdout;
}

function assertSuccessfulRebuild(result, expectedFiles) {
  assertRecord(result, "graph rebuild result");
  if (result.state !== "succeeded") {
    throw new Error(`graph rebuild did not succeed: state=${String(result.state)}`);
  }
  if (result.filesIndexed !== expectedFiles) {
    throw new Error(
      `graph rebuild indexed ${String(result.filesIndexed)} files; expected ${expectedFiles}.`,
    );
  }
  assertFreshStatus(result.status, expectedFiles, "rebuild result");
}

function assertFreshStatus(status, expectedFiles, phase) {
  assertRecord(status, `${phase} graph status`);
  if (status.status !== "fresh") {
    throw new Error(`${phase} graph status was ${String(status.status)}, not fresh.`);
  }
  if (typeof status.observedAt !== "string" || !Number.isFinite(Date.parse(status.observedAt))) {
    throw new Error(`${phase} graph status has an invalid observedAt timestamp.`);
  }
  assertRecord(status.currentRepo, `${phase} currentRepo`);
  if (status.currentRepo.branch !== "benchmark"
    || typeof status.currentRepo.head !== "string"
    || !/^[a-f0-9]{40}$/u.test(status.currentRepo.head)
    || status.currentRepo.dirty !== false) {
    throw new Error(`${phase} graph status has invalid or dirty repository provenance.`);
  }
  if (!Number.isInteger(status.schemaVersion) || status.schemaVersion <= 0) {
    throw new Error(`${phase} graph status has an invalid schema version.`);
  }
  assertRecord(status.parseHealth, `${phase} parseHealth`);
  for (const field of ["total", "ok", "partial", "failed"]) numberField(status.parseHealth, field);
  if (status.parseHealth.total !== expectedFiles
    || status.parseHealth.ok + status.parseHealth.partial + status.parseHealth.failed !== expectedFiles) {
    throw new Error(`${phase} graph status has inconsistent parse-health totals.`);
  }
  assertRecord(status.changes, `${phase} changes`);
  if (status.changes.total !== 0
    || !Array.isArray(status.changes.added)
    || !Array.isArray(status.changes.modified)
    || !Array.isArray(status.changes.deleted)
    || status.changes.added.length !== 0
    || status.changes.modified.length !== 0
    || status.changes.deleted.length !== 0) {
    throw new Error(`${phase} graph status reports source changes for a fresh fixture.`);
  }
  if (!Array.isArray(status.diagnostics)) {
    throw new Error(`${phase} graph status diagnostics must be an array.`);
  }
}

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function numberField(record, field) {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number.`);
  }
  return value;
}

function sqliteFilesSize(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter((path) => existsSync(path))
    .reduce((total, path) => total + statSync(path).size, 0);
}

function summarizeTimings(samples) {
  if (samples.length === 0) throw new Error("At least one measured status run is required.");
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.map(roundMilliseconds),
    min: roundMilliseconds(sorted[0]),
    median: roundMilliseconds(median(sorted)),
    p95: roundMilliseconds(nearestRank(sorted, 0.95)),
    max: roundMilliseconds(sorted.at(-1)),
  };
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function nearestRank(sorted, percentile) {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}

function roundMilliseconds(value) {
  return Math.round(value * 1_000) / 1_000;
}

function boundedText(value) {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "");
  if (normalized.length <= 1_000) return JSON.stringify(normalized);
  return JSON.stringify(`${normalized.slice(0, 1_000)}…`);
}
