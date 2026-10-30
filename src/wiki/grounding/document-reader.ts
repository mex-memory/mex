/**
 * The Wiki's reading of a scaffold document for grounding baseline capture.
 *
 * Capture lives in `src/graph/runtime.ts`, and the graph never imports the
 * Wiki; setup, sync and the CLI pass this reader in instead.
 */
import YAML from "yaml";
import type { BlockEntityGrounding, GroundingDocumentReader } from "../../graph/grounding-failures.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import { parseDocument } from "../markdown/parse.js";

/**
 * Groundings held by block-level Wiki entities (`<!-- mex:entity ... -->`),
 * read with the Wiki's own parser. File-level entities keep theirs in the
 * frontmatter, which `extractGroundings` already covers. A block the Wiki
 * cannot parse yields nothing here: validation owns malformed blocks.
 */
export function entityBlockGroundings(content: string): BlockEntityGrounding[] {
  try {
    const parsed = parseWikiMarkdown({ path: "entity.md", text: content });
    return parsed.entities.filter((entry) => entry.metadataKind === "comment")
      .flatMap((entry) => entry.entity.groundsTo.map((grounding) => ({ entity: String(entry.entity.id), grounding })));
  } catch { return []; }
}

/** Parse entity ownership once per document; reference failures remain exact and bounded. */
export function groundingFailureEntities(content: string): (node: string) => string | null {
  const parsed = parseDocument(content);
  let rootId: string | null = null;
  const owners = new Map<string, string | null>();
  try {
    const root = parsed.frontmatter ? YAML.parse(parsed.frontmatter.text) : null;
    if (typeof root?.mex?.id === "string") rootId = root.mex.id;
    for (const entry of [...(Array.isArray(root?.grounds_to) ? root.grounds_to : []),
      ...(Array.isArray(root?.mex?.grounds_to) ? root.mex.grounds_to : [])]) {
      if (typeof entry?.node === "string") owners.set(entry.node, rootId);
    }
    const blocks = parsed.htmlBlocks.filter(block => block.isEntityMarker).map(block => {
      let id: string | null = null;
      try { const value: unknown = YAML.parse(block.yamlText)?.id; if (typeof value === "string") id = value; } catch { /* validation owns malformed blocks */ }
      return { end: block.end, id };
    });
    for (const link of parsed.links) {
      if (!owners.has(link.nodeId)) owners.set(link.nodeId, blocks.filter(block => block.end <= link.start).at(-1)?.id ?? rootId);
    }
  } catch { /* validation owns malformed metadata */ }
  return node => owners.get(node) ?? rootId;
}

export const wikiGroundingDocumentReader: GroundingDocumentReader = {
  blockGroundings: entityBlockGroundings,
  failureEntities: groundingFailureEntities,
};
