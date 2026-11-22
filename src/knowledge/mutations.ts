import { join } from "node:path";
import { openRecord, type RecordWriter } from "../record/index.js";
import { assertPersonQuote, EntryIdSchema, isLearnedEntry, KnowledgeError, parseEntry, serializeEntry, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, readEntryFile, replaceEntryFile } from "./files.js";
import { personalSnapshot, type KnowledgeOptions, type NoteInput, type PersonalEntry } from "./store.js";
import { references } from "./references.js";
import { gateEntry, sanitizeText, stripHidden, hasSecret } from "./gates.js";
import { knowledgeProject } from "./context.js";
import { saveTombstone, tombstone, type Tombstone } from "./state.js";
import { entryLabel } from "./labels.js";
import { recordVerified } from "./gate.js";

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
  serializeEntry({ ...before.entry, mex: { ...before.entry.mex, status: "retired", retired } });
  const writer = openRecord(options);
  try {
    writer.db.exec("BEGIN IMMEDIATE");
    const found = current(writer, options, id, ["active", "proposed"]);
    const marker = saveTombstone(writer, found.projectId, found.entry, retired);
    writer.db.exec("COMMIT");
    return marker;
  } finally {
    try { writer.db.exec("ROLLBACK"); } catch { /* already committed, or preserve the original failure */ }
    writer.close();
  }
}

export function wrong(id: string, reason: string, options: KnowledgeOptions, now = new Date()): Tombstone {
  return forget(id, reason, options, now, "wrong");
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
    const from = to === "active" ? "proposed" : "active";
    const found = current(writer, options, id, [from]);
    if (found.entry.mex.status !== from || !isLearnedEntry(found.entry.mex)) {
      throw new KnowledgeError("INVALID_CHANGE", "Only a learned rule can be ticked or unticked on the review list.");
    }
    const changed: KnowledgeEntry = { ...found.entry, mex: { ...found.entry.mex, status: to } };
    replaceEntryFile(found.directory, id, found.content, serializeEntry(changed));
    if (to === "active") recordVerified(writer, found.projectId, id, "person", now);
    writer.db.exec("COMMIT");
    return { level: "personal", label: entryLabel(changed, "personal"), entry: changed };
  } finally {
    try { writer.db.exec("ROLLBACK"); } catch { /* already committed, or preserve the original failure */ }
    writer.close();
  }
}
