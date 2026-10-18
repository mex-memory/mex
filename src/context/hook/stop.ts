/**
 * The Stop event: one question at the end of a session, then the settle worker.
 *
 * When the session touched code that MEX entities describe and nobody vouched
 * for them (neither rewrote their prose nor ran `mex context confirm`), the
 * hook blocks the stop once and lists them. The agent either rewrites the
 * prose that is now false or confirms the ones that still hold. It never asks
 * twice in a session, and `context.stopReview: "off"` never asks at all.
 *
 * Either way the hook starts the detached settle worker (see `settle.ts`),
 * unless the touched code and what vouches for it are the same as at the last
 * run; a block starts it as well, since the host may never deliver the block.
 */

import { loadConfiguredContextConfig } from "../../config.js";
import { openGraphReader } from "../graph-reader.js";
import { ensureContextIndex } from "../index-store.js";
import { recordReview, reviewDigest, reviewSession, type Review, type ReviewEntry } from "../review.js";
import type { ContextRoot } from "../root.js";
import { loadSettled, loadStopAsked, recordSettled, recordStopAsked } from "../session.js";
import { startSettle, type StartOptions } from "./settle.js";

/** The most characters the question may take. */
export const STOP_REASON_LIMIT = 1500;

export interface StopOutcome {
  /** Exactly what to print; a block decision, or empty. */
  stdout: string;
  /** Fields for the hook log. */
  log: Record<string, unknown>;
}

export interface StopInput {
  root: ContextRoot;
  sessionId: string | null;
  /** Claude Code sets this when the agent is already continuing because a Stop hook blocked. */
  stopHookActive: boolean;
  start?: StartOptions;
}

const oneLine = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function describe(entry: ReviewEntry): string {
  return `- ${entry.entity.id} "${oneLine(entry.entity.title, 70)}" (.mex/${entry.entity.file}:${entry.entity.line}): ${oneLine(entry.why, 80)}`;
}

/**
 * The question, at most {@link STOP_REASON_LIMIT} characters. Entries beyond
 * what fits are counted, not listed; `mex context status` lists them all.
 */
export function composeStopReason(flagged: readonly ReviewEntry[], sessionId: string | null): string {
  const confirm = (ids: string): string => `mex context confirm ${ids}${sessionId === null ? "" : ` --session ${sessionId}`}`;
  const head = "MEX: your changes touched code that these knowledge entries describe, and nobody has vouched for them yet.";
  const tailText = (ids: string): string =>
    `For each: if your change made it false, rewrite just its prose (leave <!-- mex:entity --> blocks alone). If it still holds, run \`${confirm(ids)}\`. Entries you leave stay flagged "changed, re-check". Then finish.`;
  const lines: string[] = [];
  const listed: string[] = [];
  for (const entry of flagged) {
    const next = [...lines, describe(entry)];
    const more = flagged.length - next.length;
    const candidate = [head, ...next, ...(more > 0 ? [`(+${more} more: mex context status)`] : []), tailText([...listed, entry.entity.id].join(" "))].join("\n");
    if (candidate.length > STOP_REASON_LIMIT && lines.length > 0) break;
    lines.push(describe(entry));
    listed.push(entry.entity.id);
  }
  const more = flagged.length - lines.length;
  return [head, ...lines, ...(more > 0 ? [`(+${more} more: mex context status)`] : []), tailText(listed.join(" "))].join("\n").slice(0, STOP_REASON_LIMIT);
}

async function currentReview(root: ContextRoot, sessionId: string | null): Promise<Review | null> {
  const { index } = await ensureContextIndex(root, "if-stale");
  const { reader } = openGraphReader(root.scaffoldRoot);
  try {
    return reviewSession({ root, index, reader, sessionId });
  } finally {
    reader?.close();
  }
}

export async function handleStop(input: StopInput): Promise<StopOutcome> {
  const { root, sessionId } = input;
  const review = await currentReview(root, sessionId);
  if (review === null) return { stdout: "", log: { note: "no-git" } };
  if (review.entries.length === 0) return { stdout: "", log: { touched: 0 } };

  // From here on the entities read as changed in packets, even before the graph is refreshed.
  recordReview(root.localDir, review);
  const base = { touched: review.entries.length, eligible: review.eligible.map((e) => e.entity.id), flagged: review.flagged.map((e) => e.entity.id) };

  const config = loadConfiguredContextConfig(root.scaffoldRoot);
  const unvouched = review.flagged.filter((entry) => entry.touchedNow);
  const block = config.stopReview === "ask" && unvouched.length > 0 && sessionId !== null && !input.stopHookActive && !loadStopAsked(root.localDir, sessionId);
  if (block && sessionId !== null) recordStopAsked(root.localDir, sessionId);

  // A block starts the worker too. A host may end the session without delivering the block
  // (a headless run whose last act was its structured answer), and then no second Stop comes.
  // When the agent does answer, its confirmations change the digest and the next Stop runs
  // the worker again, or tells the running one to go round once more.
  const digest = reviewDigest(review);
  let settle: string;
  if (sessionId !== null && loadSettled(root.localDir, sessionId) === digest) {
    settle = "unchanged";
  } else {
    if (sessionId !== null) recordSettled(root.localDir, sessionId, digest);
    settle = await startSettle(root, sessionId, input.start);
  }
  if (block) {
    const reason = composeStopReason(unvouched, sessionId);
    return { stdout: JSON.stringify({ decision: "block", reason }), log: { ...base, blocked: true, settle, chars: reason.length, text: reason } };
  }
  return { stdout: "", log: { ...base, settle } };
}
