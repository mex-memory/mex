import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { MexConfig } from "../types.js";
import { toPosix } from "../paths.js";
import { createRepositoryGitPort } from "../team/git/git-port.js";
import { atomicCreateArtifact } from "../team/artifacts/filesystem.js";
import { EVENT_KINDS, type EventKind } from "../events.js";
import { NOTE_LIMITS, NoteError, type NoteContext, type NoteInput, type NoteQuery, type NoteReceipt, type NoteRecord, type NoteSearchResult } from "./contracts.js";
import { encodeNote, newNoteId, notePath, portablePath, sha256 } from "./codec.js";
import { artifactPath, discoverNotes, hasCode, prepareNoteStorage, readNoteFile } from "./storage.js";
import { readLegacyNotes } from "./legacy.js";

function boundedString(value: unknown, max: number, name: string): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || Buffer.from(value).toString("utf8") !== value) {
    throw new NoteError("INVALID_NOTE_INPUT", `${name} must be valid Unicode and at most ${max} UTF-8 bytes.`);
  }
}
function normalizeFiles(config: MexConfig, files: unknown): string[] {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > NOTE_LIMITS.files) throw new NoteError("INVALID_NOTE_INPUT", "At most 16 related file paths are allowed.");
  return files.map((file) => {
    boundedString(file, NOTE_LIMITS.pathBytes, "File path");
    const normalized = toPosix(relative(config.projectRoot, resolve(config.projectRoot, file)));
    if (!portablePath(normalized) || Buffer.byteLength(normalized) > NOTE_LIMITS.pathBytes) throw new NoteError("INVALID_NOTE_INPUT", "Related files must name paths within the repository.");
    return normalized;
  });
}
function kind(value: unknown): EventKind {
  if (typeof value !== "string" || !EVENT_KINDS.includes(value.toLowerCase() as EventKind)) throw new NoteError("INVALID_NOTE_INPUT", "Unknown note kind. Use decision, note, risk or todo.");
  return value.toLowerCase() as EventKind;
}

export async function recordNote(config: MexConfig, input: NoteInput): Promise<NoteReceipt> {
  if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["message", "kind", "files", "trace", "source", "status", "originAdapter"].includes(key))) {
    throw new NoteError("INVALID_NOTE_INPUT", "Unknown note input field; retries and attachments are not supported by this writer.");
  }
  boundedString(input.message, NOTE_LIMITS.messageBytes, "Message");
  const label = kind(input.kind ?? "note");
  const files = normalizeFiles(config, input.files);
  for (const field of ["trace", "source", "status"] as const) if (input[field] !== undefined) boundedString(input[field], NOTE_LIMITS.labelBytes, field);
  const adapter = input.originAdapter ?? "api";
  if (!["api", "cli", "mcp"].includes(adapter)) throw new NoteError("INVALID_NOTE_INPUT", "Unknown note origin adapter.");
  // Validate the scaffold binding before optional context observation.
  artifactPath(config, "events/notes");
  const context: NoteContext = { projectId: z.string().uuid().safeParse(config.identity?.scaffold_id).success ? config.identity!.scaffold_id : null,
    repositoryId: null, worktreeId: null, actor: null, session: null, git: null };
  try { context.git = await createRepositoryGitPort(config.projectRoot, { timeoutMs: 2000 }).getRepoState(); }
  catch { /* Observation unavailable: recording a general note still works. */ }
  const relativeCwd = toPosix(relative(config.projectRoot, process.cwd()));
  const cwd = relativeCwd === "" ? "." : portablePath(relativeCwd) && !isAbsolute(relativeCwd) && Buffer.byteLength(relativeCwd) <= NOTE_LIMITS.pathBytes ? relativeCwd : null;
  const timestamp = new Date();
  const id = newNoteId(timestamp);
  const recordPath = artifactPath(config, notePath(id));
  const bytes = encodeNote({ id, timestamp: timestamp.toISOString(), kind: label, files, cwd, context, originAdapter: adapter,
    message: input.message, ...(input.trace === undefined ? {} : { trace: input.trace }), ...(input.source === undefined ? {} : { source: input.source }), ...(input.status === undefined ? {} : { status: input.status }) });
  try {
    prepareNoteStorage(config, id);
    atomicCreateArtifact(config.projectRoot, recordPath, bytes, 0o644, true);
  } catch (error) {
    // Publication may have happened before a directory flush failed. Never delete
    // the final record as compensation or silently turn this into a fresh write.
    if (error instanceof NoteError) throw error;
    throw new NoteError("NOTE_WRITE_UNCONFIRMED", "Durable note recording could not be confirmed. Inspect the record ID before submitting another unkeyed note.", id);
  }
  return { schemaVersion: 1, state: "locally_recorded", id, recordedAt: timestamp.toISOString(), recordPath,
    revision: sha256(bytes), durability: process.platform === "win32" ? "file_flushed_directory_flush_unsupported" : "file_and_directories_flushed" };
}

export function getNote(config: MexConfig, id: string): NoteRecord {
  boundedString(id, 80, "Note ID");
  if (/^legacy_[a-f0-9]{64}$/.test(id)) {
    const legacy = readLegacyNotes(config, () => {});
    const found = legacy.entries.find((entry) => entry.id === id);
    if (found) return found;
    if (legacy.state.truncated || legacy.state.unavailable) throw new NoteError("NOTE_LOOKUP_INCOMPLETE", "Legacy identity lookup exceeds available bounded history.");
    throw new NoteError("NOTE_NOT_FOUND", "The note was not found.");
  }
  try { return readNoteFile(config, id); }
  catch (error) {
    if (hasCode(error, "NOT_FOUND")) throw new NoteError("NOTE_NOT_FOUND", "The note was not found.");
    throw error;
  }
}

function sinceTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  boundedString(value, 64, "Since");
  const days = /^(\d+)d$/.exec(value);
  if (days) {
    const time = Date.now() - Number(days[1]) * 86_400_000;
    if (Number.isFinite(time) && !Number.isNaN(new Date(time).getTime())) return time;
  } else {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
    if (z.string().datetime({ offset: true }).safeParse(date).success && !Number.isNaN(Date.parse(date))) return Date.parse(date);
  }
  throw new NoteError("INVALID_NOTE_INPUT", "Since must be YYYY-MM-DD, an ISO timestamp or Nd.");
}

export function findNotes(config: MexConfig, query: NoteQuery = {}): NoteSearchResult {
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > NOTE_LIMITS.results) throw new NoteError("INVALID_NOTE_INPUT", "Limit must be an integer from 1 to 200.");
  const label = query.kind === undefined ? null : kind(query.kind);
  const since = sinceTime(query.since);
  let subject: string | null = null;
  if (query.query !== undefined) {
    boundedString(query.query, NOTE_LIMITS.queryBytes, "Query");
    subject = query.query.trim().toLowerCase();
    if (!subject) throw new NoteError("INVALID_NOTE_INPUT", "Query must not be blank.");
  }
  const files = new Set(normalizeFiles(config, query.files));
  const result: NoteSearchResult = { schemaVersion: 1, events: [], truncated: false, sourceTruncated: false,
    sources: { markdown: { truncated: false, unavailable: false }, legacy: { truncated: false, unavailable: false } }, diagnostics: [] };
  const report = (code: string, message: string) => {
    if (result.diagnostics.length < NOTE_LIMITS.diagnostics) result.diagnostics.push({ code, message });
    else result.diagnostics[NOTE_LIMITS.diagnostics - 1] = { code: "DIAGNOSTICS_OMITTED", message: "Additional source diagnostics were omitted." };
  };
  const markdown = discoverNotes(config, report);
  const legacy = readLegacyNotes(config, report);
  result.sources = { markdown: markdown.state, legacy: legacy.state };
  result.sourceTruncated = markdown.state.truncated || legacy.state.truncated;
  // Reverse legacy append order before stable sorting; keep the original tie rule.
  const records = [...markdown.entries, ...legacy.entries.reverse()].filter((entry) => {
    if (label && entry.kind !== label || since !== null && !(Date.parse(entry.timestamp) >= since)) return false;
    if (subject !== null && !entry.message.toLowerCase().includes(subject)) return false;
    return files.size === 0 || entry.files.some((file) => files.has(toPosix(relative(config.projectRoot, resolve(config.projectRoot, file)))));
  });
  records.sort((a, b) => {
    const time = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    if (time) return time;
    if (a.format === "legacy" && b.format === "legacy") return 0;
    return (a.id ?? "") < (b.id ?? "") ? 1 : (a.id ?? "") > (b.id ?? "") ? -1 : 0;
  });
  for (const record of records) {
    if (result.events.length === limit) break;
    result.events.push(record);
    // Reserve the true-valued omission flags before measuring the final envelope.
    if (Buffer.byteLength(JSON.stringify(result, null, 2)) + 16 > NOTE_LIMITS.outputBytes) result.events.pop();
  }
  result.truncated = result.events.length < records.length;
  return result;
}
