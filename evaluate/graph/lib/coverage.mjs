import { createRequire } from "node:module";
import { evidenceMatchesRecord, evidencePath, evidenceSpan, evidenceSymbol } from "../../core/evidence.mjs";
import { round } from "../../core/stats.mjs";

const require = createRequire(import.meta.url);
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning, ...rest) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (typeof message === "string" && /SQLite is an experimental feature/i.test(message)) return;
  return originalEmitWarning(warning, ...rest);
});
const { DatabaseSync } = require("node:sqlite");

function tableColumns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)); }
  catch { return new Set(); }
}

function selectorMatches(selector, node) {
  const symbol = evidenceSymbol(selector);
  const path = evidencePath(selector);
  if (path !== evidencePath(node)) return false;
  const qualified = String(node.qualifiedName ?? "");
  const symbolMatches = evidenceSymbol(node) === symbol
    || qualified === symbol
    || qualified.endsWith(`.${symbol}`)
    || qualified.endsWith(`::${symbol}`);
  if (!symbolMatches) return false;
  const span = evidenceSpan(selector);
  return !span || evidenceMatchesRecord({ ...selector, symbol: evidenceSymbol(node) }, node);
}

function isUnnamedFlowNode(node) {
  const name = typeof node?.name === "string" ? node.name : "";
  return name.length === 0 || /^<.*>$/.test(name) || name.startsWith("<callback:");
}

function directedPaths(sourceIds, targetIds, kinds, nodesById, edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (edge.confidence !== null && edge.confidence < 0.8) continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge);
  }
  const paths = [];
  for (const source of sourceIds) {
    const queue = [{ id: source, path: [], unnamedBridges: 0 }];
    const visited = new Set([`${source}\0${0}`]);
    while (queue.length) {
      const current = queue.shift();
      if (targetIds.has(current.id) && current.path.length > 0) {
        paths.push(current.path);
        break;
      }
      if (current.path.length >= 7) continue;
      for (const edge of adjacency.get(current.id) ?? []) {
        const target = nodesById.get(edge.target);
        const callbackBridge = edge.kind === "contains" && isUnnamedFlowNode(target);
        if (kinds?.length && !kinds.includes(edge.kind) && !callbackBridge) continue;
        const unnamedBridges = current.unnamedBridges + Number(isUnnamedFlowNode(target));
        if (unnamedBridges > 1) continue;
        const key = `${edge.target}\0${unnamedBridges}`;
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push({ id: edge.target, path: [...current.path, edge], unnamedBridges });
      }
    }
  }
  return paths;
}

function taskCoverage(task, nodes, edges) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const evidence = (task.gold ?? []).map((gold) => {
    const matches = nodes.filter((node) => selectorMatches(gold, node));
    return {
      symbol: gold.symbol,
      path: evidencePath(gold),
      startLine: evidenceSpan(gold)?.startLine ?? null,
      endLine: evidenceSpan(gold)?.endLine ?? null,
      advisoryKind: gold.kind ?? null,
      covered: matches.length > 0,
      matches: matches.map((node) => ({
        id: node.id,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        startLine: node.startLine,
        endLine: node.endLine,
        kindAgrees: gold.kind === undefined ? null : gold.kind === node.kind,
      })),
    };
  });
  const requiredFlows = (task.requiredFlows ?? []).map((flow) => {
    const sources = nodes.filter((node) => selectorMatches(flow.from, node));
    const targets = nodes.filter((node) => selectorMatches(flow.to, node));
    const sourceIds = new Set(sources.map((node) => node.id));
    const targetIds = new Set(targets.map((node) => node.id));
    const paths = directedPaths(sourceIds, targetIds, flow.kinds, nodesById, edges);
    return { ...flow, covered: paths.length > 0, matches: paths.flat(), paths };
  });
  const covered = evidence.filter((entry) => entry.covered).length;
  const coveredFlows = requiredFlows.filter((entry) => entry.covered).length;
  return {
    taskId: task.id,
    evidence,
    totalEvidence: evidence.length,
    coveredEvidence: covered,
    missingEvidence: evidence.length - covered,
    evidenceCoverage: evidence.length ? round(covered / evidence.length) : null,
    requiredFlows,
    totalRequiredFlows: requiredFlows.length,
    coveredRequiredFlows: coveredFlows,
    directedFlowCoverage: requiredFlows.length ? round(coveredFlows / requiredFlows.length) : null,
  };
}

/** Snapshot structural coverage before retrieval so construction loss is never scored as a retrieval miss. */
export function inspectGoldCoverage(path, tasks) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const nodeColumns = tableColumns(db, "nodes");
    const requiredNodeColumns = ["id", "name", "qualified_name", "file_path", "kind", "start_line", "end_line"];
    if (requiredNodeColumns.some((column) => !nodeColumns.has(column))) {
      return { status: "unavailable", reason: "nodes table lacks coverage columns", tasks: [] };
    }
    const nodes = db.prepare("SELECT id, name, qualified_name, file_path, kind, start_line, end_line FROM nodes").all().map((row) => ({
      id: row.id,
      name: row.name,
      qualifiedName: row.qualified_name,
      filePath: row.file_path,
      kind: row.kind,
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
    }));
    const edgeColumns = tableColumns(db, "edges");
    const confidence = edgeColumns.has("confidence") ? "confidence" : "NULL AS confidence";
    const edges = edgeColumns.has("source") && edgeColumns.has("target") && edgeColumns.has("kind")
      ? db.prepare(`SELECT source, target, kind, ${confidence} FROM edges`).all().map((edge) => ({
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        confidence: edge.confidence !== null && edge.confidence !== undefined && Number.isFinite(Number(edge.confidence))
          ? Number(edge.confidence)
          : null,
      }))
      : [];
    const coverageTasks = tasks.map((task) => taskCoverage(task, nodes, edges));
    const totalEvidence = coverageTasks.reduce((sum, task) => sum + task.totalEvidence, 0);
    const coveredEvidence = coverageTasks.reduce((sum, task) => sum + task.coveredEvidence, 0);
    const totalRequiredFlows = coverageTasks.reduce((sum, task) => sum + task.totalRequiredFlows, 0);
    const coveredRequiredFlows = coverageTasks.reduce((sum, task) => sum + task.coveredRequiredFlows, 0);
    return {
      status: "ok",
      totalEvidence,
      coveredEvidence,
      missingEvidence: totalEvidence - coveredEvidence,
      evidenceCoverage: totalEvidence ? round(coveredEvidence / totalEvidence) : null,
      totalRequiredFlows,
      coveredRequiredFlows,
      directedFlowCoverage: totalRequiredFlows ? round(coveredRequiredFlows / totalRequiredFlows) : null,
      tasks: coverageTasks,
    };
  } finally {
    db.close();
  }
}

export function coverageForTask(coverage, taskId) {
  return coverage?.tasks?.find((task) => task.taskId === taskId) ?? null;
}
