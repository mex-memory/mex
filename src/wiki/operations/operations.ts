/**
 * §11.2 — what each of the eleven operations actually changes, as byte ranges.
 *
 * Every one of them returns edits in its file's original coordinates and
 * nothing here writes or applies anything. Three things are deliberately *not*
 * asserted in this module, because `plan.ts` asserts them once for all eleven
 * rather than eleven times with eleven chances to forget:
 *
 * - that the produced text differs only inside the declared ranges
 *   (`applyEdits`);
 * - that no entity the operation did not name changed (`verifyPlan`) — which is
 *   §11.2's "cannot alter adjacent entities", "changes only the source entity
 *   metadata" and "insertion must not overwrite existing prose", all of them,
 *   proven the same way;
 * - that the target is neither read-only nor outside the scaffold.
 *
 * What *is* here is the semantics: which key, which range, which revision.
 */

import { generateEntityId, type EntityId } from "../model/ids.js";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type {
  InsertionPoint,
  WikiOperation,
  CreateEntryPayload,
} from "../model/operation.js";
import { sourceIdentity, type WikiSource } from "../model/source.js";
import { authoringSourceCollectionFits, validateAuthoringProvenance } from "../model/authoring-evidence.js";
import type { WikiRelationRef } from "../model/relation.js";
import type { WikiEntity, WikiLifecycleState, WikiProvenance } from "../model/entity.js";
import type { WikiGrounding } from "../model/grounding.js";
import { deriveVerifiedGroundings } from "../grounding/provenance.js";
import type { PatchEdit } from "../markdown/patch.js";
import YAML from "yaml";
import { keyPathEdit, keyPathRemoveEdit, renderKeyValues } from "../markdown/frontmatter.js";
import { rootGroundingsNotInEffect } from "../markdown/grounding-stores.js";
import { entityTextOf } from "../markdown/codec.js";
import { parseDocument } from "../markdown/parse.js";
import { entityContentHash } from "../model/hash.js";
import {
  METADATA_KEYS,
  bodyEdit,
  dominantEol,
  headingEdits,
  metadataEdit,
  targetOf,
  withEol,
  type MetadataTarget,
} from "./entity-edits.js";
import type { LocatedEntity, LocatedFile } from "./locate.js";
import type { EntityPrecondition, PlanOptions, RevisionChange } from "./plan.js";

export interface FileEdits {
  path: string;
  absolutePath: string;
  baseText: string;
  existed: boolean;
  edits: PatchEdit[];
}

export interface OperationEdits {
  files: FileEdits[];
  entityIds: EntityId[];
  createdIds: EntityId[];
  preconditions: EntityPrecondition[];
  revisions: RevisionChange[];
  diagnostics: WikiDiagnostic[];
}

export interface OperationContext {
  options: PlanOptions;
  scaffoldRoot: string;
  /** The subject, already located. Null for `create-entry`. */
  located: LocatedEntity | null;
  /** Explicit operation authority, used only when this writer opted in. */
  creationProvenance?: WikiProvenance;
  mintId: () => EntityId;
  locate: (path: string) => LocatedFile | null;
  locateEntity: (id: string) => LocatedEntity | null;
}

function reject(code: Parameters<typeof diagnostic>[0], message: string, entityId?: string): OperationEdits {
  return {
    files: [],
    entityIds: [],
    createdIds: [],
    preconditions: [],
    revisions: [],
    diagnostics: [diagnostic(code, message, entityId === undefined ? {} : { entityId })],
  };
}

/** The precondition an entity is at right now, for apply-time revalidation. */
function preconditionFor(located: LocatedEntity): EntityPrecondition {
  return {
    entityId: located.entity.id,
    file: located.path,
    revision: located.entity.revision,
    entityContentHash: entityContentHash(entityTextOf(located.text, located.entity.location)),
  };
}

/**
 * Turn a set of field changes into non-overlapping edits.
 *
 * Fields that already exist are replaced where they are. Fields that do not
 * are **appended as one edit**, not several: two independent insertions at the
 * end of the same map would declare two zero-width ranges at one offset, which
 * is a shape the scope check should never be asked to reason about.
 */
function metadataEdits(
  text: string,
  target: MetadataTarget,
  fields: readonly (readonly [string, unknown])[],
): PatchEdit[] | null {
  const edits: PatchEdit[] = [];
  const appended: (readonly [string, unknown])[] = [];

  for (const [key, value] of fields) {
    const edit = metadataEdit(text, target, key, value);
    if (edit === null) return null;
    if (edit.end > edit.start) edits.push(edit);
    else appended.push([key, value]);
  }

  if (appended.length > 0) {
    const one = metadataEdit(text, target, appended[0]![0], appended[0]![1]);
    if (one === null) return null;
    const eol = dominantEol(text);
    const indent = /^[\r\n]*([ \t]*)/.exec(one.text)?.[1] ?? "";
    const rest = renderKeyValues(appended.slice(1), eol)
      .split(eol)
      .map((line) => (line === "" ? line : `${indent}${line}`))
      .join(eol);
    edits.push({ ...one, text: appended.length === 1 ? one.text : `${one.text}${eol}${rest}` });
  }

  return edits;
}

/** Change fields on the located subject, bumping its revision. */
function mutateSubject(
  context: OperationContext,
  fields: readonly (readonly [string, unknown])[],
  extra: readonly PatchEdit[] = [],
  bumpRevision = true,
): OperationEdits {
  const located = context.located!;
  const target = targetOf(located);
  if (target === null) {
    return reject("WIKI_PARSE_ERROR", `Could not locate the metadata block for ${located.entity.id} in ${located.path}.`, located.entity.id);
  }

  const before = located.entity.revision;
  const after = bumpRevision ? before + 1 : before;
  const all = bumpRevision ? [...fields, [METADATA_KEYS.revision, after] as const] : fields;

  const edits = metadataEdits(located.text, target, all);
  if (edits === null) {
    return reject("WIKI_PARSE_ERROR", `${located.path} does not hold a writable metadata map for ${located.entity.id}.`, located.entity.id);
  }

  return {
    files: [
      {
        path: located.path,
        absolutePath: located.absolutePath,
        baseText: located.text,
        existed: true,
        edits: [...edits, ...extra],
      },
    ],
    entityIds: [located.entity.id],
    createdIds: [],
    preconditions: [preconditionFor(located)],
    revisions: [{ entityId: located.entity.id, before, after }],
    diagnostics: [],
  };
}

// -- insertion ---------------------------------------------------------------

/**
 * Where a new block goes, as an offset into the destination file.
 *
 * Always a **zero-width** position, never a range: that is what makes
 * "insertion must not overwrite existing prose" true by construction rather
 * than by inspection, since the declared range `[o, o)` has an empty
 * intersection with every existing byte.
 */
function insertionOffset(file: LocatedFile, insertAt: InsertionPoint): number | WikiDiagnostic {
  const { text, parsed } = file;

  if (insertAt.at === "end-of-file") return text.length;
  if (insertAt.at === "start-of-file") {
    const frontmatter = parsed.frontmatter;
    if (frontmatter === null) return 0;
    let cursor = frontmatter.range.end;
    while (cursor < text.length && (text.charCodeAt(cursor) === 0x0d || text.charCodeAt(cursor) === 0x0a)) cursor += 1;
    return cursor;
  }

  const anchor = parsed.entities.find((entry) => entry.entity.id === insertAt.entityId);
  if (anchor === undefined) {
    return diagnostic(
      "ENTITY_NOT_FOUND",
      `Cannot insert ${insertAt.at} ${insertAt.entityId}: it is not in ${file.path}.`,
      { file: file.path, entityId: insertAt.entityId },
    );
  }
  return insertAt.at === "before-entity" ? anchor.entity.location.metadataStart : anchor.entity.location.bodyEnd;
}

/** Count line terminators at the tail of `text`, as whole terminators. */
function trailingBreaks(text: string): number {
  const match = /(?:\r?\n)*$/.exec(text);
  return match === null ? 0 : (match[0].match(/\r?\n/g) ?? []).length;
}

function leadingBreaks(text: string): number {
  const match = /^(?:\r?\n)*/.exec(text);
  return match === null ? 0 : (match[0].match(/\r?\n/g) ?? []).length;
}

/**
 * Pad an inserted block so it sits one blank line from its neighbours.
 *
 * Not cosmetic: a block entity's metadata binds to the next heading only when
 * nothing but blank lines intervene, and a body ends at the next entity's
 * metadata. Inserting without a separating break produces a file that still
 * parses but binds differently — which `verifyPlan` would catch as an adjacent
 * entity changing, but as a confusing failure rather than a correct write.
 */
function paddedInsertion(text: string, offset: number, block: string): string {
  const eol = dominantEol(text);
  const before = text.slice(0, offset);
  const after = text.slice(offset);

  const lead = before.length === 0 ? "" : eol.repeat(Math.max(0, 2 - trailingBreaks(before)));
  // Nothing after it: the block already ends with a terminator, so adding one
  // would leave the file ending on a blank line it did not have before.
  const tail = after.length === 0 ? "" : eol.repeat(Math.max(0, 2 - leadingBreaks(after)));
  return `${lead}${withEol(block, eol)}${tail}`;
}

// -- create-entry ------------------------------------------------------------

/** The metadata fields a new entity carries, in a fixed, readable order. */
function newEntityFields(id: EntityId, payload: CreateEntryPayload): (readonly [string, unknown])[] {
  const headingDepth = payload.headingDepth;
  return [
    ["id", id],
    ["type", payload.type],
    ["status", payload.status ?? "in_flight"],
    ["revision", 1],
    // Omitted when the heading already says it. The codec reads the heading as
    // the title unless metadata overrides it, so writing both puts one fact in
    // two places — and a later `update-entry` that moved only one of them would
    // leave the file showing one title and the index reporting another. A
    // file-level entity has no heading of its own to carry it, so it keeps the
    // key.
    ["title", headingDepth === undefined ? payload.title : undefined],
    ["summary", payload.summary],
    [
      METADATA_KEYS.metadata,
      payload.metadata === undefined || Object.keys(payload.metadata).length === 0 ? undefined : payload.metadata,
    ],
    ["topics", payload.topics === undefined || payload.topics.length === 0 ? undefined : payload.topics],
    ["relations", payload.relations === undefined || payload.relations.length === 0 ? undefined : payload.relations],
    ["sources", payload.sources === undefined || payload.sources.length === 0 ? undefined : payload.sources],
    ["provenance", payload.provenance],
    [METADATA_KEYS.groundsTo, payload.groundsTo === undefined || payload.groundsTo.length === 0 ? undefined : payload.groundsTo],
  ];
}

/** Heading plus body, the visible half of an entity. */
function headingAndBody(depth: number, title: string, body: string, eol: string): string {
  const trimmed = body.replace(/[\r\n]+$/, "");
  return `${"#".repeat(depth)} ${title}${eol}${trimmed === "" ? "" : `${eol}${trimmed}${eol}`}`;
}

function createEntry(context: OperationContext, operation: Extract<WikiOperation, { type: "create-entry" }>): OperationEdits {
  return createInto(context, operation.payload, context.mintId());
}

/**
 * Build the edits that add one new entity to a file.
 *
 * Shared by `create-entry` and `supersede-entry`'s inline replacement, so the
 * two cannot come to disagree about what a well-formed new entity looks like.
 */
function createInto(context: OperationContext, payload: CreateEntryPayload, id: EntityId): OperationEdits {
  if (payload.adopt === undefined && payload.provenance === undefined && context.creationProvenance !== undefined) {
    const validated = validateAuthoringProvenance(context.creationProvenance, { path: "provenance" });
    if (!validated.ok) {
      return reject("INVALID_OPERATION_PAYLOAD", "The operation's creation authority must fit the bounded provenance identity and timestamp contract.");
    }
    payload = { ...payload, provenance: context.creationProvenance };
  }
  const file = context.locate(payload.file);
  if (file === null) {
    return reject("WIKI_PARSE_ERROR", `${payload.file} exists but could not be read; refusing to write over it.`);
  }

  // **Already there: this is a resumed create, and the write landed.** A
  // process killed between the rename and the audit's completion line leaves a
  // create that looks un-replayed, and `create-entry` has no precondition that
  // could catch a repeat — so a naive replay mints a *second* entity with a
  // *new* id. Silent knowledge duplication, produced by implementing §11.3
  // exactly as written. The resume reuses the id its intent line recorded, and
  // finding that id already present means the remaining work is none.
  if (file.parsed.entities.some((entry) => entry.entity.id === id)) {
    return { files: [], entityIds: [], createdIds: [id], preconditions: [], revisions: [], diagnostics: [] };
  }

  if (payload.adopt !== undefined) return adoptInto(file, payload, payload.adopt, id);

  // **§12.4, on the operation that mints rather than moves.** `set-grounding`
  // has always re-derived what it is asked to write; `create-entry` wrote its
  // `groundsTo` straight into metadata, so the one invariant that says an agent
  // may not invent a node id had a hole in the operation an agent reaches for
  // first. P8 is its first caller and the first to reach it.
  //
  // `adopt` is deliberately not covered by this and is not an oversight: an
  // adoption *moves* values that are already in the user's Markdown, and a
  // missing graph fails every grounding by design (§38), so verifying there
  // would delete a legacy grounding from a checkout with no graph rather than
  // preserve it. The residue is recorded as a finding rather than closed here,
  // because narrowing adoption is a change to migration's contract.
  if (payload.groundsTo !== undefined && payload.groundsTo.length > 0) {
    const derived = deriveVerifiedGroundings(payload.groundsTo, context.options.graph ?? null);
    if (!derived.ok) {
      return { files: [], entityIds: [], createdIds: [], preconditions: [], revisions: [], diagnostics: derived.diagnostics };
    }
    payload = { ...payload, groundsTo: derived.groundings.map((entry) => ({ ...entry })) };
  }

  const insertAt = payload.insertAt;
  if (insertAt === undefined) {
    return reject("INVALID_OPERATION_PAYLOAD", "create-entry needs exactly one of `insertAt` or `adopt`.");
  }
  const offset = insertionOffset(file, insertAt);
  if (typeof offset !== "number") {
    return { files: [], entityIds: [], createdIds: [], preconditions: [], revisions: [], diagnostics: [offset] };
  }

  const eol = dominantEol(file.text.length === 0 ? "\n" : file.text);
  const fields = newEntityFields(id, payload);
  const edits: PatchEdit[] = [];
  // The validator requires a body whenever `insertAt` is used; the fallback is
  // for the type, not for a case that reaches here.
  const body = payload.body ?? "";

  if (payload.headingDepth === undefined) {
    // File-level: metadata is the frontmatter `mex` key, which may have to be
    // created along with the block that holds it.
    if (file.parsed.entities.some((entry) => entry.metadataKind === "frontmatter")) {
      return reject(
        "INVALID_OPERATION_PAYLOAD",
        `${payload.file} already has a file-level entity; a file's frontmatter holds exactly one \`mex:\` key.`,
      );
    }
    const map = Object.fromEntries(fields.filter(([, value]) => value !== undefined));
    const rendered = renderKeyValues([["mex", map]], eol);
    const frontmatter = file.parsed.frontmatter;
    if (frontmatter === null) {
      edits.push({ start: 0, end: 0, text: `---${eol}${rendered}${eol}---${eol}${file.text.length > 0 ? eol : ""}`, label: `frontmatter for ${id}` });
    } else {
      const target: MetadataTarget = { region: regionOfFrontmatter(file), prefix: [] };
      const edit = metadataEdit(file.text, target, "mex", map);
      if (edit === null) return reject("WIKI_PARSE_ERROR", `${payload.file} has frontmatter that cannot hold a \`mex\` key.`);
      edits.push(edit);
    }
    const headingOffset = frontmatter === null ? 0 : offset;
    edits.push({
      start: headingOffset,
      end: headingOffset,
      text: paddedInsertion(file.text, headingOffset, headingAndBody(1, payload.title, body, eol)),
      label: `heading and body of ${id}`,
    });
  } else {
    const metadata = `<!-- mex:entity${eol}${renderKeyValues(fields, eol)}${eol}-->`;
    const block = `${metadata}${eol}${headingAndBody(payload.headingDepth, payload.title, body, eol)}`;
    edits.push({
      start: offset,
      end: offset,
      text: paddedInsertion(file.text, offset, block),
      label: `entity ${id}`,
    });
  }

  return {
    files: [{ path: file.path, absolutePath: file.absolutePath, baseText: file.text, existed: file.existed, edits }],
    entityIds: [],
    createdIds: [id],
    preconditions: [],
    revisions: [{ entityId: id, before: 0, after: 1 }],
    diagnostics: [],
  };
}

/**
 * Adopt prose that is already on disk as an entity.
 *
 * The only bytes this contributes are the metadata block. No heading is
 * written, no body is written, and the payload carries neither — so
 * "insertion-only with respect to prose" holds by construction here rather
 * than by a comparison after the fact.
 */
function adoptInto(
  file: LocatedFile,
  payload: CreateEntryPayload,
  adopt: NonNullable<CreateEntryPayload["adopt"]>,
  id: EntityId,
): OperationEdits {
  if (file.parsed.entities.some((entry) => entry.entity.id === id)) {
    return { files: [], entityIds: [], createdIds: [id], preconditions: [], revisions: [], diagnostics: [] };
  }

  const eol = dominantEol(file.text.length === 0 ? "\n" : file.text);
  const edits: PatchEdit[] = [];

  if (adopt.at === "heading") {
    const headings = parseDocument(file.text).headings;
    const heading = headings[adopt.ordinal];
    if (heading === undefined) {
      return reject(
        "AMBIGUOUS_MIGRATION",
        `${file.path} has ${headings.length} heading(s); there is no heading ${adopt.ordinal} to adopt.`,
      );
    }
    if (heading.title !== adopt.text) {
      return reject(
        "AMBIGUOUS_MIGRATION",
        `Heading ${adopt.ordinal} of ${file.path} reads "${heading.title}", not "${adopt.text}". ` +
          "The file moved since this was proposed; re-plan rather than annotating the wrong section.",
      );
    }
    const fields = newEntityFields(id, { ...payload, headingDepth: heading.depth });
    const metadata = `<!-- mex:entity${eol}${renderKeyValues(fields, eol)}${eol}-->`;
    // **Exactly the block and one terminator — never `paddedInsertion`.**
    // Padding is right for `create-entry`, which drops a whole new section into
    // prose and wants a blank line either side of it. Here the heading is
    // already there and already spaced the way its author spaced it, so a
    // padded insertion would add a blank line *between* the metadata and the
    // heading: a character that is neither frontmatter nor part of the block,
    // which is precisely what insertion-only forbids. Verified by the
    // whole-corpus prose property, which fails on the padded form.
    edits.push({
      start: heading.start,
      end: heading.start,
      text: `${metadata}${eol}`,
      label: `metadata for adopted entity ${id}`,
    });
  } else {
    const frontmatter = file.parsed.frontmatter;
    if (frontmatter === null) {
      return reject(
        "AMBIGUOUS_MIGRATION",
        `${file.path} has no frontmatter block to hold a \`mex\` key, so its file-level entity cannot be adopted in place.`,
      );
    }
    if (file.parsed.entities.some((entry) => entry.metadataKind === "frontmatter")) {
      return reject("INVALID_OPERATION_PAYLOAD", `${file.path} already has a file-level entity.`);
    }
    const fields = newEntityFields(id, { ...payload, headingDepth: undefined });
    const map = Object.fromEntries(fields.filter(([, value]) => value !== undefined));
    const target: MetadataTarget = { region: regionOfFrontmatter(file), prefix: [] };
    const edit = metadataEdit(file.text, target, "mex", map);
    if (edit === null) return reject("WIKI_PARSE_ERROR", `${file.path} has frontmatter that cannot hold a \`mex\` key.`);
    edits.push(edit);

    // The one non-prose deletion migration performs, and it is declared in the
    // payload rather than implied: leaving a root key whose values have moved
    // under `mex:` would leave two stores of one fact.
    for (const key of adopt.absorbRootKeys ?? []) {
      const removal = keyPathRemoveEdit(file.text, target.region, [key]);
      if (removal === null) {
        return reject("WIKI_PARSE_ERROR", `${file.path}: could not locate the root \`${key}\` key to absorb.`);
      }
      if (removal !== "absent") edits.push(removal);
    }
  }

  return {
    files: [{ path: file.path, absolutePath: file.absolutePath, baseText: file.text, existed: file.existed, edits }],
    entityIds: [],
    createdIds: [id],
    preconditions: [],
    revisions: [{ entityId: id, before: 0, after: 1 }],
    diagnostics: [],
  };
}

/**
 * A frontmatter block as a YAML region, for a file being written into.
 *
 * Routed through the parser rather than computed: `innerStart` is not
 * `start + 4` on a CRLF file (finding 24), and finding 20's BOM shift applies
 * here too. There is one AST-to-file seam and this is not a second one.
 */
function regionOfFrontmatter(file: LocatedFile): MetadataTarget["region"] {
  const frontmatter = parseDocument(file.text).frontmatter;
  if (frontmatter === null) throw new Error("regionOfFrontmatter called with no frontmatter");
  return frontmatter;
}

// -- the dispatch ------------------------------------------------------------

export function buildOperationEdits(operation: WikiOperation, context: OperationContext): OperationEdits {
  switch (operation.type) {
    case "create-entry":
      return createEntry(context, operation);
    case "update-entry":
      return updateEntry(context, operation);
    case "set-property":
      return setProperty(context, operation);
    case "add-relation":
      return addRelation(context, operation);
    case "remove-relation":
      return removeRelation(context, operation);
    case "add-source":
      return addSource(context, operation);
    case "remove-source":
      return removeSource(context, operation);
    case "set-grounding":
      return setGrounding(context, operation);
    case "archive-entry":
      return archiveEntry(context);
    case "supersede-entry":
      return supersedeEntry(context, operation);
    case "move-entry":
      return moveEntry(context, operation);
  }
}

// -- update-entry ------------------------------------------------------------

function updateEntry(context: OperationContext, operation: Extract<WikiOperation, { type: "update-entry" }>): OperationEdits {
  const located = context.located!;
  const { title, summary, body, appendSources } = operation.payload;
  const fields: (readonly [string, unknown])[] = [];
  const extra: PatchEdit[] = [];

  if (appendSources !== undefined && appendSources.length > 0) {
    const sources = [...located.entity.sources];
    const existing = new Set(sources.map(sourceIdentity));
    for (const source of appendSources) {
      const identity = sourceIdentity(source);
      if (existing.has(identity)) continue;
      sources.push(source);
      existing.add(identity);
    }
    if (!authoringSourceCollectionFits(sources)) {
      return reject("INVALID_OPERATION_PAYLOAD", "Appending evidence would exceed the entity's source count or byte bounds.", located.entity.id);
    }
    if (sources.length > located.entity.sources.length) fields.push([METADATA_KEYS.sources, sources]);
  }

  if (summary !== undefined) fields.push([METADATA_KEYS.summary, summary]);

  if (title !== undefined) {
    const heading = headingEdits(located.text, located.entity, title);
    extra.push(...heading);
    // An explicit `title:` in metadata wins over the heading in the codec, so
    // it has to move with it — otherwise the file shows one title and the
    // index reports another.
    const target = targetOf(located);
    if (heading.length === 0 || (target !== null && metadataHasTitle(located, target))) {
      fields.push([METADATA_KEYS.title, title]);
    }
  }

  if (body !== undefined) {
    const eol = dominantEol(located.text);
    const trimmed = body.replace(/[\r\n]+$/, "");
    const existing = located.text.slice(located.entity.location.bodyStart, located.entity.location.bodyEnd);
    // Keep the body's own trailing separation exactly as it was: it belongs to
    // the body range, and dropping it would close the gap to the next entity.
    const tail = /(?:\r?\n)*$/.exec(existing)?.[0] ?? "";
    extra.push(bodyEdit(located.entity, `${eol}${withEol(trimmed, eol)}${tail === "" ? eol : withEol(tail, eol)}`));
  }

  return mutateSubject(context, fields, extra);
}

function metadataHasTitle(located: LocatedEntity, target: MetadataTarget): boolean {
  const edit = metadataEdit(located.text, target, METADATA_KEYS.title, located.entity.title);
  return edit !== null && edit.end > edit.start;
}

// -- set-property ------------------------------------------------------------

function setProperty(context: OperationContext, operation: Extract<WikiOperation, { type: "set-property" }>): OperationEdits {
  const { property, value } = operation.payload;
  if (property === "title") {
    return updateEntry(
      context,
      { ...operation, type: "update-entry", payload: { title: String(value) } } as Extract<WikiOperation, { type: "update-entry" }>,
    );
  }
  return mutateSubject(context, [[METADATA_KEYS[property], value]]);
}

// -- relations ---------------------------------------------------------------

function sameRelation(left: WikiRelationRef, right: WikiRelationRef): boolean {
  return left.type === right.type && left.target === right.target;
}

function addRelation(context: OperationContext, operation: Extract<WikiOperation, { type: "add-relation" }>): OperationEdits {
  const located = context.located!;
  const relation = operation.payload.relation;
  const existing = located.entity.relations;

  if (existing.some((entry) => sameRelation(entry, relation))) {
    return reject("DUPLICATE_RELATION", `${located.entity.id} already declares ${relation.type} → ${relation.target}.`, located.entity.id);
  }
  if (relation.target === located.entity.id) {
    return reject("SELF_RELATION", `${located.entity.id} cannot relate to itself.`, located.entity.id);
  }
  if (context.locateEntity(relation.target) === null) {
    return reject("INVALID_RELATION_TARGET", `Relation target ${relation.target} does not exist.`, located.entity.id);
  }
  if (relation.type === "supersedes") {
    const cycle = supersessionCycle(context, located.entity.id, relation.target);
    if (cycle !== null) return cycle;
  }
  return mutateSubject(context, [[METADATA_KEYS.relations, [...existing, relation]]]);
}

function removeRelation(context: OperationContext, operation: Extract<WikiOperation, { type: "remove-relation" }>): OperationEdits {
  const located = context.located!;
  const { type, target } = operation.payload;
  const remaining = located.entity.relations.filter((entry) => !(entry.type === type && entry.target === target));
  if (remaining.length === located.entity.relations.length) {
    return reject("INVALID_RELATION_TARGET", `${located.entity.id} has no ${type} relation to ${target}.`, located.entity.id);
  }
  return mutateSubject(context, [[METADATA_KEYS.relations, remaining.length === 0 ? [] : remaining]]);
}

/**
 * Would `superseder supersedes superseded` close a cycle?
 *
 * Walked over the *files*, not over an index, for the same reason the locator
 * is: there may be no index. Bounded by a visited set, so a cycle that already
 * exists in the scaffold is detected rather than followed forever.
 */
function supersessionCycle(context: OperationContext, superseder: EntityId, superseded: EntityId): OperationEdits | null {
  const seen = new Set<string>([superseder]);
  const queue: EntityId[] = [superseded];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === superseder) {
      return reject(
        "SUPERSESSION_CYCLE",
        `${superseder} cannot supersede ${superseded}: that closes a supersession cycle.`,
        superseder,
      );
    }
    if (seen.has(current)) continue;
    seen.add(current);
    const entity = context.locateEntity(current);
    if (entity === null) continue;
    for (const relation of entity.entity.relations) {
      if (relation.type === "supersedes") queue.push(relation.target);
    }
  }
  return null;
}

// -- sources -----------------------------------------------------------------

function addSource(context: OperationContext, operation: Extract<WikiOperation, { type: "add-source" }>): OperationEdits {
  const located = context.located!;
  const source: WikiSource = operation.payload.source;
  const identity = sourceIdentity(source);
  if (located.entity.sources.some((entry) => sourceIdentity(entry) === identity)) {
    return reject("DUPLICATE_SOURCE", `${located.entity.id} already cites ${identity}.`, located.entity.id);
  }
  return mutateSubject(context, [[METADATA_KEYS.sources, [...located.entity.sources, source]]]);
}

function removeSource(context: OperationContext, operation: Extract<WikiOperation, { type: "remove-source" }>): OperationEdits {
  const located = context.located!;
  const identity = operation.payload.sourceIdentity;
  const remaining = located.entity.sources.filter((entry) => sourceIdentity(entry) !== identity);
  if (remaining.length === located.entity.sources.length) {
    return reject("UNRESOLVED_EXTERNAL_SOURCE", `${located.entity.id} cites no source with identity ${identity}.`, located.entity.id);
  }
  return mutateSubject(context, [[METADATA_KEYS.sources, remaining.length === 0 ? [] : remaining]]);
}

// -- set-grounding -----------------------------------------------------------

function setGrounding(context: OperationContext, operation: Extract<WikiOperation, { type: "set-grounding" }>): OperationEdits {
  const located = context.located!;
  if (operation.payload.absorbRootGroundings === true) return absorbRootGroundings(context, operation.payload.groundsTo);
  const derived = deriveVerifiedGroundings(operation.payload.groundsTo, context.options.graph ?? null);
  if (!derived.ok) {
    return { files: [], entityIds: [], createdIds: [], preconditions: [], revisions: [], diagnostics: derived.diagnostics };
  }

  const groundings: WikiGrounding[] = derived.groundings.map((entry) => ({ ...entry }));
  const extra: PatchEdit[] = [];

  if (operation.payload.updateAnchors === true) {
    extra.push(...anchorEdits(located, groundings));
  }

  // A file-level entity's groundings include the file's root `grounds_to`
  // (#226), so an explicit replacement of the whole set replaces that key too.
  // Leaving it would bring every grounding the caller just removed back on the
  // next read. Only entries that were in effect go: the caller never saw the
  // others, so replacing "the set" says nothing about them.
  const root = rootGroundingsEdit(located, rootGroundingsNotInEffect(located.entity.groundsTo, located.parsed.legacy.groundsTo));
  if (root === null) return reject("WIKI_PARSE_ERROR", `${located.path}: could not locate the root \`grounds_to\` key.`, located.entity.id);
  extra.push(...root);

  return mutateSubject(context, [[METADATA_KEYS.groundsTo, groundings]], extra);
}

/**
 * Migration's move of a root `grounds_to` into an existing file-level entity.
 *
 * The groundings already belong to the entity as the codec reads it, so the
 * move changes no fact: it only folds two stores into one. A root entry that
 * was not in effect — one conflicting with `mex.grounds_to`, or one the codec
 * could not accept — stays at the root for the same reason `writeGroundings`
 * keeps it: moving it would be a decision rather than a relocation.
 */
function absorbRootGroundings(context: OperationContext, requested: readonly WikiGrounding[]): OperationEdits {
  const located = context.located!;
  if (located.metadataKind !== "frontmatter") {
    return reject(
      "INVALID_OPERATION_PAYLOAD",
      `${located.entity.id} is a section entity. A root \`grounds_to\` belongs to a file-level entity and is never attached to a section.`,
      located.entity.id,
    );
  }
  const current = located.entity.groundsTo;
  if (requested.length !== current.length || requested.some((entry, index) => canonicalJson(entry) !== canonicalJson(current[index]))) {
    return reject(
      "INVALID_OPERATION_PAYLOAD",
      `absorbRootGroundings moves ${located.entity.id}'s existing groundings and cannot change them; the requested list differs.`,
      located.entity.id,
    );
  }
  const kept = rootGroundingsNotInEffect(current, located.parsed.legacy.groundsTo);
  const root = rootGroundingsEdit(located, kept);
  if (root === null) return reject("WIKI_PARSE_ERROR", `${located.path}: could not locate the root \`grounds_to\` key.`, located.entity.id);
  return mutateSubject(context, [[METADATA_KEYS.groundsTo, current.map((entry) => ({ ...entry }))]], root);
}

/** Remove the root `grounds_to` of a file-level entity's file, or narrow it to `kept`. */
function rootGroundingsEdit(located: LocatedEntity, kept: readonly WikiGrounding[]): PatchEdit[] | null {
  if (located.metadataKind !== "frontmatter" || !located.parsed.frontmatter?.keys.includes("grounds_to")) return [];
  const region = parseDocument(located.text).frontmatter;
  if (region === null) return null;
  const root = located.parsed.legacy.groundsTo;
  // A root value with entries the codec could not read as groundings is left
  // alone, as every grounding writer leaves a value it cannot read.
  let raw: unknown;
  try { raw = (YAML.parse(region.text) as Record<string, unknown> | null)?.["grounds_to"]; } catch { return []; }
  if (!Array.isArray(raw) || raw.length !== root.length) return [];
  if (kept.length === root.length && kept.length > 0) return [];
  const edit = kept.length === 0
    ? keyPathRemoveEdit(located.text, region, ["grounds_to"])
    : keyPathEdit(located.text, region, ["grounds_to"], kept);
  if (edit === null) return null;
  return edit === "absent" ? [] : [edit];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Rewrite inline anchors to match a new grounding — only where it is unambiguous.
 *
 * An anchor is prose the author wrote, and the operation asked for it to be
 * kept in step, not for MEX to decide what it meant. So an anchor is rewritten
 * exactly when the entity's grounding is one-to-one: one node before, one node
 * after. With several groundings there is no fact about which anchor follows
 * which node, and guessing would silently repoint a reference in someone's
 * sentence.
 */
function anchorEdits(located: LocatedEntity, groundings: readonly WikiGrounding[]): PatchEdit[] {
  const before = located.entity.groundsTo;
  if (before.length !== 1 || groundings.length !== 1) return [];
  const from = before[0]!.node;
  const to = groundings[0]!.node;
  if (from === to) return [];

  const edits: PatchEdit[] = [];
  for (const anchor of located.parsed.anchors) {
    if (anchor.entityId !== located.entity.id || anchor.nodeId !== from) continue;
    const link = located.text.slice(anchor.range.start, anchor.range.end);
    const offset = link.indexOf(`mex://${from}`);
    if (offset < 0) continue;
    const start = anchor.range.start + offset;
    edits.push({ start, end: start + `mex://${from}`.length, text: `mex://${to}`, label: `anchor ${from}` });
  }
  return edits;
}

// -- archive-entry -----------------------------------------------------------

function archiveEntry(context: OperationContext): OperationEdits {
  const located = context.located!;
  if (located.entity.status === "archived") {
    return reject("INVALID_LIFECYCLE_STATE", `${located.entity.id} is already archived.`, located.entity.id);
  }
  // Body, relations, sources and groundings are untouched by construction: the
  // only field in the edit list is `status`.
  return mutateSubject(context, [[METADATA_KEYS.status, "archived" satisfies WikiLifecycleState]]);
}

// -- supersede-entry ---------------------------------------------------------

function supersedeEntry(context: OperationContext, operation: Extract<WikiOperation, { type: "supersede-entry" }>): OperationEdits {
  const located = context.located!;
  const payload = operation.payload;

  const replacementId = payload.replacementId ?? context.mintId();
  const cycle = supersessionCycle(context, replacementId, located.entity.id);
  if (cycle !== null) return cycle;

  const deprecate = mutateSubject(context, [[METADATA_KEYS.status, "deprecated" satisfies WikiLifecycleState]]);
  if (deprecate.diagnostics.length > 0) return deprecate;

  if (payload.replacement !== undefined) {
    const created = createInto(
      context,
      { ...payload.replacement, relations: [...(payload.replacement.relations ?? []), { type: "supersedes", target: located.entity.id }] },
      replacementId,
    );
    if (created.diagnostics.length > 0) return created;
    return merge(deprecate, created);
  }

  const replacement = context.locateEntity(replacementId);
  if (replacement === null) {
    return reject("ENTITY_NOT_FOUND", `No entity ${replacementId} to supersede ${located.entity.id} with.`, replacementId);
  }
  if (replacement.entity.relations.some((entry) => entry.type === "supersedes" && entry.target === located.entity.id)) {
    return reject("DUPLICATE_RELATION", `${replacementId} already supersedes ${located.entity.id}.`, replacementId);
  }

  const target = targetOf(replacement);
  if (target === null) {
    return reject("WIKI_PARSE_ERROR", `Could not locate the metadata block for ${replacementId}.`, replacementId);
  }
  const relations = [...replacement.entity.relations, { type: "supersedes" as const, target: located.entity.id }];
  const edits = metadataEdits(replacement.text, target, [
    [METADATA_KEYS.relations, relations],
    [METADATA_KEYS.revision, replacement.entity.revision + 1],
  ]);
  if (edits === null) {
    return reject("WIKI_PARSE_ERROR", `${replacement.path} does not hold a writable metadata map for ${replacementId}.`, replacementId);
  }

  const addition: OperationEdits = {
    files: [
      {
        path: replacement.path,
        absolutePath: replacement.absolutePath,
        baseText: replacement.text,
        existed: true,
        edits,
      },
    ],
    entityIds: [replacementId],
    createdIds: [],
    preconditions: [preconditionFor(replacement)],
    revisions: [{ entityId: replacementId, before: replacement.entity.revision, after: replacement.entity.revision + 1 }],
    diagnostics: [],
  };
  return merge(deprecate, addition);
}

/**
 * Combine two operations' edits, merging anything that lands in the same file.
 *
 * Two file entries for one path would be two writes to one target, and the
 * second would be planned against text the first had already changed.
 */
function merge(left: OperationEdits, right: OperationEdits): OperationEdits {
  const files: FileEdits[] = [...left.files];
  for (const file of right.files) {
    const existing = files.find((entry) => entry.path === file.path);
    if (existing === undefined) files.push(file);
    else existing.edits = [...existing.edits, ...file.edits];
  }
  return {
    files,
    entityIds: [...left.entityIds, ...right.entityIds],
    createdIds: [...left.createdIds, ...right.createdIds],
    preconditions: [...left.preconditions, ...right.preconditions],
    revisions: [...left.revisions, ...right.revisions],
    diagnostics: [...left.diagnostics, ...right.diagnostics],
  };
}

// -- move-entry --------------------------------------------------------------

function moveEntry(context: OperationContext, operation: Extract<WikiOperation, { type: "move-entry" }>): OperationEdits {
  const located = context.located!;
  const payload = operation.payload;

  if (located.metadataKind === "frontmatter") {
    // A file-level entity's metadata *is* its file's frontmatter `mex:` key, so
    // "moving" it is only well defined into a file that has no file-level
    // entity of its own. Refused rather than guessed at: silently converting it
    // to a block entity would change what the destination file is about.
    return reject(
      "INVALID_OPERATION_PAYLOAD",
      `${located.entity.id} is a file-level entity; its metadata is ${located.path}'s frontmatter. Move the file, or convert it to a block entity first.`,
      located.entity.id,
    );
  }

  const destination = context.locate(payload.file);
  if (destination === null) {
    return reject("WIKI_PARSE_ERROR", `${payload.file} exists but could not be read; refusing to write over it.`);
  }
  if (destination.path === located.path) {
    return reject("INVALID_OPERATION_PAYLOAD", `${located.entity.id} is already in ${payload.file}.`, located.entity.id);
  }

  // **Already in the destination: this is a resumed move.** Gains are written
  // before losses, so a crash between the two renames leaves the entity in both
  // files. Re-planning the insert would put a *second* copy in the destination;
  // the remaining work is the removal alone. That is what makes replaying the
  // opId converge rather than compound.
  const alreadyMoved = destination.parsed.entities.some((entry) => entry.entity.id === located.entity.id);
  const offset = alreadyMoved ? 0 : insertionOffset(destination, payload.insertAt);
  if (typeof offset !== "number") {
    return { files: [], entityIds: [], createdIds: [], preconditions: [], revisions: [], diagnostics: [offset] };
  }

  const { metadataStart, bodyEnd } = located.entity.location;
  const block = located.text.slice(metadataStart, bodyEnd).replace(/[\r\n]+$/, "");

  // Take the blank line above the block with it, so the source document closes
  // up rather than growing a hole where the entity used to be.
  let start = metadataStart;
  while (start > 0 && (located.text.charCodeAt(start - 1) === 0x0a || located.text.charCodeAt(start - 1) === 0x0d)) start -= 1;
  const sourceEol = dominantEol(located.text);
  if (start > 0) start += sourceEol.length;

  return {
    files: [
      {
        path: located.path,
        absolutePath: located.absolutePath,
        baseText: located.text,
        existed: true,
        edits: [{ start, end: bodyEnd, text: "", label: `remove ${located.entity.id} from ${located.path}` }],
      },
      ...(alreadyMoved
        ? []
        : [
            {
              path: destination.path,
              absolutePath: destination.absolutePath,
              baseText: destination.text,
              existed: destination.existed,
              edits: [
                {
                  start: offset,
                  end: offset,
                  text: paddedInsertion(destination.text, offset, block),
                  label: `insert ${located.entity.id} into ${destination.path}`,
                },
              ],
            },
          ]),
    ],
    entityIds: [located.entity.id],
    createdIds: [],
    preconditions: [preconditionFor(located)],
    // The block moves verbatim, so the entity's own text — and therefore its
    // semantic version — did not change. `revision` records what an entity
    // *says*, and this operation changes only where it says it.
    revisions: [{ entityId: located.entity.id, before: located.entity.revision, after: located.entity.revision }],
    diagnostics: [],
  };
}

export { generateEntityId };
export type { WikiEntity };
