/**
 * Existing rule files (CLAUDE.md, AGENTS.md, Cursor, Copilot, Gemini) read as
 * entries. Each section becomes one entry with a section check, tagged with
 * the agents that already load the file, so delivery can give each agent only
 * what it doesn't load itself. Disagreements and stale mentions go to Review.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { KNOWLEDGE_LIMITS } from "./contract.js";
import { validateEntry, type KnowledgeEntry } from "./entry.js";
import { fileHash, sections, textHash } from "./sections.js";

export const AGENTS = ["claude-code", "codex", "cursor", "copilot", "gemini", "opencode"] as const;
export type Agent = (typeof AGENTS)[number];

/** MEX's own text inside rule files: never read back as a source. */
export const GENERATED_MARK = "<!-- mex:generated";
const MANAGED_BLOCK = /<!--\s*mex-agent:[\w-]+:start\s*-->[\s\S]*?<!--\s*mex-agent:[\w-]+:end\s*-->/gu;

const MAX_RULE_FILES = 200;
const MAX_RULE_FILE_BYTES = 256 * 1024;

export interface RuleFile {
  path: string;
  format: "claude" | "claude-rules" | "agents" | "cursor-rules" | "cursorrules" | "copilot" | "copilot-instructions" | "gemini";
  /** Agents that load this file themselves. */
  agents: Agent[];
  scope: string[];
  hash: string;
}
export interface RuleEntry { path: string; agents: Agent[]; entry: KnowledgeEntry; }
export interface ReviewItem { kind: "conflict" | "stale"; paths: string[]; heading: string; message: string; }
export interface RuleScan { files: RuleFile[]; entries: RuleEntry[]; review: ReviewItem[]; }

/** Which format a repository path is, if it is a rule file. */
export function ruleFormat(path: string): RuleFile["format"] | undefined {
  const name = basename(path);
  if (name === "CLAUDE.md" || name === "CLAUDE.local.md") return "claude";
  if (name === "AGENTS.md" || name === "AGENTS.override.md") return "agents";
  if (name === "GEMINI.md") return "gemini";
  if (path === ".cursorrules") return "cursorrules";
  if (path === ".github/copilot-instructions.md") return "copilot";
  if (/^\.github\/instructions\/.+\.instructions\.md$/u.test(path)) return "copilot-instructions";
  if (/^\.claude\/rules\/.+\.md$/u.test(path)) return "claude-rules";
  if (/^\.cursor\/rules\/.+\.mdc?$/u.test(path)) return "cursor-rules";
  return undefined;
}

/** Repository files git would list, without ignored ones. */
function listFiles(root: string): string[] {
  try {
    return execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
      .split("\0").filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 8 || out.length > 20_000) return;
      for (const child of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (child.isSymbolicLink() || [".git", "node_modules", "__pycache__", ".venv"].includes(child.name)) continue;
        const path = dir ? `${dir}/${child.name}` : child.name;
        if (child.isDirectory()) walk(path, depth + 1); else if (child.isFile()) out.push(path);
      }
    };
    walk("", 0);
    return out;
  }
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  if (!match) return { data: {}, body: text };
  try {
    const data = parseYaml(match[1], { maxAliasCount: 0 }) as unknown;
    return { data: data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {}, body: text.slice(match[0].length) };
  } catch { return { data: {}, body: text.slice(match[0].length) }; }
}

function globs(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return raw.filter((v): v is string => typeof v === "string").map(v => v.trim().replace(/^\.\//u, "")).filter(Boolean);
}

/** The area a file applies to: its folder for nested files, its own globs for scoped formats. */
function scopeOf(path: string, format: RuleFile["format"], data: Record<string, unknown>): string[] {
  const folder = posix.dirname(path);
  switch (format) {
    case "claude": case "agents": case "gemini":
      return folder === "." ? ["**"] : [`${folder}/**`];
    case "claude-rules": return globs(data.paths).length ? globs(data.paths) : ["**"];
    case "cursor-rules": return data.alwaysApply === true || !globs(data.globs).length ? ["**"] : globs(data.globs);
    case "copilot-instructions": return globs(data.applyTo).length && !globs(data.applyTo).includes("**") ? globs(data.applyTo) : ["**"];
    default: return ["**"];
  }
}

/** Who loads a file. Claude reads AGENTS.md only where its folder has no CLAUDE.md. OpenCode reads only the root AGENTS.md. */
function agentsFor(path: string, format: RuleFile["format"], present: Set<string>): Agent[] {
  const folder = posix.dirname(path);
  const sibling = (name: string) => present.has(folder === "." ? name : `${folder}/${name}`);
  switch (format) {
    case "claude": case "claude-rules": return ["claude-code"];
    case "agents": {
      const agents: Agent[] = ["codex", "cursor", "copilot"];
      if (folder === ".") agents.push("opencode");
      if (!sibling("CLAUDE.md") && !sibling("CLAUDE.local.md")) agents.unshift("claude-code");
      return agents;
    }
    case "cursor-rules": case "cursorrules": return ["cursor"];
    case "copilot": case "copilot-instructions": return ["copilot"];
    case "gemini": return ["gemini"];
  }
}

export function discoverRuleFiles(root: string): Array<RuleFile & { text: string; data: Record<string, unknown> }> {
  const all = listFiles(root);
  const present = new Set(all);
  const out: Array<RuleFile & { text: string; data: Record<string, unknown> }> = [];
  for (const path of all.sort()) {
    const format = ruleFormat(path);
    if (!format) continue;
    if (out.length >= MAX_RULE_FILES) break;
    const full = join(root, path);
    let bytes: Buffer;
    try {
      const stat = statSync(full);
      if (!stat.isFile() || stat.size > MAX_RULE_FILE_BYTES) continue;
      bytes = readFileSync(full);
    } catch { continue; }
    const text = bytes.toString("utf8");
    if (text.includes(GENERATED_MARK)) continue; // MEX wrote it; the entries are the source.
    const { data } = frontmatter(text);
    out.push({ path, format, agents: agentsFor(path, format, present), scope: scopeOf(path, format, data), hash: fileHash(bytes), text, data });
  }
  return out;
}

const COMMANDISH = /^\s*(?:\$\s+)?(?:npm|pnpm|yarn|npx|bun|node|python3?|pip3?|go|cargo|make|uv|poetry|gradle|mvn|dotnet)\s/u;

function kindOf(body: string): "recipe" | "rule" {
  const fenced = /```/u.test(body);
  const lines = body.split("\n").filter(l => l.trim());
  const commands = lines.filter(l => COMMANDISH.test(l.replace(/^[-*]\s+`?/u, ""))).length;
  return fenced || (lines.length > 0 && commands * 2 >= lines.length) ? "recipe" : "rule";
}

function plain(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, "").replace(/[*_`]/gu, "").trim();
}

/** The claim in one line: the first sentence of the body when it is short, else the heading. */
function oneLine(heading: string, body: string, path: string): string {
  const first = body.split("\n").map(plain).find(l => l && !l.startsWith("```") && !l.startsWith("<!--")) ?? "";
  const sentence = /^(.{8,280}?[.!?])(?:\s|$)/u.exec(first)?.[1] ?? (first.length <= 280 ? first : "");
  const title = heading ? `${heading}: ` : "";
  const line = sentence ? `${title}${sentence}` : heading || basename(path);
  return line.length <= KNOWLEDGE_LIMITS.oneLineCharacters ? line : heading || basename(path);
}

function stableId(path: string, heading: string, occurrence: number): string {
  return `mx_r${createHash("sha256").update(`${path}\n${heading}\n${occurrence}`).digest("hex").slice(0, 20)}`;
}

/** One entry per section with its own text. Managed MEX blocks are left out. */
export function fileEntries(file: RuleFile & { text: string }, created: string): { entries: RuleEntry[]; review: ReviewItem[] } {
  const entries: RuleEntry[] = [], review: ReviewItem[] = [];
  const { body } = frontmatter(file.text);
  const seen = new Map<string, number>();
  for (const s of sections(body.replace(MANAGED_BLOCK, ""))) {
    const text = s.body.trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
    const occurrence = seen.get(s.heading) ?? 0;
    seen.set(s.heading, occurrence + 1);
    if (text.length > KNOWLEDGE_LIMITS.textCharacters) {
      review.push({ kind: "stale", paths: [file.path], heading: s.heading, message: "This section is too long to keep as one entry; split it." });
      continue;
    }
    // A heading names the section check; the preamble and repeated headings use the file.
    const check = s.heading && occurrence === 0
      ? { kind: "section" as const, role: "complete" as const, target: { file: file.path, heading: s.heading }, saw: { hash: textHash(sectionFull(file.text, s.heading)) }, files: { [file.path]: file.hash } }
      : { kind: "source" as const, role: "supporting" as const, target: { file: file.path }, saw: { hash: textHash(file.text) }, files: { [file.path]: file.hash } };
    try {
      const entry = validateEntry({
        mex: {
          id: stableId(file.path, s.heading, occurrence), kind: kindOf(text), scope: file.scope,
          source: { type: "rule-file", ref: file.path }, evidence: "docs",
          one_line: oneLine(s.heading, text, file.path), checks: [check], status: "active", created,
        },
        text,
      });
      entries.push({ path: file.path, agents: file.agents, entry });
    } catch {
      review.push({ kind: "stale", paths: [file.path], heading: s.heading, message: "This section can't be read as an entry." });
    }
  }
  return { entries, review };
}

/** The section text the Go evaluator hashes, read from the whole file (frontmatter included, as it reads it). */
function sectionFull(text: string, heading: string): string {
  return sections(text).find(s => s.level > 0 && s.heading === heading)?.full ?? "";
}

const normalize = (text: string) => text.toLowerCase().replace(/[`*_>#-]/gu, " ").replace(/\s+/gu, " ").trim();

/** Same topic, different words in two files: a person decides. Commands or paths that don't exist: stale. */
export function reviewItems(entries: RuleEntry[], root: string): ReviewItem[] {
  const review: ReviewItem[] = [];
  const scripts = definedScripts(root);
  const byTopic = new Map<string, RuleEntry[]>();
  for (const e of entries) {
    const heading = /^([^:]+):/u.exec(e.entry.mex.one_line)?.[1];
    if (!heading) continue;
    const key = normalize(heading);
    byTopic.set(key, [...byTopic.get(key) ?? [], e]);
  }
  for (const group of byTopic.values()) {
    const files = new Set(group.map(e => e.path));
    if (files.size < 2) continue;
    const bodies = new Set(group.map(e => normalize(e.entry.text)));
    if (bodies.size > 1) {
      const heading = /^([^:]+):/u.exec(group[0].entry.mex.one_line)![1];
      review.push({ kind: "conflict", paths: [...files].sort(), heading, message: `${[...files].sort().join(" and ")} say different things under "${heading}".` });
    }
  }
  for (const e of entries) {
    const heading = /^([^:]+):/u.exec(e.entry.mex.one_line)?.[1] ?? "";
    for (const command of missingScripts(e.entry.text, scripts)) {
      review.push({ kind: "stale", paths: [e.path], heading, message: `Names the command "${command}", which the repo doesn't define.` });
    }
    for (const match of e.entry.text.matchAll(/`([\w.-]+(?:\/[\w.-]+)+\.[a-z0-9]{1,5})`/giu)) {
      const ref = match[1].replace(/^\.\//u, "");
      try { statSync(join(root, ref)); } catch {
        try { statSync(join(root, dirname(e.path), ref)); } catch {
          review.push({ kind: "stale", paths: [e.path], heading, message: `Mentions ${ref}, which doesn't exist.` });
        }
      }
    }
  }
  return review;
}

interface Scripts { npm: Set<string> | undefined; make: Set<string> | undefined; }

/** Package scripts and Makefile targets. Rule files can't vouch for their own commands. */
function definedScripts(root: string): Scripts {
  const out: Scripts = { npm: undefined, make: undefined };
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    out.npm = new Set(Object.keys(pkg.scripts ?? {}));
  } catch { /* no package.json: npm commands aren't judged */ }
  try {
    const make = readFileSync(join(root, "Makefile"), "utf8");
    out.make = new Set([...make.matchAll(/^([A-Za-z0-9_.-]+)\s*::?(?!=)/gmu)].map(m => m[1]));
  } catch { /* no Makefile */ }
  return out;
}

const NPM_RUN = /^(?:npm run|npm run-script|pnpm run|pnpm|yarn run|yarn|bun run)\s+([\w:.-]+)/u;
const NPM_BUILTIN = new Set(["install", "i", "ci", "add", "remove", "exec", "dlx", "init", "publish", "link", "update", "outdated", "audit", "why", "list", "ls", "version", "create", "x", "test", "start"]);

/** Commands in code spans that name a package script or make target the repo doesn't define. */
function missingScripts(text: string, scripts: Scripts): string[] {
  const missing: string[] = [];
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) {
    const command = match[1].trim().replace(/^\$\s+/u, "");
    const npm = NPM_RUN.exec(command);
    if (npm && scripts.npm && !(NPM_BUILTIN.has(npm[1]) && !/ run /u.test(` ${command} `)) && !scripts.npm.has(npm[1])) missing.push(command);
    const npmTest = /^npm (test|start)\b/u.exec(command);
    if (npmTest && scripts.npm && !scripts.npm.has(npmTest[1])) missing.push(command);
    const make = /^make\s+([\w.-]+)/u.exec(command);
    if (make && scripts.make && !scripts.make.has(make[1])) missing.push(command);
  }
  return [...new Set(missing)];
}

/** Read every rule file in a checkout. Pure: writes nothing. */
export function scanRuleFiles(root: string, created = new Date().toISOString().slice(0, 10)): RuleScan {
  const found = discoverRuleFiles(root);
  const entries: RuleEntry[] = [], review: ReviewItem[] = [];
  for (const file of found) {
    const result = fileEntries(file, created);
    entries.push(...result.entries);
    review.push(...result.review);
  }
  review.push(...reviewItems(entries, root));
  return { files: found.map(({ text: _text, data: _data, ...file }) => file), entries, review };
}

/** Entries an agent doesn't already load from its own files. */
export function entriesFor(scan: RuleScan, agent: Agent): RuleEntry[] {
  return scan.entries.filter(e => !e.agents.includes(agent));
}
