// The warm path (graph-02): an edit lands in the graph in milliseconds.
//
// A warm checkout keeps, between edits:
//   * a private writable copy of its graph (base plus overlay, materialized),
//   * the compiler program of each project it has edited, alive in its server,
//   * the corpus-wide lookups the finishing pass needs (declaration locations,
//     node names, file nodes), built once from the extraction cache.
// An edit re-captures only the edited file from the live program and stages
// it with the same code a build uses. Files whose nodes gained or lost a
// caller in the edited file (their fingerprints' neighbours change) are staged
// again from their stored captures, as a refresh reuses them. The rows go into
// the private copy, and a new overlay plus pointer is published. Whatever the
// warm path cannot prove it reproduces exactly (an import that changed,
// declarations other files depend on, a removed declaration, another language)
// returns "cold": the caller queues an ordinary refresh instead.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasV5GraphSchema } from "./db/v5.js";
import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import { GraphStore, type FileRecord } from "./db/store.js";
import { warmStaging, type WarmResolutionCorpus, type WarmStagedFile } from "./engine-impl.js";
import { engineWarmDecline } from "./engine-languages.js";
import { decodeCachedExtraction, encodeCachedExtraction } from "./extraction-cache.js";
import {
  captureLocations,
  finishWarmCapture,
  movedLocations,
  normalizedCompilerTokens,
  remapCapture,
  restoreWarmCapture,
  warmCompilerContext,
  warmProjectRequest,
  type CapturedFile,
  type CompilerFileCapture,
  type FileDependencies,
  type WarmCompilerContext,
} from "./extraction/compiler.js";
import { loadTsrsServer, tsgoServer, WarmApiServer } from "./extraction/compiler-api.js";
import { readFileFingerprints, type StoredFingerprint } from "./fingerprint-store.js";
import { normalizeIncrementalReferences } from "./incremental-references.js";
import { discoverGraphConfigSources } from "./manifest.js";
import { recordWrittenGraphAudited } from "./maintenance.js";
import { materializeOverlay } from "./overlay-materialize.js";
import { patchOverlay, writeOverlay } from "./overlay-write.js";
import { applyRowDelta, groupRowsByFile, INCREMENTAL_STATE_METADATA_KEY, incrementalStateMarker } from "./publication-delta.js";
import { createGraphSnapshot, GRAPH_SNAPSHOT_METADATA_KEY, parseGraphSnapshot, readGraphGitProvenance, serializeGraphSnapshot } from "./snapshot.js";
import {
  acquireGraphWriter,
  cloneGraph,
  collectGraphGarbage,
  discardGraphTemporary,
  finalizeGraph,
  graphLocation,
  graphTemporary,
  publishGraphOverlay,
  readGraphPointer,
  type GraphLocation,
  type GraphPointer,
} from "./storage.js";
import type { Fingerprint } from "./reconcile.js";
import type { GraphNode } from "./types.js";

export interface WarmEditResult {
  /** published: a new overlay is live. unchanged: nothing to do. cold: queue a refresh. */
  status: "published" | "unchanged" | "cold";
  reason?: string;
  /** Repository-relative files this edit rewrote, the edited ones first. */
  files: string[];
  /** From the call to the published pointer. */
  ms: number;
  phases: Record<string, number>;
}

export interface WarmGraphCheckout {
  lastEditAt: number;
  edit(paths: readonly string[]): Promise<WarmEditResult>;
  close(): void;
}

/** Use the engine for its v5 publications and keep the compiler route for v4. */
export async function openWarmCheckout(root: string): Promise<WarmGraphCheckout> {
  if (process.env.MEX_GRAPH_STORAGE === "v5") {
    const location = graphLocation(root);
    const pointer = readGraphPointer(location);
    if (pointer) {
      const { NativeWarmCheckout } = await import("./native-warm.js");
      const resident = await NativeWarmCheckout.open(location, pointer);
      if (resident) return resident;
    }
  }
  return WarmCheckout.open(root);
}

/** What one compiler file's stored capture says, kept for every corpus file. */
interface FileFacts {
  projectId: string;
  dependencies: string[];
  failedLookups: string[];
  globalScope: boolean;
  /** Dependency → its declaration signature as this file's program saw it. */
  signatures: Map<string, string>;
  nodeIds: string[];
  /** Absolute declaration locations this file contributes. */
  locations: string[];
  /** Repository files whose declarations this file's references point at. */
  referenced: string[];
}

/** The repository file a portable location is in, or undefined outside the repository. */
function locationFile(location: string): string | undefined {
  if (!location.startsWith("./")) return undefined;
  const kind = location.lastIndexOf(":");
  return location.slice(2, location.lastIndexOf(":", kind - 1));
}

const CONFIG_FILE = /(^|\/)(tsconfig[^/]*\.json|jsconfig[^/]*\.json|package\.json)$/u;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const toPosix = (path: string): string => path.replaceAll("\\", "/");
const byPath = (left: GraphNode, right: GraphNode): number => (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0);

class Cold extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** One checkout kept warm in the background process. */
export class WarmCheckout {
  readonly root: string;
  readonly location: GraphLocation;
  lastEditAt = Date.now();
  /** An edit went cold: the private copy may no longer match what is published. */
  dirty = false;
  private readonly rootPrefix: string;
  private pointer: GraphPointer;
  private readonly working: string;
  private readonly db: SqliteDatabase;
  private readonly store: GraphStore;
  private readonly facts = new Map<string, FileFacts>();
  private readonly importers = new Map<string, Set<string>>();
  /** File → the files whose stored captures refer to its declarations. */
  private readonly referrers = new Map<string, Set<string>>();
  private readonly locationIds = new Map<string, string>();
  private readonly nodeNames = new Map<string, { name: string; qualifiedName: string }>();
  private readonly fileDraftIds = new Map<string, string>();
  private compiler: WarmApiServer | undefined;
  private compilerContext: WarmCompilerContext | undefined;
  private readonly projectCompilers: Record<string, string>;
  private readonly configSources: Map<string, string>;
  private overlayFiles = new Set<string>();
  private corpusNodes: GraphNode[] | undefined;
  private corpusIds: Map<string, string[]> | undefined;
  private collectedAt = 0;
  private closed = false;

  private constructor(root: string, location: GraphLocation, pointer: GraphPointer, working: string, db: SqliteDatabase) {
    this.root = root;
    this.location = location;
    this.rootPrefix = `${toPosix(root)}/`;
    this.pointer = pointer;
    this.working = working;
    this.db = db;
    this.store = new GraphStore(db);
    this.configSources = discoverGraphConfigSources(root);
    let report: { projects?: Record<string, string> } = {};
    try { report = JSON.parse(this.store.getMetadata("typescript_compilers") ?? "{}") as typeof report; } catch { /* no report */ }
    this.projectCompilers = report.projects ?? {};
  }

  /** Make a checkout warm: materialize its graph privately and read the lookups. */
  static open(rootDir: string): WarmCheckout {
    const configured = engineWarmDecline();
    if (configured) throw new Error(configured);
    const root = resolve(rootDir);
    const location = graphLocation(root);
    const pointer = readGraphPointer(location);
    if (!pointer) throw new Error("The checkout has no published graph.");
    const base = join(location.directory, pointer.base);
    const opened = openSqlite(base, { immutable: true, readOnly: true });
    try {
      if (hasV5GraphSchema(opened)) throw new Error("Schema v5 graphs use the resident warm checkout.");
    } finally { opened.close(); }
    const working = graphTemporary(location);
    cloneGraph(base, working);
    const db = openSqlite(working);
    try {
      db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16384; PRAGMA foreign_keys = OFF;");
      const checkout = new WarmCheckout(root, location, pointer, working, db);
      if (pointer.overlay) checkout.applyOverlay(join(location.directory, pointer.overlay));
      const stored = engineWarmDecline(checkout.store.getMetadata("extractor_version") ?? undefined);
      if (stored) throw new Error(stored);
      db.exec("PRAGMA foreign_keys = ON;");
      checkout.readLookups();
      return checkout;
    } catch (error) {
      try { db.close(); } catch { /* closing */ }
      discardGraphTemporary(working);
      throw error;
    }
  }

  /** Base plus overlay into the private copy: exactly what readers see. */
  private applyOverlay(overlay: string): void {
    this.overlayFiles = new Set(materializeOverlay(this.db, overlay, (path, hash) => {
      const text = this.readText(path);
      if (text === undefined || sha256(text) !== hash) throw new Error(`${path} changed since the last refresh.`);
      return text;
    }));
  }

  /** Corpus lookups from the extraction cache, one stored capture at a time. */
  private readLookups(): void {
    for (const row of this.db.prepare("SELECT payload FROM file_extraction_cache").iterate() as Iterable<{ payload: Uint8Array }>) {
      const entry = decodeCachedExtraction(row.payload);
      if (entry?.kind === "compiler") this.learn(entry.capture);
    }
  }

  private learn(capture: CompilerFileCapture): void {
    const absolute = (location: string): string => location.startsWith("./") ? `${this.rootPrefix}${location.slice(2)}` : location;
    const previous = this.facts.get(capture.filePath);
    if (previous) {
      for (const location of previous.locations) this.locationIds.delete(location);
      for (const id of previous.nodeIds) this.nodeNames.delete(id);
      for (const dependency of previous.dependencies) this.importers.get(dependency)?.delete(capture.filePath);
      for (const file of previous.referenced) this.referrers.get(file)?.delete(capture.filePath);
    }
    const referenced = new Set<string>();
    for (const location of captureLocations(capture)) {
      const file = locationFile(location);
      if (file !== undefined && file !== capture.filePath) referenced.add(file);
    }
    for (const file of referenced) {
      let set = this.referrers.get(file);
      if (!set) this.referrers.set(file, set = new Set());
      set.add(capture.filePath);
    }
    const locations: string[] = [];
    for (const [location, id] of capture.locations) {
      const key = absolute(location);
      this.locationIds.set(key, id);
      locations.push(key);
    }
    for (const node of capture.nodes) this.nodeNames.set(node.id, { name: node.name, qualifiedName: node.qualifiedName });
    if (capture.fileDraftId) this.fileDraftIds.set(capture.filePath, capture.fileDraftId);
    else this.fileDraftIds.delete(capture.filePath);
    for (const dependency of capture.dependencies) {
      let set = this.importers.get(dependency);
      if (!set) this.importers.set(dependency, set = new Set());
      set.add(capture.filePath);
    }
    this.facts.set(capture.filePath, {
      projectId: capture.projectId,
      dependencies: [...capture.dependencies],
      failedLookups: [...capture.failedLookups],
      globalScope: capture.globalScope,
      signatures: new Map(capture.dependencySignatures ?? []),
      nodeIds: capture.nodes.map((node) => node.id),
      locations,
      referenced: [...referenced],
    });
  }

  private readText(path: string): string | undefined {
    try { return readFileSync(join(this.root, path), "utf8"); } catch { return undefined; }
  }

  /** The stored (portable) capture of one file, from the private copy's cache. */
  private storedCapture(path: string): CompilerFileCapture | undefined {
    const row = this.db.prepare("SELECT payload FROM file_extraction_cache WHERE path = ?").get(path) as { payload: Uint8Array } | undefined;
    const entry = row ? decodeCachedExtraction(row.payload) : null;
    return entry?.kind === "compiler" ? entry.capture : undefined;
  }

  /**
   * The checkout's compiler, with a program for each of `projectIds`: built on
   * first use and kept. Every project must be built by the same TypeScript 7
   * server the last build used.
   */
  private async programs(projectIds: Iterable<string>): Promise<WarmApiServer> {
    const wanted = [...new Set(projectIds)];
    const names = new Set(wanted.map((projectId) => this.projectCompilers[projectId] ?? ""));
    if (names.size !== 1) throw new Cold("the projects are built by different compilers");
    const [name] = [...names];
    if (!name!.startsWith("tsrs-") && !name!.startsWith("tsgo-")) throw new Cold("the project is not built by a TypeScript 7 server");
    if (!this.compiler) {
      this.compilerContext = warmCompilerContext(this.root, [...this.facts.keys()], {
        readProjectFile: (absolute) => warmStaging.readProjectFile(this.root, absolute),
      });
      const server = name!.startsWith("tsrs-") ? await loadTsrsServer() : tsgoServer();
      this.compiler = new WarmApiServer(server, this.compilerContext.root, this.compilerContext.inputs);
    }
    if (!name!.startsWith(`${this.compiler.server.name}-`)) throw new Cold("the projects are built by different compilers");
    for (const projectId of wanted) {
      if (this.compiler.has(projectId)) continue;
      const ownedElsewhere = new Set<string>();
      for (const [path, facts] of this.facts) if (facts.projectId !== projectId) ownedElsewhere.add(`${this.rootPrefix}${path}`);
      const request = warmProjectRequest(this.compilerContext!, projectId, ownedElsewhere);
      if (!request) throw new Cold("the project's configuration changed");
      try { this.compiler.add(request); } catch (error) { throw new Cold(`the project's program could not be built: ${(error as Error).message}`); }
    }
    return this.compiler;
  }

  /** Programs this checkout keeps alive in its compiler server. */
  get projectCount(): number {
    return this.compiler?.size ?? 0;
  }

  /** Every other file's nodes (plus nodes already staged), in corpus order, for resolution. */
  private corpus(excluded: ReadonlySet<string>, extra: readonly GraphNode[]): WarmResolutionCorpus {
    this.corpusNodes ??= this.store.getAllNodes().sort(byPath);
    const others = [...this.corpusNodes.filter((node) => !excluded.has(node.filePath)), ...extra].sort(byPath);
    const paths = (this.db.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>).map((row) => row.path);
    return {
      paths,
      merge: (staged) => [...others, ...staged].sort(byPath),
      readFile: (path) => this.readText(path) ?? null,
    };
  }

  /**
   * Apply edits to `paths` (repository-relative or absolute). Never throws for
   * an edit it cannot handle: it returns "cold" with the reason.
   */
  async edit(paths: readonly string[]): Promise<WarmEditResult> {
    const started = performance.now();
    const phases: Record<string, number> = {};
    let mark = started;
    const phase = (name: string): void => { const now = performance.now(); phases[name] = Math.round((now - mark) * 10) / 10; mark = now; };
    this.lastEditAt = Date.now();
    const done = (status: WarmEditResult["status"], files: string[], reason?: string): WarmEditResult =>
      ({ status, ...(reason ? { reason } : {}), files, ms: Math.round((performance.now() - started) * 10) / 10, phases });
    try {
      if (this.closed || this.dirty) throw new Cold("the warm checkout must be opened again");
      const configured = engineWarmDecline();
      if (configured) throw new Cold(configured);
      const pointer = readGraphPointer(this.location);
      if (!pointer || pointer.base !== this.pointer.base || pointer.overlay !== this.pointer.overlay) throw new Cold("the graph was published by another writer");
      const relative = [...new Set(paths.map((path) => toPosix(path).startsWith(this.rootPrefix) ? toPosix(path).slice(this.rootPrefix.length) : toPosix(path)))].sort();
      const texts = new Map<string, { text: string; hash: string; size: number; modifiedAt: number }>();
      for (const path of relative) {
        if (CONFIG_FILE.test(path)) throw new Cold(`${path} configures the build`);
        const record = this.store.getFileRecord(path);
        const facts = this.facts.get(path);
        if (!record || !facts) {
          if (!existsSync(join(this.root, path))) {
            if (record) throw new Cold(`${path} was deleted`);
            continue; // never in the graph, and still absent
          }
          throw new Cold(warmStaging.isCompilerPath(path) ? `${path} is new` : `${path} is not TypeScript or JavaScript`);
        }
        if (facts.globalScope) throw new Cold(`${path} declares globals`);
        let text: string;
        let stat;
        try { text = readFileSync(join(this.root, path), "utf8"); stat = statSync(join(this.root, path)); } catch { throw new Cold(`${path} was deleted`); }
        const hash = sha256(text);
        if (hash === record.contentHash) continue;
        texts.set(path, { text, hash, size: stat.size, modifiedAt: stat.mtimeMs });
      }
      if (texts.size === 0) return done("unchanged", []);
      phase("read");

      // Capture each edited file from its project's live program. Every
      // project that imports it checks whether its declarations changed.
      const captured = new Map<string, { file: CapturedFile; dependencies: FileDependencies; signatures: Array<[string, string]> }>();
      const needed = new Set<string>();
      for (const path of texts.keys()) {
        needed.add(this.facts.get(path)!.projectId);
        for (const importer of this.importers.get(path) ?? []) needed.add(this.facts.get(importer)!.projectId);
      }
      const compiler = await this.programs(needed);
      compiler.update(new Map([...texts].map(([path, { text }]) => [`${this.rootPrefix}${path}`, text])));
      phase("update");
      const sessions = new Map<string, ReturnType<WarmApiServer["session"]>>();
      const session = (projectId: string): ReturnType<WarmApiServer["session"]> => {
        let value = sessions.get(projectId);
        if (!value) sessions.set(projectId, value = compiler.session(projectId));
        return value;
      };
      try {
        for (const path of texts.keys()) {
          const absolute = `${this.rootPrefix}${path}`;
          const before = this.facts.get(path)!;
          const own = session(before.projectId);
          const dependencies = own.fileDependencies(absolute);
          if (!dependencies) throw new Cold(`${path} left its project`);
          if (dependencies.globalScope || !sameList(dependencies.dependencies, before.dependencies) || !sameList(dependencies.failedLookups, before.failedLookups)) {
            throw new Cold(`the edit changed what ${path} imports`);
          }
          const byProject = new Map<string, string[]>();
          for (const importer of this.importers.get(path) ?? []) {
            const projectId = this.facts.get(importer)!.projectId;
            byProject.set(projectId, [...(byProject.get(projectId) ?? []), importer]);
          }
          for (const [projectId, importers] of byProject) {
            const signature = session(projectId).declarationSignature(path);
            if (signature === undefined || importers.some((importer) => this.facts.get(importer)!.signatures.get(path) !== signature)) {
              throw new Cold(`the edit changed declarations other files import from ${path}`);
            }
          }
          const signatures: Array<[string, string]> = [];
          let file: CapturedFile | undefined;
          own.capture([absolute], {
            location: () => {},
            node: () => {},
            dependencySignatures: () => {
              for (const dependency of dependencies.dependencies) {
                const signature = own.declarationSignature(dependency);
                if (signature !== undefined) signatures.push([dependency, signature]);
              }
            },
            file: (_absolute, value) => { file = value; },
          });
          if (!file) throw new Cold(`${path} was not captured`);
          const ids = new Set(file.nodes.map((node) => node.id));
          if (before.nodeIds.some((id) => !ids.has(id))) throw new Cold(`the edit removed or renamed a declaration in ${path}`);
          captured.set(path, { file, dependencies, signatures });
        }
      } finally {
        for (const value of sessions.values()) value.release();
      }
      phase("capture");

      // Finish and stage each edited file as a build would.
      const edited = new Set(texts.keys());
      const moved = new Map<string, string | null>();
      for (const [path, { file }] of captured) {
        const previous = this.storedCapture(path);
        if (!previous) throw new Cold(`${path} has no stored capture`);
        for (const [from, to] of movedLocations(previous, file, this.rootPrefix)) moved.set(from, to);
        for (const [location, id] of file.locations) this.locationIds.set(location, id);
        for (const node of file.nodes) this.nodeNames.set(node.id, { name: node.name, qualifiedName: node.qualifiedName });
        if (file.fileDraftId) this.fileDraftIds.set(path, file.fileDraftId);
      }
      const lookups = { locationIds: this.locationIds, nodeNames: this.nodeNames, fileDraftIds: this.fileDraftIds };
      const spool = warmStaging.spool();
      const staged: WarmStagedFile[] = [];
      const payloads = new Map<string, { hash: string; payload: Uint8Array }>();
      const sources = new Map<string, string>();
      const learned: CompilerFileCapture[] = [];
      try {
        for (const [path, { file, dependencies, signatures }] of captured) {
          const finished = finishWarmCapture(this.root, file, dependencies, signatures, lookups);
          const { text, hash, size, modifiedAt } = texts.get(path)!;
          spool.stage(path, text);
          sources.set(path, text);
          staged.push(warmStaging.stageCompilerFile({ relPath: path, contentHash: hash, size, modifiedAt }, text, finished.file));
          payloads.set(path, { hash, payload: encodeCachedExtraction({ kind: "compiler", capture: finished.capture }) });
          learned.push(finished.capture);
        }
        phase("stage");
        warmStaging.resolve(this.root, staged, this.configSources, spool, this.corpus(edited, []));
        phase("resolve");

        // Files outside the edit whose nodes gained or lost an edited caller:
        // their fingerprints' neighbours change, so they are staged again from
        // their stored captures, as a refresh reuses them.
        const neighbours = this.neighbourFiles(staged, edited);
        const restaged: WarmStagedFile[] = [];
        for (const path of neighbours) {
          const record = this.store.getFileRecord(path);
          const text = this.readText(path);
          const stored = this.storedCapture(path);
          if (!record || text === undefined || !stored || sha256(text) !== record.contentHash) throw new Cold(`${path} changed since the last refresh`);
          const remapped = remapCapture(stored, moved);
          if (remapped === null) throw new Cold(`${path} refers to a declaration the edit removed`);
          const capture = remapped ?? stored;
          const finished = finishWarmCapture(this.root, restoreWarmCapture(capture, this.root), {
            dependencies: capture.dependencies, failedLookups: capture.failedLookups, globalScope: capture.globalScope,
          }, capture.dependencySignatures ?? [], lookups);
          spool.stage(path, text);
          sources.set(path, text);
          restaged.push(warmStaging.stageCompilerFile({ relPath: path, contentHash: record.contentHash, size: record.size, modifiedAt: record.modifiedAt }, text, finished.file));
          if (remapped) payloads.set(path, { hash: record.contentHash, payload: encodeCachedExtraction({ kind: "compiler", capture: remapped }) });
        }
        const touched = new Set([...edited, ...neighbours]);
        // Files that only point at declarations the edit moved: their rows stay
        // the same, and their stored captures move as a refresh moves the
        // captures it reuses.
        const repointed: string[] = [];
        for (const path of edited) {
          for (const referrer of this.referrers.get(path) ?? []) {
            if (touched.has(referrer) || repointed.includes(referrer)) continue;
            const stored = this.storedCapture(referrer);
            if (!stored) continue;
            const remapped = remapCapture(stored, moved);
            if (remapped === undefined) continue;
            const record = this.store.getFileRecord(referrer);
            const text = this.readText(referrer);
            if (!record || text === undefined || sha256(text) !== record.contentHash) throw new Cold(`${referrer} changed since the last refresh`);
            if (remapped === null) throw new Cold(`${referrer} refers to a declaration the edit removed`);
            payloads.set(referrer, { hash: record.contentHash, payload: encodeCachedExtraction({ kind: "compiler", capture: remapped }) });
            repointed.push(referrer);
          }
        }
        if (restaged.length > 0) {
          warmStaging.resolve(this.root, restaged, this.configSources, spool, this.corpus(touched, staged.flatMap((file) => file.nodes)));
          staged.push(...restaged);
        }
        const otherIds: Array<{ id: string }> = [];
        for (const [path, ids] of this.nodeIdsByFile()) if (!touched.has(path)) for (const id of ids) otherIds.push({ id });
        const others = { record: { path: "", language: "typescript" } as FileRecord, nodes: otherIds, edges: [], references: [], imports: [] };
        normalizeIncrementalReferences([...staged, others]);
        phase("neighbours");

        // Fingerprints: sketches from each file's text, neighbours from the whole graph.
        const previous = new Map<string, StoredFingerprint[]>();
        const sketches = new Map<string, Pick<Fingerprint, "minhash" | "tokenCount">>();
        const records = new Map<string, FileRecord>();
        for (const path of touched) {
          const stored = readFileFingerprints(this.db, path);
          previous.set(path, stored);
          for (const entry of stored) sketches.set(entry.nodeId, { minhash: entry.fingerprint.minhash, tokenCount: entry.fingerprint.tokenCount });
          records.set(path, this.store.getFileRecord(path)!);
        }
        const fingerprints = warmStaging.fingerprints(staged, spool, { fingerprints: sketches, records }, normalizedCompilerTokens);
        const neighbors = this.neighbourhoods(staged, touched);
        for (const entry of fingerprints) entry.fingerprint = { ...entry.fingerprint, neighbors: neighbors(entry.nodeId) };
        const grouped = groupRowsByFile(staged, fingerprints);
        if ("reason" in grouped) throw new Cold(grouped.reason);
        phase("fingerprints");

        const writer = acquireWriter(this.location);
        if (!writer) throw new Cold("another graph writer is running");
        try {
          const records = new Map(staged.map((file) => [file.record.path, file.record]));
          this.db.exec("BEGIN");
          try {
            applyRowDelta(this.store, this.db, {
              rewritten: [...grouped.groups.values()],
              removed: [],
              previousNodes: new Map([...touched].map((path) => [path, this.store.getNodesByFile(path)])),
              previousFingerprints: previous,
              vanished: [],
            }, records, (path) => sources.get(path)!, { partialRecords: true });
            for (const [path, { hash, payload }] of payloads) this.store.setExtractionCacheEntry(path, hash, payload);
            for (const file of staged) {
              this.db.prepare("DELETE FROM coverage WHERE path = ?").run(file.record.path);
              if (file.record.parseStatus === "failed") this.db.prepare("INSERT INTO coverage(path, reason) VALUES (?, 'parse failed')").run(file.record.path);
            }
            phase("write.rows");
            this.updateSnapshot();
            phase("write.snapshot");
            this.db.exec("COMMIT");
          } catch (error) {
            try { this.db.exec("ROLLBACK"); } catch { /* none open */ }
            throw error;
          }
          phase("write");
          for (const capture of learned) this.learn(capture);
          if (this.corpusIds) for (const file of staged) this.corpusIds.set(file.record.path, file.nodes.map((node) => node.id));
          if (this.corpusNodes) {
            this.corpusNodes = [...this.corpusNodes.filter((node) => !touched.has(node.filePath)), ...staged.flatMap((file) => file.nodes)].sort(byPath);
          }
          const rewritten = [...edited, ...neighbours, ...repointed];
          for (const path of rewritten) this.overlayFiles.add(path);
          this.publish(writer, phase, rewritten);
          return done("published", rewritten);
        } finally {
          writer.release();
        }
      } finally {
        spool.dispose();
      }
    } catch (error) {
      // Lookups or the private copy may be half updated: this checkout is
      // opened again after the cold refresh.
      this.dirty = true;
      if (error instanceof Cold) return done("cold", [], error.reason);
      return done("cold", [], `the warm path failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }

  /** Every stored node id by file, kept current across edits. */
  private nodeIdsByFile(): Map<string, string[]> {
    if (!this.corpusIds) {
      this.corpusIds = new Map();
      for (const row of this.db.prepare("SELECT file_path, id FROM nodes").iterate() as Iterable<{ file_path: string; id: string }>) {
        const ids = this.corpusIds.get(row.file_path);
        if (ids) ids.push(row.id);
        else this.corpusIds.set(row.file_path, [row.id]);
      }
    }
    return this.corpusIds;
  }

  /** Files outside the edit owning a node whose set of edited callers changed. */
  private neighbourFiles(staged: readonly WarmStagedFile[], edited: ReadonlySet<string>): string[] {
    // Stored calls out of the edited files' nodes (index on source), to nodes elsewhere.
    const before = new Map<string, Set<string>>();
    const callees = this.db.prepare("SELECT e.target, t.file_path AS file FROM edges e JOIN nodes t ON t.id = e.target WHERE e.source = ? AND e.kind = 'calls'");
    for (const path of edited) {
      for (const id of this.nodeIdsByFile().get(path) ?? []) {
        for (const row of callees.all(id) as Array<{ target: string; file: string }>) {
          if (edited.has(row.file)) continue;
          const set = before.get(row.target) ?? new Set<string>();
          set.add(id);
          before.set(row.target, set);
        }
      }
    }
    const editedIds = new Set(staged.flatMap((file) => file.nodes.map((node) => node.id)));
    const after = new Map<string, Set<string>>();
    for (const edge of staged.flatMap((file) => file.edges)) {
      if (edge.kind !== "calls" || editedIds.has(edge.target)) continue;
      const set = after.get(edge.target) ?? new Set<string>();
      set.add(edge.source);
      after.set(edge.target, set);
    }
    const files = new Set<string>();
    for (const target of new Set([...before.keys(), ...after.keys()])) {
      const left = [...(before.get(target) ?? [])].sort().join("\n");
      const right = [...(after.get(target) ?? [])].sort().join("\n");
      if (left === right) continue;
      const row = this.db.prepare("SELECT file_path FROM nodes WHERE id = ?").get(target) as { file_path: string } | undefined;
      if (!row) throw new Cold("a called node is missing from the graph");
      files.add(row.file_path);
    }
    for (const path of files) if (!this.facts.has(path)) throw new Cold(`${path} is not a compiler file the warm path can stage`);
    return [...files].sort();
  }

  /**
   * Callers and callees of every staged node, as a build computes them over
   * all edges: stored `calls` edges from unstaged files, plus the staged
   * files' new edges.
   */
  private neighbourhoods(staged: readonly WarmStagedFile[], touched: ReadonlySet<string>): (id: string) => string[] {
    const sets = new Map<string, Set<string>>();
    const add = (key: string, value: string): void => {
      let set = sets.get(key);
      if (!set) sets.set(key, set = new Set());
      set.add(value);
    };
    for (const edge of staged.flatMap((file) => file.edges)) {
      if (edge.kind !== "calls") continue;
      add(edge.source, edge.target);
      add(edge.target, edge.source);
    }
    // Stored callers of each staged node, from files that were not staged (index on target).
    const callers = this.db.prepare("SELECT e.source, s.file_path AS file FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind = 'calls'");
    for (const id of staged.flatMap((file) => file.nodes.map((node) => node.id))) {
      for (const row of callers.all(id) as Array<{ source: string; file: string }>) if (!touched.has(row.file)) add(id, row.source);
    }
    return (id) => [...(sets.get(id) ?? [])].sort();
  }

  /** The snapshot a build would record for the private copy's current files. */
  private updateSnapshot(): void {
    const snapshot = parseGraphSnapshot(this.store.getMetadata(GRAPH_SNAPSHOT_METADATA_KEY));
    if (!snapshot) throw new Cold("the graph has no snapshot");
    const sources = this.store.getAllFileRecords().map((record) => ({ path: record.path, contentHash: record.contentHash, parseStatus: record.parseStatus ?? "ok" }));
    const git = readGitRefs(this.root) ?? readGraphGitProvenance(this.root);
    const next = createGraphSnapshot({
      indexedAt: new Date().toISOString(),
      git: git.unreadable ? { branch: snapshot.indexedBranch, head: snapshot.indexedHead } : git,
      schemaVersion: snapshot.schemaVersion,
      compilerVersion: snapshot.compilerVersion,
      extractorVersion: snapshot.extractorVersion,
      resolverVersion: snapshot.resolverVersion,
      grammarHash: snapshot.grammarHash,
      configHash: snapshot.configHash,
      manifestHash: snapshot.manifestHash,
      sources,
      semanticInputs: snapshot.semanticInputs,
    });
    const serialized = serializeGraphSnapshot(next);
    this.store.setMetadata(GRAPH_SNAPSHOT_METADATA_KEY, serialized);
    this.store.setMetadata(INCREMENTAL_STATE_METADATA_KEY, incrementalStateMarker(serialized));
  }

  /** Write the overlay of the private copy against the base, and point at it. */
  private publish(writer: { assertOwned(): void }, phase: (name: string) => void, rewritten: readonly string[]): void {
    const overlay = graphTemporary(this.location);
    const base = join(this.location.directory, this.pointer.base);
    try {
      // An existing overlay is copied and only the rewritten files replaced.
      const failed = this.pointer.overlay
        ? patchOverlay({ base, previous: join(this.location.directory, this.pointer.overlay), refreshed: this.working, target: overlay, root: this.root, files: [...rewritten].sort() })
        : writeOverlay({ base, refreshed: this.working, target: overlay, root: this.root, files: [...this.overlayFiles].sort() });
      if (failed) throw new Cold(failed.reason);
      phase("publish.overlay");
      finalizeGraph(overlay);
      phase("publish.finalize");
      writer.assertOwned();
      const counts = this.db.prepare("SELECT (SELECT count(*) FROM nodes) nodes, (SELECT count(*) FROM edges) edges, (SELECT count(*) FROM files) files").get() as { nodes: number; edges: number; files: number };
      const published = publishGraphOverlay(this.location, overlay, this.pointer.base, {
        head: parseGraphSnapshot(this.store.getMetadata(GRAPH_SNAPSHOT_METADATA_KEY))?.indexedHead ?? null,
        files: counts.files, nodes: counts.nodes, edges: counts.edges,
        build: { finishedAt: new Date().toISOString(), overlayFiles: this.overlayFiles.size, warm: true },
      });
      phase("publish.pointer");
      recordWrittenGraphAudited(published);
      phase("publish.audit");
      const pointer = readGraphPointer(this.location);
      if (pointer) this.pointer = pointer;
    } finally {
      discardGraphTemporary(overlay);
    }
    // Old overlays are collected now and then, not on every edit.
    if (Date.now() - this.collectedAt > 30_000) {
      this.collectedAt = Date.now();
      try { collectGraphGarbage(this.location); } catch { /* the next writer collects */ }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.compiler?.close();
    this.compiler = undefined;
    try { this.db.close(); } catch { /* closing */ }
    discardGraphTemporary(this.working);
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function acquireWriter(location: GraphLocation): { assertOwned(): void; release(): void } | undefined {
  try { return acquireGraphWriter(location); } catch { return undefined; }
}

/**
 * Branch and HEAD read from the repository's files (about a millisecond, no
 * process): HEAD, then the loose ref or packed-refs. Undefined for anything
 * unusual, and the caller asks git instead.
 */
function readGitRefs(root: string): { branch: string | null; head: string | null; unreadable?: true } | undefined {
  try {
    let directory = root;
    let dotGit: string | undefined;
    for (;;) {
      const candidate = join(directory, ".git");
      if (existsSync(candidate)) { dotGit = candidate; break; }
      const parent = resolve(directory, "..");
      if (parent === directory) return undefined;
      directory = parent;
    }
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const line = readFileSync(dotGit, "utf8").trim();
      if (!line.startsWith("gitdir: ")) return undefined;
      gitDir = resolve(directory, line.slice("gitdir: ".length));
    }
    const commonFile = join(gitDir, "commondir");
    const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const hash = /^[a-f0-9]{40,64}$/u;
    if (!head.startsWith("ref: ")) return hash.test(head) ? { branch: null, head } : undefined;
    const ref = head.slice("ref: ".length);
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    const loose = join(commonDir, ...ref.split("/"));
    if (existsSync(loose)) {
      const value = readFileSync(loose, "utf8").trim();
      return hash.test(value) ? { branch, head: value } : undefined;
    }
    const packed = join(commonDir, "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split("\n").map((entry) => entry.trim())) {
        const [value, name] = line.split(" ");
        if (name === ref && value && hash.test(value)) return { branch, head: value };
      }
    }
    return { branch, head: null };
  } catch {
    return undefined;
  }
}
