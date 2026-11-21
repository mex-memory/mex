#!/usr/bin/env node
// Call-resolution accuracy of a MEX graph, judged by a compiler-precise SCIP
// index (scip-typescript / scip-python). OSS-73, milestone M0.
//
// usage: node accuracy.mjs <repo-root> <graph.db> <scip.json>
//
// Adapted from the mex-platform bench (packages/codegraph/bench/accuracy.mjs),
// with one change: the judge, not the graph, defines the call sites. Recall is
// therefore comparable across tools that extract different call sites.
//
// Call sites (the recall universe): every SCIP reference occurrence written in
// callee position (`name(`, `name<T>(`, `name?.(`, a tagged template) whose
// symbol the judge defines in the repository at a function, method or class
// declaration. Only ASCII lines are used, so UTF-16 (SCIP) and UTF-8 (graph)
// columns coincide.
//
// A graph edge (calls or instantiates) sits at a call site when its line and
// column equal the occurrence's: MEX edges carry the 1-based line and the
// 0-based column of the callee name. It is correct when its target node lies
// in the judge's definition file, spans the definition line and carries the
// definition's name (a class and its constructor name the same target).
//
// Precision covers every edge the judge can place: an edge at an occurrence
// whose definition is a declaration elsewhere, a parameter or local, or outside
// the repository counts as wrong. Judge verdicts whose definition does not
// carry the called name (scip-python's star-import mix-ups) and symbols the
// judge defines twice are skipped and counted, as in the platform bench.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [repoRoot, graphDb, scipPath] = process.argv.slice(2);
const scip = JSON.parse(readFileSync(scipPath, "utf8"));

const sql = (q) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", `file:${graphDb}?immutable=1`, q], { encoding: "utf8", maxBuffer: 1 << 30 }) || "[]");

function loadV4() {
  const nodes = sql("SELECT id, kind, name, file_path AS file, start_line AS sl, end_line AS el, container_id AS parent FROM nodes WHERE kind <> 'file'");
  const edges = sql("SELECT e.kind, e.line, e.col, e.target, s.file_path AS file FROM edges e JOIN nodes s ON s.id = e.source WHERE e.kind IN ('calls','instantiates') AND e.line IS NOT NULL AND e.col IS NOT NULL");
  return { nodes, edges };
}

function loadV5() {
  const nodes = sql(`
    SELECT n.id, k.name AS kind, n.name, f.path AS file, n.start_line AS sl, n.end_line AS el, n.parent
    FROM nodes n JOIN node_kinds k ON k.id = n.kind JOIN files f ON f.id = n.file
    WHERE k.name <> 'file'
  `);
  // V5 uses line 0 for an edge without a call site.
  const edges = sql(`
    SELECT k.name AS kind, e.line, e.col, e.target, f.path AS file
    FROM edges e JOIN edge_kinds k ON k.id = e.kind
      JOIN nodes s ON s.id = e.source JOIN files f ON f.id = s.file
    WHERE k.name IN ('calls','instantiates') AND e.line > 0
  `);
  return { nodes, edges };
}

const hasMeta = sql("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta'").length > 0;
const isV5 = hasMeta && sql("SELECT 1 FROM meta WHERE key = 'schema_version' AND value = '5'").length > 0;
const { nodes: rows, edges } = isV5 ? loadV5() : loadV4();
const nodes = new Map(rows.map((n) => [n.id, n]));
const nodesByFile = new Map();
for (const n of rows) {
  if (!nodesByFile.has(n.file)) nodesByFile.set(n.file, []);
  nodesByFile.get(n.file).push(n);
}

const lines = new Map();
const fileLines = (rel) => {
  if (!lines.has(rel)) {
    try { lines.set(rel, readFileSync(path.join(repoRoot, rel), "utf8").split("\n")); } catch { lines.set(rel, null); }
  }
  return lines.get(rel);
};
const isAscii = (s) => !/[^\x00-\x7f]/.test(s);
const lastSegment = (name) => String(name).split(/[.:]/).filter(Boolean).pop();

// SCIP definitions and reference occurrences.
const definitionOf = new Map();
const collided = new Set();
const references = [];
const symbolKey = (doc, symbol) => (symbol.startsWith("local ") ? `${doc}\0${symbol}` : symbol);
for (const doc of scip.documents ?? []) {
  const rel = (doc.relative_path ?? doc.relativePath).replaceAll("\\", "/");
  for (const occ of doc.occurrences ?? []) {
    const r = occ.range;
    const [line, start, endLine, end] = r.length === 3 ? [r[0], r[1], r[0], r[2]] : r;
    if (line !== endLine) continue;
    const roles = occ.symbol_roles ?? occ.symbolRoles ?? 0;
    const key = symbolKey(rel, occ.symbol);
    if (roles & 1) {
      const known = definitionOf.get(key);
      if (known && (known.path !== rel || known.line !== line || known.col !== start)) collided.add(key);
      else definitionOf.set(key, { path: rel, line, col: start, end });
    } else {
      references.push({ path: rel, line, col: start, end, key, symbol: occ.symbol });
    }
  }
}

const calleePosition = /^\s*(?:<[^()]*>\s*)?(?:\?\.\s*)?[(`]/;
// A callable, by the judge's own symbol kinds: a global function or method
// (`().` suffix) or a type (`#`, a class when it is called or constructed).
// Locals, parameters and properties are bindings, not call-site targets.
const callable = (symbol, def) => {
  if (symbol.startsWith("local ")) return false;
  if (/\(\)\.$/.test(symbol)) return true;
  // A type is a call target only when it is a class: interfaces and aliases are not.
  const text = /#$/.test(symbol) && fileLines(def.path)?.[def.line];
  return Boolean(text && /\bclass\s+$/.test(text.slice(0, def.col)));
};
// A member declared on an interface or type alias: dispatch through a type, not a body.
const interfaceMember = (symbol) => {
  const owner = symbol.match(/^(.*#)[^#]*\(\)\.$/)?.[1];
  const def = owner && definitionOf.get(owner);
  const text = def && fileLines(def.path)?.[def.line];
  return Boolean(text && /\b(interface|type)\s+$/.test(text.slice(0, def.col)));
};

/** The judge's verdict for one reference occurrence. */
function verdict(ref) {
  const text = fileLines(ref.path)?.[ref.line];
  if (text === undefined || text === null || !isAscii(text)) return { kind: "non_ascii" };
  const name = text.slice(ref.col, ref.end);
  if (collided.has(ref.key)) return { kind: "judge_ambiguous", name };
  const def = definitionOf.get(ref.key);
  if (!def) return { kind: ref.symbol.startsWith("local ") ? "no_definition" : "outside_view", name };
  const defText = fileLines(def.path)?.[def.line];
  const defName = defText?.slice(def.col, def.end);
  if (defName !== name && defName !== "constructor" && defName !== "__init__") return { kind: "judge_inconsistent", name, defName };
  if (!callable(ref.symbol, def)) return { kind: "not_a_declaration", name, def, defName };
  return { kind: "declaration", name, def, defName, viaInterface: interfaceMember(ref.symbol) };
}

/** Does graph node `id` name the judge's definition? */
function matches(id, v) {
  const n = nodes.get(id);
  if (!n) return false;
  const line = v.def.line + 1;
  const spans = (m) => m.file === v.def.path && m.sl <= line && line <= m.el;
  if (spans(n) && lastSegment(n.name) === v.defName) return true;
  // An overload set is one target: the judges name its first signature
  // (`@overload` stubs, TypeScript overload lists), while a graph may name
  // the implementation. Same file, same container, same name.
  if (lastSegment(n.name) === v.defName && n.file === v.def.path) {
    const judged = (nodesByFile.get(n.file) ?? []).find((m) => spans(m) && lastSegment(m.name) === v.defName);
    if (judged && judged.parent === n.parent && judged.kind === n.kind) return true;
  }
  // A class and its constructor name the same target, either way round.
  if (v.defName === "constructor" || v.defName === "__init__") return n.kind === "class" && spans(n);
  return false;
}

const edgesAt = new Map();
for (const e of edges) {
  const k = `${e.file}:${e.line - 1}:${e.col}`;
  if (!edgesAt.has(k)) edgesAt.set(k, []);
  edgesAt.get(k).push(e);
}

const t = { sites: 0, found: 0, interface_sites: 0, interface_found: 0, correct_binding: 0, site_missing_edge: 0, site_wrong_target: 0, edges_total: edges.length, edges_judged: 0, correct: 0, wrong_declaration: 0, wrong_outside: 0, wrong_local: 0, unjudged: 0, judge_ambiguous: 0, judge_inconsistent: 0, non_ascii: 0 };
const samples = { missing: [], wrong: [] };
const judgedEdges = new Set();

// Group the judge's occurrences by position: SCIP can record several symbols
// at one range (a property and the local it aliases). Each edge and each call
// site is judged once; the site is a declaration when any of its symbols is.
const byPosition = new Map();
for (const ref of references) {
  const text = fileLines(ref.path)?.[ref.line];
  if (!text || !calleePosition.test(text.slice(ref.end))) continue;
  const k = `${ref.path}:${ref.line}:${ref.col}`;
  if (!byPosition.has(k)) byPosition.set(k, { ref, verdicts: [] });
  byPosition.get(k).verdicts.push(verdict(ref));
}

// Some extractors put a member call at the start of the expression (`apps` in
// `apps.populate()`), not at the called name. An edge with no occurrence at its
// own position moves to the call site on its line that calls its target's name,
// when exactly one does.
{
  const sitesOnLine = new Map();
  for (const [k, entry] of byPosition) {
    const lk = `${entry.ref.path}\0${entry.ref.line}\0${entry.verdicts[0]?.name ?? ""}`;
    if (!sitesOnLine.has(lk)) sitesOnLine.set(lk, []);
    sitesOnLine.get(lk).push(k);
  }
  for (const [k, list] of [...edgesAt]) {
    if (byPosition.has(k)) continue;
    const { file, line } = list[0];
    for (const e of [...list]) {
      const candidates = sitesOnLine.get(`${file}\0${line - 1}\0${lastSegment(nodes.get(e.target)?.name)}`) ?? [];
      if (candidates.length !== 1) continue;
      edgesAt.set(candidates[0], [...(edgesAt.get(candidates[0]) ?? []), e]);
      edgesAt.set(k, edgesAt.get(k).filter((x) => x !== e));
    }
  }
}
// Verdicts the judge can't stand behind: skipped and counted, never scored.
const SKIP = ["judge_ambiguous", "judge_inconsistent", "non_ascii", "no_definition"];
for (const [k, { ref, verdicts }] of byPosition) {
  const here = edgesAt.get(k) ?? [];
  for (const e of here) judgedEdges.add(e);
  const decls = verdicts.filter((v) => v.kind === "declaration");
  const bindings = verdicts.filter((v) => v.kind === "not_a_declaration");
  const outside = verdicts.some((v) => v.kind === "outside_view");
  if (!decls.length && !bindings.length && !outside) {
    const skip = SKIP.find((kind) => verdicts.some((v) => v.kind === kind));
    if (skip) t[skip] = (t[skip] ?? 0) + 1;
    continue;
  }
  // Precision for edges at this position.
  for (const e of here) {
    t.edges_judged++;
    if (decls.some((v) => matches(e.target, v))) t.correct++;
    // The target is the binding the judge defines (an alias, a variable holding a function).
    else if (bindings.some((v) => matches(e.target, v))) t.correct_binding++;
    else if (decls.length) { t.wrong_declaration++; if (samples.wrong.length < 15) samples.wrong.push(`${ref.path}:${ref.line + 1}:${ref.col} ${decls[0].name} -> ${nodes.get(e.target)?.file}:${nodes.get(e.target)?.name} (judge ${decls[0].def.path}:${decls[0].def.line + 1})`); }
    else if (bindings.length) { t.wrong_local++; if (samples.wrong.length < 15) samples.wrong.push(`${ref.path}:${ref.line + 1}:${ref.col} ${bindings[0].name} -> ${nodes.get(e.target)?.file}:${nodes.get(e.target)?.name} (judge: a local or variable at ${bindings[0].def.path}:${bindings[0].def.line + 1})`); }
    else { t.wrong_outside++; if (samples.wrong.length < 15) samples.wrong.push(`${ref.path}:${ref.line + 1}:${ref.col} ${verdicts[0].name} -> ${nodes.get(e.target)?.file}:${nodes.get(e.target)?.name} (judge: outside the repository)`); }
  }
  if (!decls.length) continue;
  t.sites++;
  const viaInterface = decls.every((v) => v.viaInterface);
  if (viaInterface) t.interface_sites++;
  if (here.some((e) => decls.some((v) => matches(e.target, v)))) { t.found++; if (viaInterface) t.interface_found++; }
  else if (here.length) t.site_wrong_target++;
  else { t.site_missing_edge++; if (samples.missing.length < 15) samples.missing.push(`${ref.path}:${ref.line + 1}:${ref.col} ${decls[0].name} (judge ${decls[0].def.path}:${decls[0].def.line + 1})`); }
}
t.unjudged = edges.length - judgedEdges.size;

const wrong = t.wrong_declaration + t.wrong_outside + t.wrong_local;
console.log(JSON.stringify({
  precision: t.edges_judged ? +((t.correct + t.correct_binding) / t.edges_judged).toFixed(4) : null,
  recall: t.sites ? +(t.found / t.sites).toFixed(4) : null,
  recall_concrete: t.sites - t.interface_sites ? +((t.found - t.interface_found) / (t.sites - t.interface_sites)).toFixed(4) : null,
  ...t, wrong, samples,
}, null, 2));
