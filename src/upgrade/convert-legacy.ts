/** Pure conversion candidates. Publication owns evidence gates and exact diffs. */
import { createHash } from "node:crypto";
import { KNOWLEDGE_LIMITS, serializeEntry, validateEntry, type KnowledgeEntry, type EntryKind } from "../knowledge/entry.js";
import { fileEntries } from "../knowledge/rule-files.js";
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

function oneLine(text: string, summary?: string): string {
  // Whole authored paragraph, never a character-limited fragment of a claim.
  return (summary?.trim() || text.trim().split(/\r?\n[ \t]*\r?\n/u)[0]).replace(/\s+/gu, " ").trim();
}

function legacyChecks(groundings: LegacyGrounding[]): KnowledgeEntry["mex"]["checks"] {
  return groundings.map(g => ({ kind: "legacy-grounding", role: "supporting",
    target: { node: g.node, ...(g.file === undefined ? {} : { file: g.file }) },
    saw: { fingerprint: g.fingerprint, ...(g.bodyHash === undefined ? {} : { bodyHash: g.bodyHash }), ...(g.codeHash === undefined ? {} : { codeHash: g.codeHash }) }, files: {},
  }));
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
    const valid = validateEntry(entry);
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
    if (["router", "obsolete"].includes(document.kind)) { result.preserved.push(document.path); continue; }
    if (!document.parsed.entities.length) {
      const converted = fileEntries({ path: document.path, format: "agents", agents: [], scope: ["**"], hash: document.hash, text: document.text }, created);
      for (const item of converted.entries) {
        // Context/pattern Markdown stays for people; agents no longer load it
        // through ROUTER. Only actual root instructions are already delivered.
        if (document.path !== "AGENTS.md" && document.path !== "CLAUDE.md") item.entry.mex.source.type = "docs";
        if (/pitfalls?|gotchas?/iu.test(item.entry.mex.one_line)) item.entry.mex.kind = "pitfall";
        try {
          item.entry.mex.checks.push(...legacyChecks(document.parsed.legacy.groundsTo));
          if (!add(item.entry, { path: document.path })) break;
        } catch { issue({ code: "ENTRY_NEEDS_REVIEW", path: document.path }); }
      }
      for (const _ of converted.review) issue({ code: "ENTRY_NEEDS_REVIEW", path: document.path });
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
