import { z } from "zod";
import { join } from "node:path";
import { EntrySchema, EntryIdSchema, parseEntry, KnowledgeError, type KnowledgeEntry } from "../knowledge/entry.js";
import { containedDirectory, readEntryFile } from "../knowledge/files.js";
import { learningMetadata } from "../filter/metadata.js";
import { JudgementSchema } from "../judge/result.js";
import { shareProblems } from "../knowledge/share-checks.js";
import { claimHash, localSettings } from "../knowledge/state.js";
import { shortHash } from "../record/project.js";
import type { RecordReader, RecordWriter } from "../record/index.js";
import { hash } from "../judge/evidence.js";
import { privacyHolds, repoVocabulary, type RepoVocabulary } from "../filter/privacy.js";

export const REVIEW_DAYS = 30, REVIEW_VISIBLE = 5;
export const ReviewSource = z.object({ producer: z.enum(["learning", "judge"]), key: z.string().max(256),
  checkout: z.string().max(4096), level: z.enum(["personal", "team"]), path: z.string().max(4096), original_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict();
export const ReviewItem = z.object({ version: z.literal(1), entry: EntrySchema, source: ReviewSource, eligible: z.boolean() }).strict();
export const ReviewOffer = z.object({ id: EntryIdSchema, state: z.string().max(32), checkout: z.string().max(4096), personal_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  review_at: z.number().finite().min(0).max(8.64e15).optional(), reason: z.string().max(2048).optional() }).passthrough();
export type StoredReview = z.infer<typeof ReviewItem>;
export interface ReviewRow { id: string; project_id: string; entry_id: string; reason: string; state: string; created_at: string; }
export type ReviewReader = RecordReader | RecordWriter;
export const groupId = (project: string, entry: KnowledgeEntry) => `rv_${shortHash(JSON.stringify([project, claimHash(entry.text), entry.mex.kind, [...new Set(entry.mex.scope)].sort()]))}`;
export const itemKey = (id: string) => `review.item.${id}`;
export function put(writer: RecordWriter, project: string, key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > 256 << 10) throw new KnowledgeError("STORE_LIMIT", "Review data exceeds its size limit.");
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(project, key, raw);
}
export function rows(reader: ReviewReader, project: string): ReviewRow[] {
  const sql = "SELECT CASE WHEN length(id)<=256 THEN id END id,project_id,entry_id,CASE WHEN length(CAST(reason AS BLOB))<=2048 THEN reason END reason,state,created_at FROM review WHERE project_id=? AND state='pending' ORDER BY created_at,id LIMIT 10001";
  const result = "location" in reader ? reader.db.prepare(sql).all(project) as unknown as ReviewRow[] : reader.all<ReviewRow>(sql, project);
  if (result.length > 10000 || result.some(r => typeof r.id !== "string" || typeof r.reason !== "string")) throw new KnowledgeError("STORE_LIMIT", "Review history exceeds its scan limit.");
  return result;
}
export function storedItems(reader: ReviewReader, project: string): Map<string, StoredReview> {
  const result = new Map<string, StoredReview>();
  for (const row of localSettings(reader, project, "review.item.", 128 << 10)) {
    try { result.set(row.key.slice("review.item.".length), ReviewItem.parse(JSON.parse(row.value))); }
    catch { throw new KnowledgeError("INVALID_STATE", "Review data is invalid; nothing was changed."); }
  }
  return result;
}
export function legacyJudge(reader: ReviewReader, row: ReviewRow): StoredReview | undefined {
  const raw = reader.setting(row.project_id, row.id);
  if (!raw || Buffer.byteLength(raw) > 256 << 10 || !/^judge\.fix\.[a-f0-9]{24}$/u.test(row.id)) return undefined;
  try {
    const fix = z.object({ judgement: JudgementSchema, before: z.string(), state: z.literal("review"), item: z.object({ id: EntryIdSchema, path: z.string(), level: z.enum(["team", "personal"]) }) }).passthrough().parse(JSON.parse(raw));
    const entry = fix.judgement.rewrite ?? parseEntry(fix.before);
    if (entry.mex.id !== row.entry_id || fix.item.id !== row.entry_id || hash(fix.before) !== fix.judgement.entry_hash) return undefined;
    return { version: 1, entry, eligible: fix.item.level === "team" || !!learningMetadata(reader, row.project_id, entry.mex.id).sources?.length, source: { producer: "judge", key: row.id, checkout: fix.judgement.checkout, level: fix.item.level, path: fix.item.path, original_hash: fix.judgement.entry_hash } };
  } catch { return undefined; }
}
export function reviewQuiet(reader: RecordWriter, project: string, entry: KnowledgeEntry, now = Date.now()): "kept-for-me" | "review-expired" | undefined {
  if (reader.setting(project, `review.keep.${claimHash(entry.text).slice(7)}`)) return "kept-for-me";
  const id = groupId(project, entry), items = storedItems(reader, project);
  const dates = rows(reader, project).filter(row => { const item = items.get(row.id) ?? legacyJudge(reader, row); return item?.eligible && groupId(project, item.entry) === id; }).map(row => Date.parse(row.created_at));
  if (dates.some(date => Number.isFinite(date) && now - date >= REVIEW_DAYS * 86400000)) return "review-expired";
  // Offers written by the previous slice have no Review row. Their retained
  // first-seen timestamp still prevents promotion after the thirty-day limit.
  for (const row of localSettings(reader, project, "learning.offer.", 128 << 10)) {
    let offer; try { offer = ReviewOffer.parse(JSON.parse(row.value)); } catch { continue; }
    if (offer.state !== "review") continue;
    const meta = learningMetadata(reader, project, offer.id);
    const date = typeof offer.review_at === "number" ? offer.review_at : Date.parse(meta.at ?? "");
    if (meta.holds?.length || !Number.isFinite(date) || now - date < REVIEW_DAYS * 86400000) continue;
    const dir = containedDirectory(reader.location.home, ["projects", project, "notes"]), raw = dir && readEntryFile(join(dir, `${offer.id}.md`));
    if (raw && groupId(project, parseEntry(raw)) === id) return "review-expired";
  }
  return undefined;
}
export function reviewEligible(entry: KnowledgeEntry, checkout: string, vocabulary?: RepoVocabulary): boolean {
  if (entry.mex.status !== "active" || entry.mex.kind === "hint" || !["person", "docs", "ci", "review"].includes(entry.mex.evidence) || shareProblems(entry).length) return false;
  try { return !privacyHolds({ source_id: entry.mex.id, quote: entry.mex.source.quote ?? entry.text, text: entry.text, one_line: entry.mex.one_line,
    label: "lasting", kind: entry.mex.kind, scope: entry.mex.scope, checks: entry.mex.checks, private: false, needs_checks: false,
    source: { session: null, row: null, at: entry.mex.created, marks: "", delivered: [], private_tag: /<\s*\/?\s*private\b/iu.test(entry.mex.source.quote ?? entry.text) } }, vocabulary ?? repoVocabulary(checkout)).length; }
  catch { return false; }
}
/** Producer transaction owns this write; repeated offers never reset first-seen time. */
export function stageReview(writer: RecordWriter, project: string, id: string, entry: KnowledgeEntry,
  source: StoredReview["source"], reason: string, eligible = true, now = Date.now()): void {
  const item = ReviewItem.parse({ version: 1, entry, source, eligible: eligible && reviewEligible(entry, source.checkout) });
  writer.db.prepare("INSERT INTO review VALUES(?,?,?,?, 'pending',?) ON CONFLICT(id) DO UPDATE SET reason=excluded.reason WHERE review.state='pending'")
    .run(id, project, entry.mex.id, reason, new Date(now).toISOString());
  put(writer, project, itemKey(id), item);
}
export function learningReviewId(project: string, entry: KnowledgeEntry): string { return `learning.review.${shortHash(project + "\0" + entry.mex.id + "\0" + hash(JSON.stringify(entry)))}`; }
