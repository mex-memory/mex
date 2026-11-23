/**
 * The opt-in verify pass (D6): for a learned rule that waits for a tick, the person can ask their own
 * agent to look through the checkout, read-only, and say whether the rule holds. One rule per call, a
 * tool limit, a wall-clock limit and an estimate shown before consent. The review stages the advice
 * until the person saves their decisions. A stopped run supplies no answer.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ModelAgent, runModel } from "../model-runner/index.js";
import { replyJson } from "./reply.js";

export const VERIFY_TURNS = 8;
export const VERIFY_TIMEOUT_MS = 2 * 60_000;
/** A read-only call re-sends its context each turn: a deliberate over-estimate, so the quote never surprises. */
export const VERIFY_ESTIMATE = 40_000;
/** The same 1.5× multiple as a learning run. An answer over this is discarded and is not a review decision. */
export const VERIFY_CEILING = Math.floor(VERIFY_ESTIMATE * 1.5);

export function verifySpend(usage: { input?: number; output?: number; cache_read?: number; cache_write?: number } | undefined): number {
  if (!usage) return 0;
  return [usage.input, usage.output, usage.cache_read, usage.cache_write].reduce((sum: number, value) =>
    sum + (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0), 0);
}

/** A cited place is a file in the checkout and a line that file contains. Directories, bare paths and invented lines are not evidence. */
export function citedEvidence(item: string, root: string): boolean {
  const match = /^(.*?):(\d+)(?:-\d+)?$/u.exec(item);
  if (!match) return false;
  const path = match[1]!;
  const line = Number(match[2]);
  if (!path || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("..") || path.includes("\\") || path.endsWith("/")) return false;
  const full = join(root, path);
  try {
    if (!statSync(full).isFile()) return false;
    const lines = readFileSync(full, "utf8").split(/\r?\n/u);
    return line >= 1 && line <= lines.length;
  } catch { return false; }
}

const Answer = z.object({
  verdict: z.enum(["keep", "drop", "rewrite"]),
  evidence: z.array(z.string().min(3).max(300)).max(8).default([]),
  text: z.string().max(600).optional(),
}).strict();
export type VerifyAnswer = z.infer<typeof Answer> & { evidence: string[] };

export function verifyPrompt(rule: { claim: string; scope: readonly string[]; why?: string }): string {
  return `You are checking one rule that was learned from this repository's past code reviews. Read the code in this checkout to decide whether the rule is still right here. You may only read files; change nothing.
Rule: ${rule.claim}${rule.why ? `\nWhy: ${rule.why}` : ""}
It applies to: ${rule.scope.join(", ")}
Look for code that follows the rule and code that breaks it. Decide: keep (the rule holds and is worth telling a coding agent), drop (it's wrong, outdated, or not worth telling), or rewrite (right idea, wrong wording).
Answer only with JSON: {"verdict":"keep|drop|rewrite","evidence":["path:line", ...],"text":"the rewritten rule, only for rewrite"}. Cite at most 8 places.`;
}

/** Evidence must name files that exist in the checkout; an answer citing nothing real is not an answer. */
export function parseVerify(text: string, root: string): VerifyAnswer | undefined {
  const parsed = Answer.safeParse(replyJson(text));
  if (!parsed.success) return undefined;
  const evidence = parsed.data.evidence.filter(item => citedEvidence(item, root));
  if (!evidence.length) return undefined;
  return { ...parsed.data, evidence };
}

export async function verifyRule(rule: { claim: string; scope: readonly string[]; why?: string }, root: string, agent: ModelAgent,
  model: typeof runModel): Promise<VerifyAnswer | undefined> {
  const result = await model({ agent, setup: "best-only", role: "best", projectRoot: root, executionDirectory: root,
    purpose: "learn-deeper-verify", prompt: verifyPrompt(rule), timeoutMs: VERIFY_TIMEOUT_MS, readOnlyTools: { maxTurns: VERIFY_TURNS } });
  if (verifySpend(result.usage) > VERIFY_CEILING) return undefined;
  return parseVerify(result.text, root);
}
