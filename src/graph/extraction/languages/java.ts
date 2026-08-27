import type { Language, NodeKind } from "../../types.js";
import type {
  ExtractedEdge,
  ExtractedNode,
  LanguageExtractor,
  TSNode,
  TSTree,
} from "../types.js";
import {
  generateNodeId,
  getChildByField,
  getNodeText,
  getPrecedingDocstring,
} from "../node-id.js";

const TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);

const METHOD_DECLARATIONS = new Set([
  "method_declaration",
  "constructor_declaration",
]);

const CALL_TYPES = new Set(["method_invocation"]);
const NEW_TYPES = new Set(["object_creation_expression"]);
const ANNOTATION_TYPES = new Set(["annotation", "marker_annotation"]);
const MODIFIER_TYPES = new Set(["modifiers"]);
const PRIMITIVE_TYPES = new Set([
  "boolean",
  "byte",
  "char",
  "double",
  "float",
  "int",
  "long",
  "short",
  "void",
]);

class JavaWalker {
  private readonly nodes: ExtractedNode[] = [];
  private readonly edges: ExtractedEdge[] = [];
  private readonly scopeStack: string[] = [];
  private packageName = "";

  constructor(
    private readonly filePath: string,
    private readonly source: string,
    private readonly language: Language,
  ) {}

  run(root: TSNode): { nodes: ExtractedNode[]; edges: ExtractedEdge[] } {
    const fileId = `file:${this.filePath}`;
    this.nodes.push({
      id: fileId,
      kind: "file",
      name: baseName(this.filePath),
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
    if (node.type === "package_declaration") return this.extractPackage(node);
    if (node.type === "import_declaration") return this.extractImport(node);
    if (TYPE_DECLARATIONS.has(node.type)) return this.extractType(node);
    if (METHOD_DECLARATIONS.has(node.type)) return this.extractMethod(node);
    if (node.type === "field_declaration") return this.extractField(node);

    for (const child of node.namedChildren) this.visit(child);
  }

  private createNode(
    kind: NodeKind,
    name: string,
    node: TSNode,
    extra?: Partial<ExtractedNode>,
  ): string | null {
    if (!name) return null;
    const id = generateNodeId(this.filePath, kind, name);
    this.nodes.push({
      id,
      kind,
      name,
      qualifiedName: this.qualify(name),
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      docstring: getPrecedingDocstring(node, this.source),
      isExported: isExported(node),
      decorators: annotationsOf(node, this.source),
      visibility: visibilityOf(node),
      isStatic: hasModifier(node, "static", this.source),
      isAbstract: hasModifier(node, "abstract", this.source),
      ...extra,
    });

    const parent = this.scopeStack[this.scopeStack.length - 1];
    if (parent) this.edges.push({ source: parent, target: id, kind: "contains" });

    this.addAnnotationRefs(id, node);
    return id;
  }

  private qualify(name: string): string {
    const result: string[] = [];
    if (this.packageName) result.push(this.packageName);
    for (const id of this.scopeStack) {
      const node = this.nodes.find((entry) => entry.id === id);
      if (node && node.kind !== "file" && node.kind !== "namespace") {
        result.push(node.name);
      }
    }
    result.push(name);
    return result.join("::");
  }

  private extractPackage(node: TSNode): void {
    const nameNode = node.namedChildren.find((child) =>
      child.type === "scoped_identifier" || child.type === "identifier"
    );
    const text = nameNode
      ? getNodeText(nameNode, this.source)
      : getNodeText(node, this.source).replace(/^package\s+/, "").replace(/;$/, "").trim();
    if (!text) return;
    this.packageName = text;
    this.createNode("namespace", text, node, { isExported: false });
  }

  private extractImport(node: TSNode): void {
    const imported = importNameOf(node, this.source);
    if (!imported) return;
    const id = generateNodeId(this.filePath, "import", imported);
    this.nodes.push({
      id,
      kind: "import",
      name: imported,
      qualifiedName: imported,
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      isExported: false,
    });
    this.edges.push({ source: `file:${this.filePath}`, target: id, kind: "contains" });
    this.addRef(`file:${this.filePath}`, imported, "imports", node);
  }

  private extractType(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const kind: NodeKind =
      node.type === "interface_declaration" || node.type === "annotation_type_declaration"
        ? "interface"
        : node.type === "enum_declaration"
          ? "enum"
          : "class";

    const id = this.createNode(kind, name, node);
    if (!id) return;

    this.extractInheritance(node, id);

    const body = getChildByField(node, "body") ?? node.namedChildren.find((child) =>
      child.type === "class_body" ||
      child.type === "interface_body" ||
      child.type === "enum_body" ||
      child.type === "annotation_type_body"
    );
    if (!body) return;

    this.scopeStack.push(id);
    for (const child of body.namedChildren) this.visit(child);
    this.scopeStack.pop();
  }

  private extractInheritance(node: TSNode, id: string): void {
    const superclass = getChildByField(node, "superclass");
    if (superclass) {
      for (const target of typeTargets(superclass, this.source)) {
        this.addRef(id, target, "extends", superclass);
      }
    }

    const interfaces = getChildByField(node, "interfaces");
    if (interfaces) {
      for (const target of typeTargets(interfaces, this.source)) {
        this.addRef(id, target, "implements", interfaces);
      }
    }
  }

  private extractMethod(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const returnTypeNode = getChildByField(node, "type");
    const returnType = returnTypeNode ? typeTargets(returnTypeNode, this.source)[0] : undefined;
    const id = this.createNode("method", name, node, {
      signature: signatureOf(node, this.source),
      returnType,
    });
    if (!id) return;

    if (returnTypeNode && returnType && !PRIMITIVE_TYPES.has(returnType)) {
      this.addRef(id, returnType, "returns", returnTypeNode);
    }

    const params = getChildByField(node, "parameters");
    if (params) this.extractParameterTypeRefs(params, id);

    const body = getChildByField(node, "body");
    if (body) this.walkBody(body, id);
  }

  private extractField(node: TSNode): void {
    const declarator = getChildByField(node, "declarator") ??
      node.namedChildren.find((child) => child.type === "variable_declarator");
    const nameNode = declarator ? getChildByField(declarator, "name") : null;
    if (!nameNode) return;

    const id = this.createNode("field", getNodeText(nameNode, this.source), node);
    if (!id) return;

    const typeNode = getChildByField(node, "type");
    if (typeNode) {
      for (const target of typeTargets(typeNode, this.source)) {
        this.addRef(id, target, "type_of", typeNode);
      }
    }

    const value = getChildByField(declarator!, "value");
    if (value) this.walkBody(value, id);
  }

  private extractParameterTypeRefs(params: TSNode, ownerId: string): void {
    for (const param of params.namedChildren) {
      if (param.type !== "formal_parameter" && param.type !== "spread_parameter") continue;
      const typeNode = getChildByField(param, "type");
      if (!typeNode) continue;
      for (const target of typeTargets(typeNode, this.source)) {
        this.addRef(ownerId, target, "type_of", typeNode);
      }
      for (const annotation of annotationNodesOf(param)) {
        const name = annotationName(annotation, this.source);
        if (name) this.addRef(ownerId, name, "decorates", annotation);
      }
    }
  }

  private walkBody(node: TSNode, owner: string): void {
    if (CALL_TYPES.has(node.type)) {
      this.extractCall(node, owner);
    } else if (NEW_TYPES.has(node.type)) {
      this.extractInstantiation(node, owner);
    }

    for (const child of node.namedChildren) this.walkBody(child, owner);
  }

  private extractCall(node: TSNode, owner: string): void {
    const nameNode = getChildByField(node, "name") ?? node.namedChildren[0];
    const name = nameNode ? getNodeText(nameNode, this.source) : "";
    if (name) this.addRef(owner, lastSegment(name), "calls", node);
  }

  private extractInstantiation(node: TSNode, owner: string): void {
    const typeNode = getChildByField(node, "type") ?? node.namedChildren[0];
    if (!typeNode) return;
    for (const target of typeTargets(typeNode, this.source)) {
      this.addRef(owner, target, "instantiates", typeNode);
      break;
    }
  }

  private addAnnotationRefs(source: string, node: TSNode): void {
    for (const annotation of annotationNodesOf(node)) {
      const name = annotationName(annotation, this.source);
      if (name) this.addRef(source, name, "decorates", annotation);
    }
  }

  private addRef(
    source: string,
    targetName: string,
    kind: ExtractedEdge["kind"],
    node: TSNode,
  ): void {
    if (!targetName || PRIMITIVE_TYPES.has(targetName)) return;
    this.edges.push({
      source,
      targetName,
      kind,
      line: node.startPosition.row,
      column: node.startPosition.column,
    });
  }
}

function nameOf(node: TSNode, source: string): string {
  const nameNode = getChildByField(node, "name");
  return nameNode ? getNodeText(nameNode, source) : "";
}

function signatureOf(node: TSNode, source: string): string | undefined {
  const params = getChildByField(node, "parameters");
  if (!params) return undefined;
  const returnType = getChildByField(node, "type");
  return returnType
    ? `${getNodeText(params, source)}: ${getNodeText(returnType, source)}`
    : getNodeText(params, source);
}

function importNameOf(node: TSNode, source: string): string {
  const raw = getNodeText(node, source)
    .replace(/^import\s+/, "")
    .replace(/^static\s+/, "")
    .replace(/;$/, "")
    .trim();
  return raw.replace(/\.\*$/, "").trim();
}

function annotationsOf(node: TSNode, source: string): string[] | undefined {
  const names = annotationNodesOf(node)
    .map((annotation) => annotationName(annotation, source))
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? [...new Set(names)] : undefined;
}

function annotationNodesOf(node: TSNode): TSNode[] {
  const modifiers = node.namedChildren.find((child) => MODIFIER_TYPES.has(child.type));
  if (!modifiers) return [];
  return modifiers.namedChildren.filter((child) => ANNOTATION_TYPES.has(child.type));
}

function annotationName(node: TSNode, source: string): string {
  const nameNode = node.namedChildren.find((child) =>
    child.type === "identifier" ||
    child.type === "scoped_identifier" ||
    child.type === "type_identifier" ||
    child.type === "scoped_type_identifier"
  );
  return nameNode ? lastSegment(getNodeText(nameNode, source)) : "";
}

function hasModifier(node: TSNode, keyword: string, source: string): boolean {
  const modifiers = node.namedChildren.find((child) => MODIFIER_TYPES.has(child.type));
  if (!modifiers) return false;
  return modifiers.children.some((child) => getNodeText(child, source) === keyword);
}

function visibilityOf(node: TSNode): ExtractedNode["visibility"] {
  const modifiers = node.namedChildren.find((child) => MODIFIER_TYPES.has(child.type));
  if (!modifiers) return undefined;
  for (const child of modifiers.children) {
    if (child.type === "public") return "public";
    if (child.type === "private") return "private";
    if (child.type === "protected") return "protected";
  }
  return undefined;
}

function isExported(node: TSNode): boolean {
  return visibilityOf(node) === "public" || TYPE_DECLARATIONS.has(node.type);
}

function typeTargets(node: TSNode, source: string): string[] {
  const raw = getNodeText(node, source)
    .replace(/\b(?:extends|implements|throws|new)\b/g, " ")
    .replace(/@\w+(?:\([^)]*\))?/g, " ");
  const names = new Set<string>();
  const re = /[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*/g;
  for (const match of raw.matchAll(re)) {
    const name = lastSegment(match[0]!);
    if (!JAVA_CONTAINER_TYPES.has(name)) names.add(name);
  }
  if (names.size > 0) return [...names];
  const fallback = lastSegment(raw.replace(/[<>\[\],?&|]/g, " ").trim().split(/\s+/)[0] ?? "");
  return fallback && !JAVA_CONTAINER_TYPES.has(fallback) ? [fallback] : [];
}

const JAVA_CONTAINER_TYPES = new Set([
  "Class",
  "Collection",
  "Iterable",
  "List",
  "Map",
  "Object",
  "Optional",
  "Provider",
  "Set",
  "Supplier",
  "String",
]);

function lastSegment(value: string): string {
  const dot = value.lastIndexOf(".");
  return dot < 0 ? value : value.slice(dot + 1);
}

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.substring(normalized.lastIndexOf("/") + 1);
}

export const javaExtractor: LanguageExtractor = {
  language: "java",
  fileExtensions: [".java"],
  grammarWasm: "tree-sitter-java.wasm",

  extract(tree: TSTree, filePath: string, source: string) {
    return new JavaWalker(filePath, source, "java").run(tree.rootNode);
  },
};
