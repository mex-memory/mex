import {
  CallNode,
  ClassNode,
  ConstantPathNode,
  ConstantReadNode,
  ConstantWriteNode,
  DefNode,
  ModuleNode,
  SingletonClassNode,
  StringNode,
  type Node as PrismNode,
} from "@ruby/prism";
import type { NodeKind } from "../../types.js";
import type { ExtractedEdge, ExtractedNode, LanguageExtractor, TSTree } from "../types.js";
import { generateNodeId } from "../node-id.js";
import { parseRubySource } from "../prism-runtime.js";

// Ruby mixins (`include`/`extend`/`prepend`) have no dedicated EdgeKind; they
// graft a module's methods onto a class much like implementing an interface,
// so they're recorded as `implements` rather than added as a new edge kind.
const MIXIN_CALL_NAMES = new Set(["include", "extend", "prepend"]);
const REQUIRE_CALL_NAMES = new Set(["require", "require_relative"]);

class LineIndex {
  private readonly starts: number[] = [0];

  constructor(source: string) {
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  pointAt(offset: number): { row: number; column: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { row: lo, column: offset - this.starts[lo] };
  }
}

class RubyWalker {
  private readonly nodes: ExtractedNode[] = [];
  private readonly edges: ExtractedEdge[] = [];
  private readonly scopeStack: string[] = [];
  private readonly lines: LineIndex;

  constructor(
    private readonly filePath: string,
    private readonly source: string,
  ) {
    this.lines = new LineIndex(source);
  }

  run(programBody: PrismNode[], endOffset: number): { nodes: ExtractedNode[]; edges: ExtractedEdge[] } {
    const fileId = `file:${this.filePath}`;
    this.nodes.push({
      id: fileId,
      kind: "file",
      name: baseName(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: "ruby",
      startLine: 1,
      endLine: this.lines.pointAt(endOffset).row + 1,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
    });

    this.scopeStack.push(fileId);
    for (const child of programBody) this.visit(child);
    this.scopeStack.pop();

    return { nodes: this.nodes, edges: this.edges };
  }

  private visit(node: PrismNode | null): void {
    if (!node) return;

    if (node instanceof ClassNode) return this.extractClass(node);
    if (node instanceof ModuleNode) return this.extractModule(node);
    if (node instanceof DefNode) return this.extractDef(node);
    if (node instanceof ConstantWriteNode && this.atModuleOrClassScope()) {
      return this.extractConstant(node);
    }
    if (node instanceof SingletonClassNode) {
      // `class << self` reopens the singleton class; its defs are effectively
      // static methods of the enclosing class, so splice its body into the
      // current scope rather than emitting a node for the wrapper itself.
      for (const child of node.body ? childrenOf(node.body) : []) this.visit(child);
      return;
    }
    if (node instanceof CallNode) return this.extractTopLevelCall(node);

    for (const child of node.compactChildNodes()) this.visit(child);
  }

  private createNode(kind: NodeKind, name: string, node: PrismNode, extra?: Partial<ExtractedNode>): string | null {
    if (!name) return null;
    const id = generateNodeId(this.filePath, kind, name);
    const start = this.lines.pointAt(node.location.startOffset);
    const end = this.lines.pointAt(node.location.startOffset + node.location.length);
    this.nodes.push({
      id,
      kind,
      name,
      qualifiedName: this.qualify(name),
      filePath: this.filePath,
      language: "ruby",
      startLine: start.row + 1,
      endLine: end.row + 1,
      startColumn: start.column,
      endColumn: end.column,
      isExported: true,
      ...extra,
    });

    const parent = this.scopeStack[this.scopeStack.length - 1];
    if (parent) this.edges.push({ source: parent, target: id, kind: "contains" });
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
    const parent = parentId ? this.nodes.find((n) => n.id === parentId) : null;
    return !!parent && (parent.kind === "file" || parent.kind === "class" || parent.kind === "module");
  }

  private extractClass(node: ClassNode): void {
    const id = this.createNode("class", node.name, node);
    if (!id) return;

    if (node.superclass) {
      const superName = constantPathName(node.superclass);
      if (superName) this.addRef(id, superName, "extends", node.superclass);
    }

    this.scopeStack.push(id);
    for (const child of node.body ? childrenOf(node.body) : []) this.visit(child);
    this.scopeStack.pop();
  }

  private extractModule(node: ModuleNode): void {
    const id = this.createNode("module", node.name, node);
    if (!id) return;

    this.scopeStack.push(id);
    for (const child of node.body ? childrenOf(node.body) : []) this.visit(child);
    this.scopeStack.pop();
  }

  private extractDef(node: DefNode): void {
    const isStatic = node.receiver !== null;
    const isMethod = this.atModuleOrClassScope();
    const id = this.createNode(isMethod ? "method" : "function", node.name, node, {
      signature: this.signatureOf(node),
      isStatic,
    });
    if (!id) return;

    this.scopeStack.push(id);
    for (const child of node.body ? childrenOf(node.body) : []) this.visit(child);
    this.scopeStack.pop();
  }

  private extractConstant(node: ConstantWriteNode): void {
    this.createNode("constant", node.name, node, {
      signature: this.source.slice(node.value.location.startOffset, node.value.location.startOffset + node.value.location.length).slice(0, 200),
    });
  }

  private extractTopLevelCall(node: CallNode): void {
    const ownerId = this.scopeStack[this.scopeStack.length - 1];
    if (ownerId) this.extractCall(node, ownerId);
    for (const child of node.compactChildNodes()) this.visit(child);
  }

  private extractCall(node: CallNode, ownerId: string): void {
    if (REQUIRE_CALL_NAMES.has(node.name)) {
      const target = firstStringArgument(node);
      if (target) this.addRef(`file:${this.filePath}`, target, "imports", node);
      return;
    }

    if (MIXIN_CALL_NAMES.has(node.name) && node.receiver === null) {
      const target = firstConstantArgument(node);
      if (target) this.addRef(ownerId, target, "implements", node);
      return;
    }

    if (node.name === "new" && node.receiver) {
      const className = constantPathName(node.receiver);
      if (className) {
        this.addRef(ownerId, className, "instantiates", node);
        return;
      }
    }

    this.addRef(ownerId, node.name, "calls", node);
  }

  private signatureOf(node: DefNode): string {
    if (!node.parameters) return "()";
    const { startOffset, length } = node.parameters.location;
    return `(${this.source.slice(startOffset, startOffset + length)})`;
  }

  private addRef(source: string, targetName: string, kind: ExtractedEdge["kind"], node: PrismNode): void {
    if (!targetName) return;
    const point = this.lines.pointAt(node.location.startOffset);
    this.edges.push({ source, targetName, kind, line: point.row, column: point.column });
  }
}

function childrenOf(node: PrismNode): PrismNode[] {
  // A `StatementsNode` body is the common case; anything else (a bare
  // single-statement body) is walked as the one child it is.
  return "body" in node && Array.isArray((node as { body: unknown }).body)
    ? ((node as unknown as { body: PrismNode[] }).body)
    : [node];
}

function constantPathName(node: PrismNode): string {
  if (node instanceof ConstantReadNode) return node.name;
  if (node instanceof ConstantPathNode) {
    const prefix = node.parent ? constantPathName(node.parent) : "";
    return prefix ? `${prefix}::${node.name}` : (node.name ?? "");
  }
  return "";
}

function firstStringArgument(node: CallNode): string {
  const args = node.arguments_?.arguments_ ?? [];
  const first = args[0];
  return first instanceof StringNode ? first.unescaped.value : "";
}

function firstConstantArgument(node: CallNode): string {
  const args = node.arguments_?.arguments_ ?? [];
  const first = args[0];
  return first ? constantPathName(first) : "";
}

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export const rubyExtractor: LanguageExtractor = {
  language: "ruby",
  fileExtensions: [".rb"],
  grammarWasm: "prism",
  extract(_tree: TSTree, filePath: string, source: string) {
    // Ignores `_tree`: Prism's AST isn't tree-sitter-shaped, so this re-parses
    // `source` directly rather than adapting `parse()`'s placeholder tree.
    const result = parseRubySource(source);
    if (!result) return { nodes: [], edges: [] };
    return new RubyWalker(filePath, source).run(result.value.statements.body, result.value.location.startOffset + result.value.location.length);
  },
};
