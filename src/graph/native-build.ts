import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { GraphMaintenanceOptions } from "../team/contracts/graph.js";
import { captureGraphCoverage, coveragePolicyHash, reuseV5Coverage, V5_COVERAGE_CACHE_LIMITS, type CoverageCache } from "./coverage.js";
import { openSqlite } from "./db/sqlite.js";
import { ENGINE_GRAPH_SCHEMA_VERSION, hasV5GraphSchema, v5Rows } from "./db/v5.js";
import { discoverGraphBuildSources, GraphSourceSpool, TREE_SITTER_EXTRACTOR_VERSION, type NativeSourceObservation } from "./engine-impl.js";
import {
  engineExtractorSuffix, graphEngineHandlesEcmaScript, graphEngineLanguageFamily, graphEngineLanguages,
} from "./engine-languages.js";
import type { BuildResult } from "./engine.js";
import { TYPESCRIPT_COMPILER_EXTRACTOR_VERSION } from "./extraction/compiler-version.js";
import { detectLanguage } from "./extraction/grammars.js";
import { discoverGraphConfigSources, graphManifestFromSources } from "./manifest.js";
import { graphEngineBinary, graphEngineVersion, runGraphEngine, type EngineRequestConfig, type EngineRequestFile, type GraphEngineBuildMetadata } from "./native-engine.js";
import { computeSourceCorpusDigest, gitProvenanceChanged, readGraphGitProvenance } from "./snapshot.js";
import { GraphSourceStagingError } from "./source-errors.js";
import { graphLocation } from "./storage.js";
import { timeGraphPhase, timeGraphPhaseAsync } from "./phase-timing.js";
import { attachedV5Base, installGraphViews, overlayBase } from "./overlay.js";
import { holdsAuditedBytes } from "./audit-record.js";
import { inspectRepoState, type GraphMaintenanceInputs } from "./status.js";
import { graphWalkObservations, restoreGraphWalkObservations } from "./source-memo.js";

const MAX_WALK_BYTES = 4 * 1024 * 1024;

export interface NativeGraphInputs {
  files: NativeGraphFile[];
  configs: EngineRequestConfig[];
  buildMetadata: GraphEngineBuildMetadata;
  sourceDirectory: string;
  walkObservation?: string;
}

export interface NativeGraphFile extends EngineRequestFile {
  contentHash: string;
  size: number;
  modifiedAt: number;
  extractorVersion: string;
}

export interface NativeGraphRefresh {
  result: BuildResult;
  filesReextracted: number;
  shadowedFiles: number;
}

export interface NativeGraphBuild {
  build(candidate: string, options: GraphMaintenanceOptions): Promise<BuildResult>;
  refresh(candidate: string, options: GraphMaintenanceOptions, against: string): Promise<NativeGraphRefresh | undefined>;
  editInputs(): NativeGraphInputs;
  observation: GraphMaintenanceInputs;
  readonly filesReextracted: number | undefined;
  assertInputsUnchanged(): void;
  dispose(): void;
}

/** Select v5 only when the complete indexable corpus can use the engine. */
export async function prepareNativeGraphBuild(root: string, base?: string, previous?: string, resident = false): Promise<NativeGraphBuild | undefined> {
  if (process.env.MEX_GRAPH_STORAGE !== "v5") return undefined;
  const languages = graphEngineLanguages();
  if (languages.length === 0) return undefined;
  const git = readGraphGitProvenance(root);
  const observedAt = new Date().toISOString();
  const owned = (path: string) => languages.includes(graphEngineLanguageFamily(detectLanguage(path)));
  const spool = new GraphSourceSpool(undefined, true);
  const repoInspection = new AbortController();
  const fullRepo = inspectRepoState(root, observedAt, { signal: repoInspection.signal });
  const staged = new Set<string>();
  let handedOff = false;
  try {
    const observationRoot = createHash("sha256").update(realpathSync.native(root)).digest("hex");
    const old = base ? refreshBaseHashes(base) : undefined;
    const observed = previous && old ? timeGraphPhase("native.priorSources", () => readSourceObservations(previous, root, observationRoot)) : undefined;
    const corpus = timeGraphPhase("native.capture", () => discoverGraphBuildSources(root, (path, source, hash) => {
      if (owned(path) && old?.get(path) !== hash) {
        staged.add(path);
        spool.stage(path, source);
      }
    }, observed?.sources));
    if (corpus.files.some(file => !owned(file.relPath))) return undefined;

    const paths = old ? [...staged].slice(0, 4) : [];
    const repo = paths.length === 0 ? fullRepo : Promise.race([
      fullRepo,
      // A dirty path makes the worktree dirty. A clean subset still needs the
      // complete status, for example after switching to a different commit.
      inspectRepoState(root, observedAt, { paths, signal: repoInspection.signal })
        .then(status => status.complete && status.state.dirty ? status : fullRepo),
    ]).finally(() => repoInspection.abort());
    const configs = timeGraphPhase("native.config", () => discoverGraphConfigSources(root));
    const walkObservation = timeGraphPhase("native.saveWalk", () => {
      const walks = graphWalkObservations(root);
      if (walks.length === 0) return undefined;
      const bytes = Buffer.from(JSON.stringify(walks));
      return bytes.length <= MAX_WALK_BYTES ? deflateRawSync(bytes, { level: 1 }).toString("hex") : undefined;
    });
    const manifest = graphManifestFromSources(root, configs, ENGINE_GRAPH_SCHEMA_VERSION);
    const binary = resident ? undefined : graphEngineBinary();
    if (!resident) {
      if (!binary) throw new Error("Schema v5 requires a mex-graph binary. Set MEX_GRAPH_ENGINE to the compatible engine.");
      const version = timeGraphPhase("native.version", () => graphEngineVersion(binary));
      if ("problem" in version) throw new Error(`Schema v5 engine unavailable: ${version.problem}.`);
    }
    const enabled = nativeEngineLanguageIds(languages);
    const files = corpus.files.map(file => {
      return {
        path: file.relPath, size: file.size, modifiedAt: file.modifiedAt,
        contentHash: file.contentHash, sourceIdentity: file.identity, utf8Size: file.utf8Size,
        ...(staged.has(file.relPath) ? { staged: spool.capturedName(file.relPath) } : {}),
        extractorVersion: nativeFileExtractorVersion(file.relPath),
      };
    });
    const currentPaths = new Set(files.map(file => file.path));
    const metadata: GraphEngineBuildMetadata = {
      indexedAt: Date.now(), indexedBranch: git.branch, indexedHead: git.head,
      compilerVersion: `typescript-${manifest.inputs.compiler}`,
      extractorVersion: manifest.inputs.extractor,
      resolverVersion: manifest.inputs.resolver,
      grammarHash: manifest.grammarHash, configHash: manifest.configHash, manifestHash: manifest.manifestHash,
      sourceCorpusDigest: computeSourceCorpusDigest(files),
      coverage: null,
      skipped: corpus.skipped.map(file => ({
        path: file.filePath, reason: file.reason === "corpus-limit" ? "too big" : file.reason,
      })),
    };
    const assertInputsUnchanged = () => {
      corpus.assertUnchanged();
      const current = discoverGraphConfigSources(root);
      if (current.size !== configs.size || [...current].some(([path, source]) => configs.get(path) !== source)
        || graphManifestFromSources(root, current, ENGINE_GRAPH_SCHEMA_VERSION).manifestHash !== manifest.manifestHash) {
        throw new GraphSourceStagingError([{
          filePath: ".", operation: "discover", message: "The graph configuration changed during source capture.",
        }]);
      }
      const now = readGraphGitProvenance(root);
      if (git.unreadable || now.unreadable || gitProvenanceChanged(git, now)) {
        throw new GraphSourceStagingError([{
          filePath: ".git/HEAD", operation: "discover", message: "Git branch or HEAD changed during graph construction.",
        }]);
      }
    };
    const factsCache = join(graphLocation(root).directory, "facts");
    let filesReextracted: number | undefined;
    const editInputs = (): NativeGraphInputs => {
      const coverage = timeGraphPhase("native.coverage", () => observed?.coverage ?? JSON.parse(captureGraphCoverage(root, V5_COVERAGE_CACHE_LIMITS)) as CoverageCache | null);
      return {
        files, configs: nativeEngineConfigs(languages, configs),
        buildMetadata: { ...metadata, coverage: nativeCoverageMetadata(coverage) },
        sourceDirectory: spool.directory, ...(walkObservation ? { walkObservation } : {}),
      };
    };
    const runCandidate = async (candidate: string, options: GraphMaintenanceOptions, refresh?: { base: string; overlay?: string; changed: string[] }) => {
      const started = Date.now();
      if (!binary) throw new Error("The resident capture has no one-shot engine.");
      const mode = refresh ? "refresh" : "build";
      const run = await timeGraphPhaseAsync(`native.${mode}`, () => runGraphEngine(binary, {
        mode, root, languages: enabled, output: candidate, factsCache, observationRoot,
        ...editInputs(),
        ...refresh,
        limits: { memoryMb: 2048, deadlineMs: 30 * 60_000 },
      }, {
        signal: options.signal,
        onEvent: event => {
          if (event.type === "progress") options.onProgress?.({
            phase: event.phase === "parse" ? "parse" : "resolve",
            message: "Building the graph with the Rust engine.",
            completed: event.done, total: event.total,
          });
        },
      }));
      if (refresh && run.error?.code === "graph_refresh_base_incompatible") return undefined;
      if (run.exitCode !== 0 || !run.result || run.result.files !== files.length) {
        const issue = run.error?.message ?? run.signal ?? run.exitCode ?? "missing result";
        throw new Error(`Schema v5 ${mode} failed (${issue}).`);
      }
      const db = openSqlite(candidate, { readOnly: true, immutable: true });
      try {
        if (!hasV5GraphSchema(db)) throw new Error("The graph engine did not write a schema v5 candidate.");
        if (refresh && (overlayBase(db) !== basename(refresh.base) || !Number.isSafeInteger(run.result.shadowedFiles))) {
          throw new Error("The graph engine did not write an overlay for the requested base.");
        }
        const health = db.prepare(
          `SELECT source_count - partial_count - failed_count AS ok, partial_count AS partial, failed_count AS failed
           FROM main.snapshot`,
        ).get() as NonNullable<BuildResult["health"]>;
        const result: BuildResult = {
          filesIndexed: run.result.files, nodesCreated: run.result.nodes, edgesCreated: run.result.edges,
          durationMs: Date.now() - started, health,
          ...(corpus.skipped.length ? { skipped: corpus.skipped } : {}),
          engine: {
            languages, files: run.result.files, fallbackFiles: 0,
            wallMs: run.result.usage.wallMs, peakRssMb: run.result.usage.peakRssMb,
          },
        };
        filesReextracted = run.result.filesReextracted ?? run.result.files;
        return { result, filesReextracted, shadowedFiles: run.result.shadowedFiles ?? 0 };
      } finally { db.close(); }
    };
    handedOff = true;
    return {
      editInputs,
      get filesReextracted() { return filesReextracted; },
      async build(candidate, options) {
        return (await runCandidate(candidate, options))!.result;
      },
      async refresh(candidate, options, against) {
        const baseline = against === base ? old : refreshBaseHashes(against);
        if (!baseline) return undefined;
        const changed = [...files.filter(file => baseline.get(file.path) !== file.contentHash).map(file => file.path),
          ...[...baseline.keys()].filter(path => !currentPaths.has(path))];
        return runCandidate(candidate, options, {
          base: against, changed,
          ...(against === base && previous && previous !== base ? { overlay: previous } : {}),
        });
      },
      observation: {
        repo, manifest,
        live: {
          complete: true,
          hashes: new Map(files.map(file => [file.path, file.contentHash])),
          discoveredPaths: new Set(files.map(file => file.path)),
          diagnostics: corpus.skipped.slice(0, 100).map(file => ({
            code: "GRAPH_SOURCE_FILE_SKIPPED", severity: "warning", path: file.filePath,
            message: `Supported source file ${file.filePath} is not indexed (${file.reason}).`,
          })),
        },
      },
      assertInputsUnchanged,
      dispose: () => {
        repoInspection.abort();
        spool.dispose();
      },
    };
  } finally {
    if (!handedOff) {
      repoInspection.abort();
      spool.dispose();
    }
  }
}

export function nativeEngineLanguageIds(languages: readonly string[]): string[] {
  return languages.flatMap(language => language === "typescript" ? [language, "tsx"] : language === "javascript" ? [language, "jsx"] : [language]);
}

export function nativeEngineConfigs(languages: readonly string[], configs: ReadonlyMap<string, string>): EngineRequestConfig[] {
  return graphEngineHandlesEcmaScript(languages) ? [...configs].map(([path, source]) => ({ path, source })) : [];
}

export function nativeFileExtractorVersion(path: string): string {
  const family = graphEngineLanguageFamily(detectLanguage(path));
  const extractor = graphEngineHandlesEcmaScript([family])
    ? TYPESCRIPT_COMPILER_EXTRACTOR_VERSION : TREE_SITTER_EXTRACTOR_VERSION;
  return extractor + engineExtractorSuffix([family]);
}

export function nativeCoverageMetadata(coverage: CoverageCache | null): GraphEngineBuildMetadata["coverage"] {
  return coverage ? { policyHash: coveragePolicyHash(coverage.policy), ...coverage.histogram, directories: coverage.directories } : null;
}

function refreshBaseHashes(file: string): Map<string, string> | undefined {
  const db = openSqlite(file, { readOnly: true, immutable: true });
  try {
    if (!hasV5GraphSchema(db) || !db.prepare("SELECT 1 FROM main.meta WHERE key = 'refresh_format'").get()) return undefined;
    const rows = db.prepare("SELECT path, lower(hex(content_hash)) AS hash FROM main.files").all() as Array<{ path: string; hash: string }>;
    return new Map(rows.map(row => [row.path, row.hash]));
  } finally { db.close(); }
}

function readSourceObservations(file: string, root: string, rootDigest: string): {
  sources: Map<string, NativeSourceObservation>; coverage: CoverageCache | undefined;
} | undefined {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return undefined;
  const canonical = realpathSync.native(file);
  const db = openSqlite(canonical, { readOnly: true, immutable: true });
  try {
    if (!hasV5GraphSchema(db) || !db.prepare("SELECT 1 FROM main.meta WHERE key = 'observation_root' AND value = ?").get(rootDigest)) return undefined;
    installGraphViews(db, canonical);
    if (!holdsAuditedBytes(canonical, stat, attachedV5Base(db)?.path)) return undefined;
    const walk = db.prepare("SELECT value FROM main.meta WHERE key = 'walk_observation_v1' AND length(value) <= 1048576")
      .get() as { value: string } | undefined;
    if (walk) {
      try {
        const bytes = inflateRawSync(Buffer.from(walk.value, "hex"), { maxOutputLength: MAX_WALK_BYTES });
        restoreGraphWalkObservations(root, JSON.parse(bytes.toString("utf8")));
      } catch { /* An unusable walk is an ordinary cache miss. */ }
    }
    const rows = db.prepare(`SELECT o.path, o.identity, o.utf8_size AS utf8Size, lower(hex(f.content_hash)) AS contentHash
      FROM main.source_observations o CROSS JOIN ${v5Rows(db, "files")} f ON f.path = o.path`).all() as Array<NativeSourceObservation & { path: string }>;
    return { sources: new Map(rows.map(({ path, ...observation }) => [path, observation])), coverage: reuseV5Coverage(db, root) };
  } catch { return undefined; }
  finally { db.close(); }
}
