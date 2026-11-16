/** Reading the corpus the alias filter ranks against, recording its verdicts, and `mex alias` / `mex ask`. */
import { createHash } from "node:crypto";
import { existsSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { openRecord, openRecordReadOnly } from "../record/index.js";
import { EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, parseEntry, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, readEntryFile } from "./files.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { teamEntries, prepareTeamWrite, applyTeamWrite, type TeamPreview } from "./team.js";
import { replacePersonalFields } from "./mutations.js";
import { corpusDigest, filterAids, normalizeAid, refilterCorpus, withAids, nativeAidRanker, type AidKind, type AidRanker, type AidSource, type AidVerdict } from "./aids.js";

export interface CorpusItem { level: "personal" | "team"; entry: KnowledgeEntry; }

/** Every current entry of the project, personal (active or proposed) and team, without hints. */
export function aidCorpus(options: KnowledgeOptions): { projectId: string; items: CorpusItem[] } {
  const project = knowledgeProject(options);
  const items: CorpusItem[] = [];
  const directory = existsSync(project.location.home) ? containedDirectory(project.location.home, ["projects", project.projectId, "notes"]) : undefined;
  if (directory) {
    const handle = opendirSync(directory);
    const names: string[] = [];
    try {
      let child, seen = 0;
      while ((child = handle.readSync())) {
        if (++seen > KNOWLEDGE_LIMITS.entries) throw new KnowledgeError("STORE_LIMIT", "Personal note directory exceeds the scan limit.");
        if (/^mx_[a-z0-9]{6,64}\.md$/u.test(child.name)) names.push(child.name.slice(0, -3));
      }
    } finally { handle.closeSync(); }
    let bytes = 0;
    for (const id of names.sort()) {
      if (project.retired.has(id)) continue;
      const content = readEntryFile(join(directory, `${id}.md`));
      if (content === undefined) continue;
      if ((bytes += Buffer.byteLength(content)) > KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("STORE_LIMIT", "Personal notes exceed the byte scan limit.");
      const entry = parseEntry(content);
      if (entry.mex.id === id && entry.mex.status !== "retired") items.push({ level: "personal", entry });
    }
  }
  const seen = new Set(items.map(i => i.entry.mex.id));
  for (const t of teamEntries(options).entries) if (!seen.has(t.entry.mex.id) && !project.retired.has(t.entry.mex.id)) items.push({ level: "team", entry: t.entry });
  return { projectId: project.projectId, items };
}

/** Kept and dropped candidates are recorded with the reason; conflicts also go to Review. */
export function recordAidVerdicts(options: KnowledgeOptions, verdicts: readonly AidVerdict[], source: AidSource, corpus: string, now = new Date()): void {
  if (!verdicts.length) return;
  const writer = openRecord({ ...options, create: true });
  try {
    const projectId = writer.checkout(options.projectPath)?.project_id ?? knowledgeProject(options).projectId;
    if (!writer.project(projectId)) return; // Nothing is registered, so there is nothing to attach verdicts to.
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      const at = now.toISOString();
      const upsert = writer.db.prepare(`INSERT INTO aid_verdicts(project_id,entry_id,kind,text,kept,reason,score,margin,top_entry,review,source,corpus,decided_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,entry_id,kind,text) DO UPDATE SET kept=excluded.kept,reason=excluded.reason,score=excluded.score,
        margin=excluded.margin,top_entry=excluded.top_entry,review=excluded.review,source=excluded.source,corpus=excluded.corpus,decided_at=excluded.decided_at`);
      const review = writer.db.prepare("INSERT OR IGNORE INTO review(id,project_id,entry_id,reason,state,created_at) VALUES(?,?,?,?,'pending',?)");
      for (const v of verdicts) {
        upsert.run(projectId, v.entry, v.kind, v.text.slice(0, 120), v.kept ? 1 : 0, v.reason.slice(0, 256), v.score ?? null, v.margin ?? null, v.top ?? null, v.review ? 1 : 0, source, corpus, at);
        if (v.review) {
          const id = `aid-${createHash("sha256").update(`${projectId}\n${v.entry}\n${v.kind}\n${v.text.toLowerCase()}`).digest("hex").slice(0, 24)}`;
          const why = v.reason.startsWith("no longer passes")
            ? `The ${v.kind} "${v.text}" ${v.reason}; remove it from the team entry or reword it.`
            : `The ${v.kind} "${v.text}" is also kept by ${v.top}; keep it on one of them.`;
          review.run(id, projectId, v.entry, why.slice(0, 512), at);
        }
      }
      writer.db.exec("COMMIT");
    } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
  } finally { writer.close(); }
}

export interface AidChange { id: string; kind: AidKind; op: "add" | "remove"; text: string; }
export type AidChangeResult =
  | { level: "personal"; entry: KnowledgeEntry; verdict?: AidVerdict; changed: boolean }
  | { level: "team"; preview?: TeamPreview; entry: KnowledgeEntry; verdict?: AidVerdict; changed: boolean };

/** `mex alias` and `mex ask`: a hand-written aid passes the same filter as a written one. */
export function changeAid(change: AidChange, options: KnowledgeOptions, apply?: { expect: string }, rank: AidRanker = nativeAidRanker): AidChangeResult {
  if (!EntryIdSchema.safeParse(change.id).success) throw new KnowledgeError("INVALID_ID", "Expected a stable entry id such as mx_7f3k2a.");
  const { items } = aidCorpus(options);
  const item = items.find(i => i.entry.mex.id === change.id);
  if (!item) throw new KnowledgeError("NOT_FOUND", "No current entry has that id in this project.");
  const current = item.entry;
  const field = change.kind === "alias" ? "aliases" : "asks";
  const list = [...(current.mex[field] ?? [])];
  const text = normalizeAid(change.text);
  let verdict: AidVerdict | undefined;
  let next = list;
  if (change.op === "remove") {
    next = list.filter(a => a.toLowerCase() !== text.toLowerCase());
    if (next.length === list.length) throw new KnowledgeError("NOT_FOUND", `The entry has no such ${change.kind}.`);
  } else {
    if (list.some(a => a.toLowerCase() === text.toLowerCase())) throw new KnowledgeError("DUPLICATE", `The entry already has that ${change.kind}.`);
    const corpus = items.map(i => i.entry);
    const others = { aliases: current.mex.aliases ?? [], asks: current.mex.asks ?? [] };
    const result = filterAids(withAids(current, others.aliases, others.asks), [{ kind: change.kind, text }], corpus, rank);
    verdict = result.verdicts[0];
    recordAidVerdicts(options, result.verdicts, "hand", corpusDigest(corpus));
    if (!verdict.kept) return { level: item.level, entry: current, verdict, changed: false } as AidChangeResult;
    next = [...list, text];
  }
  const changed = withAids(current, field === "aliases" ? next : current.mex.aliases ?? [], field === "asks" ? next : current.mex.asks ?? []);
  if (item.level === "personal") return { level: "personal", entry: replacePersonalFields(change.id, () => changed, options).entry, verdict, changed: true };
  const preview = prepareTeamWrite(changed, options);
  if (!apply) return { level: "team", preview, entry: changed, verdict, changed: false };
  return { level: "team", entry: applyTeamWrite(preview, apply.expect, options).entry, verdict, changed: true };
}

export interface AidRefresh { checked: number; changed: string[]; review: string[]; }
/**
 * Rerun the filter over every entry with aids when what it ranks against
 * changed since the last verdicts. A personal note whose aid no longer passes
 * loses it; a team entry is never edited in the background, so its failing aid
 * goes to Review instead.
 */
export function refreshAids(options: KnowledgeOptions, rank: AidRanker = nativeAidRanker): AidRefresh {
  const { projectId, items } = aidCorpus(options);
  const corpus = items.map(i => i.entry);
  const out: AidRefresh = { checked: 0, changed: [], review: [] };
  if (!corpus.some(e => e.mex.aliases?.length || e.mex.asks?.length)) return out;
  const digest = corpusDigest(corpus);
  const reader = openRecordReadOnly(options);
  let last: string | undefined;
  try { last = reader?.get<{ corpus: string }>("SELECT corpus FROM aid_verdicts WHERE project_id=? ORDER BY decided_at DESC LIMIT 1", projectId)?.corpus; }
  finally { reader?.close(); }
  if (last === digest) return out;
  const level = new Map(items.map(i => [i.entry.mex.id, i.level]));
  const verdicts: AidVerdict[] = [];
  for (const { entry, result, changed } of refilterCorpus(corpus, rank)) {
    out.checked++;
    const team = level.get(entry.mex.id) === "team";
    for (const v of result.verdicts) {
      if (team && !v.kept && !v.review) Object.assign(v, { review: true, top: v.top ?? entry.mex.id, reason: `no longer passes: ${v.reason}` });
      verdicts.push(v);
    }
    if (!changed) continue;
    if (team) { out.review.push(entry.mex.id); continue; }
    replacePersonalFields(entry.mex.id, current => withAids(current, result.aliases, result.asks), options);
    out.changed.push(entry.mex.id);
  }
  recordAidVerdicts(options, verdicts, "filter", digest);
  return out;
}
