/**
 * The optional semantic extra.
 *
 * `@huggingface/transformers` and the MiniLM model (about 23 MB with its
 * runtime) are never dependencies of MEX. On request they are installed into a
 * MEX-managed directory under the per-machine MEX home, and loaded from there
 * with a dynamic import. When the directory is absent or broken, the composer
 * simply has no embedder and uses the lexical recipe; nothing errors.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mexHomeDir } from "../global-config.js";
import type { Embedder } from "./dense.js";
import { DENSE_MODEL, DENSE_MODEL_ID } from "./frozen.js";
import { ensureDirectory, removeManagedDirectory, writeManagedFile } from "./local-state.js";

/** The library version the frozen recipe was evaluated with. */
export const SEMANTIC_LIBRARY_VERSION = "4.3.1";
const MARKER_NAME = "mex-semantic-extra";
const EXPECTED_DIMENSIONS = 384;
const MAX_SIZE_WALK_ENTRIES = 200_000;

export const semanticDirectory = (): string => join(mexHomeDir(), "semantic");

const modelCacheOf = (dir: string): string => join(dir, "models");
const modelFileOf = (dir: string): string =>
  join(modelCacheOf(dir), ...DENSE_MODEL.model.split("/"), "onnx", "model_quantized.onnx");
const libraryEntryOf = (dir: string): string =>
  join(dir, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs");
const libraryManifestOf = (dir: string): string =>
  join(dir, "node_modules", "@huggingface", "transformers", "package.json");

export interface SemanticStatus {
  /** `installed`: library and model present. `partial`: one of them is missing. `absent`: nothing there. */
  state: "installed" | "partial" | "absent";
  directory: string;
  library: { installed: boolean; version: string | null };
  model: { id: string; dtype: string; cached: boolean };
  /** Disk used by the managed directory; null if it does not exist or was not measured. */
  bytes: number | null;
}

function directoryBytes(dir: string): number | null {
  if (!existsSync(dir)) return null;
  let total = 0;
  let visited = 0;
  const stack = [dir];
  while (stack.length > 0 && visited < MAX_SIZE_WALK_ENTRIES) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) {
        try {
          total += statSync(path).size;
        } catch {
          // A file removed mid-walk does not count.
        }
      }
    }
  }
  return total;
}

export function semanticStatus(dir: string = semanticDirectory(), options: { measure?: boolean } = {}): SemanticStatus {
  let version: string | null = null;
  try {
    version = (JSON.parse(readFileSync(libraryManifestOf(dir), "utf8")) as { version?: string }).version ?? null;
  } catch {
    version = null;
  }
  const libraryInstalled = version !== null && existsSync(libraryEntryOf(dir));
  const modelCached = existsSync(modelFileOf(dir));
  return {
    state: libraryInstalled && modelCached ? "installed" : libraryInstalled || modelCached ? "partial" : "absent",
    directory: dir,
    library: { installed: libraryInstalled, version },
    model: { id: DENSE_MODEL.model, dtype: DENSE_MODEL.dtype, cached: modelCached },
    // Walking the install is slow (tens of thousands of files); only `status` asks for it.
    bytes: options.measure === false ? null : directoryBytes(dir),
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface TransformersModule {
  env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels?: boolean };
  pipeline: (
    task: string,
    model: string,
    options: { dtype: string },
  ) => Promise<((text: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>) & { dispose?: () => Promise<void> | void }>;
}

async function importLibrary(dir: string): Promise<TransformersModule> {
  const entry = existsSync(libraryEntryOf(dir))
    ? libraryEntryOf(dir)
    : createRequire(join(dir, "package.json")).resolve("@huggingface/transformers");
  const loaded = (await import(pathToFileURL(entry).href)) as Record<string, unknown> & { default?: Record<string, unknown> };
  const module = (loaded["pipeline"] ? loaded : loaded.default) as unknown as TransformersModule | undefined;
  if (!module?.pipeline || !module.env) throw new Error("The installed semantic library has an unexpected shape.");
  return module;
}

export interface LoadedEmbedder {
  embedder: Embedder | null;
  /** Why there is no embedder, when there is not. */
  reason?: string;
}

/**
 * Load the embedder from the managed directory.
 *
 * `allowDownload` is true only while installing; at prompt time the model must
 * already be cached, so a prompt can never block on the network.
 */
export async function loadEmbedder(
  dir: string = semanticDirectory(),
  options: { allowDownload?: boolean } = {},
): Promise<LoadedEmbedder> {
  const status = semanticStatus(dir, { measure: false });
  if (!options.allowDownload && status.state !== "installed") {
    return { embedder: null, reason: status.state === "absent" ? "The semantic extra is not installed." : "The semantic extra is incomplete." };
  }
  if (!status.library.installed) return { embedder: null, reason: "The semantic library is not installed." };
  try {
    const t = await importLibrary(dir);
    t.env.cacheDir = modelCacheOf(dir);
    t.env.allowRemoteModels = options.allowDownload === true;
    const extractor = await t.pipeline("feature-extraction", DENSE_MODEL.model, { dtype: DENSE_MODEL.dtype });
    return {
      embedder: {
        modelId: DENSE_MODEL_ID,
        async embed(text: string): Promise<Float32Array> {
          const out = await extractor(text, { pooling: DENSE_MODEL.pooling, normalize: DENSE_MODEL.normalize });
          return Float32Array.from(out.data);
        },
        async dispose(): Promise<void> {
          await extractor.dispose?.();
        },
      },
    };
  } catch (error) {
    return { embedder: null, reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Install and remove
// ---------------------------------------------------------------------------

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command; injectable so tests never touch npm or the network. */
export type CommandRunner = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, args, cwd, timeoutMs) => {
  // Loaded on demand: only an install runs a child process.
  const { default: crossSpawn } = await import("cross-spawn");
  return new Promise((resolve) => {
    const child = crossSpawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const cap = 64 * 1024;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr: `${stderr}\n(timed out after ${Math.round(timeoutMs / 1000)}s)` });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
};

export class SemanticInstallError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "SemanticInstallError";
  }
}

export interface InstallOptions {
  dir?: string;
  run?: CommandRunner;
  /** Replace the model download and verification step (tests). */
  verifyModel?: (dir: string) => Promise<void>;
  progress?: (message: string) => void;
}

async function downloadAndVerifyModel(dir: string): Promise<void> {
  const { embedder, reason } = await loadEmbedder(dir, { allowDownload: true });
  if (embedder === null) throw new SemanticInstallError("The semantic model could not be loaded.", reason);
  try {
    const probe = await embedder.embed("mex");
    if (probe.length !== EXPECTED_DIMENSIONS) {
      throw new SemanticInstallError(`The model produced ${probe.length} dimensions, expected ${EXPECTED_DIMENSIONS}.`);
    }
  } finally {
    await embedder.dispose?.();
  }
}

/** Install the library and the model into the managed directory, then verify them. */
export async function installSemantic(options: InstallOptions = {}): Promise<SemanticStatus> {
  const dir = options.dir ?? semanticDirectory();
  const run = options.run ?? runCommand;
  const say = options.progress ?? (() => undefined);
  ensureDirectory(dir);
  writeManagedFile(
    dir,
    join(dir, "package.json"),
    `${JSON.stringify({ name: MARKER_NAME, private: true, description: "Managed by `mex context semantic`. Safe to delete." }, null, 2)}\n`,
  );
  say(`Installing @huggingface/transformers@${SEMANTIC_LIBRARY_VERSION} into ${dir}`);
  const npm = await run(
    "npm",
    ["install", `@huggingface/transformers@${SEMANTIC_LIBRARY_VERSION}`, "--no-audit", "--no-fund", "--loglevel=error"],
    dir,
    10 * 60_000,
  );
  if (npm.code !== 0) {
    throw new SemanticInstallError("npm could not install the semantic library.", (npm.stderr || npm.stdout).trim().slice(-800));
  }
  say(`Downloading ${DENSE_MODEL.model} (${DENSE_MODEL.dtype})`);
  await (options.verifyModel ?? downloadAndVerifyModel)(dir);
  return semanticStatus(dir);
}

/** Remove the managed directory. Refuses a directory MEX did not create. */
export function removeSemantic(dir: string = semanticDirectory()): { removed: boolean } {
  if (!existsSync(dir)) return { removed: false };
  let name: string | undefined;
  try {
    name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name;
  } catch {
    name = undefined;
  }
  if (name !== MARKER_NAME) {
    throw new SemanticInstallError(`${dir} was not created by \`mex context semantic install\`; not removing it.`);
  }
  removeManagedDirectory(join(dir, ".."), dir);
  return { removed: true };
}
