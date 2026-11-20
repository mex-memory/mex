#!/usr/bin/env node
// The compiler-graded call-graph benchmark, with read latency.
//
//   node scripts/graph-bench/callgraph.mjs --repo <TypeScript checkout>
//        [--binary <mex-hook>] [--sample 100] [--out <report.json>] [--no-build] [--gate]
//
// For a sample of functions and methods whose names are defined once, the
// TypeScript compiler's language service (typescript 5.9, not the tsrs build
// MEX extracts with) gives the answer key: every call site, as file:line. Two
// arms answer "who calls X?":
//
//   mex   `mex-hook --graph-read` callers, real calls only (values excluded,
//         as the key counts calls); each read is timed, process start included.
//   grep  every line matching `\bX\s*(`, the definition line excluded: what an
//         agent's search returns before it reads anything.
//
// Scored per call site: precision, recall, F1, micro over the sample and per
// callee on average. With --gate it exits 1 unless MEX's F1 and precision are
// at least grep's. Deterministic: the sample is every k-th eligible definition
// in path order. No network, no model.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.git|\.mex)(\/|$)/u;

export function parseArgs(argv) {
  const args = { repo: ROOT, sample: 100, build: true, gate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = resolve(argv[++i]);
    else if (a === "--binary") args.binary = resolve(argv[++i]);
    else if (a === "--sample") args.sample = Number(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--no-build") args.build = false;
    else if (a === "--gate") args.gate = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.sample) || args.sample < 1) throw new Error("--sample must be a positive integer");
  return args;
}

const posix = (p) => p.split(sep).join("/");

/** The compiler's program for the repo: its tsconfig, or every .ts/.tsx file. */
export function loadProgram(repo) {
  const config = ts.findConfigFile(repo, ts.sys.fileExists, "tsconfig.json");
  let files, options = { allowJs: false, noEmit: true };
  if (config && posix(dirname(config)) === posix(repo)) {
    const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config, ts.sys, repo);
    files = parsed.fileNames;
    options = { ...parsed.options, noEmit: true };
  } else {
    files = ts.sys.readDirectory(repo, [".ts", ".tsx"], undefined, ["**/*"]);
  }
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

/** Every eligible definition whose name is defined once, sampled every k-th in path order. */
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

/** grep: every line naming the function followed by an open parenthesis, the definition line excluded. */
export function grepCallSites(repo, files, def) {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${def.name.replace(/\$/gu, "\\$")}\\s*\\(`, "u");
  const sites = new Set();
  for (const file of files) {
    const rel = posix(relative(repo, file));
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (re.test(text) && !(rel === def.rel && i + 1 === def.line)) sites.add(`${rel}:${i + 1}`);
    });
  }
  return sites;
}

/** MEX: the graph reader's callers, real calls only, timed. */
export function mexCallSites(binary, location, def) {
  const started = performance.now();
  const result = spawnSync(binary, ["--graph-read"], {
    input: JSON.stringify({ op: "callers", name: def.name, checkout: location.root, project_id: location.projectId, record_directory: location.recordDirectory }),
    encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 16 << 20,
  });
  const ms = performance.now() - started;
  let answer;
  try { answer = JSON.parse(String(result.stdout).trim().split("\n").at(-1)); } catch { answer = { ok: false }; }
  const sites = new Set();
  if (answer.ok && answer.verdict === "found" && answer.symbol?.path === def.rel) {
    for (const site of answer.sites ?? []) if (site.kind === "call") sites.add(`${site.path}:${site.line}`);
  }
  return { sites, ms, verdict: answer.ok ? answer.verdict : "error" };
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
  const rows = [];
  for (const def of picked) {
    const key = compilerCallSites(service, program, args.repo, def);
    const mex = mexCallSites(binary, location, def);
    const grep = grepCallSites(args.repo, files, def);
    rows.push({ name: def.name, file: def.rel, line: def.line, verdict: mex.verdict, ms: Math.round(mex.ms * 10) / 10,
      mex: score(key, mex.sites), grep: score(key, grep) });
  }
  const latency = rows.map((r) => r.ms);
  const report = {
    repo: posix(args.repo), at: new Date().toISOString(), sample: rows.length, files: files.length,
    key: `typescript ${ts.version} language service`,
    mex: { ...micro(rows.map((r) => r.mex)), macroF1: mean(rows.map((r) => r.mex.f1)) },
    grep: { ...micro(rows.map((r) => r.grep)), macroF1: mean(rows.map((r) => r.grep.f1)) },
    latencyMs: { p50: percentile(latency, 50), p95: percentile(latency, 95), max: Math.max(0, ...latency) },
    verdicts: rows.reduce((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] ?? 0) + 1 }), {}),
    rows,
  };
  report.pass = report.mex.f1 >= report.grep.f1 && report.mex.precision >= report.grep.precision;
  return report;
}

function table(report) {
  const f = (x) => x.toFixed(3);
  return [
    `Call graph on ${report.repo}: ${report.sample} callees, key: ${report.key}`,
    "arm   precision  recall  F1     macro-F1  sites",
    `mex   ${f(report.mex.precision)}      ${f(report.mex.recall)}   ${f(report.mex.f1)}  ${f(report.mex.macroF1)}     ${report.mex.predicted}`,
    `grep  ${f(report.grep.precision)}      ${f(report.grep.recall)}   ${f(report.grep.f1)}  ${f(report.grep.macroF1)}     ${report.grep.predicted}`,
    `read latency (process start included): p50 ${report.latencyMs.p50.toFixed(0)} ms, p95 ${report.latencyMs.p95.toFixed(0)} ms`,
    `verdicts: ${JSON.stringify(report.verdicts)}`,
    report.pass ? "PASS: MEX F1 and precision at least grep's" : "FAIL: MEX below grep",
  ].join("\n");
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
