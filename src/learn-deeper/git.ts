import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backgroundEnvironment } from "../filter/environment.js";
import { containedDirectory } from "../knowledge/files.js";
import { repositoryFromRemote, type Repository } from "./source.js";

export async function command(root: string, executable: string, args: string[], input?: string, limit = 64 << 10): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = execFile(executable, args, { cwd: root, encoding: "utf8", timeout: 2500, maxBuffer: limit,
      windowsHide: true, env: { ...backgroundEnvironment(), GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
        GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_TERMINAL_PROMPT: "0" },
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
  constructor(readonly root: string, readonly head: string, private readonly blobs: ReadonlyMap<string, string>) {}

  static async open(root: string, head: string): Promise<PinnedTree | undefined> {
    if (!SHA.test(head)) return undefined;
    const listing = await command(root, "git", ["ls-tree", "-rz", "--full-tree", head], undefined, TREE_BYTES);
    if (listing === undefined) return undefined;
    const blobs = new Map<string, string>();
    for (const row of listing.split("\0")) {
      const match = /^100(?:644|755) blob ([a-f0-9]+)\t(.+)$/u.exec(row);
      if (match && SHA.test(match[1]) && repoPath(match[2])) blobs.set(match[2], match[1]);
    }
    return new PinnedTree(root, head, blobs);
  }

  has(path: string): boolean { return this.blobs.has(path); }

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
    const blob = this.blobs.get(path);
    if (!blob) return undefined;
    const content = await command(this.root, "git", ["cat-file", "blob", blob], undefined, FILE_BYTES);
    return content?.includes("\0") ? undefined : content;
  }

  async lastChanged(path: string): Promise<string | undefined> {
    if (!this.has(path)) return undefined;
    const date = (await command(this.root, "git", ["--literal-pathspecs", "log", "-1", "--format=%cI", this.head, "--", path]))?.trim();
    return date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : undefined;
  }

  /** The native record-check command needs a directory. Stage only the declared dependencies. */
  async withCheckFiles<T>(home: string, jobId: string, paths: readonly string[], run: (checkout: string) => Promise<T>): Promise<T | undefined> {
    const parent = scratchPath(home, jobId, true)!;
    const dir = await mkdtemp(join(parent, "batch-"));
    try {
      for (const path of new Set(paths)) {
        if (!repoPath(path)) return undefined;
        const content = await this.read(path);
        if (content === undefined) return undefined;
        const file = join(dir, path);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, content, { flag: "wx", mode: 0o600 });
      }
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rmdir(parent);
    }
  }
}
