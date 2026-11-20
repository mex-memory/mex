import { z } from "zod";
import { tokenCount } from "../model-runner/consent.js";
import type { Tokens } from "../record/usage.js";
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

const modelOverhead = 8192;
const outputAllowance = 2400;
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

export function promptEstimate(prompt: string): Tokens {
  return { input: modelOverhead + Math.ceil(Buffer.byteLength(prompt) / 3), cache_write: 0, cache_read: 0, output: outputAllowance };
}

export function quoteTokens(pulls: number, docs: number, setup: LearningPlan["setup"], sessions: ImportFile[] = [],
  pullsPerBatch = PULLS_PER_BATCH): number {
  const batches = Math.max(pulls || docs || !sessions.length ? 1 : 0, Math.ceil(pulls / pullsPerBatch), Math.ceil(docs / DOCS_PER_BATCH));
  const importBatches = Math.ceil(sessions.length / SESSIONS_PER_BATCH);
  const stages = setup === "mixed" ? 2 : 1;
  return stages * ((batches + importBatches) * (modelOverhead + outputAllowance + 1000) + pulls * 4500 + docs * 1600
    + sessions.reduce((sum, file) => sum + file.messages * 2000, 0));
}

export function quoteCeiling(estimate: number): number { return Math.floor(estimate * 1.5); }

export function fitsQuote(prompt: string, ceiling: number): boolean { return tokenCount(promptEstimate(prompt)) <= ceiling; }
