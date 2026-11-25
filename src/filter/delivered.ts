import { join } from "node:path";
import type { RecordReader } from "../record/index.js";
import { ENTRY_KINDS, EntryIdSchema, KnowledgeError, parseEntry } from "../knowledge/entry.js";
import { containedDirectory, readEntryFile } from "../knowledge/files.js";
import { repoFile } from "../knowledge/references.js";
import { hash } from "../judge/evidence.js";

interface DeliveredNote { text: string; oneLine: string; digest: string; }
type NoteLookup = (id: string) => readonly DeliveredNote[];
const NOTES_LIMIT = 128;

export function deliveredNoteLookup(home: string, project: string, checkout: string): NoteLookup {
  const personal = containedDirectory(home, ["projects", project, "notes"]);
  const found = new Map<string, DeliveredNote[]>();
  return id => {
    if (!EntryIdSchema.safeParse(id).success) return [];
    const cached = found.get(id);
    if (cached) return cached;
    const files = [personal && join(personal, id + ".md"), ...["", ...ENTRY_KINDS.map(kind => kind + "/")]
      .map(folder => repoFile(checkout, `.mex/learned/${folder}${id}.md`))];
    const notes: DeliveredNote[] = [];
    for (const file of files) {
      if (!file) continue;
      try {
        const raw = readEntryFile(file);
        if (!raw) continue;
        const entry = parseEntry(raw);
        if (entry.mex.id === id) notes.push({ text: entry.text, oneLine: entry.mex.one_line, digest: hash(raw) });
      } catch (error) {
        if (!(error instanceof KnowledgeError)) throw error;
        found.set(id, []);
        return [];
      }
    }
    found.set(id, notes);
    return notes;
  };
}

/** Resolve note text and the original receipt title. A missing delivered version withholds the reply. */
export function deliveredContext(hooks: RecordReader, session: string, lookup: NoteLookup): { ids: string[]; masks: string[] | null } {
  const ids = hooks.all<{ entry_id: string }>("SELECT DISTINCT entry_id FROM deliveries WHERE session_id=? AND action IN ('given','replaced') ORDER BY entry_id LIMIT ?",
    session, NOTES_LIMIT + 1).map(row => row.entry_id);
  if (ids.length > NOTES_LIMIT) throw new Error("The filter's delivered-note limit was reached.");
  const masks = new Set<string>();
  const noteIds = ids.filter(id => EntryIdSchema.safeParse(id).success);
  if (!noteIds.length) return { ids, masks: [] };
  for (const id of noteIds) {
    const notes = lookup(id);
    if (!notes.length) return { ids, masks: null };
    for (const note of notes) {
      masks.add(note.text.replaceAll("\r\n", "\n"));
      masks.add(note.oneLine);
    }
  }
  // Different versions of an entry may have been delivered during a session.
  const variants = hooks.all<{ entry_id: string; title: string; entry_hash: unknown }>(`SELECT DISTINCT entry_id,
    CASE WHEN length(CAST(title AS BLOB))<=4096 THEN title ELSE '' END title,
    CASE WHEN length(CAST(detail AS BLOB))<=2048 AND json_valid(detail) THEN json_extract(detail,'$.entry_hash') END entry_hash
    FROM deliveries WHERE session_id=? AND action IN ('given','replaced') AND entry_id IN (${noteIds.map(() => "?").join(",")}) LIMIT ?`,
    session, ...noteIds, NOTES_LIMIT * 4 + 1);
  if (variants.length > NOTES_LIMIT * 4) return { ids, masks: null };
  for (const { entry_id, title, entry_hash } of variants) {
    if (typeof entry_hash === "string" && !lookup(entry_id).some(note => note.digest === entry_hash)) return { ids, masks: null };
    if (title) masks.add(title);
  }
  return { ids, masks: [...masks] };
}
