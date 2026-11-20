import { join, relative, sep } from "node:path";
import { reviewReason } from "./reasons.js";
import { readConflict, type StoredConflict } from "./conflicts.js";
import { openRecordReadOnly } from "../record/index.js";
import { knowledgeProject, type KnowledgeOptions } from "../knowledge/context.js";
import { containedDirectory, readEntryFile } from "../knowledge/files.js";
import { repoFile } from "../knowledge/references.js";
import { KnowledgeError, parseEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { shareProblems } from "../knowledge/share-checks.js";
import { claimHash, localSettings, retiredClaimHashes } from "../knowledge/state.js";
import { hash } from "../judge/evidence.js";
import { learningMetadata } from "../filter/metadata.js";
import { sharingEnabled } from "../filter/repository.js";
import { repoVocabulary, type RepoVocabulary } from "../filter/privacy.js";
import { rows, storedItems, groupId, reviewEligible, legacyJudge, ReviewOffer, REVIEW_DAYS, REVIEW_VISIBLE, type ReviewRow, type StoredReview, type ReviewReader } from "./state.js";

export interface ReviewMember { row: ReviewRow; item: StoredReview; revision: string; }
export interface ReviewCard { id: string; entry: KnowledgeEntry; reason: string; sources: number; createdAt: string; expiresAt: string; checkedByModel: boolean; conflictsWith?: string[]; }
export interface ReviewGroup extends ReviewCard { members: ReviewMember[]; conflict?: StoredConflict; }
export function memberRevision(row: ReviewRow, item: StoredReview): string { return hash(JSON.stringify([row, item])); }
export function canonicalBytes(home: string, project: string, item: StoredReview): string | undefined {
  const source = item.source;
  const base = source.level === "team" ? containedDirectory(source.checkout, [".mex", "learned"]) : containedDirectory(home, ["projects", project, "notes"]);
  if (!base) return undefined;
  const rel = relative(base, source.path).split(sep).join("/");
  if (rel.split("/").at(-1) !== `${item.entry.mex.id}.md`) return undefined;
  const safe = repoFile(base, rel), raw = safe && readEntryFile(safe);
  if (!raw || hash(raw) !== source.original_hash) return undefined;
  const entry = parseEntry(raw);
  if (entry.mex.status !== "active" || entry.mex.id !== item.entry.mex.id) return undefined;
  return raw;
}
export function snapshotReview(reader: ReviewReader, project: string, home: string, root: string, now = Date.now()): ReviewGroup[] {
  const pending = rows(reader, project);
  const conflicts = pending.flatMap((row): ReviewGroup[] => {
    const created = Date.parse(row.created_at), expires = created + REVIEW_DAYS * 86400000;
    if (row.reason !== "contradiction" || !Number.isFinite(created) || created > now || now >= expires) return [];
    const conflict = readConflict(reader, project, row.id);
    if (!conflict || conflict.checkout !== root || !conflict.entry.mex.source.producer || conflict.entry.mex.id !== row.entry_id) return [];
    return [{ id: row.id, entry: conflict.entry, reason: row.reason, sources: 1, createdAt: row.created_at,
      expiresAt: new Date(expires).toISOString(), checkedByModel: !!conflict.entry.mex.source.model,
      conflictsWith: [...new Set(conflict.conflicts.map(other => other.id))], conflict, members: [] }];
  });
  if (!sharingEnabled(reader, project, root)) return conflicts;
  const stored = storedItems(reader, project), all = new Map<string, ReviewMember>();
  for (const row of pending.filter(row => row.reason !== "contradiction")) { const item = stored.get(row.id) ?? legacyJudge(reader, row); if (item) all.set(row.id, { row, item, revision: memberRevision(row, item) }); }
  // Compatibility for offers created before the Review writer was installed.
  for (const value of localSettings(reader, project, "learning.offer.", 128 << 10)) {
    let offer; try { offer = ReviewOffer.parse(JSON.parse(value.value)); } catch { continue; }
    if (offer.state !== "review") continue;
    if ([...all.values()].some(m => m.item.source.key === value.key)) continue;
    const path = containedDirectory(home, ["projects", project, "notes"]), raw = path && readEntryFile(join(path, offer.id + ".md"));
    if (!raw || hash(raw) !== offer.personal_hash) continue;
    const entry = parseEntry(raw), meta = learningMetadata(reader, project, offer.id);
    const created = typeof offer.review_at === "number" ? new Date(offer.review_at).toISOString() : meta.at;
    if (!created || !Number.isFinite(Date.parse(created))) continue;
    const row: ReviewRow = { id: `legacy.${value.key}`, project_id: project, entry_id: offer.id, reason: reviewReason(offer.reason ?? "checks"), state: "pending", created_at: created };
    const item: StoredReview = { version: 1, entry, eligible: !meta.holds?.length, source: { producer: "learning", key: value.key, checkout: offer.checkout, level: "personal", path: join(path!, offer.id + ".md"), original_hash: offer.personal_hash } };
    all.set(row.id, { row, item, revision: memberRevision(row, item) });
  }
  const groups = new Map<string, ReviewGroup>(), firstSeen = new Map<string, number>(), retired = retiredClaimHashes(reader, project), vocabularies = new Map<string, RepoVocabulary>();
  let bytes = 0;
  for (const member of all.values()) {
    const { item, row } = member, entry = item.entry, claim = claimHash(entry.text), id = groupId(project, entry), created = Date.parse(row.created_at);
    if (!item.eligible || entry.mex.kind === "hint" || entry.mex.status !== "active" || !["person", "docs", "ci", "review"].includes(entry.mex.evidence)
      || shareProblems(entry).length || !Number.isFinite(created) || created > now || reader.setting(project, `review.keep.${claim.slice(7)}`) || retired.has(claim)) continue;
    const meta = learningMetadata(reader, project, entry.mex.id);
    if (meta.holds?.length) continue;
    if (!vocabularies.has(item.source.checkout)) {
      if (vocabularies.size >= 16) throw new KnowledgeError("STORE_LIMIT", "Review spans too many checkouts.");
      vocabularies.set(item.source.checkout, repoVocabulary(item.source.checkout));
    }
    if (!reviewEligible(entry, item.source.checkout, vocabularies.get(item.source.checkout))) continue;
    firstSeen.set(id, Math.min(firstSeen.get(id) ?? Infinity, created));
    const rawSource = canonicalBytes(home, project, item);
    if (!rawSource) continue;
    bytes += Buffer.byteLength(rawSource);
    if (bytes > 32 << 20) throw new KnowledgeError("STORE_LIMIT", "Review sources exceed their scan limit.");
    if (item.source.producer === "learning") {
      const raw = reader.setting(project, item.source.key); let offer; try { offer = JSON.parse(raw ?? "null"); } catch { continue; }
      if (offer?.state !== "review" || offer.personal_hash !== item.source.original_hash) continue;
    } else {
      const raw = reader.setting(project, item.source.key); let fix; try { fix = JSON.parse(raw ?? "null"); } catch { continue; }
      if (fix?.state !== "review" || fix.judgement?.entry_hash !== item.source.original_hash) continue;
    }
    let group = groups.get(id);
    if (!group) { group = { id, entry, reason: row.reason, sources: 0, createdAt: row.created_at, expiresAt: "", checkedByModel: item.source.producer === "judge", members: [] }; groups.set(id, group); }
    group.members.push(member); group.sources++; group.checkedByModel ||= item.source.producer === "judge";
  }
  const shareable = [...groups.values()].flatMap(group => {
    const created = firstSeen.get(group.id)!;
    if (now - created >= REVIEW_DAYS * 86400000) return [];
    group.createdAt = new Date(created).toISOString(); group.expiresAt = new Date(created + REVIEW_DAYS * 86400000).toISOString();
    return [group];
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return [...conflicts, ...shareable];
}
export function reviewQueue(options: KnowledgeOptions, now = Date.now()): { items: ReviewCard[]; waiting: number; hidden: number } {
  const project = knowledgeProject(options), reader = openRecordReadOnly(options);
  if (!reader) return { items: [], waiting: 0, hidden: 0 };
  try {
    if (reader.diagnostic) throw new KnowledgeError("RECORD_UNAVAILABLE", reader.diagnostic);
    const groups = snapshotReview(reader, project.projectId, project.location.home, project.root, now);
    return { items: groups.slice(0, REVIEW_VISIBLE).map(({ members: _members, conflict: _conflict, ...card }) => card), waiting: groups.length, hidden: Math.max(0, groups.length - REVIEW_VISIBLE) };
  } finally { reader.close(); }
}
