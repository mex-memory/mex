/**
 * The per-session injection budget.
 *
 * Every event adds to the characters injected in a session. While the total
 * stays within the budget packets go out whole. Past it, a packet degrades to
 * one short pointer per entry (the agent can still ask for the text); once the
 * total reaches 1.5 times the budget nothing more is sent. Pointers count
 * toward the total like anything else. Session de-duplication has already run
 * by the time a packet gets here.
 */

import type { LiveHealth } from "../types.js";

export const EXHAUSTED_FACTOR = 1.5;
export const POINTER_MAX_CHARS = 120;

export interface PointerEntry {
  id: string;
  title: string;
  health: LiveHealth;
}

export type BudgetDecision =
  | { kind: "full" }
  | { kind: "pointers"; text: string }
  | { kind: "exhausted" };

const healthWord = (health: LiveHealth): string => (health === "changed" || health === "missing" ? `${health} ⚠` : health === "none" ? "unlinked" : health);

/** One pointer line, never longer than {@link POINTER_MAX_CHARS}; the title gives way, the id never does. */
export function pointerLine(entry: PointerEntry): string {
  const tail = ` applies (${healthWord(entry.health)}) — mex wiki show ${entry.id}`;
  const head = "MEX: ";
  const room = Math.max(8, POINTER_MAX_CHARS - head.length - tail.length);
  const title = entry.title.length > room ? `${entry.title.slice(0, room - 1).trimEnd()}…` : entry.title;
  return `${head}${title}${tail}`;
}

export function decideBudget(options: { used: number; budget: number; text: string; pointers: readonly PointerEntry[] }): BudgetDecision {
  const { used, budget, text, pointers } = options;
  if (used >= budget * EXHAUSTED_FACTOR) return { kind: "exhausted" };
  if (used + text.length <= budget) return { kind: "full" };
  if (pointers.length === 0) return { kind: "exhausted" };
  const lines = pointers.map(pointerLine).join("\n");
  return used + lines.length > budget * EXHAUSTED_FACTOR ? { kind: "exhausted" } : { kind: "pointers", text: lines };
}
