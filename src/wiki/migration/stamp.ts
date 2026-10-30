/**
 * Give a knowledge file its file-level entity id without migrating its prose (#286).
 *
 * ## Why this is not migration
 *
 * Migration converts a scaffold someone already wrote: it decides which
 * headings are entities, and abstains where nothing structural says. Setup's
 * own templates need none of that. They are known files with known types, and
 * the Wiki should exist from the moment setup places them, so that a fact the
 * population agent creates has a parent to `refine` and `link-sections` has a
 * root to link to. Running the legacy converter over those templates at the end
 * of setup is what left facts orphaned and printed migration notices about
 * files setup itself had just written.
 *
 * A stamp is one `create-entry` adopting the file, and nothing else. Headings
 * are never adopted here: once a file carries its own entity, adopting a
 * heading inside it would shorten that entity's body, which the operation
 * layer refuses by design. That is why a file whose entries should become
 * entities from its prose (the decision log) is stamped only after migration
 * has adopted them.
 *
 * ## Through the operation pipeline, like every other write
 *
 * The stamps are planned and applied as one batch through P5, so containment,
 * `wiki.readOnly`, the audit log and the all-or-nothing rollback hold exactly
 * as they do for migration and `link-sections`.
 */
import { createHash } from "node:crypto";
import type { WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityTypeRegistry, WikiEntityType } from "../model/entity.js";
import type { AbsorbableRootKey, WikiActor } from "../model/operation.js";
import { isTeamOwnedReadOnlyPath } from "../model/team-owned-paths.js";
import { exactFileContentHash } from "../model/hash.js";
import { applyPlannedOperationBatch, planOperationBatch } from "../operations/batch.js";
import { isReadOnlyPath } from "../operations/paths.js";
import { DECLARABLE_FILE_TYPES, NON_KNOWLEDGE_FILES, fileTitleOf, roleFor } from "./classify.js";
import { inventoryScaffold, type InventoryFile } from "./inventory.js";

export interface StampOptions {
  scaffoldRoot: string;
  /**
   * Which files to consider.
   *
   * `placed`: every eligible file in `paths`, typed by its path rule or its
   * declaration. For templates setup has just written.
   *
   * `remaining`: only files migration will not give an id to. A file that
   * already holds entities but no file-level one (migration skips it as
   * adopted), and a file under `context/` or `patterns/` with no type rule and
   * no declaration (migration abstains on it), which takes its folder's type.
   * Every other file is left for migration, which adopts its sections too.
   */
  scope: "placed" | "remaining";
  /** Scaffold-relative POSIX paths; all files when absent. */
  paths?: readonly string[];
  exclude?: readonly string[];
  readOnly?: readonly string[];
  registry?: EntityTypeRegistry;
  actor?: WikiActor;
  now?: () => string;
}

export interface StampedFile {
  file: string;
  type: WikiEntityType;
}

export interface StampResult {
  stamped: StampedFile[];
  applied: boolean;
  diagnostics: WikiDiagnostic[];
}

const SPEC_FAMILY = ["spec", "requirement", "constraint", "acceptance_criterion"];

/** The type a folder gives a file nothing else types, for the `remaining` scope. */
function folderType(path: string): WikiEntityType | null {
  if (path.startsWith("patterns/")) return "pattern";
  if (/^context\/[^/]+\.mdx?$/iu.test(path)) return "component";
  return null;
}

/** The file-level type to stamp, or null when this file is not stamped. */
export function stampTypeOf(file: InventoryFile, scope: StampOptions["scope"]): WikiEntityType | null {
  const path = file.path;
  if (isTeamOwnedReadOnlyPath(path) || Object.hasOwn(NON_KNOWLEDGE_FILES, path) || path.startsWith("specs/")) return null;
  if (file.parsed.diagnostics.some((entry) => entry.severity === "error")) return null;
  // The file-level entity lives in frontmatter; a file without any is not
  // given one, for the reason migration gives (bytes above unowned prose).
  if (file.parsed.frontmatter === null || fileTitleOf(file) === null) return null;
  const entities = file.parsed.entities;
  if (entities.some((entry) => entry.metadataKind === "frontmatter")) return null;
  if (entities.some((entry) => SPEC_FAMILY.includes(entry.entity.type))) return null;
  // Even a partially populated log must adopt its remaining decisions before
  // its container. Facts alone do not mean those prose entries were adopted.
  if (path === "context/decisions.md") return null;

  const role = roleFor(path);
  const declared = file.parsed.legacy.type;
  const declaredType = typeof declared === "string" && (DECLARABLE_FILE_TYPES as readonly string[]).includes(declared)
    ? declared as WikiEntityType
    : null;
  // A declaration that disagrees with the path rule, or is not a type at all,
  // is migration's to report; stamping either way would pick a side.
  if (declared !== undefined && (declaredType === null || (role !== null && role.fileType !== declaredType))) return null;
  // A register whose entries are the entities (risks) gets no file-level one.
  if (role !== null && role.fileType === null) return null;
  const ruled = role?.fileType ?? declaredType;

  if (scope === "placed") return ruled;
  if (entities.length > 0) return ruled ?? folderType(path);
  return ruled === null ? folderType(path) : null;
}

/** A fresh operation id per attempt: a stamp's idempotency is the id already on the file. */
function stampOpId(file: InventoryFile, timestamp: string): string {
  const digest = createHash("sha256")
    .update(`mex-stamp\u0000${file.path}\u0000${exactFileContentHash(file.text)}\u0000${timestamp}`, "utf8")
    .digest("hex");
  return `stamp_${digest.slice(0, 40)}`;
}

/** Stamp each eligible file with its file-level entity, in one all-or-nothing batch. */
export function stampScaffoldFiles(options: StampOptions): StampResult {
  const inventory = inventoryScaffold({
    scaffoldRoot: options.scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const selected = options.paths === undefined ? null : new Set(options.paths);
  const timestamp = options.now?.() ?? new Date().toISOString();
  const actor = options.actor ?? { kind: "system", id: "mex-setup" };
  const stamped: StampedFile[] = [];
  const envelopes: unknown[] = [];
  for (const file of inventory.files) {
    if (selected !== null && !selected.has(file.path)) continue;
    if (isReadOnlyPath(file.path, options.readOnly ?? [])) continue;
    const type = stampTypeOf(file, options.scope);
    if (type === null) continue;
    // A root `type` moves under `mex.type`; leaving it would store the type twice.
    const absorbRootKeys: AbsorbableRootKey[] = file.parsed.legacy.type === undefined ? [] : ["type"];
    envelopes.push({
      opId: stampOpId(file, timestamp),
      type: "create-entry",
      actor,
      timestamp,
      reason: "Give a knowledge file its Wiki id",
      payload: {
        file: file.path,
        adopt: { at: "file", ...(absorbRootKeys.length === 0 ? {} : { absorbRootKeys }) },
        type,
        title: fileTitleOf(file)!,
        status: "promoted",
      },
    });
    stamped.push({ file: file.path, type });
  }
  if (envelopes.length === 0) return { stamped: [], applied: true, diagnostics: [] };
  const planOptions = {
    scaffoldRoot: options.scaffoldRoot,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  };
  const planned = planOperationBatch(envelopes, planOptions);
  if (!planned.ok) return { stamped: [], applied: false, diagnostics: [...planned.diagnostics] };
  const applied = applyPlannedOperationBatch(planned.plan, {
    ...planOptions,
    expectedPreviewRevision: planned.plan.previewRevision,
  });
  return {
    stamped: applied.ok ? stamped : [],
    applied: applied.ok,
    diagnostics: [...planned.diagnostics, ...applied.diagnostics],
  };
}
