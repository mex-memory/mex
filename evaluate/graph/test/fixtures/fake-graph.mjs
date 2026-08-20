import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const mode = process.env.FAKE_GRAPH_QUERY_MODE ?? "ok";

function build() {
  mkdirSync(".mex", { recursive: true });
  const db = new DatabaseSync(join(".mex", "graph.db"));
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL,
      file_path TEXT NOT NULL, language TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL, end_column INTEGER NOT NULL, docstring TEXT, signature TEXT, visibility TEXT,
      is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0, is_static INTEGER DEFAULT 0,
      is_abstract INTEGER DEFAULT 0, decorators TEXT, type_parameters TEXT, return_type TEXT, body_hash TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, metadata TEXT, line INTEGER, col INTEGER, provenance TEXT);
    CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, node_count INTEGER DEFAULT 0, errors TEXT);
    CREATE TABLE unresolved_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, from_node_id TEXT NOT NULL, reference_name TEXT NOT NULL, reference_kind TEXT NOT NULL, line INTEGER NOT NULL, col INTEGER NOT NULL, candidates TEXT, file_path TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'unknown');
    CREATE VIRTUAL TABLE nodes_fts USING fts5(id, name, qualified_name, docstring, signature);
  `);
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("src/subject.ts", "hash", "typescript", 100, 1, 1, 2, "[]");
  const insert = db.prepare(`INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run("function:target", "function", "TargetSymbol", "TargetSymbol", "src/subject.ts", "typescript", 1, 1, 0, 30, 1);
  db.prepare("INSERT INTO nodes_fts VALUES (?, ?, ?, ?, ?)").run("function:target", "TargetSymbol", "TargetSymbol", null, null);
  db.close();
  process.stdout.write(`${JSON.stringify({ filesIndexed: 1, nodesCreated: 2, edgesCreated: 0, durationMs: 1 }, null, 2)}\n`);
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

if (args[0] === "graph" && args[1] === "--json") build();
else if (mode === "failure") {
  process.stderr.write("intentional fake failure\n");
  process.exit(7);
} else if (mode === "malformed") {
  process.stdout.write("not-json\n");
} else if (args[0] === "graph" && args[1] === "scope") {
  const mutateThisQuery = !process.env.FAKE_GRAPH_MUTATE_QUERY
    || process.env.FAKE_GRAPH_MUTATE_QUERY === args[2];
  if (mutateThisQuery && process.env.FAKE_GRAPH_MUTATE_SUBJECT === "1") {
    appendFileSync(join("src", "subject.ts"), "// concurrent source drift\n");
  }
  if (mutateThisQuery && process.env.FAKE_GRAPH_MUTATE_BUNDLE === "1") {
    appendFileSync(fileURLToPath(import.meta.url), "\n// concurrent bundle drift\n");
  }
  if (mutateThisQuery && process.env.FAKE_GRAPH_MUTATE_HARNESS_PATH) {
    appendFileSync(process.env.FAKE_GRAPH_MUTATE_HARNESS_PATH, "\n// concurrent evaluator drift\n");
  }
  emit({ type: "meta", schemaVersion: 1, command: "graph scope", task: args[2], detail: "minimal", maxNodes: 10, maxOutputTokens: 1_000 });
  if (mode !== "miss") emit({ type: "fact", id: "function:target", kind: "function", name: "TargetSymbol", qualifiedName: "TargetSymbol", filePath: "src/subject.ts", language: "typescript", startLine: 1, endLine: 1 });
  emit({ type: "summary", matchedNodes: mode === "miss" ? 0 : 1, returnedNodes: mode === "miss" ? 0 : 1, returnedEdges: 0, maxOutputTokens: 1_000, truncated: false, suggestedNextCommands: [], estimatedOutputTokens: 100 });
} else if (args[0] === "graph" && args[1] === "query") {
  if (args[3] === "MissingSymbol") emit({ type: "error", code: "TARGET_NOT_FOUND", target: args[3] });
  else {
    emit({ type: "meta", schemaVersion: 1, command: `graph query ${args[2]}`, detail: "minimal", maxNodes: 10, maxOutputTokens: 1_000 });
    emit({ type: "result", relation: args[2], target: "function:target", id: "function:target", kind: "function", name: "TargetSymbol", qualifiedName: "TargetSymbol", filePath: "src/subject.ts", language: "typescript", startLine: 1, endLine: 1 });
    emit({ type: "summary", matchedNodes: 1, returnedNodes: 1, returnedEdges: 0, maxOutputTokens: 1_000, truncated: false, suggestedNextCommands: [], estimatedOutputTokens: 100 });
  }
} else {
  process.stderr.write(`unsupported fake command: ${args.join(" ")}\n`);
  process.exit(9);
}
