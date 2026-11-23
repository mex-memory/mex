import { z } from "zod";

/** Why one candidate did not become a saved rule. No source text. */
export const DISPOSITIONS = ["dropped", "quota", "bad-output", "earlier-suppressed", "proof-downgrade", "duplicate", "interrupted"] as const;
export type DispositionName = (typeof DISPOSITIONS)[number];
export interface CandidateDisposition { id: string; disposition: DispositionName; detail?: string }

const row = z.object({
  id: z.string().min(1).max(360),
  disposition: z.enum(DISPOSITIONS),
  detail: z.string().min(1).max(64).optional(),
}).strict();

/** Outlives the job-scoped raw rows, which are deleted when the run ends. */
export const dispositionKey = (jobId: string) => `learning.deep.dispositions.${jobId}`;

const rank: Record<DispositionName, number> = {
  dropped: 1, quota: 2, "earlier-suppressed": 3, duplicate: 4, "proof-downgrade": 5, "bad-output": 6, interrupted: 7,
};

export function readDispositions(raw: string | undefined | null): CandidateDisposition[] {
  if (!raw || Buffer.byteLength(raw) > 500_000) return [];
  try {
    const parsed = z.array(row).max(2000).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}

/** A later, more specific reason replaces an earlier one for the same candidate. */
export function mergeDispositions(current: readonly CandidateDisposition[], next: readonly CandidateDisposition[]): CandidateDisposition[] {
  const map = new Map(current.map(item => [item.id, item]));
  for (const item of next) {
    const parsed = row.safeParse(item);
    if (!parsed.success) continue;
    const previous = map.get(parsed.data.id);
    if (!previous || rank[parsed.data.disposition] >= rank[previous.disposition]) map.set(parsed.data.id, parsed.data);
  }
  return [...map.values()].slice(0, 2000);
}
