import type { MachineUninstallPreviewSchema } from "@mex/hub-contracts/machine";
import { basename } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { z } from "zod";
import { recordedCompactChanges } from "../../compaction/control.js";
import { recordedCompactValue } from "../../compaction/settings.js";
import { AGENT_NAMES, installHookCommands } from "../../install/index.js";
import { equalSnapshot, MAX_SETTINGS_BYTES, readSnapshot, snapshotBytes, type Snapshot } from "../../install/files.js";
import { decodeSnapshot, settingsRestorePlan } from "../../install/recovery.js";
import { openRecordReadOnly, type RecordReader } from "../../record/index.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { EXCLUDE_JOURNAL_PREFIX, recordedExcludeBlock } from "../../repo-start/exclude.js";
import { MARKER_JOURNAL_KEY } from "../../repo-start/folder.js";
import { hookChanges, visibleValue } from "./install-diff.js";
import { nativeFiles } from "./machine-files.js";
import { machinePath, machineProjects } from "./machine-projects.js";
import { retainedData } from "./machine-storage.js";

type Preview = z.infer<typeof MachineUninstallPreviewSchema>;
type Change = Preview["changes"][number];
interface JournalRow {
  id: number; agent: string; path: string; key: string; bytes: number;
  oldStart: string | null; newStart: string | null;
}
const JOURNAL_LIMIT = 512;
const JOURNAL_BYTES = 8 << 20;
const MARKER = "Before uninstalling, MEX checks whether the file still matches the install record.";
const CONFLICT = "Uninstall keeps the current file when an installed value has been edited.";
const FILE_OMITTED = "Recorded file (contents omitted)";
const ABSENT = "Not present";

function journalMetadata(reader: RecordReader | undefined): JournalRow[] {
  return reader?.all<JournalRow>(`SELECT id,agent,path,key, coalesce(length(CAST(old_value AS BLOB)),0)+coalesce(length(CAST(new_value AS BLOB)),0) bytes,
    substr(old_value,1,12) oldStart,substr(new_value,1,12) newStart FROM installs
    WHERE key LIKE 'file-v1:%' OR key LIKE ? OR key=? ORDER BY id DESC LIMIT ?`, EXCLUDE_JOURNAL_PREFIX + "%", MARKER_JOURNAL_KEY, JOURNAL_LIMIT + 1) ?? [];
}

function compactRows(reader: RecordReader | undefined): Change[] {
  if (!reader) return [];
  return recordedCompactChanges(reader).map(change => {
    const before = visibleValue(recordedCompactValue(change, snapshotBytes(change.before)), 1024);
    const mexValue = visibleValue(recordedCompactValue(change, snapshotBytes(change.after)), 1024) ?? ABSENT;
    const entry = change.choice === "post-turn" ? "Post-turn compaction" : change.choice === "idle" ? "Idle compaction threshold" : "Compaction window";
    return { id: change.key, group: AGENT_NAMES[change.agent], entry, path: change.path, before, mexValue, restores: before, note: MARKER };
  });
}

function agentGroup(agent: string): string {
  return Object.hasOwn(AGENT_NAMES, agent) ? AGENT_NAMES[agent as keyof typeof AGENT_NAMES]
    : agent === "legacy" ? "Older project hooks" : "MEX runtime";
}

function projectedSettings(
  row: JournalRow, oldValue: string, newValue: string, home: string, current: Map<string, Snapshot | null>,
): Pick<Change, "before" | "mexValue" | "restores" | "note"> {
  const before = decodeSnapshot(oldValue), after = decodeSnapshot(newValue);
  const diff = hookChanges(snapshotBytes(before), snapshotBytes(after), installHookCommands(home, process.platform));
  const value = (side: Record<string, unknown>, snapshot: Snapshot): string | null =>
    Object.values(side).some(v => v !== undefined) ? visibleValue(side, 4096) : snapshot.data === null ? null : "No MEX entries in this change";
  const prior = value(diff.before, before), written = value(diff.after, after) ?? ABSENT;
  try {
    let live = current.get(row.path);
    if (live === undefined) live = readSnapshot(row.path, MAX_SETTINGS_BYTES);
    if (!live) throw new Error("An earlier restore needs review.");
    const restored = settingsRestorePlan(live, before, after);
    current.set(row.path, restored);
    return { before: prior, mexValue: written, restores: prior, note: equalSnapshot(live, after) ? undefined : "Other settings in this file are kept when possible." };
  } catch {
    current.set(row.path, null);
    return { before: prior, mexValue: written, restores: "Current file kept", note: CONFLICT };
  }
}

function omitted(row: JournalRow): Pick<Change, "before" | "mexValue" | "restores" | "note"> {
  const before = row.oldStart === '{"data":null' ? null : FILE_OMITTED;
  const mexValue = row.newStart === '{"data":null' ? ABSENT : FILE_OMITTED;
  return { before, mexValue, restores: before, note: MARKER };
}

export async function takeUninstallSnapshot(options: LocationOptions, signal: AbortSignal) {
  const location = recordLocation({ ...options, create: false });
  const reader = openRecordReadOnly(options);
  let projects, journal;
  let partial = false;
  let valueBudget = 512 << 10;
  let settings, other;
  try {
    if (reader?.diagnostic) throw new Error(reader.diagnostic);
    projects = machineProjects(reader);
    journal = journalMetadata(reader);
    partial = journal.length > JOURNAL_LIMIT || projects.partial;
    const compact = compactRows(reader);
    settings = compact;
    other = [] as Change[];
    const current = new Map<string, Snapshot | null>();
    let budget = JOURNAL_BYTES;
    for (const [index, row] of journal.slice(0, JOURNAL_LIMIT - compact.length).entries()) {
      if (index % 16 === 0) await setImmediate(undefined, { signal });
      if (!machinePath(row.path)) { partial = true; continue; }
      const exclude = row.key.startsWith(EXCLUDE_JOURNAL_PREFIX);
      const marker = row.key === MARKER_JOURNAL_KEY;
      const config = row.key === "file-v1:settings";
      const entry = exclude ? "Git exclude block" : marker ? "Folder marker" : config ? "Hook entries"
        : row.agent === "opencode" ? "Hook plugin" : basename(row.path).slice(0, 512);
      const group = exclude || marker ? "Checkout changes" : agentGroup(row.agent);
      let values = omitted(row);
      if (config || exclude || marker || row.bytes <= 16 << 10) {
        if (row.bytes <= Math.min(budget, 3 << 20) && valueBudget > 0) {
          try {
            const stored = reader!.get<{ old_value: string; new_value: string }>("SELECT old_value,new_value FROM installs WHERE id=? AND key=?", row.id, row.key);
            if (!stored) throw new Error("Install record changed.");
            const { old_value, new_value } = stored;
            budget -= row.bytes;
            if (config) values = projectedSettings(row, old_value, new_value, location.home, current);
            else if (exclude) {
              const before = visibleValue(recordedExcludeBlock(old_value, row.key), 4096);
              values = { before, mexValue: visibleValue(recordedExcludeBlock(new_value, row.key), 4096) ?? ABSENT, restores: before, note: MARKER };
            } else if (marker) {
              values = { before: null, mexValue: visibleValue(new_value, 4096) ?? ABSENT, restores: null, note: MARKER };
            } else {
              const describe = (raw: string) => {
                const bytes = snapshotBytes(decodeSnapshot(raw));
                return bytes ? "File (" + bytes.length + " bytes)" : null;
              };
              const before = describe(old_value);
              values = { before, mexValue: describe(new_value) ?? ABSENT, restores: before, note: MARKER };
            }
            valueBudget -= (values.before?.length ?? 0) + values.mexValue.length + (values.restores?.length ?? 0);
          } catch { partial = true; }
        } else if (config || exclude || marker) partial = true;
      }
      (config || exclude || marker ? settings : other).push({ id: String(row.id), group, path: row.path, entry, ...values });
    }
    if (journal.length + compact.length > JOURNAL_LIMIT) partial = true;
  } finally { reader?.close(); }
  const native = await nativeFiles(location.home, projects.projects, signal);
  const retained = new Map<string, Preview["notRemoved"][number]>();
  for (const { path, retained: kind } of native.files) if (kind) retained.set(path, { path, kind });
  const data = await retainedData(location, signal);
  const preview: Preview = { ...data, changes: [...settings, ...other], notRemoved: [...retained.values()].slice(0, 512),
    partial: data.partial || partial || native.partial || retained.size > 512 };
  return { preview };
}
