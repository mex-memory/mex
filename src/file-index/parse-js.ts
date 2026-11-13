import { createRequire } from "node:module";
import { isMainThread } from "node:worker_threads";
import { lineAt, lineStarts } from "./classify.js";
import type { ImportItem, OutlineItem, SymbolKind } from "./types.js";

/** What a parser returns for one file. */
export interface ParsedFile {
  outline: OutlineItem[];
  imports: ImportItem[];
  exports: string[];
  error?: string;
}

/** The loose shape of an ESTree node from oxc; only the fields read here. */
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

interface OxcResult { program: { body: AstNode[] }; errors: Array<{ message: string }> }
interface Oxc {
  parseSync(filename: string, source: string, options?: Record<string, unknown>): OxcResult;
  rawTransferSupported(): boolean;
}

let oxc: Oxc | null | undefined;
let options: Record<string, unknown> = { preserveParens: false };

/** The oxc parser, or null when its native binding can't load on this machine. */
export function loadOxc(): Oxc | null {
  if (oxc !== undefined) return oxc;
  try {
    oxc = createRequire(import.meta.url)("oxc-parser") as Oxc;
    // Raw transfer roughly halves parse time in one thread, but in several worker
    // threads at once it stalled single files for seconds (novu, Windows), so
    // workers use the ordinary transfer.
    if (isMainThread && oxc.rawTransferSupported()) options = { preserveParens: false, experimentalRawTransfer: true };
  } catch {
    oxc = null;
  }
  return oxc;
}

const TEST_CALLS = new Set(["describe", "context", "suite", "it", "test", "specify", "bench"]);

/** Parse TypeScript or JavaScript with oxc and pull out the outline, imports and exports. */
export function parseJs(path: string, source: string, lang: "ts" | "tsx" | "js"): ParsedFile | null {
  const parser = loadOxc();
  if (!parser) return null;
  let result: OxcResult;
  try {
    // Plain .js files often hold JSX (React projects), and JSX parses all ordinary JavaScript.
    result = parser.parseSync(path, source, { ...options, lang: lang === "js" ? "jsx" : lang });
  } catch (error) {
    return { outline: [], imports: [], exports: [], error: (error as Error).message };
  }
  const starts = lineStarts(source);
  const out = new Collector(starts);
  out.statements(result.program.body, undefined);
  const parsed: ParsedFile = { outline: out.outline, imports: out.imports, exports: [...new Set(out.exports)] };
  if (result.errors.length > 0 && result.program.body.length === 0) parsed.error = result.errors[0]!.message;
  return parsed;
}

function node(value: unknown): AstNode | undefined {
  return value && typeof value === "object" && typeof (value as AstNode).type === "string" ? value as AstNode : undefined;
}
function nodes(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.filter((item): item is AstNode => node(item) !== undefined) : [];
}
function keyName(key: unknown): string | undefined {
  const k = node(key);
  if (!k) return undefined;
  if (k.type === "Identifier" || k.type === "PrivateIdentifier") return (k.type === "PrivateIdentifier" ? "#" : "") + String(k.name);
  if (k.type === "Literal" && (typeof k.value === "string" || typeof k.value === "number")) return String(k.value);
  return undefined;
}
/** A symbol starts at its first decorator, as Python's do. */
function decorated(n: AstNode, from: number): number {
  const first = nodes(n.decorators)[0];
  return first ? Math.min(from, first.start) : from;
}
function calleeRoot(callee: unknown): string | undefined {
  let current = node(callee);
  while (current) {
    if (current.type === "Identifier") return String(current.name);
    if (current.type === "MemberExpression") current = node(current.object);
    else if (current.type === "CallExpression") current = node(current.callee);
    else return undefined;
  }
  return undefined;
}
function stringValue(value: unknown): string | undefined {
  const n = node(value);
  if (!n) return undefined;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral") {
    const quasis = nodes(n.quasis);
    return quasis.map((q) => String((q.value as { cooked?: string; raw?: string })?.cooked ?? (q.value as { raw?: string })?.raw ?? "")).join("${…}");
  }
  return undefined;
}

class Collector {
  readonly outline: OutlineItem[] = [];
  readonly imports: ImportItem[] = [];
  readonly exports: string[] = [];
  constructor(private readonly starts: readonly number[]) {}

  private add(name: string, kind: SymbolKind, start: number, end: number, parent: number | undefined): number {
    const item: OutlineItem = { name, kind, start: lineAt(this.starts, start), end: lineAt(this.starts, Math.max(start, end - 1)) };
    if (parent !== undefined) item.parent = parent;
    this.outline.push(item);
    return this.outline.length - 1;
  }

  statements(list: AstNode[], parent: number | undefined): void {
    for (const statement of list) this.statement(statement, parent, statement.start, false);
  }

  /** `from` is where the symbol's span starts: the `export` keyword when there is one. */
  private statement(n: AstNode, parent: number | undefined, from: number, exported: boolean): void {
    switch (n.type) {
      case "ImportDeclaration": {
        const source = stringValue(n.source);
        if (source === undefined) return;
        const names: string[] = [];
        for (const spec of nodes(n.specifiers)) {
          if (spec.type === "ImportDefaultSpecifier") names.push("default");
          else if (spec.type === "ImportNamespaceSpecifier") names.push("*");
          else names.push(keyName(spec.imported) ?? keyName(spec.local) ?? "");
        }
        this.imports.push({ from: source, names: names.filter(Boolean) });
        return;
      }
      case "ExportNamedDeclaration": {
        const declaration = node(n.declaration);
        if (declaration) { this.statement(declaration, parent, n.start, true); return; }
        const source = stringValue(n.source);
        const names: string[] = [];
        for (const spec of nodes(n.specifiers)) {
          const exportedName = keyName(spec.exported);
          if (exportedName) this.exports.push(exportedName);
          const local = keyName(spec.local);
          if (local) names.push(local);
        }
        if (source !== undefined) this.imports.push({ from: source, names });
        return;
      }
      case "ExportDefaultDeclaration": {
        this.exports.push("default");
        const declaration = node(n.declaration);
        if (declaration && /Declaration$|Expression$/.test(declaration.type)) {
          const name = keyName(declaration.id) ?? "default";
          if (declaration.type === "FunctionDeclaration" || declaration.type === "FunctionExpression" || declaration.type === "ArrowFunctionExpression") this.add(name, "function", n.start, n.end, parent);
          else if (declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression") this.classLike(declaration, name, n.start, parent);
          else if (declaration.type === "TSInterfaceDeclaration") this.add(name, "interface", n.start, n.end, parent);
        }
        return;
      }
      case "ExportAllDeclaration": {
        const source = stringValue(n.source);
        if (source !== undefined) this.imports.push({ from: source, names: ["*"] });
        const as = keyName(n.exported);
        if (as) this.exports.push(as);
        return;
      }
      case "TSExportAssignment":
        this.exports.push("default");
        return;
      case "FunctionDeclaration":
      case "TSDeclareFunction": {
        const name = keyName(n.id);
        if (!name) return;
        this.add(name, "function", from, n.end, parent);
        if (exported) this.exports.push(name);
        return;
      }
      case "ClassDeclaration": {
        const name = keyName(n.id) ?? "default";
        this.classLike(n, name, from, parent);
        if (exported) this.exports.push(name);
        return;
      }
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
      case "TSEnumDeclaration": {
        const name = keyName(n.id);
        if (!name) return;
        this.add(name, n.type === "TSInterfaceDeclaration" ? "interface" : n.type === "TSEnumDeclaration" ? "enum" : "type", from, n.end, parent);
        if (exported) this.exports.push(name);
        return;
      }
      case "TSModuleDeclaration": {
        const name = keyName(n.id) ?? stringValue(n.id);
        if (!name) return;
        const index = this.add(name, "namespace", from, n.end, parent);
        if (exported) this.exports.push(name);
        let body = node(n.body);
        while (body && body.type === "TSModuleDeclaration") body = node(body.body);
        if (body) this.statements(nodes(body.body), index);
        return;
      }
      case "VariableDeclaration": {
        const declarators = nodes(n.declarations);
        for (const declarator of declarators) {
          const id = node(declarator.id);
          if (!id || id.type !== "Identifier") continue;
          const name = String(id.name);
          const init = node(declarator.init);
          const span = declarators.length === 1 ? [from, n.end] : [declarator.start, declarator.end];
          if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) this.add(name, "function", span[0]!, span[1]!, parent);
          else if (init && init.type === "ClassExpression") this.classLike(init, name, span[0]!, parent, span[1]);
          else this.add(name, n.kind === "const" ? "const" : "variable", span[0]!, span[1]!, parent);
          if (exported) this.exports.push(name);
        }
        return;
      }
      case "ExpressionStatement":
        this.testCall(node(n.expression), parent);
        return;
      default:
        return;
    }
  }

  private classLike(n: AstNode, name: string, from: number, parent: number | undefined, end = n.end): void {
    const index = this.add(name, "class", decorated(n, from), end, parent);
    const body = node(n.body);
    for (const member of nodes(body?.body)) {
      const memberName = keyName(member.key) ?? (member.type === "StaticBlock" ? undefined : undefined);
      if (!memberName) continue;
      const start = decorated(member, member.start);
      if (member.type === "MethodDefinition" || member.type === "TSAbstractMethodDefinition") this.add(memberName, "method", start, member.end, index);
      else if (member.type === "PropertyDefinition" || member.type === "TSAbstractPropertyDefinition" || member.type === "AccessorProperty") {
        const value = node(member.value);
        this.add(memberName, value && (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") ? "method" : "property", start, member.end, index);
      }
    }
  }

  /** `describe("…", () => { … })` and `it("…", …)` become test symbols, nested as written. */
  private testCall(expression: AstNode | undefined, parent: number | undefined): void {
    if (!expression || expression.type !== "CallExpression") return;
    const root = calleeRoot(expression.callee);
    if (!root || !TEST_CALLS.has(root)) return;
    const args = nodes(expression.arguments);
    const title = stringValue(args[0]);
    if (title === undefined) return;
    const index = this.add(title, "test", expression.start, expression.end, parent);
    const callback = args.find((arg) => arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression");
    const body = node(callback?.body);
    if (body && body.type === "BlockStatement") {
      for (const statement of nodes(body.body)) if (statement.type === "ExpressionStatement") this.testCall(node(statement.expression), index);
    }
  }
}
