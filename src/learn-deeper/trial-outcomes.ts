import { openHooksReadOnly, type RecordWriter } from "../record/index.js";

export type TrialKind = "issues" | "linter" | "alternatives";
export interface TrialDelivery { entryId: string; kind: TrialKind; acted: number; settled: number }
export interface TrialReceiptEntry { id: string; issues?: number; linter?: boolean; alternatives?: number }

/** Follow and ignore are counted from the delivery of that entry, after the window settles. */
export function trialFollowCounts(rows: readonly TrialDelivery[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.settled !== 1) continue;
    const name = `trial.${row.kind}.${row.acted === 1 ? "followed" : "ignored"}`;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

export function trialKinds(entry: TrialReceiptEntry): TrialKind[] {
  const kinds: TrialKind[] = [];
  if (entry.issues) kinds.push("issues");
  if (entry.linter) kinds.push("linter");
  if (entry.alternatives) kinds.push("alternatives");
  return kinds;
}

/** Replace the follow snapshot on each trial receipt from settled deliveries of that entry. */
export function recordTrialDeliveryOutcomes(writer: RecordWriter): void {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  if (!hooks || hooks.diagnostic) return;
  try {
    const receipts = writer.db.prepare(`SELECT scope, key, value FROM settings WHERE key GLOB 'learning.deep.trials.*' LIMIT 64`).all() as Array<{ scope: string; key: string; value: string }>;
    const save = writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
    for (const receipt of receipts) {
      let parsed: { entries?: TrialReceiptEntry[]; follow?: Record<string, number> };
      try { parsed = JSON.parse(receipt.value) as typeof parsed; } catch { continue; }
      const rows: TrialDelivery[] = [];
      for (const entry of (parsed.entries ?? []).slice(0, 200)) {
        if (!entry || typeof entry.id !== "string") continue;
        const kinds = trialKinds(entry);
        if (!kinds.length) continue;
        const found = hooks.all<{ acted: number; settled: number }>(`SELECT w.acted AS acted, w.settled AS settled FROM deliveries d
          JOIN surface_windows w ON w.delivery_id=d.id WHERE d.entry_id=? AND d.project_id=? LIMIT 32`, entry.id, receipt.scope);
        for (const kind of kinds) for (const window of found) rows.push({ entryId: entry.id, kind, acted: window.acted, settled: window.settled });
      }
      const follow = trialFollowCounts(rows);
      if (JSON.stringify(parsed.follow ?? {}) === JSON.stringify(follow)) continue;
      save.run(receipt.scope, receipt.key, JSON.stringify({ ...parsed, follow }));
    }
  } catch { /* A hooks database without these tables leaves the receipt unchanged. */ }
  finally { hooks.close(); }
}
