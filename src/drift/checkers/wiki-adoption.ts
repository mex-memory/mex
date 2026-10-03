import { join, relative } from "node:path";
import type { DriftIssue } from "../../types.js";
import { loadConfiguredWikiConfig } from "../../config.js";
import { toPosix } from "../../paths.js";
import { findAdoptionGaps } from "../../wiki/migration/adoption-gaps.js";
import { inventoryScaffold } from "../../wiki/migration/inventory.js";

/**
 * Knowledge files the Wiki does not hold (#227).
 *
 * Migration runs during setup and not again, so a pattern added afterwards, or
 * a context file written without a type, stays out of Wiki search,
 * `wiki for-code` and the Hub's Context view with nothing saying so. This
 * reports the same gaps `wiki validate` does, from the same function, over the
 * Wiki's own walk of the scaffold (honouring `wiki.exclude`), so the two
 * commands cannot disagree about which files are outside the Wiki.
 *
 * Read-only. A scaffold that cannot be walked within the Wiki corpus bounds
 * yields no finding here rather than failing the whole check: the bound is
 * reported by the Wiki commands that own it.
 */
export function checkWikiAdoption(projectRoot: string, scaffoldRoot: string): DriftIssue[] {
  let gaps: ReturnType<typeof findAdoptionGaps>;
  try {
    const exclude = loadConfiguredWikiConfig(scaffoldRoot).exclude;
    gaps = findAdoptionGaps(inventoryScaffold({ scaffoldRoot, exclude }));
  } catch {
    return [];
  }
  return gaps.map((gap) => ({
    code: gap.kind === "not-adopted" ? "KNOWLEDGE_NOT_ADOPTED" : "KNOWLEDGE_UNTYPED",
    severity: "warning",
    file: toPosix(relative(projectRoot, join(scaffoldRoot, gap.file))),
    line: null,
    message: gap.message,
  }));
}
