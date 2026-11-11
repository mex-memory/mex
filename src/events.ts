import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, resolve, relative } from "node:path";
import chalk from "chalk";
import { toPosix } from "./paths.js";
import type { MexConfig } from "./types.js";

/** Runtime list of valid event kinds. Re-exported as part of the public API so
 *  consumers can validate user-supplied kinds against the same source of truth. */
export const EVENT_KINDS = ["decision", "note", "risk", "todo"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventEntry {
  timestamp: string;
  kind: EventKind;
  message: string;
  files: string[];
  cwd: string;
  /** Optional pointer to a long-form trace document for this event. Free-form
   *  string — typically a path under `.mex/traces/` (e.g.
   *  `.mex/traces/2026-05-15-jwt.md`) but no format is enforced. Intended for
   *  embedders that capture richer context than the short `message` field
   *  can hold. Omitted on entries that don't reference a trace. */
  trace?: string;
  /** Optional provenance marker — where the event originated (e.g. "meeting",
   *  "manual", "agent"). Free-form string, no enum. Absent means the event was
   *  authored manually, the same as every pre-existing entry. Intended for
   *  external tools (e.g. mex-call) that write events on a human's behalf. */
  source?: string;
  /** Optional lifecycle marker for a decision (e.g. "decided", "implemented").
   *  Free-form string — deliberately NOT an enum so the reader never drops a
   *  line over an unrecognized value the way it does for `kind`. Omitted on
   *  entries that don't track a lifecycle. */
  status?: string;
}

export interface LogOpts {
  kind?: string;
  files?: string[];
  /** Optional pointer to a long-form trace document — persisted as
   *  `EventEntry.trace`. See that field for the contract. */
  trace?: string;
  /** Optional provenance marker — persisted as `EventEntry.source`. See that
   *  field for the contract. */
  source?: string;
  /** Optional lifecycle marker — persisted as `EventEntry.status`. See that
   *  field for the contract. */
  status?: string;
}

const VALID_KINDS = new Set<EventKind>(EVENT_KINDS);
const EVENT_FILE = "events/decisions.jsonl";
const MAX_EVENT_LOG_READ_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_LOG_ENTRIES = 10_000;

export function eventLogPath(config: MexConfig): string {
  return resolve(config.scaffoldRoot, EVENT_FILE);
}

export async function runLog(config: MexConfig, message: string, opts: LogOpts = {}): Promise<void> {
  const entry = appendEvent(config, message, opts);
  console.log(chalk.green(`Logged ${entry.kind}: ${message}`));
}

export function appendEvent(config: MexConfig, message: string, opts: LogOpts = {}): EventEntry {
  const kind = normalizeKind(opts.kind);
  const files = (opts.files ?? []).map((f) => toPosix(relative(config.projectRoot, resolve(config.projectRoot, f))));
  const entry: EventEntry = {
    timestamp: new Date().toISOString(),
    kind,
    message,
    files,
    cwd: toPosix(relative(config.projectRoot, process.cwd())) || ".",
  };
  if (opts.trace !== undefined) entry.trace = opts.trace;
  if (opts.source !== undefined) entry.source = opts.source;
  if (opts.status !== undefined) entry.status = opts.status;
  const file = eventLogPath(config);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n");
  return entry;
}

export function readEvents(config: MexConfig): EventEntry[] {
  return readEventLog(config).entries;
}

function readEventLog(config: MexConfig): { entries: EventEntry[]; sourceTruncated: boolean } {
  const file = eventLogPath(config);
  if (!existsSync(file)) return { entries: [], sourceTruncated: false };
  const read = readBoundedEventLog(file);
  const allLines = read.text.split("\n").filter(Boolean);
  const sourceTruncated = read.truncated || allLines.length > MAX_EVENT_LOG_ENTRIES;
  const lines = allLines.slice(-MAX_EVENT_LOG_ENTRIES);
  const entries: EventEntry[] = [];
  for (const line of lines) {
    try {
      const raw = JSON.parse(line);
      if (
        typeof raw.timestamp === "string" &&
        VALID_KINDS.has(raw.kind) &&
        typeof raw.message === "string" &&
        Array.isArray(raw.files)
      ) {
        const entry: EventEntry = {
          timestamp: raw.timestamp,
          kind: raw.kind,
          message: raw.message,
          files: raw.files.filter((f: unknown): f is string => typeof f === "string"),
          cwd: typeof raw.cwd === "string" ? raw.cwd : ".",
        };
        if (typeof raw.trace === "string") entry.trace = raw.trace;
        if (typeof raw.source === "string") entry.source = raw.source;
        if (typeof raw.status === "string") entry.status = raw.status;
        entries.push(entry);
      }
    } catch {
      // Ignore malformed historical lines; timeline should remain usable.
    }
  }
  return { entries, sourceTruncated };
}

function readBoundedEventLog(file: string): { text: string; truncated: boolean } {
  const size = statSync(file, { bigint: true }).size;
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The legacy event log is too large to inspect safely.");
  }
  const byteCount = Number(size > BigInt(MAX_EVENT_LOG_READ_BYTES)
    ? BigInt(MAX_EVENT_LOG_READ_BYTES)
    : size);
  const start = Number(size) - byteCount;
  const buffer = Buffer.alloc(byteCount);
  const descriptor = openSync(file, "r");
  try {
    let offset = 0;
    while (offset < byteCount) {
      const read = readSync(descriptor, buffer, offset, byteCount - offset, start + offset);
      if (read === 0) break;
      offset += read;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const firstCompleteLine = text.indexOf("\n");
      text = firstCompleteLine === -1 ? "" : text.slice(firstCompleteLine + 1);
    }
    return { text, truncated: start > 0 };
  } finally {
    closeSync(descriptor);
  }
}

function normalizeKind(raw: string | undefined): EventKind {
  if (raw !== undefined && raw.length > 16) throw new Error("Unknown event type. Use decision, note, risk, or todo.");
  const kind = (raw ?? "note").toLowerCase();
  if (!VALID_KINDS.has(kind as EventKind)) {
    throw new Error(`Unknown event type "${raw}". Use decision, note, risk, or todo.`);
  }
  return kind as EventKind;
}
