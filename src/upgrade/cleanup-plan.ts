/** Exact tracked-file cleanup proposals. This module never writes a file. */
import { planManagedBlockEdit } from "../managed-block.js";
import { parseDocument } from "../wiki/markdown/parse.js";
import type { LegacySnapshot } from "./legacy-reader.js";

export interface UpgradeFileChange { path: string; before: string | null; after: string | null; }
export interface CleanupPlan {
  changes: UpgradeFileChange[];
  issues: Array<{ code: "INCOMPLETE_LEGACY_INPUT" | "INSTRUCTION_BLOCK_REVIEW"; path: string }>;
}

const SKILLS = { start: "<!-- mex-agent:skills:start -->", end: "<!-- mex-agent:skills:end -->" };
const ANCHOR = { start: "<!-- mex-anchor:start -->", end: "<!-- mex-anchor:end -->" };

function instructions(markers: typeof SKILLS, eol: string): string {
  return [markers.start, "## MEX project knowledge",
    "- Use `mex recall` to find relevant project knowledge.",
    "- Use `mex expand <id>` to read an entry and its evidence.",
    "- Follow the current request and repository instructions.",
    "- Check the entry's source and verdict before relying on it.",
    "- Use `mex note` for explicit personal notes and decisions.",
    "- Use `mex check` to inspect checks and `mex wrong` to retire incorrect knowledge.",
    "- Preview `mex share` before sharing personal knowledge with the team.",
    markers.end].join(eol);
}

/** Replace actual managed HTML blocks, preserving every outside byte. */
export function planInstructionRewrite(text: string): { after?: string; review: boolean } {
  const html = parseDocument(text).htmlBlocks.map(block => text.slice(block.start, block.end));
  const present = (markers: typeof SKILLS) => html.some(block => block === markers.start || block === markers.end);
  const skills = present(SKILLS), anchor = present(ANCHOR);
  if (!skills && !anchor) return { review: false };
  let after = text;
  for (const markers of [SKILLS, ANCHOR]) {
    if (!(markers === SKILLS ? skills : anchor)) continue;
    const plan = planManagedBlockEdit({ ...markers, maxPreviewBytes: 32 * 1024,
      render: eol => markers === ANCHOR && skills ? "" : instructions(markers, eol) }, Buffer.from(after));
    if (plan.action === "conflict") return { review: true };
    if (plan.desiredBytes) after = Buffer.from(plan.desiredBytes).toString("utf8");
  }
  return { review: false, ...(after !== text ? { after } : {}) };
}

export function planLegacyCleanup(snapshot: LegacySnapshot): CleanupPlan {
  const result: CleanupPlan = { changes: [], issues: [] };
  if (!snapshot.complete) return { changes: [], issues: [{ code: "INCOMPLETE_LEGACY_INPUT", path: ".mex" }] };
  for (const document of snapshot.documents) {
    if (document.kind === "obsolete") {
      result.changes.push({ path: document.path, before: document.text, after: null });
    } else if (document.kind === "instructions") {
      const planned = planInstructionRewrite(document.text);
      if (planned.review) result.issues.push({ code: "INSTRUCTION_BLOCK_REVIEW", path: document.path });
      else if (planned.after !== undefined) result.changes.push({ path: document.path, before: document.text, after: planned.after });
    }
  }
  return result;
}
