import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
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

export interface TimelineOpts {
  json?: boolean;
  /** `"md"` renders a Markdown table instead of the terminal output (#55). */
  format?: string;
  since?: string;
  kind?: string;
  limit?: number;
  /** Case-insensitive literal text in an event's message. */
  query?: string;
  /** Exact recorded paths; any path may match, combined with other filters. */
  files?: string[];
}

const VALID_KINDS = new Set<EventKind>(EVENT_KINDS);
const EVENT_FILE = "events/decisions.jsonl";
const MAX_EVENT_LOG_READ_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_LOG_ENTRIES = 10_000;
const DEFAULT_TIMELINE_LIMIT = 20;
const MAX_TIMELINE_LIMIT = 200;
const MAX_TIMELINE_OUTPUT_BYTES = 64 * 1024;
const MAX_TIMELINE_QUERY_BYTES = 256;
const MAX_TIMELINE_FILES = 16;
const MAX_TIMELINE_FILE_BYTES = 1024;

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

export async function runTimeline(config: MexConfig, opts: TimelineOpts = {}): Promise<void> {
  const since = parseSince(opts.since);
  const kind = opts.kind === undefined ? null : normalizeKind(opts.kind);
  const limit = opts.limit ?? DEFAULT_TIMELINE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TIMELINE_LIMIT) {
    throw new Error(`Timeline limit must be an integer from 1 to ${MAX_TIMELINE_LIMIT}.`);
  }
  const query = normalizeTimelineQuery(opts.query);
  const files = normalizeTimelineFiles(config, opts.files);
  const { entries, sourceTruncated } = readEventLog(config);
  const filtered = entries.filter((e) => {
    if (kind && e.kind !== kind) return false;
    if (since && !(Date.parse(e.timestamp) >= since.getTime())) return false;
    if (query !== null && !e.message.toLowerCase().includes(query)) return false;
    if (files.size > 0 && !e.files.some((file) => files.has(normalizeRecordedFile(config, file)))) return false;
    return true;
  });
  // Stable ties prefer the later appended record, without locale-dependent ordering.
  filtered.reverse().sort((a, b) => a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0);
  const selected: EventEntry[] = [];
  let outputBytes = 0;
  for (const entry of filtered) {
    if (selected.length === limit) break;
    // Reserve envelope/notice space. Keep complete entries; never shorten a claim.
    const serialized = JSON.stringify(entry, null, 2);
    const entryBytes = Buffer.byteLength(serialized, "utf8") + 4 * serialized.split("\n").length + 4;
    if (outputBytes + entryBytes > MAX_TIMELINE_OUTPUT_BYTES - 512) continue;
    selected.push(entry);
    outputBytes += entryBytes;
  }
  const truncated = selected.length < filtered.length;

  if (opts.json) {
    console.log(JSON.stringify({ events: selected, truncated, sourceTruncated }, null, 2));
    return;
  }

  if (opts.format === "md") {
    printTimelineMarkdown(selected, truncated, sourceTruncated);
    return;
  }

  if (selected.length === 0 && !truncated) {
    console.log(chalk.dim("No events found."));
  }

  for (const e of selected) {
    const files = e.files.length ? chalk.dim(` (${e.files.join(", ")})`) : "";
    console.log(`${chalk.bold(e.timestamp.slice(0, 10))} ${chalk.cyan(e.kind)} ${e.message}${files}`);
  }
  if (truncated) console.log(chalk.dim("Some matching events were omitted by the entry or output limit; narrow the filters."));
  if (sourceTruncated) console.log(chalk.dim("Searched only the latest 8 MiB / 10,000 non-empty log lines; older history was not scanned."));
}

/**
 * Markdown rendering for `timeline --format md` — valid inside reports and
 * standup notes. Pipes and line breaks are escaped so a message cannot break
 * the table; omission notes mirror the terminal output in italics. The default
 * terminal rendering is untouched (#55).
 */
function printTimelineMarkdown(
  selected: EventEntry[],
  truncated: boolean,
  sourceTruncated: boolean,
): void {
  if (selected.length === 0) {
    console.log("_No events found._");
    return;
  }
  console.log("| Date | Type | Event | Files |");
  console.log("|---|---|---|---|");
  for (const e of selected) {
    const message = e.message.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    const files = e.files.length ? e.files.map((f) => `\`${f}\``).join(", ") : "—";
    console.log(`| ${e.timestamp.slice(0, 10)} | ${e.kind} | ${message} | ${files} |`);
  }
  if (truncated) console.log("_Some matching events were omitted by the entry or output limit; narrow the filters._");
  if (sourceTruncated) console.log("_Searched only the latest 8 MiB / 10,000 non-empty log lines; older history was not scanned._");
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

function normalizeTimelineQuery(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_TIMELINE_QUERY_BYTES || raw.trim() === "") {
    throw new Error(`Timeline query must be non-empty and at most ${MAX_TIMELINE_QUERY_BYTES} UTF-8 bytes.`);
  }
  return raw.trim().toLowerCase();
}

function normalizeTimelineFiles(config: MexConfig, raw: string[] | undefined): Set<string> {
  if (raw === undefined) return new Set();
  if (raw.length > MAX_TIMELINE_FILES) {
    throw new Error(`Timeline accepts at most ${MAX_TIMELINE_FILES} file filters.`);
  }
  return new Set(raw.map((file) => {
    if (file === "" || file.includes("\0") || Buffer.byteLength(file, "utf8") > MAX_TIMELINE_FILE_BYTES) {
      throw new Error(`Timeline file filters must be non-empty and at most ${MAX_TIMELINE_FILE_BYTES} UTF-8 bytes.`);
    }
    const normalized = normalizeRecordedFile(config, file);
    if (normalized === "" || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
      throw new Error("Timeline file filters must name a file inside the repository.");
    }
    return normalized;
  }));
}

function normalizeRecordedFile(config: MexConfig, file: string): string {
  return toPosix(relative(config.projectRoot, resolve(config.projectRoot, file)));
}

function normalizeKind(raw: string | undefined): EventKind {
  if (raw !== undefined && raw.length > 16) throw new Error("Unknown event type. Use decision, note, risk, or todo.");
  const kind = (raw ?? "note").toLowerCase();
  if (!VALID_KINDS.has(kind as EventKind)) {
    throw new Error(`Unknown event type "${raw}". Use decision, note, risk, or todo.`);
  }
  return kind as EventKind;
}

function parseSince(raw: string | undefined): Date | null {
  if (raw === undefined) return null;
  if (raw.length > 32) throw new Error("Invalid --since value. Use YYYY-MM-DD or Nd, e.g. 30d.");
  const days = raw.match(/^(\d+)d$/);
  if (days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - Number(days[1]));
    if (Number.isNaN(d.getTime())) throw new Error("Invalid --since day count.");
    return d;
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error(`Invalid --since value "${raw}". Use YYYY-MM-DD or Nd, e.g. 30d.`);
  }
  return parsed;
}
