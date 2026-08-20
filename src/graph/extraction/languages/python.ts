import type { Language, NodeKind } from "../../types.js";
import type {
  ExtractedEdge,
  ExtractedNode,
  LanguageExtractor,
  TSNode,
  TSTree,
} from "../types.js";
import { canonicalNodeIdentity, generateNodeId, getChildByField, getNodeText } from "../node-id.js";

const FUNCTION_TYPES = new Set(["function_definition"]);
const CLASS_TYPES = new Set(["class_definition"]);
const DECORATED_TYPES = new Set(["decorated_definition"]);
const ASSIGNMENT_TYPES = new Set(["assignment"]);
const CALL_TYPES = new Set(["call"]);

class PythonWalker {
  private readonly nodes: ExtractedNode[] = [];
  private readonly edges: ExtractedEdge[] = [];
  private readonly scopeStack: string[] = [];
  private readonly identityOccurrences = new Map<string, number>();

  constructor(
    private readonly filePath: string,
    private readonly source: string,
    private readonly language: Language,
  ) {}

  run(root: TSNode): { nodes: ExtractedNode[]; edges: ExtractedEdge[] } {
    const fileName = baseName(this.filePath);
    const fileId = generateNodeId(this.filePath, "file", fileName, this.filePath, "source-file");
    this.nodes.push({
      id: fileId,
      identityKey: canonicalNodeIdentity(this.filePath, "file", this.filePath, "source-file"),
      kind: "file",
      name: fileName,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: this.language,
      startLine: 1,
      endLine: root.endPosition.row + 1,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
    });

    this.scopeStack.push(fileId);
    for (const child of root.namedChildren) this.visit(child);
    this.scopeStack.pop();

    return { nodes: this.nodes, edges: this.edges };
  }

  private visit(node: TSNode): void {
    const type = node.type;

    if (DECORATED_TYPES.has(type)) {
      const def = node.namedChildren.find(
        (child) => FUNCTION_TYPES.has(child.type) || CLASS_TYPES.has(child.type),
      );
      if (def) return this.visit(def);
      return;
    }

    if (FUNCTION_TYPES.has(type)) return this.extractFunction(node);
    if (CLASS_TYPES.has(type)) return this.extractClass(node);
    if (ASSIGNMENT_TYPES.has(type) && this.atModuleOrClassScope()) {
      return this.extractVariable(node);
    }

    if (type === "import_statement" || type === "import_from_statement") {
      return this.extractImport(node);
    }

    // Python statements can be nested in other blocks like `if`, `while`, `try`, etc.
    for (const child of node.namedChildren) this.visit(child);
  }

  private createNode(
    kind: NodeKind,
    name: string,
    node: TSNode,
    extra?: Partial<ExtractedNode>,
  ): string | null {
    if (!name) return null;
    const qualifiedName = this.qualify(name);
    const baseIdentity = canonicalNodeIdentity(this.filePath, kind, qualifiedName, kind, extra?.signature);
    const ordinal = this.identityOccurrences.get(baseIdentity) ?? 0;
    this.identityOccurrences.set(baseIdentity, ordinal + 1);
    const declarationRole = ordinal === 0 ? kind : `${kind}:ordinal:${ordinal}`;
    const identityKey = canonicalNodeIdentity(this.filePath, kind, qualifiedName, declarationRole, extra?.signature);
    const id = generateNodeId(this.filePath, kind, name, qualifiedName, declarationRole, extra?.signature);
    this.nodes.push({
      id,
      identityKey,
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      docstring: getPythonDocstring(node, this.source),
      isExported: isExported(name),
      ...extra,
    });

    const parent = this.scopeStack[this.scopeStack.length - 1];
    if (parent) {
      this.edges.push({ source: parent, target: id, kind: "contains" });
    }
    return id;
  }

  private qualify(name: string): string {
    const parts: string[] = [];
    for (const scopeId of this.scopeStack) {
      const scope = this.nodes.find((n) => n.id === scopeId);
      if (scope && scope.kind !== "file") parts.push(scope.name);
    }
    parts.push(name);
    return parts.join("::");
  }

  private atModuleOrClassScope(): boolean {
    const parentId = this.scopeStack[this.scopeStack.length - 1];
    if (!parentId) return false;
    const parent = this.nodes.find((n) => n.id === parentId);
    return !!parent && (parent.kind === "file" || parent.kind === "class");
  }

  private extractFunction(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;

    const parentId = this.scopeStack[this.scopeStack.length - 1];
    const parent = parentId ? this.nodes.find((node) => node.id === parentId) : null;
    const isMethod = parent && parent.kind === "class";

    const id = this.createNode(isMethod ? "method" : "function", name, node, {
      signature: signatureOf(node, this.source),
      returnType: returnTypeOf(node, this.source),
      isAsync: isAsync(node),
    });
    if (!id) return;

    const body = getChildByField(node, "body");
    if (body) this.walkBody(body, id);
  }

  private extractClass(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("class", name, node);
    if (!id) return;

    this.extractHeritage(node, id);
    const body = getChildByField(node, "body");
    if (body) {
      this.scopeStack.push(id);
      for (const member of body.namedChildren) this.visit(member);
      this.scopeStack.pop();
    }
  }

  private extractVariable(node: TSNode): void {
    const left = getChildByField(node, "left") ?? node.namedChild(0);
    if (!left) return;

    let name = "";
    if (left.type === "identifier") {
      name = getNodeText(left, this.source);
    } else if (left.type === "pattern_list" || left.type === "tuple") {
      // Complex assignment: skip until every target can be represented reliably.
      return;
    }

    if (!name) return;

    // By convention in Python, uppercase variables at module scope are constants.
    const parentId = this.scopeStack[this.scopeStack.length - 1];
    const parent = parentId ? this.nodes.find((node) => node.id === parentId) : null;
    const isTopLevel = parent && parent.kind === "file";

    const isConst = isTopLevel && /^[A-Z0-9_]+$/.test(name);

    const right = getChildByField(node, "right");
    const id = this.createNode(isConst ? "constant" : "variable", name, node, {
      signature: right ? getNodeText(right, this.source).slice(0, 200) : undefined,
    });

    if (id && right) this.walkBody(right, id);
  }

  private extractHeritage(node: TSNode, fromId: string): void {
    const superclasses = getChildByField(node, "superclasses");
    if (!superclasses) return;
    for (const child of superclasses.namedChildren) {
      // `metaclass=Meta` configures class creation; it is not a base class.
      if (child.type === "keyword_argument") continue;
      this.addRef(fromId, getNodeText(child, this.source), "extends", child);
    }
  }

  private extractImport(node: TSNode): void {
    const fileId = this.scopeStack[0];
    if (!fileId) return;
    const grouped = new Map<string, Array<{ localName: string; importedName: string }>>();
    for (const binding of pythonImportBindings(getNodeText(node, this.source))) {
      const entries = grouped.get(binding.moduleSpecifier) ?? [];
      entries.push({ localName: binding.localName, importedName: binding.importedName });
      grouped.set(binding.moduleSpecifier, entries);
    }
    for (const [moduleSpecifier, bindings] of grouped) {
      this.addRef(fileId, moduleSpecifier, "imports", node, { bindings });
    }
  }

  private walkBody(body: TSNode, ownerId: string): void {
    const type = body.type;

    if (CALL_TYPES.has(type)) {
      this.extractCall(body, ownerId);
    } else if (FUNCTION_TYPES.has(type) || DECORATED_TYPES.has(type)) {
      this.scopeStack.push(ownerId);
      this.visit(body);
      this.scopeStack.pop();
      return;
    } else if (CLASS_TYPES.has(type)) {
      this.scopeStack.push(ownerId);
      this.visit(body);
      this.scopeStack.pop();
      return;
    }

    for (const child of body.namedChildren) this.walkBody(child, ownerId);
  }

  private extractCall(node: TSNode, ownerId: string): void {
    const fn = getChildByField(node, "function") ?? node.namedChild(0);
    let calleeName = "";
    if (fn) {
      if (fn.type === "attribute") {
        const attribute = getChildByField(fn, "attribute");
        if (attribute) {
          calleeName = getNodeText(attribute, this.source);
        }
      } else {
        calleeName = getNodeText(fn, this.source);
      }
    }
    if (calleeName) {
      // Python has no `new` keyword. Follow the language's class naming
      // convention so constructor-shaped calls can bind to class nodes.
      const kind: ExtractedEdge["kind"] = isConstructorName(calleeName)
        ? "instantiates"
        : "calls";
      this.addRef(ownerId, calleeName, kind, node);
    }

    // `walkBody` continues through this call's children, including arguments.
    // Do not descend here as well or nested calls (`outer(inner())`) duplicate.
  }

  private addRef(
    source: string,
    targetName: string,
    kind: ExtractedEdge["kind"],
    node: TSNode,
    metadata?: Record<string, unknown>,
  ): void {
    if (!targetName) return;
    this.edges.push({
      source,
      targetName,
      kind,
      line: node.startPosition.row,
      column: node.startPosition.column,
      metadata,
    });
  }
}

// ----------------------------------------------------------------------------
// Python node helpers
// ----------------------------------------------------------------------------

function nameOf(node: TSNode, source: string): string {
  const nameNode = getChildByField(node, "name");
  return nameNode ? getNodeText(nameNode, source) : "";
}

function pythonImportBindings(statement: string): Array<{
  moduleSpecifier: string; importedName: string; localName: string;
}> {
  const normalized = statement.replace(/[()]/g, " ").replace(/\\\s*\n/g, " ").trim();
  const direct = normalized.match(/^import\s+(.+)$/s);
  if (direct) {
    return direct[1]!.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [moduleSpecifier, alias] = entry.split(/\s+as\s+/);
      return {
        moduleSpecifier: moduleSpecifier!.trim(),
        importedName: "*",
        localName: alias?.trim() || moduleSpecifier!.trim().split(".")[0]!,
      };
    });
  }
  const from = normalized.match(/^from\s+([^\s]+)\s+import\s+(.+)$/s);
  if (!from) return [];
  const moduleName = from[1]!;
  return from[2]!.split(",").map((entry) => entry.trim()).filter(Boolean).flatMap((entry) => {
    const [importedName, alias] = entry.split(/\s+as\s+/);
    const imported = importedName!.trim();
    const importsSiblingModule = /^\.+$/.test(moduleName);
    const localName = alias?.trim() || imported;
    if (!importsSiblingModule) return [{ moduleSpecifier: moduleName, importedName: imported, localName }];
    // `from . import name` can mean a symbol from __init__.py or a sibling
    // module. Preserve both explicit candidates; later binding resolves only
    // the one(s) backed by indexed files/symbols.
    return [
      { moduleSpecifier: moduleName, importedName: imported, localName },
      { moduleSpecifier: `${moduleName}${imported}`, importedName: "*", localName },
    ];
  });
}

function isConstructorName(name: string): boolean {
  const simpleName = name.slice(name.lastIndexOf(".") + 1);
  return /^[A-Z]/.test(simpleName);
}

function signatureOf(node: TSNode, source: string): string | undefined {
  const params = getChildByField(node, "parameters");
  if (!params) return undefined;
  let sig = getNodeText(params, source);
  const ret = getChildByField(node, "return_type");
  if (ret) sig += " -> " + getNodeText(ret, source);
  return sig;
}

function returnTypeOf(node: TSNode, source: string): string | undefined {
  const ret = getChildByField(node, "return_type");
  if (!ret) return undefined;
  return getNodeText(ret, source);
}

function isExported(name: string): boolean {
  return !name.startsWith("_") || (name.startsWith("__") && name.endsWith("__"));
}

function isAsync(node: TSNode): boolean {
  // tree-sitter-python parses 'async def' by having an 'async' node as the first child of function_definition
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === "async") return true;
  }
  return false;
}

function getPythonDocstring(node: TSNode, source: string): string | undefined {
  const body = getChildByField(node, "body");
  if (!body || body.type !== "block") return undefined;

  const firstStmt = body.namedChild(0);
  if (firstStmt && firstStmt.type === "expression_statement") {
    const expr = firstStmt.namedChild(0);
    if (expr && expr.type === "string") {
      const text = getNodeText(expr, source);
      // Python docstrings may use a raw/unicode prefix and single or triple
      // quotes. Strip a matched delimiter pair without interpreting escapes.
      const unprefixed = text.replace(/^[rRuU]{1,2}(?=["'])/, "");
      const delimiter = ["\"\"\"", "'''", "\"", "'"]
        .find((quote) => unprefixed.startsWith(quote) && unprefixed.endsWith(quote));
      if (delimiter) {
        return unprefixed.slice(delimiter.length, -delimiter.length).trim();
      }
    }
  }
  return undefined;
}

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export const pythonExtractor: LanguageExtractor = {
  language: "python",
  fileExtensions: [".py"],
  grammarWasm: "tree-sitter-python.wasm",
  extract(tree: TSTree, filePath: string, source: string) {
    return new PythonWalker(filePath, source, "python").run(tree.rootNode);
  },
};
