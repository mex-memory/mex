import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SourceRef, MANIFEST_PATH, MANIFEST_BYTES, noteKey, parseManifest } from "../learn-deeper/coverage.js";
import { sourceDigest } from "../learn-deeper/source.js";
import { openRecordReadOnly } from "../record/index.js";
import { cachedVerdicts, nativeBinary, runNative, type CheckResult, type Verdict } from "./check.js";
import { knowledgeProject, type KnowledgeOptions, type KnowledgeProject } from "./context.js";
import { KnowledgeError } from "./contract.js";
import type { KnowledgeEntry } from "./entry.js";
import { containedDirectory, readBoundedTextFile } from "./files.js";
import { hasSecret } from "./gates.js";
import { isLearned } from "./native-select.js";
import { claimHash } from "./state.js";
import { expand, personalSnapshot, type StoredEntry } from "./store.js";

interface Fix { snippet: string; path: string; commit: string; lines: string }
interface LearnedRecall {
  id: string;
  level: "personal" | "team";
  label: string;
  verdict: Verdict;
  action: "given" | "replaced" | "withheld";
  message: string;
  claim?: string;
  why?: string;
  fix?: Fix;
  quote?: string;
  sources?: string[];
}

function learnVerdict(item: StoredEntry, options: KnowledgeOptions, project: KnowledgeProject): { verdict: Verdict; checks: CheckResult[] } {
  const binary = nativeBinary(options.env);
  if (binary) {
    try {
      const report = runNative(binary, { action: "evaluate", checkout: project.root, project_id: project.projectId,
        mex_home: project.location.home, record_directory: project.location.directory, store: false });
      const items = (report.items ?? []).filter(row => row.id === item.entry.mex.id && row.level === item.level);
      if (items.length === 1) {
        const results = (report.results ?? []).filter(row => row.entry_id === item.entry.mex.id);
        return { verdict: items[0].verdict, checks: results.length === 1 ? results[0].checks : [] };
      }
    } catch { /* No current result: only a cached exclusion can be used. */ }
  }
  const fallback = cachedVerdicts(options, project.projectId, project.root)?.get(item.entry.mex.id);
  return { verdict: fallback === "broken" || fallback === "changed" ? fallback : "unknown", checks: [] };
}

function sourceLinks(entry: KnowledgeEntry, level: "personal" | "team", options: KnowledgeOptions, project: KnowledgeProject): string[] {
  const { id, source, checks } = entry.mex;
  const recorded: string[] = [];
  try {
    if (level === "team") {
      if (containedDirectory(project.root, [".mex"])) {
        const manifest = parseManifest(readBoundedTextFile(join(project.root, MANIFEST_PATH), MANIFEST_BYTES));
        const proof = manifest?.learn_deeper?.find(row => row.id === id && row.claim === claimHash(entry.text));
        recorded.push(...(proof?.sources.map(source => source.link) ?? []));
      }
    } else {
      const reader = openRecordReadOnly(options);
      try {
        const value = reader?.setting(project.projectId, noteKey(id));
        if (value && Buffer.byteLength(value) <= 20_000) {
          const proof = JSON.parse(value) as { hash?: unknown; sources?: unknown };
          const { content } = personalSnapshot(id, options, project, undefined, false);
          if (proof.hash === sourceDigest(content) && Array.isArray(proof.sources) && proof.sources.length <= 8) {
            for (const row of proof.sources) {
              const parsed = SourceRef.safeParse(row);
              if (parsed.success) recorded.push(parsed.data.link);
            }
          }
        }
      } finally { reader?.close(); }
    }
  } catch { /* Provenance may be unavailable on an older checkout. */ }
  const checkLinks = checks.flatMap(check => check.kind === "source" && "url" in check.target ? [check.target.url] : []);
  const direct = /^https:\/\/\S+$/u.test(source.ref) ? [source.ref] : [];
  const links = [...new Set([...direct, ...recorded, ...checkLinks])].filter(value => {
    if (value.length > 2048 || hasSecret(value) || /[\s\p{C}]/u.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch { return false; }
  });
  return links.length || !["docs", "review"].includes(source.type) || !source.ref || direct.length ? links : [source.ref];
}

export function recallLearned(id: string, options: KnowledgeOptions): LearnedRecall | undefined {
  let item;
  try { item = expand(id, options); }
  catch (error) { if (error instanceof KnowledgeError && error.code === "NOT_FOUND") return undefined; throw error; }
  return describeLearnedRecall(item, options);
}

export function describeLearnedRecall(item: StoredEntry, options: KnowledgeOptions): LearnedRecall | undefined {
  if (item.level === "hint" || !isLearned(item.entry)) return undefined;
  const id = item.entry.mex.id;
  const project = knowledgeProject(options);
  const { verdict, checks } = learnVerdict(item, options, project);
  const mex: KnowledgeEntry["mex"] & { fix?: Fix } = item.entry.mex;
  const label = mex.source.label ? `${item.label} ${mex.source.label}` : item.label;
  const result = { id, level: item.level, label, verdict };
  if (mex.status === "proposed") return { ...result, action: "withheld", message: "Withheld. This entry is awaiting acceptance." };
  const reason = checks.find(check => (check.status === "fail" || check.status === "gone") && check.reason)?.reason;
  const detail = reason && reason.length <= 240 && !hasSecret(reason) && !/[\p{C}]/u.test(reason)
    ? ` Check reported "${reason}".` : "";
  if (verdict === "broken") return { ...result, action: "withheld",
    message: `Withheld. The current checkout no longer supports this entry.${detail} Run mex check for details.` };
  if (verdict === "changed") return { ...result, action: "replaced",
    message: `Being checked. Its evidence changed.${detail} Read the current code or run mex check for details.` };
  if (verdict !== "held" && !checks.some(check => check.kind === "scope" && check.status === "pass")) {
    return { ...result, action: "withheld", message: "Withheld. MEX could not verify that the scope still applies." };
  }
  return { ...result, action: "given", message: verdict === "held" ? "Current checks hold." : "The scope still applies. Other checks could not confirm the entry.",
    claim: mex.one_line, why: item.entry.text, ...(mex.fix ? { fix: mex.fix } : {}),
    ...(item.level === "personal" && mex.source.quote ? { quote: mex.source.quote } : {}),
    sources: sourceLinks(item.entry, item.level, options, project) };
}

export function formatLearnedRecall(item: LearnedRecall): string {
  const lines = [`${item.id} ${item.label}`, item.message];
  if (item.claim) lines.push("", item.claim);
  if (item.why) lines.push("", item.why);
  if (item.fix) {
    const { path, commit, lines: range, snippet } = item.fix;
    const fence = "`".repeat(Math.max(3, ...(snippet.match(/`+/gu) ?? []).map(run => run.length + 1)));
    lines.push("", `Do this instead (from ${path}:${range} at ${commit}):`, fence, snippet.replace(/\n$/u, ""), fence);
  }
  if (item.quote) lines.push("", `Source quote: ${item.quote}`);
  for (const source of item.sources ?? []) lines.push(`Source: ${source}`);
  return lines.join("\n");
}

/** The Go writer owns the ledger. A receipt failure never blocks recall. */
export function noteLearnedRecall(item: LearnedRecall, options: KnowledgeOptions): void {
  try {
    const project = knowledgeProject(options);
    const env = options.env ?? process.env;
    const binary = nativeBinary(env);
    if (!binary || !existsSync(project.location.hooks)) return;
    spawnSync(binary, ["--probe"], {
      input: JSON.stringify({ entry: item.id, kind: "recall", level: item.level, action: item.action,
        session: env.MEX_SESSION_ID ?? "", invocation: randomUUID(), project: project.projectId, checkout: project.root }),
      encoding: "utf8", windowsHide: true, timeout: 2000, maxBuffer: 16384, env: { ...env, MEX_BACKGROUND: "1" },
    });
  } catch { /* The read succeeded. */ }
}
