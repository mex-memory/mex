import { discoverGraphReadPaths } from "./read-discovery.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isSameResolvedPath, toPosix } from "../paths.js";
import {
  GRAPH_CONFIG_GLOBS, GRAPH_CORPUS_GLOB_OPTIONS, GRAPH_CORPUS_LIMITS,
  GraphCorpusLimitError, addGraphCorpusBytes, graphCorpusIgnoreGlobs, graphCorpusPolicyHash,
} from "./corpus-policy.js";
import { graphConfigIdentity } from "./config-identity.js";
import { DB_SCHEMA_VERSION } from "./db/database.js";
import { grammarManifestHash } from "./extraction/grammars.js";
import { GraphSourceStagingError, type GraphSourceStagingFailure } from "./source-errors.js";
import { recallSource, rememberSource } from "./source-memo.js";

// Package metadata does not initialize the compiler on a graph read.
const TYPESCRIPT_COMPILER_VERSION: string = createRequire(import.meta.url)("typescript/package.json").version;
// Pinned against extraction by the read-manifest compatibility test.
export const CORPUS_EXTRACTOR_VERSION = "typescript-5.9-v7+tree-sitter-v4";
export const RESOLVER_VERSION = "compiler-first-v3";

export interface GraphManifest {
  manifestHash: string;
  configHash: string;
  grammarHash: string;
  /**
   * The exact inputs `manifestHash` was folded from.
   *
   * Kept alongside the hash so a reader can ask which *class* of input moved
   * rather than only whether the fold changed. Config content is a build input
   * that may shift under a usable index; the remaining entries are engine
   * identity, and a difference in any of them means the store was written by
   * code that no longer exists here.
   */
  inputs: GraphManifestInputs;
}

/** One fixed key order; the serialized form is the manifest hash preimage. */
export interface GraphManifestInputs {
  db: number;
  compiler: string;
  extractor: string;
  resolver: string;
  corpusPolicyHash: string;
  grammarHash: string;
  configHash: string;
}

export function graphManifest(root: string): GraphManifest {
  const configSources = discoverGraphConfigSources(root);
  const configHash = configHashForSources(configSources);
  const grammarHash = grammarManifestHash();
  const inputs: GraphManifestInputs = {
    db: DB_SCHEMA_VERSION,
    compiler: TYPESCRIPT_COMPILER_VERSION,
    extractor: CORPUS_EXTRACTOR_VERSION,
    resolver: RESOLVER_VERSION,
    corpusPolicyHash: graphCorpusPolicyHash(root),
    grammarHash,
    configHash,
  };
  return {
    manifestHash: graphManifestHash(inputs),
    configHash,
    grammarHash,
    inputs: Object.freeze(inputs),
  };
}

/**
 * Fold manifest inputs in one fixed order.
 *
 * Exported so a reader can re-fold *these* inputs with a different config hash
 * and compare the result to a stored manifest. That substitution is the only
 * supported way to ask whether a stored manifest and the current one differ by
 * config alone, so the preimage must never be constructed anywhere else.
 */
export function graphManifestHash(inputs: GraphManifestInputs): string {
  return sha256(JSON.stringify({
    db: inputs.db,
    compiler: inputs.compiler,
    extractor: inputs.extractor,
    resolver: inputs.resolver,
    corpusPolicyHash: inputs.corpusPolicyHash,
    grammarHash: inputs.grammarHash,
    configHash: inputs.configHash,
  }));
}

/**
 * True when a stored manifest is reproducible from the current engine identity
 * and the config hash that store recorded — that is, when config content is the
 * only manifest input that moved.
 *
 * This deliberately proves identity by reconstruction rather than by comparing
 * a stored engine-identity field. A store written before this check existed
 * records no such field, and those are exactly the stores that need to keep
 * answering. Reconstruction also covers `corpusPolicyHash`, which no snapshot
 * records at all, so an ignore-policy change cannot pass as config drift.
 *
 * Fails closed on anything it cannot prove: a store with no recorded config
 * hash, or one whose manifest does not reproduce, is not config-drifted.
 */
export function graphManifestDiffersOnlyByConfig(
  current: GraphManifest,
  storedManifestHash: string | undefined,
  storedConfigHash: string | undefined,
): boolean {
  if (typeof storedManifestHash !== "string" || typeof storedConfigHash !== "string") return false;
  if (storedManifestHash === current.manifestHash) return false;
  if (storedConfigHash === current.configHash) return false;
  return graphManifestHash({ ...current.inputs, configHash: storedConfigHash }) === storedManifestHash;
}

export function discoverGraphConfigSources(root: string): Map<string, string> {
  let canonicalRoot: string;
  let configPaths: string[];
  try {
    canonicalRoot = realpathSync(root);
    configPaths = discoverGraphReadPaths([...GRAPH_CONFIG_GLOBS], {
      ...GRAPH_CORPUS_GLOB_OPTIONS,
      cwd: root,
      ignore: graphCorpusIgnoreGlobs(root),
    }, GRAPH_CORPUS_LIMITS.maxConfigFiles).map(toPosix);
  } catch (error) {
    throw new GraphSourceStagingError([sourceStagingFailure(".", "discover", error)]);
  }
  let configBytes = 0;
  const configs = configPaths.map((path) => {
    try {
      const canonicalPath = resolveContainedRepoFile(root, canonicalRoot, path);
      const file = readStableUtf8File(
        canonicalPath,
        resolve(root, path),
        GRAPH_CORPUS_LIMITS.maxConfigFileBytes,
        "maxConfigFileBytes",
      );
      configBytes = addGraphCorpusBytes(
        configBytes,
        Buffer.byteLength(file.source, "utf8"),
        "config",
      );
      return [path, file.source] as const;
    } catch (error) {
      throw new GraphSourceStagingError([sourceStagingFailure(path, "read", error)]);
    }
  });
  return new Map(configs);
}

/**
 * Identify config inputs by what they contribute to extraction, not by bytes.
 *
 * Hashing raw content made a dependency bump, an npm script or a reindent
 * indistinguishable from a change to module resolution, and every one of them
 * invalidated the index. `graphConfigIdentity` projects each file down to the
 * fields that decide what the compiler resolves, and falls back to exact bytes
 * for anything it cannot parse or recognize.
 */
export function configHashForSources(configSources: ReadonlyMap<string, string>): string {
  return sha256(JSON.stringify([...configSources.entries()]
    .map(([path, source]) => [path, sha256(graphConfigIdentity(path, source))])
    .sort(([left], [right]) => compareCodePoints(left!, right!))));
}

function resolveContainedRepoFile(
  root: string,
  canonicalRoot: string,
  relPath: string,
): string {
  const lexicalRoot = resolve(root);
  const absolutePath = resolve(lexicalRoot, relPath);
  if (!isContainedPath(lexicalRoot, absolutePath)) {
    throw sourceContainmentError("Source path escapes the repository root.");
  }
  const canonicalPath = realpathSync(absolutePath);
  if (!isContainedPath(canonicalRoot, canonicalPath)) {
    throw sourceContainmentError("Resolved source path escapes the repository root.");
  }
  return canonicalPath;
}

function readStableUtf8File(
  canonicalPath: string,
  sourcePath = canonicalPath,
  maxBytes = GRAPH_CORPUS_LIMITS.maxSourceFileBytes,
  // Named explicitly rather than inferred from `maxBytes`. The source and
  // config per-file ceilings are numerically identical, so comparing the value
  // reported every oversized *source* file as a config-limit breach.
  limitName: "maxSourceFileBytes" | "maxConfigFileBytes" = "maxSourceFileBytes",
): {
  source: string;
  size: number;
  modifiedAt: number;
} {
  const before = lstatSync(canonicalPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw sourceContainmentError("Resolved source path is not a stable regular file.");
  }
  const remembered = recallSource(canonicalPath, before);
  if (remembered !== undefined) {
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      throw new GraphCorpusLimitError(limitName, Number.isSafeInteger(before.size) ? before.size : undefined);
    }
    return { source: remembered, size: before.size, modifiedAt: before.mtimeMs };
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw sourceContainmentError("Source path changed before it could be opened.");
    }
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxBytes) {
      throw new GraphCorpusLimitError(
        limitName,
        Number.isSafeInteger(opened.size) ? opened.size : undefined,
      );
    }
    const source = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    const resolvedAfter = realpathSync(sourcePath);
    const pathAfter = lstatSync(resolvedAfter);
    if (!sameFileIdentity(opened, after)
      || !isSameResolvedPath(resolvedAfter, canonicalPath)
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !sameFileIdentity(opened, pathAfter)) {
      throw sourceContainmentError("Source file changed while it was being read.");
    }
    rememberSource(canonicalPath, opened, source);
    return { source, size: opened.size, modifiedAt: opened.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function sameFileIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

function sourceContainmentError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "GRAPH_SOURCE_PATH_ESCAPE" });
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


function sha256(text: string | Buffer): string { return createHash("sha256").update(text).digest("hex"); }
function compareCodePoints(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
