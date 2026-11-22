#!/usr/bin/env node
// Node parity between today's graph and the Rust engine's facts (OSS-73).
//
// usage: node parity.mjs <repo-root> <today's graph.db> <mex-graph binary> [language]
//
// Compare extractor output by id for the files today's graph indexed.
// Signatures and return types are display text for the compiler languages,
// where today's route can use the type checker. Report their agreement separately.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const [root, graphDb, engine, language = "python"] = process.argv.slice(2);
const compiler = ["typescript", "tsx", "javascript", "jsx"].includes(language);
if (!root || !graphDb || !engine || (!compiler && language !== "python")) {
  console.error("usage: node parity.mjs <repo-root> <graph.db> <mex-graph> [python|typescript|tsx|javascript|jsx]");
  process.exit(2);
}
const sql = (q) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", `file:${graphDb}?immutable=1`, q], { encoding: "utf8", maxBuffer: 1 << 30 }) || "[]");

const files = sql(`SELECT path FROM files WHERE language = '${language}' ORDER BY path`).map((r) => r.path);
const today = new Map(sql(`SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.start_line, n.end_line, n.start_column, n.end_column,
    n.signature, n.docstring, n.body_hash, n.return_type, n.is_async, n.is_exported,
    n.container_id, n.visibility, n.decorators, n.type_parameters, n.is_static, n.is_abstract,
    hex(f.minhash) AS minhash, f.token_count
  FROM nodes n LEFT JOIN node_fingerprints f ON f.node_id = n.id
  WHERE n.language = '${language}' AND n.kind != 'route' AND instr(n.identity_key, char(0) || 'framework:') = 0`).map((n) => [n.id, n]));

const dir = mkdtempSync(join(tmpdir(), "mex-parity-"));
const list = join(dir, "files.txt");
let out;
let extractionMs;
try {
  writeFileSync(list, files.join("\n"));
  const start = performance.now();
  out = execFileSync(engine, ["facts", "--root", root, "--files-from", list], { encoding: "utf8", maxBuffer: 1 << 30 });
  extractionMs = Math.round(performance.now() - start);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const engineNodes = new Map();
const parsedFiles = new Set();
const parseIssues = [];
for (const line of out.split("\n")) {
  if (!line) continue;
  const n = JSON.parse(line);
  if (n.summary) {
    parsedFiles.add(n.path);
    if (n.status !== "ok") parseIssues.push({ path: n.path, status: n.status });
  } else {
    if (engineNodes.has(n.id)) throw new Error(`duplicate engine node ${n.id} in ${n.path}`);
    engineNodes.set(n.id, n);
  }
}
for (const path of files) {
  if (!parsedFiles.has(path)) throw new Error(`missing engine facts summary for ${path}`);
}

const minhashHex = (values) => values?.map((v) => v.toString(16).padStart(8, "0")).join("").toUpperCase() ?? null;
const arrayText = (json) => JSON.stringify(json ? JSON.parse(json) : []);
const fields = {
  kind: (t, e) => [t.kind, e.kind],
  name: (t, e) => [t.name, e.name],
  qualifiedName: (t, e) => [t.qualified_name, e.qualifiedName],
  path: (t, e) => [t.file_path, e.path],
  span: (t, e) => [`${t.start_line}:${t.start_column}-${t.end_line}:${t.end_column}`, `${e.startLine}:${e.startColumn}-${e.endLine}:${e.endColumn}`],
  docstring: (t, e) => [t.docstring ?? null, e.docstring ?? null],
  bodyHash: (t, e) => [t.body_hash ?? null, e.bodyHash ?? null],
  async: (t, e) => [Boolean(t.is_async), Boolean(e.async)],
  exported: (t, e) => [Boolean(t.is_exported), Boolean(e.exported)],
  // hex(NULL) is "" in SQLite: no fingerprint row.
  minhash: (t, e) => [t.minhash || null, minhashHex(e.minhash)],
  tokenCount: (t, e) => [t.token_count ?? null, e.tokenCount ?? null],
};
const displayFields = {
  signature: (t, e) => [t.signature ?? null, e.signature ?? null],
  returnType: (t, e) => [t.return_type ?? null, e.returnType ?? null],
};
if (compiler) {
  Object.assign(fields, {
    containerId: (t, e) => [t.container_id ?? null, e.containerId ?? null],
    static: (t, e) => [Boolean(t.is_static), Boolean(e.static)],
    abstract: (t, e) => [Boolean(t.is_abstract), Boolean(e.abstract)],
    visibility: (t, e) => [t.visibility ?? null, e.visibility ?? null],
    decorators: (t, e) => [arrayText(t.decorators), JSON.stringify(e.decorators ?? [])],
    typeParameters: (t, e) => [arrayText(t.type_parameters), JSON.stringify(e.typeParameters ?? [])],
  });
} else {
  Object.assign(fields, displayFields);
}

const comparators = Object.entries({ ...fields, ...displayFields });
const results = Object.fromEntries(comparators.map(([field]) => [field, { count: 0, samples: [] }]));
let matched = 0;
const missing = [];
const extra = [];
const show = (value) => typeof value === "string" ? value.slice(0, 240) : value;
for (const [id, t] of today) {
  const e = engineNodes.get(id);
  if (!e) {
    missing.push(`${t.file_path}:${t.start_line} ${t.kind} ${t.qualified_name}`);
    continue;
  }
  matched++;
  for (const [field, compare] of comparators) {
    const [a, b] = compare(t, e);
    if (a === b) continue;
    const result = results[field];
    result.count++;
    if (result.samples.length < 5) {
      result.samples.push({ at: `${t.file_path}:${t.start_line} ${t.qualified_name}`, today: show(a), engine: show(b) });
    }
  }
}
for (const [id, e] of engineNodes) {
  if (!today.has(id)) extra.push(`${e.path}:${e.startLine} ${e.kind} ${e.qualifiedName}`);
}

const diffs = Object.fromEntries(Object.keys(fields).map((name) => [name, results[name]]));
const fieldDifferences = Object.values(diffs).reduce((sum, result) => sum + result.count, 0);
const exact = missing.length === 0 && extra.length === 0 && fieldDifferences === 0;
const notGated = compiler ? Object.fromEntries(Object.keys(displayFields).map((field) => {
  const result = results[field];
  const agreed = matched - result.count;
  return [field, { agreed, compared: matched, agreement: matched ? agreed / matched : null, ...result }];
})) : undefined;
console.log(JSON.stringify({
  language, files: files.length, extractionMs, todayNodes: today.size, engineNodes: engineNodes.size, matched,
  missing: missing.length, extra: extra.length, fieldDifferences, exact,
  missingSamples: missing.slice(0, 10), extraSamples: extra.slice(0, 10), parseIssues, diffs, notGated,
}, null, 2));
if (!exact) process.exitCode = 1;
