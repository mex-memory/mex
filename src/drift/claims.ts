import { readFileSync } from "node:fs";
import { visit } from "unist-util-visit";
import { parseMarkdown, getHeadingAtLine, isNegatedSection } from "../markdown.js";
import type { Claim } from "../types.js";
import type { Root, Code, InlineCode, Strong, Text } from "mdast";

const KNOWN_EXTENSIONS = /\.(ts|js|tsx|jsx|py|go|rs|rb|java|json|yaml|yml|toml|md|css|scss|html|vue|svelte|sh)$/;
const COMMAND_PREFIXES = /^(npm|yarn|pnpm|bun|make|cargo|python|pip|go|node|npx|tsx)\s/;
const DEPENDENCY_SECTION_PATTERNS = /key\s*libraries|core\s*technologies|dependencies|stack|tech/i;
/** Paths with angle brackets or square brackets are template placeholders, not real paths */
const TEMPLATE_PLACEHOLDER = /[<>\[\]{}]/;

/** HTTP methods that indicate an API route, not a file path */
const HTTP_METHOD_PREFIX = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//;

/** Things that look like paths but are actually code snippets, URL routes, or other non-path content */
function isNotAPath(value: string): boolean {
  // URL routes: /voice/incoming, /api/users — start with / but have no file extension
  if (value.startsWith("/") && !KNOWN_EXTENSIONS.test(value)) return true;

  // HTTP method + route: GET /api/bookmarks, POST /users/:id
  if (HTTP_METHOD_PREFIX.test(value)) return true;

  // Code snippets: contains =, (), ;, or other code-like characters
  if (/[=();,]/.test(value)) return true;

  // Quoted strings or attribute assignments: gather.action="...", foo="bar"
  if (/["']/.test(value)) return true;

  // Wildcard prefixes like *_streaming_client.py — patterns, not real paths
  if (value.startsWith("*")) return true;

  return false;
}

/** Extract all claims from a markdown file */
export function extractClaims(filePath: string, source: string): Claim[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const tree = parseMarkdown(content);
  const claims: Claim[] = [];

  // Extract from inline code
  visit(tree, "inlineCode", (node: InlineCode) => {
    const line = node.position?.start.line ?? 0;
    const heading = getHeadingAtLine(tree, line);
    const negated = isNegatedSection(heading);

    // Path claims: contains / or ends in known extension
    if (node.value.includes("/") || KNOWN_EXTENSIONS.test(node.value)) {
      // Skip commands, template placeholders, and non-path content
      if (!COMMAND_PREFIXES.test(node.value) && !TEMPLATE_PLACEHOLDER.test(node.value) && !isNotAPath(node.value)) {
        claims.push({
          kind: "path",
          value: node.value,
          source,
          line,
          section: heading,
          negated,
        });
      }
    }

    // Command claims
    if (COMMAND_PREFIXES.test(node.value)) {
      claims.push({
        kind: "command",
        value: node.value,
        source,
        line,
        section: heading,
        negated,
      });
    }
  });

  // Extract from code blocks
  visit(tree, "code", (node: Code) => {
    const line = node.position?.start.line ?? 0;
    const heading = getHeadingAtLine(tree, line);
    const negated = isNegatedSection(heading);

    // Each line of the code block could be a command
    for (const codeLine of node.value.split("\n")) {
      const trimmed = codeLine.trim();
      if (COMMAND_PREFIXES.test(trimmed)) {
        claims.push({
          kind: "command",
          value: trimmed,
          source,
          line,
          section: heading,
          negated,
        });
      }
    }
  });

  // Extract dependencies from **BoldName** patterns in relevant sections
  visit(tree, "strong", (node: Strong) => {
    const line = node.position?.start.line ?? 0;
    const heading = getHeadingAtLine(tree, line);
    const negated = isNegatedSection(heading);

    if (heading && DEPENDENCY_SECTION_PATTERNS.test(heading)) {
      const text = getStrongText(node);
      if (!text) return;

      // Check for version pattern: "React 18" or "Node v20"
      const versionMatch = text.match(/^(.+?)\s+[v^~>=<]*(\d[\d.]*\S*)$/);
      if (versionMatch) {
        claims.push({
          kind: "dependency",
          value: versionMatch[1].trim(),
          source,
          line,
          section: heading,
          negated,
        });
        claims.push({
          kind: "version",
          value: text,
          source,
          line,
          section: heading,
          negated,
        });
      } else {
        claims.push({
          kind: "dependency",
          value: text,
          source,
          line,
          section: heading,
          negated,
        });
      }
    }
  });

  return claims;
}

function getStrongText(node: Strong): string | null {
  const textNode = node.children.find(
    (c): c is Text => c.type === "text"
  );
  return textNode?.value ?? null;
}
