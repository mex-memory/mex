import type { MachineHome } from "@mex/hub-contracts/machine";
import { setImmediate } from "node:timers/promises";
import { KNOWLEDGE_LIMITS, type KnowledgeEntry } from "../../knowledge/entry.js";
import { containedDirectory } from "../../knowledge/files.js";
import { entryInventory } from "../../knowledge/inventory.js";
import { retiredIds } from "../../knowledge/state.js";
import { openHooksReadOnly, openRecordReadOnly, recordLocation, type RecordReader } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { registeredProjectIds } from "./home-metrics.js";
import { activeCheckouts, checkoutCollation, knowledgeStatus, mostRecentCheckout, readStore } from "./read.js";
import { compareReview, emptyReview, projectReview, REVIEW_BYTES, REVIEW_PROJECT_BYTES, REVIEW_READ_NOTE, type ProjectReview, type ReviewPoint } from "./review-snapshot.js";

export const NEEDS_LIMIT = 20;


type NeedsCount = MachineHome["needsCount"][string];
type Knowledge = MachineHome["knowledge"][string];
type StatusCounts = Omit<Knowledge, "total" | "onlyYou" | "team" | "updatingSince" | "byKind">;
type Kind = keyof Knowledge["byKind"];
type ScopedEntry = { id: string; kind: Kind; level: "onlyYou" | "team" };
interface ProjectSnapshot {
  review: ProjectReview;
  knowledge?: Knowledge;
}

export interface HomeSnapshot {
  generatedAt: string;
  review: { cards: ReviewPoint[]; partial?: string };
  projects: Map<string, ProjectSnapshot>;
}

function emptyCounts(): StatusCounts {
  return { upToDate: 0, codeChanged: 0, outOfDate: 0, notChecked: 0 };
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

/** Project failures retain that project's last sample. Only small aggregates survive each iteration. */
export async function takeHomeSnapshot(
  location: LocationOptions, previous: HomeSnapshot | undefined, now: () => number, signal: AbortSignal, only?: string,
): Promise<HomeSnapshot> {
  await setImmediate(undefined, { signal });
  const start = now();
  const { home } = recordLocation({ ...location, create: false });
  const projects = only ? new Map(previous?.projects) : new Map<string, ProjectSnapshot>();
  let ids: string[];
  let partial: string | undefined;
  try {
    ids = readStore(openRecordReadOnly, location, (reader) => only ? (reader?.project(only) ? [only] : []) : registeredProjectIds(reader));
  } catch {
    return {
      generatedAt: previous?.generatedAt ?? new Date(start).toISOString(),
      review: { cards: previous?.review.cards ?? [], partial: REVIEW_READ_NOTE },
      projects: previous?.projects ?? projects,
    };
  }
  if (only) projects.delete(only);
  let available = REVIEW_BYTES;
  for (const { review } of projects.values()) available -= review.bytes;
  for (const id of ids) {
    await setImmediate(undefined, { signal });
    const prior = previous?.projects.get(id);
    const budget = Math.min(available, REVIEW_PROJECT_BYTES);
    let reader: RecordReader | undefined;
    let hooks: RecordReader | undefined;
    let review: ProjectReview;
    let knowledge = prior?.knowledge;
    try {
      reader = openRecordReadOnly(location);
      if (!reader || reader.diagnostic) throw new Error("Home record unavailable");
      const paths = activeCheckouts(reader, id, start);
      try { hooks = openHooksReadOnly(location); } catch { /* Keep Review available when hooks cannot be read. */ }
      const usableHooks = hooks?.diagnostic ? undefined : hooks;
      try { knowledge = readKnowledge(reader, usableHooks, id, home, mostRecentCheckout(usableHooks, id, paths)); }
      catch { /* Keep the last good Knowledge counts. */ }
      review = await projectReview(reader, usableHooks, id, home, paths, start, budget, signal, prior?.review);
    } catch {
      if (signal.aborted) throw signal.reason;
      review = prior && prior.review.bytes <= budget ? { ...prior.review, partial: REVIEW_READ_NOTE } : emptyReview(REVIEW_READ_NOTE);
    } finally { hooks?.close(); reader?.close(); }
    available -= review.bytes;
    projects.set(id, { review, knowledge });
  }
  if (only) partial = previous?.review.partial;
  const cards = [...projects.values()].flatMap(({ review }) => [...review.cards.values()]).sort(compareReview);
  return { generatedAt: new Date(now()).toISOString(), review: { cards, partial }, projects };
}

export function snapshotFields(snapshot: HomeSnapshot | undefined, updatingSince: string | undefined, byRepo: MachineHome["byRepo"]) {
  const needsCount: Record<string, NeedsCount> = Object.create(null);
  const knowledge: Record<string, Knowledge> = Object.create(null);
  for (const [id, project] of snapshot?.projects ?? []) {
    if (!Object.hasOwn(byRepo, id)) continue;
    if (project.review.oldest) needsCount[id] = { count: project.review.cards.size, oldest: project.review.oldest };
    if (project.knowledge) knowledge[id] = updatingSince ? { ...project.knowledge, updatingSince } : project.knowledge;
  }
  const needs = (snapshot?.review.cards ?? []).filter(({ row }) => Object.hasOwn(byRepo, row.repoId)).slice(0, NEEDS_LIMIT)
    .map(({ row }) => ({ id: row.cardId, repoId: row.repoId, rule: row.claim, waitingSince: row.createdAt }));
  return { needs, needsCount, knowledge };
}
