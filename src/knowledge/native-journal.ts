import { isAbsolute } from "node:path";
import { z } from "zod";
import { equalSnapshot, readSnapshot, replaceFile, snapshotBytes, type Snapshot } from "../install/files.js";
import type { RecordReader, RecordWriter } from "../record/index.js";

const PREFIX = "native-v1:";
const MAX_ROWS = 16_384;
const LIMIT = 1024 * 1024;
const snapshot = z.object({ mode: z.number().int().min(0).max(0o777), data: z.string().max(2 * LIMIT).nullable() });
const kindSchema = z.enum(["file", "exclude"]);
type Kind = z.infer<typeof kindSchema>;
type Row = { id: number; path: string; key: string; old_value: string; new_value: string };

export const EXCLUDE_START = "# mex: local rule files (generated, personal)";
export const EXCLUDE_END = "# mex: end";
const excludePattern = /^# mex: local rule files \(generated, personal\)\r?\n[\s\S]*?^# mex: end(?:\r?\n|$)/mu;
export function nativeExcludeBlock(text: string): RegExpExecArray | null {
  return excludePattern.exec(text);
}

export function journalOwnsNativeFile(writer: RecordWriter | undefined, file: string, text: string): boolean {
  const row = writer?.db.prepare("SELECT new_value FROM installs WHERE path=? AND key=? ORDER BY id DESC LIMIT 1")
    .get(file, PREFIX + "file");
  if (typeof row?.new_value !== "string") return false;
  try {
    const written = snapshot.parse(JSON.parse(row.new_value));
    return written.data === Buffer.from(text).toString("base64");
  } catch { return false; }
}

/** Each intent commits before the write. The next lock prevents uninstall undoing a pending write. */
export function changeNativeFile(writer: RecordWriter | undefined, file: string, expected: Snapshot, after: Snapshot, kind: Kind = "file"): void {
  if (equalSnapshot(expected, after)) return;
  if (!writer) { replaceFile(file, expected, after); return; }
  const db = writer.db;
  db.exec("BEGIN IMMEDIATE");
  let id: number | bigint;
  try {
    const count = db.prepare("SELECT count(*) n FROM installs WHERE key LIKE ?").get(PREFIX + "%")!;
    if (Number(count.n) >= MAX_ROWS) throw new Error("The rule-file journal is full. Run mex uninstall before continuing.");
    id = db.prepare("INSERT INTO installs(agent,path,key,old_value,new_value,ts) VALUES(?,?,?,?,?,?)")
      .run("mex", file, PREFIX + kind, JSON.stringify(expected), JSON.stringify(after), new Date().toISOString()).lastInsertRowid;
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT key FROM installs WHERE id=?").get(id);
    if (current?.key !== PREFIX + kind) throw new Error("MEX was uninstalled during the rule-file update.");
    try { replaceFile(file, expected, after); }
    catch (error) {
      db.prepare("UPDATE installs SET key=? WHERE id=?").run("cancelled:" + PREFIX + kind, id);
      throw error;
    }
  } finally { db.exec("COMMIT"); }
}

export function nativeUninstallPaths(reader: RecordReader): string[] {
  return reader.all<{ path: string }>("SELECT DISTINCT path FROM installs WHERE key LIKE ? ORDER BY path LIMIT ?", PREFIX + "%", MAX_ROWS)
    .map(row => row.path);
}

function undoExclude(current: Snapshot, before: Snapshot, after: Snapshot): Snapshot | undefined {
  if (current.data === null) return current;
  const now = snapshotBytes(current)?.toString("latin1") ?? "";
  const oldBlock = nativeExcludeBlock(snapshotBytes(before)?.toString("latin1") ?? "");
  const newBlock = nativeExcludeBlock(snapshotBytes(after)?.toString("latin1") ?? "");
  const found = nativeExcludeBlock(now);
  if (!found && newBlock) return current;
  if (found?.[0].replace(/\r\n/gu, "\n") !== newBlock?.[0].replace(/\r\n/gu, "\n")) return undefined;
  const offset = found?.index ?? now.length;
  const text = now.slice(0, offset) + (oldBlock?.[0] ?? "") + now.slice(offset + (found?.[0].length ?? 0));
  return { data: Buffer.from(text, "latin1").toString("base64"), mode: current.mode };
}

export function restoreNativeFiles(writer: RecordWriter): { restored: string[]; conflicts: string[] } {
  const restored = new Set<string>(), conflicts = new Set<string>();
  const absent = new Set<string>();
  const db = writer.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT id,path,key,old_value,new_value FROM installs WHERE key LIKE ? ORDER BY id DESC LIMIT ?")
      .all(PREFIX + "%", MAX_ROWS + 1) as Row[];
    if (rows.length > MAX_ROWS) throw new Error("The rule-file journal exceeds its bound.");
    for (const row of rows) {
      if (conflicts.has(row.path)) continue;
      try {
        const kind = kindSchema.parse(row.key.slice(PREFIX.length));
        const portable = row.path.replace(/\\/gu, "/");
        if (!isAbsolute(row.path) || portable.split("/").includes("..") || !(kind === "exclude" ? /\/info\/exclude$/u.test(portable)
          : /(?:\/(?:AGENTS\.md|native-local\.json)|\/\.mex\/native\.json|\/\.claude\/rules\/mex[\w-]*\.md|\/\.github\/instructions\/mex[\w-]*\.instructions\.md)$/u.test(portable))) {
          throw new Error("An unsafe rule-file journal path was kept.");
        }
        const before = snapshot.parse(JSON.parse(row.old_value));
        const after = snapshot.parse(JSON.parse(row.new_value));
        const now = readSnapshot(row.path, LIMIT);
        if (now.data === null && after.data !== null) absent.add(row.path);
        if (!absent.has(row.path) && !equalSnapshot(now, before)) {
          const desired = equalSnapshot(now, after) ? before : kind === "exclude" ? undoExclude(now, before, after) : undefined;
          if (!desired) throw new Error("A generated rule file was edited.");
          if (!equalSnapshot(now, desired)) replaceFile(row.path, now, desired);
        }
        db.prepare("UPDATE installs SET key=? WHERE id=?").run("restored:" + row.key, row.id);
        restored.add(row.path);
      } catch { conflicts.add(row.path); }
    }
    db.prepare("DELETE FROM settings WHERE key IN ('native.defaults.v1', 'native.codex-fallback.v1') AND scope LIKE 'checkout:%'").run();
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { restored: [...restored], conflicts: [...conflicts] };
}
