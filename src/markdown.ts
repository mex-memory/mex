import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import { visit } from "unist-util-visit";
import YAML from "yaml";
import type { ScaffoldFrontmatter } from "./types.js";
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
