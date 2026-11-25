import { openHooksReadOnly, type RecordReader } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { readStore } from "./read.js";

const RECEIPT_LIMIT = 100_000;
const DAY_MS = 86_400_000;
export const USAGE_PARTIAL = "Some earlier uses are missing because the reading limit was reached.";
export const USAGE_UNAVAILABLE = "Recent use couldn’t be read.";

export interface UseWindow { from: string; to: string; lastRow: number }
export interface UseStats { lastUsedAt: string | null; useCount30Days: number }
interface UseKey { repoId: string; id: string }
const timestamp = (ms: number) => new Date(ms).toISOString().replace(/Z$/u, "000000Z");
export const useKey = ({ repoId, id }: UseKey) => `${repoId}:${id}`;
export const noUse: UseStats = { lastUsedAt: null, useCount30Days: 0 };

export function useWindow(hooks: RecordReader | undefined, now: number): UseWindow {
  return { from: timestamp(now - 30 * DAY_MS), to: timestamp(now),
    lastRow: hooks?.get<{ last: number }>("SELECT coalesce(max(rowid),0) AS last FROM deliveries")?.last ?? 0 };
}

/**
 * The time index bounds the read before filtering or grouping. Hooks write
 * RFC3339Nano without trailing zeroes, so normalize fractions before comparing
 * times within the same second. The whole-second predicates can use the index.
 */
export const usageRange = `recent AS MATERIALIZED (
  SELECT substr(project_id,1,27) AS project_id,substr(entry_id,1,68) AS entry_id,
    action IN ('given','replaced') AND moment<>'correction' AS given,
    substr(ts,1,19) || '.' || substr(
      CASE WHEN substr(ts,20,1)='.' THEN substr(ts,21,length(ts)-21) ELSE '' END || '000000000',1,9
    ) || 'Z' AS used
  FROM deliveries INDEXED BY deliveries_ts
  WHERE ts>=substr(?,1,19) AND ts<? AND rowid<=?
  ORDER BY ts DESC,rowid DESC LIMIT ?
)`;

function usageSql(page: boolean) {
  return `WITH ${usageRange}${page ? ", page(key) AS MATERIALIZED (SELECT value FROM json_each(?))" : ""},
    stats AS (
      SELECT project_id || ':' || entry_id AS key, max(used) AS lastUsedAt, count(*) AS useCount30Days
      FROM recent WHERE used>=? AND used<=? AND length(project_id)=26 AND length(entry_id) BETWEEN 9 AND 67 AND given
        ${page ? "AND project_id || ':' || entry_id IN (SELECT key FROM page)" : ""}
      GROUP BY project_id, entry_id
    )
    SELECT key,lastUsedAt,useCount30Days FROM stats UNION ALL
    SELECT '',NULL,count(*) FROM recent`;
}

function readUsage(hooks: RecordReader | undefined, window: UseWindow, page?: readonly UseKey[]) {
  const items = new Map<string, UseStats>();
  let partial: string | undefined;
  if (hooks && window.lastRow && (!page || page.length)) {
    if (page && page.length > 100) throw new Error("Knowledge use page exceeds its limit");
    const upper = new Date(Date.parse(window.to) + 1_000).toISOString().slice(0, 19);
    const keys = page ? [JSON.stringify([...new Set(page.map(useKey))])] : [];
    const rows = hooks.all<UseStats & { key: string }>(usageSql(Boolean(page)),
      window.from, upper, window.lastRow, RECEIPT_LIMIT, ...keys, window.from, window.to);
    for (const { key, lastUsedAt, useCount30Days } of rows) {
      if (key) items.set(key, { lastUsedAt, useCount30Days });
      else if (useCount30Days >= RECEIPT_LIMIT) partial = USAGE_PARTIAL;
    }
  }
  return { items, partial };
}

export function knowledgeRanking(location: LocationOptions, window: UseWindow) {
  return readStore(openHooksReadOnly, location, (hooks) => readUsage(hooks, window));
}

export function knowledgePageUsage(location: LocationOptions, page: readonly UseKey[], window?: UseWindow, now = Date.now()) {
  try {
    return readStore(openHooksReadOnly, location, (hooks) => readUsage(hooks, window ?? useWindow(hooks, now), page));
  } catch {
    return { items: new Map<string, UseStats>(), partial: USAGE_UNAVAILABLE };
  }
}
