import { randomBytes } from "node:crypto";
import { existsSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { openRecord, projectIdentity, projectDataDirectory } from "../record/index.js";
import { assertPersonQuote, EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, parseEntry, serializeEntry, type EntryKind, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, createEntryFile, readEntryFile } from "./files.js";
import { knowledgeProject, type KnowledgeOptions, type KnowledgeProject } from "./context.js";
import { references, type References } from "./references.js";
import { gateEntry, sanitizeText } from "./gates.js";
import { entryLabel, KNOWLEDGE_PRIORITY, type KnowledgeLevel } from "./labels.js";
import { expandTeam, teamEntries, type TeamEntry } from "./team.js";
export type { KnowledgeOptions } from "./context.js";

export interface PersonalEntry { level: "personal"; label: string; entry: KnowledgeEntry; }
export type StoredEntry = PersonalEntry | TeamEntry;
export interface NoteInput { text: string; kind?: EntryKind; scope?: string[]; oneLine?: string; }
function readDirectory(project: KnowledgeProject): string | undefined {
  if (!existsSync(project.location.home)) return undefined;
  return containedDirectory(project.location.home, ["projects", project.projectId, "notes"]);
}
function display(entry: KnowledgeEntry): PersonalEntry {
  return { level: "personal", label: entryLabel(entry, "personal"), entry };
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
  serializeEntry(entry);
  const source = references(projectIdentity(options.projectPath).rootPath);
  const gated = gateEntry(entry, source);
  const bytes = serializeEntry(gated);
  assertPersonQuote(gated, sanitizeText(input.text, source));
  const writer = openRecord({ ...options, create: true });
  try {
    const projectId = writer.checkout(options.projectPath)?.project_id;
    if (!projectId || !/^[gf]-[a-f0-9]{24}$/u.test(projectId)) throw new KnowledgeError("RECORD_UNAVAILABLE", "The project could not be registered.");
    // Check existing components before asking the record owner to create its project folder.
    containedDirectory(writer.location.home, ["projects", projectId]);
    projectDataDirectory(writer.location, projectId);
    const directory = containedDirectory(writer.location.home, ["projects", projectId, "notes"], true)!;
    createEntryFile(directory, gated.mex.id, bytes);
    return display(gated);
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
export function personalSnapshot(id: string, options: KnowledgeOptions, project = knowledgeProject(options), source?: References, gated = true) {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Expected a stable entry id such as mx_7f3k2a.");
  const directory = readDirectory(project);
  const content = directory && !project.retired.has(id) && readEntryFile(join(directory, `${id}.md`));
  if (!directory || !content) throw new KnowledgeError("NOT_FOUND", "No active personal note has that id in this project.");
  const entry = parseEntry(content);
  if (entry.mex.id !== id) throw new KnowledgeError("INVALID_ENTRY", "Entry id does not match its filename.");
  if (entry.mex.status !== "active") throw new KnowledgeError("NOT_FOUND", "No active personal note has that id in this project.");
  return { ...display(gated ? gateEntry(entry, source ?? references(project.root)) : entry), directory, content };
}
export function expandPersonal(id: string, options: KnowledgeOptions, project = knowledgeProject(options), source?: References): PersonalEntry {
  const { level, label, entry } = personalSnapshot(id, options, project, source);
  return { level, label, entry };
}
export function expand(id: string, options: KnowledgeOptions): StoredEntry {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Expected a stable entry id such as mx_7f3k2a.");
  const project = knowledgeProject(options);
  if (project.retired.has(id)) throw new KnowledgeError("NOT_FOUND", "No active entry has that id in this project.");
  try { return expandPersonal(id, options, project); }
  catch (error) { if (!(error instanceof KnowledgeError) || error.code !== "NOT_FOUND") throw error; }
  const team = expandTeam(id, options);
  if (team) return team;
  throw new KnowledgeError("NOT_FOUND", "No active entry has that id in this project.");
}
export interface RecallItem {
  id: string; level: KnowledgeLevel; label: string; kind: EntryKind; one_line: string;
  scope: string[]; source: Pick<KnowledgeEntry["mex"]["source"], "type" | "ref">;
  evidence: KnowledgeEntry["mex"]["evidence"]; created: string;
  branch?: TeamEntry["branch"];
}
export interface RecallResult { entries: RecallItem[]; truncated: boolean; withheld?: number; }
export function recallItem(item: { level: KnowledgeLevel; label: string; entry: KnowledgeEntry; branch?: TeamEntry["branch"] }): RecallItem {
  const { id, kind, one_line, scope, source, evidence, created } = item.entry.mex;
  return { id, level: item.level, label: item.label, kind, one_line, scope, source: { type: source.type, ref: source.ref }, evidence, created, ...(item.branch ? { branch: item.branch } : {}) };
}
export function matchesQuery(entry: KnowledgeEntry, query: string): boolean {
  const searchable = new Set(words([entry.text, entry.mex.one_line, entry.mex.kind, ...entry.mex.scope].join(" ")));
  return [...new Set(words(query))].every(term => searchable.has(term));
}
export function recallPersonal(query: string, options: KnowledgeOptions, limit = 20, project = knowledgeProject(options), source?: References): RecallResult {
  if (query.length > KNOWLEDGE_LIMITS.queryCharacters) throw new KnowledgeError("INVALID_QUERY", "Search text exceeds 256 characters.");
  const terms = [...new Set(words(query))];
  if (!terms.length) throw new KnowledgeError("INVALID_QUERY", "Search requires at least one word.");
  if (!Number.isInteger(limit) || limit < 1 || limit > KNOWLEDGE_LIMITS.results) throw new KnowledgeError("INVALID_LIMIT", "Search limit must be between 1 and 100.");
  const directory = readDirectory(project);
  if (!directory) return { entries: [], truncated: false };
  const { retired } = project;
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
    let entry = parseEntry(content);
    if (entry.mex.id !== id) throw new KnowledgeError("INVALID_ENTRY", "Entry id does not match its filename.");
    if (entry.mex.status !== "active") continue;
    source ??= references(project.root);
    entry = gateEntry(entry, source);
    const searchable = new Set(words([entry.text, entry.mex.one_line, entry.mex.kind, ...entry.mex.scope].join(" ")));
    if (terms.every(term => searchable.has(term))) {
      const { kind, one_line, scope, source, evidence, created } = entry.mex;
      matches.push({ id, level: "personal", label: display(entry).label, kind, one_line, scope, source: { type: source.type, ref: source.ref }, evidence, created });
    }
  }
  matches.sort((a, b) => a.created !== b.created ? (a.created > b.created ? -1 : 1) : a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
  return { entries: matches.slice(0, limit), truncated: matches.length > limit };
}

export function recall(query: string, options: KnowledgeOptions, limit = 20): RecallResult {
  const project = knowledgeProject(options);
  const personal = recallPersonal(query, options, limit, project);
  const team = teamEntries(options);
  const items = [...personal.entries, ...team.entries.filter(item => !project.retired.has(item.entry.mex.id) && matchesQuery(item.entry, query)).map(recallItem)];
  const seen = new Set<string>();
  const entries = items.filter(item => !seen.has(item.id) && !!seen.add(item.id));
  entries.sort((a, b) => KNOWLEDGE_PRIORITY.indexOf(a.level) - KNOWLEDGE_PRIORITY.indexOf(b.level)
    || b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
  return { entries: entries.slice(0, limit), truncated: personal.truncated || entries.length > limit, ...(team.withheld ? { withheld: team.withheld } : {}) };
}
