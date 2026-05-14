import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import chalk from "chalk";
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
}

export interface LogOpts {
  kind?: string;
  files?: string[];
}

export interface TimelineOpts {
  json?: boolean;
  since?: string;
  kind?: string;
  limit?: number;
}

const VALID_KINDS = new Set<EventKind>(EVENT_KINDS);
const EVENT_FILE = "events/decisions.jsonl";

export function eventLogPath(config: MexConfig): string {
  return resolve(config.scaffoldRoot, EVENT_FILE);
}

export async function runLog(config: MexConfig, message: string, opts: LogOpts = {}): Promise<void> {
  const entry = appendEvent(config, message, opts);
  console.log(chalk.green(`Logged ${entry.kind}: ${message}`));
}

export function appendEvent(config: MexConfig, message: string, opts: LogOpts = {}): EventEntry {
  const kind = normalizeKind(opts.kind);
  const files = (opts.files ?? []).map((f) => relative(config.projectRoot, resolve(config.projectRoot, f)));
  const entry: EventEntry = {
    timestamp: new Date().toISOString(),
    kind,
    message,
    files,
    cwd: relative(config.projectRoot, process.cwd()) || ".",
  };
  const file = eventLogPath(config);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n");
  return entry;
}

export async function runTimeline(config: MexConfig, opts: TimelineOpts = {}): Promise<void> {
  const entries = readEvents(config);
  const since = parseSince(opts.since);
  const kind = opts.kind ? normalizeKind(opts.kind) : null;
  let filtered = entries.filter((e) => {
    if (kind && e.kind !== kind) return false;
    if (since && new Date(e.timestamp) < since) return false;
    return true;
  });
  filtered = filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (opts.limit && opts.limit > 0) filtered = filtered.slice(0, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({ events: filtered }, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log(chalk.dim("No events found."));
    return;
  }

  for (const e of filtered) {
    const files = e.files.length ? chalk.dim(` (${e.files.join(", ")})`) : "";
    console.log(`${chalk.bold(e.timestamp.slice(0, 10))} ${chalk.cyan(e.kind)} ${e.message}${files}`);
  }
}

export function readEvents(config: MexConfig): EventEntry[] {
  const file = eventLogPath(config);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
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
        entries.push({
          timestamp: raw.timestamp,
          kind: raw.kind,
          message: raw.message,
          files: raw.files.filter((f: unknown): f is string => typeof f === "string"),
          cwd: typeof raw.cwd === "string" ? raw.cwd : ".",
        });
      }
    } catch {
      // Ignore malformed historical lines; timeline should remain usable.
    }
  }
  return entries;
}

function normalizeKind(raw: string | undefined): EventKind {
  const kind = (raw ?? "note").toLowerCase();
  if (!VALID_KINDS.has(kind as EventKind)) {
    throw new Error(`Unknown event type "${raw}". Use decision, note, risk, or todo.`);
  }
  return kind as EventKind;
}

function parseSince(raw: string | undefined): Date | null {
  if (!raw) return null;
  const days = raw.match(/^(\d+)d$/);
  if (days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - Number(days[1]));
    return d;
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid --since value "${raw}". Use YYYY-MM-DD or Nd, e.g. 30d.`);
  }
  return parsed;
}
