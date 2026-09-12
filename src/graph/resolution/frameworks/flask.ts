import { canonicalNodeIdentity, generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode } from "../../types.js";
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolvedRef,
  UnresolvedRef,
} from "../types.js";

// Receiver creation: `app = Flask(__name__)`, `bp: Blueprint = Blueprint(...)`,
// `app = flask.Flask(__name__)`. Group 2 captures the constructor call's
// argument text start for a static url_prefix read.
const FRAMEWORK_INSTANCE = /^\s*([A-Za-z_]\w*)\s*(?::\s*[\w.\[\]"]+)?\s*=\s*(?:flask\.)?(?:Flask|Blueprint)\s*\(/;
const FROM_IMPORT = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/;
const IMPORTED_NAME = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/;
const ROUTE_DECORATOR = /^(\s*)@([A-Za-z_]\w*)\.(route|get|post|put|patch|delete|options|head)\s*\(/;
// `methods=` written as a list or a tuple; the value must close on the same
// logical line and hold only quoted names (or it is unreadable).
const METHODS_VALUE = /(?:^|[,({\s])methods\s*=\s*([[(])([^)\]]*)[\])]/;
const PATH_ARG = /^\s*([fFbBuU]{0,2})?(["'])((?:[^"'\\]|\\.)*)\2/;
const HANDLER = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const FLASK_IMPORT = /(?:^|\r?\n)\s*(?:from\s+flask(?:\.[\w.]+)?\s+import\s|import\s+flask\b)/;
const URL_PREFIX_ARG = /(?:^|[,({\s])url_prefix\s*=\s*(["'])((?:[^"'\\]|\\.)*)\1/;

/** A route decorator parsed before its handler was seen. */
interface PendingRoute {
  method: string;
  path: string;
  line: number;
  endColumn: number;
}

export const flaskResolver: FrameworkResolver = {
  name: "flask",
  languages: ["python"],
  detect(context) {
    // Detection runs against the staged corpus, and dependency manifests are
    // not staged files — only source is. A Flask project always has a Python
    // module importing flask, so the import is the reliable observable here;
    // `flask_restful` and friends do not match (`import flask` requires the
    // word boundary).
    return context.getAllFiles().some((filePath) => {
      if (!filePath.toLowerCase().endsWith(".py")) return false;
      const content = context.readFile(filePath);
      return content ? FLASK_IMPORT.test(content) : false;
    });
  },
  claimsReference: (name) => /^[A-Za-z_]\w*$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    if (!filePath.toLowerCase().endsWith(".py")) {
      return { nodes: [], references: [] };
    }

    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];
    const pendingRoutes: PendingRoute[] = [];

    // Blank `#` comments and triple-quoted strings (docstrings) with spaces
    // before scanning: a decorator shown inside a docstring example is
    // documentation, not a route (#177 review). Offsets and line numbers stay
    // valid because only comment content is replaced; single-quoted strings
    // survive intact because decorator arguments live in them.
    const scannable = blankCommentsAndDocstrings(content);
    const logical = mergeLogicalLines(scannable);

    // Route receivers: names assigned Flask/Blueprint in THIS file, plus
    // names imported with `from <module> import name` — the usual package
    // layout creates the app or Blueprint in `__init__.py` and declares
    // routes elsewhere, and detection already proved this is a Flask project
    // (#177 review). Names imported FROM flask are framework classes, not
    // instances. A Blueprint keeps its static constructor `url_prefix`.
    const receivers = new Map<string, string>();
    const importedNames: Array<{ name: string }> = [];
    for (const entry of logical) {
      const instance = FRAMEWORK_INSTANCE.exec(entry.text);
      if (instance) {
        receivers.set(instance[1]!, parseUrlPrefix(entry.text, instance[0].length));
        continue;
      }
      const imported = FROM_IMPORT.exec(entry.text);
      if (imported && !imported[1]!.split(".")[0]!.startsWith("flask")) {
        for (const raw of imported[2]!.split(",")) {
          const nameMatch = IMPORTED_NAME.exec(raw.trim().replace(/[()]/g, ""));
          if (nameMatch) importedNames.push({ name: nameMatch[2] ?? nameMatch[1]! });
        }
      }
    }
    for (const { name } of importedNames) {
      if (!receivers.has(name)) receivers.set(name, "");
    }

    for (const entry of logical) {
      const line = entry.text;
      const decorator = ROUTE_DECORATOR.exec(line);
      if (decorator && receivers.has(decorator[2]!)) {
        const receiverPrefix = receivers.get(decorator[2]!)!;
        const open = line.indexOf("(", decorator[1]!.length + decorator[2]!.length + 1);
        const args = readBalanced(line, open);
        const route = args === null ? null : parseRoute(decorator[3]!, args, entry.line, receiverPrefix);
        if (route) pendingRoutes.push(...route);
        continue;
      }

      if (pendingRoutes.length === 0) continue;
      // Stacked decorators and blank/comment lines are legal between a route
      // decorator and its def; only a real statement ends the wait.
      if (/^\s*@/.test(line)) continue;
      if (/^\s*(?:#.*)?$/.test(line)) continue;

      const handler = HANDLER.exec(line);
      if (handler) {
        emitRoutes(filePath, handler[1]!, pendingRoutes, nodes, references);
      }
      pendingRoutes.length = 0;
    }

    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind !== "function_ref") return null;
    const candidates = context.getNodesInFile(ref.filePath).filter((node) => (
      (node.kind === "function" || node.kind === "method")
      && node.name === ref.referenceName
    ));
    // The decorator proves the handler name, not a repository-global target;
    // same-file is the only context that binds it unambiguously.
    if (candidates.length !== 1) return null;

    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.8,
      resolvedBy: "flask-route-handler",
    };
  },
};

/**
 * Turn one decorator's arguments into 1..n routes.
 *
 * `@app.route("/x")` means GET by default. `methods=["POST", "PUT"]` — or the
 * tuple spelling — fans out to one route per declared method; a `methods=`
 * that is present but not a literal list/tuple of strings skips the route
 * rather than guessing `GET` (#177 review). Shortcut decorators carry their
 * method in the name. Paths that are not fully static — f-strings,
 * `%`-format, `{}` placeholders — are skipped, not emitted verbatim. Flask
 * path converters such as `/users/<int:user_id>` are preserved as written.
 * A Blueprint receiver's static `url_prefix` composes in front of the
 * decorated path; composing prefixes across `register_blueprint()` calls
 * stays out of scope.
 */
function parseRoute(
  decoratorName: string,
  argsText: string,
  lineIndex: number,
  receiverPrefix: string,
): PendingRoute[] | null {
  const pathMatch = PATH_ARG.exec(argsText);
  if (!pathMatch) return null;
  const prefix = pathMatch[1] ?? "";
  const rawPath = pathMatch[3]!;
  if (/[fF]/.test(prefix)) return null;
  if (rawPath.includes("{") || rawPath.includes("}") || rawPath.includes("%")) return null;
  const path = composePath(receiverPrefix, rawPath);

  if (decoratorName === "route") {
    const methods = declaredMethods(argsText);
    if (methods === "unreadable") return null;
    return (methods ?? ["GET"]).map((method) => ({
      method: method.toUpperCase(),
      path,
      line: lineIndex,
      endColumn: argsText.length,
    }));
  }
  return [{
    method: decoratorName.toUpperCase(),
    path,
    line: lineIndex,
    endColumn: argsText.length,
  }];
}

/** `/admin` + `/settings` → `/admin/settings`; "" and `/` fold correctly. */
function composePath(urlPrefix: string, decoratedPath: string): string {
  let prefix = urlPrefix.replace(/\/+$/, "");
  if (prefix && !prefix.startsWith("/")) prefix = "/" + prefix;
  let path = decoratedPath;
  if (path && !path.startsWith("/")) path = "/" + path;
  const full = prefix + path;
  return full === "" ? "/" : full;
}

/**
 * Methods from `methods=[...]` or `methods=(...)`. Null when absent (→ GET
 * default); the literal string set when readable; "unreadable" when the key
 * exists but the value is not a literal list/tuple of plain strings — the
 * route is then skipped rather than assigned a guessed GET (#177 review).
 */
function declaredMethods(argsText: string): string[] | "unreadable" | null {
  const match = METHODS_VALUE.exec(argsText);
  if (!match) {
    // The key exists but its value is not a list/tuple literal at all (a
    // variable name, an expression) — skip the route rather than guess GET.
    return /(?:^|[,({\s])methods\s*=/.test(argsText) ? "unreadable" : null;
  }
  const inner = match[2]!;
  const methods: string[] = [];
  for (const part of inner.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const literal = /^(["'])([A-Za-z]+)\1$/.exec(trimmed);
    if (!literal) return "unreadable";
    methods.push(literal[2]!.toUpperCase());
  }
  return methods.length > 0 ? methods : "unreadable";
}

/** The static `url_prefix="…"` of a Flask/Blueprint constructor, if any. */
function parseUrlPrefix(line: string, callStart: number): string {
  const open = line.indexOf("(", callStart - 1);
  const args = open < 0 ? null : readBalanced(line, open);
  if (args === null) return "";
  const match = URL_PREFIX_ARG.exec(args);
  return match ? match[2]! : "";
}

/**
 * Extract balanced argument text starting at the `(` at `open`, string-aware
 * so quotes never skew depth. Returns null when the call does not close.
 */
function readBalanced(line: string, open: number): string | null {
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return line.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Join physical lines whose parens are still open into one logical line
 * (the text, plus the 0-based index of its first physical line). Black
 * routinely splits long decorators over several lines; without this those
 * routes produce nothing (#177 review). Paren depth is tracked string-aware
 * per physical line; a line that opens more than it closes continues.
 */
function mergeLogicalLines(content: string): Array<{ text: string; line: number }> {
  const physical = content.split(/\r?\n/);
  const out: Array<{ text: string; line: number }> = [];
  let buffer: string | null = null;
  let bufferLine = 0;
  let depth = 0;
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i]!;
    let openCount = 0;
    let closeCount = 0;
    let quote: string | null = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (quote) {
        if (ch === quote && line[j - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === "\"" || ch === "'") { quote = ch; continue; }
      if (ch === "(") openCount++;
      else if (ch === ")") closeCount++;
    }
    const delta = openCount - closeCount;
    if (buffer === null) {
      if (delta > 0) {
        buffer = line;
        bufferLine = i;
        depth = delta;
      } else {
        out.push({ text: line, line: i });
      }
      continue;
    }
    buffer += " " + line.trim();
    depth += delta;
    if (depth <= 0) {
      out.push({ text: buffer, line: bufferLine });
      buffer = null;
      depth = 0;
    }
  }
  if (buffer !== null) out.push({ text: buffer, line: bufferLine });
  return out;
}

function emitRoutes(
  filePath: string,
  handler: string,
  routes: PendingRoute[],
  nodes: GraphNode[],
  references: UnresolvedRef[],
): void {
  const occurrences = new Map<string, number>();
  for (const route of routes) {
    const name = `${route.method} ${route.path}`;
    const signature = `${name} -> ${handler}`;
    // The same route can legitimately appear twice in one module — a
    // conditional `@app.route("/debug")` in both branches, or a redundant
    // stacked `@app.route("/x")` + `@app.route("/x", methods=["GET"])`. The
    // ordinal in the role keeps ids distinct so a duplicate cannot fail the
    // whole build (#177 review).
    const ordinal = occurrences.get(name) ?? 0;
    occurrences.set(name, ordinal + 1);
    const role = `flask-route:${ordinal}`;
    const id = generateNodeId(filePath, "route", name, name, role, signature);
    nodes.push({
      id,
      identityKey: canonicalNodeIdentity(filePath, "route", name, role, signature),
      kind: "route",
      name,
      qualifiedName: name,
      filePath,
      language: "python",
      startLine: route.line + 1,
      endLine: route.line + 1,
      startColumn: 0,
      endColumn: route.endColumn,
      signature,
      isExported: false,
      updatedAt: 0,
    });
    references.push({
      fromNodeId: id,
      referenceName: handler,
      referenceKind: "function_ref",
      filePath,
      language: "python",
      line: route.line,
      column: 0,
    });
  }
}

/**
 * Blank `#` comments and triple-quoted strings with spaces (newlines kept),
 * so every offset and line number stays valid against the original. Single
 * and double quoted strings are preserved — decorator arguments live in
 * them, and they cannot span lines.
 */
function blankCommentsAndDocstrings(content: string): string {
  const out: string[] = [];
  type State = "code" | "comment" | "string" | "docstring";
  let state: State = "code";
  let quote = "";
  let docQuote = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];
    const after = content[i + 2];
    if (state === "code") {
      if (ch === "#") { state = "comment"; out.push(" "); continue; }
      if ((ch === "\"" || ch === "'") && ch === next && ch === after) {
        state = "docstring";
        docQuote = ch;
        out.push("   ");
        i += 2;
        continue;
      }
      if (ch === "\"" || ch === "'") { state = "string"; quote = ch; out.push(ch); continue; }
      out.push(ch);
      continue;
    }
    if (state === "comment") {
      if (ch === "\n") { state = "code"; out.push("\n"); } else out.push(" ");
      continue;
    }
    if (state === "string") {
      const escaped = content[i - 1] === "\\";
      if (ch === quote && !escaped) { state = "code"; out.push(ch); continue; }
      if (ch === "\n") { state = "code"; out.push("\n"); continue; }
      out.push(ch);
      continue;
    }
    // docstring: blank everything until the closing triple quote.
    if (content.startsWith(docQuote.repeat(3), i) && content[i - 1] !== "\\") {
      state = "code";
      out.push("   ");
      i += 2;
      continue;
    }
    out.push(ch === "\n" ? "\n" : " ");
  }
  return out.join("");
}
