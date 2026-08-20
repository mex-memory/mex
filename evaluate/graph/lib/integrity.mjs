import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { stableJson } from "../../core/hash.mjs";
import { round } from "../../core/stats.mjs";

const require = createRequire(import.meta.url);
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning, ...rest) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (typeof message === "string" && /SQLite is an experimental feature/i.test(message)) return;
  return originalEmitWarning(warning, ...rest);
});
const { DatabaseSync } = require("node:sqlite");

const NORMALIZED_TABLES = [
  {
    name: "nodes",
    columns: [
      "id", "kind", "name", "qualified_name", "container_id", "identity_key", "file_path", "language",
      "start_line", "end_line", "start_column", "end_column", "docstring", "signature", "visibility",
      "is_exported", "is_async", "is_static", "is_abstract", "decorators", "type_parameters", "return_type", "body_hash",
    ],
    order: ["id"],
  },
  {
    name: "edges",
    columns: [
      "source", "target", "kind", "line", "col", "confidence", "resolution_method", "provenance", "metadata", "evidence",
    ],
    order: ["source", "target", "kind", "line", "col", "resolution_method", "provenance"],
  },
  {
    name: "files",
    columns: [
      "path", "content_hash", "language", "size", "node_count", "errors", "parse_status", "diagnostic_count",
      "missing_count", "error_coverage", "extractor_version",
    ],
    order: ["path"],
  },
  {
    name: "unresolved_refs",
    columns: [
      "ref_key", "from_node_id", "reference_name", "reference_kind", "line", "col", "file_path", "language",
      "receiver", "qualifier", "import_source", "candidates", "metadata", "status", "target_id", "confidence", "resolver",
    ],
    order: ["ref_key", "from_node_id", "file_path", "line", "col", "reference_name", "reference_kind"],
  },
  {
    name: "import_bindings",
    columns: [
      "binding_key", "file_path", "local_name", "imported_name", "module_specifier", "resolved_file_path", "target_id",
      "is_type_only", "metadata",
    ],
    order: ["binding_key", "file_path", "local_name"],
  },
  {
    name: "node_aliases",
    columns: ["alias_id", "canonical_node_id", "match_method", "confidence"],
    order: ["alias_id"],
  },
  {
    name: "source_chunks",
    columns: ["file_path", "start_line", "end_line", "content_hash", "path_terms", "identifier_terms", "comment_terms"],
    order: ["file_path", "start_line", "end_line"],
  },
  {
    name: "project_metadata",
    columns: ["key", "value"],
    order: ["key"],
  },
  {
    name: "node_fingerprints",
    columns: ["node_id", "minhash", "neighbors", "token_count"],
    order: ["node_id"],
  },
  {
    name: "lsh_buckets",
    columns: ["band", "band_hash", "node_id"],
    order: ["band", "band_hash", "node_id"],
  },
];

function identifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

function scalar(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return Number(row?.value ?? 0);
}

function rows(db, sql, params = []) {
  return db.prepare(sql).all(...params).map((row) => ({ ...row }));
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table));
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(rows(db, `PRAGMA table_info(${identifier(table)})`).map((row) => row.name));
}

function hasColumns(db, table, required) {
  const available = tableColumns(db, table);
  return required.every((column) => available.has(column));
}

function tableCount(db, table) {
  return tableExists(db, table) ? scalar(db, `SELECT COUNT(*) AS value FROM ${identifier(table)}`) : 0;
}

function duplicateExcess(db, table, columns) {
  if (!hasColumns(db, table, columns)) return null;
  const group = columns.map(identifier).join(", ");
  return scalar(db, `SELECT COALESCE(SUM(count - 1), 0) AS value FROM (
    SELECT COUNT(*) AS count FROM ${identifier(table)} GROUP BY ${group} HAVING COUNT(*) > 1
  )`);
}

function groupedCounts(db, table, column, where = null) {
  if (!hasColumns(db, table, [column])) return {};
  const result = rows(db, `SELECT ${identifier(column)} AS key, COUNT(*) AS count FROM ${identifier(table)}
    ${where ? `WHERE ${where}` : ""} GROUP BY ${identifier(column)} ORDER BY ${identifier(column)}`);
  return Object.fromEntries(result.map((row) => [row.key ?? "<null>", Number(row.count)]));
}

function normalizedRows(db, spec) {
  const available = tableColumns(db, spec.name);
  if (!available.size) return null;
  const columns = spec.columns.filter((column) => available.has(column));
  if (!columns.length) return [];
  const order = spec.order.filter((column) => available.has(column));
  const sql = `SELECT ${columns.map(identifier).join(", ")} FROM ${identifier(spec.name)}${order.length ? ` ORDER BY ${order.map(identifier).join(", ")}` : ""}`;
  return rows(db, sql);
}

function normalizedGraphHash(db) {
  const hash = createHash("sha256");
  for (const spec of NORMALIZED_TABLES) {
    hash.update(`${spec.name}\0`);
    const tableRows = normalizedRows(db, spec);
    if (tableRows === null) {
      hash.update("<absent>\n");
      continue;
    }
    for (const row of tableRows) hash.update(`${stableJson(row)}\n`);
  }
  return hash.digest("hex");
}

function graphSchemaVersion(db) {
  if (!hasColumns(db, "schema_versions", ["version"])) return null;
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_versions").get();
  return row?.version !== null && row?.version !== undefined && Number.isFinite(Number(row.version)) ? Number(row.version) : null;
}

function fileHealth(db, files) {
  const hasV2Health = hasColumns(db, "files", ["parse_status", "diagnostic_count", "missing_count", "error_coverage"]);
  const filesWithExtractionErrors = hasColumns(db, "files", ["errors"])
    ? scalar(db, "SELECT COUNT(*) AS value FROM files WHERE errors IS NOT NULL AND errors NOT IN ('', '[]')")
    : 0;
  if (!hasV2Health) {
    return {
      healthAvailable: false,
      parseStatusCounts: { unknown: files },
      okFiles: null,
      partialFiles: null,
      failedFiles: null,
      unknownHealthFiles: files,
      totalDiagnostics: null,
      totalMissingNodes: null,
      meanErrorCoverage: null,
      maxErrorCoverage: null,
      failedFilePaths: [],
      filesWithExtractionErrors,
    };
  }
  const aggregate = db.prepare(`SELECT
    COALESCE(SUM(diagnostic_count), 0) AS diagnostics,
    COALESCE(SUM(missing_count), 0) AS missing,
    COALESCE(AVG(error_coverage), 0) AS mean_coverage,
    COALESCE(MAX(error_coverage), 0) AS max_coverage
    FROM files`).get();
  const parseStatusCounts = groupedCounts(db, "files", "parse_status");
  return {
    healthAvailable: true,
    parseStatusCounts,
    okFiles: parseStatusCounts.ok ?? 0,
    partialFiles: parseStatusCounts.partial ?? 0,
    failedFiles: parseStatusCounts.failed ?? 0,
    unknownHealthFiles: files - Object.values(parseStatusCounts).reduce((sum, count) => sum + count, 0),
    totalDiagnostics: Number(aggregate.diagnostics),
    totalMissingNodes: Number(aggregate.missing),
    meanErrorCoverage: round(Number(aggregate.mean_coverage)),
    maxErrorCoverage: round(Number(aggregate.max_coverage)),
    failedFilePaths: rows(db, "SELECT path FROM files WHERE parse_status = 'failed' ORDER BY path").map((row) => row.path),
    filesWithExtractionErrors: scalar(db, `SELECT COUNT(*) AS value FROM files
      WHERE diagnostic_count > 0 OR (errors IS NOT NULL AND errors NOT IN ('', '[]'))`),
  };
}

function referenceHealth(db) {
  const total = tableCount(db, "unresolved_refs");
  const hasStatus = hasColumns(db, "unresolved_refs", ["status"]);
  const statuses = hasStatus ? groupedCounts(db, "unresolved_refs", "status") : { unresolved: total };
  const unresolvedReferences = hasStatus
    ? (statuses.pending ?? 0) + (statuses.unresolved ?? 0) + (statuses.ambiguous ?? 0)
    : total;
  const callPredicate = "reference_kind IN ('calls', 'function_ref', 'instantiates')";
  const unresolvedCalls = hasColumns(db, "unresolved_refs", ["reference_kind"])
    ? scalar(db, `SELECT COUNT(*) AS value FROM unresolved_refs WHERE ${callPredicate}${hasStatus ? " AND status != 'resolved'" : ""}`)
    : 0;
  return {
    references: total,
    referenceStatuses: statuses,
    resolvedReferences: statuses.resolved ?? 0,
    unresolvedReferences,
    ambiguousReferences: statuses.ambiguous ?? 0,
    pendingReferences: statuses.pending ?? 0,
    unresolvedCalls,
    danglingUnresolvedSources: hasColumns(db, "unresolved_refs", ["from_node_id"])
      ? scalar(db, "SELECT COUNT(*) AS value FROM unresolved_refs r LEFT JOIN nodes n ON n.id = r.from_node_id WHERE n.id IS NULL")
      : 0,
    danglingResolvedTargets: hasColumns(db, "unresolved_refs", ["target_id"])
      ? scalar(db, `SELECT COUNT(*) AS value FROM unresolved_refs r LEFT JOIN nodes n ON n.id = r.target_id
        WHERE r.target_id IS NOT NULL AND n.id IS NULL`)
      : 0,
    referenceResolvers: hasColumns(db, "unresolved_refs", ["resolver"])
      ? groupedCounts(db, "unresolved_refs", "resolver")
      : {},
  };
}

function edgeHealth(db, edges) {
  const hasConfidence = hasColumns(db, "edges", ["confidence"]);
  const confidence = hasConfidence ? db.prepare(`SELECT
    COALESCE(MIN(confidence), 0) AS minimum,
    COALESCE(AVG(confidence), 0) AS average,
    SUM(CASE WHEN confidence >= 0.8 THEN 1 ELSE 0 END) AS traversable,
    SUM(CASE WHEN confidence < 0.8 THEN 1 ELSE 0 END) AS below_threshold,
    SUM(CASE WHEN confidence < 0 OR confidence > 1 THEN 1 ELSE 0 END) AS invalid
    FROM edges`).get() : null;
  return {
    duplicateEdges: duplicateExcess(db, "edges", ["source", "target", "kind", "line", "col"]),
    edgeKinds: groupedCounts(db, "edges", "kind"),
    edgeProvenance: groupedCounts(db, "edges", "provenance"),
    edgeResolutionMethods: groupedCounts(db, "edges", "resolution_method"),
    edgeConfidenceAvailable: hasConfidence,
    traversableEdges: confidence ? Number(confidence.traversable) : edges,
    belowFlowThresholdEdges: confidence ? Number(confidence.below_threshold) : null,
    invalidConfidenceEdges: confidence ? Number(confidence.invalid) : null,
    minimumEdgeConfidence: confidence ? round(Number(confidence.minimum)) : null,
    meanEdgeConfidence: confidence ? round(Number(confidence.average)) : null,
  };
}

function isLowValuePath(filePath) {
  const path = String(filePath ?? "").toLowerCase();
  return /(^|\/)(__tests?__|tests?|specs?|fixtures?|examples?|samples?|benchmarks?|demos?|mocks?|testdata|integration)(\/|$)/.test(path)
    || /\.(test|spec)\.[^/]+$/.test(path)
    || /(^|\/)test_[^/]+\.[^/]+$/.test(path)
    || /_test\.[^/]+$/.test(path)
    || /(^|\/)(generated|vendor)\//.test(path);
}

function hasCompilerProvenCallbackBinding(edge) {
  if (edge.resolution_method !== "typescript-callback-parameter"
    || edge.provenance !== "callback-synthesis"
    || Number(edge.confidence) < 0.8
    || !Number.isInteger(Number(edge.line))) return false;
  try {
    const evidence = JSON.parse(edge.evidence ?? "[]");
    return Array.isArray(evidence) && evidence.some((item) => item
      && Number.isInteger(item.argumentIndex)
      && typeof item.parameterName === "string" && item.parameterName.length > 0
      && typeof item.wiringSite === "string" && item.wiringSite.length > 0);
  } catch {
    return false;
  }
}

/** Production-to-test edges require an explicit import/use or callback binding. */
function productionTestEdgeHealth(db) {
  if (!hasColumns(db, "edges", ["source", "target", "kind"])
    || !hasColumns(db, "nodes", ["id", "file_path"])) {
    return { suspiciousProductionToTestEdges: null, suspiciousProductionToTestEdgeSamples: [] };
  }
  const bindings = hasColumns(db, "import_bindings", ["file_path", "resolved_file_path", "target_id"])
    ? rows(db, "SELECT file_path, resolved_file_path, target_id FROM import_bindings")
    : [];
  const proven = new Set(bindings.flatMap((binding) => [
    binding.target_id ? `${binding.file_path}\0id:${binding.target_id}` : null,
    binding.resolved_file_path ? `${binding.file_path}\0path:${binding.resolved_file_path}` : null,
  ].filter(Boolean)));
  const resolutionMethod = hasColumns(db, "edges", ["resolution_method"])
    ? "e.resolution_method"
    : "NULL AS resolution_method";
  const provenance = hasColumns(db, "edges", ["provenance"]) ? "e.provenance" : "NULL AS provenance";
  const confidence = hasColumns(db, "edges", ["confidence"]) ? "e.confidence" : "NULL AS confidence";
  const evidence = hasColumns(db, "edges", ["evidence"]) ? "e.evidence" : "NULL AS evidence";
  const line = hasColumns(db, "edges", ["line"]) ? "e.line" : "NULL AS line";
  const candidates = rows(db, `SELECT e.source, e.target, e.kind, ${resolutionMethod},
      ${provenance}, ${confidence}, ${evidence}, ${line},
      source.file_path AS source_path, target.file_path AS target_path
    FROM edges e JOIN nodes source ON source.id = e.source JOIN nodes target ON target.id = e.target
    WHERE source.file_path != target.file_path`);
  const suspicious = candidates.filter((edge) => !isLowValuePath(edge.source_path)
    && isLowValuePath(edge.target_path)
    && !proven.has(`${edge.source_path}\0id:${edge.target}`)
    && !proven.has(`${edge.source_path}\0path:${edge.target_path}`)
    && !hasCompilerProvenCallbackBinding(edge));
  return {
    suspiciousProductionToTestEdges: suspicious.length,
    suspiciousProductionToTestEdgeSamples: suspicious.slice(0, 20),
  };
}

export function inspectGraphDatabase(path, buildSummary = null) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const nodes = tableCount(db, "nodes");
    const files = tableCount(db, "files");
    const edges = tableCount(db, "edges");
    const callEdges = hasColumns(db, "edges", ["kind"])
      ? scalar(db, "SELECT COUNT(*) AS value FROM edges WHERE kind = 'calls'")
      : 0;
    const extractedFileNodes = hasColumns(db, "files", ["node_count"])
      ? scalar(db, "SELECT COALESCE(SUM(node_count), 0) AS value FROM files")
      : null;
    const storedFileNodes = hasColumns(db, "nodes", ["file_path"]) && hasColumns(db, "files", ["path"])
      ? scalar(db, "SELECT COUNT(*) AS value FROM nodes INNER JOIN files ON files.path = nodes.file_path")
      : null;
    const references = referenceHealth(db);
    const callableNodes = hasColumns(db, "nodes", ["kind"])
      ? scalar(db, "SELECT COUNT(*) AS value FROM nodes WHERE kind IN ('function', 'method', 'route', 'component')")
      : 0;
    const noIncomingCalls = hasColumns(db, "nodes", ["id", "kind"]) && hasColumns(db, "edges", ["target", "kind"])
      ? scalar(db, `SELECT COUNT(*) AS value FROM nodes n WHERE n.kind IN ('function', 'method', 'route', 'component')
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'calls' AND e.target = n.id)`)
      : 0;
    const noOutgoingCalls = hasColumns(db, "nodes", ["id", "kind"]) && hasColumns(db, "edges", ["source", "kind"])
      ? scalar(db, `SELECT COUNT(*) AS value FROM nodes n WHERE n.kind IN ('function', 'method', 'route', 'component')
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'calls' AND e.source = n.id)`)
      : 0;
    const sourceChunks = tableCount(db, "source_chunks");
    const imports = tableCount(db, "import_bindings");
    const aliases = tableCount(db, "node_aliases");
    const buildNodeCount = Number(buildSummary?.nodesCreated ?? NaN);
    const health = fileHealth(db, files);
    const edgeMetrics = edgeHealth(db, edges);
    const integrity = {
      schemaVersion: graphSchemaVersion(db),
      files,
      nodes,
      extractedFileNodes,
      storedFileNodes,
      extractedToStoredLoss: extractedFileNodes !== null && storedFileNodes !== null ? Math.max(0, extractedFileNodes - storedFileNodes) : null,
      nonFileOrFrameworkNodes: storedFileNodes !== null ? Math.max(0, nodes - storedFileNodes) : null,
      buildNodesCreated: buildNodeCount,
      buildToStoredDelta: Number.isFinite(buildNodeCount) ? nodes - buildNodeCount : null,
      edges,
      callEdges,
      ...references,
      unresolvedCallRate: callEdges + references.unresolvedCalls
        ? round(references.unresolvedCalls / (callEdges + references.unresolvedCalls))
        : 0,
      danglingEdges: hasColumns(db, "edges", ["source", "target"]) && hasColumns(db, "nodes", ["id"])
        ? scalar(db, `SELECT COUNT(*) AS value FROM edges e LEFT JOIN nodes s ON s.id = e.source
          LEFT JOIN nodes t ON t.id = e.target WHERE s.id IS NULL OR t.id IS NULL`)
        : 0,
      danglingContainers: hasColumns(db, "nodes", ["container_id"])
        ? scalar(db, `SELECT COUNT(*) AS value FROM nodes child LEFT JOIN nodes parent ON parent.id = child.container_id
          WHERE child.container_id IS NOT NULL AND parent.id IS NULL`)
        : null,
      duplicateFileKindName: duplicateExcess(db, "nodes", ["file_path", "kind", "name"]),
      duplicateQualifiedIdentity: duplicateExcess(db, "nodes", ["file_path", "kind", "qualified_name"]),
      duplicateIdentityKeys: duplicateExcess(db, "nodes", ["identity_key"]),
      missingIdentityKeys: hasColumns(db, "nodes", ["identity_key"])
        ? scalar(db, "SELECT COUNT(*) AS value FROM nodes WHERE identity_key IS NULL OR identity_key = ''")
        : null,
      ftsRowDelta: tableExists(db, "nodes_fts") ? tableCount(db, "nodes_fts") - nodes : null,
      sourceChunks,
      sourceChunkFtsRowDelta: tableExists(db, "source_chunks_fts") ? tableCount(db, "source_chunks_fts") - sourceChunks : null,
      importBindings: imports,
      unresolvedImportBindings: hasColumns(db, "import_bindings", ["resolved_file_path", "target_id"])
        ? scalar(db, "SELECT COUNT(*) AS value FROM import_bindings WHERE resolved_file_path IS NULL AND target_id IS NULL")
        : null,
      danglingImportTargets: hasColumns(db, "import_bindings", ["target_id"])
        ? scalar(db, `SELECT COUNT(*) AS value FROM import_bindings b LEFT JOIN nodes n ON n.id = b.target_id
          WHERE b.target_id IS NOT NULL AND n.id IS NULL`)
        : null,
      nodeAliases: aliases,
      danglingAliases: hasColumns(db, "node_aliases", ["canonical_node_id"])
        ? scalar(db, `SELECT COUNT(*) AS value FROM node_aliases a LEFT JOIN nodes n ON n.id = a.canonical_node_id WHERE n.id IS NULL`)
        : null,
      callableNodes,
      noIncomingCalls,
      noIncomingCallRate: callableNodes ? round(noIncomingCalls / callableNodes) : 0,
      noOutgoingCalls,
      noOutgoingCallRate: callableNodes ? round(noOutgoingCalls / callableNodes) : 0,
      unresolvedKinds: hasColumns(db, "unresolved_refs", ["reference_kind"])
        ? groupedCounts(db, "unresolved_refs", "reference_kind", hasColumns(db, "unresolved_refs", ["status"]) ? "status != 'resolved'" : null)
        : {},
      ...productionTestEdgeHealth(db),
      ...health,
      ...edgeMetrics,
      projectMetadata: hasColumns(db, "project_metadata", ["key", "value"])
        ? Object.fromEntries(rows(db, "SELECT key, value FROM project_metadata ORDER BY key").map((row) => [row.key, row.value]))
        : {},
      normalizedGraphSha256: normalizedGraphHash(db),
    };
    return integrity;
  } finally {
    db.close();
  }
}
