import type { GraphMaintenanceOptions } from "../team/contracts/graph.js";
import { captureGraphCoverage, coveragePolicyHash, type CoverageCache } from "./coverage.js";
import { openSqlite } from "./db/sqlite.js";
import { ENGINE_GRAPH_SCHEMA_VERSION, hasV5GraphSchema } from "./db/v5.js";
import { discoverGraphBuildSources, GraphSourceSpool, TREE_SITTER_EXTRACTOR_VERSION } from "./engine-impl.js";
import {
  engineExtractorSuffix, graphEngineHandlesEcmaScript, graphEngineLanguageFamily, graphEngineLanguages,
} from "./engine-languages.js";
import type { BuildResult } from "./engine.js";
import { TYPESCRIPT_COMPILER_EXTRACTOR_VERSION } from "./extraction/compiler-version.js";
import { detectLanguage } from "./extraction/grammars.js";
import { configHashForSources, discoverGraphConfigSources, graphManifest } from "./manifest.js";
import { graphEngineBinary, graphEngineVersion, runGraphEngine, type GraphEngineBuildMetadata } from "./native-engine.js";
import { computeSourceCorpusDigest, gitProvenanceChanged, readGraphGitProvenance } from "./snapshot.js";
import { GraphSourceStagingError } from "./source-errors.js";

export interface NativeGraphBuild {
  build(candidate: string, options: GraphMaintenanceOptions): Promise<BuildResult>;
  assertGitUnchanged(): void;
  dispose(): void;
}

/** Select v5 only when the complete indexable corpus can use the engine. */
export async function prepareNativeGraphBuild(root: string): Promise<NativeGraphBuild | undefined> {
  if (process.env.MEX_GRAPH_STORAGE !== "v5") return undefined;
  const languages = graphEngineLanguages();
  if (languages.length === 0) return undefined;
  const git = readGraphGitProvenance(root);
  const manifest = graphManifest(root, ENGINE_GRAPH_SCHEMA_VERSION);
  const owned = (path: string) => {
    const language = detectLanguage(path);
    return languages.includes(graphEngineLanguageFamily(language))
      && (language !== "python" || path.endsWith(".py"));
  };
  const spool = new GraphSourceSpool(undefined, true);
  let handedOff = false;
  try {
    // One private capture per source. The child verifies the bytes against
    // these hashes before extraction and again before full-text indexing.
    const corpus = await discoverGraphBuildSources(root, (path, source) => {
      if (owned(path)) spool.stage(path, source);
    });
    if (corpus.files.some(file => !owned(file.relPath))) return undefined;

    const configs = discoverGraphConfigSources(root);
    if (configHashForSources(configs) !== manifest.configHash) {
      throw new GraphSourceStagingError([{
        filePath: ".", operation: "discover", message: "The graph configuration changed during source capture.",
      }]);
    }
    const binary = graphEngineBinary();
    if (!binary) throw new Error("Schema v5 requires a mex-graph binary. Set MEX_GRAPH_ENGINE to the compatible engine.");
    const version = graphEngineVersion(binary);
    if ("problem" in version) throw new Error(`Schema v5 engine unavailable: ${version.problem}.`);

    const enabled = languages.flatMap(language =>
      language === "typescript" ? [language, "tsx"] : language === "javascript" ? [language, "jsx"] : [language]);
    const files = corpus.files.map(file => {
      const family = graphEngineLanguageFamily(detectLanguage(file.relPath));
      const extractor = family === "python" ? TREE_SITTER_EXTRACTOR_VERSION : TYPESCRIPT_COMPILER_EXTRACTOR_VERSION;
      return {
        path: file.relPath, size: file.size, modifiedAt: file.modifiedAt,
        contentHash: file.contentHash, staged: spool.capturedName(file.relPath),
        extractorVersion: extractor + engineExtractorSuffix([family]),
      };
    });
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
    const assertGitUnchanged = () => {
      if (gitProvenanceChanged(git, readGraphGitProvenance(root))) {
        throw new GraphSourceStagingError([{
          filePath: ".git/HEAD", operation: "discover", message: "Git branch or HEAD changed during graph construction.",
        }]);
      }
    };
    handedOff = true;
    return {
      async build(candidate, options) {
        const started = Date.now();
        const coverage = JSON.parse(captureGraphCoverage(root)) as CoverageCache | null;
        metadata.coverage = coverage
          ? { policyHash: coveragePolicyHash(coverage.policy), ...coverage.histogram, directories: coverage.directories }
          : null;
        const run = await runGraphEngine(binary, {
          mode: "build", root, files, languages: enabled, output: candidate, sourceDirectory: spool.directory,
          ...(graphEngineHandlesEcmaScript(languages) ? { configs: [...configs].map(([path, source]) => ({ path, source })) } : {}),
          limits: { memoryMb: 2048, deadlineMs: 30 * 60_000 },
          buildMetadata: metadata,
        }, {
          signal: options.signal,
          onEvent: event => {
            if (event.type === "progress") options.onProgress?.({
              phase: event.phase === "parse" ? "parse" : "resolve",
              message: "Building the graph with the Rust engine.",
              completed: event.done, total: event.total,
            });
          },
        });
        if (run.exitCode !== 0 || !run.result || run.result.files !== files.length) {
          throw new Error(`Schema v5 build failed (${run.error?.code ?? run.signal ?? run.exitCode ?? "missing result"}).`);
        }
        assertGitUnchanged();
        const db = openSqlite(candidate, { readOnly: true, immutable: true });
        try {
          if (!hasV5GraphSchema(db)) throw new Error("The graph engine did not write a schema v5 candidate.");
          const health = db.prepare(
            `SELECT COUNT(*) FILTER(WHERE parse_status = 0) AS ok,
                    COUNT(*) FILTER(WHERE parse_status = 1) AS partial,
                    COUNT(*) FILTER(WHERE parse_status = 2) AS failed
             FROM main.files`,
          ).get() as NonNullable<BuildResult["health"]>;
          return {
            filesIndexed: run.result.files, nodesCreated: run.result.nodes, edgesCreated: run.result.edges,
            durationMs: Date.now() - started, health,
            ...(corpus.skipped.length ? { skipped: corpus.skipped } : {}),
            engine: {
              languages, files: run.result.files, fallbackFiles: 0,
              wallMs: run.result.usage.wallMs, peakRssMb: run.result.usage.peakRssMb,
            },
          };
        } finally { db.close(); }
      },
      assertGitUnchanged,
      dispose: () => spool.dispose(),
    };
  } finally {
    if (!handedOff) spool.dispose();
  }
}
