/**
 * The read side: one Markdown file in, entities and diagnostics out.
 *
 * Three properties govern everything here.
 *
 * **It never throws.** A malformed file yields diagnostics plus whatever could
 * still be read. Throwing would take out an entire `rebuild-index` run for one
 * bad file, and prose must never be lost.
 *
 * **It never guesses.** Unbound metadata, two blocks competing for one heading,
 * a root `grounds_to` in a file with no file-level entity — each is reported
 * and left alone. A parser that picks a plausible answer attaches somebody's
 * decision record to the wrong section, and nobody finds out.
 *
 * A root `grounds_to` in a file that *has* a file-level entity is not a guess,
 * and is attached to that entity (#226). Frontmatter is file-level by nature,
 * and the file-level `mex` map is itself frontmatter, so a root grounding beside
 * it is a claim about the same document. This used to be refused on any
 * multi-entity file, which is how setup's own groundings went missing from
 * `wiki for-code`: population wrote them at the root, and migration then gave
 * the file a `mex` map and section entities. The narrowing is deliberate and
 * one-directional: **a root grounding is never attached to a section entity**,
 * and a file with only section entities keeps its root groundings unattributed.
 *
 * **Every character is accounted for.** Regions belonging to no entity are
 * emitted as explicit gaps, so the partition property can prove nothing was
 * lost or double-claimed. Without them "the rest of the file" is unverifiable.
 */

import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { entityContentHash, exactFileContentHash } from "../model/hash.js";
import {
  createEntityValidator,
  DEFAULT_ENTITY_TYPE_REGISTRY,
  type EntityTypeRegistry,
  type WikiEntity,
  type WikiEntityLocation,
} from "../model/entity.js";
import { rootContext } from "../model/validate.js";
import YAML from "yaml";
import type { LabeledRange } from "./ranges.js";
import type {
  RejectedEntity,
  LegacyEdge,
  ParsedEntity,
  ParsedFile,
  ParsedFrontmatter,
  ParsedLegacy,
  ParseOptions,
} from "./contract.js";
import { parseDocument, type RawDocument, type RawFrontmatter } from "./parse.js";
import { bindComments, resolveBodyExtents, type Binding } from "./bind.js";
import { findTopLevelKeyRange, topLevelKeys } from "./frontmatter.js";
import { lineAt, lineStarts } from "./positions.js";
import { associateAnchors } from "./anchors.js";
import { mergeGroundingStores } from "./grounding-stores.js";
import { validateGrounding, type WikiGrounding } from "../model/grounding.js";

/** An already-parsed metadata value, as a map, or null when it is not one. */
function asMetadataMap(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse YAML, returning null rather than throwing on malformed input. */
function parseYamlMap(text: string): Record<string, unknown> | null {
  try {
    const document = YAML.parseDocument(text);
    if (document.errors.length > 0) return null;
    const value = document.toJS() as unknown;
    if (value === null || value === undefined) return {};
    return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Default a field **only when its key is absent**.
 *
 * YAML distinguishes a missing key from one explicitly set to `null`, and the
 * model's `optional()` rejects the second on purpose — an explicit null is
 * nearly always a mistake worth reporting. Defaulting `null` to `[]` here would
 * launder exactly the input the model exists to catch.
 */
function fieldOr<T>(source: Record<string, unknown>, key: string, fallback: T): unknown {
  return key in source ? source[key] : fallback;
}

function buildEntityDraft(
  metadata: Record<string, unknown>,
  title: string,
  body: string,
  location: WikiEntityLocation,
): Record<string, unknown> {
  const draft: Record<string, unknown> = {
    id: metadata["id"],
    type: metadata["type"],
    title: typeof metadata["title"] === "string" ? metadata["title"] : title,
    body,
    status: metadata["status"],
    revision: fieldOr(metadata, "revision", 1),
    topics: fieldOr(metadata, "topics", []),
    relations: fieldOr(metadata, "relations", []),
    sources: fieldOr(metadata, "sources", []),
    groundsTo: fieldOr(metadata, "grounds_to", []),
    location,
  };
  if ("summary" in metadata) draft["summary"] = metadata["summary"];
  if ("provenance" in metadata) draft["provenance"] = metadata["provenance"];
  if ("metadata" in metadata) draft["metadata"] = metadata["metadata"];
  return draft;
}

/**
 * The entity's own text, for the operation precondition hash.
 *
 * The three ranges are concatenated rather than sliced as one span, because the
 * span between them is not the entity's — for a file-level entity it holds the
 * closing frontmatter fence and other keys, which belong to no entity and must
 * not move the hash when they change.
 *
 * **Exported, and the operations layer calls it.** It is *not*
 * `slice(metadataStart, bodyEnd)`, which is the natural thing to write and
 * differs by the newline after `-->` and any blank lines before the heading. A
 * second definition here would be a precondition mismatch between plan time and
 * apply time, and it would read as a concurrency bug rather than as the
 * arithmetic error it is.
 */
export function entityTextOf(text: string, location: WikiEntityLocation): string {
  return (
    text.slice(location.metadataStart, location.metadataEnd) +
    text.slice(location.headingStart, location.headingEnd) +
    text.slice(location.bodyStart, location.bodyEnd)
  );
}

interface BuildContext {
  path: string;
  text: string;
  starts: number[];
  fileHash: string;
  registry: EntityTypeRegistry;
  diagnostics: WikiDiagnostic[];
  rejected: RejectedEntity[];
}

function buildEntity(context: BuildContext, binding: Binding): ParsedEntity | null {
  const { path, text } = context;
  const metadata =
    binding.parsedMetadata === undefined
      ? parseYamlMap(binding.yamlText)
      : asMetadataMap(binding.parsedMetadata);

  const location: WikiEntityLocation = {
    file: path,
    metadataStart: binding.metadataStart,
    metadataEnd: binding.metadataEnd,
    headingStart: binding.heading?.start ?? binding.bodyStart,
    headingEnd: binding.heading?.end ?? binding.bodyStart,
    bodyStart: binding.bodyStart,
    bodyEnd: binding.bodyEnd,
    startLine: lineAt(context.starts, binding.metadataStart),
    endLine: lineAt(context.starts, Math.max(binding.metadataStart, binding.bodyEnd - 1)),
    headingDepth: binding.heading?.depth ?? 0,
    fileContentHash: context.fileHash,
    entityContentHash: "",
  };
  location.entityContentHash = entityContentHash(entityTextOf(text, location));

  if (metadata === null) {
    context.diagnostics.push(
      diagnostic("WIKI_PARSE_ERROR", `Malformed YAML in entity metadata in ${path}.`, {
        file: path,
        location: { file: path, startOffset: binding.metadataStart, endOffset: binding.metadataEnd },
      }),
    );
    return null;
  }

  const draft = buildEntityDraft(metadata, binding.heading?.title ?? "", text.slice(binding.bodyStart, binding.bodyEnd), location);
  const validator = createEntityValidator({ registry: context.registry, requireLocation: true });
  const result = validator(draft, rootContext({ file: path }));

  if (!result.ok) {
    // One diagnostic, not the validator's whole list. A caller fixing a file
    // wants "this metadata block is not valid, here is why"; the per-field
    // codes belong to the model's own tests, and emitting them here would make
    // the codec's diagnostic surface depend on the model's internal shape.
    const reasons = result.diagnostics.map((entry) => entry.message).join(" ");
    // The uncollapsed list, for `wiki validate` and nothing else. See
    // `RejectedEntity` in `contract.ts` for why it is carried rather than
    // re-derived by a second reader.
    context.rejected.push({
      ...(typeof metadata["id"] === "string" ? { entityId: metadata["id"] } : {}),
      range: { start: binding.metadataStart, end: binding.metadataEnd },
      diagnostics: result.diagnostics,
    });
    context.diagnostics.push(
      diagnostic("WIKI_PARSE_ERROR", `Invalid entity metadata in ${path}. ${reasons}`.trim(), {
        file: path,
        entityId: typeof metadata["id"] === "string" ? metadata["id"] : undefined,
        location: { file: path, startOffset: binding.metadataStart, endOffset: binding.metadataEnd },
      }),
    );
    return null;
  }

  return { entity: result.value, metadataKind: binding.kind };
}

/**
 * Bind a file-level `mex` key to the document's first heading.
 *
 * The same "only blank lines may intervene" rule as a comment block, applied
 * between the frontmatter block and the heading. A file whose prose starts
 * before its first heading still parses; its entity simply has no bound heading
 * and depth 0, rather than reaching past the prose to claim one.
 */
function bindFrontmatter(
  text: string,
  document: RawDocument,
  frontmatter: RawFrontmatter,
  mexRange: { keyStart: number; valueEnd: number },
  parsedMetadata: unknown,
): Binding {
  const heading = document.headings.find((candidate) => candidate.start >= frontmatter.end);
  const bindable = heading !== undefined && /^[ \t\r\n]*$/.test(text.slice(frontmatter.end, heading.start));
  return {
    kind: "frontmatter",
    metadataStart: mexRange.keyStart,
    metadataEnd: mexRange.valueEnd,
    heading: bindable ? heading! : null,
    yamlText: "",
    parsedMetadata,
    bodyStart: bindable ? heading!.end : frontmatter.end,
    bodyEnd: text.length,
  };
}

/**
 * The file-level `mex` map with the file's root `grounds_to` attached (#226).
 *
 * The union rule is `grounding-stores.ts`, shared with `mex check`'s reader so
 * the two resolve duplicates and conflicts the same way. Each root entry must
 * pass the model's own grounding validator first: one malformed root entry
 * would otherwise reject the whole entity, turning a legacy key into the loss
 * of the entity it sits beside. The one difference from `check` follows from
 * that: `check` drops a malformed root list as a set, as it always has, while
 * this keeps its valid entries.
 *
 * Anything this cannot read as a map is returned untouched, so the entity
 * validator reports it exactly as it did before.
 */
function withRootGroundings(
  path: string,
  root: Record<string, unknown>,
  diagnostics: WikiDiagnostic[],
): unknown {
  const mex = root["mex"];
  const map = asMetadataMap(mex);
  const rootGroundings = root["grounds_to"];
  if (map === null || !Array.isArray(rootGroundings) || rootGroundings.length === 0) return mex;
  const own = map["grounds_to"] ?? [];
  if (!Array.isArray(own)) return mex;

  const context = rootContext({ file: path });
  const valid = rootGroundings.filter((entry) => validateGrounding(entry, context).ok) as WikiGrounding[];
  const readable = own.filter((entry): entry is WikiGrounding => {
    const record = asMetadataMap(entry);
    return record !== null && typeof record["node"] === "string" && typeof record["fingerprint"] === "string";
  });
  const { merged, conflicts } = mergeGroundingStores(readable, valid);
  const entityId = typeof map["id"] === "string" ? map["id"] : undefined;
  const nodes = [...new Set(conflicts.map((entry) => entry.node))].join(", ");
  diagnostics.push(conflicts.length > 0
    ? diagnostic(
      "GROUNDING_MIXED_SHAPE",
      `${path} grounds ${nodes} differently in its root \`grounds_to\` and in \`mex.grounds_to\`; ` +
        "the `mex.grounds_to` entry is the one in effect.",
      { file: path, entityId, severity: "warning" },
    )
    : diagnostic(
      "GROUNDING_MIXED_SHAPE",
      `${path} keeps groundings in both a root \`grounds_to\` and \`mex.grounds_to\`; ` +
        "both belong to its file-level entity.",
      { file: path, entityId },
    ));
  // Append only what the root adds, after the entity's own list as written.
  return { ...map, grounds_to: [...own, ...merged.slice(readable.length)] };
}

/** Every region belonging to no entity, in position order. */
function collectGaps(text: string, entities: readonly ParsedEntity[]): LabeledRange[] {
  const claimed: { start: number; end: number }[] = [];
  for (const parsed of entities) {
    const location = parsed.entity.location;
    claimed.push(
      { start: location.metadataStart, end: location.metadataEnd },
      { start: location.headingStart, end: location.headingEnd },
      { start: location.bodyStart, end: location.bodyEnd },
    );
  }
  claimed.sort((left, right) => left.start - right.start);

  const gaps: LabeledRange[] = [];
  let cursor = 0;
  for (const range of claimed) {
    if (range.start > cursor) gaps.push({ label: `gap[${gaps.length}]`, start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) gaps.push({ label: `gap[${gaps.length}]`, start: cursor, end: text.length });
  return gaps;
}

function readLegacy(root: Record<string, unknown> | null): ParsedLegacy {
  const legacy: ParsedLegacy = { groundsTo: [], edges: [], topics: [] };
  if (root === null) return legacy;

  const grounds = root["grounds_to"];
  if (Array.isArray(grounds)) {
    for (const entry of grounds) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record["node"] !== "string" || typeof record["fingerprint"] !== "string") continue;
      legacy.groundsTo.push(record as unknown as ParsedLegacy["groundsTo"][number]);
    }
  }

  const edges = root["edges"];
  if (Array.isArray(edges)) {
    for (const entry of edges) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record["target"] !== "string") continue;
      const edge: LegacyEdge = { target: record["target"] };
      if (typeof record["condition"] === "string") edge.condition = record["condition"];
      legacy.edges.push(edge);
    }
  }

  // These are deliberately kept as labels. A label is not an EntityId, and
  // migration may resolve it only through an explicit, reviewed mapping.
  const topics = root["topics"];
  if (Array.isArray(topics)) {
    for (const topic of topics) {
      if (typeof topic === "string" && topic.trim() !== "") legacy.topics.push(topic);
    }
  }

  return legacy;
}

export function parseWikiMarkdown(options: ParseOptions): ParsedFile {
  const { path, text } = options;
  const registry = options.registry ?? DEFAULT_ENTITY_TYPE_REGISTRY;
  const document = parseDocument(text);
  const diagnostics: WikiDiagnostic[] = [];

  // -- frontmatter ----------------------------------------------------------
  let frontmatter: ParsedFrontmatter | null = null;
  let rootMap: Record<string, unknown> | null = null;
  let frontmatterBinding: Binding | null = null;

  if (document.frontmatter !== null) {
    const block = document.frontmatter;
    rootMap = parseYamlMap(block.text);
    const mexRange = rootMap === null ? null : findTopLevelKeyRange(text, block, "mex");

    frontmatter = {
      range: { start: block.start, end: block.end },
      keys: topLevelKeys(block),
      mexKeyRange: mexRange === null ? null : { start: mexRange.keyStart, end: mexRange.valueEnd },
    };

    if (rootMap === null) {
      diagnostics.push(
        diagnostic("WIKI_PARSE_ERROR", `Malformed YAML frontmatter in ${path}.`, {
          file: path,
          location: { file: path, startOffset: block.start, endOffset: block.end },
        }),
      );
    } else if (mexRange !== null) {
      frontmatterBinding = bindFrontmatter(text, document, block, mexRange, withRootGroundings(path, rootMap, diagnostics));
    }
  }

  // -- block-level metadata -------------------------------------------------
  const { bindings, unbound, contested } = bindComments(text, document);

  for (const block of unbound) {
    diagnostics.push(
      diagnostic("UNBOUND_ENTITY_METADATA", `Entity metadata in ${path} is not followed by a heading.`, {
        file: path,
        location: { file: path, startOffset: block.start, endOffset: block.end },
      }),
    );
  }
  for (const clash of contested) {
    diagnostics.push(
      diagnostic(
        "DUPLICATE_ENTITY_METADATA",
        `${clash.blocks.length} metadata blocks in ${path} bind to the heading ${JSON.stringify(clash.heading.title)}.`,
        {
          file: path,
          location: { file: path, startOffset: clash.blocks[0]!.start, endOffset: clash.heading.end },
        },
      ),
    );
  }

  const all = frontmatterBinding === null ? bindings : [frontmatterBinding, ...bindings];
  all.sort((left, right) => left.metadataStart - right.metadataStart);

  // Every metadata block terminates the preceding body, whether or not it bound
  // to a heading — see resolveBodyExtents.
  const metadataStarts = document.htmlBlocks.filter((block) => block.isEntityMarker).map((block) => block.start);
  resolveBodyExtents(text, document, all, metadataStarts);

  // -- entities -------------------------------------------------------------
  const rejected: RejectedEntity[] = [];
  const context: BuildContext = {
    path,
    text,
    starts: lineStarts(text),
    fileHash: exactFileContentHash(text),
    registry,
    diagnostics,
    rejected,
  };

  const entities: ParsedEntity[] = [];
  for (const binding of all) {
    const built = buildEntity(context, binding);
    if (built !== null) entities.push(built);
  }

  // -- anchors --------------------------------------------------------------
  const anchors = associateAnchors(
    document.links,
    entities.map((parsed) => ({
      id: parsed.entity.id,
      bodyStart: parsed.entity.location.bodyStart,
      bodyEnd: parsed.entity.location.bodyEnd,
    })),
  );

  return {
    path,
    text,
    entities,
    gaps: collectGaps(text, entities),
    anchors,
    frontmatter,
    legacy: readLegacy(rootMap),
    diagnostics,
    rejected,
  };
}
