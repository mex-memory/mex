// Compare the graph a repository gets from the in-process TypeScript 5.9
// compiler with the one it gets from TypeScript 7.1's API, edge by edge, and
// time both. Run with: npx vite-node scripts/graph-compiler-parity.ts -- <repo> [--server tsrs|tsgo] [--json out.json]
// With --servers, compares tsrs with tsgo instead (the release check).
//
// Each extractor runs in its own child process so its time and peak memory
// are measured alone.

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTypeScriptExtraction, type CompilerExtractionResult } from "../src/graph/extraction/compiler.js";
import { ApiProjectCompiler, loadTsrsServer, tsgoServer } from "../src/graph/extraction/compiler-api.js";
import { compareCompilerExtractions, parityHolds } from "../src/graph/extraction/compiler-parity.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const mode = args[0];

if (mode === "--servers") {
  // Release check: tsrs must give exactly tsgo's graph on every repository given.
  // Run with: npx vite-node scripts/graph-compiler-parity.ts -- --servers <repo>...
  const { compareServersOnRepository } = await import("../src/graph/extraction/compiler-policy.js");
  let failed = 0;
  for (const repo of args.slice(1)) {
    const comparison = await compareServersOnRepository(resolve(repo));
    const report = comparison.report;
    console.log(JSON.stringify({
      repo, tsrs: comparison.tsrs, tsgo: comparison.tsgo, agrees: comparison.agrees, reason: comparison.reason,
      timings: comparison.timings,
      nodes: report?.nodes.matched, edges: report?.edges.matched,
      onlyTsgo: report?.edges.onlyLeft.slice(0, 20), onlyTsrs: report?.edges.onlyRight.slice(0, 20),
    }, null, 2));
    if (!comparison.agrees) failed++;
  }
  process.exit(failed === 0 ? 0 : 1);
}

if (mode === "--extract") {
  // Child: extract with one compiler and write the result as JSON.
  const [, compiler, repo, out] = args;
  const started = performance.now();
  const server = compiler === "tsgo" ? tsgoServer() : compiler === "tsrs" ? await loadTsrsServer() : undefined;
  const api = server ? new ApiProjectCompiler(server) : undefined;
  let serverPeakBytes = 0;
  let samplingMs = 0;
  if (api) {
    // The compiler server is a child process; sample its peak working set
    // before it exits, and leave the sampling out of the measured time.
    const close = api.close.bind(api);
    api.close = () => {
      const sampled = performance.now();
      serverPeakBytes = Math.max(serverPeakBytes, childPeakBytes());
      samplingMs += performance.now() - sampled;
      close();
    };
  }
  const result = buildTypeScriptExtraction(resolve(repo!), undefined, api ? { selectCompiler: () => api } : {});
  const elapsed = performance.now() - started - samplingMs;
  // One line per file: a large repository's result does not fit in one string.
  const fd = openSync(out!, "w");
  writeSync(fd, `${JSON.stringify({
    elapsedMs: elapsed,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    serverPeakBytes,
    projectCompilers: result.projectCompilers,
    projectCompilerNotes: result.projectCompilerNotes,
  })}\n`);
  for (const file of result.files) writeSync(fd, `${JSON.stringify(file)}\n`);
  closeSync(fd);
  process.exit(0);
}

/** Peak working set of this process's children (the compiler server), Windows only. */
function childPeakBytes(): number {
  if (process.platform !== "win32") return 0;
  const query = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Measure-Object -Property PeakWorkingSetSize -Maximum).Maximum`,
  ], { encoding: "utf8" });
  return Number(query.stdout.trim() || 0) * 1024;
}

const repo = resolve(args[0] ?? ".");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const self = fileURLToPath(import.meta.url);

interface Run { elapsedMs: number; peakRssBytes: number; serverPeakBytes: number; result: CompilerExtractionResult }

function run(compiler: "legacy" | "tsgo" | "tsrs"): Run {
  const out = resolve(process.env.TEMP ?? process.env.TMPDIR ?? ".", `mex-parity-${compiler}-${process.pid}.json`);
  const child = spawnSync(process.execPath, [
    "--max-old-space-size=8192", "--expose-gc",
    resolve("node_modules/vite-node/vite-node.mjs"), self, "--", "--extract", compiler, repo, out,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  if (child.status !== 0) throw new Error(`${compiler} extraction failed (exit ${child.status})`);
  const [meta, ...files] = readFileSync(out, "utf8").split("\n").filter(Boolean);
  rmSync(out, { force: true });
  const header = JSON.parse(meta!) as Omit<Run, "result"> & {
    projectCompilers: Record<string, string>; projectCompilerNotes?: Record<string, string[]>;
  };
  return {
    elapsedMs: header.elapsedMs,
    peakRssBytes: header.peakRssBytes,
    serverPeakBytes: header.serverPeakBytes,
    result: {
      files: files.map((line) => JSON.parse(line)),
      projectCompilers: header.projectCompilers,
      projectCompilerNotes: header.projectCompilerNotes ?? {},
    } as CompilerExtractionResult,
  };
}

const server = (args.includes("--server") ? args[args.indexOf("--server") + 1] : "tsrs") as "tsgo" | "tsrs";
const legacy = run("legacy");
const tsgo = run(server);
const report = compareCompilerExtractions(legacy.result, tsgo.result);
const summary = {
  repo,
  server,
  files: { legacy: legacy.result.files.length, api: tsgo.result.files.length },
  time: { legacyMs: Math.round(legacy.elapsedMs), apiMs: Math.round(tsgo.elapsedMs) },
  peakRssMb: {
    legacy: Math.round(legacy.peakRssBytes / 2 ** 20),
    apiClient: Math.round(tsgo.peakRssBytes / 2 ** 20),
    apiServer: Math.round(tsgo.serverPeakBytes / 2 ** 20),
  },
  parity: parityHolds(report),
  nodes: { ...report.nodes, onlyLeft: report.nodes.onlyLeft.length, onlyRight: report.nodes.onlyRight.length },
  nodeFieldDifferences: report.nodeFieldDifferences.length,
  displayDifferences: report.displayDifferences,
  edges: { ...report.edges, onlyLeft: report.edges.onlyLeft.length, onlyRight: report.edges.onlyRight.length },
  unresolved: report.unresolved,
  imports: { ...report.imports, differences: report.imports.differences.length },
  projects: projectSummary(tsgo.result),
};
console.log(JSON.stringify(summary, null, 2));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, report }, null, 2));

/** How the API run built each project: by compiler, translated tsconfigs, and fallbacks with their reasons. */
function projectSummary(result: CompilerExtractionResult): Record<string, unknown> {
  const byCompiler: Record<string, number> = {};
  for (const compiler of Object.values(result.projectCompilers ?? {})) byCompiler[compiler] = (byCompiler[compiler] ?? 0) + 1;
  const notes = Object.entries(result.projectCompilerNotes ?? {});
  const changes: Record<string, number> = {};
  for (const [, entries] of notes) {
    for (const entry of entries) if (/ → | removed$/u.test(entry) && !/ leaves /u.test(entry)) changes[entry] = (changes[entry] ?? 0) + 1;
  }
  return {
    byCompiler,
    translated: notes.filter(([, entries]) => entries.some((entry) => / → | removed$/u.test(entry) && !/ leaves /u.test(entry))).length,
    translations: changes,
    fallbacks: notes.flatMap(([project, entries]) => entries.filter((entry) => / leaves | failed \(/u.test(entry)).map((entry) => `${project}: ${entry}`)),
  };
}
