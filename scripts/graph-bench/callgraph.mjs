#!/usr/bin/env node
// The compiler-graded call-graph benchmark: "who calls X?", answered by MEX
// and by grep, scored against the TypeScript compiler.
//
//   node scripts/graph-bench/callgraph.mjs --repo <TypeScript checkout>
//        [--binary <mex-hook>] [--sample 100|all] [--baseline-db <graph.db>]
//        [--rg] [--out <report.json>] [--no-build] [--gate]
//
// TypeScript 5.9's language service is the answer key. For each definition it
// supplies every call site as file:line. The definitions are functions, methods and functions
// bound to a const whose name the program defines once, every k-th in path
// order, or all of them. Arms:
//
//   mex       `mex-hook --graph-read` callers of file:name, real calls only
//             (values are passed, not called); each read is timed with its
//             process start.
//   baseline  with --baseline-db, the calls edges of another graph database
//             (an 0.8 `.mex/graph.db`), read directly: the graph before 0.9.
//   grep      every line matching `\bX\s*(`, the definition line excluded:
//             what an agent's search returns before it reads anything.
//   careful   grep's lines, less what an agent would set aside by eye:
//             comments, the name only inside a string, and lines that
//             declare a function of that name rather than call it.
//
// Scored per call site: precision, recall and F1, micro (summed over every
// definition) and macro (averaged per definition), with 95% bootstrap
// intervals over definitions. Tokens are what each arm's answer costs an
// agent to read (characters / 4): grep's matching lines, MEX's one line per
// caller. With --rg, the time ripgrep takes to answer the same name is
// measured on the first 50 definitions. With --gate it exits 1 unless MEX's
// F1 and precision are at least careful grep's. Deterministic; no network,
// no model.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.git|\.mex)(\/|$)/u;
const BOOTSTRAP = 2000;
const RG_SAMPLE = 50;

export function parseArgs(argv) {
  const args = { repo: ROOT, sample: 100, build: true, gate: false, rg: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = resolve(argv[++i]);
    else if (a === "--binary") args.binary = resolve(argv[++i]);
    else if (a === "--sample") { const v = argv[++i]; args.sample = v === "all" ? Infinity : Number(v); }
    else if (a === "--baseline-db") args.baselineDb = resolve(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--no-build") args.build = false;
    else if (a === "--gate") args.gate = true;
    else if (a === "--rg") args.rg = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.sample !== Infinity && (!Number.isInteger(args.sample) || args.sample < 1)) throw new Error("--sample must be a positive integer or all");
  return args;
}

const posix = (p) => p.split(sep).join("/");
const tokens = (text) => Math.ceil(text.length / 4);

/** A tsconfig's files and options, following project references (a solution config lists none itself). */
function configFiles(config, seen = new Set()) {
  if (seen.has(config) || !ts.sys.fileExists(config)) return { files: [], options: undefined };
  seen.add(config);
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config, ts.sys, dirname(config));
  let files = [...parsed.fileNames], options = parsed.fileNames.length ? parsed.options : undefined;
  for (const ref of parsed.projectReferences ?? []) {
    const next = ts.sys.fileExists(ref.path) && !ts.sys.directoryExists(ref.path) ? ref.path : join(ref.path, "tsconfig.json");
    const child = configFiles(next, seen);
    files.push(...child.files);
    options ??= child.options;
  }
  return { files: [...new Set(files)], options };
}

/** The compiler's program for the repo: its tsconfig (with its references), or every .ts/.tsx file. */
export function loadProgram(repo) {
  const config = ts.findConfigFile(repo, ts.sys.fileExists, "tsconfig.json");
  let files = [], options = { allowJs: false, noEmit: true };
  if (config && posix(dirname(config)) === posix(repo)) {
    const found = configFiles(config);
    files = found.files;
    if (found.options) options = { ...found.options, noEmit: true, composite: false, incremental: false };
  }
  if (!files.length) files = ts.sys.readDirectory(repo, [".ts", ".tsx"], undefined, ["**/*"]);
  files = files.filter((f) => !f.endsWith(".d.ts") && !SKIP.test(posix(relative(repo, f))));
  const versions = new Map(files.map((f) => [f, "1"]));
  const host = {
    getScriptFileNames: () => files,
    getScriptVersion: (f) => versions.get(f) ?? "1",
    getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8")) : undefined),
    getCurrentDirectory: () => repo,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return { service, files, program: service.getProgram() };
}

/** Named functions, methods and arrow-function consts, with where their name sits. */
export function definitions(program, repo, files) {
  const out = [];
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const visit = (node) => {
      let name;
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.body) name = node.name;
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) name = node.name;
      if (name) {
        out.push({ name: name.text, file, rel: posix(relative(repo, file)), pos: name.getStart(sf), line: sf.getLineAndCharacterOfPosition(name.getStart(sf)).line + 1 });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** Every eligible definition whose name is defined once, all of them or every k-th in path order. */
export function sample(defs, n) {
  const count = new Map();
  for (const d of defs) count.set(d.name, (count.get(d.name) ?? 0) + 1);
  const unique = defs.filter((d) => count.get(d.name) === 1 && d.name.length >= 3)
    .sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  if (unique.length <= n) return unique;
  const step = unique.length / n;
  return Array.from({ length: n }, (_, i) => unique[Math.floor(i * step)]);
}

/** The key: every reference to the definition that is the callee of a call or new. */
export function compilerCallSites(service, program, repo, def) {
  const refs = service.findReferences(def.file, def.pos) ?? [];
  const sites = new Set();
  for (const group of refs) {
    for (const ref of group.references) {
      if (ref.isDefinition) continue;
      const rel = posix(relative(repo, ref.fileName));
      if (rel.startsWith("..") || SKIP.test(rel)) continue;
      const sf = program.getSourceFile(ref.fileName);
      if (!sf) continue;
      const node = findNode(sf, ref.textSpan.start);
      if (!node || !isCallee(node)) continue;
      sites.add(`${rel}:${sf.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1}`);
    }
  }
  return sites;
}

function findNode(sf, pos) {
  let found;
  const visit = (node) => {
    if (pos >= node.getStart(sf) && pos < node.getEnd()) {
      if (ts.isIdentifier(node) && node.getStart(sf) === pos) found = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sf);
  return found;
}

function isCallee(node) {
  let callee = node;
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) callee = node.parent;
  const call = callee.parent;
  return (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === callee;
}

/** Each file's lines, read once. */
function fileLines(repo, files) {
  return files.map((file) => ({ rel: posix(relative(repo, file)), lines: readFileSync(file, "utf8").split("\n") }));
}

const escape = (name) => name.replace(/[$]/gu, "\\$");

/** A line an agent would set aside by eye: a comment, the name only in a string, or a declaration of the name. */
export function setAside(text, name) {
  const t = text.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return true;
  const call = new RegExp(`(^|[^A-Za-z0-9_$])${escape(name)}\\s*\\(`, "u");
  // The name only inside a string or template literal.
  const code = t.replace(/(["'`])(?:\\.|(?!\1).)*\1/gu, "\"\"").replace(/\/\/.*$/u, "");
  if (!call.test(code)) return true;
  // A declaration: function name(, name = (, name: (, or a method `name(...) {` at the start of the line.
  const n = escape(name);
  if (new RegExp(`^(export\\s+)?(default\\s+)?(async\\s+)?function\\s*\\*?\\s*${n}\\s*[<(]`, "u").test(code)) return true;
  if (new RegExp(`^(export\\s+)?(const|let|var)\\s+${n}\\s*(:[^=]+)?=`, "u").test(code)) return true;
  if (new RegExp(`^(public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|override\\s+|readonly\\s+)*(get\\s+|set\\s+)?${n}\\s*(<[^>]*>)?\\s*\\([^)]*\\)\\s*(:[^{]*)?\\{\\s*$`, "u").test(code)) return true;
  if (new RegExp(`^${n}\\s*:\\s*(async\\s*)?(function|\\()`, "u").test(code)) return true;
  return false;
}

/** grep and careful grep: every line naming the function followed by an open parenthesis, the definition line excluded. */
export function grepCallSites(texts, def) {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${escape(def.name)}\\s*\\(`, "u");
  const grep = new Set(), careful = new Set();
  let grepTokens = 0, carefulTokens = 0;
  for (const { rel, lines } of texts) {
    lines.forEach((text, i) => {
      if (!re.test(text) || (rel === def.rel && i + 1 === def.line)) return;
      const site = `${rel}:${i + 1}`;
      const shown = tokens(`${site}:${text.trim()}\n`);
      grep.add(site);
      grepTokens += shown;
      if (!setAside(text, def.name)) { careful.add(site); carefulTokens += shown; }
    });
  }
  return { grep: { sites: grep, tokens: grepTokens }, careful: { sites: careful, tokens: carefulTokens } };
}

/**
 * MEX: the graph reader's callers, real calls only, timed. The definition is
 * named by its file, as `mex graph callers file:name` does, so a name the repo
 * defines in files the key's program leaves out still names this one. Sites
 * are scored over the files the key reads, as grep's are. Tokens are one line
 * per caller, "path:line in owner", as the CLI prints it.
 */
export function mexCallSites(binary, location, def, keyFiles) {
  const started = performance.now();
  const result = spawnSync(binary, ["--graph-read"], {
    input: JSON.stringify({ op: "callers", name: `${def.rel}:${def.name}`, checkout: location.root, project_id: location.projectId, record_directory: location.recordDirectory }),
    encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 16 << 20,
  });
  const ms = performance.now() - started;
  let answer;
  try { answer = JSON.parse(String(result.stdout).trim().split("\n").at(-1)); } catch { answer = { ok: false }; }
  const sites = new Set();
  let cost = 0;
  if (answer.ok && answer.verdict === "found" && answer.symbol?.path === def.rel) {
    for (const site of answer.sites ?? []) {
      if (site.kind !== "call" || (keyFiles && !keyFiles.has(site.path))) continue;
      sites.add(`${site.path}:${site.line}`);
      cost += tokens(`  ${site.path}:${site.line}  in ${site.owner?.name ?? site.in.name}\n`);
    }
  }
  return { sites, tokens: cost, ms, verdict: answer.ok ? answer.verdict : "error" };
}

/** Another graph database's calls into the definition (an 0.8 `.mex/graph.db`), read directly. */
export function baselineReader(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const node = db.prepare(`SELECT id, start_line FROM nodes WHERE file_path=? AND name=? AND kind IN ('function','method','variable','constant')`);
  const calls = db.prepare(`SELECT s.file_path AS path, e.line AS line FROM edges e JOIN nodes s ON s.id=e.source WHERE e.target=? AND e.kind='calls'`);
  return {
    callSites(def, keyFiles) {
      const rows = node.all(def.rel, def.name);
      if (!rows.length) return { sites: new Set(), tokens: 0, verdict: "missing" };
      const best = rows.reduce((a, b) => (Math.abs(b.start_line - def.line) < Math.abs(a.start_line - def.line) ? b : a));
      const sites = new Set();
      let cost = 0;
      for (const row of calls.all(best.id)) {
        if (row.line == null || (keyFiles && !keyFiles.has(row.path))) continue;
        sites.add(`${row.path}:${row.line}`);
        cost += tokens(`  ${row.path}:${row.line}\n`);
      }
      return { sites, tokens: cost, verdict: "found" };
    },
    close() { db.close(); },
  };
}

/** ripgrep's time to answer the same name over the repo, process start included. */
function rgMs(repo, name) {
  const started = performance.now();
  spawnSync("rg", ["-n", "--no-heading", "-g", "*.ts", "-g", "*.tsx", "-e", `\\b${name}\\s*\\(`, "."], { cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 });
  return performance.now() - started;
}

export function score(key, got) {
  let hit = 0;
  for (const s of got) if (key.has(s)) hit++;
  const precision = got.size ? hit / got.size : key.size ? 0 : 1;
  const recall = key.size ? hit / key.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { hit, predicted: got.size, expected: key.size, precision, recall, f1 };
}

function micro(rows) {
  const t = rows.reduce((a, r) => ({ hit: a.hit + r.hit, predicted: a.predicted + r.predicted, expected: a.expected + r.expected }), { hit: 0, predicted: 0, expected: 0 });
  const precision = t.predicted ? t.hit / t.predicted : 1;
  const recall = t.expected ? t.hit / t.expected : 1;
  return { ...t, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function percentile(xs, p) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** A seeded generator, so the intervals are the same on every run. */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% bootstrap interval of a statistic over definitions. */
function interval(rows, stat) {
  if (!rows.length) return [0, 0];
  const random = mulberry32(20261121);
  const values = [];
  for (let b = 0; b < BOOTSTRAP; b++) {
    const pick = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    values.push(stat(pick));
  }
  return [percentile(values, 2.5), percentile(values, 97.5)];
}

function summarize(rows, arm) {
  const scored = rows.map((r) => r[arm]).filter(Boolean);
  if (!scored.length) return undefined;
  return {
    ...micro(scored),
    microF1Interval: interval(scored, (pick) => micro(pick).f1),
    macroF1: mean(scored.map((s) => s.f1)),
    macroF1Interval: interval(scored, (pick) => mean(pick.map((s) => s.f1))),
    tokens: scored.reduce((a, s) => a + s.tokens, 0),
    tokensPerCallee: mean(scored.map((s) => s.tokens)),
  };
}

function cli(repo, ...args) {
  const r = spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), ...args], { cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20, timeout: 1_800_000 });
  if (r.status !== 0) throw new Error(`mex ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

function hookBinary(explicit) {
  if (explicit) return explicit;
  const exe = process.platform === "win32" ? ".exe" : "";
  const out = join(ROOT, "test-results", "graph-bench", `mex-hook${exe}`);
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync("go", ["build", "-o", out, "./cmd/mex-hook"], { cwd: join(ROOT, "native"), env: { ...process.env, CGO_ENABLED: "0" }, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`go build failed: ${r.stderr}`);
  return out;
}

export async function run(args) {
  const { graphLocation } = await import(pathToFileURL(join(ROOT, "dist", "graph-storage.js")).href);
  if (args.build) {
    cli(args.repo, "graph", "--root", args.repo, "--json");
    cli(args.repo, "index", "--json");
  }
  const binary = hookBinary(args.binary);
  const location = graphLocation(args.repo);
  const { service, files, program } = loadProgram(args.repo);
  const picked = sample(definitions(program, args.repo, files), args.sample);
  const keyFiles = new Set(files.map((f) => posix(relative(args.repo, f))));
  const texts = fileLines(args.repo, files);
  const baseline = args.baselineDb ? baselineReader(args.baselineDb) : undefined;
  const rows = [];
  const rg = [];
  try {
    for (const def of picked) {
      const key = compilerCallSites(service, program, args.repo, def);
      const mex = mexCallSites(binary, location, def, keyFiles);
      const { grep, careful } = grepCallSites(texts, def);
      const row = { name: def.name, file: def.rel, line: def.line, verdict: mex.verdict, ms: Math.round(mex.ms * 10) / 10,
        mex: { ...score(key, mex.sites), tokens: mex.tokens },
        grep: { ...score(key, grep.sites), tokens: grep.tokens },
        careful: { ...score(key, careful.sites), tokens: careful.tokens } };
      if (baseline) {
        const b = baseline.callSites(def, keyFiles);
        row.baseline = { ...score(key, b.sites), tokens: b.tokens };
      }
      if (args.rg && rg.length < RG_SAMPLE) rg.push(rgMs(args.repo, def.name));
      rows.push(row);
    }
  } finally { baseline?.close(); }
  const latency = rows.map((r) => r.ms);
  const report = {
    repo: posix(args.repo), at: new Date().toISOString(), sample: rows.length, files: files.length,
    key: `typescript ${ts.version} language service`,
    arms: Object.fromEntries(["mex", "baseline", "careful", "grep"].map((arm) => [arm, summarize(rows, arm)]).filter(([, s]) => s)),
    latencyMs: { p50: percentile(latency, 50), p95: percentile(latency, 95), max: Math.max(0, ...latency) },
    ...(rg.length ? { rgMs: { p50: percentile(rg, 50), p95: percentile(rg, 95) } } : {}),
    verdicts: rows.reduce((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] ?? 0) + 1 }), {}),
    macroF1GainOverCareful: interval(rows, (pick) => mean(pick.map((r) => r.mex.f1 - r.careful.f1))),
    rows,
  };
  // Kept for readers of the earlier report shape.
  report.mex = report.arms.mex;
  report.grep = report.arms.grep;
  // An empty sample proves nothing: it never passes.
  report.pass = rows.length > 0 && report.arms.mex.f1 >= report.arms.careful.f1 && report.arms.mex.precision >= report.arms.careful.precision;
  return report;
}

function table(report) {
  const f = (x) => x.toFixed(3);
  const ci = ([a, b]) => `[${f(a)}, ${f(b)}]`;
  const lines = [
    `Call graph on ${report.repo}: ${report.sample} callees in ${report.files} files, key: ${report.key}`,
    "arm       precision  recall  F1 (95% CI)              macro-F1 (95% CI)        sites  tokens/callee",
  ];
  for (const [arm, s] of Object.entries(report.arms)) {
    lines.push(`${arm.padEnd(9)} ${f(s.precision)}      ${f(s.recall)}   ${f(s.f1)} ${ci(s.microF1Interval)}  ${f(s.macroF1)} ${ci(s.macroF1Interval)}  ${String(s.predicted).padStart(5)}  ${s.tokensPerCallee.toFixed(1)}`);
  }
  lines.push(`MEX macro-F1 gain over careful grep: ${ci(report.macroF1GainOverCareful)} (95% CI)`);
  lines.push(`read latency (process start included): MEX p50 ${report.latencyMs.p50.toFixed(0)} ms, p95 ${report.latencyMs.p95.toFixed(0)} ms`
    + (report.rgMs ? `; ripgrep p50 ${report.rgMs.p50.toFixed(0)} ms, p95 ${report.rgMs.p95.toFixed(0)} ms` : ""));
  lines.push(`verdicts: ${JSON.stringify(report.verdicts)}`);
  lines.push(report.pass ? "PASS: MEX F1 and precision at least careful grep's" : "FAIL: MEX below careful grep");
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const report = await run(args);
  console.log(table(report));
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.gate && !report.pass) process.exitCode = 1;
}
