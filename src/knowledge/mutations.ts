import { join } from "node:path";
import { openRecord, type RecordWriter } from "../record/index.js";
import { assertPersonQuote, EntryIdSchema, KnowledgeError, parseEntry, serializeEntry, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, readEntryFile, replaceEntryFile } from "./files.js";
import { personalSnapshot, type KnowledgeOptions, type NoteInput, type PersonalEntry } from "./store.js";
import { references } from "./references.js";
import { gateEntry, sanitizeText, stripHidden, hasSecret } from "./gates.js";
import { knowledgeProject } from "./context.js";
import { saveTombstone, tombstone, type Tombstone } from "./state.js";

function assertId(id: string): void {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Expected a stable entry id such as mx_7f3k2a.");
}
function current(writer: RecordWriter, options: KnowledgeOptions, id: string) {
  const projectId = writer.checkout(options.projectPath)?.project_id;
  if (!projectId) throw new KnowledgeError("NOT_FOUND", "No active personal note has that id in this project.");
  if (tombstone(writer, projectId, id)) throw new KnowledgeError("RETIRED_ENTRY", "The entry was retired and cannot be restored by editing.");
  const directory = containedDirectory(writer.location.home, ["projects", projectId, "notes"]);
  const content = directory && readEntryFile(join(directory, `${id}.md`));
  if (!directory || !content) throw new KnowledgeError("NOT_FOUND", "No active personal note has that id in this project.");
  const entry = parseEntry(content);
  if (entry.mex.id !== id) throw new KnowledgeError("INVALID_ENTRY", "Entry id does not match its filename.");
  if (entry.mex.status !== "active") throw new KnowledgeError("RETIRED_ENTRY", "The entry is retired and cannot be edited.");
  return { projectId, directory, content, entry };
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
  const before = personalSnapshot(id, options, knowledgeProject(options), undefined, false);
  if (hasSecret(reason)) throw new KnowledgeError("SECRET_FOUND", "The retirement reason contains a possible secret.");
  const retired = { reason: stripHidden(reason), by: `mex ${action}`, at: now.toISOString().slice(0, 10) };
  serializeEntry({ ...before.entry, mex: { ...before.entry.mex, status: "retired", retired } });
  const writer = openRecord(options);
  try {
    writer.db.exec("BEGIN IMMEDIATE");
    const found = current(writer, options, id);
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
