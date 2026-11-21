#!/usr/bin/env node
// Graph build benchmark (OSS-73): cold build and one-file CLI refresh.
//
// usage: node measure.mjs --bench <BENCH_DIR> --tool <id> --cli <path/to/cli.js>
//                         --repo <name> [--runs 3] [--keep-graph] [--timeout-min 30]
// For an engine build, use --engine <path/to/mex-graph> instead of --cli
// and optionally pass --languages python and --memory-mb 4096.
//
// Each run indexes a fresh copy of $BENCH_DIR/repos/<repo> (made and read once
// before timing, as in an existing checkout) with a fresh MEX home, telemetry
// and update checks off. It times `mex graph rebuild`, then appends one comment
// line to a fixed source file and times `mex graph refresh`.
//
// Peak memory is the resident memory of the whole process tree, sampled every
// 100 ms with `ps`; `/usr/bin/time -l` supplies CPU time and the largest single
// process. Graph size is every graph file on disk, plus a per-table breakdown
// from SQLite's dbstat. Results go to $BENCH_DIR/results/<tool>/<repo>/.
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return acc;
}, []));
for (const required of ["bench", "tool", "repo"]) if (!args[required]) throw new Error(`--${required} is required`);
const { cli, engine } = args;
if (Boolean(cli) === Boolean(engine) || cli === true || engine === true) {
  throw new Error("specify either --cli <path> or --engine <path>");
}
const runs = Number(args.runs ?? 3);
const ENGINE_DEADLINE_MIN = 40;
const timeoutMs = Number(args["timeout-min"] ?? (engine ? ENGINE_DEADLINE_MIN : 30)) * 60_000;
const bench = engine ? resolve(args.bench) : args.bench;
const repoDir = join(bench, "repos", args.repo);
const outDir = join(bench, "results", args.tool, args.repo);
const languages = String(args.languages ?? "python").split(",").map((lang) => lang.trim());
const memoryMb = Number(args["memory-mb"] ?? 4096);
if (engine && (args.languages === true || languages.some((lang) => !lang))) {
  throw new Error("--languages requires a comma-separated list of language ids");
}
if (engine && (args["memory-mb"] === true || !Number.isSafeInteger(memoryMb) || memoryMb < 1)) {
  throw new Error("--memory-mb requires a positive integer");
}
mkdirSync(outDir, { recursive: true });

const SOURCE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".cs"]);
const EXCLUDE = /(^|\/)(node_modules|dist|build|vendor|__fixtures__|fixtures|test|tests|__tests__|spec|e2e|docs?|examples?)\//i;

/** The file the refresh edits: the largest non-test source file under 64 KB, chosen once from git. */
function refreshFile() {
  const files = execFileSync("git", ["-C", repoDir, "ls-files"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n")
    .filter((f) => SOURCE.has(extname(f)) && !EXCLUDE.test(f) && !/\.d\.ts$|\.(test|spec)\./.test(f));
  let best = null;
  for (const f of files) {
    const size = statSync(join(repoDir, f)).size;
    if (size < 64 * 1024 && (!best || size > best.size || (size === best.size && f < best.file))) best = { file: f, size };
  }
  return best?.file;
}

function commentFor(file) {
  return extname(file) === ".py" ? "\n# mex graph bench edit\n" : "\n// mex graph bench edit\n";
}

function readAll(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) readAll(path);
    else if (entry.isFile()) readFileSync(path);
  }
}

function writeEngineRequest(root, home, output) {
  const paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter(Boolean);
  const files = paths.map((path) => ({ path, size: lstatSync(join(root, path), { throwIfNoEntry: false })?.size ?? 0 }));
  const request = join(home, "request.json");
  writeFileSync(request, JSON.stringify({
    contract: 1, mode: "build", root, files, languages, output,
    limits: { memoryMb, deadlineMs: ENGINE_DEADLINE_MIN * 60_000 },
  }));
  return request;
}

/** Sum of RSS (KB) over `pid` and its descendants. */
function treeRssKb(pid) {
  let out;
  try { out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }); } catch { return 0; }
  const children = new Map(); const rss = new Map();
  for (const line of out.trim().split("\n")) {
    const [p, pp, r] = line.trim().split(/\s+/).map(Number);
    rss.set(p, r);
    if (!children.has(pp)) children.set(pp, []);
    children.get(pp).push(p);
  }
  let total = 0; const stack = [pid]; const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p); total += rss.get(p) ?? 0;
    for (const c of children.get(p) ?? []) stack.push(c);
  }
  return total;
}

function timed(argv, env, cwd, startEngine = false) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn("/usr/bin/time", ["-l", ...argv], {
      cwd, env, detached: startEngine, stdio: [startEngine ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (startEngine) {
      // EOF signals that the parent went away. Keep stdin open for the job.
      child.stdin.on("error", () => {}); // An early engine exit is reported by the wrapper.
      child.stdin.write("start\n");
    }
    let stdout = ""; let stderr = ""; let peakKb = 0;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const sampler = setInterval(() => { peakKb = Math.max(peakKb, treeRssKb(child.pid)); }, 100);
    const killer = setTimeout(() => { try { process.kill(startEngine ? -child.pid : child.pid, "SIGKILL"); } catch {} }, timeoutMs);
    child.on("close", (code) => {
      clearInterval(sampler); clearTimeout(killer);
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      const num = (re) => Number(stderr.match(re)?.[1] ?? NaN);
      resolve({
        code, wallMs: Math.round(wallMs),
        cpuMs: Math.round((num(/([\d.]+) user/) + num(/([\d.]+) sys/)) * 1000),
        peakTreeMb: Math.round(peakKb / 1024),
        maxSingleMb: Math.round(num(/(\d+)\s+maximum resident set size/) / 1048576),
        stdout, stderrTail: stderr.split("\n").filter((l) => !/^\s+\d+\s+[a-z]/.test(l)).slice(-8).join("\n"),
      });
    });
  });
}

/** Every graph database file this tool wrote, with WAL/SHM. */
function graphFiles(src, home) {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^graph.*\.db(-wal|-shm)?$/.test(e.name)) found.push(p);
    }
  };
  walk(join(src, ".mex"));
  walk(join(home, ".mex", "projects"));
  return found;
}

function dbStats(db) {
  const q = (sql) => execFileSync("sqlite3", ["-readonly", `file:${db}?immutable=1`, sql], { encoding: "utf8" }).trim();
  const tables = {};
  for (const line of q("SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC;").split("\n")) {
    const [name, bytes] = line.split("|");
    if (name) tables[name] = Number(bytes);
  }
  const count = (t) => { try { return Number(q(`SELECT count(*) FROM ${t};`)); } catch { return null; } };
  return { files: count("files"), nodes: count("nodes"), edges: count("edges"), tables };
}

const env = (home) => ({ ...process.env, MEX_HOME: home, DO_NOT_TRACK: "1", MEX_TELEMETRY: "0", MEX_OFFLINE: "1" });
const target = engine ? undefined : refreshFile();
const results = [];
for (let i = 1; i <= runs; i++) {
  const runDir = join(outDir, `run-${i}`);
  rmSync(runDir, { recursive: true, force: true });
  const src = join(runDir, "src"); const home = join(runDir, "home");
  cpSync(repoDir, src, { recursive: true }); mkdirSync(home, { recursive: true });
  readAll(src);

  const engineDb = engine ? join(home, "graph-engine.db") : null;
  const build = engine
    ? await timed([resolve(engine), "build", "--request", writeEngineRequest(src, home, engineDb)], env(home), src, true)
    : await timed(["node", cli, "graph", "rebuild", "--root", src, "--json"], env(home), src);
  let summary = {};
  if (engine) {
    if (build.code === 0) {
      summary = JSON.parse(build.stdout.trimEnd().split("\n").at(-1));
      if (summary?.type !== "result") throw new Error("engine stdout must end with a result event");
    }
  } else {
    try { const r = JSON.parse(build.stdout); summary = { files: r.filesIndexed, nodes: r.nodesCreated, edges: r.edgesCreated, compiler: r.typescript?.compiler }; } catch {}
  }
  const files = engine
    ? [engineDb, `${engineDb}-wal`, `${engineDb}-shm`].filter((f) => existsSync(f))
    : graphFiles(src, home);
  const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
  const mainDb = engine
    ? (build.code === 0 ? engineDb : null)
    : files.filter((f) => f.endsWith(".db")).sort((a, b) => statSync(b).size - statSync(a).size)[0];
  const stats = mainDb ? dbStats(mainDb) : null;

  let refresh = null;
  if (build.code === 0 && target) {
    appendFileSync(join(src, target), commentFor(target));
    refresh = await timed(["node", cli, "graph", "refresh", "--root", src, "--json"], env(home), src);
    delete refresh.stdout;
  }
  delete build.stdout;
  const result = { tool: args.tool, repo: args.repo, run: i, build, summary, graph: { bytes, files: files.map((f) => f.slice(runDir.length + 1)), stats }, refresh, refreshFile: target };
  results.push(result);
  console.log(JSON.stringify({ run: i, code: build.code, wallMs: build.wallMs, peakTreeMb: build.peakTreeMb, nodes: stats?.nodes, edges: stats?.edges, mb: Math.round(bytes / 1048576), refreshMs: refresh?.wallMs, refreshCode: refresh?.code }));
  if (i === 1 && args["keep-graph"] && mainDb) { cpSync(mainDb, join(outDir, "graph.db")); writeFileSync(join(outDir, "root.txt"), src + "\n"); }
  rmSync(home, { recursive: true, force: true });
  if (!(i === 1 && args["keep-graph"])) rmSync(src, { recursive: true, force: true });
}
writeFileSync(join(outDir, "measure.json"), JSON.stringify(results, null, 2));
