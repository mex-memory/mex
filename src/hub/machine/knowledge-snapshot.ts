import { lstatSync, opendirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { ENTRY_KINDS, EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, parseEntry, type EntryKind } from "../../knowledge/entry.js";
import { containedDirectory, personalReadGuard, readEntryRevision } from "../../knowledge/files.js";
import { assertNoSecrets, stripHidden } from "../../knowledge/gates.js";
import { localHintReader } from "../../knowledge/hints.js";
import { openHooksReadOnly, openRecordReadOnly, recordLocation, type RecordReader } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { absolutePath, realPath } from "../../record/project.js";
import { registeredProjectIds } from "./home-metrics.js";
import { activeCheckouts, checkoutCollation, knowledgeStatus, mostRecentCheckout } from "./home-snapshot.js";
import { knowledgeRanking, useKey, useWindow, USAGE_UNAVAILABLE, type UseWindow } from "./knowledge-usage.js";
import { knowledgeKey, readStore } from "./read.js";

export const PROJECT_ID = /^[gf]-[a-f0-9]{24}$/u;
export const RETIRED_PREFIX = "knowledge.retired.";
// Two generations, Home's snapshot and request work all share the Hub worker heap.
const METADATA_BYTES = 16 << 20;
const SCAN_NOTE = "Some items are missing because this repo reached the reading limit.";
const READ_NOTE = "Some items in this repo couldn’t be read.";

export type Audience = "onlyYou" | "team" | "hint";
export type Status = ReturnType<typeof knowledgeStatus>;
export interface KnowledgeRow {
  key: string;
  id: string;
  repoId: string;
  audience: Audience;
  kind: EntryKind;
  oneLine: string;
  scope: string[];
  revision: string;
  checkout?: string;
  status: Status;
  checkedAt?: string;
  search: string;
  lastUsedAt: string | null;
}

export interface RetiredRow { id: string; repoId: string; audience: Audience; at: string }
interface ProjectKnowledge {
  rows: Map<string, KnowledgeRow>;
  retired: RetiredRow[];
  partial?: string;
  watch: string[];
  bytes: number;
}

export interface KnowledgeSnapshot {
  generatedAt: string;
  projects: Map<string, ProjectKnowledge>;
  partial?: string;
  usage?: UseWindow;
  usagePartial?: string;
}

export const searchText = (text: string) => text.normalize("NFKC").toLowerCase();
export { knowledgeKey } from "./read.js";
export const midnight = (day: string) => `${day}T00:00:00.000Z`;

export function registeredCheckout(reader: RecordReader, repoId: string, path: string): boolean {
  try {
    return reader.get<{ path: string }>("SELECT path FROM checkouts WHERE project_id=? AND path=?", repoId, path) !== undefined
      && !!lstatSync(path, { throwIfNoEntry: false })?.isDirectory() && absolutePath(path) === realPath(path);
  } catch { return false; }
}

export function representativeCheckout(reader: RecordReader, hooks: RecordReader | undefined, repoId: string, now: number) {
  return mostRecentCheckout(hooks, repoId, activeCheckouts(reader, repoId, now).filter((path) => registeredCheckout(reader, repoId, path)));
}

export function isRetired(reader: RecordReader, repoId: string, id: string): boolean {
  return reader.get("SELECT 1 FROM settings WHERE scope=? AND key=?", repoId, RETIRED_PREFIX + id) !== undefined;
}

async function projectKnowledge(
  reader: RecordReader, hooks: RecordReader | undefined, location: LocationOptions, home: string,
  repoId: string, now: number, available: number, env: NodeJS.ProcessEnv | undefined, signal: AbortSignal,
): Promise<ProjectKnowledge> {
  const checkout = representativeCheckout(reader, hooks, repoId, now);
  const rows = new Map<string, KnowledgeRow>();
  const retired = new Map<string, RetiredRow>();
  const watch: string[] = [];
  const teamIds = new Set<string>();
  let bytes = 0, seen = 0, consumed = 0, partial: string | undefined;

  const hints = checkout && localHintReader(reader, repoId, { ...location, projectPath: checkout, env }, now);
  const add = async (parts: string[], base: string, audience: Audience) => {
    try {
      const directory = containedDirectory(base, parts);
      if (!directory) {
        const parent = containedDirectory(base, parts.slice(0, -1));
        if (parent) watch.push(parent);
        return;
      }
      const verifyNotes = personalReadGuard(directory);
      await scan(directory, audience, audience === "team");
      verifyNotes();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      // A rotating notes directory is handled by the last-good snapshot.
      if (error instanceof KnowledgeError && ["STORE_BUSY", "STORE_CHANGED"].includes(error.code)) throw error;
      if (error instanceof KnowledgeError && error.code === "STORE_LIMIT") partial = SCAN_NOTE;
      else partial ??= READ_NOTE;
    }
  };

  async function scan(directory: string, audience: Audience, nested: boolean): Promise<void> {
    watch.push(directory);
    const identity = lstatSync(directory, { bigint: true });
    const handle = opendirSync(directory);
    try {
      let child: Dirent | null;
      while ((child = handle.readSync())) {
        if (++seen > KNOWLEDGE_LIMITS.entries || consumed >= available || bytes >= KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("STORE_LIMIT", SCAN_NOTE);
        if (seen % 128 === 0) {
          await setImmediate(undefined, { signal });
          const current = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
          if (current?.ino !== identity.ino || current.dev !== identity.dev || realPath(directory) !== absolutePath(directory)) {
            throw new KnowledgeError("STORE_CHANGED", "Knowledge storage changed while being read.");
          }
        }
        if (child.isSymbolicLink()) { partial ??= READ_NOTE; continue; }
        const name = child.name;
        if (nested && child.isDirectory() && ENTRY_KINDS.some((kind) => kind === name)) {
          const inner = containedDirectory(directory, [child.name]);
          if (inner) await scan(inner, audience, false);
          continue;
        }
        if (!child.isFile() || !child.name.endsWith(".md")) continue;
        const id = child.name.slice(0, -3);
        if (!EntryIdSchema.safeParse(id).success) continue;
        const key = knowledgeKey(repoId, audience, id);
        if (audience === "team" && teamIds.has(id)) {
          rows.delete(key);
          retired.delete(key);
          partial ??= READ_NOTE;
          continue;
        }
        if (audience === "team") teamIds.add(id);
        try {
          const path = join(directory, name);
          const stat = lstatSync(path, { throwIfNoEntry: false });
          if (!stat) continue;
          const remaining = KNOWLEDGE_LIMITS.scanBytes - bytes;
          if (stat.size > KNOWLEDGE_LIMITS.entryBytes) { partial ??= READ_NOTE; continue; }
          if (stat.size > remaining) throw new KnowledgeError("STORE_LIMIT", SCAN_NOTE);
          bytes += stat.size;
          const found = readEntryRevision(path, Math.min(remaining, KNOWLEDGE_LIMITS.entryBytes));
          if (!found) continue;
          bytes += Math.max(0, found.size - stat.size);
          let entry = parseEntry(found.content);
          if (entry.mex.id !== id) { partial ??= READ_NOTE; continue; }
          if (entry.mex.status === "retired") {
            if (audience === "team" || (audience === "onlyYou" && !isRetired(reader, repoId, id))) {
              if (consumed + 256 > available) throw new KnowledgeError("STORE_LIMIT", SCAN_NOTE);
              retired.set(key, { id, repoId, audience, at: midnight(entry.mex.retired!.at) });
              consumed += 256;
            }
            continue;
          }
          if (isRetired(reader, repoId, id)) continue;
          if (audience === "hint") {
            const hint = hints && hints(entry);
            if (!hint) continue;
            entry = hint.entry;
          } else assertNoSecrets(entry);
          const oneLine = stripHidden(entry.mex.one_line);
          const search = searchText(`${oneLine} ${stripHidden(entry.text.slice(0, 500))}`).slice(0, 2_048);
          const scope = entry.mex.scope;
          const cost = 512 + 2 * (oneLine.length + search.length) + scope.reduce((sum, glob) => sum + 24 + 2 * glob.length, 0);
          if (consumed + cost > available) throw new KnowledgeError("STORE_LIMIT", SCAN_NOTE);
          consumed += cost;
          rows.set(key, { key, id, repoId, audience, kind: entry.mex.kind, oneLine, scope, revision: found.revision,
            ...(audience === "team" ? { checkout } : {}), status: "notChecked", search, lastUsedAt: null });
        } catch (error) {
          if (error instanceof KnowledgeError && ["STORE_LIMIT", "STORE_BUSY", "STORE_CHANGED"].includes(error.code)) throw error;
          partial ??= READ_NOTE;
        }
      }
    } finally { handle.closeSync(); }
  }

  await add(["projects", repoId, "notes"], home, "onlyYou");
  if (checkout) {
    await add([".mex", "learned"], checkout, "team");
    await add(["projects", repoId, "hints"], home, "hint");
  }
  if (checkout && hooks && rows.size) {
    try {
      const ids = [...new Set([...rows.values()].map(({ id }) => id))];
      const saved = hooks.all<{ entry_id: string; verdict: string; checked_at: string }>(`SELECT entry_id,verdict,checked_at
        FROM verdicts WHERE project_id=? AND checkout=? ${checkoutCollation} AND entry_id IN (SELECT value FROM json_each(?)) LIMIT ?`,
      repoId, checkout, JSON.stringify(ids), KNOWLEDGE_LIMITS.entries);
      const verdicts = new Map(saved.map((value) => [value.entry_id, value]));
      for (const row of rows.values()) {
        const verdict = verdicts.get(row.id);
        row.status = knowledgeStatus(verdict?.verdict);
        row.checkedAt = verdict?.checked_at;
      }
    } catch { partial ??= "Recent checks couldn’t be read."; }
  }
  return { rows, retired: [...retired.values()], watch, partial, bytes: consumed };
}

export async function takeKnowledgeSnapshot(
  location: LocationOptions, previous: KnowledgeSnapshot | undefined, now: () => number,
  signal: AbortSignal, env?: NodeJS.ProcessEnv, only?: ReadonlySet<string>,
): Promise<KnowledgeSnapshot> {
  await setImmediate(undefined, { signal });
  const { home } = recordLocation({ ...location, create: false });
  const projects = only ? new Map(previous?.projects) : new Map<string, ProjectKnowledge>();
  const ids = only ?? readStore(openRecordReadOnly, location, registeredProjectIds);
  let used = [...projects.values()].reduce((sum, project) => sum + project.bytes, 0);
  for (const id of ids) {
    await setImmediate(undefined, { signal });
    if (!PROJECT_ID.test(id)) continue;
    used -= projects.get(id)?.bytes ?? 0;
    projects.delete(id);
    let project: ProjectKnowledge | undefined;
    let reader: RecordReader | undefined;
    let hooks: RecordReader | undefined;
    try {
      reader = openRecordReadOnly(location);
      if (reader?.diagnostic) throw new Error(reader.diagnostic);
      if (reader?.project(id)) {
        try { hooks = openHooksReadOnly(location); } catch { /* Knowledge files are still readable. */ }
        project = await projectKnowledge(reader, hooks?.diagnostic ? undefined : hooks, location, home,
          id, now(), METADATA_BYTES - used, env, signal);
      }
    } catch {
      if (signal.aborted) throw signal.reason;
      const prior = previous?.projects.get(id);
      if (prior && prior.bytes <= METADATA_BYTES - used) project = { ...prior, partial: READ_NOTE };
      else project = { rows: new Map(), retired: [], watch: [], partial: READ_NOTE, bytes: 0 };
    } finally {
      hooks?.close();
      reader?.close();
    }
    if (project) {
      used += project.bytes;
      projects.set(id, project);
    }
  }
  let usage = previous?.usage;
  let usagePartial = previous?.usagePartial;
  try {
    if (!only || !usage) usage = readStore(openHooksReadOnly, location, (hooks) => useWindow(hooks, now()));
    const ranking = knowledgeRanking(location, usage);
    usagePartial = ranking.partial;
    for (const id of ids) {
      const project = projects.get(id);
      if (!project || project.rows === previous?.projects.get(id)?.rows) continue;
      for (const row of project.rows.values()) row.lastUsedAt = ranking.items.get(useKey(row))?.lastUsedAt ?? null;
    }
  } catch { usagePartial = USAGE_UNAVAILABLE; }
  return { generatedAt: new Date(now()).toISOString(), projects, usage, usagePartial };
}
