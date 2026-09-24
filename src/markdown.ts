import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import { visit } from "unist-util-visit";
import YAML from "yaml";
import { keyPathEdit, keyPathRemoveEdit, renderKeyValue, spliceTopLevelKey } from "./wiki/markdown/frontmatter.js";
import { mergeGroundingStores, rootGroundingsNotInEffect } from "./wiki/markdown/grounding-stores.js";
import { applyEdits, type PatchEdit } from "./wiki/markdown/patch.js";
import { parseDocument } from "./wiki/markdown/parse.js";
import type { Grounding, ScaffoldFrontmatter } from "./types.js";
import type { Root, Content, Link } from "mdast";

const parser = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

/** Parse markdown string into AST */
export function parseMarkdown(content: string): Root {
  return parser.parse(content);
}

/** Extract YAML frontmatter from markdown content */
export function extractFrontmatter(
  content: string
): ScaffoldFrontmatter | null {
  const tree = parseMarkdown(content);
  let frontmatter: ScaffoldFrontmatter | null = null;

  visit(tree, "yaml", (node: { value: string }) => {
    try {
      frontmatter = YAML.parse(node.value) as ScaffoldFrontmatter;
    } catch {
      // Invalid YAML — skip
    }
  });

  return frontmatter;
}

/**
 * Where a file's groundings are **written**: under `mex:` once it has one, else at the root.
 *
 * A pre-wiki scaffold keeps `grounds_to` as a root frontmatter key, and that is
 * the key `mex ground` has always read and written. Once migration adopts a
 * file as a wiki entity, the entity's metadata is the `mex:` map and the
 * grounding belongs inside it — section 13.4's "move it under `mex.grounds_to`".
 *
 * **The read and the write must agree on one store, and that is the point.**
 * Two stores of one fact, maintained by two writers, drift apart the moment
 * either updates — the failure D1 exists to forbid. This used to be enforced by
 * having the reader follow this path too, so a file with a `mex:` map was read
 * only at `mex.grounds_to`. That made the root key invisible rather than
 * absent: setup itself produced files with both (population wrote root
 * groundings, then migration added a `mex:` map to a multi-entity file without
 * moving them), and `mex check` skipped every root entry in them (#226).
 *
 * So the reader now takes the union of both keys ({@link extractGroundings}),
 * and one store is restored by the writer instead: `writeGroundings` on a file
 * carrying both **consolidates**, moving root entries under `mex.grounds_to`
 * and removing the root key. The rule for the union, and for the one kind of
 * root entry a write keeps, is in `src/wiki/markdown/grounding-stores.ts`.
 *
 * A file with no `mex:` key is untouched by this: the path is the root key, and
 * every shipped grounding test exercises that case unchanged.
 */
export function groundingKeyPath(content: string): readonly string[] {
  const frontmatter = extractFrontmatter(content) as (ScaffoldFrontmatter & { mex?: unknown }) | null;
  return hasMexMap(frontmatter) ? ["mex", "grounds_to"] : ["grounds_to"];
}

function hasMexMap(frontmatter: (ScaffoldFrontmatter & { mex?: unknown }) | null): boolean {
  const mex = frontmatter?.mex;
  return mex !== null && typeof mex === "object";
}

/** The groundings a file carries, per store, as its frontmatter declares them. */
export interface GroundingShape {
  /** True when the file has a `mex:` map and a non-empty root `grounds_to`. */
  mixed: boolean;
  /** The union a reader sees: `mex` entries, then root entries for other nodes. */
  merged: Grounding[];
  /** Root entries whose node `mex.grounds_to` carries with a different fingerprint or bodyHash. */
  conflicts: Grounding[];
}

/**
 * Read both grounding stores from an already-parsed frontmatter.
 *
 * Taking the parsed map rather than the file lets `mex check` report the shape
 * from the frontmatter it already read, without a second read of the file.
 * Each store is validated as a set on its own, as the single store always was,
 * so one malformed key cannot hide the other's entries.
 */
export function groundingShape(frontmatter: ScaffoldFrontmatter | null): GroundingShape {
  const withMex = frontmatter as (ScaffoldFrontmatter & { mex?: { grounds_to?: unknown } }) | null;
  const rootValue: unknown = withMex?.grounds_to;
  const root = isGroundingArray(rootValue) ? rootValue : [];
  if (!hasMexMap(withMex)) return { mixed: false, merged: root, conflicts: [] };
  const mexValue: unknown = withMex?.mex?.grounds_to;
  const mex = isGroundingArray(mexValue) ? mexValue : [];
  const { merged, conflicts } = mergeGroundingStores(mex, root);
  return { mixed: Array.isArray(rootValue) && rootValue.length > 0, merged, conflicts };
}

/**
 * Return validated code-graph groundings from both stores (#226).
 *
 * On a file with a `mex:` map the result is the union, deduplicated by node;
 * where the two keys disagree about one node, the `mex.grounds_to` entry is
 * returned and the disagreement is left for `mex check` to report.
 */
export function extractGroundings(content: string): Grounding[] {
  return groundingShape(extractFrontmatter(content)).merged;
}

/**
 * Accept a `grounds_to` value.
 *
 * The check names the two required keys and deliberately does not enumerate the
 * optional ones. That is what lets `bodyHash` — and the wiki lane's `file`,
 * `commit`, `verifiedAt` and `reason` — survive a read/write cycle: the parsed
 * entries are handed to {@link writeGroundings} unchanged, so every key the
 * author put in the file is rendered back out. Tightening this into an
 * exact-shape check would silently strip whichever keys this lane's type had
 * not yet heard of, which is the failure it exists to avoid.
 */
export function isGroundingArray(value: unknown): value is Grounding[] {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const grounding = entry as Partial<Grounding>;
    return typeof grounding.node === "string" && grounding.node.length > 0
      && typeof grounding.fingerprint === "string" && grounding.fingerprint.length > 0;
  });
}

/**
 * Add or replace `grounds_to`, touching nothing else in the file.
 *
 * This used to rewrite the whole frontmatter block through `YAML.stringify`,
 * which preserved the body but reformatted the YAML: comment placement, quoting
 * style and key order were lost every time MEX recorded a fingerprint. That
 * turns a one-line grounding update into a whole-block diff, which is exactly
 * what the Markdown-canonical design exists to avoid — the scaffold has to stay
 * reviewable in an ordinary pull request.
 *
 * It now splices the one key's own range. Everything else in the file, byte for
 * byte, is left as the author wrote it.
 *
 * `groundings` is the file's whole grounding set, as {@link extractGroundings}
 * returned it and the caller changed it. On a file that also carries a root
 * `grounds_to` beside its `mex:` map, the write **consolidates** (#226): the
 * set goes to `mex.grounds_to` and the root key is removed in the same splice,
 * so the next read finds one store. The one exception is a root entry that
 * conflicts with the old `mex.grounds_to`. The reader never returned it, so
 * this write is not carrying it forward, and it stays at the root for a person
 * to resolve. A malformed root key is left alone, as the single-store writer
 * always left a value it could not read. A second write of the same set is a
 * no-op.
 */
export function writeGroundings(content: string, groundings: Grounding[]): string {
  if (!isGroundingArray(groundings)) throw new Error("Invalid grounds_to entries");
  const path = groundingKeyPath(content);
  if (path.length === 1) {
    return spliceTopLevelKey(content, "grounds_to", renderKeyValue("grounds_to", groundings)).text;
  }
  const frontmatter = parseDocument(content).frontmatter;
  if (frontmatter === null) {
    return spliceTopLevelKey(content, "grounds_to", renderKeyValue("grounds_to", groundings)).text;
  }
  const edit = keyPathEdit(content, frontmatter, path, groundings);
  // A `mex` map that cannot hold the key is not a reason to write a second copy
  // at the root; it is a reason to leave the file alone and let validation say so.
  if (edit === null) return content;
  const edits: PatchEdit[] = [edit];
  const before = extractFrontmatter(content);
  const rootValue: unknown = before?.grounds_to;
  if (isGroundingArray(rootValue)) {
    const kept = rootGroundingsNotInEffect(groundingShape(before).merged, rootValue);
    // An empty root list is a second store too, only an empty one.
    if (kept.length < rootValue.length || rootValue.length === 0) {
      const root = kept.length === 0
        ? keyPathRemoveEdit(content, frontmatter, ["grounds_to"])
        : keyPathEdit(content, frontmatter, ["grounds_to"], kept);
      if (root === null) return content;
      if (root !== "absent") edits.push(root);
    }
  }
  return applyEdits(content, edits).text;
}

export interface MexAnchor {
  nodeId: string;
  /** Offsets of the complete markdown link, used for precise durable rewrites. */
  start: number;
  end: number;
}

/** Find standard markdown links whose destination is exactly `mex://<nodeId>`. */
export function findMexAnchors(content: string): MexAnchor[] {
  const anchors: MexAnchor[] = [];
  visit(parseMarkdown(content), "link", (node: Link) => {
    if (!node.url.startsWith("mex://") || node.url.length === "mex://".length) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    anchors.push({ nodeId: node.url.slice("mex://".length), start, end });
  });
  return anchors;
}

/** Extract inline anchor node ids in document order. */
export function extractMexAnchorIds(content: string): string[] {
  return findMexAnchors(content).map((anchor) => anchor.nodeId);
}

/** Rewrite one parsed anchor while preserving its visible text and surrounding markdown byte-for-byte. */
export function rewriteMexAnchor(content: string, anchor: MexAnchor, nodeId: string): string {
  if (!nodeId) throw new Error("Invalid mex anchor node id");
  const link = content.slice(anchor.start, anchor.end);
  const oldUri = `mex://${anchor.nodeId}`;
  const uriOffset = link.indexOf(oldUri);
  if (uriOffset < 0) throw new Error("mex anchor no longer matches markdown content");
  const start = anchor.start + uriOffset;
  return content.slice(0, start) + `mex://${nodeId}` + content.slice(start + oldUri.length);
}

/** Get the current heading context for a given line position */
export function getHeadingAtLine(
  tree: Root,
  line: number
): string | null {
  let currentHeading: string | null = null;

  for (const node of tree.children) {
    if (!node.position) continue;
    if (node.position.start.line > line) break;
    if (node.type === "heading") {
      currentHeading = getTextContent(node);
    }
  }

  return currentHeading;
}

/** Extract plain text from an AST node */
export function getTextContent(node: Content | Root): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if ("children" in node) {
    return (node.children as Content[]).map(getTextContent).join("");
  }
  return "";
}

/**
 * Words that mark surrounding prose as describing something that is gone or
 * deliberately absent. A heading is not always the right scope: a changelog
 * bullet naming a deleted file sits under an ordinary heading yet still refers
 * to something that should not exist on disk.
 */
const NEGATED_TEXT =
  /\b(?:deleted|removed|dropped|retired|orphaned|unreferenced|absent|no longer|does not exist|never created)\b/i;

/**
 * True when this passage describes a path as deleted or deliberately absent.
 * Callers pass a whole block rather than one line: markdown wraps prose freely,
 * so the word and the reference it governs routinely sit on different lines of
 * the same sentence.
 */
export function isNegatedText(text: string | undefined): boolean {
  if (!text) return false;
  return NEGATED_TEXT.test(text);
}

/** Check if a heading or its ancestors suggest negation */
export function isNegatedSection(heading: string | null): boolean {
  if (!heading) return false;
  const lower = heading.toLowerCase();
  return (
    lower.includes("not exist") ||
    lower.includes("not use") ||
    lower.includes("deliberately not") ||
    lower.includes("excluded") ||
    lower.includes("removed") ||
    lower.includes("deprecated")
  );
}
