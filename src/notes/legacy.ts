import { readContainedArtifact } from "../team/artifacts/filesystem.js";
import { EVENT_KINDS, type EventKind } from "../events.js";
import { NOTE_LIMITS, type NoteRecord, type NoteSourceStatus } from "./contracts.js";
import { sha256 } from "./codec.js";
import { artifactPath, hasCode } from "./storage.js";
import type { MexConfig } from "../types.js";

/** Preserve the original JSONL rows and existing Activity LF-offset identities. */
export function readLegacyNotes(config: MexConfig, report: (code: string, message: string) => void): { entries: NoteRecord[]; state: NoteSourceStatus } {
  const state = { truncated: false, unavailable: false };
  const path = artifactPath(config, "events/decisions.jsonl");
  const entries: NoteRecord[] = [];
  let artifact;
  try { artifact = readContainedArtifact(config.projectRoot, path, NOTE_LIMITS.sourceBytes, "exact", true); }
  catch (error) {
    if (hasCode(error, "NOT_FOUND")) return { entries, state };
    state.unavailable = true; state.truncated = true;
    report("LEGACY_SOURCE_UNAVAILABLE", "Legacy history could not be safely read.");
    return { entries, state };
  }
  const bytes = Buffer.from(artifact.bytes);
  state.truncated = artifact.offset > 0;
  let position = artifact.offset > 0 ? bytes.indexOf(10) + 1 : 0;
  if (artifact.offset > 0 && position === 0) return { entries, state };
  // Prefix CRLF count is unknown for a tail read. Never mint a replacement ID.
  if (artifact.offset > 0) report("LEGACY_IDENTITY_UNAVAILABLE", "Legacy tail rows lack their original LF offsets; IDs are unavailable for this window.");
  const rows: Array<{ start: number; end: number; logicalOffset: number }> = [];
  let rowCount = 0;
  let carriageReturns = 0;
  while (position < bytes.length) {
    const start = position;
    const newline = bytes.indexOf(10, position);
    const end = newline === -1 ? bytes.length : newline;
    const logicalOffset = start - carriageReturns;
    if (newline !== -1 && bytes[end - 1] === 13) carriageReturns++;
    position = newline === -1 ? bytes.length : newline + 1;
    if (end !== start) rows[rowCount++ % NOTE_LIMITS.sourceRecords] = { start, end, logicalOffset };
  }
  if (rowCount > NOTE_LIMITS.sourceRecords) state.truncated = true;
  const ordered = rowCount > NOTE_LIMITS.sourceRecords
    ? [...rows.slice(rowCount % NOTE_LIMITS.sourceRecords), ...rows.slice(0, rowCount % NOTE_LIMITS.sourceRecords)] : rows;
  for (const row of ordered) {
    try {
      if (row.end - row.start > 64 * 1024) throw new Error();
      const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(row.start, bytes[row.end - 1] === 13 ? row.end - 1 : row.end));
      if (raw.trim() === "") continue;
      const value = JSON.parse(raw);
      if (!value || typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp)) || typeof value.message !== "string"
        || !EVENT_KINDS.includes(value.kind) || !Array.isArray(value.files)) throw new Error();
      entries.push({ id: artifact.offset === 0 ? `legacy_${sha256(`${path}\0${row.logicalOffset}\0${raw}`)}` : null,
        format: "legacy", timestamp: value.timestamp, kind: value.kind as EventKind, message: value.message,
        files: value.files.filter((item: unknown): item is string => typeof item === "string"), cwd: typeof value.cwd === "string" ? value.cwd : ".",
        context: null, originAdapter: null, recordPath: path, revision: null,
        ...(typeof value.trace === "string" ? { trace: value.trace } : {}), ...(typeof value.source === "string" ? { source: value.source } : {}),
        ...(typeof value.status === "string" ? { status: value.status } : {}) });
    } catch { state.truncated = true; report("INVALID_LEGACY_NOTE", "A malformed or oversized legacy row was omitted."); }
  }
  return { entries, state };
}
