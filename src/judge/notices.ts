import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { containedDirectory, readBoundedTextFile } from "../knowledge/files.js";
import { KnowledgeError } from "../knowledge/entry.js";
import { openHooksReadOnly, type RecordWriter } from "../record/index.js";

const IDs = z.array(z.string().regex(/^(?:judge\.fix|learning\.team)\.[a-f0-9]{24}\.(preview|updated)$/u)).max(16);

/** An explicit bounded list makes ordinary hooks one stat, with no DB scan. */
export function wakeNotice(writer: RecordWriter, actor: string, id: string): void {
  if (!/^[a-f0-9]{24}$/u.test(actor) || !IDs.safeParse([id]).success) throw new KnowledgeError("UNSAFE_STORE", "Invalid notice identity.");
  const directory = containedDirectory(writer.location.directory, ["judge-notices"], true)!;
  const path = join(directory, `${actor}.json`);
  let ids: string[] = [];
  try { ids = IDs.parse(JSON.parse(readBoundedTextFile(path, 4096) ?? "[]")); } catch { /* replace invalid hints, never canonical data */ }
  ids = ids.filter(id => { const kind = id.startsWith("learning.") ? "learning" : "judge";
    return writer.db.prepare("SELECT 1 FROM notices WHERE id=? AND kind IN (?,?)").get(id, `${kind}-preview.${actor}`, `${kind}-updated.${actor}`); });
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (hooks && !hooks.diagnostic) ids = ids.filter(id => !hooks.get("SELECT 1 FROM notices_shown WHERE notice_id=?", id));
  } finally { hooks?.close(); }
  if (!ids.includes(id)) {
    // Preview receipts are required for publication; old status lines must not
    // occupy every hint slot and silently prevent a new preview from arriving.
    if (ids.length === 16 && id.endsWith(".preview")) {
      const status = ids.findIndex(id => id.endsWith(".updated"));
      if (status >= 0) ids.splice(status, 1);
    }
    if (ids.length < 16) ids.push(id);
  }
  const temporary = join(directory, `.notice-${randomUUID()}`);
  try { writeFileSync(temporary, JSON.stringify(ids), { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch { /* already published */ } }
}
