import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import { visit } from "unist-util-visit";
import YAML from "yaml";
import type { Grounding, ScaffoldFrontmatter } from "./types.js";
import type { Root, Content } from "mdast";

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

/** Return validated code-graph groundings; malformed entries are rejected as a set. */
export function extractGroundings(content: string): Grounding[] {
  const value = extractFrontmatter(content)?.grounds_to;
  return isGroundingArray(value) ? value : [];
}

export function isGroundingArray(value: unknown): value is Grounding[] {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const grounding = entry as Partial<Grounding>;
    return typeof grounding.node === "string" && grounding.node.length > 0
      && typeof grounding.fingerprint === "string" && grounding.fingerprint.length > 0;
  });
}

/** Add or replace grounds_to while preserving the markdown body and other frontmatter keys. */
export function writeGroundings(content: string, groundings: Grounding[]): string {
  if (!isGroundingArray(groundings)) throw new Error("Invalid grounds_to entries");
  const tree = parseMarkdown(content);
  const yamlNode = tree.children.find((node) => node.type === "yaml");
  const frontmatter = extractFrontmatter(content) ?? {};
  frontmatter.grounds_to = groundings;
  const yaml = YAML.stringify(frontmatter).trimEnd();
  const block = `---\n${yaml}\n---`;
  const start = yamlNode?.position?.start.offset;
  const end = yamlNode?.position?.end.offset;
  if (start !== undefined && end !== undefined) {
    return content.slice(0, start) + block + content.slice(end);
  }
  return `${block}\n\n${content}`;
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
