import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { looksBinary } from "../file-index/classify.js";
import { backgroundEnvironment } from "../filter/environment.js";
import { containedDirectory } from "../knowledge/files.js";
import { stripHidden } from "../knowledge/gates.js";
import { ruleFormat } from "../knowledge/rule-files.js";
import { safePath } from "./harvest/evidence.js";
import { repositoryFromRemote, type Repository } from "./source.js";

const FILE_READ_MS = 2500;

function commandEnvironment(): NodeJS.ProcessEnv {
  return { ...backgroundEnvironment(), GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
    GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_TERMINAL_PROMPT: "0" };
}

export async function command(root: string, executable: string, args: string[], input?: string, limit = 64 << 10,
  timeout = FILE_READ_MS): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = execFile(executable, args, { cwd: root, encoding: "utf8", timeout, maxBuffer: limit,
      windowsHide: true, env: commandEnvironment(),
    }, (error, stdout) => resolve(error ? undefined : stdout));
    child.stdin?.on("error", () => { /* process failure is reported by execFile */ });
    child.stdin?.end(input);
  });
}

export async function origin(root: string): Promise<Repository | undefined> {
  const remote = await command(root, "git", ["remote", "get-url", "origin"]);
  return remote && repositoryFromRemote(remote.trim()) || undefined;
}

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export async function revision(root: string): Promise<string | undefined> {
  const value = (await command(root, "git", ["rev-parse", "--verify", "HEAD^{commit}"]))?.trim();
  return value && SHA.test(value) ? value : undefined;
}

export function repoPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 300 && !/[\\:*?"<>|\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every(part => part && !/[. ]$/u.test(part) && ![".git", ".mex"].includes(part.toLowerCase())
      && !/^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

const FILE_BYTES = 96 << 10;
const TREE_BYTES = 4 << 20;
// The gate reads a verification body up to 1 MB. Rule files get the same
// bound and a longer read, so a large AGENTS.md is still compared against.
const RULE_FILE_BYTES = 1 << 20;
const RULE_READ_MS = 10_000;
const STAGED_FILES = 512;
const STAGED_BYTES = 12 << 20;
// Match the native --pattern-check reader's per-file limit.
const PATTERN_FILE_BYTES = 512 << 10;
const PRIVATE_MARKER = /<\s*\/?\s*private\b/iu;

export interface PatternStage {
  readable: ReadonlySet<string>;
  binary: ReadonlySet<string>;
}

function knowledgePath(path: string): boolean {
  return repoPath(path) && /\.mdx?$/iu.test(path)
    && !path.split("/").some(part => part.startsWith(".") || part === "node_modules")
    && !/^(?:events|inbox|relays|team|workstreams)\//u.test(path)
    && !/^patterns\/(?:index|readme)\.md$/iu.test(path);
}

function scratchPath(home: string, jobId: string, create: boolean): string | undefined {
  if (!/^[a-f0-9-]{36}$/u.test(jobId)) throw new Error("Invalid learning job identity.");
  return containedDirectory(home, ["learn-checks", jobId], create);
}

/** A resumed owner reclaims only the abandoned staging directories for its own job. */
export async function clearLearningChecks(home: string, jobId: string): Promise<void> {
  const root = scratchPath(home, jobId, false);
  if (!root) return;
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 16 || entries.some(item => !item.isDirectory() || !/^batch-[A-Za-z0-9]{6}$/u.test(item.name))) {
    throw new Error("Learning's temporary check directory contains unexpected files.");
  }
  for (const item of entries) await rm(join(root, item.name), { recursive: true, force: true });
  await rmdir(root);
}

/** Limited to regular files in the consented commit, without consulting the working tree. */
export class PinnedTree {
  constructor(readonly root: string, readonly head: string, private readonly blobs: ReadonlyMap<string, string>,
    private readonly knowledgeBlobs: ReadonlyMap<string, string> = new Map()) {}

  static async open(root: string, head: string): Promise<PinnedTree | undefined> {
    if (!SHA.test(head)) return undefined;
    const listing = await command(root, "git", ["ls-tree", "-rz", "--full-tree", head], undefined, TREE_BYTES);
    if (listing === undefined) return undefined;
    const blobs = new Map<string, string>();
    const knowledge = new Map<string, string>();
    for (const row of listing.split("\0")) {
      const match = /^100(?:644|755) blob ([a-f0-9]+)\t(.+)$/u.exec(row);
      if (!match || !SHA.test(match[1])) continue;
      const [, blob, path] = match;
      if (path.startsWith(".mex/")) {
        const relative = path.slice(5);
        if (knowledgePath(relative)) knowledge.set(relative, blob);
      } else if (repoPath(path)) blobs.set(path, blob);
    }
    return new PinnedTree(root, head, blobs, knowledge);
  }

  has(path: string): boolean { return this.blobs.has(path); }

  paths(): Iterable<string> { return this.blobs.keys(); }

  /** Candidate files only. A matching word is not proof of a declaration. */
  async filesMentioning(identifier: string): Promise<string[]> {
    if (!/^[A-Za-z_$][\w$]{1,79}$/u.test(identifier)) return [];
    const output = await command(this.root, "git", ["grep", "-l", "-z", "-I", "-F", "-w", "--no-textconv", "-e", identifier, this.head, "--"],
      undefined, 256 << 10);
    const prefix = this.head + ":";
    return (output ?? "").split("\0").flatMap(item => item.startsWith(prefix) && this.has(item.slice(prefix.length))
      ? [item.slice(prefix.length)] : []);
  }

  hasWorkflows(): boolean { return [...this.blobs.keys()].some(path => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)); }

  async changedSince(path: string, original: string): Promise<boolean> {
    const current = this.blobs.get(path);
    if (!current || !SHA.test(original) || original === this.head) return false;
    const output = await command(this.root, "git", ["--literal-pathspecs", "ls-tree", "-rz", original, "--", path]);
    const match = /^100(?:644|755) blob ([a-f0-9]+)\t(.+)\0$/u.exec(output ?? "");
    return !!match && match[2] === path && match[1] !== current;
  }

  docs(): string[] {
    return [...this.blobs.keys()]
      .filter(path => /(?:^|\/)(?:readme|contributing|architecture|development)\.(?:md|rst|adoc)$/iu.test(path)
        || /(?:^|\/)(?:docs?|adr|rfcs?|decisions)\/.+\.(?:md|rst|adoc)$/iu.test(path))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "en"));
  }

  async read(path: string): Promise<string | undefined> {
    return this.readBlob(this.blobs.get(path));
  }

  // Keep canonical knowledge out of the admissible source and check paths.
  knowledgePaths(): string[] { return [...this.knowledgeBlobs.keys()]; }

  async readKnowledge(path: string): Promise<string | undefined> {
    return this.readBlob(this.knowledgeBlobs.get(path));
  }

  private async readBlob(blob: string | undefined, limit = FILE_BYTES, timeout?: number): Promise<string | undefined> {
    if (!blob) return undefined;
    const content = await command(this.root, "git", ["cat-file", "blob", blob], undefined, limit, timeout);
    return content?.includes("\0") ? undefined : content;
  }

  private async readPatternBlob(path: string, ruleFile: boolean): Promise<Buffer | "binary" | undefined> {
    const blob = this.blobs.get(path);
    if (!blob || !safePath(path)) return undefined;
    return new Promise(resolve => {
      execFile("git", ["cat-file", "blob", blob], { cwd: this.root, encoding: "buffer",
        maxBuffer: ruleFile ? RULE_FILE_BYTES : PATTERN_FILE_BYTES,
        timeout: ruleFile ? RULE_READ_MS : FILE_READ_MS, windowsHide: true, env: commandEnvironment() }, (error, bytes) => {
        // On overflow execFile retains the bounded prefix. A positive binary
        // classification is sufficient even when the rest couldn't be read.
        if (error && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve(undefined);
        if (looksBinary(bytes) || (!error && bytes.includes(0))) return resolve("binary");
        // These bytes stay in the local check tree. The evidence pipeline
        // screens any excerpt separately before sending it to a model.
        resolve(error || PRIVATE_MARKER.test(stripHidden(bytes.toString("utf8"))) ? undefined : bytes);
      });
    });
  }

  async lastChanged(path: string): Promise<string | undefined> {
    if (!this.has(path)) return undefined;
    const date = (await command(this.root, "git", ["--literal-pathspecs", "log", "-1", "--format=%cI", this.head, "--", path]))?.trim();
    return date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : undefined;
  }

  /** The native record-check command needs a directory. Stage only the declared dependencies. */
  async withCheckFiles<T>(home: string, jobId: string, paths: readonly string[], run: (checkout: string) => Promise<T>): Promise<T | undefined> {
    return this.withScratch(home, jobId, async dir => {
      for (const path of new Set(paths)) {
        if (!repoPath(path)) return undefined;
        const content = await this.read(path);
        if (content === undefined) return undefined;
        await stage(dir, path, content);
      }
      return run(dir);
    });
  }

  /**
   * Project the pinned regular files needed by the gate. Live or untracked files never enter it.
   * Rule files come first and are read with the gate's 1 MB bound. A rule file that still can't
   * be staged is reported to `run` instead of failing: the model call has already been paid for.
   */
  async withCheckTree<T>(home: string, jobId: string, paths: readonly string[],
    run: (checkout: string, files: ReadonlySet<string>, unreadRules: readonly string[]) => Promise<T>): Promise<T> {
    return this.stageCheckTree(home, jobId, paths, (checkout, files, unreadRules) => run(checkout, files, unreadRules));
  }

  /** Use the native reader's limits for pattern proof without changing other staging callers. */
  async withPatternCheckTree<T>(home: string, jobId: string, paths: readonly string[], maxFiles: number,
    run: (checkout: string, files: ReadonlySet<string>, unreadRules: readonly string[], coverage: PatternStage) => Promise<T>): Promise<T> {
    return this.stageCheckTree(home, jobId, paths, run, maxFiles);
  }

  private async stageCheckTree<T>(home: string, jobId: string, paths: readonly string[],
    run: (checkout: string, files: ReadonlySet<string>, unreadRules: readonly string[], coverage: PatternStage) => Promise<T>,
    patternMaxFiles?: number): Promise<T> {
    const rules = [...this.paths()].filter(path => ruleFormat(path));
    const references = [...this.paths()].filter(path =>
      /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|pyproject\.toml|setup\.cfg|tox\.ini|Cargo\.toml|GNUmakefile|Makefile|(?:build|settings)\.gradle(?:\.kts)?|gradlew)$/iu.test(path)
      || /^(?:\.github\/workflows\/[^/]+|\.gitlab-ci)\.ya?ml$/u.test(path)
      || /^(?:docs\/.*|(?:readme|contributing|agents|claude)(?:[._-][^/]*)?)\.md$/iu.test(path));
    const ruleSet = new Set(rules);
    return this.withScratch(home, jobId, async dir => {
      const staged = new Set<string>();
      const readable = new Set<string>(), binary = new Set<string>();
      const files = [...new Set([...rules, ...paths, ...references])].slice(0, patternMaxFiles ?? STAGED_FILES);
      let bytes = 0;
      for (let offset = 0; offset < files.length && bytes < STAGED_BYTES; offset += 8) {
        const chunk = files.slice(offset, offset + 8);
        const bodies = await Promise.all(chunk.map(async path => {
          if (patternMaxFiles !== undefined) {
            const body = await this.readPatternBlob(path, ruleSet.has(path));
            if (body === "binary") binary.add(path);
            else return body;
          } else if (ruleSet.has(path)) return this.readBlob(this.blobs.get(path), RULE_FILE_BYTES, RULE_READ_MS);
          else return this.read(path);
        }));
        for (const [i, path] of chunk.entries()) {
          const body = bodies[i];
          if (body === undefined) continue;
          const size = Buffer.byteLength(body);
          if (bytes + size > STAGED_BYTES) continue;
          await stage(dir, path, body);
          staged.add(path);
          if (patternMaxFiles !== undefined && size <= PATTERN_FILE_BYTES) readable.add(path);
          bytes += size;
        }
      }
      return run(dir, staged, rules.filter(path => !staged.has(path)), { readable, binary });
    });
  }

  private async withScratch<T>(home: string, jobId: string, run: (dir: string) => Promise<T>): Promise<T> {
    const parent = scratchPath(home, jobId, true)!;
    const dir = await mkdtemp(join(parent, "batch-"));
    try {
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rmdir(parent);
    }
  }
}

async function stage(dir: string, path: string, content: string | Buffer): Promise<void> {
  const file = join(dir, path);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, content, { flag: "wx", mode: 0o600 });
}
