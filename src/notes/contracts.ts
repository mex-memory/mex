import type { EventKind } from "../events.js";

export const NOTE_LIMITS = Object.freeze({
  messageBytes: 16 * 1024, metadataBytes: 16 * 1024, artifactBytes: 32 * 1024,
  directoryEntries: 20_000, sourceBytes: 8 * 1024 * 1024, sourceRecords: 10_000,
  queryBytes: 256, files: 16, pathBytes: 1024, labelBytes: 1024,
  results: 200, outputBytes: 64 * 1024, diagnostics: 32,
});

export interface NoteInput {
  message: string;
  kind?: EventKind;
  files?: string[];
  trace?: string;
  source?: string;
  status?: string;
  /** Transport fact, never an inferred agent or author identity. */
  originAdapter?: "cli" | "mcp" | "api";
}

export interface NoteContext {
  projectId: string | null;
  repositoryId: null;
  worktreeId: null;
  actor: null;
  session: null;
  git: { branch: string | null; head: string | null; dirty: boolean; observedAt: string } | null;
}

export interface NoteRecord {
  /** Null only for legacy tail rows whose historical LF offset is unavailable. */
  id: string | null;
  format: "markdown" | "legacy";
  timestamp: string;
  kind: EventKind;
  message: string;
  files: string[];
  cwd: string | null;
  context: NoteContext | null;
  originAdapter: "cli" | "mcp" | "api" | null;
  trace?: string;
  source?: string;
  status?: string;
  /** Repository-relative canonical artifact location. */
  recordPath: string;
  revision: string | null;
}

export interface NoteReceipt {
  schemaVersion: 1;
  state: "locally_recorded";
  id: string;
  recordedAt: string;
  recordPath: string;
  revision: string;
  durability: "file_and_directories_flushed" | "file_flushed_directory_flush_unsupported";
}

export interface NoteQuery {
  query?: string;
  files?: string[];
  kind?: EventKind;
  /** ISO timestamp, YYYY-MM-DD, or relative Nd. */
  since?: string;
  limit?: number;
}

export interface NoteDiagnostic { code: string; message: string }
export interface NoteSourceStatus { truncated: boolean; unavailable: boolean }
export interface NoteSearchResult {
  schemaVersion: 1;
  events: NoteRecord[];
  truncated: boolean;
  sourceTruncated: boolean;
  sources: { markdown: NoteSourceStatus; legacy: NoteSourceStatus };
  diagnostics: NoteDiagnostic[];
}

export class NoteError extends Error {
  constructor(readonly code: string, message: string, readonly recordId?: string) {
    super(message);
    this.name = "NoteError";
  }
}

/** Stable, content-free transport error; no raw filesystem/Git output. */
export function noteProblem(error: unknown): { code: string; message: string; recordId?: string } {
  if (error instanceof NoteError) return { code: error.code, message: error.message, ...(error.recordId ? { recordId: error.recordId } : {}) };
  return { code: "NOTE_IO_FAILED", message: "The note operation failed. Check repository access and available storage." };
}
