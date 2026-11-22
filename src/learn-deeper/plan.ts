import { z } from "zod";
import { tokenCount } from "../model-runner/consent.js";
import { ZERO, type Tokens } from "../record/usage.js";
import type { Pull } from "./forge.js";
import { repoPath } from "./git.js";
import { ImportFile, MAX_SESSIONS, SESSIONS_PER_BATCH } from "./session-import.js";
import { repository } from "./source.js";

export const LEARN_KIND = "learn-deeper";
export const LEARN_COMMAND = "mex learn";
export const PULLS_PER_BATCH = 4;
export const BACKFILL_PULLS_PER_BATCH = 8;
export const DOCS_PER_BATCH = 6;
export const MAX_PULLS = 48;
export const MAX_DOCS = 36;
export const MAX_LEARNED_PROPOSALS = 16;
// The plan asks for about ten rules in the first batch, so the first answer stays short and quick to check.
export const FIRST_BATCH_PROPOSALS = 10;

const baseOutputAllowance = 2400;
const anchorOutputPerRule = 192;
export const inputOverhead = 8192;
// All five measured best-only Codex replay calls reported the same cached
// prefix. Reserve it separately from the prompt and uncached headroom so both
// token ceilings and the model's cache-read price see it.
export const codexCacheRead = 12_288;
const iso = z.string().datetime({ offset: true });
const slug = z.object({ host: z.enum(["github.com", "gitlab.com"]), slug: z.string() }).strict()
  .refine(value => repository(value.host, value.slug)?.slug === value.slug);

export const Plan = z.object({
  checkout: z.string().min(1).max(4096), head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  origin: slug, source: slug, visibility: z.enum(["public", "private"]),
  agent: z.enum(["claude", "codex"]), setup: z.enum(["mixed", "best-only"]), since: iso, until: iso,
  preferred: z.array(z.string().refine(repoPath)).max(12),
  pulls: z.array(z.object({ number: z.number().int().positive(), at: iso }).strict()).max(MAX_PULLS),
  // Old approved jobs and weekly plans keep their original batch boundaries.
  pullsPerBatch: z.literal(BACKFILL_PULLS_PER_BATCH).optional(),
  docs: z.array(z.string().refine(repoPath)).max(MAX_DOCS),
  sessions: z.array(ImportFile).max(MAX_SESSIONS).default([]),
  refresh: z.boolean().default(false),
  gaps: z.array(z.string().max(180)).max(12),
  estimate: z.number().int().positive(), ceiling: z.number().int().positive(),
}).strict();
export type LearningPlan = z.infer<typeof Plan>;

export function orderBackfillPulls(pulls: readonly Pull[]): Pull[] {
  // Inventory still samples the full window. Present nearby changes together,
  // so recurring review lessons can be corroborated in one model call.
  return [...pulls].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.number - b.number);
}

export function reviewWindow(now = new Date()): { since: string; until: string } {
  const day = now.getUTCDate();
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 18);
  const endOfMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, endOfMonth));
  return { since: start.toISOString(), until: now.toISOString() };
}

function estimateCall(promptTokens: number, agent: LearningPlan["agent"], anchorRules: number): Tokens {
  return { ...ZERO, input: inputOverhead + promptTokens, cache_read: agent === "codex" ? codexCacheRead : 0,
    output: baseOutputAllowance + anchorOutputPerRule * anchorRules };
}

export function promptEstimate(prompt: string, agent: LearningPlan["agent"], anchorRules = MAX_LEARNED_PROPOSALS): Tokens {
  return estimateCall(Math.ceil(Buffer.byteLength(prompt) / 3), agent, anchorRules);
}

export function quoteTokens(pulls: number, docs: number, agent: LearningPlan["agent"], setup: LearningPlan["setup"], sessions: ImportFile[] = [],
  pullsPerBatch = PULLS_PER_BATCH): number {
  const batches = Math.max(pulls || docs || !sessions.length ? 1 : 0, Math.ceil(pulls / pullsPerBatch), Math.ceil(docs / DOCS_PER_BATCH));
  const importBatches = Math.ceil(sessions.length / SESSIONS_PER_BATCH);
  // The writer includes the anchor instructions and up to twelve earlier
  // entries. The source allowance includes bounded changed-file metadata.
  const writer = tokenCount(estimateCall(4000, agent, MAX_LEARNED_PROPOSALS));
  const filter = setup === "mixed" ? tokenCount(estimateCall(300, agent, 0)) : 0;
  const sources = pulls * 5400 + docs * 1600 + sessions.reduce((sum, file) => sum + file.messages * 2000, 0);
  return (batches + importBatches) * (writer + filter) + (filter ? 2 : 1) * sources;
}

export function quoteCeiling(estimate: number): number { return Math.floor(estimate * 1.5); }
