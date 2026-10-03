/**
 * Knowledge files the Wiki does not hold, and why (#227).
 *
 * Migration runs during setup and then never again on its own. A pattern an
 * agent adds after setup, or a context file population wrote without a type,
 * therefore stays outside the Wiki — out of `wiki query`, `wiki for-code` and
 * the Hub's Context view, groundings included — and nothing said so. This is
 * the one place that answers "which knowledge files are not entities", so
 * `wiki validate` and `mex check` cannot disagree about it.
 *
 * ## The answer is migration's own
 *
 * A gap is read off {@link classifyFile}, the function migration itself runs,
 * never a second set of rules. A file is reported when migration would adopt
 * it (`not-adopted`), when it is a direct child of `context/` that no rule
 * names and no declaration types (`untyped`), or when it declares a type
 * migration cannot honour (`invalid-declaration`). A file outside `context/`
 * that nothing types is not reported: nothing establishes that it is knowledge.
 *
 * ## Only once the Wiki is in use
 *
 * A scaffold with no entity at all has not been migrated — an agent-memory
 * scaffold completes without a Wiki — and reporting every one of its files
 * would be noise about a feature it does not use. One adopted entity anywhere
 * is the structural sign that it does.
 *
 * Pure and read-only, over an inventory the caller already holds.
 */

import { classifyFile, isDirectContextFile } from "./classify.js";
import type { ScaffoldInventory } from "./inventory.js";

export type AdoptionGapKind = "not-adopted" | "untyped" | "invalid-declaration";

export interface AdoptionGap {
  /** Scaffold-relative path. */
  file: string;
  kind: AdoptionGapKind;
  /** A sentence about this file, specific enough to act on. */
  message: string;
}

/** True when any file in the inventory already carries an entity. */
export function wikiInUse(inventory: ScaffoldInventory): boolean {
  return inventory.files.some((file) => file.parsed.entities.length > 0);
}

/** Every knowledge file outside the Wiki, in inventory order. */
export function findAdoptionGaps(inventory: ScaffoldInventory): AdoptionGap[] {
  if (!wikiInUse(inventory)) return [];
  const gaps: AdoptionGap[] = [];
  for (const file of inventory.files) {
    const classification = classifyFile(file);
    if (classification.skipped) continue;
    if (classification.candidates.length > 0) {
      const types = [...new Set(classification.candidates.map((candidate) => candidate.type))].sort();
      gaps.push({
        file: file.path,
        kind: "not-adopted",
        message:
          `${file.path} is not in the Wiki: migration would adopt it as ` +
          `${classification.candidates.length} entit${classification.candidates.length === 1 ? "y" : "ies"} ` +
          `(${types.join(", ")}), but has not been run since it was written.`,
      });
      continue;
    }
    const whole = classification.abstentions.find((entry) => entry.target === null && entry.kind !== undefined);
    if (whole === undefined) continue;
    if (whole.kind === "invalid-declaration") {
      gaps.push({ file: file.path, kind: "invalid-declaration", message: `${file.path} is not in the Wiki: ${whole.reason}` });
    } else if (whole.kind === "untyped" && isDirectContextFile(file.path)) {
      gaps.push({
        file: file.path,
        kind: "untyped",
        message:
          `${file.path} is not in the Wiki: no rule names this context file and its frontmatter declares no \`type\`, ` +
          "so its content and groundings are unreachable through Wiki search, `wiki for-code` and the Hub.",
      });
    }
  }
  return gaps;
}
