// Compare the published v4 and v5 graphs on the same scratch checkout.
// Run `npm run build:node` and build the Rust engine before running this:
//
//   node_modules/.bin/esbuild scripts/graph-engine-bench/storage-parity.ts \
//     --bundle --platform=node --format=esm --packages=external \
//     --banner:js="import { createRequire as __mexRequire } from 'node:module'; const require = __mexRequire(import.meta.url);" \
//     --outfile=dist/graph-storage-parity.mjs
//   MEX_GRAPH_ENGINE=<release mex-graph> node dist/graph-storage-parity.mjs <repos-dir> [flask hono nest]
//
// The source copies and graph homes are always disposed. The report goes to
// stdout. A difference outside the unresolved-caller improvement exits 1.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RepositoryGraphPort } from "../../src/graph/application-adapter.js";
import { openSqlite } from "../../src/graph/db/sqlite.js";
import { collectGraphGarbage, currentGraphPath, graphLocation, readGraphPointer } from "../../src/graph/storage.js";
import { treeRssKb } from "./process-tree.mjs";

const MiB = 1024 * 1024;
// Leave room for a write between samples on a nearly full volume.
const MIN_FREE_BYTES = 1664 * MiB;
const cli = resolve("dist/cli.js");
const [, , reposDirectory, ...requested] = process.argv;
if (!reposDirectory || !process.env.MEX_GRAPH_ENGINE) {
  throw new Error("Pass the benchmark repos directory and set MEX_GRAPH_ENGINE.");
}

const repositories = {
  flask: { edit: "src/flask/app.py", samples: [
    ["dispatch_request", "src/flask/app.py"], ["render_template", "src/flask/templating.py"],
    ["find_app_by_string", "src/flask/cli.py"],
  ] },
  hono: { edit: "src/hono-base.ts", samples: [
    ["dispatch", "src/hono-base.ts"], ["compose", "src/compose.ts"], ["getCookie", "src/helper/cookie/index.ts"],
  ] },
  nest: { edit: "packages/core/injector/injector.ts", samples: [
    ["loadInstance", "packages/core/injector/injector.ts"], ["explore", "packages/core/router/router-explorer.ts"],
    ["createParamDecorator", "packages/common/decorators/http/create-route-param-metadata.decorator.ts"],
  ] },
} as const;
type Name = keyof typeof repositories;
type RecordValue = Record<string, unknown>;
interface Measurement {
  wallMs: number;
  peakTreeMiB: number;
}
interface DiskUsage {
  bytes: number;
  tables: Record<string, number>;
  routeNodes: number;
  frameworkEdges: number;
  singleCandidates?: { count: number; examples: unknown[] };
}

const answersFor = (page: { items: readonly unknown[]; nextCursor: string | null }) =>
  ({ items: page.items, more: page.nextCursor !== null });

const freeBytes = () => {
  const stat = statfsSync(tmpdir(), { bigint: true });
  return Number(stat.bavail * stat.bsize);
};
const initialFree = freeBytes();
let minimumFree = initialFree;
function diskCheck() {
  const free = freeBytes();
  minimumFree = Math.min(minimumFree, free);
  if (free < MIN_FREE_BYTES) throw new Error(`Disk guard: ${Math.floor(free / MiB)} MiB free.`);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], { encoding: "utf8" }).trim();
}

function command(root: string, args: string[], measure = false): Promise<{ stdout: string; measurement: Measurement }> {
  diskCheck();
  return new Promise((fulfill, reject) => {
    const started = performance.now();
    const detached = process.platform !== "win32";
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root, env: process.env, detached, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let peakKb = 0;
    let failure: unknown;
    function kill() {
      if (!child.pid) return;
      try { process.kill(detached ? -child.pid : child.pid, "SIGKILL"); } catch { /* exited */ }
    }
    const tick = setInterval(() => {
      try { diskCheck(); } catch (error) { failure = error; kill(); }
      if (measure && child.pid) peakKb = Math.max(peakKb, treeRssKb(child.pid));
    }, 100);
    const deadline = setTimeout(() => { failure = new Error("Benchmark command timed out."); kill(); }, 300_000);
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      clearInterval(tick);
      clearTimeout(deadline);
      if (failure || code !== 0) {
        reject(failure ?? new Error(`${args.join(" ")} exited ${code}: ${(stderr || stdout).slice(-2000)}`));
        return;
      }
      fulfill({ stdout, measurement: { wallMs: Math.round(performance.now() - started), peakTreeMiB: Math.round(peakKb / 1024) } });
    });
  });
}

async function json(root: string, ...args: string[]) {
  return JSON.parse((await command(root, args)).stdout);
}

async function records(root: string, ...args: string[]): Promise<RecordValue[]> {
  const { stdout } = await command(root, args);
  const result = stdout.trim().split("\n").map(line => JSON.parse(line) as RecordValue);
  if (result.some(row => row.type === "error")) throw new Error(`${args.join(" ")}: ${JSON.stringify(result)}`);
  return result;
}

function storage(root: string, version: 4 | 5): DiskUsage {
  const path = currentGraphPath(root);
  const db = openSqlite(path, { readOnly: true, immutable: true });
  try {
    const versionSql = version === 5 ? "PRAGMA user_version" : "SELECT max(version) AS version FROM schema_versions";
    if (Object.values(db.prepare(versionSql).get() as RecordValue)[0] !== version) {
      throw new Error(`Expected published schema ${version}.`);
    }
    const rows = db.prepare(
      `SELECT coalesce(s.tbl_name, d.name) AS name, sum(d.pgsize) AS bytes
       FROM dbstat d LEFT JOIN sqlite_schema s ON s.name = d.name GROUP BY 1`,
    ).all() as Array<{ name: string; bytes: number }>;
    const tables: Record<string, number> = {};
    for (const row of rows) {
      // Sum index pages into their owning table and FTS5 shadow pages into
      // their virtual table. dbstat omits any freelist pages from file size.
      const table = row.name.replace(/_(?:config|data|docsize|idx|content)$/u, suffix =>
        row.name.slice(0, -suffix.length).endsWith("_fts") ? "" : suffix);
      tables[table] = (tables[table] ?? 0) + row.bytes;
    }
    const total = statSync(path).size;
    const accounted = Object.values(tables).reduce((sum, bytes) => sum + bytes, 0);
    if (total > accounted) tables["(freelist or unallocated)"] = total - accounted;
    const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
    const routeNodes = count(version === 4
      ? "SELECT count(*) AS count FROM nodes WHERE kind = 'route'"
      : "SELECT count(*) AS count FROM nodes WHERE kind = (SELECT id FROM node_kinds WHERE name = 'route')");
    const frameworkEdges = count(version === 4
      ? "SELECT count(*) AS count FROM edges WHERE provenance = 'framework'"
      : "SELECT count(*) AS count FROM edges WHERE provenance = (SELECT id FROM provenances WHERE name = 'framework')");
    const singleCandidates = version === 5 ? {
      count: count("SELECT count(*) AS count FROM unresolved_calls WHERE candidate IS NOT NULL"),
      examples: db.prepare(`
        SELECT name.name, reason.name AS reason, file.path, call.line,
               kind.name || ':' || lower(hex(candidate.public_id)) AS candidate,
               candidate.qualified_name AS qualifiedName
        FROM unresolved_calls call JOIN unresolved_names name ON name.id = call.name
        JOIN unresolved_reasons reason ON reason.id = call.reason
        JOIN nodes source ON source.id = call.source JOIN files file ON file.id = source.file
        JOIN nodes candidate ON candidate.id = call.candidate JOIN node_kinds kind ON kind.id = candidate.kind
        ORDER BY reason.name <> 'interface_dispatch', file.path, call.line, call.col LIMIT 2
      `).all(),
    } : undefined;
    return { bytes: total, tables, routeNodes, frameworkEdges, singleCandidates };
  } finally { db.close(); }
}

async function readAnswers(root: string, repo: Name) {
  const port = new RepositoryGraphPort(root);
  const pointer = readGraphPointer(graphLocation(root))!;
  const answers: RecordValue = {};
  const status = await json(root, "graph", "status", "--json");
  // Timestamps, DB version, and revision-bound cursors change with the format.
  const {
    observedAt, indexedAt, lastSuccessfulIndexAt, schemaVersion, stores, usage, currentRepo, ...statusFacts
  } = status;
  const { observedAt: repoObservedAt, ...repoFacts } = currentRepo;
  answers.status = { ...statusFacts, currentRepo: repoFacts, files: pointer.files, nodes: pointer.nodes, edges: pointer.edges };
  // Hono's one indexed implementation of the execution-context method has
  // a caller through the interface, even though its resolved caller list is empty.
  if (repo === "hono") {
    const target = (await port.searchNodes({ query: "waitUntil", limit: 100 })).items.find(node =>
      node.name === "waitUntil" && node.path === "src/middleware/cache/index.test.ts");
    if (!target) throw new Error("Missing Hono's interface-dispatch benchmark target.");
    answers["Context::waitUntil / CLI who-calls"] = await records(
      root, "graph", "query", "who-calls", target.ref.symbolId, "--max-nodes", "15",
    );
  }
  for (const [name, path] of repositories[repo].samples) {
    const nodes = await port.searchNodes({ query: name, limit: 40 });
    const symbol = nodes.items.find(candidate => candidate.path === path
      && (candidate.name === name || candidate.name === `#${name}`));
    if (!symbol) throw new Error(`Missing benchmark target ${path}:${name}`);
    const id = symbol.ref.symbolId;
    answers[`${name} / node search`] = answersFor(nodes);
    answers[`${name} / source search`] = answersFor(await port.searchSource({
      query: name, limit: 10, maxLinesPerMatch: 30, maxBytesPerMatch: 4096,
    }));
    answers[`${name} / definition`] = await port.resolveCodeRef({ ref: symbol.ref, maxCandidates: 12 });
    answers[`${name} / callers`] = answersFor(await port.getCallers({ symbolId: id, limit: 30 }));
    answers[`${name} / callees`] = answersFor(await port.getCallees({ symbolId: id, limit: 30 }));
    answers[`${name} / impact`] = await port.getImpact({ ref: symbol.ref, depth: 2, maxNodes: 30 });
    answers[`${name} / anchor`] = await port.withFreshGroundingSnapshot(graph => {
      const node = graph.getNode(id);
      const fingerprint = graph.getFingerprint(id);
      if (!node?.bodyHash || !fingerprint?.startsWith("mh2:")) throw new Error(`Missing grounded evidence for ${name}`);
      return { node, fingerprint };
    });
    for (const relation of ["where-defined", "who-calls", "what-calls"]) {
      answers[`${name} / CLI ${relation}`] = await records(root, "graph", "query", relation, id, "--max-nodes", "15");
    }
    answers[`${name} / CLI get`] = await records(root, "graph", "get", id, "--max-source-lines", "15");
    answers[`${name} / CLI impact`] = await records(root, "impact", id, "--depth", "2", "--max-nodes", "15");
  }
  return answers;
}

function sweepBenchGraphs(root: string): void {
  collectGraphGarbage(graphLocation(root), Date.now() + 120_000);
  diskCheck();
}

async function reconcileMove(root: string, python: boolean) {
  const extension = python ? "py" : "ts";
  const before = join(root, `mex_storage_bench_anchor_before.${extension}`);
  const after = join(root, `mex_storage_bench_anchor_after.${extension}`);
  const name = "mexStorageBenchAnchor";
  const source = python
    ? `def ${name}(seed):\n    large = seed * 75671 + (seed % 18313) ** 2\n    small = (seed + 56437) / (45739 + seed)\n    return (large + small) * 89497 - seed * 23549\n`
    : `export function ${name}(seed: number) {\n  const large = seed * 75671 + (seed % 18313) ** 2;\n  const small = (seed + 56437) / (45739 + seed);\n  return (large + small) * 89497 - seed * 23549;\n}\n`;
  try {
    writeFileSync(before, source, { flag: "wx" });
    await json(root, "graph", "refresh", "--json");
    sweepBenchGraphs(root);
    const port = new RepositoryGraphPort(root);
    const id = (await port.searchNodes({ query: name, limit: 10 })).items.find(node => node.name === name)!.ref.symbolId;
    const { node, fingerprint } = await port.withFreshGroundingSnapshot(graph => ({
      node: graph.getNode(id), fingerprint: graph.getFingerprint(id),
    }));
    if (!fingerprint || !node?.bodyHash) throw new Error("Could not capture the move fixture.");
    renameSync(before, after);
    await json(root, "graph", "refresh", "--json");
    const verdict = await port.withFreshGroundingSnapshot(graph => graph.reconcile(id, fingerprint, node.bodyHash!));
    if (verdict?.kind !== "MOVED" || verdict.nodeId === id) throw new Error(`Expected a move: ${JSON.stringify(verdict)}`);
    return { before: id, verdict };
  } finally {
    rmSync(before, { force: true });
    rmSync(after, { force: true });
  }
}

function potentialOnly(left: unknown, right: unknown): RecordValue[] | undefined {
  if (!Array.isArray(left) || !Array.isArray(right)) return undefined;
  const sites = right.filter(row => row.type === "unresolved-reference");
  if (!sites.length || left.some(row => row.type === "unresolved-reference")) return undefined;
  const v5Summary = right.at(-1);
  if (v5Summary?.status !== "partial" || v5Summary.truncated) return undefined;
  // An otherwise empty caller result now reports potential sites. Prove
  // that removing the new records and their summary effects leaves v4.
  const normalized = right.filter(row => row.type !== "unresolved-reference").map(row =>
    row.type === "summary" ? {
      ...row,
      status: left.at(-1)?.status,
      evidenceStrength: left.at(-1)?.evidenceStrength,
      warnings: left.at(-1)?.warnings,
      estimatedOutputTokens: left.at(-1)?.estimatedOutputTokens,
    } : row);
  return isDeepStrictEqual(left, normalized) ? sites : undefined;
}

function firstDifference(left: unknown, right: unknown, path = "$"): unknown {
  if (isDeepStrictEqual(left, right)) return undefined;
  if (left && right && typeof left === "object" && typeof right === "object") {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const result = firstDifference((left as RecordValue)[key], (right as RecordValue)[key], `${path}.${key}`);
      if (result !== undefined) return result;
    }
  }
  return { path, v4: left ?? null, v5: right ?? null };
}

async function compare(name: Name) {
  const input = resolve(reposDirectory!, name);
  diskCheck();
  const scratch = mkdtempSync(join(tmpdir(), `mex-storage-bench-${name}-`));
  const root = join(scratch, "repo");
  try {
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "advice.detachedHead=false", "clone", "--shared", "--quiet", input, root]);
    const revision = git(root, ["rev-parse", "HEAD"]);
    const edit = repositories[name].edit;
    const arms = [];
    for (const version of [4, 5] as const) {
      const home = join(scratch, `home-v${version}`);
      mkdirSync(home);
      process.env.MEX_HOME = home;
      process.env.MEX_GRAPH_ENGINE_LANGUAGES = "python,typescript,javascript";
      if (version === 5) process.env.MEX_GRAPH_STORAGE = "v5";
      else delete process.env.MEX_GRAPH_STORAGE;
      try {
        console.error(`${name}: building v${version}`);
        const build = await command(root, ["graph", "rebuild", "--json"], true);
        const result = JSON.parse(build.stdout);
        if (!result.engine || result.engine.fallbackFiles !== 0) throw new Error(`v${version} did not build with the engine.`);
        const disk = storage(root, version);
        console.error(`${name}: comparing v${version} reads`);
        const answers = await readAnswers(root, name);
        appendFileSync(join(root, edit), extname(edit) === ".py" ? "\n# storage benchmark edit\n" : "\n// storage benchmark edit\n");
        const refresh = await command(root, ["graph", "refresh", "--json"], true);
        git(root, ["restore", "--", edit]);
        sweepBenchGraphs(root);
        answers["reconcile moved anchor"] = await reconcileMove(root, name === "flask");
        arms.push({ answers, disk, rebuild: build.measurement, refresh: refresh.measurement });
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
    const [v4, v5] = arms;
    if (!v4 || !v5) throw new Error("Both graph formats are required.");
    const identical: string[] = [];
    const deliberate: RecordValue[] = [];
    const differences: RecordValue[] = [];
    for (const [question, left] of Object.entries(v4.answers)) {
      const right = v5.answers[question];
      if (isDeepStrictEqual(left, right)) identical.push(question);
      else {
        const sites = question.endsWith("CLI who-calls") ? potentialOnly(left, right) : undefined;
        if (sites) deliberate.push({ question, count: sites.length, example: sites[0] });
        else differences.push({ question, firstDifference: firstDifference(left, right) });
      }
    }
    if (differences.length) process.exitCode = 1;
    console.log(JSON.stringify({
      repo: name, revision, edit, questions: Object.keys(v4.answers), identical, deliberate, differences,
      counts: { v4: v4.answers.status, v5: v5.answers.status },
      move: v5.answers["reconcile moved anchor"],
      v4: { disk: v4.disk, rebuild: v4.rebuild, refresh: v4.refresh },
      v5: { disk: v5.disk, rebuild: v5.rebuild, refresh: v5.refresh },
    }));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (!treeRssKb(process.pid)) throw new Error("Whole-process-tree memory sampling requires access to ps.");
process.env.MEX_TELEMETRY = "0";
process.env.MEX_OFFLINE = "1";
process.env.DO_NOT_TRACK = "1";
for (const name of requested.length > 0 ? requested : Object.keys(repositories)) {
  if (!Object.hasOwn(repositories, name)) throw new Error(`Unknown benchmark repo: ${name}`);
  try { await compare(name as Name); }
  catch (error) { console.error(`${name}: ${String(error)}`); process.exitCode = 1; }
}
console.log(JSON.stringify({ freeAtStartMiB: Math.floor(initialFree / MiB), minimumFreeMiB: Math.floor(minimumFree / MiB) }));
