/**
 * Section 13.4 — the legacy fields, and which of them migration may translate.
 *
 * ## `edges` is live infrastructure, so conversion is additive
 *
 * The natural reading of "translate unambiguous `edges` to `related_to`" is
 * that converted edges are removed. That reading breaks shipped behaviour:
 * `src/drift/checkers/edges.ts` validates every frontmatter edge and reports
 * broken targets, `src/drift/checkers/stale-pattern.ts` calls them "mex's
 * canonical navigation" and walks them to decide whether a pattern is
 * reachable, and `src/setup/prompts.ts` instructs agents to write and maintain
 * them. Deleting them empties a shipped navigation graph and silences a shipped
 * drift check, in exchange for a relation the wiki gets anyway.
 *
 * **So the root `edges` key stays exactly as it was**, and the entity gains a
 * `related_to`. The spec never says delete; it says translate and retain. It
 * also keeps migration insertion-only for this case, which is a good sign it is
 * the right reading.
 *
 * ## What "unambiguous" means on each side, and why they differ
 *
 * An edge has two ends and they ask different questions.
 *
 * - **Source.** The edge lives in a file's frontmatter, so it is the *file's*
 *   fact. It needs a file-level entity to belong to. A file that yields only
 *   block entities has no entity the edge is about, and picking one would be
 *   the guess section 13.1 forbids.
 * - **Target.** The edge says "open that file". A target file resolves when it
 *   has a file-level entity — the file-level entity *is* the document — or when
 *   it yields exactly one entity of any kind.
 *
 * A **grounding** is a claim that *this prose* is implemented by *that code*,
 * and a root `grounds_to` is frontmatter: a claim the file makes about itself,
 * with nothing in it naming a section. So it moves to the **file-level** entity
 * whenever the file has or gets one, however many section entities sit beside
 * it, and it is **never** attributed to a section entity (#226).
 *
 * This used to be stricter: a root `grounds_to` moved only when the file
 * yielded exactly one entity, on the reasoning that attaching it to a parent
 * with section children claimed it described the parent rather than a child.
 * But the file-level entity is the whole document, which is what the author
 * put it on, and refusing left it at the root beside a new `mex:` map. Setup
 * produced exactly that on every multi-entity file it populated, and the Wiki
 * then dropped those groundings. Attaching to the file-level entity narrows
 * "never guesses" rather than abandoning it: the only guess refused was ever
 * which *section*, and that is still refused. A file with only section
 * entities keeps its root groundings, reported and unattributed.
 *
 * A file adopted before this rule is folded the same way: its root groundings
 * move into the existing file-level entity's `mex.grounds_to`, as a move of
 * values already in the file, never re-derived from the graph.
 */
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityId } from "../model/ids.js";
import type { WikiGrounding } from "../model/grounding.js";
import type { LegacyEdge } from "../markdown/contract.js";
import { rootGroundingsNotInEffect } from "../markdown/grounding-stores.js";
import type { GroundingGraph } from "../grounding/adapter.js";
import type { InventoryFile, ScaffoldInventory } from "./inventory.js";
import { ALREADY_ADOPTED_REASON, type Candidate, type FileClassification } from "./classify.js";

/** Frontmatter keys migration preserves untouched. Section 13.4's first bullet. */
export const PRESERVED_LEGACY_KEYS = ["name", "description", "triggers", "last_updated", "edges"] as const;

/** What one file's entities look like once this run has adopted them. */
export interface FileOutcome {
  path: string;
  /** The file-level entity's id, when the file gets one. */
  fileEntity: EntityId | null;
  /** Every entity id the file will hold, adopted or already present. */
  entities: EntityId[];
}

/** An edge that became a relation. */
export interface ConvertedEdge {
  sourceFile: string;
  sourceEntity: EntityId;
  target: EntityId;
  targetFile: string;
  /** The edge's `condition`, which becomes the relation's `note`. */
  note?: string;
  /** Index within the file's `edges` array, so the opId is stable. */
  index: number;
}

export interface LegacyPlan {
  converted: ConvertedEdge[];
  diagnostics: WikiDiagnostic[];
}

/** Resolve one edge target to a single entity, or say why it cannot. */
export function resolveEdgeTarget(outcomes: Map<string, FileOutcome>, target: string): EntityId | null {
  const outcome = outcomes.get(normalizeTarget(target));
  if (outcome === undefined) return null;
  if (outcome.fileEntity !== null) return outcome.fileEntity;
  return outcome.entities.length === 1 ? (outcome.entities[0] ?? null) : null;
}

/** Edge targets are written scaffold-relative, sometimes with a leading `./`. */
function normalizeTarget(target: string): string {
  return target.replace(/^\.\//, "").replace(/\\/g, "/").trim();
}

/**
 * Which edges convert, and which are reported.
 *
 * Runs over the **whole** scaffold's outcomes, never one file's, because an
 * edge's target is another file: finding 29's blast radius applied to a
 * migration that mints ids and converts references in the same run. Every id
 * has to exist before any edge is resolved, so this is a second pass by
 * construction rather than by discipline.
 */
export function planLegacyEdges(
  inventory: ScaffoldInventory,
  outcomes: Map<string, FileOutcome>,
): LegacyPlan {
  const converted: ConvertedEdge[] = [];
  const diagnostics: WikiDiagnostic[] = [];

  for (const file of inventory.files) {
    const edges = file.parsed.legacy.edges;
    if (edges.length === 0) continue;

    const outcome = outcomes.get(file.path);
    const source = outcome?.fileEntity ?? null;
    if (source === null) {
      diagnostics.push(
        diagnostic(
          "AMBIGUOUS_MIGRATION",
          `${file.path} carries ${edges.length} legacy edge(s) but has no file-level entity to own them. ` +
            "The edges are navigation for the file as a whole; attributing them to one of its sections " +
            "would be a guess. They are preserved as they are.",
          { file: file.path },
        ),
      );
      continue;
    }
    const existingRelations = file.parsed.entities.find((entry) => entry.entity.id === source)?.entity.relations ?? [];

    edges.forEach((edge, index) => {
      const target = resolveEdgeTarget(outcomes, edge.target);
      if (target === null) {
        diagnostics.push(
          diagnostic(
            "AMBIGUOUS_MIGRATION",
            `${file.path}: the edge to ${edge.target} does not resolve to exactly one entity. ` +
              "The edge is preserved and no relation was written.",
            { file: file.path, entityId: source },
          ),
        );
        return;
      }
      if (target === source) return;
      // An operation-id replay is not the only way this conversion can already
      // be settled: a human or agent may have authored the same canonical pair.
      // Relation identity is type + target, so preserve its existing note and
      // metadata rather than retrying under migration's different operation id.
      if (existingRelations.some((relation) => relation.type === "related_to" && relation.target === target)) return;
      converted.push({
        sourceFile: file.path,
        sourceEntity: source,
        target,
        targetFile: normalizeTarget(edge.target),
        ...(edge.condition === undefined ? {} : { note: edge.condition }),
        index,
      });
    });
  }

  return { converted, diagnostics };
}

export interface GroundingPlan {
  /** Groundings to move under `mex.grounds_to`, keyed by file. */
  moved: Map<string, WikiGrounding[]>;
  /**
   * Files adopted by an earlier run whose root `grounds_to` folds into their
   * existing file-level entity (#226), keyed by file. `groundsTo` is that
   * entity's grounding set as the codec reads it, root entries included.
   */
  absorbed: Map<string, { entityId: EntityId; groundsTo: WikiGrounding[]; count: number }>;
  diagnostics: WikiDiagnostic[];
}

/**
 * Decide, per file, whether a root `grounds_to` may move.
 *
 * `backfill` upgrades each entry with a `bodyHash` re-derived from the live
 * graph where the node still resolves (finding 39), and leaves it **absent**
 * where it does not, rather than fabricating one — a wrong body hash is what
 * every future drift verdict is measured against, so an invented one poisons
 * resolution permanently.
 *
 * These groundings are not minted, they are relocated: the pair was already in
 * the scaffold, written by a previous `mex ground`. So section 12.4's
 * re-derivation requirement, which governs *new* groundings, is not what
 * applies here; moving a fact is not asserting a new one.
 *
 * A file that already has a file-level entity is folded without `backfill`:
 * the codec already reads those groundings as the entity's, so the move must
 * leave them exactly as they read. Its root entries that are not in effect —
 * conflicting with the entity's own `mex.grounds_to`, or rejected by the
 * grounding validator — stay at the root and are reported, because choosing
 * between two authored values for one node, or repairing a malformed one, is
 * a decision migration does not make.
 */
export function planGroundingMoves(
  inventory: ScaffoldInventory,
  classifications: Map<string, FileClassification>,
  candidatesFor: (path: string) => Candidate[],
  graph: GroundingGraph | null,
): GroundingPlan {
  const moved = new Map<string, WikiGrounding[]>();
  const absorbed: GroundingPlan["absorbed"] = new Map();
  const diagnostics: WikiDiagnostic[] = [];

  for (const file of inventory.files) {
    const groundings = file.parsed.legacy.groundsTo;
    if (groundings.length === 0) continue;

    const adopted = file.parsed.entities.find((entry) => entry.metadataKind === "frontmatter");
    if (adopted !== undefined) {
      // Any other skip — a Team-owned path, a non-knowledge file — means the
      // file is not migration's to write, so nothing here touches it.
      if (classifications.get(file.path)?.skipReason !== ALREADY_ADOPTED_REASON) continue;
      const kept = rootGroundingsNotInEffect(adopted.entity.groundsTo, groundings);
      if (kept.length > 0) {
        diagnostics.push(
          diagnostic(
            "AMBIGUOUS_MIGRATION",
            `${file.path} has root \`grounds_to\` entries for ${[...new Set(kept.map((entry) => entry.node))].join(", ")} ` +
              "that are not in effect: each conflicts with `mex.grounds_to` or is malformed. They are preserved " +
              "at the root; keep the right entry under `mex.grounds_to` and delete the root one.",
            { file: file.path, entityId: adopted.entity.id },
          ),
        );
      }
      if (kept.length < groundings.length) {
        absorbed.set(file.path, {
          entityId: adopted.entity.id,
          groundsTo: adopted.entity.groundsTo,
          count: groundings.length - kept.length,
        });
      }
      continue;
    }

    const fileLevel = candidatesFor(file.path).find((candidate) => candidate.target.at === "file");
    if (fileLevel === undefined) {
      diagnostics.push(
        diagnostic(
          "AMBIGUOUS_MIGRATION",
          `${file.path} carries a root \`grounds_to\` but has no file-level entity to own it. A grounding ` +
            "claims that particular prose is implemented by particular code, and nothing here says which " +
            "section it describes. It is preserved at the root and left unattributed.",
          { file: file.path },
        ),
      );
      continue;
    }

    moved.set(file.path, groundings.map((grounding) => backfill(grounding, graph)));
  }

  return { moved, absorbed, diagnostics };
}

/** Add a `bodyHash` the graph can re-derive; never invent one. */
export function backfill(grounding: WikiGrounding, graph: GroundingGraph | null): WikiGrounding {
  if (grounding.bodyHash !== undefined || graph === null) return grounding;
  const node = graph.getNode(grounding.node);
  if (node === null || node.bodyHash === null) return grounding;
  return { ...grounding, bodyHash: node.bodyHash };
}

/** Every legacy key a file carries that migration neither converts nor preserves by name. */
export function unrecognizedKeys(file: InventoryFile): string[] {
  const frontmatter = file.parsed.frontmatter;
  if (frontmatter === null) return [];
  const known = new Set<string>([...PRESERVED_LEGACY_KEYS, "grounds_to", "mex"]);
  return frontmatter.keys.filter((key) => !known.has(key));
}
