import type { DatabaseSync } from "node:sqlite";

/**
 * The usage log of graph work (record migration 6): CPU time and peak memory
 * of every build, refresh, verify and warm update. Warm updates are summed per
 * project and checkout per minute, not one row per keystroke.
 */
export type BuildUsageKind = "build" | "refresh" | "verify" | "warm";
export type BuildUsageResult = "ok" | "unchanged" | "failed";

export interface BuildUsage {
  projectId: string;
  checkout: string;
  kind: BuildUsageKind;
  files: number;
  wallMs: number;
  /** This process, the candidate process and the compiler servers together. */
  cpuMs: number;
  /** Node plus the compiler server. */
  peakRssMb: number;
  /** The compiler server alone, when it was measured. */
  serverRssMb?: number;
  result: BuildUsageResult;
  at?: Date;
}

export interface BuildUsageRow {
  ts: string;
  kind: BuildUsageKind;
  files: number;
  wall_ms: number;
  cpu_ms: number;
  peak_rss_mb: number;
  server_rss_mb: number | null;
  result: BuildUsageResult;
  runs: number;
}

/** Rows older than this are removed as new ones arrive. */
export const BUILD_USAGE_RETENTION_DAYS = 90;

const whole = (value: number): number => Math.max(0, Math.round(Number.isFinite(value) ? value : 0));

export function recordBuildUsage(db: DatabaseSync, usage: BuildUsage): void {
  const at = usage.at ?? new Date();
  const values = [
    usage.projectId, usage.checkout, usage.kind, whole(usage.files), whole(usage.wallMs), whole(usage.cpuMs),
    whole(usage.peakRssMb), usage.serverRssMb === undefined ? null : whole(usage.serverRssMb), usage.result,
  ] as const;
  if (usage.kind === "warm") {
    const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
    db.prepare(`INSERT INTO build_usage(ts,project_id,checkout,kind,files,wall_ms,cpu_ms,peak_rss_mb,server_rss_mb,result)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id,checkout,ts) WHERE kind='warm' DO UPDATE SET
        files=files+excluded.files, wall_ms=wall_ms+excluded.wall_ms, cpu_ms=cpu_ms+excluded.cpu_ms,
        peak_rss_mb=max(peak_rss_mb,excluded.peak_rss_mb),
        server_rss_mb=CASE WHEN server_rss_mb IS NULL THEN excluded.server_rss_mb
          WHEN excluded.server_rss_mb IS NULL THEN server_rss_mb ELSE max(server_rss_mb,excluded.server_rss_mb) END,
        result=CASE WHEN result='failed' OR excluded.result='failed' THEN 'failed' ELSE excluded.result END,
        runs=runs+1`).run(minute, ...values);
    return;
  }
  db.prepare(`INSERT INTO build_usage(ts,project_id,checkout,kind,files,wall_ms,cpu_ms,peak_rss_mb,server_rss_mb,result)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(at.toISOString(), ...values);
  const cutoff = new Date(at.getTime() - BUILD_USAGE_RETENTION_DAYS * 86_400_000).toISOString();
  db.prepare("DELETE FROM build_usage WHERE ts<?").run(cutoff);
}

interface Reader { all<T>(sql: string, ...values: Array<string | number>): T[] }

/** The latest row of each kind for one checkout, for `mex graph status --json`. */
export function latestBuildUsage(reader: Reader, projectId: string, checkout: string): Partial<Record<BuildUsageKind, BuildUsageRow>> {
  const rows = reader.all<BuildUsageRow>(`SELECT ts,kind,files,wall_ms,cpu_ms,peak_rss_mb,server_rss_mb,result,runs FROM build_usage u
    WHERE project_id=? AND checkout=? AND ts=(SELECT max(ts) FROM build_usage v WHERE v.project_id=u.project_id AND v.checkout=u.checkout AND v.kind=u.kind)`,
  projectId, checkout);
  const latest: Partial<Record<BuildUsageKind, BuildUsageRow>> = {};
  for (const row of rows) latest[row.kind] = row;
  return latest;
}
