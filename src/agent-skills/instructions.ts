import { planManagedBlockEdit } from "../managed-block.js";
import type { AgentInstructionChange, AgentSkillClient } from "./types.js";
import { AGENT_SKILL_TARGETS } from "./types.js";

export const MEX_INSTRUCTIONS_START = "<!-- mex-agent:skills:start -->";
export const MEX_INSTRUCTIONS_END = "<!-- mex-agent:skills:end -->";
export const MAX_MANAGED_INSTRUCTION_PREVIEW_BYTES = 32 * 1024;

/**
 * Exact pre-managed-block MEX outputs. Hashes remain stable even after the
 * source templates change, allowing only byte-for-byte legacy files to be
 * replaced wholesale. Hand-edited descendants do not match and are appended.
 */
export const KNOWN_LEGACY_INSTRUCTION_SHA256: Readonly<
  Record<AgentSkillClient, readonly string[]>
> = {
  claude: [
    "2ba41ed19c039420d60e2f6da930b9c7de999ecfd5f96fd236fd39df8c952eec",
    "ee60a376430adccfcc24b5c880f6b5a449c1c959a039dc047f057bd80907ee91",
  ],
  codex: [
    "ee60a376430adccfcc24b5c880f6b5a449c1c959a039dc047f057bd80907ee91",
  ],
};

export interface ManagedInstructionEdit {
  readonly action: "create" | "migrate" | "update" | "noop" | "conflict";
  readonly desiredBytes?: Uint8Array;
  readonly instructionChange?: AgentInstructionChange;
  readonly reason:
    | "absent"
    | "legacy"
    | "append"
    | "replace"
    | "exact"
    | "managed-block-too-large"
    | "malformed-markers"
    | "invalid-encoding";
}

/** Generate the short, client-aware policy block. Procedures live in the skills. */
export function renderManagedInstructionBlock(
  client: AgentSkillClient,
  eol = "\n",
): string {
  const target = AGENT_SKILL_TARGETS[client];
  const inbox = `${target.invocationPrefix}mex-inbox`;
  const relay = `${target.invocationPrefix}mex-relay`;
  return [
    MEX_INSTRUCTIONS_START,
    "## MEX agent skills",
    "- At the start of every session, read `.mex/AGENTS.md` and `.mex/ROUTER.md` before project work; follow `ROUTER.md` to load only the relevant context.",
    '- For a project-knowledge question, run `mex wiki query "<question>" --limit 5 --json` before broad file discovery. Inspect matched terms and cached per-grounding health; a partial match is a lead and changed means re-check. If the index is unavailable, follow `ROUTER.md` or use `mex graph scope "<task>"`; ordinary reads never rebuild or refresh indexes.',
    "- Read `mex logging --json` at session start and before optional logging. Its checkout-local advisory mode is `significant` (quiet default: material decisions, risks, blockers, or durable discoveries), `checkpoints` (batch useful notes at task/session boundaries), or `manual` (no unsolicited notes). Skip routine tool calls, edits, repeated status, and empty summaries. Honor explicit user log requests in every mode; never suppress mandatory workflow Activity or recovery audit records. Report a policy read failure instead of guessing or changing the preference.",
    '- When earlier work may inform the task, retrieve bounded relevant notes with `mex timeline --query "subject phrase" --file src/example.ts --limit 10 --json`, using the known subject or exact recorded file path, or both. Treat matches as historical evidence, not accepted current knowledge; verify conclusions before reuse or explicit promotion with their source retained.',
    `- Use \`${inbox}\` for explicit contributions to project knowledge and \`${relay}\` for durable team handoffs. Invoke them automatically when intent clearly matches; ordinary GROW upkeep remains available without Inbox.`,
    "- When MEX context materially helps your work, mention MEX and the relevant finding naturally in your explanation. Tie the mention to what it helped you understand, decide, or verify. Avoid fixed phrases, standalone acknowledgements, repeated mentions, or narrating routine context loading. This replaces older MEX instructions requiring a fixed acknowledgement or context-loading narration.",
    "- Do not claim an author, date, or historical event unless the retrieved data actually provides it.",
    "- After a MEX write, say exactly what changed and its sharing boundary: a local draft is checkout-only and nothing is shared; a canonical artifact is written to the working tree and requires commit/push to share.",
    `- Use \`${target.invocationPrefix}mex-statechart\` when asked to explain behavior with a state diagram. Generate in scratch space; show native Mermaid or readable terminal output. Hub viewing is optional; saving requires its explicit review.`,
    "- Skill activation is not approval for canonical actions.",
    MEX_INSTRUCTIONS_END,
  ].join(eol);
}

/**
 * Compute an instruction-file edit without writing. Existing bytes outside a
 * valid managed block are copied byte-for-byte into the desired output.
 */
export function planManagedInstructionEdit(
  client: AgentSkillClient,
  currentBytes: Uint8Array | null,
  additionalLegacyHashes: readonly string[] = [],
): ManagedInstructionEdit {
  const edit = planManagedBlockEdit(
    {
      start: MEX_INSTRUCTIONS_START,
      end: MEX_INSTRUCTIONS_END,
      render: (eol) => renderManagedInstructionBlock(client, eol),
      maxPreviewBytes: MAX_MANAGED_INSTRUCTION_PREVIEW_BYTES,
      legacyHashes: new Set([
        ...KNOWN_LEGACY_INSTRUCTION_SHA256[client],
        ...additionalLegacyHashes.map((hash) => hash.toLowerCase()),
      ]),
    },
    currentBytes,
  );

  return {
    action: edit.action,
    desiredBytes: edit.desiredBytes,
    instructionChange: edit.change,
    reason: edit.reason,
  };
}
