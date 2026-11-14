import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, opendirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { realPath, projectIdentity } from "../record/project.js";
import { containedDirectory, readBoundedTextFile } from "./files.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError } from "./contract.js";

export type MemoryAgent = "claude-code" | "codex";
export interface MemoryOptions extends KnowledgeOptions { env?: NodeJS.ProcessEnv; userHome?: string; consumerAgent?: string; }
export interface MemoryCandidate {
  agent: MemoryAgent; text: string; sourceRoot: string; sourcePath: string;
  sourceHash: string; sourceBytes: number; observation: string; observedAt: number; ref: string;
}
export interface MemoryDiscovery {
  candidates: MemoryCandidate[]; files: number; skipped: number; partial: boolean;
  agents: Record<MemoryAgent, "missing" | "readable" | "partial">;
}
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const MEMORY_LIMITS = Object.freeze({ files: 128, paths: 1024, bytes: 4 * 1024 * 1024, fileBytes: 1024 * 1024, hints: 128 });

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
export function memoryRoots(options: MemoryOptions, onProblem?: (agent: MemoryAgent) => void): Array<{ agent: MemoryAgent; root: string }> {
  const env = options.env ?? process.env, userHome = options.userHome ?? homedir();
  const project = knowledgeProject(options), roots: Array<{ agent: MemoryAgent; root: string }> = [];
  try {
  const claude = selectedDirectory(resolve(env.CLAUDE_CONFIG_DIR || join(userHome, ".claude")));
  if (claude) {
    let custom: string | undefined;
    const settings = readBoundedTextFile(join(claude, "settings.json"), 64 * 1024);
    if (settings) {
      const config = JSON.parse(settings);
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Unknown memory configuration");
      const path = config.autoMemoryDirectory;
      if (path !== undefined) {
        if (typeof path !== "string" || !(isAbsolute(path) || path.startsWith("~/"))) throw new Error("Unknown memory directory");
        custom = path.startsWith("~/") ? join(userHome, path.slice(2)) : path;
      }
    }
    if (custom) {
      const root = selectedDirectory(custom);
      if (root) roots.push({ agent: "claude-code", root });
    } else {
      const projectPaths = new Set([project.root]);
      try {
        const common = execFileSync("git", ["-C", project.root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
          { encoding: "utf8", timeout: 1500, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
        if (basename(common) === ".git") projectPaths.add(realPath(dirname(common)));
      } catch { /* A non-Git folder has only its explicit project root. */ }
      const override = env.CLAUDE_CODE_PROJECT_DIR_NAME;
      const names = override && /^[A-Za-z0-9._-]+$/u.test(override) && override !== "." && override !== ".."
        ? [override] : [...projectPaths].map(path => path.replace(/[^a-zA-Z0-9]/gu, "-"));
      for (const name of names) {
        const root = containedDirectory(claude, ["projects", name, "memory"]);
        if (root) roots.push({ agent: "claude-code", root });
      }
    }
  }
  } catch { onProblem?.("claude-code"); }
  try {
  const codex = selectedDirectory(resolve(env.CODEX_HOME || join(userHome, ".codex")));
  if (codex) for (const name of ["memories_v2", "memories"]) {
    const root = containedDirectory(codex, [name]);
    if (root) roots.push({ agent: "codex", root });
  }
  } catch { onProblem?.("codex"); }
  return roots.filter((item, index) => roots.findIndex(other => other.agent === item.agent && other.root === item.root) === index);
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

/** Closed, read-only layouts. No transcript, raw-memory, skill or tool-output ingestion. */
export function discoverMemory(options: MemoryOptions, now = new Date()): MemoryDiscovery {
  const project = knowledgeProject(options);
  const result: MemoryDiscovery = { candidates: [], files: 0, skipped: 0, partial: false, agents: { "claude-code": "missing", codex: "missing" } };
  let roots: ReturnType<typeof memoryRoots>;
  try { roots = memoryRoots(options, agent => { result.partial = true; result.agents[agent] = "partial"; }); }
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
  const add = (agent: MemoryAgent, root: string, path: string, source: string, text: string, stamp: number, observation: string, sourceBytes: number) => {
    if (result.candidates.length >= MEMORY_LIMITS.hints) { result.partial = true; return; }
    const facts = paragraphs(text);
    for (const fact of facts) {
      if (result.candidates.length >= MEMORY_LIMITS.hints) { result.partial = true; break; }
      result.candidates.push({ agent, text: fact, sourceRoot: root, sourcePath: path, sourceHash: digest(source), sourceBytes,
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
              add(agent, root, path, source, body, Number(after.mtimeMs), `${path}\n${digest(body)}`, Number(after.size));
            } else if (prefix === "rollout_summaries") {
              const cwd = /^cwd:\s*(.+)$/mu.exec(source)?.[1].trim();
              const thread = /^thread_id:\s*(\S+)$/mu.exec(source)?.[1];
              const updated = Date.parse(/^updated_at:\s*(.+)$/mu.exec(source)?.[1] ?? "");
              if (!cwd || !thread || !Number.isFinite(updated)) throw new Error("Unknown rollout summary format");
              if (!withinProject(cwd)) { result.skipped++; continue; }
              add(agent, root, path, source, learnings(source).join("\n\n"), updated, `${thread}\n${updated}`, Number(after.size));
            } else {
              const blocks = source.split(/(?=^# Task Group:)/mu).filter(block => block.startsWith("# Task Group:"));
              if (!blocks.length) throw new Error("Unknown consolidated memory format");
              for (const block of blocks) {
                const cwds = [...block.matchAll(/\bcwd=([^,)\n]+)/gu)].map(match => match[1].trim());
                if (!cwds.length || !cwds.every(withinProject)) { result.skipped++; continue; }
                add(agent, root, path, source, learnings(block).join("\n\n"), Number(after.mtimeMs), digest(block), Number(after.size));
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

export function checkMemorySource(candidate: Pick<MemoryCandidate, "agent" | "sourceRoot" | "sourcePath" | "sourceHash" | "sourceBytes">, options: MemoryOptions, roots = memoryRoots(options)): boolean {
  try {
    if (!roots.some(root => root.agent === candidate.agent && root.root === candidate.sourceRoot)) return false;
    const parts = candidate.sourcePath.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[\\\0]/u.test(part))) return false;
    const parent = parts.slice(0, -1);
    if (parent.length && !containedDirectory(candidate.sourceRoot, parent)) return false;
    const file = join(candidate.sourceRoot, candidate.sourcePath), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== candidate.sourceBytes) return false;
    const text = readBoundedTextFile(file, MEMORY_LIMITS.fileBytes);
    return text !== undefined && digest(text) === candidate.sourceHash;
  } catch { return false; }
}
