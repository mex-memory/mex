import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { addGraphCorpusBytes, GRAPH_CONFIG_GLOBS, GRAPH_SUPPORTED_SOURCE_GLOB } from "./corpus-policy.js";
import { reuseV5Coverage } from "./coverage.js";
import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import { ENGINE_GRAPH_SCHEMA_VERSION, hasV5GraphSchema, v5Rows } from "./db/v5.js";
import { captureNativeGraphSource, nativeGraphSourcePaths, preciseSourceIdentity } from "./engine-impl.js";
import { graphEngineLanguageFamily, graphEngineLanguages } from "./engine-languages.js";
import { detectLanguage } from "./extraction/grammars.js";
import { pinWarmGraphArtifact, publishNativeWarmOverlay, type WarmGraphArtifact } from "./maintenance.js";
import { discoverGraphConfigSources, graphManifestDiffersOnlyByConfig, graphManifestFromSources, type GraphManifest } from "./manifest.js";
import { nativeCoverageMetadata, nativeEngineConfigs, nativeEngineLanguageIds, prepareNativeGraphBuild, type NativeGraphFile } from "./native-build.js";
import { graphEngineBinary, graphEngineVersion, type EngineRequestConfig, type GraphEngineBuildMetadata } from "./native-engine.js";
import { NativeGraphServer, type ServeEdit, type ServeStamp } from "./native-serve.js";
import { installGraphViews, overlayBase } from "./overlay.js";
import { overlayTooLarge } from "./overlay-write.js";
import { flushGraphPhaseTimings, recordGraphPhase } from "./phase-timing.js";
import { computeSourceCorpusDigest, gitProvenanceChanged, readGraphGitProvenance, type GraphGitProvenance } from "./snapshot.js";
import { graphWalkObservations, withSourceMemo } from "./source-memo.js";
import { acquireGraphWriter, collectGraphGarbage, discardGraphTemporary, graphTemporary, readGraphPointer, type GraphLocation, type GraphPointer } from "./storage.js";
import type { WarmEditResult, WarmGraphCheckout } from "./warm.js";

const active = new Set<string>();

interface TreeProof {
  stamps: ServeStamp[];
  walkObservation?: string;
}

interface EditPlan {
  files: Map<string, NativeGraphFile>;
  inputs: Omit<ServeEdit, "output">;
  proof?: TreeProof;
  assertUnchanged?(): void;
  dispose?(): void;
}

function graphFiles(db: SqliteDatabase): Map<string, NativeGraphFile> {
  const rows = db.prepare(`SELECT f.path, lower(hex(f.content_hash)) AS contentHash, f.size, f.modified_at AS modifiedAt,
    f.extractor_version AS extractorVersion, o.identity AS sourceIdentity, o.utf8_size AS utf8Size
    FROM ${v5Rows(db, "files")} f LEFT JOIN main.source_observations o ON o.path = f.path ORDER BY f.path`).all() as NativeGraphFile[];
  return new Map(rows.map(file => [file.path, file]));
}

function captureTreeProof(root: string, files: ReadonlyMap<string, NativeGraphFile>): TreeProof | undefined {
  // Tracked config exceptions use this Git index. Linked worktrees and Git
  // environment overrides use the full discovery proof, as do Windows filesystems.
  if (process.platform === "win32" || process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_INDEX_FILE
    || !lstatSync(join(root, ".git"), { throwIfNoEntry: false })?.isDirectory()) return undefined;
  nativeGraphSourcePaths(root);
  const walks = graphWalkObservations(root);
  const source = walks.find(walk => (JSON.parse(walk.key) as unknown[])[0] === GRAPH_SUPPORTED_SOURCE_GLOB);
  const config = walks.find(walk => JSON.stringify((JSON.parse(walk.key) as unknown[])[0]) === JSON.stringify(GRAPH_CONFIG_GLOBS));
  if (!source || !config || [...files.values()].some(file => !file.sourceIdentity || file.utf8Size == null)) return undefined;
  const directories = new Map([...source.directories, ...config.directories]);
  const stamps: ServeStamp[] = [];
  for (const [directory, identity] of directories) {
    const path = relative(root, directory).replaceAll("\\", "/") || ".";
    stamps.push({ path, identity, directory: true });
    const rule = path === "." ? ".gitignore" : `${path}/.gitignore`;
    const entry = stamp(root, rule);
    if (entry.identity !== null) stamps.push(entry);
  }
  for (const path of [...config.paths, ".git/index", ".git/info/exclude", ".git/config", ".mex/config.json"]) {
    stamps.push(stamp(root, path));
  }
  // The source listing after capturing rule-file stamps must agree with the
  // publication. Later changes to a rule, an existing file or a directory
  // invalidate the final proof in the child.
  const current = nativeGraphSourcePaths(root);
  if (current.length !== files.size || current.some(path => !files.has(path))) return undefined;
  return { stamps };
}

function stamp(root: string, path: string): ServeStamp {
  let entry;
  try { entry = lstatSync(join(root, path), { bigint: true, throwIfNoEntry: false }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error; }
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error("A discovery input has no stable file identity.");
  return { path, identity: entry ? preciseSourceIdentity(entry) : null, directory: false };
}

/** Normal checkout HEAD and loose branch refs. Other ref stores go through Git. */
function readWarmGitRefs(root: string): GraphGitProvenance | undefined {
  const dir = join(root, ".git");
  const read = (path: string) => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    return info?.isFile() && info.size <= 4096 ? readFileSync(path, "utf8").trim() : undefined;
  };
  try {
    const head = read(join(dir, "HEAD"));
    if (!head) return undefined;
    const hash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
    if (hash.test(head)) return { branch: null, head };
    const ref = /^ref: refs\/heads\/([^\\\0]+)$/u.exec(head)?.[1];
    if (!ref || ref.split("/").some(part => !part || part === "." || part === "..")) return undefined;
    const commit = read(join(dir, "refs", "heads", ref));
    return commit && hash.test(commit) ? { branch: ref, head: commit } : undefined;
  } catch { return undefined; }
}

function sameGraphFile(a: NativeGraphFile | undefined, b: NativeGraphFile | undefined): boolean {
  return a?.contentHash === b?.contentHash && a?.size === b?.size && a?.extractorVersion === b?.extractorVersion;
}

function sameConfigs(a: EngineRequestConfig[], b: EngineRequestConfig[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function editPaths(root: string, paths: readonly string[]): string[] {
  return [...new Set(paths.map(input => {
    const path = (isAbsolute(input) ? relative(root, input) : input).replaceAll("\\", "/");
    if (!path || /^[a-z]:/iu.test(path) || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("The reported edit is outside the checkout.");
    }
    return path;
  }))].sort();
}

export class NativeWarmCheckout implements WarmGraphCheckout {
  lastEditAt = Date.now();
  private closed = false;
  private editing = false;
  private requiredShadows: Set<string>;

  private constructor(
    private readonly location: GraphLocation,
    private readonly server: NativeGraphServer,
    private readonly key: string,
    private readonly base: WarmGraphArtifact,
    private readonly baseFiles: ReadonlyMap<string, NativeGraphFile>,
    private live: WarmGraphArtifact,
    private files: Map<string, NativeGraphFile>,
    private readonly languages: string[],
    private configs: EngineRequestConfig[],
    private metadata: GraphEngineBuildMetadata,
    private proof: TreeProof | undefined,
  ) {
    this.requiredShadows = this.shadowsFor(files);
  }

  static async open(location: GraphLocation, pointer: GraphPointer): Promise<NativeWarmCheckout | undefined> {
    const root = location.root;
    const basePath = join(location.directory, pointer.base);
    const livePath = join(location.directory, pointer.overlay ?? pointer.base);
    const db = openSqlite(livePath, { readOnly: true, immutable: true });
    const key = `${location.directory}\0${location.key}`;
    let reserved = false;
    try {
      if (!hasV5GraphSchema(db)) return undefined;
      if (active.has(key)) throw new Error("The checkout already has a resident graph engine.");
      if (process.env.MEX_GRAPH_STORAGE !== "v5") throw new Error("Schema v5 is no longer selected.");
      active.add(key);
      reserved = true;
      return await withSourceMemo(async () => {
        const base = pinWarmGraphArtifact(basePath);
        const live = pointer.overlay ? pinWarmGraphArtifact(livePath, base) : base;
        if (overlayBase(db) !== (pointer.overlay ? pointer.base : undefined)) throw new Error("The graph pointer names the wrong overlay base.");
        installGraphViews(db, livePath);
        const files = graphFiles(db);
        const languages = graphEngineLanguages();
        if (!languages.length || [...files.keys()].some(path => !languages.includes(graphEngineLanguageFamily(detectLanguage(path))))) {
          throw new Error("The selected engine languages do not cover the published checkout.");
        }
        const baseDb = pointer.overlay ? openSqlite(basePath, { readOnly: true, immutable: true }) : undefined;
        let baseFiles: ReadonlyMap<string, NativeGraphFile>;
        try { baseFiles = baseDb ? graphFiles(baseDb) : files; }
        finally { baseDb?.close(); }
        const metadata = readMetadata(db);
        const coverage = reuseV5Coverage(db, root);
        metadata.coverage = nativeCoverageMetadata(coverage ?? null);
        let proof = coverage && metadata.skipped.length === 0 ? tryTreeProof(root, files) : undefined;
        const config = discoverGraphConfigSources(root);
        const manifest = graphManifestFromSources(root, config, ENGINE_GRAPH_SCHEMA_VERSION);
        assertCompatibleManifest(manifest, metadata);
        if (manifest.manifestHash !== metadata.manifestHash) proof = undefined;
        const configs = nativeEngineConfigs(languages, config);
        const binary = graphEngineBinary();
        if (!binary) throw new Error("No mex-graph binary was found.");
        const version = graphEngineVersion(binary);
        if ("problem" in version) throw new Error(version.problem);
        base.assertCurrent();
        live.assertCurrent();
        const observationRoot = createHash("sha256").update(root).digest("hex");
        const server = await NativeGraphServer.open(binary, location.directory, {
          mode: "serve", root, files: [...files.values()], configs, observationRoot,
          languages: nativeEngineLanguageIds(languages), base: basePath,
          ...(pointer.overlay ? { overlay: livePath } : {}),
          factsCache: join(location.directory, "facts"),
          limits: { memoryMb: 2048, deadlineMs: 24 * 60 * 60_000 },
        });
        return new NativeWarmCheckout(location, server, key, base, baseFiles, live, files, languages, configs, metadata, proof);
      });
    } catch (error) {
      if (reserved) active.delete(key);
      throw error;
    } finally { db.close(); }
  }

  get pid(): number | undefined { return this.server.pid; }

  async edit(reported: readonly string[]): Promise<WarmEditResult> {
    this.lastEditAt = Date.now();
    const started = performance.now();
    const phases: Record<string, number> = {};
    const done = (status: WarmEditResult["status"], files: string[], reason?: string, finished = performance.now()): WarmEditResult =>
      ({ status, files, ms: finished - started, phases, ...(reason ? { reason } : {}) });
    if (this.closed || this.editing) return done("cold", [], "the resident checkout is busy or closed");
    this.editing = true;
    const root = this.location.root;
    let writer: ReturnType<typeof acquireGraphWriter> | undefined;
    try {
      return await withSourceMemo(async () => {
        if (!this.server.live) throw new Error("The resident graph engine exited.");
        if (process.env.MEX_GRAPH_STORAGE !== "v5" || graphEngineLanguages().join(",") !== this.languages.join(",")) {
          throw new Error("The engine language or storage selection changed.");
        }
        writer = acquireGraphWriter(this.location);
        const assertCurrent = () => {
          if (this.closed || !this.server.live) throw new Error("The resident graph engine closed during the edit.");
          writer!.assertOwned();
          const pointer = readGraphPointer(this.location);
          if (!pointer || join(this.location.directory, pointer.base) !== this.base.path
            || join(this.location.directory, pointer.overlay ?? pointer.base) !== this.live.path) {
            throw new Error("The graph was published by another writer.");
          }
          this.base.assertCurrent();
          if (this.live !== this.base) this.live.assertCurrent();
        };
        assertCurrent();
        const paths = editPaths(root, reported);
        const git = this.readGitProvenance();
        if (git.unreadable) throw new Error("Git provenance could not be verified.");
        let plan = this.fastPlan(paths, git);
        recordGraphPhase("native.warm.observe", performance.now() - started);
        for (;;) {
          plan ??= await this.fullPlan(git);
          const output = graphTemporary(this.location);
          try {
            if (plan.inputs.files.length === 0 && plan.inputs.deleted.length === 0 && !plan.inputs.configs
              && plan.inputs.buildMetadata.manifestHash === this.metadata.manifestHash
              && git.head === this.metadata.indexedHead && git.branch === this.metadata.indexedBranch) return done("unchanged", []);
            const result = await this.server.edit({ ...plan.inputs, output });
            if (overlayTooLarge(result.shadowedFiles!, result.files)) {
              throw new Error("The resident overlay exceeds the refresh overlay limit.");
            }
            phases.engine = (phases.engine ?? 0) + result.usage.wallMs;
            const candidate = plan;
            const requiredShadows = this.shadowsFor(candidate.files, [
              ...candidate.inputs.files.map(file => file.path), ...candidate.inputs.deleted,
            ]);
            const publication = await publishNativeWarmOverlay({
              location: this.location, base: this.base, previous: this.live, output, result,
              expected: candidate.files, requiredShadows, metadata: candidate.inputs.buildMetadata, assertCurrent,
              verifyInputs: async () => {
                if (candidate.assertUnchanged) candidate.assertUnchanged();
                else {
                  const verified = await this.server.verify(result.id, candidate.proof!.stamps);
                  phases.engine += verified.wallMs;
                  if (!verified.matches) return false;
                  const now = this.readGitProvenance();
                  if (now.unreadable || gitProvenanceChanged(git, now)) return false;
                }
                return true;
              },
            });
            if (!publication) {
              await this.server.discard(result.id);
              this.proof = undefined;
              plan = undefined;
              continue;
            }
            this.live = publication.artifact;
            this.files = candidate.files;
            this.requiredShadows = requiredShadows;
            this.metadata = candidate.inputs.buildMetadata;
            this.configs = candidate.inputs.configs ?? this.configs;
            try {
              await this.server.accept(result.id, publication.artifact.path);
              this.proof = candidate.proof ?? this.newTreeProof(candidate.inputs.walkObservation);
            } catch { this.close(); }
            try { collectGraphGarbage(this.location); } catch { /* the next writer collects */ }
            return done("published", [...candidate.inputs.files.map(file => file.path), ...candidate.inputs.deleted], undefined, publication.publishedAt);
          } finally {
            try { discardGraphTemporary(output); } catch { /* the next writer collects */ }
            plan?.dispose?.();
          }
        }
      });
    } catch (error) {
      this.close();
      return done("cold", [], error instanceof Error ? error.message : String(error));
    } finally {
      this.editing = false;
      writer?.release();
      for (const [phase, ms] of Object.entries(phases)) recordGraphPhase(`native.warm.${phase}`, ms);
      flushGraphPhaseTimings("warm.serve", root);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    active.delete(this.key);
    this.server.close();
  }

  private readGitProvenance(): GraphGitProvenance {
    return (this.proof && readWarmGitRefs(this.location.root)) ?? readGraphGitProvenance(this.location.root);
  }

  private shadowsFor(files: ReadonlyMap<string, NativeGraphFile>, edited?: readonly string[]): Set<string> {
    const shadows = new Set(edited ? this.requiredShadows : undefined);
    for (const path of edited ?? new Set([...this.baseFiles.keys(), ...files.keys()])) {
      if (sameGraphFile(files.get(path), this.baseFiles.get(path))) shadows.delete(path);
      else shadows.add(path);
    }
    return shadows;
  }

  private fastPlan(paths: string[], git: GraphGitProvenance): EditPlan | undefined {
    if (!this.proof || git.head !== this.metadata.indexedHead || git.branch !== this.metadata.indexedBranch
      || paths.some(path => !this.files.has(path))) return undefined;
    const files = new Map(this.files);
    const changed: NativeGraphFile[] = [];
    for (const path of paths) {
      let source;
      try { source = captureNativeGraphSource(this.location.root, path); }
      catch { return undefined; }
      const old = this.files.get(path)!;
      if (old.sourceIdentity === source.identity && old.contentHash === source.contentHash) continue;
      const file = {
        path, size: source.size, modifiedAt: source.modifiedAt, contentHash: source.contentHash,
        sourceIdentity: source.identity, utf8Size: source.utf8Size, extractorVersion: old.extractorVersion,
      };
      files.set(path, file);
      changed.push(file);
    }
    let bytes = 0;
    for (const file of files.values()) bytes = addGraphCorpusBytes(bytes, file.utf8Size!, "source");
    return {
      files, proof: this.proof, inputs: { files: changed, deleted: [],
        ...(this.proof.walkObservation ? { walkObservation: this.proof.walkObservation } : {}),
        buildMetadata: { ...this.metadata, indexedAt: Date.now(), sourceCorpusDigest: computeSourceCorpusDigest([...files.values()]) },
      },
    };
  }

  private newTreeProof(walkObservation?: string): TreeProof | undefined {
    if (!this.metadata.coverage || this.metadata.skipped.length > 0) return undefined;
    const root = this.location.root;
    const proof = tryTreeProof(root, this.files, walkObservation);
    if (!proof) return undefined;
    const configs = discoverGraphConfigSources(root);
    const manifest = graphManifestFromSources(root, configs, ENGINE_GRAPH_SCHEMA_VERSION);
    return manifest.manifestHash === this.metadata.manifestHash && sameConfigs(this.configs, nativeEngineConfigs(this.languages, configs))
      ? proof : undefined;
  }

  private async fullPlan(git: GraphGitProvenance): Promise<EditPlan> {
    const capture = await prepareNativeGraphBuild(this.location.root, this.base.path, this.live.path, true);
    if (!capture) throw new Error("The current source corpus is not owned by the Rust engine.");
    try {
      assertCompatibleManifest(capture.observation.manifest, this.metadata);
      const { files: current, configs, ...inputs } = capture.editInputs();
      if (git.head !== inputs.buildMetadata.indexedHead || git.branch !== inputs.buildMetadata.indexedBranch) {
        throw new Error("Git provenance changed during discovery.");
      }
      const files = new Map(current.map(({ staged: _staged, ...file }) => [file.path, file]));
      return {
        files,
        inputs: { ...inputs,
          ...(sameConfigs(configs, this.configs) ? {} : { configs }),
          files: current.filter(file => !sameGraphFile(this.files.get(file.path), file)
            || this.files.get(file.path)?.sourceIdentity !== file.sourceIdentity),
          deleted: [...this.files.keys()].filter(path => !files.has(path)),
        },
        assertUnchanged: capture.assertInputsUnchanged, dispose: capture.dispose,
      };
    } catch (error) {
      capture.dispose();
      throw error;
    }
  }
}

function tryTreeProof(root: string, files: ReadonlyMap<string, NativeGraphFile>, walkObservation?: string): TreeProof | undefined {
  try {
    const proof = captureTreeProof(root, files);
    if (proof && walkObservation) proof.walkObservation = walkObservation;
    return proof;
  } catch { return undefined; }
}

function assertCompatibleManifest(manifest: GraphManifest, previous: GraphEngineBuildMetadata): void {
  if (manifest.manifestHash !== previous.manifestHash && !graphManifestDiffersOnlyByConfig(manifest, previous.manifestHash, previous.configHash)) {
    throw new Error("The published graph uses a different engine or corpus policy.");
  }
}

function readMetadata(db: SqliteDatabase): GraphEngineBuildMetadata {
  const metadata = db.prepare(`SELECT indexed_at AS indexedAt, indexed_branch AS indexedBranch, lower(hex(indexed_head)) AS indexedHead,
    compiler_version AS compilerVersion, extractor_version AS extractorVersion, resolver_version AS resolverVersion,
    lower(hex(grammar_hash)) AS grammarHash, lower(hex(config_hash)) AS configHash, lower(hex(manifest_hash)) AS manifestHash,
    lower(hex(corpus_digest)) AS sourceCorpusDigest FROM main.snapshot`).get() as GraphEngineBuildMetadata | undefined;
  if (!metadata) throw new Error("The resident checkout has no v5 snapshot metadata.");
  metadata.indexedHead ||= null;
  metadata.skipped = db.prepare("SELECT path, reason FROM main.coverage WHERE reason <> 'parse failed' ORDER BY path").all() as GraphEngineBuildMetadata["skipped"];
  return metadata;
}
