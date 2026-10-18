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
    "## Project knowledge (MEX)",
    '- This repository keeps curated, code-linked knowledge in `.mex/`. The entries relevant to your work are shown to you automatically as "MEX knowledge": when a task starts, and when you read, search or edit source files. Use them to orient; they say how the code works and where to look.',
    "- An entry marked ⚠ describes code that changed after it was written: check the code before relying on it, and say so if the entry is wrong.",
    '- Need more? `mex wiki query "<two or three words>"`, then `mex wiki show <id>` for one entry\'s text. This is cheaper than opening `.mex` files, which are mostly metadata.',
    "- If your code change makes an entry false, rewrite that entry's prose at the `.mex` line shown with it; do not search `.mex` for entries, the affected ones are listed when you edit code. Never edit the `mex:entity` comment blocks, ids or fingerprints: MEX re-records code links itself.",
    "- Entries your change touched stay flagged as changed until someone re-checks them (`mex check`, `mex sync`). If one still holds, `mex context confirm <ids>` lets MEX re-record it after the session.",
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
