#!/usr/bin/env node
// Node parity between today's graph and the Rust engine's facts (OSS-73).
//
// usage: node parity.mjs <repo-root> <today's graph.db> <mex-graph binary> [language]
//
// For every file of the language today's graph indexed, compares today's
// extractor nodes (framework-resolver nodes left out) with the nodes
// `mex-graph facts` prints, by id: kind, names, span, signature, docstring,
// body hash, return type, flags, and the stored sketch (minhash and token
// count). Grounded anchors depend on all of these, so the gate is zero
// differences. Prints a JSON summary with samples of each difference.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [root, graphDb, engine, language = "python"] = process.argv.slice(2);
const sql = (q) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", `file:${graphDb}?immutable=1`, q], { encoding: "utf8", maxBuffer: 1 << 30 }) || "[]");

const files = sql(`SELECT path FROM files WHERE language = '${language}' ORDER BY path`).map((r) => r.path);
const today = new Map();
for (const n of sql(`SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.start_line, n.end_line, n.start_column, n.end_column,
    n.signature, n.docstring, n.body_hash, n.return_type, n.is_async, n.is_exported, n.identity_key,
    hex(f.minhash) AS minhash, f.token_count
  FROM nodes n LEFT JOIN node_fingerprints f ON f.node_id = n.id
  WHERE n.language = '${language}'`)) {
  // Framework resolvers add route nodes; they aren't extractor output.
  if (n.kind === "route" || n.identity_key.includes("\u0000framework:")) continue;
  today.set(n.id, n);
}

const dir = mkdtempSync(join(tmpdir(), "mex-parity-"));
const list = join(dir, "files.txt");
writeFileSync(list, files.join("\n"));
const out = execFileSync(engine, ["facts", "--root", root, "--files-from", list], { encoding: "utf8", maxBuffer: 1 << 30 });
rmSync(dir, { recursive: true, force: true });
const engineNodes = new Map();
for (const line of out.split("\n")) {
  if (!line) continue;
  const n = JSON.parse(line);
  if (!n.summary) engineNodes.set(n.id, n);
}

const minhashHex = (values) => values?.map((v) => v.toString(16).padStart(8, "0")).join("").toUpperCase() ?? null;
const FIELDS = {
  kind: (t, e) => [t.kind, e.kind],
  name: (t, e) => [t.name, e.name],
  qualifiedName: (t, e) => [t.qualified_name, e.qualifiedName],
  path: (t, e) => [t.file_path, e.path],
  span: (t, e) => [`${t.start_line}:${t.start_column}-${t.end_line}:${t.end_column}`, `${e.startLine}:${e.startColumn}-${e.endLine}:${e.endColumn}`],
  signature: (t, e) => [t.signature ?? null, e.signature ?? null],
  docstring: (t, e) => [t.docstring ?? null, e.docstring ?? null],
  bodyHash: (t, e) => [t.body_hash ?? null, e.bodyHash ?? null],
  returnType: (t, e) => [t.return_type ?? null, e.returnType ?? null],
  async: (t, e) => [Boolean(t.is_async), Boolean(e.async)],
  exported: (t, e) => [Boolean(t.is_exported), Boolean(e.exported)],
  // hex(NULL) is "" in SQLite: no fingerprint row.
  minhash: (t, e) => [t.minhash || null, minhashHex(e.minhash)],
  tokenCount: (t, e) => [t.token_count ?? null, e.tokenCount ?? null],
};
const diffs = Object.fromEntries(Object.keys(FIELDS).map((f) => [f, { count: 0, samples: [] }]));
let matched = 0;
const missing = []; const extra = [];
for (const [id, t] of today) {
  const e = engineNodes.get(id);
  if (!e) { missing.push(`${t.file_path}:${t.start_line} ${t.kind} ${t.qualified_name}`); continue; }
  matched++;
  for (const [field, get] of Object.entries(FIELDS)) {
    const [a, b] = get(t, e);
    if (a !== b) {
      diffs[field].count++;
      if (diffs[field].samples.length < 5) diffs[field].samples.push({ at: `${t.file_path}:${t.start_line} ${t.qualified_name}`, today: typeof a === "string" ? a.slice(0, 120) : a, engine: typeof b === "string" ? b.slice(0, 120) : b });
    }
  }
}
for (const [id, e] of engineNodes) if (!today.has(id)) extra.push(`${e.path}:${e.startLine} ${e.kind} ${e.qualifiedName}`);

const differing = Object.values(diffs).reduce((n, d) => n + d.count, 0);
console.log(JSON.stringify({
  language, files: files.length, todayNodes: today.size, engineNodes: engineNodes.size, matched,
  missing: missing.length, extra: extra.length, fieldDifferences: differing,
  exact: missing.length === 0 && extra.length === 0 && differing === 0,
  missingSamples: missing.slice(0, 10), extraSamples: extra.slice(0, 10),
  diffs: Object.fromEntries(Object.entries(diffs).filter(([, d]) => d.count)),
}, null, 2));
