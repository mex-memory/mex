import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, opendirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { realPath, projectIdentity } from "../record/project.js";
import { containedDirectory, readBoundedTextFile } from "./files.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError } from "./contract.js";

export type MemoryAgent = "claude-code" | "codex";
export type MemoryState = "missing" | "off" | "readable" | "partial";
export const MEMORY_NAMES = { "claude-code": "Claude Code", codex: "Codex" } as const;
export interface MemorySessionReference { id?: string; path?: string; }
export interface MemoryOptions extends KnowledgeOptions { env?: NodeJS.ProcessEnv; userHome?: string; consumerAgent?: string; }
export interface MemoryCandidate {
  agent: MemoryAgent; text: string; sourceRoot: string; sourcePath: string;
  sourceHash: string; sourceBytes: number; observation: string; observedAt: number; ref: string;
  modifiedAt: number; sessionReference?: MemorySessionReference;
}
export interface MemoryDiscovery {
  candidates: MemoryCandidate[]; files: number; skipped: number; partial: boolean;
  agents: Record<MemoryAgent, MemoryState>;
}
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const MEMORY_LIMITS = Object.freeze({ files: 128, paths: 1024, bytes: 4 * 1024 * 1024, fileBytes: 1024 * 1024, hints: 128 });
export const memoryOffNotice = (agent: MemoryAgent) => `${MEMORY_NAMES[agent]} memory is off: MEX learns from your messages only`;

export function normalizeMemoryAgent(agent: string | undefined): string | undefined {
  if (agent === undefined) return undefined;
  const normalized = agent.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(normalized)) throw new KnowledgeError("INVALID_AGENT", "Expected the recipient agent name, such as codex or claude-code.");
  return normalized === "claude" ? "claude-code" : normalized;
}

function selectedDirectory(path: string): string | undefined {
  try { return statSync(path).isDirectory() ? realPath(path) : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/**
 * Git's common directory for a checkout root, read from the files git itself uses: a `.git`
 * folder is its own, and a linked worktree's `.git` file names its git dir, whose `commondir`
 * file names the shared one. Undefined when the layout is anything else.
 */
function commonDirFromFiles(root: string): string | undefined {
  const dotGit = join(root, ".git");
  const stat = lstatSync(dotGit, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile() || stat.size > 4096) return undefined;
  const pointer = /^gitdir: (.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
  if (!pointer) return undefined;
  const gitDir = resolve(root, pointer);
  try { return resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return gitDir; throw error; }
}

/**
 * The main checkout of a linked worktree (the folder holding the common `.git`), or undefined.
 * Read from git's files: a git start costs tens of milliseconds on Windows. Git answers only
 * when the files don't.
 */
function mainCheckout(root: string): string | undefined {
  try {
    let common: string | undefined;
    try { common = commonDirFromFiles(root); } catch { common = undefined; }
    common ??= execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", timeout: 1500, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    return basename(common) === ".git" ? realPath(dirname(common)) : undefined;
  } catch { return undefined; /* A non-Git folder has only its explicit project root. */ }
}

function claudeSettings(directory: string, name: string): { autoMemoryEnabled?: unknown; autoMemoryDirectory?: unknown } {
  const raw = readBoundedTextFile(join(directory, name), 64 << 10);
  if (raw === undefined) return {};
  const config = JSON.parse(raw);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Unknown memory configuration");
  return config;
}

export function memoryRoots(options: MemoryOptions, report?: (agent: MemoryAgent, state: "off" | "partial") => void): Array<{ agent: MemoryAgent; root: string }> {
  const env = options.env ?? process.env, userHome = options.userHome ?? homedir();
  const project = knowledgeProject(options), roots: Array<{ agent: MemoryAgent; root: string }> = [];
  try {
    const claude = selectedDirectory(resolve(env.CLAUDE_CONFIG_DIR || join(userHome, ".claude")));
    const settings = claude ? claudeSettings(claude, "settings.json") : {};
    const local = containedDirectory(project.root, [".claude"]);
    const disabled = env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1" || settings.autoMemoryEnabled === false
      || !!local && ["settings.json", "settings.local.json"].some(name => claudeSettings(local, name).autoMemoryEnabled === false);
    if (disabled) report?.("claude-code", "off");
    else if (claude) {
      const custom = settings.autoMemoryDirectory;
      if (custom !== undefined) {
        if (typeof custom !== "string" || !(isAbsolute(custom) || custom.startsWith("~/"))) throw new Error("Unknown memory directory");
        const root = selectedDirectory(custom.startsWith("~/") ? join(userHome, custom.slice(2)) : custom);
        if (root) roots.push({ agent: "claude-code", root });
      } else {
        const projectPaths = new Set([project.root]);
        const main = mainCheckout(project.root);
        if (main) projectPaths.add(main);
        const override = env.CLAUDE_CODE_PROJECT_DIR_NAME;
        const names = override && /^[A-Za-z0-9._-]+$/u.test(override) && override !== "." && override !== ".."
          ? [override] : [...projectPaths].map(path => path.replace(/[^a-zA-Z0-9]/gu, "-"));
        for (const name of names) {
          const root = containedDirectory(claude, ["projects", name, "memory"]);
          if (root) roots.push({ agent: "claude-code", root });
        }
      }
    }
  } catch { report?.("claude-code", "partial"); }
  try {
    const codex = selectedDirectory(resolve(env.CODEX_HOME || join(userHome, ".codex")));
    if (codex) {
      const raw = readBoundedTextFile(join(codex, "config.toml"), 64 << 10);
      const config = raw === undefined ? {} : parseToml(raw) as { features?: { memories?: boolean }; memories?: { use_memories?: boolean } };
      if (config.features?.memories === false || config.memories?.use_memories === false) report?.("codex", "off");
      else for (const name of ["memories_v2", "memories"]) {
        const root = containedDirectory(codex, [name]);
        if (root) roots.push({ agent: "codex", root });
      }
    }
  } catch { report?.("codex", "partial"); }
  return roots.filter((item, index) => roots.findIndex(other => other.agent === item.agent && other.root === item.root) === index);
}

export function hostMemoryStatus(options: MemoryOptions): Record<MemoryAgent, MemoryState> {
  const states: Record<MemoryAgent, MemoryState> = { "claude-code": "missing", codex: "missing" };
  for (const { agent, root } of memoryRoots(options, (agent, state) => { states[agent] = state; })) {
    if (states[agent] === "readable") continue;
    let summaries: string | undefined;
    try { if (agent === "codex") summaries = containedDirectory(root, ["rollout_summaries"]); }
    catch { states[agent] = "partial"; }
    for (const folder of summaries ? [root, summaries] : [root]) {
      try {
        const directory = opendirSync(folder);
        try {
          for (let count = 0; ; count++) {
            const child = directory.readSync();
            if (!child) break;
            if (count >= MEMORY_LIMITS.paths) { states[agent] = "partial"; break; }
            if (child.isFile() && (agent === "codex" && folder === root ? child.name === "MEMORY.md" : child.name.endsWith(".md"))) {
              states[agent] = "readable";
              break;
            }
          }
        } finally { directory.closeSync(); }
      } catch { states[agent] = "partial"; }
      if (states[agent] === "readable") break;
    }
  }
  return states;
}

function paragraphs(text: string): string[] {
  const body = text.replace(/```[^\n]*\n[\s\S]*?```/gu, "");
  return body.split(/\n\s*\n|\n(?=\s*[-*]\s)/u).map(part => part.trim().replace(/^[-*]\s+/u, "").replace(/\s+/gu, " "))
    .filter(part => part.length > 0 && part.length <= 1024 && !part.startsWith("#") && !/^\[[^\]]+\]\([^)]*\)$/u.test(part));
}
function learnings(text: string): string[] {
  const result: string[] = [];
  let active = false, lines: string[] = [];
  const flush = () => { if (active) result.push(...paragraphs(lines.join("\n"))); lines = []; };
  for (const line of text.split(/\r?\n/u)) {
    if (/^(?:#{1,6}\s*)?(?:reusable knowledge|learnings|user preferences|preference signals)\s*:?\s*$/iu.test(line.trim())) {
      flush(); active = true; continue;
    }
    if (/^#{1,6}\s|^[A-Za-z][A-Za-z /-]{2,50}:\s*$/u.test(line.trim())) { flush(); active = false; continue; }
    if (active) lines.push(line);
  }
  flush();
  return result;
}

function sessionReference(id?: string, path?: string): MemorySessionReference | undefined {
  id = id && /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : undefined;
  path = path && path.length <= 4096 && isAbsolute(path) && path.endsWith(".jsonl") ? path : undefined;
  return id || path ? { id, path } : undefined;
}

function uniqueReference(references: Array<MemorySessionReference | undefined>): MemorySessionReference | undefined {
  const first = references[0];
  return first && references.every(ref => ref?.id === first.id && ref?.path === first.path) ? first : undefined;
}

function taskReference(block: string): MemorySessionReference | undefined {
  const rows = block.split(/\r?\n/u).filter(line => /^\s*[-*]\s+.+\(cwd=/u.test(line));
  return uniqueReference(rows.map(row => sessionReference(/\bthread_id=([A-Za-z0-9_-]+)(?=[,)\s])/u.exec(row)?.[1],
    /\brollout_path=([^,)]+)/u.exec(row)?.[1]?.trim())));
}

function consolidatedFacts(block: string): Array<{ text: string; reference?: MemorySessionReference }> {
  const byTask = new Map<string, MemorySessionReference | undefined>();
  for (const section of block.split(/^## /mu)) {
    const id = /^Task (\d+)(?=[:\r\n])/u.exec(section)?.[1];
    if (id) byTask.set(id, byTask.has(id) ? undefined : taskReference(section));
  }
  const groupReference = taskReference(block);
  return learnings(block).map(text => {
    const tasks = [...text.matchAll(/\[Task (\d+)\]/gu)].map(match => byTask.get(match[1]!));
    // Claims with mixed or unreadable references can still be ordinary hints.
    return { text, reference: tasks.length ? uniqueReference(tasks) : groupReference };
  });
}

/** Closed, read-only layouts. No transcript, raw-memory, skill or tool-output ingestion. */
export function discoverMemory(options: MemoryOptions, now = new Date()): MemoryDiscovery {
  const project = knowledgeProject(options);
  const result: MemoryDiscovery = { candidates: [], files: 0, skipped: 0, partial: false, agents: { "claude-code": "missing", codex: "missing" } };
  let roots: ReturnType<typeof memoryRoots>;
  try { roots = memoryRoots(options, (agent, state) => { if (state === "partial") result.partial = true; result.agents[agent] = state; }); }
  catch { return { ...result, partial: true, agents: { "claude-code": "partial", codex: "partial" } }; }
  let bytes = 0, paths = 0;
  const started = performance.now(), scopes = new Map<string, boolean>();
  const withinProject = (cwd: string): boolean => {
    if (!isAbsolute(cwd) || cwd.length > 4096) return false;
    if (scopes.has(cwd)) return scopes.get(cwd)!;
    if (scopes.size >= 32 || performance.now() - started > 10_000) { result.partial = true; return false; }
    let matches = false;
    try {
      const actual = realPath(cwd);
      matches = actual === project.root || projectIdentity(actual).id === project.projectId;
    } catch { /* Unknown/missing scope is never another project's evidence. */ }
    scopes.set(cwd, matches); return matches;
  };
  const add = (agent: MemoryAgent, root: string, path: string, sourceHash: string, text: string, stamp: number, observation: string,
    stat: { size: bigint; mtimeMs: bigint }, sessionReference?: MemorySessionReference) => {
    if (result.candidates.length >= MEMORY_LIMITS.hints) { result.partial = true; return; }
    const facts = paragraphs(text);
    for (const fact of facts) {
      if (result.candidates.length >= MEMORY_LIMITS.hints) { result.partial = true; break; }
      result.candidates.push({ agent, text: fact, sourceRoot: root, sourcePath: path, sourceHash, sourceBytes: Number(stat.size),
        modifiedAt: Number(stat.mtimeMs), sessionReference,
        observedAt: Math.min(now.getTime(), stamp), observation: digest(`${agent}\n${observation}\n${fact}`), ref: `agent-memory:${agent}/${digest(path).slice(7, 31)}` });
    }
  };
  for (const { agent, root } of roots) {
    const visit = (folder: string, prefix = "") => {
      const handle = opendirSync(folder);
      try {
        let child;
        while ((child = handle.readSync())) {
          if (++paths > MEMORY_LIMITS.paths || result.files >= MEMORY_LIMITS.files || performance.now() - started > 10_000) { result.partial = true; break; }
          const path = prefix ? `${prefix}/${child.name}` : child.name;
          if (child.isSymbolicLink()) { result.skipped++; result.partial = true; continue; }
          if (agent === "codex" && !prefix && child.isDirectory() && child.name === "rollout_summaries") { visit(join(folder, child.name), path); continue; }
          if (!child.isFile() || !child.name.endsWith(".md") || (agent === "codex" && !prefix && child.name !== "MEMORY.md")) continue;
          result.files++;
          try {
            const file = join(root, path), before = lstatSync(file, { bigint: true });
            if (before.nlink !== 1n || before.isSymbolicLink()) throw new Error("Linked memory source");
            const actual = realPath(file), rel = relative(root, actual);
            if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Redirected memory source");
            const source = readBoundedTextFile(file, MEMORY_LIMITS.fileBytes);
            if (source === undefined) continue;
            bytes += Buffer.byteLength(source);
            if (bytes > MEMORY_LIMITS.bytes) { result.partial = true; break; }
            const after = lstatSync(file, { bigint: true });
            if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs) throw new Error("Changed memory source");
            if (result.agents[agent] !== "partial") result.agents[agent] = "readable";
            const sourceHash = digest(source);
            if (agent === "claude-code") {
              let body = source;
              const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source);
              if (front) {
                const doc = parseDocument(front[1], { uniqueKeys: true });
                if (doc.errors.length || doc.warnings.length) throw new Error("Unknown memory frontmatter");
                const meta = doc.toJS({ maxAliasCount: 0 });
                if (!meta || Object.keys(meta).some(key => !["name", "description", "type"].includes(key))) throw new Error("Unknown memory frontmatter");
                body = front[2];
              }
              // A routing index of links is not itself a fact.
              if (child.name === "MEMORY.md" && /\[[^\]]+\]\([^)]*\.md(?:#[^)]*)?\)/u.test(body)) continue;
              add(agent, root, path, sourceHash, body, Number(after.mtimeMs), `${path}\n${digest(body)}`, after);
            } else if (prefix === "rollout_summaries") {
              const header = source.split(/\r?\n(?:\s*\r?\n|(?=#))/u, 1)[0]!;
              const cwd = /^cwd:[ \t]*(.+)$/mu.exec(header)?.[1].trim();
              const thread = /^thread_id:[ \t]*(\S+)[ \t]*$/mu.exec(header)?.[1];
              const rollout = /^rollout_path:[ \t]*(.+)$/mu.exec(header)?.[1].trim();
              const updated = Date.parse(/^updated_at:[ \t]*(.+)$/mu.exec(header)?.[1] ?? "");
              if (!cwd || !Number.isFinite(updated)) throw new Error("Unknown rollout summary format");
              if (!withinProject(cwd)) { result.skipped++; continue; }
              add(agent, root, path, sourceHash, learnings(source).join("\n\n"), updated, `${thread ?? rollout ?? path}\n${updated}`, after, sessionReference(thread, rollout));
            } else {
              const blocks = source.split(/(?=^# Task Group:)/mu).filter(block => block.startsWith("# Task Group:"));
              if (!blocks.length) throw new Error("Unknown consolidated memory format");
              for (const block of blocks) {
                const cwds = [...block.matchAll(/\bcwd=([^,)\n]+)/gu)].map(match => match[1].trim());
                if (!cwds.length || !cwds.every(withinProject)) { result.skipped++; continue; }
                const blockHash = digest(block);
                for (const { text, reference } of consolidatedFacts(block)) {
                  add(agent, root, path, sourceHash, text, Number(after.mtimeMs), blockHash, after, reference);
                }
              }
            }
          } catch { result.skipped++; result.partial = true; result.agents[agent] = "partial"; }
        }
      } finally { handle.closeSync(); }
    };
    try { visit(root); } catch { result.partial = true; result.agents[agent] = "partial"; }
  }
  return result;
}

export function checkMemorySource(candidate: Pick<MemoryCandidate, "agent" | "sourceRoot" | "sourcePath" | "sourceHash" | "sourceBytes">
  & { modifiedAt?: number }, options: MemoryOptions, roots = memoryRoots(options)): boolean {
  try {
    if (!roots.some(root => root.agent === candidate.agent && root.root === candidate.sourceRoot)) return false;
    const parts = candidate.sourcePath.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[\\\0]/u.test(part))) return false;
    const parent = parts.slice(0, -1);
    if (parent.length && !containedDirectory(candidate.sourceRoot, parent)) return false;
    const file = join(candidate.sourceRoot, candidate.sourcePath), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== candidate.sourceBytes
      || candidate.modifiedAt !== undefined && Math.trunc(stat.mtimeMs) !== candidate.modifiedAt) return false;
    const text = readBoundedTextFile(file, MEMORY_LIMITS.fileBytes);
    return text !== undefined && digest(text) === candidate.sourceHash;
  } catch { return false; }
}
