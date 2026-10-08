import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { inventoryScaffold } from "../migration/inventory.js";
import { diagnostic } from "../model/diagnostic.js";
import { WIKI_ENTITY_TYPES } from "../model/entity.js";
import { planOperationBatch, applyPlannedOperationBatch } from "../operations/batch.js";
import { isReadOnlyPath } from "../operations/paths.js";
import { resolveGrounding } from "../grounding/resolve.js";
import { entityContentHash } from "../model/hash.js";
import { entityTextOf } from "../markdown/codec.js";
import type { WikiWriteOptions } from "./write.js";
import type { ServiceResult } from "./read.js";

export interface SectionLinksData {
  links: { source: string; target: string; file: string }[];
  applied: boolean;
  changedFiles: string[];
}

/** Explicit structural repair. No semantic dependencies or code baselines are inferred. */
export function wikiLinkSections(options: WikiWriteOptions & { apply?: boolean }): ServiceResult<SectionLinksData> {
  const data: SectionLinksData = { links: [], applied: false, changedFiles: [] };
  const inventory = inventoryScaffold(options);
  const diagnostics = [...inventory.diagnostics, ...inventory.files.flatMap(file => file.parsed.diagnostics)];
  const entries = inventory.files.flatMap(file => file.parsed.entities);
  const counts = new Map<string, number>();
  for (const { entity } of entries) counts.set(entity.id, (counts.get(entity.id) ?? 0) + 1);
  if ([...counts.values()].some(count => count > 1)) {
    diagnostics.push(diagnostic("DUPLICATE_ENTITY_ID", "Resolve duplicate identities before linking sections."));
  }
  if (diagnostics.some(item => item.severity === "error")) return { data, diagnostics };
  const envelopes = [];
  const timestamp = new Date().toISOString();
  for (const file of inventory.files) {
    if (isReadOnlyPath(file.path, options.readOnly ?? [])) continue;
    const physicalPath = relative(realpathSync(options.scaffoldRoot), realpathSync(file.absolutePath)).replaceAll("\\", "/");
    if ([file.path, physicalPath].some(path => path.startsWith("specs/"))) continue;
    if (file.parsed.entities.some(({ entity }) =>
      ["spec", "requirement", "constraint", "acceptance_criterion"].includes(entity.type))) continue;
    const eligible = file.parsed.entities.filter(({ entity }) =>
      (WIKI_ENTITY_TYPES as readonly string[]).includes(entity.type)
      && !["spec", "requirement", "constraint", "acceptance_criterion"].includes(entity.type)
      && entity.status !== "archived");
    const root = eligible.find(entry => entry.metadataKind === "frontmatter");
    for (const child of eligible) {
      if (child.metadataKind !== "comment") continue;
      // An intervening unannotated heading ends a possible enclosing section.
      const parent = [...eligible].reverse().find(candidate => candidate.metadataKind === "comment"
        && candidate.entity.location!.headingStart < child.entity.location!.headingStart
        && candidate.entity.location!.headingDepth < child.entity.location!.headingDepth
        && !file.headings.some(heading => heading.start > candidate.entity.location!.headingStart
          && heading.start < child.entity.location!.headingStart
          && heading.depth <= candidate.entity.location!.headingDepth)) ?? root;
      if (!parent || parent.entity.id === child.entity.id) continue;
      if (child.entity.relations.some(relation => relation.target === parent.entity.id)) continue;
      const link = { source: child.entity.id, target: parent.entity.id, file: file.path };
      data.links.push(link);
      const token = createHash("sha256").update(`${link.source}:${link.target}:${child.entity.revision}`).digest("hex").slice(0, 24);
      envelopes.push({ opId: `sections_${token}`, type: "add-relation", entityId: link.source,
        baseRevision: child.entity.revision,
        baseContentHash: entityContentHash(entityTextOf(file.text, child.entity.location!)),
        actor: { kind: "system", id: "wiki-link-sections" }, timestamp,
        reason: "Connect an existing section to its authored enclosing knowledge",
        payload: { relation: { type: "refines", target: link.target,
          note: `Section of ${parent.entity.title} in ${file.path}` } } });
      if (envelopes.length > 500) return { data: { ...data, links: [] }, diagnostics: [
        diagnostic("INVALID_OPERATION_PAYLOAD", "Section repair exceeds 500 links; narrow wiki.exclude before applying.") ] };
    }
  }
  if (!envelopes.length) return { data, diagnostics };
  const planned = planOperationBatch(envelopes, options);
  diagnostics.push(...planned.diagnostics);
  if (!planned.ok || !options.apply) return { data, diagnostics };
  const graph = options.graph;
  const applied = applyPlannedOperationBatch(planned.plan, { ...options,
    expectedPreviewRevision: planned.plan.previewRevision,
    ...(graph ? { resolveGrounding: (grounding, context) => resolveGrounding(grounding, graph, context) } : {}),
  });
  diagnostics.push(...applied.diagnostics);
  data.applied = applied.ok;
  data.changedFiles = applied.changedFiles;
  return { data, diagnostics };
}
