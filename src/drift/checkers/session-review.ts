import { join, relative } from "node:path";
import { loadFlags } from "../../context/flags.js";
import { loadContextIndex } from "../../context/index-file.js";
import { toPosix } from "../../paths.js";
import type { DriftIssue } from "../../types.js";

/**
 * Entities an agent session touched that nobody outside the session has
 * reviewed, from the checkout-local session flags (`.mex/local/context-flags.json`).
 *
 * Two kinds, both `GROUNDING_REVIEW` warnings: entities still flagged (the
 * session changed their code and nobody vouched for them), and entities the
 * settle worker re-recorded on the session's word (a prose edit or
 * `mex context confirm` inside the session). A re-record makes the links
 * current, so the body-hash checks fall silent while the prose may still be
 * wrong; this keeps the entity visible until its prose is revised (by
 * `mex sync`) or someone confirms it. Read-only.
 */
export function checkSessionReview(projectRoot: string, scaffoldRoot: string): DriftIssue[] {
  const localDir = join(scaffoldRoot, "local");
  const flags = loadFlags(localDir);
  if (Object.keys(flags.entities).length === 0 && Object.keys(flags.review).length === 0) return [];
  const source = (file: string): string => toPosix(relative(projectRoot, join(scaffoldRoot, file)));
  // The entity's current code links, as the context index last resolved them, so a reviewer starts from the code.
  const entities = new Map((loadContextIndex(localDir).index?.entities ?? []).map((entity) => [entity.id, entity]));
  const links = (id: string): string => {
    const symbols = entities.get(id)?.symbols ?? [];
    return symbols.length === 0 ? "" : `; current links: ${symbols.slice(0, 6).map((s) => `#${s.name} ${s.file}:${s.start}-${s.end}`).join(", ")}${symbols.length > 6 ? ", …" : ""}`;
  };
  const issues: DriftIssue[] = [];
  for (const [id, entry] of Object.entries(flags.entities)) {
    issues.push({
      code: "GROUNDING_REVIEW",
      severity: "warning",
      file: source(entry.file),
      line: entry.line,
      message: `A session changed the code this entity describes and nobody has re-checked it (${entry.why}): review the prose, rewrite it if it is now false, or run \`mex context confirm ${id}\`${links(id)}; entity: ${id} "${entry.title}"`,
      entity: { id, title: entry.title },
    });
  }
  for (const [id, mark] of Object.entries(flags.review)) {
    if (flags.entities[id] !== undefined) continue;
    issues.push({
      code: "GROUNDING_REVIEW",
      severity: "warning",
      file: source(mark.file),
      line: mark.line,
      message: `Code links re-recorded after a session on the session's ${mark.basis === "edited" ? "own prose edit" : "confirmation"} (${mark.why}); nobody else has reviewed the prose: rewrite it if it is now false, or run \`mex context confirm ${id}\`${links(id)}; entity: ${id} "${mark.title}"`,
      entity: { id, title: mark.title },
    });
  }
  return issues;
}
