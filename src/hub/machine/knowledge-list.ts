import { createHash } from "node:crypto";
import {
  MachineKnowledgeAudienceSchema, MachineKnowledgeKindSchema, MachineKnowledgeStatusSchema,
  type MachineKnowledgeItemSchema, type MachineKnowledgePageSchema,
} from "@mex/hub-contracts/machine";
import { z } from "zod";
import { EntryIdSchema, KNOWLEDGE_LIMITS } from "../../knowledge/entry.js";
import { openRecordReadOnly } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import type { KnowledgeData } from "./knowledge.js";
import { PROJECT_ID, searchText, type Audience, type KnowledgeRow, type KnowledgeSnapshot } from "./knowledge-snapshot.js";
import { knowledgePageUsage, useKey } from "./knowledge-usage.js";
import { readStore } from "./read.js";
import { HubRequestError } from "./security.js";

const querySchema = z.object({
  repo: z.string().regex(PROJECT_ID).optional(),
  q: z.string().trim().max(KNOWLEDGE_LIMITS.queryCharacters).default(""),
  kind: MachineKnowledgeKindSchema.optional(),
  audience: MachineKnowledgeAudienceSchema.optional(),
  status: z.union([MachineKnowledgeStatusSchema, z.literal("needs-look")]).optional(),
  area: z.string().min(1).max(512).optional(),
  cursor: z.string().min(1).max(384).optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/u).transform(Number).pipe(z.number().max(100)).optional(),
});
const cursorSchema = z.object({
  generation: z.string(),
  filter: z.string(),
  after: z.string().min(1).max(120),
}).strict();
type Item = z.infer<typeof MachineKnowledgeItemSchema>;

export function badKnowledgeRequest(detail: string) {
  return new HubRequestError(400, "INVALID_REQUEST", "Invalid Knowledge request", detail);
}

export function knowledgeMissing(detail = "That item may have been forgotten or moved.") {
  return new HubRequestError(404, "INVALID_REQUEST", "Knowledge item unavailable", detail);
}

export const knowledgeChanged = () => new HubRequestError(409, "KNOWLEDGE_CHANGED", "Knowledge changed", "Start again at the first page.");

export const repoMissing = () => new HubRequestError(404, "INVALID_REQUEST", "Repo not found", "Choose a repo registered with MEX.");

export function ensureRepo(location: LocationOptions, repoId: string | undefined) {
  if (repoId === undefined) return;
  if (!PROJECT_ID.test(repoId)) throw badKnowledgeRequest("Choose a registered repo.");
  if (!readStore(openRecordReadOnly, location, (reader) => reader?.project(repoId))) {
    throw repoMissing();
  }
}

export function parseKnowledgeKey(key: string): { repoId: string; audience: Audience; id: string } {
  const [repoId, audience, id, ...rest] = key.split(":");
  if (rest.length || !PROJECT_ID.test(repoId) || !MachineKnowledgeAudienceSchema.safeParse(audience).success || !EntryIdSchema.safeParse(id).success) {
    throw badKnowledgeRequest("Choose an item with a valid ID.");
  }
  return { repoId, audience: audience as Audience, id };
}

export const emptyStatusCounts = () => ({ upToDate: 0, codeChanged: 0, outOfDate: 0, notChecked: 0 });

export function* scopedRows(snapshot: KnowledgeSnapshot | undefined, repo?: string) {
  if (!snapshot) return;
  if (repo) yield* snapshot.projects.get(repo)?.rows.values() ?? [];
  else for (const project of snapshot.projects.values()) yield* project.rows.values();
}

export function partialNotes(snapshot: KnowledgeSnapshot | undefined, repo?: string, usage = snapshot?.usagePartial) {
  const notes: Array<{ repoId?: string; note: string }> = [];
  if (snapshot?.partial) notes.push({ note: snapshot.partial });
  if (usage) notes.push({ note: usage });
  for (const [repoId, project] of snapshot?.projects ?? []) {
    if (project.partial && (!repo || repo === repoId)) notes.push({ repoId, note: project.partial });
  }
  return notes.length ? notes : undefined;
}

export function itemSummary({ key, id, repoId, audience, kind, oneLine, scope, revision, checkout, status, lastUsedAt }: KnowledgeRow): Item {
  return { key, id, repoId, audience, kind, oneLine, scope, revision, checkout, status, lastUsedAt };
}

export function compareRows(a: KnowledgeRow, b: KnowledgeRow): number {
  return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") || a.oneLine.localeCompare(b.oneLine) || a.key.localeCompare(b.key);
}

export function needsLook(row: KnowledgeRow) {
  return row.status === "codeChanged" || row.status === "outOfDate";
}

export function readKnowledgePage(data: KnowledgeData, query: Record<string, string>): z.infer<typeof MachineKnowledgePageSchema> {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw badKnowledgeRequest("Check the search, filters, and page size.");
  const { repo, q, kind, audience, status, area, cursor, limit = 50 } = parsed.data;
  ensureRepo(data.location, repo);
  const { snapshot, generation, generatedAt, updatingSince } = data.get();
  const filter = createHash("sha256").update(JSON.stringify([repo, q, kind, audience, status, area])).digest("base64url");
  const words = searchText(q).split(/\s+/u).filter(Boolean);
  const counts: z.infer<typeof MachineKnowledgePageSchema>["counts"] = { status: emptyStatusCounts(), kind: {}, audience: {} };
  let after: KnowledgeRow | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded.generation !== generation) throw knowledgeChanged();
    if (decoded.filter !== filter) throw badKnowledgeRequest("The page cursor belongs to a different search.");
    const { repoId } = parseKnowledgeKey(decoded.after);
    after = snapshot?.projects.get(repoId)?.rows.get(decoded.after);
    if (!after) throw badKnowledgeRequest("Start again at the first page.");
  }
  const matches: KnowledgeRow[] = [];
  let total = 0;
  for (const row of scopedRows(snapshot, repo)) {
    counts.status[row.status]++;
    counts.kind[row.kind] = (counts.kind[row.kind] ?? 0) + 1;
    counts.audience[row.audience] = (counts.audience[row.audience] ?? 0) + 1;
    if (kind && row.kind !== kind || audience && row.audience !== audience || area && !row.scope.includes(area)) continue;
    if (status && (status === "needs-look" ? !needsLook(row) : row.status !== status)) continue;
    if (!words.every((word) => row.search.includes(word))) continue;
    total++;
    if (!after || compareRows(row, after) > 0) matches.push(row);
  }
  matches.sort(compareRows);
  const page = matches.slice(0, limit);
  const usage = knowledgePageUsage(data.location, page, snapshot?.usage);
  return {
    items: page.map((row) => ({ ...itemSummary(row), ...(usage.items.get(useKey(row)) ?? { useCount30Days: 0, lastUsedAt: row.lastUsedAt }) })),
    total, counts, generatedAt, updatingSince, partial: partialNotes(snapshot, repo, usage.partial ?? snapshot?.usagePartial),
    nextCursor: matches.length > limit
      ? Buffer.from(JSON.stringify({ generation, filter, after: page.at(-1)!.key })).toString("base64url") : null,
  };
}

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
  try { return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
  catch { throw badKnowledgeRequest("The page cursor is invalid."); }
}
