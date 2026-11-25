/**
 * The rule-file scan, kept per project so hooks and delivery read it without
 * parsing Markdown. It is derived: rebuilt from the files on every scan, never
 * edited, never in git.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openRecord, type RecordWriter } from "../record/index.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KNOWLEDGE_LIMITS, KnowledgeError } from "./contract.js";
import { containedDirectory, readBoundedTextFile } from "./files.js";
import { scanRuleFiles, type RuleScan } from "./rule-files.js";

export const RULE_CACHE = "rule-files.json";
const VERSION = 1;

export interface RuleCache extends RuleScan { version: number; root: string; }

/** Scan the checkout's rule files and save the result for the project. */
export function refreshRuleFiles(
  options: KnowledgeOptions, now = new Date(), listed?: readonly string[],
  registered?: { writer: RecordWriter; projectId: string },
): RuleCache {
  const known = registered?.writer.checkout(options.projectPath);
  if (registered && (known?.path !== options.projectPath || known.project_id !== registered.projectId)) {
    throw new KnowledgeError("RECORD_UNAVAILABLE", "That checkout is no longer registered or its folder is missing.");
  }
  const root = registered ? options.projectPath : knowledgeProject(options).root;
  const scan = scanRuleFiles(root, now.toISOString().slice(0, 10), listed);
  const cache: RuleCache = { version: VERSION, root, ...scan };
  const writer = registered?.writer ?? openRecord({ ...options, create: true });
  try {
    const projectId = (known ?? writer.checkout(options.projectPath))?.project_id;
    if (!projectId || !/^[gf]-[a-f0-9]{24}$/u.test(projectId)) throw new KnowledgeError("RECORD_UNAVAILABLE", "The project could not be registered.");
    const directory = containedDirectory(writer.location.home, ["projects", projectId], true)!;
    const target = join(directory, RULE_CACHE);
    const temporary = join(directory, `.${RULE_CACHE}.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } finally { if (!registered) writer.close(); }
  return cache;
}

/** The last saved scan, if any. A registered reader needs no Git or identity fallback. */
export function readRuleFiles(options: KnowledgeOptions | { home: string; projectId: string }): RuleCache | undefined {
  if ("projectId" in options) {
    if (!/^[gf]-[a-f0-9]{24}$/u.test(options.projectId)) throw new KnowledgeError("UNSAFE_STORE", "Invalid registered project identity.");
    const directory = containedDirectory(options.home, ["projects", options.projectId]);
    const text = directory && readBoundedTextFile(join(directory, RULE_CACHE), KNOWLEDGE_LIMITS.scanBytes);
    if (text === undefined) return undefined;
    const cache = JSON.parse(text) as RuleCache;
    if (cache?.version !== VERSION || typeof cache.root !== "string"
      || !Array.isArray(cache.files) || !Array.isArray(cache.entries) || !Array.isArray(cache.review)) {
      throw new KnowledgeError("UNSAFE_STORE", "The saved rule file scan is invalid.");
    }
    return cache;
  }
  const project = knowledgeProject(options);
  const file = join(project.location.home, "projects", project.projectId, RULE_CACHE);
  if (!existsSync(file)) return undefined;
  try {
    const cache = JSON.parse(readFileSync(file, "utf8")) as RuleCache;
    return cache.version === VERSION ? cache : undefined;
  } catch { return undefined; }
}

export function formatRules(cache: RuleScan): string {
  const lines: string[] = [];
  if (!cache.files.length) return "No rule files found.";
  lines.push(`${cache.files.length} rule files, ${cache.entries.length} entries`);
  for (const file of cache.files) {
    const count = cache.entries.filter(e => e.path === file.path).length;
    lines.push(`  ${file.path}  ${count} entries · loaded by ${file.agents.join(", ")}${file.scope.join(",") === "**" ? "" : ` · for ${file.scope.join(", ")}`}`);
  }
  if (cache.review.length) {
    lines.push("", "Review");
    for (const item of cache.review) lines.push(`  ${item.kind === "conflict" ? "conflict" : "stale   "} ${item.paths.join(", ")}${item.heading ? ` (${item.heading})` : ""}: ${item.message}`);
  }
  return lines.join("\n");
}
