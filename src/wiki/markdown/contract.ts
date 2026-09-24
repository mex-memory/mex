import type { WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityId } from "../model/ids.js";
import type { WikiEntity, EntityTypeRegistry } from "../model/entity.js";
import type { WikiGrounding } from "../model/grounding.js";
import type { LabeledRange, SourceRange } from "./ranges.js";

/**
 * The Markdown codec's read-side contract.
 *
 * These types were fixed before the parser existed, so the oracle — the fixture
 * corpus and its hand-derived expectations — could be written against a stable
 * interface by a session that could not shape it around an implementation. The
 * parser landed in P2b and satisfies them; the rules below are what it must go
 * on satisfying.
 *
 * ## Rules the implementation must satisfy
 *
 * **Positions.** Every offset is a UTF-16 code-unit index into the decoded text.
 * Files are read with `readFileSync(path, "utf-8")` and never as a Buffer.
 *
 * **Binding.** An entity's metadata is either a `mex` key in YAML frontmatter
 * (file-level) or a `<!-- mex:entity ... -->` HTML comment (block-level). A
 * comment binds to the *next* heading, with only blank lines permitted between
 * the two; anything else makes it unbound, which is a diagnostic rather than a
 * guess. Two metadata blocks binding to one heading is an error.
 *
 * **A `mex:entity` comment inside a fenced code block, an indented code block,
 * or an HTML block is content, not metadata.** This is the single most likely
 * parser bug.
 *
 * **Body extent.** A body runs from the end of its heading to whichever comes
 * first: the next heading of equal or shallower depth, the start of the next
 * entity's metadata, or end of file. Deeper headings belong to the body.
 *
 * The "next entity's metadata" clause is not in the original spec, which
 * mentions only heading depth. It is forced by the partition property: a
 * file-level entity's body would otherwise swallow the block entities inside it
 * and the ranges would overlap. See the mixed-entity fixture.
 *
 * **Range conventions**, fixed here because the partition property makes them
 * observable and the fixtures encode them:
 *
 * - A comment metadata range covers `<!--` through `-->` and stops there. The
 *   newline after it, and any blank lines between metadata and heading, are
 *   gaps. That keeps "only blank lines may intervene" visible as a gap holding
 *   nothing but whitespace, rather than hidden inside a range.
 * - A frontmatter metadata range covers the `mex` key and its value only. The
 *   surrounding delimiters and the other keys are gaps, so a write that touches
 *   `mex:` provably cannot disturb `name:` or a comment above it.
 * - A heading range includes its line terminator; a body starts immediately
 *   after. A setext heading's range covers both its text line and its
 *   underline.
 *
 * **Conflict regions.** A Git conflict marker is not inert prose to CommonMark:
 * `=======` is a valid setext underline, so
 *
 *     <<<<<<< HEAD
 *     Rotation happens every fifteen minutes.
 *     =======
 *
 * parses as a **depth-1 heading**. Left alone that phantom heading terminates
 * whatever entity body contains it, and half a section silently disappears from
 * the index after an ordinary bad merge — found by a user, not by a test. So
 * heading detection is suppressed between `<<<<<<<` and `>>>>>>>`, and the
 * marker text is preserved verbatim as content. This is the third rule the
 * original spec does not state. Diagnosing conflict markers as a validation
 * problem belongs to a later phase; here they are handled and reported as
 * nothing.
 *
 * **Identity.** Renaming a heading does not change an entity's id. Moving
 * metadata together with its heading preserves identity.
 */

/** Where an entity's metadata came from. */
export type EntityMetadataKind = "frontmatter" | "comment";

export interface ParsedEntity {
  /**
   * The entity, with `location` populated.
   *
   * `location.metadataStart/End` covers the `mex:` key's own range for a
   * file-level entity — not the whole frontmatter block, whose other keys belong
   * to a gap — and the whole comment including its delimiters for a block-level
   * entity.
   */
  entity: WikiEntity;
  metadataKind: EntityMetadataKind;
}

/** An inline `mex://<nodeId>` link. */
export interface ParsedAnchor {
  nodeId: string;
  /** Range of the complete Markdown link, so a rewrite can preserve link text. */
  range: SourceRange;
  /** The entity whose body contains it, or null when it sits outside every entity. */
  entityId: EntityId | null;
}

/** A legacy root-level `edges` entry, preserved verbatim for a later phase. */
export interface LegacyEdge {
  target: string;
  condition?: string;
}

export interface ParsedFrontmatter {
  /** The whole block including both `---` delimiters. */
  range: SourceRange;
  /** Top-level keys in document order, so a writer can preserve that order. */
  keys: string[];
  /** Range of the `mex` key and its value, or null when absent. */
  mexKeyRange: SourceRange | null;
}

/**
 * Legacy root-level fields.
 *
 * Read but not interpreted. The root `grounds_to` is always recorded here as
 * written. Where the file has a file-level entity, the codec also attaches it
 * to that entity (#226). Where the file has only section entities it cannot be
 * attributed to a section without guessing, so it stays here, reported and
 * never assigned.
 */
export interface ParsedLegacy {
  groundsTo: WikiGrounding[];
  edges: LegacyEdge[];
  /** Unresolved root-level labels; migration maps these only when configured. */
  topics: string[];
}

export interface ParsedFile {
  /** Scaffold-relative path, POSIX separators. */
  path: string;
  /** The decoded text exactly as read, including any BOM and original line endings. */
  text: string;
  entities: ParsedEntity[];
  /**
   * Regions belonging to no entity: prose between entities, frontmatter keys
   * other than `mex`, and trailing content.
   *
   * Explicit rather than inferred so the partition property is checkable —
   * without it, "the rest of the file" is unverifiable.
   */
  gaps: LabeledRange[];
  anchors: ParsedAnchor[];
  frontmatter: ParsedFrontmatter | null;
  legacy: ParsedLegacy;
  diagnostics: WikiDiagnostic[];
  /**
   * Metadata blocks that parsed as YAML but failed model validation.
   *
   * The codec reports one collapsed `WIKI_PARSE_ERROR` for each of these and
   * does not produce an entity, deliberately: its own diagnostic surface must
   * not depend on the model's internal shape (finding 26). But that decision
   * left `wiki validate` — the layer finding 26 names as where a user is
   * supposed to get field-level detail — with nothing to work from, because the
   * entity it would re-validate was never handed back. Re-reading the metadata
   * in the validation layer would be a second metadata reader, which is worse.
   *
   * So the per-field diagnostics are carried here, beside the collapsed one,
   * for the one consumer that is allowed to depend on them. Nothing else reads
   * this, and the collapsed `WIKI_PARSE_ERROR` in `diagnostics` is unchanged.
   */
  rejected: RejectedEntity[];
}

/** One metadata block the model refused, and every reason it gave. */
export interface RejectedEntity {
  /** The id the block declared, when it declared a string. */
  entityId?: string;
  /** Range of the metadata block, in UTF-16 code units. */
  range: SourceRange;
  /** The validator's own per-field diagnostics, uncollapsed. */
  diagnostics: WikiDiagnostic[];
}

export interface ParseOptions {
  /** Scaffold-relative path, used for diagnostics and `location.file`. */
  path: string;
  /** File text, read with `readFileSync(path, "utf-8")`. */
  text: string;
  /** Defaults to the model's default registry. */
  registry?: EntityTypeRegistry;
}

/**
 * Parse one Markdown file into entities, gaps, anchors and diagnostics.
 *
 * Never throws on malformed input — a broken file yields diagnostics and
 * whatever could still be read. Throwing would take out a whole
 * `rebuild-index` run for one bad file, and prose must never be lost.
 *
 * The implementation lives in `codec.ts`; this re-export keeps the contract and
 * its entry point in one place for callers. The import is one-way at runtime —
 * `codec.ts` takes only types from here.
 */
export { parseWikiMarkdown } from "./codec.js";

/**
 * Assemble every range in a parsed file, in position order, for the partition check.
 *
 * Implemented rather than stubbed: it is pure bookkeeping over the parse result,
 * it is what the fixture tests call, and having it fixed now means the next
 * builder cannot accidentally redefine what "covered" means.
 */
export function partitionRanges(file: ParsedFile): LabeledRange[] {
  const ranges: LabeledRange[] = [];

  for (let index = 0; index < file.entities.length; index += 1) {
    const { location } = file.entities[index]!.entity;
    if (location === undefined) continue;
    ranges.push({ label: `entities[${index}].metadata`, start: location.metadataStart, end: location.metadataEnd });
    ranges.push({ label: `entities[${index}].heading`, start: location.headingStart, end: location.headingEnd });
    ranges.push({ label: `entities[${index}].body`, start: location.bodyStart, end: location.bodyEnd });
  }

  ranges.push(...file.gaps);

  return ranges.sort((left, right) => (left.start === right.start ? left.end - right.end : left.start - right.start));
}
