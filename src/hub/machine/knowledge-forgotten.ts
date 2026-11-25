import { MachineKnowledgeAudienceSchema, type MachineForgottenPageSchema } from "@mex/hub-contracts/machine";
import { z } from "zod";
import { EntryIdSchema } from "../../knowledge/entry.js";
import { isObservedHint } from "../../knowledge/hints.js";
import { openRecordReadOnly, type RecordReader } from "../../record/index.js";
import { registeredProjectIds } from "./home-metrics.js";
import type { KnowledgeData } from "./knowledge.js";
import { badKnowledgeRequest, ensureRepo, knowledgeChanged, partialNotes } from "./knowledge-list.js";
import { midnight, PROJECT_ID, RETIRED_PREFIX, type RetiredRow } from "./knowledge-snapshot.js";
import { readStore } from "./read.js";

const PAGE_SIZE = 50;
const day = z.string().date();
const cursorSchema = z.object({
  repo: z.string().regex(PROJECT_ID).optional(),
  generation: z.string(),
  repoId: z.string().regex(PROJECT_ID),
  id: EntryIdSchema,
  audience: MachineKnowledgeAudienceSchema,
}).strict();

type Position = Pick<RetiredRow, "repoId" | "id" | "audience">;
type Candidate = Position & { at?: string };

function compare(a: Position, b: Position) {
  return a.repoId.localeCompare(b.repoId) || a.id.localeCompare(b.id) || a.audience.localeCompare(b.audience);
}

function markers(reader: RecordReader, repoId: string, after: string, limit: number): Candidate[] {
  const rows = reader.all<{ key: string; value: string | null }>(`
    SELECT key,CASE WHEN length(CAST(value AS BLOB))<=8192 THEN value END AS value
    FROM settings WHERE scope=? AND key>=? AND key<? AND key>?
      AND length(key) BETWEEN ? AND ? AND key GLOB 'knowledge.retired.mx_*' AND substr(key,?) NOT GLOB '*[^a-z0-9]*'
    ORDER BY key LIMIT ?`, repoId, RETIRED_PREFIX, "knowledge.retired/", after, RETIRED_PREFIX.length + 9, RETIRED_PREFIX.length + 67, RETIRED_PREFIX.length + 4, limit);
  return rows.map(({ key, value }) => {
    const id = key.slice(RETIRED_PREFIX.length);
    const audience = isObservedHint(reader, repoId, id) ? "hint" : "onlyYou";
    let at: string | undefined;
    try {
      const marker = value ? JSON.parse(value) : undefined;
      const parsed = day.safeParse(marker?.retired?.at);
      if (marker?.id === id && EntryIdSchema.safeParse(id).success && parsed.success) at = midnight(parsed.data);
    } catch { /* Keep corrupt retirement markers hidden. */ }
    return { id, repoId, audience, at };
  });
}

export function readForgotten(data: KnowledgeData, repo?: string, cursor?: string): z.infer<typeof MachineForgottenPageSchema> {
  ensureRepo(data.location, repo);
  const { snapshot, generation, generatedAt, updatingSince } = data.get();
  let after: z.infer<typeof cursorSchema> | undefined;
  if (cursor !== undefined) {
    if (cursor.length > 480) throw badKnowledgeRequest("The page cursor is invalid.");
    try { after = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
    catch { throw badKnowledgeRequest("The page cursor is invalid."); }
    if (after.generation !== generation) throw knowledgeChanged();
    if (after.repo !== repo) throw badKnowledgeRequest("The page cursor belongs to a different repo.");
  }
  const candidates = readStore(openRecordReadOnly, data.location, (reader) => {
    const candidates: Candidate[] = [];
    if (!reader) return candidates;
    for (const repoId of repo ? [repo] : registeredProjectIds(reader)) {
      if (after && repoId < after.repoId) continue;
      const seek = after?.repoId === repoId ? after : undefined;
      // At the same ID the local marker sorts ahead of the team copy.
      const local = markers(reader, repoId, seek ? RETIRED_PREFIX + seek.id : "", PAGE_SIZE + 1 - candidates.length);
      const merged = new Map<string, Candidate>();
      for (const row of snapshot?.projects.get(repoId)?.retired ?? []) {
        if (!seek || compare(row, seek) > 0) merged.set(row.id + ":" + row.audience, row);
      }
      for (const row of local) merged.set(row.id + ":" + row.audience, row);
      candidates.push(...[...merged.values()].sort(compare).slice(0, PAGE_SIZE + 1 - candidates.length));
      if (candidates.length > PAGE_SIZE) break;
    }
    return candidates;
  });
  const page = candidates.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  const nextCursor = candidates.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({
    repo, generation, repoId: last.repoId, id: last.id, audience: last.audience,
  })).toString("base64url") : null;
  return {
    items: page.flatMap(({ id, repoId, audience, at }) => at ? [{ id, repoId, audience, at }] : []),
    nextCursor, generatedAt, updatingSince, partial: partialNotes(snapshot, repo, ""),
  };
}
