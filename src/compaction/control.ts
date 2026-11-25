import { z } from "zod";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { MAX_SETTINGS_BYTES, equalSnapshot, readSnapshot, replaceFile } from "../install/files.js";
import { withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import type { RecordReader, RecordWriter } from "../record/index.js";
import { changeCompactSettings, compactSettingsPath, restoreCompactSettings, type CompactAgent, type CompactChoice, type CompactScope } from "./settings.js";
import { healthPause } from "./evidence.js";
import { LEDGER_MODE, publishCompactionLedgerNotice, type LedgerMode } from "../ledger/view.js";

const scope = "compaction";
const snapshots = z.object({ data: z.string().max(Math.ceil(MAX_SETTINGS_BYTES / 3) * 4).nullable(), mode: z.number().int().min(0).max(0o777) }).strict();
const selection = z.object({
  agent: z.enum(["claude-code", "codex"]), model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
  checkout: z.string().max(4096).refine(isAbsolute), scope: z.enum(["user", "repo"]),
  choice: z.enum(["window", "idle", "post-turn"]),
  value: z.number().int().positive().max(500_000),
}).strict();
const active = selection.extend({
  state: z.literal("active"), at: z.number().int().nonnegative(), path: z.string().max(4096).refine(isAbsolute),
  before: snapshots, after: snapshots,
}).strict();
const paused = selection.extend({ state: z.literal("paused"), at: z.number().int().nonnegative(), reason: z.enum(["kept-rate", "rereads", "ledger"]) }).strict();
const receipt = z.discriminatedUnion("state", [active, paused]);
const publicState = (r: z.infer<typeof receipt>) => {
  const { agent, model, checkout, scope: savedScope, choice, value } = r;
  return { agent, model, checkout, scope: savedScope, choice, value, state: r.state,
    ...(r.state === "paused" ? { reason: r.reason } : {}) };
};

export type CompactSelection = z.infer<typeof selection>;
const keyFor = (id: string) => `window.${id}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function entries(record: RecordReader | RecordWriter) {
  const query = `SELECT key, CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END value FROM settings
    WHERE scope=? AND key GLOB 'window.*' ORDER BY key LIMIT 17`;
  const rows = "location" in record ? record.db.prepare(query).all(3 << 20, scope)
    : record.all<{ key: string; value: string }>(query, 3 << 20, scope);
  if (rows.length > 16) throw new Error("The managed compaction settings limit was reached.");
  return rows.map(row => ({ key: String(row.key), change: receipt.parse(JSON.parse(String(row.value))) }));
}

export function compactStates(reader: RecordReader, checkout: string) {
  return entries(reader).map(row => row.change).filter(change => change.scope === "user" || change.checkout === checkout).map(publicState);
}

export function recordedCompactChanges(reader: RecordReader) {
  return entries(reader).flatMap(({ key, change }) => change.state === "active" ? [{ key, ...change }] : []);
}

export function compactSettingFiles(reader: RecordReader): string[] {
  return recordedCompactChanges(reader).map(({ path }) => path);
}

export function compactReviewNeeded(writer: RecordWriter): boolean {
  return !!writer.db.prepare(`SELECT 1 FROM settings WHERE scope=? AND key GLOB 'window.*'
    AND CASE WHEN json_valid(value) THEN value->>'$.state'='active' ELSE false END LIMIT 1`).get(scope);
}

function compactWatch(writer: RecordWriter): void {
  const path = join(writer.location.directory, "compaction-watch");
  const current = readSnapshot(path, 16);
  const data = compactReviewNeeded(writer) ? Buffer.from("1\n").toString("base64") : null;
  if (data !== current.data) replaceFile(path, current, { data, mode: 0o600 });
}

export function prepareCompact(request: CompactSelection) {
  const target = selection.parse(request);
  const path = compactSettingsPath(target.agent, target.scope, target.checkout);
  const before = readSnapshot(path, MAX_SETTINGS_BYTES);
  const after = changeCompactSettings(before, target.agent, target.model, target.choice, target.value);
  const offer = sha(JSON.stringify([target, path, before, after])).slice(0, 24);
  return { target, path, before, after, offer };
}

export async function acceptCompact(writer: RecordWriter, request: CompactSelection, acceptedOffer: string) {
  return await withContainedArtifactLock(writer.location.home, "install", ".install.lock", () => {
    const { target, path, before, after, offer } = prepareCompact(request);
    if (offer !== acceptedOffer) throw new Error("The offer changed. Run mex compact again to review the current offer.");
    if (equalSnapshot(before, after)) return false;
    const key = keyFor(sha(path));
    const saved = entries(writer);
    if (saved.some(row => row.key === key && row.change.state === "active")) throw new Error("Run mex compact off before changing this managed setting.");
    if (saved.length >= 16 && !saved.some(row => row.key === key)) throw new Error("The managed compaction settings limit was reached.");
    const change = active.parse({ ...target, path, before, after, state: "active", at: Date.now() });
    // The durable undo snapshot precedes the host write. If the process
    // stops between them, off can recognize an already restored file.
    writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
      .run(scope, key, JSON.stringify(change));
    try {
      compactWatch(writer);
      replaceFile(path, before, after);
    } catch (error) {
      // File replacement may have failed after journaling, while the settings
      // still hold the original value. Discard that unused acceptance.
      if (equalSnapshot(readSnapshot(path, MAX_SETTINGS_BYTES), before)) {
        const previous = saved.find(row => row.key === key)?.change;
        if (previous) writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify(previous), scope, key);
        else writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(scope, key);
      }
      throw error;
    }
    return true;
  });
}

/** Caller holds the installation lock. Leave edited settings to the user. */
export function undoManagedCompaction(writer: RecordWriter, filter: Partial<Pick<CompactSelection, "checkout" | "agent" | "model" | "scope" | "choice">> = {}) {
  const result = { restored: [] as string[], conflicts: [] as string[] };
  for (const { key, change } of entries(writer)) {
    if ((filter.checkout && change.scope === "repo" && filter.checkout !== change.checkout) ||
      (filter.agent && filter.agent !== change.agent) || (filter.model && filter.model !== change.model) ||
      (filter.scope && filter.scope !== change.scope) || (filter.choice && filter.choice !== change.choice)) continue;
    try {
      if (change.state === "active") {
        restoreCompactSettings(change);
        result.restored.push(change.path);
      }
      writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(scope, key);
    } catch {
      if (change.state === "active") result.conflicts.push(change.path);
    }
  }
  compactWatch(writer);
  return result;
}

export async function reviewManagedCompaction(writer: RecordWriter, mode: LedgerMode = LEDGER_MODE): Promise<void> {
  if (!compactReviewNeeded(writer)) return;
  let failed = false;
  for (const { key, change } of entries(writer)) {
    if (change.state !== "active") continue;
    const reason = healthPause(writer, { ...change, since: change.at });
    if (!reason) continue;
    try {
      await withContainedArtifactLock(writer.location.home, "install", ".install.lock", () => {
        const current = writer.setting(scope, key);
        if (current !== JSON.stringify(change)) return; // off or a newer acceptance won
        const { agent, model, choice, value, checkout } = change;
        if (reason === "ledger" && mode !== "enforce") {
          publishCompactionLedgerNotice(writer.location, agent, change.scope, checkout, change.at, "report-only");
          return;
        }
        restoreCompactSettings(change);
        const next = paused.parse({ agent, model, choice, value, checkout, scope: change.scope,
          reason, at: Date.now(), state: "paused" });
        writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify(next), scope, key);
        compactWatch(writer);
        if (reason === "ledger") publishCompactionLedgerNotice(writer.location, agent, change.scope, checkout, change.at, mode);
        console.log(`MEX paused ${agent} compaction (${reason}) and restored the previous setting.`);
      });
    } catch { failed = true; }
  }
  if (failed) throw new Error("A managed compaction setting could not be restored.");
}
