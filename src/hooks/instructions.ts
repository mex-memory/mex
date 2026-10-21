/**
 * The short instruction block `mex hooks install` keeps in the project's
 * `CLAUDE.md`: what the injected "MEX knowledge" is, what a warning means and
 * what to do when a change makes an entry false.
 *
 * It is planned and removed with the shared managed-block machinery, under
 * its own markers, so it coexists with the agent-skills policy block and is
 * removed on its own.
 */

import { planManagedBlockEdit, planManagedBlockRemoval, type ManagedBlockEdit, type ManagedBlockRemoval, type ManagedBlockSpec } from "../managed-block.js";

export const HOOK_INSTRUCTIONS_START = "<!-- mex-agent:hooks:start -->";
export const HOOK_INSTRUCTIONS_END = "<!-- mex-agent:hooks:end -->";
export const MAX_HOOK_INSTRUCTION_PREVIEW_BYTES = 8 * 1024;

export function renderHookInstructionBlock(eol: "\n" | "\r\n" = "\n"): string {
  return [
    HOOK_INSTRUCTIONS_START,
    "MEX notes are curated project knowledge linked to code locations, not complete answers. Read the code when details matter. ⚠ means linked code changed: verify the note before relying on it. Do not open or edit `.mex` files by hand except as an edit note directs.",
    HOOK_INSTRUCTIONS_END,
  ].join(eol);
}

const SPEC: ManagedBlockSpec = {
  start: HOOK_INSTRUCTIONS_START,
  end: HOOK_INSTRUCTIONS_END,
  render: (eol) => renderHookInstructionBlock(eol),
  maxPreviewBytes: MAX_HOOK_INSTRUCTION_PREVIEW_BYTES,
};

export const planHookInstructionEdit = (current: Uint8Array | null): ManagedBlockEdit => planManagedBlockEdit(SPEC, current);

export const planHookInstructionRemoval = (current: Uint8Array | null): ManagedBlockRemoval => planManagedBlockRemoval(SPEC, current);
