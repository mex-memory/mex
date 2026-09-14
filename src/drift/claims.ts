import { readFileSync } from "node:fs";
import { visit } from "unist-util-visit";
import { parseMarkdown, getHeadingAtLine, isNegatedSection } from "../markdown.js";
import type { Claim } from "../types.js";
import type { Root, Code, InlineCode, ListItem, Strong, Text } from "mdast";

const KNOWN_EXTENSIONS = /\.(ts|js|tsx|jsx|py|go|rs|rb|java|json|yaml|yml|toml|md|css|scss|html|vue|svelte|sh)$/;
const COMMAND_PREFIXES = /^(npm|yarn|pnpm|bun|make|cargo|python|pip|go|node|npx|tsx)\s/;
const DEPENDENCY_SECTION_PATTERNS = /key\s*libraries|core\s*technologies|dependencies|stack|tech/i;
/** Paths with angle brackets or square brackets are template placeholders, not real paths */
const TEMPLATE_PLACEHOLDER = /[<>\[\]{}]/;

/** HTTP methods that indicate an API route, not a file path */
const HTTP_METHOD_PREFIX = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//;

/** IP addresses and CIDR ranges are network values, not filesystem paths. */
const IP_OR_CIDR = /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/;

/** Inline file extension references like `.yaml` describe a type, not a file. */
const EXTENSION_ONLY = /^\.[A-Za-z0-9]+$/;

/** Common shell commands that can contain path-like arguments. */
const SHELL_COMMAND_PREFIX = /^(?:sudo\s+)?(?:ls|cd|cat|grep|find|kubectl|helm|docker|git)\s+/;

/**
 * Dotted config keys or annotations can contain slashes but are not paths:
 * `argocd.argoproj.io/sync-wave`, `k8s.io/api`. The dotted segment must start
 * with a real character -- anchoring it any looser also matches a hidden
 * directory (`.github/CODEOWNERS`, `.mex/ROUTER.md`), which would drop the
 * scaffold's own paths out of the check entirely.
 */
const DOTTED_KEY_WITH_SLASH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+\/[A-Za-z0-9_.-]+$/;

/**
 * An installable package name: optional scope, then name characters only.
 * Prose that happens to be bold -- a description, or connective punctuation
 * left behind when inline code is stripped out -- does not match.
 */
const PACKAGE_NAME = /^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Architectural/descriptive terms that pass PACKAGE_NAME but are not
 * installable packages — the blocklist complement to the structural
 * heuristics above. One word per label; real packages never collide
 * (npm names "api" or "database" are far rarer than the false positives
 * these labels cause in stack docs).
 */
const ARCHITECTURAL_LABELS = new Set([
  "frontend", "backend", "fullstack", "full-stack",
  "database", "database layer", "storage layer", "data layer",
  "api", "api layer", "service layer",
  "middleware", "infrastructure", "infra", "platform",
  "auth", "authentication", "authorization",
  "caching", "queue", "queues", "scheduler", "workers",
  "server", "client", "monorepo", "tooling", "observability",
  "testing", "deployment", "orchestration", "gateway", "firewall",
]);

/** Things that look like paths but are actually code snippets, URL routes, or other non-path content */
function isNotAPath(value: string): boolean {
  // URL routes: /voice/incoming, /api/users — start with / but have no file extension
  if (value.startsWith("/") && !KNOWN_EXTENSIONS.test(value)) return true;

  // HTTP method + route: GET /api/bookmarks, POST /users/:id
  if (HTTP_METHOD_PREFIX.test(value)) return true;

  // IP addresses and CIDR ranges: 192.168.5.0/24, 10.0.0.0/8
  if (IP_OR_CIDR.test(value)) return true;

  // File extensions: .yaml, .yml
  if (EXTENSION_ONLY.test(value)) return true;

  // Shell commands with path-like arguments: sudo ls /var/lib/kubelet
  if (SHELL_COMMAND_PREFIX.test(value)) return true;

  // Annotation/config keys with slash-separated namespaces: argocd.argoproj.io/sync-wave
  if (DOTTED_KEY_WITH_SLASH.test(value)) return true;

  // Code snippets: contains =, (), ;, or other code-like characters
  if (/[=();,]/.test(value)) return true;

  // Quoted strings or attribute assignments: gather.action="...", foo="bar"
  if (/["']/.test(value)) return true;

  // Elided paths: `/api/api/...` in a troubleshooting note names a shape, not
  // a file.
  if (value.includes("..")) return true;

  // Home-relative runtime locations: ~/.claude/projects, ~/.config/app.toml.
  // Real at runtime, absent from the repository, and never a project file.
  if (value.startsWith("~")) return true;

  // Globs anywhere, not just leading: .mex/graph.db*, *_client.py. A pattern
  // describes a set of files rather than claiming one exists.
  if (/[*?]/.test(value)) return true;

  // Anything with whitespace is a command or a sentence, not a path:
  // `nodemon src/index.ts` names a runner and its argument.
  if (/\s/.test(value)) return true;

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

  // A stack doc declares a dependency as `- **name** — description`, so only
  // bold that opens a list item is a declaration. Collected up front because
  // both the inline-code pass and the bold pass need to know which nodes are
  // package names rather than paths or emphasis.
  const declarationStrong = new Set<Strong>();
  const declaredPackage = new Set<InlineCode>();
  visit(tree, "listItem", (item: ListItem) => {
    const firstBlock = item.children[0];
    if (!firstBlock || firstBlock.type !== "paragraph") return;
    const lead = firstBlock.children[0];
    if (!lead || lead.type !== "strong") return;

    const heading = getHeadingAtLine(tree, lead.position?.start.line ?? 0);
    if (!heading || !DEPENDENCY_SECTION_PATTERNS.test(heading)) return;

    declarationStrong.add(lead);
    for (const child of lead.children) {
      if (child.type === "inlineCode") declaredPackage.add(child);
    }
  });


  // Extract from inline code
  visit(tree, "inlineCode", (node: InlineCode) => {
    const line = node.position?.start.line ?? 0;
    const heading = getHeadingAtLine(tree, line);
    const negated = isNegatedSection(heading);

    // A package named inside a dependency entry is not a file. `youtubei.js`
    // ends in a known extension, so without this it was reported as a
    // missing path on every scaffold that documents its packages.
    if (declaredPackage.has(node)) return;

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

    if (!heading || !DEPENDENCY_SECTION_PATTERNS.test(heading)) return;

    // Only bold that opens a list item declares a dependency. Bold used
    // mid-sentence is emphasis on a term -- `the **service-role** key` -- and
    // reading it as a package name invented a claim the manifest can never
    // satisfy.
    if (!declarationStrong.has(node)) return;

    // When the entry names its packages in code, those are the dependency:
    // `**Radix UI + \`class-variance-authority\`**` is one package, not a
    // package called "Radix UI + ". Reading the surrounding prose instead
    // produced claims made of connective punctuation.
    const coded = node.children.filter(
      (child): child is InlineCode => child.type === "inlineCode"
    );
    if (coded.length > 0) {
      for (const child of coded) {
        claims.push({
          kind: "dependency",
          value: child.value,
          source,
          line,
          section: heading,
          negated,
        });
      }
      return;
    }

    const text = getStrongText(node);
    if (!text) return;

    // Check for version pattern: "React 18" or "Node v20"
    const versionMatch = text.match(/^(.+?)\s+[v^~>=<]*(\d[\d.]*\S*)$/);
    const name = versionMatch ? versionMatch[1].trim() : text;

    // A description is not a claim. "Supabase (Postgres + Auth)" and
    // "Express 4.21 on Node" describe a choice in prose; nothing installable
    // carries that name, so checking it against a manifest only ever produces
    // a warning the author cannot act on.
    if (!PACKAGE_NAME.test(name)) return;

    // Package-name heuristics (#4): a name that survives PACKAGE_NAME can
    // still be a label no manifest could ever satisfy. Acronyms ("AWS",
    // "REST") and multi-word descriptive phrases ("REST API", "Frontend
    // Layer") are not packages; scoped names ("@mex/core") keep their slash.
    const lower = name.toLowerCase();
    if (name === name.toUpperCase() && /[A-Z]/.test(name)) return;
    if (/\s/.test(name) && !name.startsWith("@")) return;
    if (ARCHITECTURAL_LABELS.has(lower)) return;

    claims.push({
      kind: "dependency",
      value: name,
      source,
      line,
      section: heading,
      negated,
    });
    if (versionMatch) {
      claims.push({
        kind: "version",
        value: text,
        source,
        line,
        section: heading,
        negated,
      });
    }
  });

  return claims;
}

function getStrongText(node: Strong): string | null {
  const text = node.children
    .filter((c): c is Text => c.type === "text")
    .map((c) => c.value)
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}
