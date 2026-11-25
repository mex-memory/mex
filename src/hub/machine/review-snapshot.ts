import type { MachineReviewRow } from "@mex/hub-contracts/machine";
import { setImmediate } from "node:timers/promises";
import { sharingEnabled } from "../../filter/repository.js";
import { hash } from "../../judge/evidence.js";
import { KNOWLEDGE_LIMITS, KnowledgeError } from "../../knowledge/entry.js";
import { entryProducer, listProducers } from "../../knowledge/producers.js";
import type { RecordReader } from "../../record/index.js";
import { groupRevision, hasRetiredReviewSource, snapshotReview, type ReviewGroup } from "../../review/queue.js";
import { reviewReason } from "../../review/reasons.js";
import { checkoutCollation, knowledgeKey } from "./read.js";
import { conflictNote } from "./review-notes.js";
import { assertNoSecrets, stripHidden } from "../../knowledge/gates.js";
import { realPath } from "../../record/project.js";

export const REVIEW_BYTES = 8 << 20;
export const REVIEW_PROJECT_BYTES = 4 << 20;
export const reviewLimits = { retainedBytes: 8 << 20, vocabularyBytes: 48 << 20 };
export const REVIEW_SCAN_NOTE = "Some cards are missing because Review reached its reading limit.";
export const REVIEW_READ_NOTE = "Some Review cards couldn’t be read. Try refreshing.";
const MAX_LIST_NOTE_READS = 128;
const CHECKS_REQUIRED = "Record the checks before sharing this rule.";
const producers = new Map(listProducers().map(({ id, name }) => [id, name]));

export type ReviewRow = MachineReviewRow;

export interface ReviewPoint {
  /** The row carries the action checkout selected from active registrations. */
  row: ReviewRow;
  bytes: number;
}

export interface ProjectReview {
  cards: Map<string, ReviewPoint>;
  bytes: number;
  oldest?: string;
  partial?: string;
}

export function compareReview(a: ReviewPoint, b: ReviewPoint): number {
  return Number(Boolean(b.row.contradiction)) - Number(Boolean(a.row.contradiction))
    || a.row.createdAt.localeCompare(b.row.createdAt) || a.row.cardId.localeCompare(b.row.cardId)
    || a.row.repoId.localeCompare(b.row.repoId);
}

export function judgeMember(group: ReviewGroup) {
  return group.members.find(({ item }) => item.source.producer === "judge");
}

export function reviewPoint(
  repoId: string, group: ReviewGroup, checkout: string, sources: string[], active: ReadonlySet<string>,
  contradiction?: ReviewRow["contradiction"],
): ReviewPoint {
  const { id, entry: { mex }, conflict } = group;
  const judge = judgeMember(group);
  const target = judge?.item.source;
  const audience = target?.level === "team" ? "team" : "onlyYou";
  const retireTarget: MachineReviewRow["retireTarget"] = judge && { key: knowledgeKey(repoId, audience, judge.row.entry_id), audience };
  const producer = group.members[0]?.item.source.producer === "judge" ? "judge" : entryProducer(mex);
  const source = producers.get(producer === "unknown" ? "session-ongoing" : producer);
  const shareBlocked = !mex.checks.length || mex.checks.some(({ kind }) => kind === "legacy-grounding");
  let reason = conflict ? "contradiction" : reviewReason(group.reason);
  try { assertNoSecrets(reason); } catch { reason = "this rule needs your decision"; }
  const row: ReviewRow = {
    key: repoId + ":" + id, repoId, cardId: id, checkout, claim: stripHidden(mex.one_line).trim() || "Rule for Review",
    kind: mex.kind, scope: mex.scope,
    revision: hash(JSON.stringify([checkout, groupRevision(group)])),
    reason: stripHidden(reason).trim() || "this rule needs your decision",
    createdAt: new Date(group.createdAt).toISOString(), expiresAt: group.expiresAt, checkedByModel: group.checkedByModel,
    sources: { count: group.sources, producer: source ?? "MEX", checkouts: sources },
    contradiction,
    retireTarget,
    actions: conflict ? ["use", "keepCurrent"] : target ? ["share", "keep", "edit", "retire"] : ["share", "keep", "edit"],
    disabled: conflict ? undefined : {
      ...(shareBlocked ? { share: CHECKS_REQUIRED } : {}),
      ...(target?.level === "team" && !active.has(target.checkout) ? { retire: "Turn on MEX in the checkout with this note before retiring it." } : {}),
    },
  };
  return { row, bytes: JSON.stringify(row).length * 2 + 512 };
}

export const emptyReview = (partial?: string): ProjectReview => ({ cards: new Map(), bytes: 0, partial });

function recentOrder(hooks: RecordReader | undefined, repoId: string, paths: string[]): string[] {
  if (!hooks || paths.length < 2) return paths;
  return hooks.all<{ path: string }>(`
    SELECT paths.value AS path
    FROM json_each(?) AS paths
    LEFT JOIN sessions AS recent ON recent.session_id=(
      SELECT session_id FROM sessions WHERE project_id=? AND checkout=paths.value ${checkoutCollation}
      ORDER BY last_seen_at DESC,session_id DESC LIMIT 1
    )
    ORDER BY recent.last_seen_at DESC,recent.session_id DESC,paths.key
  `, JSON.stringify(paths), repoId).map(({ path }) => path);
}

export async function projectReview(
  reader: RecordReader, hooks: RecordReader | undefined, repoId: string, home: string, paths: string[], now: number,
  budget: number, signal: AbortSignal, prior?: ProjectReview,
): Promise<ProjectReview> {
  paths = paths.filter((path) => path === realPath(path));
  const active = new Set(paths);
  const shared = new Set(paths.filter((path) => sharingEnabled(reader, repoId, path)));
  let recent = paths;
  try { recent = recentOrder(hooks, repoId, paths); } catch { /* Checkout order is a fallback while hooks are unavailable. */ }
  const recentShared = recent.filter((path) => shared.has(path));
  const result = emptyReview();
  let failed = false;
  // The list needs only a few claims. Full effects are read with the selected card.
  let reads = 0;
  const claims = new Map<string, ReturnType<typeof conflictNote>["note"]>();
  for (const path of paths) {
    await setImmediate(undefined, { signal });
    try {
      for (const group of snapshotReview(reader, repoId, home, path, now, reviewLimits)) {
        if (result.cards.has(group.id) || hasRetiredReviewSource(reader, repoId, group)) continue;
        const sourcePaths = new Set(group.members.map(({ item }) => item.source.checkout));
        const sources = group.conflict ? [path] : recent.filter((source) => sourcePaths.has(source));
        const checkout = group.conflict ? path : sources.find((source) => shared.has(source)) ?? recentShared[0] ?? path;
        if (group.conflict) {
          try { assertNoSecrets(group.entry); } catch { result.partial = REVIEW_READ_NOTE; continue; }
        }
        const current = group.conflict?.conflicts.slice(0, 8).map((other): ReturnType<typeof conflictNote>["note"] => {
          const audience = other.level === "personal" ? "onlyYou" : other.level;
          const key = knowledgeKey(repoId, audience, other.id);
          const cached = claims.get(checkout + "\0" + key);
          if (cached) return cached;
          if (reads >= MAX_LIST_NOTE_READS) {
            result.partial ??= REVIEW_SCAN_NOTE;
            return { key, audience, claim: "Current note unavailable" };
          }
          reads++;
          const { note } = conflictNote(reader, { home, repoId, checkout }, other, now);
          claims.set(checkout + "\0" + key, note);
          return note;
        });
        const point = reviewPoint(repoId, group, checkout, sources.length ? sources : [checkout], active, current && { current });
        const bytes = point.bytes;
        if (result.bytes + bytes > budget || result.cards.size >= KNOWLEDGE_LIMITS.entries) {
          result.partial = REVIEW_SCAN_NOTE;
          return result;
        }
        result.cards.set(group.id, point);
        result.bytes += bytes;
        const at = point.row.createdAt;
        if (!result.oldest || at < result.oldest) result.oldest = at;
      }
    } catch (error) {
      failed = true;
      result.partial = error instanceof KnowledgeError && error.code === "STORE_LIMIT" ? REVIEW_SCAN_NOTE : REVIEW_READ_NOTE;
    }
  }
  if (failed && !result.cards.size && prior && prior.bytes <= budget) return { ...prior, partial: result.partial };
  return result;
}
