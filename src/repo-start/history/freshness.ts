/**
 * Code facts age as the code moves on. Over the newest 400 landed changes of Hono, novu, django,
 * flask and requests, pairs re-mined before each change were right 274 times in 346 hints (0.79),
 * against 168 in 220 (0.76) for pairs mined once before them: equal or better precision and 63%
 * more correct hints (scripts/measure-change-together.ts). So the background process re-reads a
 * project's history when the checkout its facts came from has a new HEAD, at most once per
 * REMINE_MS. Only projects already mined (by `mex`) are refreshed.
 */
import { execFileSync } from "node:child_process";
import type { RecordWriter } from "../../record/index.js";
import type { EnqueueOptions, EnqueueResult } from "../../record/jobs.js";
import { automaticWorkEnabled } from "../../controls/index.js";
import { readFactFile } from "../facts.js";
import type { CodeFactsFile } from "./job.js";

/** The shortest gap between two re-reads of one project's history. */
export const REMINE_MS = 10 * 60_000;
/** Projects checked per pass; the background process passes once a minute. */
const MAX_PROJECTS = 32;

export type HeadReader = (checkout: string) => string | undefined;
const readHead: HeadReader = checkout => {
  try {
    return execFileSync("git", ["-C", checkout, "rev-parse", "-q", "--verify", "HEAD"],
      { encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch { return undefined; }
};

/** Bumped when the entries made from the same facts change, so the next run proposes them again. */
export const ENTRIES_VERSION = 1;
/** Project setting: `{head, version, complete}` of the last time code facts were proposed as entries. */
export const ENTRIES_KEY = "code-facts.entries";

export interface EntriesProposed { head?: string; version?: number; complete?: boolean; }
export function readEntriesProposed(writer: RecordWriter, projectId: string): EntriesProposed | undefined {
  try {
    const value = JSON.parse(writer.setting(projectId, ENTRIES_KEY) ?? "null") as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return undefined;
    return {
      head: typeof value.head === "string" ? value.head : undefined,
      version: typeof value.version === "number" ? value.version : undefined,
      complete: value.complete !== false,
    };
  } catch { return undefined; }
}
/** The HEAD whose entries were proposed in full by this version, if any. */
export function entriesProposedAt(writer: RecordWriter, projectId: string): string | undefined {
  const value = readEntriesProposed(writer, projectId);
  return value?.version === ENTRIES_VERSION && value.complete ? value.head : undefined;
}
/**
 * Entries this version has never tried to propose: none yet (facts mined before entries existed)
 * or an older ENTRIES_VERSION. A run that tried and stayed incomplete is not retried until HEAD moves.
 */
function entriesOutdated(writer: RecordWriter, projectId: string): boolean {
  const value = readEntriesProposed(writer, projectId);
  return value?.version === undefined || value.version < ENTRIES_VERSION;
}

/**
 * Queue a code-facts job for every project whose mined checkout has moved on, or whose facts
 * this version hasn't yet proposed as entries. Returns how many were queued.
 */
export function queueStaleCodeFacts(
  writer: RecordWriter,
  queue: (writer: RecordWriter, options: EnqueueOptions) => EnqueueResult,
  now = Date.now(),
  head: HeadReader = readHead,
): number {
  let queued = 0;
  const rows = writer.db.prepare("SELECT DISTINCT project_id FROM checkouts WHERE state='on' AND provisional IS NULL LIMIT ?")
    .all(MAX_PROJECTS) as Array<{ project_id: string }>;
  for (const { project_id: projectId } of rows) {
    const facts = readFactFile<CodeFactsFile>(writer.location, projectId, "code-facts.json");
    if (!facts?.checkout || facts.skipped || !facts.head) continue;
    const built = Date.parse(facts.built_at);
    if (!Number.isFinite(built) || now - built < REMINE_MS) continue;
    const checkout = writer.db.prepare("SELECT state FROM checkouts WHERE project_id=? AND path=?").get(projectId, facts.checkout) as { state: string } | undefined;
    if (checkout?.state !== "on" || !automaticWorkEnabled(writer, projectId, now)) continue;
    const current = head(facts.checkout);
    if (!current || (current === facts.head && !entriesOutdated(writer, projectId))) continue;
    if (!queue(writer, { kind: "code-facts", projectId, params: { checkout: facts.checkout } }).existing) queued++;
  }
  return queued;
}
