import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RecordLocation } from "../record/location.js";
import { readSnapshot, replaceFile } from "../install/files.js";

function publish(file: string, value: unknown): void {
  const before = readSnapshot(file, 4096);
  const data = Buffer.from(`${JSON.stringify(value)}\n`).toString("base64");
  if (before.data !== data) replaceFile(file, before, { data, mode: 0o600 });
}

/** Called under the Node record writer lock, including when repairing after a crash. */
export function publishControlMirrors(db: DatabaseSync, location: RecordLocation, onlyScope?: string): void {
  const rows = db.prepare("SELECT scope,key,value FROM settings WHERE (scope='global' AND key IN ('enabled','ledger.holdout')) OR key IN ('capture.enabled','delivery.scorer','delivery.aliases') OR key LIKE 'delivery.surface.%'").all();
  const global = new Map(rows.filter(row => row.scope === "global").map(row => [String(row.key), String(row.value)]));
  const file = join(location.home, "controls.json");
  if ((onlyScope === undefined || onlyScope === "global") && (global.size || existsSync(file))) {
    const surfaces = Object.fromEntries([...global].filter(([key]) => key.startsWith("delivery.surface.")).map(([key, value]) => [key.slice(17), value]));
    const trial = global.get("ledger.holdout");
    publish(file, { version: 1, off: global.get("enabled") === "false", capture: global.get("capture.enabled") !== "false", ...(global.has("delivery.scorer") ? { scorer: global.get("delivery.scorer") } : {}), ...(global.has("delivery.aliases") ? { aliases: global.get("delivery.aliases") } : {}), ...(Object.keys(surfaces).length ? { surfaces } : {}), ...(trial ? { ledger_holdout: trial } : {}) });
  }
  const deliveryScopes = new Set(rows.filter(row => row.scope !== "global" && (row.key === "delivery.scorer" || String(row.key).startsWith("delivery.surface."))).map(row => String(row.scope)));
  for (const scope of deliveryScopes) {
    if (onlyScope !== undefined && scope !== onlyScope) continue;
    if (!/^[gf]-[a-f0-9]{24}$/.test(scope)) throw new Error("Invalid delivery project identity.");
    const settings = new Map(rows.filter(row => row.scope === scope).map(row => [String(row.key), String(row.value)]));
    const scorer = settings.get("delivery.scorer");
    if (scorer && !["tiers", "bm25", "fcfs", "risk"].includes(scorer)) throw new Error("Invalid delivery scorer.");
    const surfaces = Object.fromEntries([...settings].filter(([key]) => key.startsWith("delivery.surface.")).map(([key, value]) => [key.slice(17), value]));
    publish(join(location.directory, "hook-delivery", scope + ".json"), { version: 1, ...(scorer ? { scorer } : {}), ...(Object.keys(surfaces).length ? { surfaces } : {}) });
  }
  for (const row of rows) {
    if (row.scope === "global" || (row.key !== "capture.enabled" && row.key !== "delivery.scorer")) continue;
    if (onlyScope !== undefined && row.scope !== onlyScope) continue;
    if (!/^[gf]-[a-f0-9]{24}$/.test(String(row.scope))) throw new Error("Invalid capture project identity.");
    if (row.key === "delivery.scorer") {
      continue;
    }
    publish(join(location.directory, "hook-capture", `${row.scope}.json`), { version: 1, enabled: row.value !== "false" });
  }
}

/** Ordinary record readers never repair. A Node writer may repair its own mirrors. */
export function repairControlMirrors(db: DatabaseSync, location: RecordLocation): void {
  let held = false;
  try {
    db.exec("BEGIN IMMEDIATE"); held = true;
    publishControlMirrors(db, location);
    db.exec("COMMIT"); held = false;
  } catch { /* Explicit controls use strict publication and report failures. */ }
  finally { if (held) { try { db.exec("ROLLBACK"); } catch { /* original failure */ } } }
}
