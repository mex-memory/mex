// ============================================================================
// mex code-graph — GraphEngine implementation  (Track A)
// ============================================================================
//
// The real engine behind the FROZEN `GraphEngine` interface (`./engine.ts`). It
// ties the pieces together: discover source files → parse+extract (A1) → assign
// body_hash/updatedAt → persist (A3) → resolve cross-file references (A4). Reads
// are plain synchronous SQL; build/sync are async only because they lazy-load
// tree-sitter WASM grammars (the deliberate sync/async split — spec §6).
//
// It implements EXACTLY the frozen surface and nothing more. Fingerprints,
// reconciliation and grounding are Track B and layer on TOP of this — they are
// not part of this class.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { globSync } from "glob";
import { toPosix } from "../paths.js";
import type { GraphEdge, GraphNode, Language } from "./types.js";
import type { BuildResult, GraphEngine, NodeSearchOptions } from "./engine.js";
import { openGraphDatabase } from "./db/database.js";
import { GraphStore, type FileRecord, type UnresolvedRefRecord } from "./db/store.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { detectLanguage, extractFile, isSupportedSourceFile, loadGrammars, normalizedAstTokens } from "./extraction/index.js";
import { resolveReferences } from "./resolution/resolver.js";
import { createResolutionContext } from "./resolution/context.js";
import { FRAMEWORK_RESOLVERS } from "./resolution/frameworks/index.js";
import { getCallees, getCallers } from "./traversal/traversal.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { createFingerprint } from "./fingerprint.js";

/** Directories never worth indexing. */
const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.mex/**",
  "**/coverage/**",
  "**/.next/**",
  "**/out/**",
];

/** Kinds whose `body_hash` is the drift trigger (spec §3). Others stay null. */
const BODY_KINDS = new Set<GraphNode["kind"]>([
  "function",
  "method",
  "class",
  "interface",
  "enum",
  "type_alias",
  "struct",
  "trait",
  "protocol",
  "constant",
  "variable",
  "component",
]);

export interface GraphEngineOptions {
  /** Project root to index. */
  rootDir: string;
  /** Path to the SQLite DB file (defaults to `<rootDir>/.mex/graph.db`). */
  dbPath?: string;
}

class GraphEngineImpl implements GraphEngine {
  private readonly rootDir: string;
  private readonly dbPath: string;
  private db: SqliteDatabase | null = null;
  private store: GraphStore | null = null;

  constructor(options: GraphEngineOptions) {
    this.rootDir = resolve(options.rootDir);
    this.dbPath = options.dbPath ?? resolve(this.rootDir, ".mex", "graph.db");
  }

  /** Lazily open (creating if needed) the DB + store. Shared by reads & writes. */
  private getStore(): GraphStore {
    if (!this.store) {
      this.db = openGraphDatabase(this.dbPath);
      this.store = new GraphStore(this.db);
    }
    return this.store;
  }

  // --- Build / sync (async: lazy-load grammars) -----------------------------

  async build(rootDir?: string): Promise<BuildResult> {
    const started = Date.now();
    const root = rootDir ? resolve(rootDir) : this.rootDir;
    const files = discoverSourceFiles(root);

    // Load grammars for exactly the languages present (lazy — spec §7).
    const languages = new Set<Language>(files.map((f) => detectLanguage(f.relPath)));
    await loadGrammars([...languages]);

    const store = this.getStore();

    // Full rebuild: clear existing graph rows (CASCADE clears edges + refs).
    store.transaction(() => {
      this.db!.exec("DELETE FROM nodes");
      this.db!.exec("DELETE FROM files");
    });

    let nodesCreated = 0;
    let containsEdges = 0;
    store.transaction(() => {
      for (const file of files) {
        const result = this.indexFile(store, file);
        nodesCreated += result.nodes;
        containsEdges += result.contains;
      }
    });

    this.extractFrameworkNodes(store, root, files.map((file) => file.relPath));
    // Second pass: bind every parked cross-file/framework reference to a node id.
    const refEdges = this.resolveAll(store, root);
    this.refreshFingerprints(store, root);
    // Insurance for the external-content FTS table: the trigger-safe writes
    // above maintain it incrementally, then rebuild from the final node state.
    store.rebuildSearchIndex();

    return {
      filesIndexed: files.length,
      nodesCreated,
      edgesCreated: containsEdges + refEdges,
      durationMs: Date.now() - started,
    };
  }

  async sync(changedFiles: string[]): Promise<BuildResult> {
    const started = Date.now();
    const store = this.getStore();

    // Normalize to project-relative posix paths and keep only source files.
    const rels = changedFiles
      .map((f) => toPosix(relative(this.rootDir, resolve(this.rootDir, f))))
      .filter((rel) => rel && !rel.startsWith("..") && isSupportedSourceFile(rel));

    const languages = new Set<Language>(rels.map((rel) => detectLanguage(rel)));
    await loadGrammars([...languages]);

    let nodesCreated = 0;
    store.transaction(() => {
      for (const rel of rels) {
        const abs = resolve(this.rootDir, rel);
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          // File was deleted — drop its nodes (CASCADE clears edges/refs).
          store.deleteNodesByFile(rel);
          continue;
        }
        // Replace the file's nodes wholesale (line-independent ids mean a body
        // edit keeps the same id, so INCOMING edges from unchanged files survive
        // the re-resolve below).
        store.deleteNodesByFile(rel);
        nodesCreated += this.indexFile(store, {
          relPath: rel,
          source: readFileSync(abs, "utf-8"),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        }).nodes;
      }
    });

    this.extractFrameworkNodes(store, this.rootDir, rels);
    // Rebuild ALL reference edges from unresolved_refs (contains edges untouched)
    // so incoming edges cascade-cleared by the delete above are restored.
    store.clearReferenceEdges();
    const refEdges = this.resolveAll(store, this.rootDir);
    this.refreshFingerprints(store, this.rootDir);

    return {
      filesIndexed: rels.length,
      nodesCreated,
      edgesCreated: refEdges,
      durationMs: Date.now() - started,
    };
  }

  /** Extract + persist one file's nodes, contains edges, and unresolved refs. */
  private indexFile(
    store: GraphStore,
    file: { relPath: string; source: string; size: number; modifiedAt: number },
  ): { nodes: number; contains: number } {
    const now = Date.now();
    const extraction = extractFile(file.relPath, file.source);
    const language = extraction?.language ?? detectLanguage(file.relPath);

    // Always record the file (even with zero symbols) so change detection and
    // graceful degradation know it was seen.
    const record: FileRecord = {
      path: file.relPath,
      contentHash: sha256(file.source),
      language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: now,
      nodeCount: extraction?.nodes.length ?? 0,
    };
    store.upsertFile(record);
    if (!extraction) return { nodes: 0, contains: 0 };

    const sourceLines = file.source.split("\n");

    for (const extracted of extraction.nodes) {
      const node: GraphNode = {
        ...extracted,
        bodyHash: BODY_KINDS.has(extracted.kind)
          ? bodyHash(sourceLines, extracted.startLine, extracted.endLine)
          : undefined,
        updatedAt: now,
      };
      store.insertNode(node);
    }

    let contains = 0;
    for (const edge of extraction.edges) {
      if (edge.target) {
        // Fully-resolved intra-file edge (contains) — persist directly.
        store.insertEdge(edge as GraphEdge);
        contains++;
      } else if (edge.targetName) {
        // Cross-file candidate — park for the resolution pass.
        const ref: UnresolvedRefRecord = {
          fromNodeId: edge.source,
          referenceName: edge.targetName,
          referenceKind: edge.kind,
          filePath: file.relPath,
          language,
          line: edge.line,
          column: edge.column,
          candidates: edge.candidates,
        };
        store.insertUnresolvedRef(ref);
      }
    }
    return { nodes: extraction.nodes.length, contains };
  }

  /** Resolve every parked reference to a node id and persist the edges. */
  private resolveAll(store: GraphStore, root: string): number {
    const nodes = store.getAllNodes();
    const refs = store.getAllUnresolvedRefs();
    const context = createResolutionContext(store, root);
    const resolvers = FRAMEWORK_RESOLVERS.filter((resolver) => resolver.detect(context));
    const edges = resolveReferences(nodes, refs, { resolvers, context });
    store.transaction(() => {
      for (const edge of edges) store.insertEdge(edge);
    });
    return edges.length;
  }

  /** Run optional framework extraction after language nodes exist. */
  private extractFrameworkNodes(store: GraphStore, root: string, filePaths: readonly string[]): void {
    const context = createResolutionContext(store, root);
    const resolvers = FRAMEWORK_RESOLVERS.filter((resolver) => resolver.detect(context));
    for (const filePath of filePaths) {
      let content: string;
      try { content = readFileSync(resolve(root, filePath), "utf-8"); } catch { continue; }
      const language = detectLanguage(filePath);
      for (const resolver of resolvers) {
        if (!resolver.extract || (resolver.languages && !resolver.languages.includes(language))) continue;
        const extracted = resolver.extract(filePath, content);
        for (const node of extracted.nodes) {
          store.insertNode(node);
          const fileNode = store.getNodeById(`file:${filePath}`);
          if (fileNode) store.insertEdge({ source: fileNode.id, target: node.id, kind: "contains", provenance: "heuristic" });
        }
        for (const ref of extracted.references) {
          store.insertUnresolvedRef({
            fromNodeId: ref.fromNodeId,
            referenceName: ref.referenceName,
            referenceKind: ref.referenceKind,
            filePath: ref.filePath,
            language: ref.language,
            line: ref.line,
            column: ref.column,
            candidates: ref.candidates,
          });
        }
      }
    }
  }

  /** Refresh every body-bearing node after resolution so neighbor ids are final. */
  private refreshFingerprints(store: GraphStore, root: string): void {
    const fingerprints = new FingerprintStore(this.db!);
    const byFile = new Map<string, GraphNode[]>();
    for (const node of store.getAllNodes().filter((entry) => entry.bodyHash)) {
      const nodes = byFile.get(node.filePath) ?? [];
      nodes.push(node);
      byFile.set(node.filePath, nodes);
    }
    for (const [filePath, nodes] of byFile) {
      let source: string;
      try { source = readFileSync(resolve(root, filePath), "utf-8"); } catch { continue; }
      const tokens = normalizedAstTokens(filePath, source, nodes);
      for (const node of nodes) {
        const callers = getCallers(store, node.id).map((entry) => entry.id);
        const callees = getCallees(store, node.id).map((entry) => entry.id);
        fingerprints.upsert(node.id, createFingerprint(tokens.get(node.id) ?? [], callers, callees));
      }
    }
  }

  // --- Reads (synchronous SQL — no grammar work) ----------------------------

  searchNodes(query: string, options?: NodeSearchOptions): GraphNode[] {
    return this.getStore().search(query, options);
  }

  getNode(id: string): GraphNode | null {
    return this.getStore().getNodeById(id);
  }

  getCallers(id: string): GraphNode[] {
    return getCallers(this.getStore(), id);
  }

  getCallees(id: string): GraphNode[] {
    return getCallees(this.getStore(), id);
  }

  close(): void {
    if (this.db) this.db.close();
    this.db = null;
    this.store = null;
  }
}

/** Create the real {@link GraphEngine}. The public factory Track B / Phase 2 use. */
export function createGraphEngine(options: GraphEngineOptions): GraphEngine {
  return new GraphEngineImpl(options);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

interface DiscoveredFile {
  relPath: string;
  source: string;
  size: number;
  modifiedAt: number;
}

/** Every indexable source file under `root`, as project-relative posix paths. */
function discoverSourceFiles(root: string): DiscoveredFile[] {
  const matches = globSync("**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py}", {
    cwd: root,
    ignore: IGNORE_GLOBS,
    nodir: true,
    absolute: false,
    dot: false,
  });
  const files: DiscoveredFile[] = [];
  for (const rel of matches) {
    const posix = toPosix(rel);
    if (!isSupportedSourceFile(posix)) continue;
    const abs = resolve(root, rel);
    try {
      const stat = statSync(abs);
      files.push({
        relPath: posix,
        source: readFileSync(abs, "utf-8"),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    } catch {
      // Unreadable (race / permissions) — skip; never crash a build (spec §7).
    }
  }
  return files;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * body_hash = sha256 of the node's normalized body. Line-independent id means a
 * SAME-id node whose body_hash MOVED is a real edit → drift. Normalization
 * (collapse whitespace) keeps reindentation from reading as a change.
 */
function bodyHash(sourceLines: string[], startLine: number, endLine: number): string {
  const body = sourceLines.slice(startLine - 1, endLine).join("\n");
  const normalized = body.replace(/\s+/g, " ").trim();
  return sha256(normalized);
}
