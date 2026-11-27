import { join } from "node:path";
import { openRecord, type RecordWriter } from "../record/index.js";
import { assertPersonQuote, EntryIdSchema, isLearnedEntry, KNOWLEDGE_LIMITS, KnowledgeError, parseEntry, serializeEntry, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, readEntryFile, replaceEntryFile } from "./files.js";
import { personalSnapshot, type KnowledgeOptions, type NoteInput, type PersonalEntry } from "./store.js";
import { references } from "./references.js";
import { gateEntry, sanitizeText, stripHidden, hasSecret } from "./gates.js";
import { knowledgeProject } from "./context.js";
import { claimHash, saveTombstone, tombstone, type Retirement, type Tombstone } from "./state.js";
import { entryLabel } from "./labels.js";
import { recordVerified } from "./gate.js";
import { publishNotes, snapshotNotes } from "./personal-store.js";
import { noteKey } from "../learn-deeper/coverage.js";
import { LEARNED_TRIAL_LABEL } from "../learn-deeper/trial-outcomes.js";
import { forgetObservations } from "../learn-deeper/observations.js";
import { sourceDigest } from "../learn-deeper/source.js";

export const learnedRefusalKey = (id: string) => `learning.deep.refused.${id}`;
export const learnedWaitingKey = (id: string) => `learning.deep.waiting.${id}`;
export const learnedReviewedKey = (jobId: string) => `learning.deep.reviewed.${jobId}`;

function recordRefusal(writer: RecordWriter, project: string, entry: KnowledgeEntry): void {
  putSetting(writer, project, learnedRefusalKey(entry.mex.id), JSON.stringify([claimHash(entry.text), claimHash(entry.mex.one_line)]));
}

function putSetting(writer: RecordWriter, project: string, key: string, value: string): void {
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(project, key, value);
}

function retiredEntry(entry: KnowledgeEntry, retired: Retirement): string {
  return serializeEntry({ ...entry, mex: { ...entry.mex, status: "retired", retired } });
}

function retireNote(writer: RecordWriter, project: string, entry: KnowledgeEntry, retired: Retirement): Tombstone {
  const marker = saveTombstone(writer, project, entry, retired);
  if (isLearnedEntry(entry.mex)) {
    recordRefusal(writer, project, entry);
    forgetObservations(writer.db, project, entry.mex.id);
  }
  return marker;
}

function noteReceipt(writer: RecordWriter, project: string, id: string): { hash?: unknown } | null {
  const value = writer.setting(project, noteKey(id));
  if (!value || Buffer.byteLength(value) > 20_000) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Older unticks changed only the file status, leaving the receipt for the active revision. */
export function learnedRefused(writer: RecordWriter, project: string, entry: KnowledgeEntry, raw: string): boolean {
  if (writer.setting(project, learnedRefusalKey(entry.mex.id))) return true;
  if (entry.mex.status !== "proposed") return false;
  const proof = noteReceipt(writer, project, entry.mex.id);
  return !!proof && proof.hash !== sourceDigest(raw) && proof.hash === sourceDigest(serializeEntry({ ...entry, mex: { ...entry.mex, status: "active" } }));
}

function recordStatusChange(writer: RecordWriter, project: string, entry: KnowledgeEntry,
  before: string, after: string, status: "active" | "proposed", now: Date): void {
  const id = entry.mex.id;
  if (status === "active") {
    recordVerified(writer, project, id, "person", now);
    putSetting(writer, project, "learning.deep.trial." + id, "permanent");
    writer.db.prepare("DELETE FROM settings WHERE scope=? AND key IN (?,?)").run(project, learnedRefusalKey(id), learnedWaitingKey(id));
  } else recordRefusal(writer, project, entry);
  // A status-only change does not invalidate the source receipt. Only renew it
  // if it attested to the exact revision the person saw.
  const proof = noteReceipt(writer, project, id);
  if (proof?.hash === sourceDigest(before)) putSetting(writer, project, noteKey(id), JSON.stringify({ ...proof, hash: sourceDigest(after) }));
}

function assertId(id: string): void {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Expected a stable entry id such as mx_7f3k2a.");
}
function current(writer: RecordWriter, options: KnowledgeOptions, id: string, statuses: readonly string[] = ["active"]) {
  const projectId = writer.checkout(options.projectPath)?.project_id;
  if (!projectId) throw new KnowledgeError("NOT_FOUND", "No active personal note has that id in this project.");
  if (tombstone(writer, projectId, id)) throw new KnowledgeError("RETIRED_ENTRY", "The entry was retired and cannot be restored by editing.");
  const directory = containedDirectory(writer.location.home, ["projects", projectId, "notes"]);
  const content = directory && readEntryFile(join(directory, `${id}.md`));
  if (!directory || !content) throw new KnowledgeError("NOT_FOUND", "No active personal note has that id in this project.");
  const entry = parseEntry(content);
  if (entry.mex.id !== id) throw new KnowledgeError("INVALID_ENTRY", "Entry id does not match its filename.");
  if (!statuses.includes(entry.mex.status)) throw new KnowledgeError("RETIRED_ENTRY", "The entry is retired and cannot be edited.");
  return { projectId, directory, content, entry };
}

/**
 * Replace a personal note's retrieval aids or other non-claim fields, keeping
 * its claim, source and status. Proposed notes can be changed this way too;
 * an edit of the claim goes through edit() instead.
 */
export function replacePersonalFields(id: string, change: (entry: KnowledgeEntry) => KnowledgeEntry, options: KnowledgeOptions, expected?: string): PersonalEntry {
  assertId(id);
  const writer = openRecord(options);
  try {
    writer.db.exec("BEGIN IMMEDIATE");
    const found = current(writer, options, id, ["active", "proposed"]);
    if (expected !== undefined && found.content !== expected) throw new KnowledgeError("STALE_ENTRY", "The entry changed; read it again before changing it.");
    const changed = change(found.entry);
    for (const field of ["id", "kind", "source", "evidence", "one_line", "status", "created"] as const) {
      if (JSON.stringify(changed.mex[field]) !== JSON.stringify(found.entry.mex[field])) throw new KnowledgeError("INVALID_CHANGE", `This change can't alter the entry's ${field}.`);
    }
    if (changed.text !== found.entry.text) throw new KnowledgeError("INVALID_CHANGE", "This change can't alter the entry's text.");
    replaceEntryFile(found.directory, id, found.content, serializeEntry(changed));
    return { level: "personal", label: entryLabel(changed, "personal"), entry: changed };
  } finally {
    try { writer.db.exec("ROLLBACK"); } catch { /* do not hide the outcome */ }
    writer.close();
  }
}

export function editedEntry(entry: KnowledgeEntry, input: NoteInput, now: Date): KnowledgeEntry {
  const changed: KnowledgeEntry = {
    mex: {
      id: entry.mex.id, kind: input.kind ?? entry.mex.kind, scope: input.scope ?? entry.mex.scope,
      source: { type: "person", ref: `mex edit ${now.toISOString().slice(0, 10)}`, quote: input.text }, evidence: "person",
      one_line: input.oneLine ?? input.text.trim().replace(/\s+/gu, " "),
      // The old observations and trigger patterns no longer attest to this claim.
      checks: [], status: "active", created: entry.mex.created,
    }, text: input.text.trim().replace(/\r\n/g, "\n"),
  };
  serializeEntry(changed); assertPersonQuote(changed, input.text);
  return changed;
}

export function edit(id: string, input: NoteInput, options: KnowledgeOptions, now = new Date()): PersonalEntry {
  assertId(id);
  const before = personalSnapshot(id, options);
  const context = references(knowledgeProject(options).root);
  const changed = gateEntry(editedEntry(before.entry, input, now), context);
  assertPersonQuote(changed, sanitizeText(input.text, context));
  const writer = openRecord(options);
  try {
    writer.db.exec("BEGIN IMMEDIATE");
    const found = current(writer, options, id);
    if (found.content !== before.content) throw new KnowledgeError("STALE_ENTRY", "The entry changed; read it again before editing.");
    replaceEntryFile(found.directory, id, found.content, serializeEntry(changed));
    return { level: "personal", label: before.label, entry: changed };
  } finally {
    // Only a lock is held here; the filesystem publication is the edit's commit.
    try { writer.db.exec("ROLLBACK"); } catch { /* do not hide an edit outcome */ }
    writer.close();
  }
}

/** Retire locally in one durable transaction; restored old Markdown stays hidden. */
export function forget(id: string, reason: string, options: KnowledgeOptions, now = new Date(), action: "forget" | "wrong" = "forget"): Tombstone {
  assertId(id);
  const before = personalSnapshot(id, options, knowledgeProject(options), undefined, false, true);
  reason = stripHidden(reason);
  if (hasSecret(reason)) throw new KnowledgeError("SECRET_FOUND", "The retirement reason contains a possible secret.");
  const retired = { reason, by: `mex ${action}`, at: now.toISOString().slice(0, 10) };
  retiredEntry(before.entry, retired);
  const writer = openRecord(options);
  try {
    writer.db.exec("BEGIN IMMEDIATE");
    const found = current(writer, options, id, ["active", "proposed"]);
    if (!isLearnedEntry(found.entry.mex)) {
      const marker = retireNote(writer, found.projectId, found.entry, retired);
      writer.db.exec("COMMIT");
      return marker;
    }
    // Native delivery reads the entry file, so publish its retirement together
    // with the durable tombstone used by learn deeper and recall.
    const notes = snapshotNotes(writer, found.projectId);
    if (notes.files.get(id) !== found.content) throw new KnowledgeError("STALE_ENTRY", "The entry changed; read it again.");
    const files = new Map(notes.files).set(id, retiredEntry(found.entry, retired));
    let marker!: Tombstone;
    publishNotes(writer, found.projectId, notes, files,
      () => { marker = retireNote(writer, found.projectId, found.entry, retired); }, { locked: true });
    return marker;
  } finally {
    try { writer.db.exec("ROLLBACK"); } catch { /* already committed, or preserve the original failure */ }
    writer.close();
  }
}

export function wrong(id: string, reason: string, options: KnowledgeOptions, now = new Date()): Tombstone {
  return forget(id, reason, options, now, "wrong");
}

function reviewedStatus(entry: KnowledgeEntry, status: "active" | "proposed"): KnowledgeEntry {
  const label = entry.mex.source.label?.replace(LEARNED_TRIAL_LABEL, "");
  return { ...entry, mex: { ...entry.mex, status, source: { ...entry.mex.source, label } } };
}

/**
 * A person's tick on the learn-deeper review list: a learned rule that waited for it comes into force,
 * and the tick is recorded as its verification. Only learned rules wait for a tick; nothing else changes.
 */
export function tickLearned(id: string, options: KnowledgeOptions, now = new Date()): PersonalEntry {
  return setLearnedStatus(id, options, "active", now);
}

/** A person unticks a learned rule on the review list: it waits again and isn't delivered. */
export function untickLearned(id: string, options: KnowledgeOptions, now = new Date()): PersonalEntry {
  return setLearnedStatus(id, options, "proposed", now);
}

function setLearnedStatus(id: string, options: KnowledgeOptions, to: "active" | "proposed", now: Date): PersonalEntry {
  assertId(id);
  const writer = openRecord(options);
  try {
    writer.db.exec("BEGIN IMMEDIATE");
    const from = to === "active" ? ["proposed", "active"] as const : ["active"] as const;
    const found = current(writer, options, id, from);
    if (!isLearnedEntry(found.entry.mex) || (to === "active" && found.entry.mex.status === "active"
      && !found.entry.mex.source.label?.startsWith(LEARNED_TRIAL_LABEL))) {
      throw new KnowledgeError("INVALID_CHANGE", "Only a learned rule can be ticked or unticked on the review list.");
    }
    const changed = reviewedStatus(found.entry, to);
    const before = snapshotNotes(writer, found.projectId);
    if (before.files.get(id) !== found.content) throw new KnowledgeError("STALE_ENTRY", "The entry changed; read it again.");
    const after = serializeEntry(changed);
    const files = new Map(before.files).set(id, after);
    publishNotes(writer, found.projectId, before, files,
      () => recordStatusChange(writer, found.projectId, found.entry, found.content, after, to, now), { locked: true });
    return { level: "personal", label: entryLabel(changed, "personal"), entry: changed };
  } finally {
    try { writer.db.exec("ROLLBACK"); } catch { /* already committed, or preserve the original failure */ }
    writer.close();
  }
}

export interface LearnedReviewDecision {
  id: string;
  raw: string;
  decision: "keep" | "trial" | "wait" | "drop";
  support: number;
  /** A verify rewrite the producer gate already accepted. Saved as waiting, not as an edit command. */
  rewrite?: string;
}

/** Apply the whole review or leave it pending if any entry changed while it was open. */
export function finishLearnedReview(jobId: string, project: string, decisions: readonly LearnedReviewDecision[],
  options: KnowledgeOptions, now = new Date()): { kept: number; trials: number; waiting: number; dropped: number } {
  const writer = openRecord(options);
  try {
    writer.db.exec("BEGIN IMMEDIATE");
    const stale = () => new KnowledgeError("STALE_ENTRY", "The learned rules changed. Open the review again.");
    if (writer.checkout(options.projectPath)?.project_id !== project || writer.setting(project, learnedReviewedKey(jobId))) throw stale();
    const before = snapshotNotes(writer, project);
    const files = new Map(before.files);
    const metadata: Array<() => void> = [];
    const outcome = { kept: 0, trials: 0, waiting: 0, dropped: 0 };
    for (const { id, raw, decision, rewrite } of decisions) {
      if (before.files.get(id) !== raw || tombstone(writer, project, id)) throw stale();
      const entry = parseEntry(raw);
      if (entry.mex.id !== id || !isLearnedEntry(entry.mex) || entry.mex.status === "retired" || learnedRefused(writer, project, entry, raw)) throw stale();
      if (decision === "trial") {
        if (entry.mex.status !== "active" || !entry.mex.source.label?.startsWith(LEARNED_TRIAL_LABEL)) throw stale();
        outcome.trials++;
        continue;
      }
      if (decision === "wait" && rewrite) {
        const text = rewrite.trim().replace(/\s+/gu, " ");
        const changed: KnowledgeEntry = { ...entry, text, mex: { ...entry.mex, one_line: text.slice(0, KNOWLEDGE_LIMITS.oneLineCharacters), status: "proposed" } };
        const gated = gateEntry(changed, references(options.projectPath));
        const after = serializeEntry(gated);
        outcome.waiting++;
        files.set(id, after);
        metadata.push(() => {
          putSetting(writer, project, learnedWaitingKey(id), "true");
          const proof = noteReceipt(writer, project, id);
          if (proof?.hash === sourceDigest(raw)) putSetting(writer, project, noteKey(id), JSON.stringify({ ...proof, hash: sourceDigest(after) }));
        });
        continue;
      }
      if (decision === "drop") {
        const retired = { reason: "Dropped on the learn-deeper review list", by: "mex forget", at: now.toISOString().slice(0, 10) };
        outcome.dropped++;
        files.set(id, retiredEntry(entry, retired));
        metadata.push(() => retireNote(writer, project, entry, retired));
        continue;
      }
      const status = decision === "keep" ? "active" : "proposed";
      if (decision === "keep") outcome.kept++;
      else outcome.waiting++;
      if (entry.mex.status !== status || decision === "keep" && entry.mex.source.label?.startsWith(LEARNED_TRIAL_LABEL)) {
        const after = serializeEntry(reviewedStatus(entry, status));
        files.set(id, after);
        metadata.push(() => recordStatusChange(writer, project, entry, raw, after, status, now));
      } else if (decision === "wait") {
        // Any support count. A later weekly run must not switch this on without a tick.
        metadata.push(() => putSetting(writer, project, learnedWaitingKey(id), "true"));
      }
    }
    const record = () => {
      for (const apply of metadata) apply();
      putSetting(writer, project, learnedReviewedKey(jobId), now.toISOString());
    };
    if ([...files].some(([id, raw]) => before.files.get(id) !== raw)) {
      publishNotes(writer, project, before, files, record, { locked: true });
    } else { record(); writer.db.exec("COMMIT"); }
    return outcome;
  } finally {
    try { writer.db.exec("ROLLBACK"); } catch { /* The transaction may already have ended. */ }
    writer.close();
  }
}
