import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { globSync } from "glob";
import { toPosix } from "../paths.js";
import type { BuildResult, GraphEngine, NodeSearchOptions } from "./engine.js";
import { DB_SCHEMA_VERSION, markGraphReady, openGraphDatabase } from "./db/database.js";
import {
  GraphStore,
  type FileRecord,
  type ImportBindingRecord,
  type NodeAliasRecord,
  type UnresolvedRefRecord,
} from "./db/store.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import {
  buildTypeScriptExtraction,
  canonicalNodeIdentity,
  detectLanguage,
  extractFile,
  grammarManifestHash,
  isSupportedSourceFile,
  loadGrammars,
  normalizedAstTokens,
  normalizedCompilerTokens,
  SUPPORTED_SOURCE_GLOB,
  TYPESCRIPT_COMPILER_EXTRACTOR_VERSION,
  TYPESCRIPT_COMPILER_VERSION,
  type CompilerExtractedNode,
  type CompilerExtractionResult,
  type CompilerFileExtraction,
} from "./extraction/index.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { createFingerprintBuilder } from "./fingerprint.js";
import { MIN_TOKENS } from "./config.js";
import { minhashJaccard } from "./reconcile-engine.js";
import type { Fingerprint } from "./reconcile.js";
import { createStagedResolutionContext } from "./resolution/context.js";
import { FRAMEWORK_RESOLVERS } from "./resolution/frameworks/index.js";
import { resolveReferences } from "./resolution/resolver.js";
import { getCallees, getCallers, getIncoming, getOutgoing } from "./traversal/traversal.js";
import type { GraphEdge, GraphNode, Language, ReferenceKind } from "./types.js";

const IGNORE_GLOBS = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.mex/**",
  "**/coverage/**", "**/.next/**", "**/out/**",
];

const BODY_KINDS = new Set<GraphNode["kind"]>([
  "function", "method", "class", "interface", "enum", "type_alias", "struct",
  "trait", "protocol", "constant", "variable", "component",
]);

const COMPILER_LANGUAGES = new Set<Language>(["typescript", "javascript", "tsx", "jsx"]);
const RESOLVER_VERSION = "compiler-first-v2";
const TREE_SITTER_EXTRACTOR_VERSION = "tree-sitter-v2";
const CORPUS_EXTRACTOR_VERSION = `${TYPESCRIPT_COMPILER_EXTRACTOR_VERSION}+${TREE_SITTER_EXTRACTOR_VERSION}`;

export interface GraphEngineOptions {
  rootDir: string;
  dbPath?: string;
  /** Query-only engine for sandboxed agent commands. Build/sync are unavailable. */
  readOnly?: boolean;
  /** Injectable source-file access for embedders and deterministic fault tests. */
  sourceFileAccess?: Partial<GraphSourceFileAccess>;
}

export interface GraphSourceFileAccess {
  stat(absolutePath: string): { size: number; mtimeMs: number };
  read(absolutePath: string): string;
}

export interface GraphSourceStagingFailure {
  filePath: string;
  operation: "stat" | "read" | "discover";
  code?: string;
  message: string;
}

/** A structural sync never publishes a corpus whose source discovery was incomplete. */
export class GraphSourceStagingError extends Error {
  readonly code = "GRAPH_SOURCE_STAGING_FAILED";

  constructor(readonly failures: GraphSourceStagingFailure[]) {
    super(`Could not stage ${failures.length} source file(s): ${failures.map((failure) => failure.filePath).join(", ")}`);
    this.name = "GraphSourceStagingError";
  }
}

const NODE_SOURCE_FILE_ACCESS: GraphSourceFileAccess = {
  stat: (absolutePath) => statSync(absolutePath),
  read: (absolutePath) => readFileSync(absolutePath, "utf-8"),
};

interface DiscoveredFile {
  relPath: string;
  source: string;
  size: number;
  modifiedAt: number;
}

interface StagedFile {
  discovered: DiscoveredFile;
  record: FileRecord;
  nodes: GraphNode[];
  edges: GraphEdge[];
  references: UnresolvedRefRecord[];
  imports: ImportBindingRecord[];
  compilerNodes?: CompilerExtractedNode[];
}

interface StagedCorpus {
  files: StagedFile[];
  compiler: CompilerExtractionResult;
  fingerprints: Array<{ nodeId: string; fingerprint: Fingerprint }>;
  manifestHash: string;
  configHash: string;
  grammarHash: string;
}

export interface GraphManifest {
  manifestHash: string;
  configHash: string;
  grammarHash: string;
}

class GraphEngineImpl implements GraphEngine {
  private readonly rootDir: string;
  private readonly dbPath: string;
  private readonly readOnly: boolean;
  private readonly sourceFileAccess: GraphSourceFileAccess;
  private db: SqliteDatabase | null = null;
  private store: GraphStore | null = null;

  constructor(options: GraphEngineOptions) {
    this.rootDir = resolve(options.rootDir);
    this.dbPath = options.dbPath ?? resolve(this.rootDir, ".mex", "graph.db");
    this.readOnly = options.readOnly ?? false;
    this.sourceFileAccess = { ...NODE_SOURCE_FILE_ACCESS, ...options.sourceFileAccess };
  }

  private getStore(allowRebuild = false): GraphStore {
    if (!this.store) {
      this.db = openGraphDatabase(this.dbPath, { allowRebuild, readOnly: this.readOnly });
      this.store = new GraphStore(this.db);
    }
    return this.store;
  }

  async build(rootDir?: string): Promise<BuildResult> {
    if (this.readOnly) throw new Error("A read-only graph engine cannot build an index.");
    const started = Date.now();
    const root = rootDir ? resolve(rootDir) : this.rootDir;
    const staged = await stageCorpus(root, undefined, this.sourceFileAccess);
    const result = this.publish(staged);
    return { ...result, durationMs: Date.now() - started };
  }

  async sync(changedFiles: string[]): Promise<BuildResult> {
    if (this.readOnly) throw new Error("A read-only graph engine cannot synchronize an index.");
    const started = Date.now();
    const changed = [...new Set(changedFiles.map((file) =>
      toPosix(relative(this.rootDir, resolve(this.rootDir, file))),
    ).filter((file) => file && !file.startsWith("..")))].sort();
    const changedSources = changed.filter(isSupportedSourceFile);
    const deletedChangedSources = inspectChangedSources(this.rootDir, changedSources, this.sourceFileAccess);
    const manifest = graphManifest(this.rootDir);
    const manifestChanged = this.getStore(true).getMetadata("manifest_hash") !== manifest.manifestHash;
    if (changedSources.length === 0 && !manifestChanged) {
      return { filesIndexed: 0, nodesCreated: 0, edgesCreated: 0, durationMs: Date.now() - started };
    }

    // Re-stage the whole semantic corpus. This makes an arbitrary sync sequence
    // converge to the same graph as a clean build and re-resolves cross-file refs.
    const staged = await stageCorpus(this.rootDir, manifest, this.sourceFileAccess);
    const stagedByPath = new Map(staged.files.map((file) => [file.record.path, file]));
    const unstagedExisting = changedSources.filter((file) => (
      !deletedChangedSources.has(file) && !stagedByPath.has(file)
    ));
    if (unstagedExisting.length > 0) {
      throw new GraphSourceStagingError(unstagedExisting.map((filePath) => ({
        filePath,
        operation: "discover",
        message: "The changed source still exists but was absent from the staged corpus.",
      })));
    }
    const failedChanged = changedSources.filter((file) => stagedByPath.get(file)?.record.parseStatus === "failed");
    if (failedChanged.length > 0) {
      // Preserve the previous structural snapshot. Scope notices changed hashes
      // and can still return the live files as explicitly text-only evidence.
      const health = healthCounts(staged.files);
      return {
        filesIndexed: 0, nodesCreated: 0, edgesCreated: 0,
        durationMs: Date.now() - started, health,
      };
    }
    const result = this.publish(staged);
    return { ...result, durationMs: Date.now() - started };
  }

  private publish(staged: StagedCorpus): Omit<BuildResult, "durationMs"> {
    const store = this.getStore(true);
    const oldNodes = store.getAllNodes();
    const oldAliases = store.getAllAliases();
    const priorFingerprintStore = new FingerprintStore(this.db!);
    const oldFingerprints = new Map<string, Fingerprint>();
    for (const node of oldNodes) {
      const fingerprint = priorFingerprintStore.get(node.id);
      if (fingerprint) oldFingerprints.set(node.id, fingerprint);
    }
    let edgeCount = 0;
    const expectedNodes = staged.files.reduce((count, file) => count + file.nodes.length, 0);

    store.transaction(() => {
      store.clearDerivedGraph();
      for (const file of staged.files) {
        store.upsertFile(file.record);
        store.replaceSourceChunks(file.record.path, file.discovered.source, file.record.contentHash);
      }
      for (const file of staged.files) for (const node of file.nodes) store.insertNode(node);
      for (const file of staged.files) {
        for (const edge of file.edges) if (store.insertEdge(edge)) edgeCount++;
        for (const reference of file.references) store.insertUnresolvedRef(reference);
        for (const binding of file.imports) store.insertImportBinding(binding);
      }

      new FingerprintStore(this.db!).upsertMany(staged.fingerprints);
      createCompatibilityAliases(
        store, oldNodes, oldAliases, oldFingerprints, new FingerprintStore(this.db!),
      );
      store.rebuildSearchIndex();
      store.validateInvariants(expectedNodes);
      store.setMetadata("compiler_version", staged.compiler.compilerVersion);
      store.setMetadata("extractor_version", CORPUS_EXTRACTOR_VERSION);
      store.setMetadata("resolver_version", RESOLVER_VERSION);
      store.setMetadata("config_hash", staged.configHash);
      store.setMetadata("grammar_hash", staged.grammarHash);
      markGraphReady(this.db!, staged.manifestHash);
    });

    return {
      filesIndexed: staged.files.length,
      nodesCreated: expectedNodes,
      edgesCreated: edgeCount,
      health: healthCounts(staged.files),
    };
  }

  searchNodes(query: string, options?: NodeSearchOptions): GraphNode[] {
    return this.getStore().search(query, options);
  }

  searchSource(query: string, limit = 40) {
    return this.getStore().searchSourceChunks(query, limit).map(({ id: _id, ...hit }) => hit);
  }

  getIndexedFiles() {
    return this.getStore().getAllFileRecords().map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      parseStatus: file.parseStatus ?? "ok",
      diagnosticCount: file.diagnosticCount ?? 0,
      errorCoverage: file.errorCoverage ?? 0,
      nodeCount: file.nodeCount,
    }));
  }

  getNode(id: string): GraphNode | null { return this.getStore().getNodeById(id); }
  getCallers(id: string): GraphNode[] { return getCallers(this.getStore(), id); }
  getCallees(id: string): GraphNode[] { return getCallees(this.getStore(), id); }
  getIncoming(id: string, kinds?: GraphEdge["kind"][]) { return getIncoming(this.getStore(), id, kinds); }
  getOutgoing(id: string, kinds?: GraphEdge["kind"][]) { return getOutgoing(this.getStore(), id, kinds); }

  close(): void {
    if (this.db) this.db.close();
    this.db = null;
    this.store = null;
  }
}

export function createGraphEngine(options: GraphEngineOptions): GraphEngine {
  return new GraphEngineImpl(options);
}

async function stageCorpus(
  root: string,
  manifest = graphManifest(root),
  sourceFileAccess: GraphSourceFileAccess = NODE_SOURCE_FILE_ACCESS,
): Promise<StagedCorpus> {
  const discovered = discoverSourceFiles(root, sourceFileAccess);
  const compilerPaths = discovered.filter((file) => COMPILER_LANGUAGES.has(detectLanguage(file.relPath)))
    .map((file) => file.relPath);
  const compiler = buildTypeScriptExtraction(root, compilerPaths);
  const compilerByPath = new Map(compiler.files.map((file) => [file.filePath, file]));
  const treeLanguages = [...new Set(discovered.map((file) => detectLanguage(file.relPath))
    .filter((language) => !COMPILER_LANGUAGES.has(language)))];
  await loadGrammars(treeLanguages);

  const files = discovered.map((file) => {
    const compilerFile = compilerByPath.get(file.relPath);
    return compilerFile ? stageCompilerFile(file, compilerFile) : stageTreeFile(file);
  });
  stageFrameworkAndFallbackResolution(root, files);
  validateStagedCorpus(files);
  const fingerprints = stageFingerprints(files);
  return { files, compiler, fingerprints, ...manifest };
}

function stageFrameworkAndFallbackResolution(root: string, files: StagedFile[]): void {
  const sourceByPath = new Map(files.map((file) => [file.record.path, file.discovered.source]));
  const initialNodes = files.flatMap((file) => file.nodes);
  const detectionContext = createStagedResolutionContext(initialNodes, root, sourceByPath);
  const resolvers = FRAMEWORK_RESOLVERS.filter((resolver) => resolver.detect(detectionContext));
  const fileNodeByPath = new Map(initialNodes
    .filter((node) => node.kind === "file")
    .map((node) => [node.filePath, node]));

  for (const file of files) {
    if (file.record.parseStatus !== "ok") continue;
    const language = detectLanguage(file.record.path);
    for (const resolver of resolvers) {
      if (!resolver.extract || (resolver.languages && !resolver.languages.includes(language))) continue;
      const extracted = resolver.extract(file.record.path, file.discovered.source);
      for (const rawNode of extracted.nodes) {
        const node: GraphNode = {
          ...rawNode,
          identityKey: rawNode.identityKey ?? canonicalNodeIdentity(
            rawNode.filePath, rawNode.kind, rawNode.qualifiedName,
            `framework:${resolver.name}`, rawNode.signature,
          ),
        };
        file.nodes.push(node);
        const fileNode = fileNodeByPath.get(file.record.path);
        if (fileNode) file.edges.push({
          source: fileNode.id,
          target: node.id,
          kind: "contains",
          line: node.startLine,
          confidence: 0.8,
          provenance: "framework",
          resolutionMethod: resolver.name,
          evidence: [{ wiringSite: { filePath: file.record.path, line: node.startLine } }],
        });
      }
      for (const ref of extracted.references) {
        const wiringSite = {
          filePath: ref.filePath,
          line: ref.line === undefined ? undefined : ref.line + 1,
          column: ref.column,
        };
        const explicitTargets = file.imports
          .filter((binding) => binding.localName === ref.referenceName && binding.targetId)
          .map((binding) => binding.targetId!)
          .filter((id, index, values) => values.indexOf(id) === index);
        const explicitTarget = ref.referenceKind === "function_ref" && explicitTargets.length === 1
          ? explicitTargets[0]
          : undefined;
        const resolverName = resolver.name === "express" ? "express-route-handler" : resolver.name;
        const stagedRef: UnresolvedRefRecord = {
          ...ref,
          line: wiringSite.line,
          resolver: explicitTarget ? resolverName : resolver.name,
          status: explicitTarget ? "resolved" : "pending",
          targetId: explicitTarget,
          confidence: 0.8,
          candidates: explicitTarget ? [explicitTarget] : ref.candidates,
          metadata: { wiringSite, ...(explicitTarget ? { importBinding: ref.referenceName } : {}) },
        };
        file.references.push(stagedRef);
        if (explicitTarget) file.edges.push({
          source: ref.fromNodeId,
          target: explicitTarget,
          kind: "references",
          line: wiringSite.line,
          column: wiringSite.column,
          confidence: 0.8,
          provenance: "framework",
          resolutionMethod: resolverName,
          evidence: [{ resolver: resolverName, wiringSite, importBinding: ref.referenceName }],
        });
      }
    }
    file.record.nodeCount = file.nodes.length;
  }

  const nodes = files.flatMap((file) => file.nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const context = createStagedResolutionContext(nodes, root, sourceByPath);
  const refs = files.flatMap((file) => file.references).filter((ref) =>
    ref.status !== "resolved"
    && !ref.resolver?.startsWith("typescript-")
    && ref.resolver !== "lexical-containment",
  );
  const resolvedEdges = resolveReferences(nodes, refs, { resolvers, context });
  hydrateFallbackImportBindings(files, nodes, nodeById);
  const fileByPath = new Map(files.map((file) => [file.record.path, file]));
  for (const edge of resolvedEdges) {
    const source = nodeById.get(edge.source);
    const stagedFile = source ? fileByPath.get(source.filePath) : undefined;
    if (stagedFile) stagedFile.edges.push(edge);
  }
}

/**
 * Fallback resolvers prove module ownership while resolving import references.
 * Persist that proof on each binding too: namespace imports target the file
 * node, while a uniquely named imported declaration targets the declaration.
 */
function hydrateFallbackImportBindings(
  files: readonly StagedFile[],
  nodes: readonly GraphNode[],
  nodeById: ReadonlyMap<string, GraphNode>,
): void {
  const symbolsByFileAndName = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.kind === "file") continue;
    const key = `${node.filePath}\0${node.name}`;
    const bucket = symbolsByFileAndName.get(key) ?? [];
    bucket.push(node);
    symbolsByFileAndName.set(key, bucket);
  }
  for (const file of files) {
    for (const binding of file.imports) {
      if (binding.resolvedFilePath || binding.targetId) continue;
      const imported = file.references.find((reference) =>
        reference.referenceKind === "imports"
        && reference.referenceName === binding.moduleSpecifier
        && fallbackBindings(reference).some((candidate) =>
          candidate.localName === binding.localName && candidate.importedName === binding.importedName),
      );
      const targetFile = imported?.targetId ? nodeById.get(imported.targetId) : undefined;
      if (!targetFile || targetFile.kind !== "file") continue;
      binding.resolvedFilePath = targetFile.filePath;
      if (binding.importedName === "*") {
        binding.targetId = targetFile.id;
        continue;
      }
      const candidates = symbolsByFileAndName.get(`${targetFile.filePath}\0${binding.importedName}`) ?? [];
      if (candidates.length === 1) binding.targetId = candidates[0]!.id;
    }
  }
}

function validateStagedCorpus(files: readonly StagedFile[]): void {
  const nodes = files.flatMap((file) => file.nodes);
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Graph staging invariant failed: duplicate node id ${node.id}.`);
    ids.add(node.id);
    if (!node.identityKey) throw new Error(`Graph staging invariant failed: ${node.id} has no identity key.`);
    if (identities.has(node.identityKey)) {
      throw new Error(`Graph staging invariant failed: duplicate identity key for ${node.id}.`);
    }
    identities.add(node.identityKey);
  }
  for (const file of files) {
    if (file.record.nodeCount !== file.nodes.length) {
      throw new Error(`Graph staging invariant failed: ${file.record.path} emitted ${file.nodes.length} nodes but reported ${file.record.nodeCount}.`);
    }
    if (file.record.parseStatus === "failed" && file.nodes.length > 0) {
      throw new Error(`Graph staging invariant failed: failed file ${file.record.path} emitted graph claims.`);
    }
    for (const node of file.nodes) {
      if (node.containerId && !ids.has(node.containerId)) {
        throw new Error(`Graph staging invariant failed: dangling container ${node.containerId}.`);
      }
    }
    for (const edge of file.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) {
        throw new Error(`Graph staging invariant failed: dangling ${edge.kind} edge ${edge.source} -> ${edge.target}.`);
      }
    }
    for (const ref of file.references) {
      if (!ids.has(ref.fromNodeId)) {
        throw new Error(`Graph staging invariant failed: dangling reference source ${ref.fromNodeId}.`);
      }
      if (ref.targetId && !ids.has(ref.targetId)) {
        throw new Error(`Graph staging invariant failed: dangling reference target ${ref.targetId}.`);
      }
    }
    for (const binding of file.imports) {
      if (binding.targetId && !ids.has(binding.targetId)) {
        throw new Error(`Graph staging invariant failed: dangling import target ${binding.targetId}.`);
      }
    }
  }
}

function stageFingerprints(staged: readonly StagedFile[]): Array<{ nodeId: string; fingerprint: Fingerprint }> {
  const fingerprintBuilder = createFingerprintBuilder();
  const pending: Array<{ nodeId: string; fingerprint: Fingerprint }> = [];
  const callersByTarget = new Map<string, Set<string>>();
  const calleesBySource = new Map<string, Set<string>>();
  for (const edge of staged.flatMap((file) => file.edges).filter((edge) => edge.kind === "calls")) {
    const callers = callersByTarget.get(edge.target) ?? new Set<string>();
    callers.add(edge.source);
    callersByTarget.set(edge.target, callers);
    const callees = calleesBySource.get(edge.source) ?? new Set<string>();
    callees.add(edge.target);
    calleesBySource.set(edge.source, callees);
  }
  for (const file of staged) {
    const nodes = file.nodes.filter((node) => node.bodyHash);
    if (nodes.length === 0) continue;
    const nodeIds = new Set(nodes.map((node) => node.id));
    const compilerNodes = file.compilerNodes?.filter((node) => nodeIds.has(node.id));
    const tokens = compilerNodes && compilerNodes.length > 0
      ? normalizedCompilerTokens(file.discovered.source, compilerNodes)
      : normalizedAstTokens(file.record.path, file.discovered.source, nodes);
    for (const node of nodes) {
      pending.push({
        nodeId: node.id,
        fingerprint: fingerprintBuilder.create(
          tokens.get(node.id) ?? [],
          [...(callersByTarget.get(node.id) ?? [])],
          [...(calleesBySource.get(node.id) ?? [])],
        ),
      });
    }
  }
  return pending;
}

function stageCompilerFile(discovered: DiscoveredFile, extraction: CompilerFileExtraction): StagedFile {
  const now = Date.now();
  const lines = discovered.source.split("\n");
  const nodes: GraphNode[] = extraction.nodes.map((node) => ({
    id: node.id,
    identityKey: node.identityKey,
    containerId: node.containerId,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    startColumn: node.startColumn,
    endColumn: node.endColumn,
    docstring: node.docstring,
    signature: node.signature,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
    isAbstract: node.isAbstract,
    decorators: node.decorators,
    typeParameters: node.typeParameters,
    returnType: node.returnType,
    bodyHash: BODY_KINDS.has(node.kind) ? bodyHash(lines, node.startLine, node.endLine) : undefined,
    updatedAt: now,
  }));
  const edges: GraphEdge[] = [];
  const references: UnresolvedRefRecord[] = [];
  for (const ref of extraction.references) {
    const reference: UnresolvedRefRecord = {
      refKey: ref.id,
      fromNodeId: ref.sourceId,
      referenceName: ref.targetName,
      referenceKind: ref.kind as ReferenceKind,
      filePath: ref.filePath,
      language: extraction.language,
      line: ref.line + 1,
      column: ref.column,
      candidates: ref.candidates,
      receiver: ref.receiver,
      qualifier: ref.qualifier,
      metadata: ref.evidence,
      status: ref.status,
      targetId: ref.targetId,
      confidence: ref.confidence,
      resolver: ref.resolutionMethod,
    };
    references.push(reference);
    if (ref.status === "resolved" && ref.targetId) {
      edges.push({
        source: ref.sourceId,
        target: ref.targetId,
        kind: ref.kind,
        metadata: { targetName: ref.targetName, targetQualifiedName: ref.targetQualifiedName },
        line: ref.line + 1,
        column: ref.column,
        provenance: ref.provenance,
        confidence: ref.confidence,
        resolutionMethod: ref.resolutionMethod,
        evidence: [ref.evidence],
      });
    }
  }
  const imports: ImportBindingRecord[] = extraction.importBindings.map((binding) => ({
    bindingKey: binding.id,
    filePath: binding.filePath,
    localName: binding.localName,
    importedName: binding.importedName,
    moduleSpecifier: binding.moduleSpecifier,
    resolvedFilePath: binding.resolvedFilePath,
    targetId: binding.targetId,
    isTypeOnly: binding.isTypeOnly,
    metadata: {
      isNamespace: binding.isNamespace, isDefault: binding.isDefault,
      line: binding.line + 1, column: binding.column,
      confidence: binding.confidence, resolutionMethod: binding.resolutionMethod,
    },
  }));
  return {
    discovered,
    record: {
      path: discovered.relPath,
      contentHash: sha256(discovered.source),
      language: extraction.language,
      size: discovered.size,
      modifiedAt: discovered.modifiedAt,
      indexedAt: now,
      nodeCount: nodes.length,
      // File health describes whether structural graph claims are trustworthy.
      // Semantic type errors are useful compiler observations, but treating them
      // as parse/extraction loss makes healthy real-world repositories look
      // corrupt (and would trigger unnecessary agent fallbacks).
      errors: extraction.health.diagnostics
        .slice(0, extraction.health.syntacticDiagnosticCount)
        .map((diagnostic) => ({ ...diagnostic })),
      parseStatus: extraction.health.status,
      diagnosticCount: extraction.health.syntacticDiagnosticCount,
      missingCount: 0,
      errorCoverage: extraction.health.diagnosticByteCoverage,
      extractorVersion: TYPESCRIPT_COMPILER_EXTRACTOR_VERSION,
    },
    nodes,
    edges,
    references,
    imports,
    compilerNodes: extraction.nodes,
  };
}

function stageTreeFile(discovered: DiscoveredFile): StagedFile {
  const now = Date.now();
  const extraction = extractFile(discovered.relPath, discovered.source);
  const language = extraction?.language ?? detectLanguage(discovered.relPath);
  const health = extraction?.health ?? {
    status: "failed" as const, diagnosticCount: 1, missingCount: 0, errorCoverage: 1,
    diagnostics: [{ type: "PARSER_UNAVAILABLE", startLine: 1, endLine: 1 }],
  };
  const containsParents = new Map<string, string>();
  for (const edge of extraction?.edges ?? []) {
    if (edge.kind === "contains" && edge.target) containsParents.set(edge.target, edge.source);
  }
  const lines = discovered.source.split("\n");
  const nodes: GraphNode[] = (extraction?.nodes ?? []).map((node) => ({
    ...node,
    containerId: containsParents.get(node.id),
    identityKey: node.identityKey
      ?? canonicalNodeIdentity(node.filePath, node.kind, node.qualifiedName, node.kind, node.signature),
    bodyHash: BODY_KINDS.has(node.kind) ? bodyHash(lines, node.startLine, node.endLine) : undefined,
    updatedAt: now,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: GraphEdge[] = [];
  const references: UnresolvedRefRecord[] = [];
  for (const edge of extraction?.edges ?? []) {
    if (edge.target) {
      edges.push({
        source: edge.source, target: edge.target, kind: edge.kind as GraphEdge["kind"],
        line: edge.kind === "contains" ? byId.get(edge.target)?.startLine : edge.line === undefined ? undefined : edge.line + 1,
        column: edge.column, metadata: edge.metadata, provenance: "tree-sitter",
        confidence: 1, resolutionMethod: edge.kind === "contains" ? "lexical-containment" : "tree-sitter",
      });
    } else if (edge.targetName) {
      const dot = edge.targetName.lastIndexOf(".");
      references.push({
        fromNodeId: edge.source,
        referenceName: edge.targetName,
        referenceKind: edge.kind,
        filePath: discovered.relPath,
        language,
        line: edge.line === undefined ? undefined : edge.line + 1,
        column: edge.column,
        candidates: edge.candidates,
        receiver: dot > 0 ? edge.targetName.slice(0, dot) : undefined,
        qualifier: dot > 0 ? edge.targetName.slice(0, dot) : undefined,
        metadata: edge.metadata,
        status: "pending",
        resolver: "tree-sitter",
      });
    }
  }
  const imports: ImportBindingRecord[] = references
    .filter((reference) => reference.referenceKind === "imports")
    .flatMap((reference) => fallbackBindings(reference).map((binding) => ({
      bindingKey: `import:${sha256([
        reference.filePath, binding.localName, binding.importedName, reference.referenceName,
      ].join("\0")).slice(0, 32)}`,
      filePath: reference.filePath,
      localName: binding.localName,
      importedName: binding.importedName,
      moduleSpecifier: reference.referenceName,
      isTypeOnly: false,
      metadata: {
        line: reference.line,
        column: reference.column,
        confidence: 1,
        resolutionMethod: "explicit-import",
      },
    })));
  return {
    discovered,
    record: {
      path: discovered.relPath,
      contentHash: sha256(discovered.source),
      language,
      size: discovered.size,
      modifiedAt: discovered.modifiedAt,
      indexedAt: now,
      nodeCount: nodes.length,
      errors: health.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      parseStatus: health.status,
      diagnosticCount: health.diagnosticCount,
      missingCount: health.missingCount,
      errorCoverage: health.errorCoverage,
      extractorVersion: TREE_SITTER_EXTRACTOR_VERSION,
    },
    nodes,
    edges,
    references,
    imports,
  };
}

function fallbackBindings(reference: UnresolvedRefRecord): Array<{ localName: string; importedName: string }> {
  const bindings = reference.metadata?.bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.filter((binding): binding is { localName: string; importedName: string } => {
    if (!binding || typeof binding !== "object") return false;
    const candidate = binding as Record<string, unknown>;
    return typeof candidate.localName === "string" && typeof candidate.importedName === "string";
  });
}

function createCompatibilityAliases(
  store: GraphStore,
  oldNodes: GraphNode[],
  oldAliases: NodeAliasRecord[],
  oldFingerprints: ReadonlyMap<string, Fingerprint>,
  freshFingerprints: FingerprintStore,
): void {
  const fresh = store.getAllNodes();
  const freshIds = new Set(fresh.map((node) => node.id));
  const freshById = new Map(fresh.map((node) => [node.id, node]));
  const byQualified = groupUnique(fresh, (node) => `${node.filePath}\0${node.kind}\0${node.qualifiedName}`);
  const oldBySignature = groupUnique(
    oldNodes.filter((node) => normalizedSignature(node.signature).length > 0),
    compatibilitySignatureKey,
  );
  const bySignature = groupUnique(
    fresh.filter((node) => normalizedSignature(node.signature).length > 0),
    compatibilitySignatureKey,
  );
  const byBody = groupUnique(fresh.filter((node) => node.bodyHash), (node) => `${node.kind}\0${node.bodyHash}`);
  const canonicalMap = new Map<string, string>();
  for (const old of oldNodes) {
    if (freshIds.has(old.id)) {
      canonicalMap.set(old.id, old.id);
      continue;
    }
    const qualified = byQualified.get(`${old.filePath}\0${old.kind}\0${old.qualifiedName}`);
    const signatureKey = normalizedSignature(old.signature) ? compatibilitySignatureKey(old) : undefined;
    const oldSignature = signatureKey ? oldBySignature.get(signatureKey) : undefined;
    const signature = oldSignature?.length === 1 && signatureKey
      ? bySignature.get(signatureKey) : undefined;
    const body = old.bodyHash ? byBody.get(`${old.kind}\0${old.bodyHash}`) : undefined;
    const match = qualified?.length === 1 ? { node: qualified[0]!, method: "qualified-name", confidence: 1 }
      : signature?.length === 1 ? { node: signature[0]!, method: "signature", confidence: 0.98 }
      : body?.length === 1 ? { node: body[0]!, method: "body-hash", confidence: 0.95 }
      : fingerprintAliasMatch(old, oldFingerprints.get(old.id), freshFingerprints, freshById);
    if (!match) continue;
    store.insertAlias(old.id, match.node.id, match.method, match.confidence);
    canonicalMap.set(old.id, match.node.id);
  }
  for (const alias of oldAliases) {
    const canonical = canonicalMap.get(alias.canonicalNodeId);
    if (canonical) store.insertAlias(alias.aliasId, canonical, alias.matchMethod, alias.confidence);
  }
}

function normalizedSignature(signature: string | undefined): string {
  return signature?.replace(/\s+/g, " ").trim() ?? "";
}

/** Signature-only moves require the same unambiguous symbol in both snapshots. */
function compatibilitySignatureKey(node: GraphNode): string {
  return `${node.kind}\0${node.name}\0${normalizedSignature(node.signature)}`;
}

function fingerprintAliasMatch(
  old: GraphNode,
  baseline: Fingerprint | undefined,
  freshFingerprints: FingerprintStore,
  freshById: ReadonlyMap<string, GraphNode>,
): { node: GraphNode; method: string; confidence: number } | null {
  if (!baseline || baseline.tokenCount < MIN_TOKENS) return null;
  const scored = freshFingerprints.lookup(baseline)
    .filter((candidate) => freshById.get(candidate.nodeId)?.kind === old.kind)
    .map((candidate) => ({
      ...candidate,
      node: freshById.get(candidate.nodeId)!,
      score: minhashJaccard(baseline.minhash, candidate.fingerprint.minhash),
    }))
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
  const best = scored[0];
  if (!best || best.score < 0.95) return null;
  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < 0.08) return null;
  return { node: best.node, method: "fingerprint", confidence: best.score };
}

function groupUnique<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const bucket = grouped.get(key(value)) ?? [];
    bucket.push(value);
    grouped.set(key(value), bucket);
  }
  return grouped;
}

function inspectChangedSources(
  root: string,
  changedSources: readonly string[],
  sourceFileAccess: GraphSourceFileAccess,
): Set<string> {
  const deleted = new Set<string>();
  const failures: GraphSourceStagingFailure[] = [];
  for (const relPath of changedSources) {
    try {
      sourceFileAccess.stat(resolve(root, relPath));
    } catch (error) {
      if (isMissingPathError(error)) deleted.add(relPath);
      else failures.push(sourceStagingFailure(relPath, "stat", error));
    }
  }
  if (failures.length > 0) throw new GraphSourceStagingError(failures);
  return deleted;
}

function discoverSourceFiles(root: string, sourceFileAccess: GraphSourceFileAccess): DiscoveredFile[] {
  const matches = globSync(SUPPORTED_SOURCE_GLOB, {
    cwd: root, ignore: IGNORE_GLOBS, nodir: true, absolute: false, dot: false,
  }).map(toPosix).sort();
  const files: DiscoveredFile[] = [];
  const failures: GraphSourceStagingFailure[] = [];
  for (const relPath of matches) {
    if (!isSupportedSourceFile(relPath)) continue;
    let stat: { size: number; mtimeMs: number };
    try {
      stat = sourceFileAccess.stat(resolve(root, relPath));
    } catch (error) {
      failures.push(sourceStagingFailure(relPath, "stat", error));
      continue;
    }
    try {
      files.push({
        relPath,
        source: sourceFileAccess.read(resolve(root, relPath)),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    } catch (error) {
      failures.push(sourceStagingFailure(relPath, "read", error));
    }
  }
  if (failures.length > 0) throw new GraphSourceStagingError(failures);
  return files;
}

function sourceStagingFailure(
  filePath: string,
  operation: GraphSourceStagingFailure["operation"],
  error: unknown,
): GraphSourceStagingFailure {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "") || undefined
    : undefined;
  return {
    filePath,
    operation,
    ...(code ? { code } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "ENOENT" || code === "ENOTDIR";
}

export function graphManifest(root: string): GraphManifest {
  const configPaths = [...new Set(globSync([
    "package.json", "**/package.json", "tsconfig*.json", "**/tsconfig*.json",
    "jsconfig*.json", "**/jsconfig*.json",
  ], {
    cwd: root, ignore: IGNORE_GLOBS, nodir: true,
  }).map(toPosix))].sort();
  const configs = configPaths.map((path) => {
    try { return [path, sha256(readFileSync(resolve(root, path), "utf-8"))]; }
    catch { return [path, "unreadable"]; }
  });
  const configHash = sha256(JSON.stringify(configs));
  const grammarHash = grammarManifestHash();
  const manifestHash = sha256(JSON.stringify({
    db: DB_SCHEMA_VERSION,
    compiler: TYPESCRIPT_COMPILER_VERSION,
    extractor: CORPUS_EXTRACTOR_VERSION,
    resolver: RESOLVER_VERSION,
    grammarHash,
    configHash,
  }));
  return { manifestHash, configHash, grammarHash };
}

function healthCounts(files: StagedFile[]): { ok: number; partial: number; failed: number } {
  return {
    ok: files.filter((file) => file.record.parseStatus === "ok").length,
    partial: files.filter((file) => file.record.parseStatus === "partial").length,
    failed: files.filter((file) => file.record.parseStatus === "failed").length,
  };
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function bodyHash(sourceLines: string[], startLine: number, endLine: number): string {
  return sha256(sourceLines.slice(startLine - 1, endLine).join("\n").replace(/\s+/g, " ").trim());
}
