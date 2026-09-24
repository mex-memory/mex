import type { DriftIssue, ScaffoldFrontmatter } from "../../types.js";
import { groundingShape } from "../../markdown.js";

const FIX = "Any `mex ground` write or `mex wiki migrate` consolidates it under `mex.grounds_to`.";

/**
 * Report a file that keeps groundings both at the root and under `mex:` (#226).
 *
 * Both are read — the grounding checker sees their union — so this is not a
 * missed grounding, only a second store that the next write will fold into
 * the first. That is why it is info. A node the two keys ground differently is
 * a warning: the checker uses the `mex.grounds_to` entry, and the root one is
 * an authored claim nobody is checking until a person picks one.
 *
 * Needs no graph. The shape is a fact about the Markdown, so it is reported on
 * a fresh clone and in CI exactly as it is with an index.
 */
export function checkGroundingShape(frontmatter: ScaffoldFrontmatter | null, source: string): DriftIssue[] {
  const shape = groundingShape(frontmatter);
  if (!shape.mixed) return [];
  if (shape.conflicts.length > 0) {
    const nodes = [...new Set(shape.conflicts.map((entry) => entry.node))].join(", ");
    return [{
      code: "GROUNDING_MIXED_SHAPE",
      severity: "warning",
      file: source,
      line: null,
      message: `Root \`grounds_to\` and \`mex.grounds_to\` ground the same node differently: ${nodes}. ` +
        "The `mex.grounds_to` entry is checked; keep the right one and delete the other.",
    }];
  }
  return [{
    code: "GROUNDING_MIXED_SHAPE",
    severity: "info",
    file: source,
    line: null,
    message: `Groundings are split between a root \`grounds_to\` and \`mex.grounds_to\`; both are checked. ${FIX}`,
  }];
}
