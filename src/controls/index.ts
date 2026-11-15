import type { CheckoutRow, RecordWriter } from "../record/index.js";
import { writeHookCheckout } from "../record/hook-checkouts.js";
import { publishControlMirrors } from "./mirrors.js";

/** A duration is explicit and bounded; malformed input must never turn into a permanent off. */
export function offDeadline(duration: string, now = Date.now()): string {
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/i.exec(duration);
  const milliseconds = match ? Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()]!) : NaN;
  const until = now + milliseconds;
  if (!Number.isFinite(milliseconds) || milliseconds < 1 || !Number.isSafeInteger(Math.ceil(until)) || until > 8.64e15) {
    throw new Error("Use a positive duration such as 30m, 2h or 1d.");
  }
  return new Date(until).toISOString();
}

/** Change only the registered checkout; never register a repo as a side effect. */
export function setCheckoutEnabled(writer: RecordWriter, directory: string, enabled: boolean, until: string | null = null): CheckoutRow {
  if (until !== null && (enabled || !Number.isFinite(Date.parse(until)))) throw new Error("Invalid off deadline.");
  let previous: CheckoutRow | undefined;
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    previous = writer.checkout(directory);
    if (!previous) throw new Error("MEX is not registered here. Run `mex` first.");
    const next: CheckoutRow = { ...previous, state: enabled ? "on" : until ? "off until" : "off", off_until: until };
    writer.db.prepare("UPDATE checkouts SET state=?,off_until=? WHERE path=?").run(next.state, next.off_until, next.path);
    writeHookCheckout(next, writer.location.directory);
    writer.db.exec("COMMIT");
    return next;
  } catch (error) {
    // Keep a failed publication from being reported as a successful switch.
    // Restore the old mirror under the same writer lock before rolling back.
    if (previous) { try { writeHookCheckout(previous, writer.location.directory); } catch { /* report the original failure */ } }
    writer.db.exec("ROLLBACK");
    throw error;
  }
}

/** A separate global switch never clears checkout or session choices. */
export function setGlobalEnabled(writer: RecordWriter, enabled: boolean): void {
  setPolicy(writer, "global", "enabled", enabled);
}

export function setCaptureEnabled(writer: RecordWriter, enabled: boolean, directory?: string): string {
  const scope = directory === undefined ? "global" : writer.checkout(directory)?.project_id;
  if (!scope) throw new Error("MEX is not registered here. Run `mex` first.");
  setPolicy(writer, scope, "capture.enabled", enabled);
  return scope;
}

export function setDeliveryScorer(writer: RecordWriter, value: string, directory?: string): string {
  if (!["tiers", "bm25", "fcfs", "risk"].includes(value)) throw new Error("Use tiers, bm25, fcfs or risk for delivery.scorer.");
  const scope = directory === undefined ? "global" : writer.checkout(directory)?.project_id;
  if (!scope) throw new Error("MEX is not registered here. Run mex first.");
  setPolicy(writer, scope, "delivery.scorer", value);
  return scope;
}

function setPolicy(writer: RecordWriter, scope: string, key: string, enabled: boolean | string): void {
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
      .run(scope, key, String(enabled));
    publishControlMirrors(writer.db, writer.location, scope);
    writer.db.exec("COMMIT");
  } catch (error) {
    writer.db.exec("ROLLBACK");
    // After rollback, publish only from a fresh locked snapshot. Other commands
    // may already have made another choice while the filesystem was unavailable.
    writer.db.exec("BEGIN IMMEDIATE");
    try { publishControlMirrors(writer.db, writer.location, scope); } catch { /* original failure */ }
    finally { writer.db.exec("ROLLBACK"); }
    throw error;
  }
}

/** Automatic project work is held only when every registered checkout is off. */
export function automaticWorkEnabled(writer: Pick<RecordWriter, "setting" | "db">, projectId?: string | null, now = Date.now()): boolean {
  if (process.env.MEX_OFF === "1" || writer.setting("global", "enabled") === "false") return false;
  if (!projectId) return true;
  const rows = writer.db.prepare("SELECT state,off_until FROM checkouts WHERE project_id=?").all(projectId);
  return rows.some(row => row.state === "on" || (row.state === "off until" && Number.isFinite(Date.parse(String(row.off_until))) && Date.parse(String(row.off_until)) <= now));
}
