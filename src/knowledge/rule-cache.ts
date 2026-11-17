/**
 * The rule-file scan, kept per project so hooks and delivery read it without
 * parsing Markdown. It is derived: rebuilt from the files on every scan, never
 * edited, never in git.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openRecord } from "../record/index.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError } from "./contract.js";
import { containedDirectory } from "./files.js";
import { scanRuleFiles, type RuleScan } from "./rule-files.js";

export const RULE_CACHE = "rule-files.json";
const VERSION = 1;

export interface RuleCache extends RuleScan { version: number; root: string; }

/** Scan the checkout's rule files and save the result for the project. */
export function refreshRuleFiles(options: KnowledgeOptions, now = new Date(), listed?: readonly string[]): RuleCache {
  const project = knowledgeProject(options);
  const scan = scanRuleFiles(project.root, now.toISOString().slice(0, 10), listed);
  const cache: RuleCache = { version: VERSION, root: project.root, ...scan };
  const writer = openRecord({ ...options, create: true });
  try {
    const projectId = writer.checkout(options.projectPath)?.project_id;
    if (!projectId || !/^[gf]-[a-f0-9]{24}$/u.test(projectId)) throw new KnowledgeError("RECORD_UNAVAILABLE", "The project could not be registered.");
    const directory = containedDirectory(writer.location.home, ["projects", projectId], true)!;
    const target = join(directory, RULE_CACHE);
    const temporary = join(directory, `.${RULE_CACHE}.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } finally { writer.close(); }
  return cache;
}

/** The last saved scan, if any. Never scans. */
export function readRuleFiles(options: KnowledgeOptions): RuleCache | undefined {
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
