/** Scripted replies for the evidence gate, read from the real gate prompt so tests exercise its parser. */
import type { GateVerdict } from "../../norm-gate.js";

const TARGETS = "\n\nTarget rules:\n";

export const isGatePrompt = (prompt: string): boolean => prompt.startsWith("Check draft rules for coding agents") && prompt.includes(TARGETS);

export function gateTargets(prompt: string): Array<{ id: string; text: string }> {
  const at = prompt.lastIndexOf(TARGETS);
  if (at < 0) throw new Error("Not a gate prompt");
  return prompt.slice(at + TARGETS.length).split("\n").filter(Boolean).map(line => JSON.parse(line) as { id: string; text: string });
}

export interface ScriptedVerdict { verdict: GateVerdict; duplicateOf?: string }

/** One verdict per target rule; `pick` returns undefined to leave a rule out of the reply. */
export function gateReply(prompt: string, pick: (rule: { id: string; text: string }) => ScriptedVerdict | undefined = () => ({ verdict: "keep" })) {
  return {
    verdicts: gateTargets(prompt).flatMap(rule => {
      const chosen = pick(rule);
      return chosen ? [{ rule: rule.id, verdict: chosen.verdict, reason: "Recorded verdict.", ...(chosen.duplicateOf ? { duplicateOf: chosen.duplicateOf } : {}) }] : [];
    }),
  };
}
