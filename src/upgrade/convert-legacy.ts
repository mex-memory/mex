/** Pure conversion candidates. Publication owns evidence gates and exact diffs. */
import { createHash } from "node:crypto";
import { canonicalFingerprint } from "../graph/fingerprint.js";
import { KNOWLEDGE_LIMITS, serializeEntry, validateEntry, type KnowledgeEntry, type EntryKind } from "../knowledge/entry.js";
import { fileEntries, stableId } from "../knowledge/rule-files.js";
import { headings, lines, sections, textHash } from "../knowledge/sections.js";
import type { LegacyDocument, LegacySnapshot } from "./legacy-reader.js";
type LegacyGrounding = LegacyDocument["parsed"]["legacy"]["groundsTo"][number];

export interface UpgradeCandidate {
  entry: KnowledgeEntry;
  source: { path: string; entityId?: string; line?: number };
}
export interface ConversionIssue {
  code: "INCOMPLETE_LEGACY_INPUT" | "ENTRY_NEEDS_REVIEW" | "CONVERSION_LIMIT";
  path: string;
  entityId?: string;
  line?: number;
}
export interface LegacyConversion {
  candidates: UpgradeCandidate[];
  issues: ConversionIssue[];
  /** Navigation and obsolete instructions stay out of delivered knowledge. */
  preserved: string[];
}

const KINDS: Record<string, EntryKind> = {
  architecture: "fact", component: "fact", decision: "decision", convention: "rule",
  pattern: "procedure", guide: "procedure", risk: "pitfall", fact: "fact", task: "procedure",
  spec: "fact", requirement: "rule", constraint: "rule", acceptance_criterion: "rule",
};

const HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t].*)?$/u;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/u;
const flat = (text: string) => text.replace(/\s+/gu, " ").trim();

/**
 * Whole authored text, never a character-limited fragment of a claim: the
 * first paragraph under any leading headings, the first item of a list, or the
 * labelled decision of a 0.8 decision record. Falls back to its first sentence
 * only when the paragraph is over the one-line limit.
 */
export function oneLine(text: string, summary?: string): string {
  if (summary?.trim()) return flat(summary);
  const body = text.split(/\r?\n/u).filter(line => !HEADING_LINE.test(line)).join("\n").trim();
  const decision = /\*\*Decision:\*\*[ \t]*([\s\S]*?)(?=[ \t]*\*\*[^*\n]{1,40}:\*\*|\r?\n[ \t]*\r?\n|$)/u.exec(body)?.[1];
  let first = flat(decision ?? "") ? decision! : body.split(/\r?\n[ \t]*\r?\n/u)[0];
  if (LIST_ITEM.test(first)) first = first.split(/\r?\n(?=[ \t]*(?:[-*+]|\d+[.)])[ \t]+)/u)[0].replace(LIST_ITEM, "");
  const line = flat(first) || flat(text);
  if (line.length <= KNOWLEDGE_LIMITS.oneLineCharacters) return line;
  return /^(.{8,}?[.!?])(?:\s|$)/u.exec(line)?.[1] ?? line;
}

/**
 * 0.8 shipped these as setup templates and navigation, not project knowledge:
 * the agent tool-config templates, the patterns folder's how-to-write-patterns
 * README and its lookup table. They stay in place for people.
 */
export function legacyTemplate(path: string): boolean {
  return /^\.mex\/(?:\.tool-configs\/|patterns\/(?:README|INDEX)\.md$)/u.test(path);
}
/** Sections of 0.8's instruction template that describe the retired workflow (ROUTER, GROW, Graph/Wiki commands, logging). */
const WORKFLOW_SECTIONS = new Set(["project knowledge", "code graph", "scaffold growth", "agent logging", "navigation", "mex context policy", "mex agent skills", "after every task"]);
/** Pattern subsections that only told the agent to update the 0.8 scaffold. */
const WORKFLOW_STEPS = /^(?:update (?:the )?scaffold|scaffold growth|grow)$/iu;
export const workflowSection = (heading: string) => WORKFLOW_SECTIONS.has(heading.trim().toLowerCase());

/**
 * One procedure per 0.8 pattern: the whole file, or each `## Task:` section of
 * a multi-task file. Splitting a pattern by its Steps/Verify/Debug headings
 * produced fragments no agent could follow. Scaffold-upkeep steps are left out.
 */
function patternUnits(document: LegacyDocument): Array<{ heading: string; line: number; text: string }> {
  const all = lines(document.text);
  let start = 0;
  if (all[0] === "---") { const close = all.indexOf("---", 1); if (close > 0) start = close + 1; }
  const hs = headings(all).filter(h => h.line >= start);
  const tasks = hs.filter(h => h.level === 2 && /^task\b/iu.test(h.text));
  const title = hs.find(h => h.level === 1);
  const units = tasks.length ? tasks : [title ?? { line: start - 1, level: 0, text: "" }];
  return units.map(unit => {
    const nextUnit = tasks.length ? hs.find(h => h.line > unit.line && h.level <= unit.level) : undefined;
    const end = nextUnit ? nextUnit.line : all.length;
    const kept: string[] = [];
    let skipLevel = 0;
    for (let i = unit.line + 1; i < end; i++) {
      const h = hs.find(item => item.line === i);
      if (h && skipLevel && h.level <= skipLevel) skipLevel = 0;
      if (h && WORKFLOW_STEPS.test(h.text.replace(/[:*]/gu, "").trim())) { skipLevel = h.level; continue; }
      if (!skipLevel) kept.push(all[i]);
    }
    return { heading: unit.text, line: Math.max(unit.line, 0), text: kept.join("\n").trim() };
  });
}

/** An entry field holds one line of at most this many characters. */
const MAX_LINE = 2048;
function legacyChecks(groundings: LegacyGrounding[]): KnowledgeEntry["mex"]["checks"] {
  return groundings.flatMap((g): KnowledgeEntry["mex"]["checks"] => {
    // 0.8 scaffolds from before #233 hold `mh:` hex, which can pass the line
    // limit. `mh2:` is the same fingerprint, losslessly, in less space.
    const fingerprint = g.fingerprint.length > MAX_LINE ? canonicalFingerprint(g.fingerprint) : g.fingerprint;
    // The baseline is kept as evidence and never re-evaluated, so one that is
    // still too long is left out rather than losing the whole entry.
    if (fingerprint.length > MAX_LINE) return [];
    return [{ kind: "legacy-grounding", role: "supporting",
      target: { node: g.node, ...(g.file === undefined ? {} : { file: g.file }) },
      saw: { fingerprint, ...(g.bodyHash === undefined ? {} : { bodyHash: g.bodyHash }), ...(g.codeHash === undefined ? {} : { codeHash: g.codeHash }) }, files: {},
    }];
  });
}

/** The source text is evidence about the documented claim, not its live code. */
function documentChecks(document: LegacyDocument) {
  const hs = headings(lines(document.text));
  const bodies = sections(document.text);
  return (offset: number): KnowledgeEntry["mex"]["checks"] => {
    const line = document.text.slice(0, offset).split("\n").length - 1;
    const heading = hs.find(item => item.line === line)?.text;
    if (heading && hs.filter(item => item.text === heading).length === 1) {
      const body = bodies.find(item => item.heading === heading)?.full;
      if (body !== undefined) return [{ kind: "section", role: "complete", target: { file: document.path, heading }, saw: { hash: textHash(body) }, files: { [document.path]: document.hash } }];
    }
    return [{ kind: "source", role: "supporting", target: { file: document.path }, saw: { hash: textHash(document.text) }, files: { [document.path]: document.hash } }];
  };
}

/**
 * Existing source stays authoritative. No model, graph refresh, identity
 * registration or file write happens here. Unsupported material is reported.
 */
export function convertLegacy(snapshot: LegacySnapshot, created: string): LegacyConversion {
  const result: LegacyConversion = { candidates: [], issues: [], preserved: [] };
  if (!snapshot.complete) {
    result.issues.push({ code: "INCOMPLETE_LEGACY_INPUT", path: ".mex" });
    return result;
  }
  const seen = new Set<string>();
  let bytes = 0, limited = false;
  const issue = (value: ConversionIssue): void => {
    if (result.issues.length < 100) result.issues.push(value);
    else result.issues[99] = { code: "CONVERSION_LIMIT", path: ".mex" };
  };
  const add = (entry: KnowledgeEntry, source: UpgradeCandidate["source"]): boolean => {
    // A Windows checkout (core.autocrlf) reads CRLF; an entry file is always
    // LF, or reading it back would not reproduce the reviewed bytes.
    const valid = validateEntry({ ...entry, text: entry.text.replace(/\r\n?/gu, "\n") });
    if (seen.has(valid.mex.id)) throw new Error("Duplicate imported entry identity");
    const size = Buffer.byteLength(serializeEntry(valid));
    if (result.candidates.length >= KNOWLEDGE_LIMITS.entries || bytes + size > KNOWLEDGE_LIMITS.scanBytes) {
      limited = true;
      issue({ code: "CONVERSION_LIMIT", ...source });
      return false;
    }
    bytes += size;
    seen.add(valid.mex.id);
    result.candidates.push({ entry: valid, source });
    return true;
  };
  for (const document of snapshot.documents) {
    if (limited) break;
    if (["router", "obsolete"].includes(document.kind) || (legacyTemplate(document.path) && !document.parsed.entities.length)) { result.preserved.push(document.path); continue; }
    if (!document.parsed.entities.length && document.kind === "pattern") {
      const checksFor = documentChecks(document);
      for (const unit of patternUnits(document)) {
        if (!unit.text || !/[\p{L}\p{N}]/u.test(unit.text)) continue;
        try {
          const offset = unit.line ? document.text.split("\n").slice(0, unit.line).join("\n").length + 1 : 0;
          const title = unit.heading.replace(/^task:?\s*/iu, "").trim();
          const summary = oneLine(unit.text);
          const one = title && !summary.toLowerCase().startsWith(title.toLowerCase()) && title.length + summary.length + 2 <= KNOWLEDGE_LIMITS.oneLineCharacters ? `${title}: ${summary}` : summary;
          if (!add({ mex: { id: stableId(document.path, unit.heading, 0), kind: "procedure", scope: ["**"], source: { type: "docs", ref: document.path }, evidence: "docs",
            one_line: one, checks: [...checksFor(offset), ...legacyChecks(document.parsed.legacy.groundsTo)], status: "active", created }, text: unit.text }, { path: document.path })) break;
        } catch { issue({ code: "ENTRY_NEEDS_REVIEW", path: document.path }); }
      }
      continue;
    }
    if (!document.parsed.entities.length) {
      const converted = fileEntries({ path: document.path, format: "agents", agents: [], scope: ["**"], hash: document.hash, text: document.text }, created);
      const heading = (item: (typeof converted.entries)[number]) => {
        const check = item.entry.mex.checks.find(c => c.kind === "section");
        return check && "heading" in check.target ? String(check.target.heading) : /^([^:]+):/u.exec(item.entry.mex.one_line)?.[1] ?? "";
      };
      for (const item of converted.entries) {
        // The retired 0.8 workflow stays in the document for people, but it is
        // not project knowledge and must never be delivered as a rule.
        if (document.kind === "instructions" && workflowSection(heading(item))) continue;
        // Context/pattern Markdown stays for people; agents no longer load it
        // through ROUTER. Only actual root instructions are already delivered.
        if (document.path !== "AGENTS.md" && document.path !== "CLAUDE.md") item.entry.mex.source.type = "docs";
        if (/pitfalls?|gotchas?/iu.test(item.entry.mex.one_line)) item.entry.mex.kind = "pitfall";
        try {
          item.entry.mex.checks.push(...legacyChecks(document.parsed.legacy.groundsTo));
          if (!add(item.entry, { path: document.path })) break;
        } catch { issue({ code: "ENTRY_NEEDS_REVIEW", path: document.path }); }
      }
      for (const item of converted.review) if (!(document.kind === "instructions" && workflowSection(item.heading))) issue({ code: "ENTRY_NEEDS_REVIEW", path: document.path });
      continue;
    }
    const unassigned = document.parsed.legacy.groundsTo.length > 0
      && !document.parsed.entities.some(item => item.metadataKind === "frontmatter");
    const checksFor = documentChecks(document);
    for (const { entity } of document.parsed.entities) {
      if (limited) break;
      const source = { path: document.path, entityId: entity.id };
      if (!entity.body.trim() || entity.type === "topic") { result.preserved.push(document.path); continue; }
      try {
        const status = entity.status === "archived" || entity.status === "deprecated" ? "retired" : "active";
        const originalDate = entity.provenance?.createdAt?.slice(0, 10);
        add({ mex: {
          id: entity.id.toLowerCase(), kind: KINDS[entity.type] ?? "fact", scope: ["**"],
          source: { type: "docs", ref: document.path }, evidence: "docs",
          one_line: oneLine(entity.body, entity.summary), checks: [...checksFor(entity.location.headingStart), ...legacyChecks([...entity.groundsTo, ...(unassigned ? document.parsed.legacy.groundsTo : [])])],
          status, created: originalDate ?? created,
          ...(status === "retired" ? { retired: { reason: `Imported legacy status: ${entity.status}`, by: "mex upgrade", at: created } } : {}),
        }, text: entity.body.trim() }, source);
      } catch { issue({ code: "ENTRY_NEEDS_REVIEW", ...source }); }
    }
  }
  for (const row of snapshot.logRows) {
    if (limited) break;
    if (row.value.kind !== "decision") continue;
    const path = snapshot.log!.path;
    try {
      const text = String(row.value.message).trim();
      const id = `mx_l${createHash("sha256").update(`${path}\0${row.line}\0${JSON.stringify(row.value)}`).digest("hex").slice(0, 24)}`;
      add({ mex: { id, kind: "decision", scope: ["**"], source: { type: "docs", ref: path }, evidence: "docs",
        one_line: oneLine(text), checks: [], status: "active", created: String(row.value.timestamp).slice(0, 10) }, text }, { path, line: row.line });
    } catch { issue({ code: "ENTRY_NEEDS_REVIEW", path, line: row.line }); }
  }
  result.preserved = [...new Set(result.preserved)].sort();
  return result;
}
