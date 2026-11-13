import { randomBytes } from "node:crypto";
import { existsSync, opendirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openRecord, openRecordReadOnly, recordLocation, projectIdentity, projectDataDirectory, type CheckoutRow, type RecordReader } from "../record/index.js";
import type { LocationOptions } from "../record/location.js";
import { realPath } from "../record/project.js";
import { assertPersonQuote, EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, parseEntry, serializeEntry, type EntryKind, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, createEntryFile, readEntryFile } from "./files.js";
import { retiredIds } from "./state.js";

export interface KnowledgeOptions extends LocationOptions { projectPath: string; }
export interface PersonalEntry { level: "personal"; label: string; entry: KnowledgeEntry; }
export interface NoteInput { text: string; kind?: EntryKind; scope?: string[]; oneLine?: string; }
/** Honor registered identities without migrating or registering anything on a read. */
function registeredCheckout(reader: RecordReader, requested: string): CheckoutRow | undefined {
  let current = realPath(requested);
  const start = current;
  while (true) {
    const row = reader.get<CheckoutRow>("SELECT * FROM checkouts WHERE path=?", current);
    if (row && (current === start || row.project_id.startsWith("g-") || row.provisional || existsSync(join(current, ".git")))) return row;
    if (existsSync(join(current, ".git"))) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
function readDirectory(options: KnowledgeOptions): { directory: string; retired: Set<string> } | undefined {
  const location = recordLocation({ ...options, create: false });
  // No record and no home is a normal empty read, never a setup action.
  if (!existsSync(location.home)) return undefined;
  const reader = openRecordReadOnly(options);
  try {
    if (reader?.diagnostic) throw new KnowledgeError("RECORD_UNAVAILABLE", reader.diagnostic);
    const projectId = (reader && registeredCheckout(reader, options.projectPath)?.project_id) || projectIdentity(options.projectPath).id;
    if (!/^[gf]-[a-f0-9]{24}$/u.test(projectId)) throw new KnowledgeError("UNSAFE_STORE", "Invalid registered project identity.");
    const directory = containedDirectory(location.home, ["projects", projectId, "notes"]);
    return directory ? { directory, retired: retiredIds(reader, projectId) } : undefined;
  } finally { reader?.close(); }
}
function display(entry: KnowledgeEntry): PersonalEntry {
  const day = Number(entry.mex.created.slice(8, 10));
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(entry.mex.created.slice(5, 7)) - 1];
  return { level: "personal", label: entry.mex.source.type === "person" ? `[you said, ${day} ${month}]` : `[personal, from ${entry.mex.evidence}]`, entry };
}
/** Explicit note creation is the only operation here that opens a writer. */
export function note(input: NoteInput, options: KnowledgeOptions, now = new Date()): PersonalEntry {
  const created = now.toISOString().slice(0, 10);
  const entry: KnowledgeEntry = {
    mex: {
      id: `mx_${randomBytes(12).toString("hex")}`, kind: input.kind ?? "rule", scope: input.scope ?? ["**"],
      source: { type: "person", ref: `mex note ${created}`, quote: input.text }, evidence: "person",
      one_line: input.oneLine ?? input.text.trim().replace(/\s+/gu, " "), checks: [], status: "active", created,
    }, text: input.text.trim().replace(/\r\n/g, "\n"),
  };
  // Reject bad input before initializing any persistent state.
  const bytes = serializeEntry(entry);
  assertPersonQuote(entry, input.text);
  const writer = openRecord({ ...options, create: true });
  try {
    const projectId = writer.checkout(options.projectPath)?.project_id;
    if (!projectId || !/^[gf]-[a-f0-9]{24}$/u.test(projectId)) throw new KnowledgeError("RECORD_UNAVAILABLE", "The project could not be registered.");
    // Check existing components before asking the record owner to create its project folder.
    containedDirectory(writer.location.home, ["projects", projectId]);
    projectDataDirectory(writer.location, projectId);
    const directory = containedDirectory(writer.location.home, ["projects", projectId, "notes"], true)!;
    createEntryFile(directory, entry.mex.id, bytes);
    return display(entry);
  } finally { writer.close(); }
}
function words(text: string): string[] { return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []; }
function load(directory: string, id: string): KnowledgeEntry | undefined {
  const content = readEntryFile(join(directory, `${id}.md`));
  if (content === undefined) return undefined;
  const entry = parseEntry(content);
  if (entry.mex.id !== id) throw new KnowledgeError("INVALID_ENTRY", "Entry id does not match its filename.");
  return entry.mex.status === "active" ? entry : undefined;
}
export function expand(id: string, options: KnowledgeOptions): PersonalEntry {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Expected a stable entry id such as mx_7f3k2a.");
  const store = readDirectory(options);
  const entry = store && !store.retired.has(id) && load(store.directory, id);
  if (!entry) throw new KnowledgeError("NOT_FOUND", "No active personal note has that id in this project.");
  return display(entry);
}
export interface RecallItem {
  id: string; level: "personal"; label: string; kind: EntryKind; one_line: string;
  scope: string[]; source: Pick<KnowledgeEntry["mex"]["source"], "type" | "ref">;
  evidence: KnowledgeEntry["mex"]["evidence"]; created: string;
}
export interface RecallResult { entries: RecallItem[]; truncated: boolean; }
export function recall(query: string, options: KnowledgeOptions, limit = 20): RecallResult {
  if (query.length > KNOWLEDGE_LIMITS.queryCharacters) throw new KnowledgeError("INVALID_QUERY", "Search text exceeds 256 characters.");
  const terms = [...new Set(words(query))];
  if (!terms.length) throw new KnowledgeError("INVALID_QUERY", "Search requires at least one word.");
  if (!Number.isInteger(limit) || limit < 1 || limit > KNOWLEDGE_LIMITS.results) throw new KnowledgeError("INVALID_LIMIT", "Search limit must be between 1 and 100.");
  const store = readDirectory(options);
  if (!store) return { entries: [], truncated: false };
  const { directory, retired } = store;
  const names: string[] = [];
  const handle = opendirSync(directory);
  try {
    let child, seen = 0;
    while ((child = handle.readSync())) {
      if (++seen > KNOWLEDGE_LIMITS.entries) throw new KnowledgeError("STORE_LIMIT", "Personal note directory exceeds the scan limit.");
      if (/^mx_[a-z0-9]{6,64}\.md$/u.test(child.name)) names.push(child.name.slice(0, -3));
    }
  } finally { handle.closeSync(); }
  names.sort();
  const matches: RecallItem[] = [];
  let totalBytes = 0;
  for (const id of names) {
    const content = readEntryFile(join(directory, `${id}.md`));
    if (content === undefined) continue;
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("STORE_LIMIT", "Personal notes exceed the byte scan limit.");
    if (retired.has(id)) continue;
    const entry = parseEntry(content);
    if (entry.mex.id !== id) throw new KnowledgeError("INVALID_ENTRY", "Entry id does not match its filename.");
    if (entry.mex.status !== "active") continue;
    const searchable = new Set(words([entry.text, entry.mex.one_line, entry.mex.kind, ...entry.mex.scope].join(" ")));
    if (terms.every(term => searchable.has(term))) {
      const { kind, one_line, scope, source, evidence, created } = entry.mex;
      matches.push({ id, level: "personal", label: display(entry).label, kind, one_line, scope, source: { type: source.type, ref: source.ref }, evidence, created });
    }
  }
  matches.sort((a, b) => a.created !== b.created ? (a.created > b.created ? -1 : 1) : a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
  return { entries: matches.slice(0, limit), truncated: matches.length > limit };
}
