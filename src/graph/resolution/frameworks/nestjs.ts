import { canonicalNodeIdentity, generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode, Language } from "../../types.js";
import type { FrameworkExtractionResult, FrameworkResolver, ResolvedRef, UnresolvedRef } from "../types.js";

const CONTROLLER_DECORATOR = /^@Controller\b/;
const HTTP_DECORATOR = /^@(Get|Post|Put|Patch|Delete|Options|Head|All)\b/;
const CLASS_DECLARATION = /^(?:export\s+)?(?:abstract\s+)?(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)/;
const STRING_LITERAL_ARG = /^(["'`])([^"'\\]*)\1/;
const OBJECT_PATH_ARG = /(?:^|[,{]\s*)path\s*:\s*(["'])([^"'\\]*)\1/;

export const nestjsResolver: FrameworkResolver = {
  name: "nestjs",
  languages: ["typescript", "javascript"],
  detect(context) {
    const pkg = context.readFile("package.json");
    if (!pkg) return false;
    try {
      const parsed = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return Boolean(
        parsed.dependencies?.["@nestjs/core"] ??
        parsed.dependencies?.["@nestjs/common"] ??
        parsed.devDependencies?.["@nestjs/core"] ??
        parsed.devDependencies?.["@nestjs/common"]
      );
    } catch { return false; }
  },
  claimsReference: (name) => /^[A-Za-z_$][\w$]*$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    const language = languageFor(filePath);
    if (!language) return { nodes: [], references: [] };

    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];

    // Comments are blanked (with spaces, so offsets and line numbers survive)
    // before scanning: a commented-out `// @Get('legacy')` or a handler left
    // inside a block comment is not a route, and reading raw text invented
    // phantom routes pointing at real handlers (#102 review).
    const blanked = blankComments(content);
    const lines = blanked.split("\n");

    // Controller state binds to the NEXT class declaration, so two controllers
    // in one file each keep their own prefix and neither leaks into the other.
    let pendingController: { prefix: string; skip: boolean } | null = null;
    let activeController: { prefix: string; skip: boolean } | null = null;
    let currentClass: string | null = null;
    const occurrences = new Map<string, number>();

    let lineStart = 0;
    for (const line of lines) {
      const trimmed = line.trim();

      if (CONTROLLER_DECORATOR.test(trimmed)) {
        pendingController = parseControllerArgs(trimmed);
        lineStart += line.length + 1;
        continue;
      }

      const classMatch = CLASS_DECLARATION.exec(trimmed);
      if (classMatch) {
        currentClass = classMatch[1]!;
        activeController = pendingController;
        pendingController = null;
        lineStart += line.length + 1;
        continue;
      }

      const decoratorMatch = HTTP_DECORATOR.exec(trimmed);
      if (decoratorMatch && activeController && !activeController.skip) {
        const method = decoratorMatch[1]!.toUpperCase();
        // Scan from just past the decorator's closing paren, not the line
        // end: `@Get() list() {}` on one line must bind `list`, not the next
        // method. (#102 review round 2.)
        const openInLine = line.length - line.trimStart().length + trimmed.indexOf("(");
        const span = openInLine >= 0 ? extractBalancedArgs(line, openInLine) : null;
        const handlerName = findHandlerName(blanked, lineStart + (span?.end ?? line.length));
        if (handlerName && span) {
          // An empty argument list is a route with no path; an argument that
          // is not a string literal (an array, a constant, a template with
          // an interpolation) cannot be read statically — no route beats a
          // wrong route.
          const trimmedArgs = span.args.trim();
          const rawPath: string | null = trimmedArgs === "" ? "" : firstStringArgument(span.args);
          if (rawPath !== null) {
            const routeName = `${method} ${normalizeRoutePath(activeController.prefix, rawPath)}`;
            const handler = handlerName;
            const signature = `${routeName} -> ${handler}`;
            // Two routes can share a name in one file (NestJS versioning:
            // @Version('1') @Get() findAllV1 / @Version('2') @Get()
            // findAllV2). The handler in the signature distinguishes most;
            // the ordinal in the role covers the rest, mirroring Express.
            const ordinal = occurrences.get(routeName) ?? 0;
            occurrences.set(routeName, ordinal + 1);
            const role = `nestjs-route:${ordinal}`;
            const id = generateNodeId(filePath, "route", routeName, routeName, role, signature);
            nodes.push({
              id,
              identityKey: canonicalNodeIdentity(filePath, "route", routeName, role, signature),
              kind: "route",
              name: routeName,
              qualifiedName: routeName,
              filePath,
              language,
              startLine: blanked.slice(0, lineStart).split("\n").length,
              endLine: blanked.slice(0, lineStart).split("\n").length,
              startColumn: 0,
              endColumn: line.length,
              signature,
              isExported: false,
              updatedAt: 0,
            });
            references.push({
              fromNodeId: id,
              referenceName: handler,
              referenceKind: "function_ref",
              filePath,
              language,
              line: blanked.slice(0, lineStart).split("\n").length - 1,
              column: 0,
              // The TypeScript extractor names methods `Class::method`;
              // carrying the owning controller lets resolution distinguish
              // two same-named handlers across controllers in one file.
              ...(currentClass ? { candidates: [`${currentClass}::${handler}`] } : {}),
            });
          }
        }
      }

      lineStart += line.length + 1;
    }

    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind !== "function_ref") return null;
    const sameFile = context.getNodesInFile(ref.filePath)
      .filter((node) => (node.kind === "method" || node.kind === "function") && node.name === ref.referenceName);
    // NestJS handlers live in the same file as the controller. A unique
    // same-file declaration binds; when several share the name (two
    // controllers in one file), the owning class recorded at extraction
    // picks the one the route was declared on.
    let target = sameFile.length === 1 ? sameFile[0] : null;
    if (!target && sameFile.length > 1 && ref.candidates?.length) {
      const qualified = sameFile.filter((node) => ref.candidates!.includes(node.qualifiedName));
      if (qualified.length === 1) target = qualified[0]!;
    }
    return target
      ? { original: ref, targetNodeId: target.id, confidence: 0.8, resolvedBy: "nestjs-route-handler" }
      : null;
  },
};

function languageFor(filePath: string): Language | null {
  if (/\.(ts|mts|cts)$/.test(filePath)) return "typescript";
  if (/\.tsx$/.test(filePath)) return "tsx";
  if (/\.(js|mjs|cjs)$/.test(filePath)) return "javascript";
  if (/\.jsx$/.test(filePath)) return "jsx";
  return null;
}

/**
 * Blank comments out of the source, replacing every comment character with a
 * space and preserving all newlines, so scanning sees comment-free code while
 * every offset, line number, and column stays valid against the original.
 * String literals are preserved verbatim — decorator arguments live in them.
 */
function blankComments(content: string): string {
  const out: string[] = [];
  let state: "code" | "line" | "block" | "string" = "code";
  let quote = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; out.push("  "); i++; continue; }
      if (ch === "/" && next === "*") { state = "block"; out.push("  "); i++; continue; }
      if (ch === "\"" || ch === "'" || ch === "`") { state = "string"; quote = ch; out.push(ch); continue; }
      out.push(ch);
      continue;
    }
    if (state === "line") {
      if (ch === "\n") { state = "code"; out.push("\n"); } else out.push(" ");
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; out.push("  "); i++; continue; }
      out.push(ch === "\n" ? "\n" : " ");
      continue;
    }
    // Inside a string: escape sequences cannot close it.
    if (ch === quote && content[i - 1] !== "\\") state = "code";
    out.push(ch);
  }
  return out.join("");
}

/**
 * Read `@Controller(...)` arguments into a prefix, or a skip when the argument
 * cannot be read statically. Every form resets whatever the previous
 * controller left behind — a `@Controller` without a readable path must not
 * inherit one (#102 review).
 */
function parseControllerArgs(line: string): { prefix: string; skip: boolean } {
  const open = line.indexOf("(");
  if (open < 0) return { prefix: "", skip: false };
  const span = extractBalancedArgs(line, open);
  if (span === null) return { prefix: "", skip: true };
  const trimmedArgs = span.args.trim();
  if (trimmedArgs === "") return { prefix: "", skip: false };

  const literal = STRING_LITERAL_ARG.exec(trimmedArgs);
  if (literal) {
    const path = firstStringArgument(trimmedArgs);
    return path === null ? { prefix: "", skip: true } : { prefix: path, skip: false };
  }

  if (trimmedArgs.startsWith("{")) {
    // An object with a `path` key must have a statically readable value for
    // it; `{ path: CONSTANT }` is as unreadable as a bare constant argument.
    // An object with no `path` at all (`{ host: '…' }`) is unprefixed.
    const hasPath = /(?:^|[,{]\s*)path\s*:/.test(trimmedArgs);
    if (!hasPath) return { prefix: "", skip: false };
    const objectPath = OBJECT_PATH_ARG.exec(trimmedArgs);
    if (!objectPath) return { prefix: "", skip: true };
    return { prefix: objectPath[2]!, skip: false };
  }

  // A constant identifier or an array of paths is not statically readable
  // here; skip this controller's routes rather than emit a wrong prefix.
  return { prefix: "", skip: true };
}

/**
 * The first positional string-literal argument, or null when absent, or when
 * it is a template with an interpolation — `` `${BASE}/x` `` has no static
 * path and must not be emitted verbatim.
 */
function firstStringArgument(argsText: string): string | null {
  const match = STRING_LITERAL_ARG.exec(argsText.trim());
  if (!match) return null;
  if (match[1] === "`" && match[2]!.includes("${")) return null;
  return match[2]!;
}

/** `GET /users/:id` from the controller prefix and the method's path. */
function normalizeRoutePath(prefix: string, methodPath: string): string {
  let fullPath = prefix.replace(/\/+$/, "");
  if (fullPath && !fullPath.startsWith("/")) fullPath = "/" + fullPath;
  let subPath = methodPath;
  if (subPath && !subPath.startsWith("/")) subPath = "/" + subPath;
  if (subPath === "/") subPath = "";
  fullPath += subPath;
  if (!fullPath) fullPath = "/";
  else if (fullPath.length > 1 && fullPath.endsWith("/")) fullPath = fullPath.slice(0, -1);
  return fullPath;
}

/**
 * Extract the argument text of the call whose `(` sits at `open`, and the
 * offset just past its closing `)`. Skipping over string literals keeps a `)`
 * inside `'List users :)'` from closing it; the end offset lets the caller
 * start the handler scan at the right place when the decorator and its method
 * share a line. Returns null when the call does not close on this line.
 */
function extractBalancedArgs(line: string, open: number): { args: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { args: line.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Forward-scan from just past a decorator line for the handler name: skip
 * whitespace, further decorators (string-aware, so `@ApiOperation({
 * summary: 'List users :)' })` no longer swallows the route), and modifier
 * keywords, then read the identifier that opens a parameter list.
 */
function findHandlerName(content: string, from: number): string | null {
  let idx = from;
  while (idx < content.length) {
    const ch = content[idx]!;
    if (/\s/.test(ch)) { idx++; continue; }
    if (ch === "@") {
      idx++;
      while (idx < content.length && /[A-Za-z0-9_$]/.test(content[idx]!)) idx++;
      if (content[idx] === "(") {
        let depth = 0;
        let quote: string | null = null;
        while (idx < content.length) {
          const c = content[idx]!;
          if (quote) {
            if (c === quote && content[idx - 1] !== "\\") quote = null;
          } else if (c === "\"" || c === "'" || c === "`") {
            quote = c;
          } else if (c === "(") {
            depth++;
          } else if (c === ")") {
            depth--;
            if (depth === 0) { idx++; break; }
          }
          idx++;
        }
      }
      continue;
    }
    const rest = content.slice(idx);
    const keyword = /^(?:public|private|protected|static|readonly|override|async)\s+/.exec(rest);
    if (keyword) { idx += keyword[0].length; continue; }
    const method = /^([A-Za-z_$][\w$]*)\s*[<(]/.exec(rest);
    if (method) return method[1]!;
    return null;
  }
  return null;
}
