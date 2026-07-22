import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createGraphEngine } from "./engine-impl.js";
import type { GraphEngine } from "./engine.js";
import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import type { GraphNode } from "./types.js";
import {
  compactFact, groupByFile, readNodeSource, selectScope,
  type CompactFact, type DetailLevel, type SourceRange,
} from "./scope.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { serializeFingerprint } from "./fingerprint.js";
import { BudgetLedger, estimateTokens, resolveOptions, SCHEMA_VERSION, type AgentOptions } from "./agent-protocol.js";

type QueryRelation = "who-calls" | "what-calls" | "where-defined";

interface AgentGraphSession {
  graph: GraphEngine;
  db: SqliteDatabase;
  close(): void;
}

export interface AgentCommandDeps {
  open?: (rootDir: string) => AgentGraphSession;
  write?: (line: string) => void;
}

type RawOptions = Partial<Record<keyof AgentOptions, unknown>>;
type Rec = Record<string, unknown>;

/** Agent-facing blast radius. Output is newline-delimited JSON (JSONL). */
export function runImpact(
  target: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const fileNodes = nodesForFile(session, rootDir, target);
    const roots = fileNodes.length > 0 ? fileNodes : resolveSymbol(session.graph, target);
    if (roots.length === 0) {
      writeJson(write, { type: "error", code: "TARGET_NOT_FOUND", target });
      return;
    }
    if (fileNodes.length === 0 && roots.length > 1) {
      writeJson(write, { type: "error", code: "TARGET_AMBIGUOUS", target, candidates: roots.map(nodeRef) });
      return;
    }

    const ledger = new BudgetLedger(opts.maxOutputTokens);
    const meta = metaRecord("impact", opts);
    ledger.frame(meta);

    const records: Rec[] = [];
    const emittedNodes: GraphNode[] = [];
    let truncated = false;

    const targetRecord: Rec = { type: "target", targetType: fileNodes.length > 0 ? "file" : "symbol", value: target };
    if (ledger.tryAdd(targetRecord)) records.push(targetRecord); else truncated = true;

    // Definitions (roots) and transitive callers share one `maxNodes` cap on returned nodes.
    const rootsSorted = roots.sort(byId);
    for (const root of rootsSorted) {
      if (emittedNodes.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, root.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const record: Rec = { type: "defines", ...fact };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      records.push(record);
      emittedNodes.push(root);
    }

    const impacted = new Map<string, { node: GraphNode; depth: number; root: string }>();
    for (const root of rootsSorted) {
      for (const entry of transitiveCallers(session.graph, root, opts.depth)) {
        const current = impacted.get(entry.node.id);
        if (!current || entry.depth < current.depth) impacted.set(entry.node.id, { ...entry, root: root.id });
      }
    }
    const ordered = [...impacted.values()].sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id));
    for (const entry of ordered) {
      if (emittedNodes.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, entry.node.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const record: Rec = { type: "caller", depth: entry.depth, root: entry.root, ...fact };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      records.push(record);
      emittedNodes.push(entry.node);
    }

    const sourceRecords = planSource(ledger, emittedNodes, rootDir, opts, records);

    const affectedIds = [...new Set([...roots.map((node) => node.id), ...impacted.keys()])];
    const groundingRecords: Rec[] = [];
    for (const grounding of groundedFiles(session.db, affectedIds)) {
      const record: Rec = { type: "grounding", node: grounding.node_id, file: grounding.scaffold_file };
      if (ledger.tryAdd(record)) groundingRecords.push(record); else truncated = true;
    }

    emitAll(write, meta, [...records, ...sourceRecords, ...groundingRecords]);
    write(JSON.stringify(summaryRecord(ledger, opts, {
      matchedNodes: roots.length + impacted.size,
      returnedNodes: emittedNodes.length,
      returnedEdges: 0,
      truncated,
      suggestedNextCommands: emittedNodes.length > 0 ? [`mex graph get ${emittedNodes[0]!.id} --detail source`] : [],
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Structural graph lookup. Output is newline-delimited JSON (JSONL). */
export function runGraphQuery(
  relation: string,
  target: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  if (!isRelation(relation)) {
    writeJson(write, { type: "error", code: "INVALID_QUERY", relation, expected: ["who-calls", "what-calls", "where-defined"] });
    return;
  }
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const nodes = resolveSymbol(session.graph, target);
    if (nodes.length === 0) {
      writeJson(write, { type: "error", code: "TARGET_NOT_FOUND", target });
      return;
    }

    // Preserve (queried target, result) pairs; dedupe by that pair, not by result id alone.
    const pairs: Array<{ targetId: string; node: GraphNode }> = [];
    const seen = new Set<string>();
    for (const queried of nodes.sort(byId)) {
      const related = relation === "where-defined"
        ? [queried]
        : (relation === "who-calls" ? session.graph.getCallers(queried.id) : session.graph.getCallees(queried.id)).sort(byId);
      for (const node of related) {
        const key = `${queried.id} ${node.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ targetId: queried.id, node });
      }
    }

    const ledger = new BudgetLedger(opts.maxOutputTokens);
    const meta = metaRecord(`graph query ${relation}`, opts);
    ledger.frame(meta);

    const entries: Array<{ record: Rec; node: GraphNode }> = [];
    let truncated = false;
    for (const pair of pairs) {
      if (entries.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, pair.node.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const record: Rec = { type: "result", relation, target: pair.targetId, ...fact };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      entries.push({ record, node: pair.node });
    }

    const sourceRecords = planSource(ledger, entries.map((e) => e.node), rootDir, opts, entries.map((e) => e.record));

    emitAll(write, meta, [...entries.map((e) => e.record), ...sourceRecords]);
    write(JSON.stringify(summaryRecord(ledger, opts, {
      matchedNodes: pairs.length,
      returnedNodes: entries.length,
      returnedEdges: 0,
      truncated,
      suggestedNextCommands: entries.length > 0 && opts.detail !== "source" ? [`mex graph get ${entries[0]!.node.id} --detail source`] : [],
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Broad graph retrieval for an agent task. Compact JSONL manifest by default. */
export function runGraphScope(
  task: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const { candidates, matchedCount } = selectScope(session.graph, task, opts.maxNodes);
    const ledger = new BudgetLedger(opts.maxOutputTokens);
    const meta = metaRecord("graph scope", opts, task);
    ledger.frame(meta);

    const facts: Array<{ record: Rec; node: GraphNode }> = [];
    const returnedIds = new Set<string>();
    let truncated = candidates.length < matchedCount;
    for (const candidate of candidates) {
      const fact = factFor(session, candidate.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const node = session.graph.getNode(candidate.id);
      if (!node) continue;
      const record: Rec = { type: "fact", ...fact, score: candidate.score, selectionReasons: candidate.reasons };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      facts.push({ record, node });
      returnedIds.add(candidate.id);
    }

    const edgeRecords: Rec[] = [];
    if (opts.detail !== "minimal") {
      for (const { node } of facts) {
        for (const callee of session.graph.getCallees(node.id)) {
          if (!returnedIds.has(callee.id)) continue;
          const record: Rec = { type: "edge", kind: "calls", source: node.id, target: callee.id, provenance: "static" };
          if (ledger.tryAdd(record)) edgeRecords.push(record); else truncated = true;
        }
      }
    }

    const sourceRecords = planSource(ledger, facts.map((f) => f.node), rootDir, opts, facts.map((f) => f.record));

    emitAll(write, meta, [...facts.map((f) => f.record), ...edgeRecords, ...sourceRecords]);
    write(JSON.stringify(summaryRecord(ledger, opts, {
      matchedNodes: matchedCount,
      returnedNodes: facts.length,
      returnedEdges: edgeRecords.length,
      truncated,
      suggestedNextCommands: buildScopeSuggestions(facts.map((f) => f.node), opts.detail),
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Targeted source expansion by node id. Output is JSONL source records. */
export function runGraphGet(
  ids: string[],
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions({ ...rawOptions, detail: "source" });
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const ledger = new BudgetLedger(opts.maxOutputTokens);
    const meta: Rec = {
      type: "meta", schemaVersion: SCHEMA_VERSION, command: "graph get",
      detail: "source", maxNodes: ids.length, maxOutputTokens: opts.maxOutputTokens,
    };
    ledger.frame(meta);

    const nodes: GraphNode[] = [];
    const errorRecords: Rec[] = [];
    let truncated = false;
    for (const id of ids) {
      const node = session.graph.getNode(id);
      if (!node) {
        const record: Rec = { type: "error", code: "NODE_NOT_FOUND", id };
        if (ledger.tryAdd(record)) errorRecords.push(record); else truncated = true;
        continue;
      }
      nodes.push(node);
    }
    const sourceRecords = planSource(ledger, nodes, rootDir, opts);
    const sourcedIds = new Set(
      sourceRecords.flatMap((record) => (record.ranges as SourceRange[]).flatMap((range) => range.nodeIds)),
    );

    emitAll(write, meta, [...errorRecords, ...sourceRecords]);
    write(JSON.stringify(summaryRecord(ledger, opts, {
      matchedNodes: ids.length,
      returnedNodes: sourcedIds.size,
      returnedEdges: 0,
      truncated,
      suggestedNextCommands: [],
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

// ── shared helpers ──────────────────────────────────────────────────────────

function metaRecord(command: string, opts: AgentOptions, task?: string): Rec {
  return {
    type: "meta", schemaVersion: SCHEMA_VERSION, command,
    ...(task !== undefined ? { task } : {}),
    detail: opts.detail, maxNodes: opts.maxNodes, maxOutputTokens: opts.maxOutputTokens,
  };
}

function summaryRecord(
  ledger: BudgetLedger,
  opts: AgentOptions,
  fields: { matchedNodes: number; returnedNodes: number; returnedEdges: number; truncated: boolean; suggestedNextCommands: string[] },
): Rec {
  const base: Rec = {
    type: "summary",
    matchedNodes: fields.matchedNodes,
    returnedNodes: fields.returnedNodes,
    returnedEdges: fields.returnedEdges,
    maxOutputTokens: opts.maxOutputTokens,
    truncated: fields.truncated || ledger.droppedAny || ledger.overBudget,
    suggestedNextCommands: fields.suggestedNextCommands,
  };
  return { ...base, estimatedOutputTokens: ledger.estimatedTokens + estimateTokens({ ...base, estimatedOutputTokens: 0 }) };
}

/**
 * Plan grouped-per-file source records for `nodes` (deduped by id) under the
 * ledger, only when detail is "source". Sets `sourceIncluded` on the already-built
 * `facts` records to reflect whether each node's source actually fit the budget.
 * Returns the source records to emit.
 */
function planSource(
  ledger: BudgetLedger,
  nodes: GraphNode[],
  rootDir: string,
  opts: AgentOptions,
  facts: Rec[] = [],
): Rec[] {
  if (opts.detail !== "source") {
    for (const fact of facts) fact.sourceIncluded = false;
    return [];
  }
  const sourceRecords: Rec[] = [];
  const sourcedIds = new Set<string>();
  const emit = (record: Rec, ids: string[]): void => {
    if (!ledger.tryAdd(record)) return;
    sourceRecords.push(record);
    for (const id of ids) sourcedIds.add(id);
  };
  for (const [filePath, fileNodes] of groupByFile(dedupeById(nodes))) {
    const ranges = fileNodes
      .map((node) => readNodeSource(node, rootDir, opts.maxSourceLines))
      .filter((range): range is SourceRange => range !== null);
    if (ranges.length === 0) continue;
    const grouped: Rec = { type: "source", filePath, ranges };
    // Prefer one grouped record per file (dedups shared context); if it doesn't
    // fit, degrade to per-range records so partial source still lands.
    if (ledger.fits(grouped)) emit(grouped, ranges.flatMap((range) => range.nodeIds));
    else for (const range of ranges) emit({ type: "source", filePath, ranges: [range] }, range.nodeIds);
  }
  for (const fact of facts) fact.sourceIncluded = typeof fact.id === "string" && sourcedIds.has(fact.id);
  return sourceRecords;
}

function emitAll(write: (line: string) => void, meta: Rec, records: Rec[]): void {
  write(JSON.stringify(meta));
  for (const record of records) write(JSON.stringify(record));
}

function buildScopeSuggestions(nodes: GraphNode[], detail: DetailLevel): string[] {
  if (nodes.length === 0) return [];
  const suggestions: string[] = [];
  if (detail !== "source") suggestions.push(`mex graph get ${nodes[0]!.id} --detail source`);
  suggestions.push(`mex graph query who-calls ${nodes[0]!.name}`);
  return suggestions;
}

function factFor(session: AgentGraphSession, id: string, detail: DetailLevel, includeFingerprint: boolean): CompactFact | null {
  const fact = compactFact(session.graph, id, detail);
  if (!fact || !includeFingerprint) return fact;
  const fingerprint = new FingerprintStore(session.db).get(id);
  return fingerprint ? { ...fact, fingerprint: serializeFingerprint(fingerprint) } : fact;
}

function dedupeById(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function openSession(rootDir: string, deps: AgentCommandDeps, write: (line: string) => void): AgentGraphSession | null {
  try {
    if (deps.open) return deps.open(rootDir);
    const dbPath = resolve(rootDir, ".mex", "graph.db");
    if (!existsSync(dbPath)) {
      writeJson(write, { type: "error", code: "GRAPH_UNAVAILABLE", message: "Run `mex graph` first." });
      return null;
    }
    const graph = createGraphEngine({ rootDir, dbPath });
    const db = openSqlite(dbPath);
    return { graph, db, close: () => { graph.close(); db.close(); } };
  } catch (error) {
    unavailable(write, error);
    return null;
  }
}

function resolveSymbol(graph: GraphEngine, target: string): GraphNode[] {
  const exactId = graph.getNode(target);
  if (exactId) return [exactId];
  const matches = graph.searchNodes(target, { limit: 100 });
  const exact = matches.filter((node) => node.name === target || node.qualifiedName === target);
  return exact.length > 0 ? exact : matches;
}

function nodesForFile(session: AgentGraphSession, rootDir: string, target: string): GraphNode[] {
  const relativeTarget = (target.startsWith("/") ? relative(rootDir, target) : target)
    .replace(/^\.\//, "").replaceAll("\\", "/");
  const rows = session.db.prepare("SELECT id FROM nodes WHERE file_path = ? ORDER BY id").all(relativeTarget) as Array<{ id: string }>;
  return rows.map((row) => session.graph.getNode(row.id)).filter((node): node is GraphNode => node !== null);
}

function transitiveCallers(graph: GraphEngine, root: GraphNode, maxDepth: number): Array<{ node: GraphNode; depth: number }> {
  const seen = new Set([root.id]);
  const queue: Array<{ node: GraphNode; depth: number }> = [{ node: root, depth: 0 }];
  const results: Array<{ node: GraphNode; depth: number }> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const caller of graph.getCallers(current.node.id).sort(byId)) {
      if (seen.has(caller.id)) continue;
      seen.add(caller.id);
      const entry = { node: caller, depth: current.depth + 1 };
      results.push(entry);
      queue.push(entry);
    }
  }
  return results;
}

function groundedFiles(db: SqliteDatabase, nodeIds: string[]): Array<{ scaffold_file: string; node_id: string }> {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT scaffold_file, node_id FROM _mex_grounded_source WHERE node_id IN (${placeholders}) ORDER BY scaffold_file, node_id`,
  ).all(...nodeIds) as Array<{ scaffold_file: string; node_id: string }>;
}

function nodeRef(node: GraphNode): Record<string, string | number> {
  return { id: node.id, kind: node.kind, name: node.name, file: node.filePath, line: node.startLine };
}

function byId(left: GraphNode, right: GraphNode): number { return left.id.localeCompare(right.id); }
function isRelation(value: string): value is QueryRelation {
  return value === "who-calls" || value === "what-calls" || value === "where-defined";
}
function writeJson(write: (line: string) => void, value: unknown): void { write(JSON.stringify(value)); }
function unavailable(write: (line: string) => void, error: unknown): void {
  writeJson(write, {
    type: "error",
    code: "GRAPH_UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
  });
}
