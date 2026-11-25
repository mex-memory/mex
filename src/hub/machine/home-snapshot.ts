import type { MachineHome } from "@mex/hub-contracts/machine";
import { lstatSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { KNOWLEDGE_LIMITS, type KnowledgeEntry } from "../../knowledge/entry.js";
import { containedDirectory } from "../../knowledge/files.js";
import { entryInventory } from "../../knowledge/inventory.js";
import { retiredIds } from "../../knowledge/state.js";
import { openHooksReadOnly, openRecordReadOnly, recordLocation, type RecordReader } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { snapshotReview } from "../../review/queue.js";
import { registeredProjectIds } from "./home-metrics.js";
import { readStore } from "./read.js";

export const NEEDS_LIMIT = 20;
const CHECKOUT_LIMIT = 128;
const REVIEW_PREVIEW_LENGTH = KNOWLEDGE_LIMITS.oneLineCharacters;
const reviewLimits = { retainedBytes: 8 << 20, vocabularyBytes: 48 << 20 };
export const checkoutCollation = process.platform === "win32" ? "COLLATE NOCASE" : "";

type Need = MachineHome["needs"][number] & { contradiction: boolean };
type NeedsCount = MachineHome["needsCount"][string];
type Knowledge = MachineHome["knowledge"][string];
type StatusCounts = Omit<Knowledge, "total" | "onlyYou" | "team" | "updatingSince" | "byKind">;
type Kind = keyof Knowledge["byKind"];
type ScopedEntry = { id: string; kind: Kind; level: "onlyYou" | "team" };
const knowledgeStatuses = { held: "upToDate", changed: "codeChanged", broken: "outOfDate", unknown: "notChecked" } as const;
export function knowledgeStatus(verdict: string | undefined) {
  return Object.hasOwn(knowledgeStatuses, verdict ?? "") ? knowledgeStatuses[verdict as keyof typeof knowledgeStatuses] : "notChecked";
}

interface ProjectSnapshot {
  needs: Need[];
  needsCount?: NeedsCount;
  knowledge: Knowledge;
}

export interface HomeSnapshot {
  generatedAt: string;
  needs: Need[];
  projects: Map<string, ProjectSnapshot>;
}

function compareNeeds(a: Need, b: Need): number {
  return Number(b.contradiction) - Number(a.contradiction) || a.waitingSince.localeCompare(b.waitingSince)
    || a.id.localeCompare(b.id) || a.repoId.localeCompare(b.repoId);
}

function emptyCounts(): StatusCounts {
  return { upToDate: 0, codeChanged: 0, outOfDate: 0, notChecked: 0 };
}

export function activeCheckouts(reader: RecordReader, project: string, now: number): string[] {
  const rows = reader.all<{ path: string }>(`SELECT path FROM checkouts WHERE project_id=?
    AND (state='on' OR (state='off until' AND off_until<=?)) ORDER BY path LIMIT ?`, project, new Date(now).toISOString(), CHECKOUT_LIMIT + 1);
  if (rows.length > CHECKOUT_LIMIT) throw new Error("Home checkout scan limit exceeded");
  return rows.map(({ path }) => path).filter((path) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory());
}

export function mostRecentCheckout(hooks: RecordReader | undefined, project: string, paths: string[]) {
  if (paths.length < 2) return paths[0];
  const last = hooks?.get<{ checkout: string }>(`SELECT checkout FROM sessions WHERE project_id=?
    AND checkout ${checkoutCollation} IN (SELECT value FROM json_each(?))
    ORDER BY last_seen_at DESC,session_id DESC LIMIT 1`, project, JSON.stringify(paths));
  return paths.find((path) => checkoutCollation ? path.toLowerCase() === last?.checkout.toLowerCase() : path === last?.checkout) ?? paths[0];
}

function readKnowledge(reader: RecordReader, hooks: RecordReader | undefined, project: string, home: string, checkout: string | undefined): Knowledge {
  const scan = entryInventory(retiredIds(reader, project));
  const entries: ScopedEntry[] = [];
  const collect = (level: ScopedEntry["level"]) => ({ mex: { id, kind } }: KnowledgeEntry) => {
    if (kind !== "hint") entries.push({ id, kind, level });
  };
  scan(containedDirectory(home, ["projects", project, "notes"]), 0, collect("onlyYou"));
  if (checkout) scan(containedDirectory(checkout, [".mex", "learned"]), 1, collect("team"));

  const ids = new Set(entries.map(({ id }) => id));
  const verdictRows = hooks && checkout && ids.size ? hooks.all<{ entry_id: string; verdict: string }>(`SELECT entry_id,verdict FROM verdicts
    WHERE project_id=? AND checkout=? ${checkoutCollation} AND entry_id IN (SELECT value FROM json_each(?)) LIMIT ?`,
    project, checkout, JSON.stringify([...ids]), KNOWLEDGE_LIMITS.entries + 1) : [];
  if (verdictRows.length > KNOWLEDGE_LIMITS.entries) throw new Error("Home verdict scan limit exceeded");
  const verdicts = new Map(verdictRows.map(({ entry_id, verdict }) => [entry_id, verdict]));
  const knowledge: Knowledge = { ...emptyCounts(), total: entries.length, onlyYou: 0, team: 0, byKind: {} };
  for (const { id, kind, level } of entries) {
    const field = knowledgeStatus(verdicts.get(id));
    knowledge[level]++;
    knowledge[field]++;
    (knowledge.byKind[kind] ??= emptyCounts())[field]++;
  }
  return knowledge;
}

async function projectSnapshot(location: LocationOptions, reader: RecordReader, project: string, home: string, now: number, signal: AbortSignal): Promise<ProjectSnapshot> {
  const paths = activeCheckouts(reader, project, now);
  const knowledge = readStore(openHooksReadOnly, location, (hooks) => (
    readKnowledge(reader, hooks, project, home, mostRecentCheckout(hooks, project, paths))
  ));
  const seen = new Map<string, Need>();
  let oldest: string | undefined;
  for (const path of paths) {
    await setImmediate(undefined, { signal });
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const card of snapshotReview(reader, project, home, path, now, reviewLimits)) {
      const waitingSince = new Date(card.createdAt).toISOString();
      const need: Need = {
        id: card.id, repoId: project, waitingSince, contradiction: card.reason === "contradiction",
        rule: (card.entry.mex.one_line || card.entry.text.split(/\r?\n/u, 1)[0]).slice(0, REVIEW_PREVIEW_LENGTH),
      };
      const previous = seen.get(need.id);
      if (!previous || compareNeeds(need, previous) < 0) seen.set(need.id, need);
      if (!oldest || waitingSince < oldest) oldest = waitingSince;
      if (seen.size > KNOWLEDGE_LIMITS.entries) throw new Error("Home Review scan limit exceeded");
    }
  }
  return {
    knowledge,
    needsCount: oldest ? { count: seen.size, oldest } : undefined,
    needs: [...seen.values()].sort(compareNeeds).slice(0, NEEDS_LIMIT),
  };
}

/** Project failures retain that project's last sample. Only small aggregates survive each iteration. */
export async function takeHomeSnapshot(location: LocationOptions, previous: HomeSnapshot | undefined, now: () => number, signal: AbortSignal): Promise<HomeSnapshot> {
  await setImmediate(undefined, { signal });
  const start = now();
  const { home } = recordLocation({ ...location, create: false });
  const projects = new Map<string, ProjectSnapshot>();
  const ids = readStore(openRecordReadOnly, location, registeredProjectIds);
  for (const id of ids) {
    await setImmediate(undefined, { signal });
    let reader: RecordReader | undefined;
    try {
      reader = openRecordReadOnly(location);
      if (!reader || reader.diagnostic) throw new Error("Home record unavailable");
      projects.set(id, await projectSnapshot(location, reader, id, home, start, signal));
    } catch {
      if (signal.aborted) throw signal.reason;
      const prior = previous?.projects.get(id);
      if (prior) projects.set(id, prior);
    } finally { reader?.close(); }
  }
  let needs: Need[] = [];
  for (const project of projects.values()) needs = [...needs, ...project.needs].sort(compareNeeds).slice(0, NEEDS_LIMIT);
  return { generatedAt: new Date(now()).toISOString(), needs, projects };
}

export function snapshotFields(snapshot: HomeSnapshot | undefined, updatingSince: string | undefined, byRepo: MachineHome["byRepo"]) {
  const needsCount: Record<string, NeedsCount> = Object.create(null);
  const knowledge: Record<string, Knowledge> = Object.create(null);
  for (const [id, project] of snapshot?.projects ?? []) {
    if (!Object.hasOwn(byRepo, id)) continue;
    if (project.needsCount) needsCount[id] = project.needsCount;
    knowledge[id] = updatingSince ? { ...project.knowledge, updatingSince } : project.knowledge;
  }
  return {
    needs: (snapshot?.needs ?? []).filter(({ repoId }) => Object.hasOwn(byRepo, repoId)).map(({ contradiction: _contradiction, ...need }) => need),
    needsCount, knowledge,
  };
}
