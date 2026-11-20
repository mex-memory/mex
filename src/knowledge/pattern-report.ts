/**
 * Pattern monitoring for `mex report` (plan sheet 31). The hook keeps
 * <record directory>/projects/<project>/pattern-monitor.json with, per entry,
 * when its `when:` patterns last fired and how often they fired and were
 * broken in the current 30-day window. A pattern that never fired in 90 days
 * is listed here, never deleted; one that fires often and is never broken is
 * already delivered through the area digest, and is listed so it can be seen.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { parseEntry, type KnowledgeEntry } from "./entry.js";
import { readBoundedTextFile, readEntryFile } from "./files.js";
import { teamEntries } from "./team.js";

/** Keep in step with native/delivery/monitor.go. */
export const SILENT_DAYS = 90;
const WINDOW_DAYS = 30;
const DIGEST_FIRINGS = 10;
const MAX_PERSONAL = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Activity { last_fired?: string; last_violation?: string; window: string; fired: number; violations: number }
export interface PatternRow { id: string; one_line: string; created: string; last_fired: string | null }
export interface PatternReport { silent: PatternRow[]; digest: PatternRow[] }

export function readPatternMonitor(recordDirectory: string, projectId: string): Record<string, Activity> {
  const text = readBoundedTextFile(join(recordDirectory, "projects", projectId, "pattern-monitor.json"), 1 << 20);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as { version?: number; entries?: Record<string, Activity> };
    return parsed.version === 1 && parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
  } catch {
    return {};
  }
}

function patternedEntries(options: KnowledgeOptions): KnowledgeEntry[] {
  const project = knowledgeProject(options);
  const out: KnowledgeEntry[] = [];
  const notes = join(project.location.home, "projects", project.projectId, "notes");
  let names: string[] = [];
  try { names = readdirSync(notes).filter(name => /^mx_[a-z0-9]+\.md$/u.test(name)).slice(0, MAX_PERSONAL); } catch { /* no notes */ }
  for (const name of names) {
    const content = readEntryFile(join(notes, name));
    if (!content) continue;
    try { out.push(parseEntry(content)); } catch { /* an unreadable note is reported elsewhere */ }
  }
  for (const team of teamEntries(options).entries) out.push(team.entry);
  return out.filter(entry => entry.mex.status === "active" && (entry.mex.when?.some(w => w.type !== "creates") ?? false));
}

export function patternReport(options: KnowledgeOptions, now = new Date()): PatternReport {
  const project = knowledgeProject(options);
  const activity = readPatternMonitor(project.location.directory, project.projectId);
  const silentSince = now.getTime() - SILENT_DAYS * DAY_MS;
  const silent: PatternRow[] = [], digest: PatternRow[] = [];
  const seen = new Set<string>();
  for (const entry of patternedEntries(options)) {
    const { id, one_line, created } = entry.mex;
    if (seen.has(id)) continue;
    seen.add(id);
    const a = activity[id];
    const row: PatternRow = { id, one_line, created, last_fired: a?.last_fired ?? null };
    const lastFired = a?.last_fired ? Date.parse(a.last_fired) : NaN;
    // Old enough to have had 90 days, and no firing in them.
    if (Date.parse(created) <= silentSince && !(lastFired > silentSince)) silent.push(row);
    const windowStart = a ? Date.parse(a.window) : NaN;
    if (a && a.fired >= DIGEST_FIRINGS && a.violations === 0 && now.getTime() - windowStart <= WINDOW_DAYS * DAY_MS) digest.push(row);
  }
  const order = (x: PatternRow, y: PatternRow) => (x.last_fired ?? "").localeCompare(y.last_fired ?? "") || x.id.localeCompare(y.id);
  return { silent: silent.sort(order), digest: digest.sort(order) };
}

export function formatPatternReport(report: PatternReport): string[] {
  const lines: string[] = [];
  if (report.silent.length) {
    lines.push(`Patterns that haven't fired in ${SILENT_DAYS} days (kept; check they still describe the code):`);
    for (const row of report.silent) lines.push(`  ${row.id} ${row.one_line} (last fired ${row.last_fired ?? "never"})`);
  }
  if (report.digest.length) {
    lines.push("Patterns that fire often and are never broken (sent in the area digest, one line each):");
    for (const row of report.digest) lines.push(`  ${row.id} ${row.one_line}`);
  }
  return lines;
}
