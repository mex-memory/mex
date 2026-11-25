import { z } from "zod";
import type { RecordReader, RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";
import { DropCounts } from "./items.js";
import { FILTER_LIMITS } from "./input.js";

const FilterBatch = z.object({ batch: z.number().int().positive().safe(),
  itemsKept: z.number().int().nonnegative().max(128), itemsDropped: DropCounts,
  notesDeferred: z.number().int().nonnegative().max(FILTER_LIMITS.notes),
  notesWaitingForSync: z.number().int().nonnegative().max(FILTER_LIMITS.notes),
  messagesWithheld: z.number().int().nonnegative().max(FILTER_LIMITS.messages) }).strict();
export type FilterBatchReport = z.infer<typeof FilterBatch>;

const reportKey = (checkout: string) => `filter.latest-batch.${shortHash(checkout)}`;

/** Save just the counts, in the same transaction as completed filter output. */
export function saveFilterBatchReport(writer: RecordWriter, project: string, checkout: string, report: FilterBatchReport): void {
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(project, reportKey(checkout), JSON.stringify(FilterBatch.parse(report)));
}

export function readFilterBatchReport(reader: RecordReader, project: string, checkout: string): FilterBatchReport | null {
  const row = reader.get<{ value: string | null }>("SELECT CASE WHEN length(CAST(value AS BLOB))<=2048 THEN value END value FROM settings WHERE scope=? AND key=?",
    project, reportKey(checkout));
  if (!row?.value) return null;
  try { return FilterBatch.parse(JSON.parse(row.value)); } catch { return null; }
}

export function formatFilterBatch(report: FilterBatchReport, label = "Filter batch"): string {
  const drops = Object.entries(report.itemsDropped).sort(([a], [b]) => a.localeCompare(b));
  const dropped = drops.reduce((total, [, count]) => total + count, 0);
  const reasons = drops.length ? ` (${drops.map(([reason, count]) => `${reason} ${count}`).join(", ")})` : "";
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const parts = [
    `${label} ${report.batch} kept ${count(report.itemsKept, "item")}`,
    `dropped ${count(dropped, "item")}${reasons}`,
    `deferred ${count(report.notesDeferred, "explicit note")}`,
    `withheld context for ${count(report.messagesWithheld, "message")}`,
  ];
  if (report.notesWaitingForSync) parts.push(`${count(report.notesWaitingForSync, "note")} waiting for mex sync`);
  return parts.join(" · ");
}
