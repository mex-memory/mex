import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { prepare, run, selectedSchedule } from "../index.mjs";
import { buildIndexCache, git, mexEntrypoint, resolveCommit } from "./workspace.mjs";
import { generateReport, loadRows } from "./report.mjs";
import { resourceGuard, resourceSnapshot, startSampler } from "./resources.mjs";

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
export function atomicJson(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
export function removeOwnedTree(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("cleanup path escaped pipeline output");
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
export function cleanupPipeline(output, keepCache = null, keepGraph = null) {
  for (const name of ["ws", "temp", "instruction-check"]) removeOwnedTree(output, join(output, name));
  const cacheRoot = join(output, "index-cache");
  if (existsSync(cacheRoot)) for (const name of readdirSync(cacheRoot)) if (join(cacheRoot, name) !== keepCache) removeOwnedTree(output, join(cacheRoot, name));
  if (!keepCache) removeOwnedTree(output, cacheRoot);
  const chains = join(output, "chain");
  if (existsSync(chains)) for (const name of readdirSync(chains)) if (join(chains, name) !== keepGraph) removeOwnedTree(output, join(chains, name));
  if (!keepGraph) removeOwnedTree(output, chains);
  const artifacts = join(output, "artifacts");
  if (existsSync(artifacts)) for (const name of readdirSync(artifacts)) if (name.endsWith(".codex-home")) removeOwnedTree(output, join(artifacts, name));
}
export async function compareGraphTables(left, right) {
  const { DatabaseSync } = await import("node:sqlite");
  const a = new DatabaseSync(left, { readOnly: true }), b = new DatabaseSync(right, { readOnly: true });
  const names = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  // Two full builds of one commit differ only in these: write times and stamps of the build itself.
  const OPERATIONAL_COLUMN = /_at$/;
  const OPERATIONAL_METADATA = new Set(["unindexed_source_coverage", "graph_snapshot_v1", "incremental_state_snapshot"]);
  const digest = (db, name, operational = false) => {
    const quote = (v) => `"${v.replaceAll('"', '""')}"`;
    const all = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map((c) => c.name);
    const cols = operational ? all.filter((c) => !OPERATIONAL_COLUMN.test(c)) : all;
    let count = 0; const h = createHash("sha256");
    h.update(JSON.stringify(cols));
    const statement = db.prepare(`SELECT ${cols.map(quote).join(",")} FROM ${quote(name)} ORDER BY ${cols.map(quote).join(",")}`);
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) {
      if (operational && name === "project_metadata" && OPERATIONAL_METADATA.has(String(row.key))) continue;
      h.update(JSON.stringify(row, (_, v) => typeof v === "bigint" ? String(v) : v)); count++;
    }
    return { rows: count, sha256: h.digest("hex") };
  };
  try {
    const an = names(a), bn = names(b);
    const tables = [...new Set([...an, ...bn])].sort().map((name) => {
      const l = an.includes(name) ? digest(a, name) : null, r = bn.includes(name) ? digest(b, name) : null;
      return { name, left: l, right: r, equal: l !== null && r !== null && l.sha256 === r.sha256 && l.rows === r.rows };
    });
    let semantic = null;
    if (["nodes", "edges", "files", "project_metadata"].every((name) => an.includes(name) && bn.includes(name))) {
      const { inspectGraphDatabase } = await import("../../graph/lib/integrity.mjs");
      const leftHash = inspectGraphDatabase(left).normalizedGraphSha256, rightHash = inspectGraphDatabase(right).normalizedGraphSha256;
      semantic = { equal: leftHash === rightHash, leftHash, rightHash, policy: "existing graph evaluator normalization (operational timestamps, Git coordinates and storage bookkeeping excluded)" };
    }
    const operational = tables.map(({ name }) => {
      const l = an.includes(name) ? digest(a, name, true) : null, r = bn.includes(name) ? digest(b, name, true) : null;
      return { name, equal: l !== null && r !== null && l.sha256 === r.sha256 && l.rows === r.rows };
    });
    return {
      equal: operational.every((t) => t.equal),
      policy: `every table and row; ignores only columns ending in _at and the build-stamp metadata keys ${[...OPERATIONAL_METADATA].join(", ")}, which differ between two full builds of one commit`,
      unequalTables: operational.filter((t) => !t.equal).map((t) => t.name),
      exactEqual: tables.every((t) => t.equal),
      tables,
      semantic,
    };
  } finally { a.close(); b.close(); }
}

/** One current cache and one durable graph link; rows commit before the link advances. */
export async function runPipeline(args, suite) {
  mkdirSync(join(args.output, "artifacts"), { recursive: true });
  const schedule = selectedSchedule(suite, args);
  const selected = suite.tasks.filter((t) => schedule.some((r) => r.task.id === t.id));
  const seeds = args.seedGraphs ? JSON.parse(readFileSync(args.seedGraphs, "utf8")) : suite.graphSeeds ?? {};
  const seedPaths = Object.fromEntries(Object.entries(seeds).map(([key, p]) => [key, resolve(p)]));
  const groups = [];
  for (const task of selected) {
    const base = resolveCommit(args.subject, task.base), scaffold = task.scaffold;
    let g = groups.find((g) => g.base === base && g.scaffold === scaffold);
    if (!g) { g = { base, scaffold, tasks: [], timestamp: Number(git(args.subject, ["show", "-s", "--format=%ct", base]).stdout.trim()) }; groups.push(g); }
    g.tasks.push(task.id);
  }
  groups.sort((a, b) => a.timestamp - b.timestamp || a.base.localeCompare(b.base));
  const key = createHash("sha256").update(JSON.stringify({ suite: hash(args.suite), subject: args.subject, deps: args.deps, agent: args.agent, model: args.model, effort: args.effort, sandbox: args.sandbox, cli: hash(mexEntrypoint(args.cliBin)), aliases: args.aliases ? hash(args.aliases) : null, groups, schedule: schedule.map((r) => r.runId), scaffolds: Object.fromEntries(Object.entries(suite.scaffolds ?? {}).map(([k, v]) => [k, resolveCommit(args.subject, v)])), seeds: Object.fromEntries(Object.entries(seedPaths).map(([k, p]) => [k, { path: p, sha256: hash(p) }])), compareBase: args.compareBase })).digest("hex");
  const statePath = join(args.output, "pipeline.json");
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { schemaVersion: 1, key, done: [], current: null, graph: null, graphScaffold: null, tasks: {}, baselines: {}, initialResources: resourceSnapshot(args.output) };
  if (state.key !== key) throw new Error("pipeline configuration changed; use a separate output (including effort comparisons)");
  if (state.done.length && !args.resume) throw new Error("pipeline exists; use --resume");
  if (state.graph && (!existsSync(state.graph) || hash(state.graph) !== state.graphSha256)) throw new Error("pipeline chain graph is missing or changed");
  cleanupPipeline(args.output, state.current?.cachePath, state.graph);
  atomicJson(statePath, state);
  try {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i], id = `${group.base}-${group.scaffold}`;
      if (state.done.includes(id)) {
        const verifiedRows = loadRows(args.output, suite);
        for (const item of schedule.filter((r) => group.tasks.includes(r.task.id))) {
          const row = join(args.output, "runs", `${item.runId}.json`);
          if (!existsSync(row) || !verifiedRows.find((r) => r.runId === item.runId)?.valid) throw new Error(`finished pipeline row missing/invalid: ${item.runId}`);
        }
        continue;
      }
      const baseArgs = { ...args, tasks: group.tasks, resume: true };
      if (!state.current || state.current.id !== id || !existsSync(join(args.output, "prepare.json"))) {
        cleanupPipeline(args.output, null, state.graph);
        let seed = state.graphScaffold === group.scaffold ? state.graph : seedPaths[group.scaffold];
        if (seed) baseArgs.seedCache = seed;
        // An explicit seed is required for a configured chain, rather than silently full-building it.
        if (suite.requireGraphSeeds && !seed) throw new Error(`missing seed graph for scaffold ${group.scaffold}; pass --seed-graphs`);
        await prepare(baseArgs, suite);
        const prepared = JSON.parse(readFileSync(join(args.output, "prepare.json"), "utf8"));
        const cachePath = prepared.tasks[group.tasks[0]].cachePath;
        state.current = { id, cachePath };
        Object.assign(state.tasks, prepared.tasks);
        Object.assign(state.baselines, JSON.parse(readFileSync(join(args.output, "baselines.json"), "utf8")));
        atomicJson(statePath, state);
        cleanupPipeline(args.output, cachePath, state.graph);
      }
      const info = JSON.parse(readFileSync(join(state.current.cachePath, "build-info.json"), "utf8"));
      atomicJson(join(args.output, "artifacts", `${id}.graph.json`), info);
      if (args.compareBase && [group.base, ...group.tasks].some((v) => v === args.compareBase || v.startsWith(args.compareBase))) {
        const comparisonFile = join(args.output, "artifacts", `${id}.comparison.json`);
        if (!existsSync(comparisonFile)) {
          await resourceGuard({ ...args.resources, path: args.output, label: "full graph comparison" });
          const sampler = startSampler({ path: args.output, csv: join(args.output, "artifacts", `${id}.full.resources.csv`) });
          let full;
          try { full = buildIndexCache({ subjectRoot: args.subject, cacheDir: join(args.output, "index-cache"), key: "full-comparison", base: group.base, scaffoldCommit: resolveCommit(args.subject, suite.scaffolds[group.scaffold]), cliBin: args.cliBin, depsDir: args.deps, agent: args.agent, projectName: suite.projectName, env: process.env }); }
          finally { atomicJson(join(args.output, "artifacts", `${id}.full.resources.json`), await sampler.stop()); }
          atomicJson(comparisonFile, await compareGraphTables(join(state.current.cachePath, "graph.db"), join(full, "graph.db")));
          removeOwnedTree(args.output, full);
        }
      }
      await run(baseArgs, suite);
      const rows = loadRows(args.output, suite);
      const expected = schedule.filter((r) => group.tasks.includes(r.task.id));
      if (expected.some((item) => !rows.find((r) => r.runId === item.runId)?.valid)) throw new Error(`base ${group.base} has invalid rows; inspect artifacts and resume`);
      const graph = join(args.output, "chain", `${group.base}.db`);
      mkdirSync(join(args.output, "chain"), { recursive: true });
      copyFileSync(join(state.current.cachePath, "graph.db"), `${graph}.tmp`); renameSync(`${graph}.tmp`, graph);
      state.graph = graph; state.graphSha256 = hash(graph); state.graphScaffold = group.scaffold;
      state.done.push(id); state.current = null;
      atomicJson(statePath, state);
      cleanupPipeline(args.output, null, graph);
      atomicJson(join(args.output, "baselines.json"), state.baselines);
      writeFileSync(join(args.output, "report.md"), generateReport({ suite, rows, salt: key, baselines: state.baselines }));
    }
    // Clear the graph pointer durably before deleting the last link; a reboot can finish this cleanup.
    state.graph = null; state.graphSha256 = null; state.complete = true; state.finalResources = resourceSnapshot(args.output);
    atomicJson(statePath, state); cleanupPipeline(args.output);
    const preparedPath = join(args.output, "prepare.json");
    if (existsSync(preparedPath)) { const p = JSON.parse(readFileSync(preparedPath, "utf8")); p.tasks = state.tasks; atomicJson(preparedPath, p); }
    process.stdout.write(`${JSON.stringify({ bases: groups.length, rows: loadRows(args.output, suite).length, initial: state.initialResources, final: state.finalResources, cleaned: true }, null, 2)}\n`);
    return state;
  } finally {
    // Keep a completed cache for resume, but never retain workspaces, temp directories or credential homes.
    cleanupPipeline(args.output, state.current?.cachePath, state.graph);
  }
}
