// ============================================================================
// mex code-graph — Java extractor
// ============================================================================
//
// Max-surface LanguageExtractor for tree-sitter-java. Pure one-file walk;
// cross-file imports resolve later via resolveJavaModulePath.

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

const TYPE_DECL_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);

const SKIP_RECEIVERS = new Set(["this", "super"]);

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
    switch (node.type) {
      case "package_declaration":
        return this.extractPackage(node);
      case "import_declaration":
        return this.extractImport(node);
      case "class_declaration":
        return this.extractClassLike(node, "class");
      case "interface_declaration":
        return this.extractClassLike(node, "interface");
      case "enum_declaration":
        return this.extractEnum(node);
      case "record_declaration":
        return this.extractRecord(node);
      case "annotation_type_declaration":
        return this.extractAnnotationType(node);
      case "module_declaration":
        return this.extractModule(node);
      case "method_declaration":
        return this.extractMethod(node);
      case "constructor_declaration":
        return this.extractConstructor(node);
      case "field_declaration":
        return this.extractFields(node);
      default:
        for (const child of node.namedChildren) this.visit(child);
    }
  }

  private createNode(
    kind: NodeKind,
    name: string,
    node: TSNode,
    extra?: Partial<ExtractedNode>,
  ): string | null {
    if (!name) return null;
    const id = generateNodeId(this.filePath, kind, name);
    const mods = modifiersOf(node);
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
      visibility: mods.visibility,
      isExported: mods.isPublic,
      isStatic: mods.isStatic || undefined,
      isAbstract: mods.isAbstract || undefined,
      decorators: mods.decorators.length > 0 ? mods.decorators : undefined,
      ...extra,
    });

    const parent = this.scopeStack[this.scopeStack.length - 1];
    if (parent) {
      this.edges.push({ source: parent, target: id, kind: "contains" });
    }

    for (const dec of mods.decorators) {
      this.edges.push({
        source: id,
        targetName: dec,
        kind: "decorates",
        line: node.startPosition.row,
        column: node.startPosition.column,
      });
    }

    return id;
  }

  private qualify(name: string): string {
    const parts: string[] = [];
    if (this.packageName) parts.push(this.packageName);
    for (const scopeId of this.scopeStack) {
      const scope = this.nodes.find((n) => n.id === scopeId);
      if (
        scope &&
        scope.kind !== "file" &&
        scope.kind !== "namespace"
      ) {
        parts.push(scope.name);
      } else if (scope && scope.kind === "namespace" && scope.name !== this.packageName) {
        parts.push(scope.name);
      }
    }
    parts.push(name);
    return parts.join("::");
  }

  private extractPackage(node: TSNode): void {
    const nameNode =
      node.namedChildren.find(
        (c) => c.type === "scoped_identifier" || c.type === "identifier",
      ) ?? null;
    if (!nameNode) return;
    this.packageName = getNodeText(nameNode, this.source);
    this.createNode("namespace", this.packageName, node, {
      isExported: true,
    });
  }

  private extractImport(node: TSNode): void {
    const pathNode = node.namedChildren.find(
      (c) =>
        c.type === "scoped_identifier" ||
        c.type === "identifier",
    );
    if (!pathNode) return;
    let targetName = getNodeText(pathNode, this.source);
    if (node.namedChildren.some((c) => c.type === "asterisk")) {
      targetName = `${targetName}.*`;
    }
    this.addRef(`file:${this.filePath}`, targetName, "imports", node);
  }

  private extractClassLike(node: TSNode, kind: "class" | "interface"): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode(kind, name, node, {
      typeParameters: typeParametersOf(node, this.source),
    });
    if (!id) return;

    this.extractHeritage(node, id);

    const body =
      getChildByField(node, "body") ??
      node.namedChildren.find(
        (c) =>
          c.type === "class_body" ||
          c.type === "interface_body",
      );
    if (!body) return;
    this.scopeStack.push(id);
    for (const member of body.namedChildren) this.visitMember(member);
    this.scopeStack.pop();
  }

  private extractEnum(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("enum", name, node);
    if (!id) return;
    this.extractHeritage(node, id);

    const body =
      getChildByField(node, "body") ??
      node.namedChildren.find((c) => c.type === "enum_body");
    if (!body) return;
    this.scopeStack.push(id);
    for (const member of body.namedChildren) {
      if (member.type === "enum_constant") {
        const constName = nameOf(member, this.source);
        if (constName) this.createNode("enum_member", constName, member);
      } else {
        this.visitMember(member);
      }
    }
    this.scopeStack.pop();
  }

  private extractRecord(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("class", name, node, {
      typeParameters: typeParametersOf(node, this.source),
    });
    if (!id) return;
    this.extractHeritage(node, id);

    this.scopeStack.push(id);
    const params =
      getChildByField(node, "parameters") ??
      node.namedChildren.find((c) => c.type === "formal_parameters");
    if (params) {
      for (const param of params.namedChildren) {
        if (param.type !== "formal_parameter") continue;
        const fieldName = nameOf(param, this.source);
        if (fieldName) {
          this.createNode("field", fieldName, param, {
            isExported: true,
          });
        }
      }
    }
    const body =
      getChildByField(node, "body") ??
      node.namedChildren.find((c) => c.type === "class_body");
    if (body) {
      for (const member of body.namedChildren) this.visitMember(member);
    }
    this.scopeStack.pop();
  }

  private extractAnnotationType(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("interface", name, node);
    if (!id) return;

    const body =
      getChildByField(node, "body") ??
      node.namedChildren.find((c) => c.type === "annotation_type_body");
    if (!body) return;
    this.scopeStack.push(id);
    for (const member of body.namedChildren) {
      if (member.type === "annotation_type_element_declaration") {
        const elName = nameOf(member, this.source);
        if (!elName) continue;
        const returnType = typeNameOf(getChildByField(member, "type"), this.source);
        this.createNode("method", elName, member, {
          returnType,
          signature: returnType ? `() -> ${returnType}` : "()",
        });
      } else if (TYPE_DECL_TYPES.has(member.type)) {
        this.visit(member);
      }
    }
    this.scopeStack.pop();
  }

  private extractModule(node: TSNode): void {
    const nameNode = getChildByField(node, "name");
    const name = nameNode
      ? getNodeText(nameNode, this.source)
      : nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("namespace", name, node, { isExported: true });
    if (!id) return;

    const body =
      getChildByField(node, "body") ??
      node.namedChildren.find((c) => c.type === "module_body");
    if (!body) return;
    for (const dir of body.namedChildren) {
      if (dir.type === "requires_module_directive") {
        const mod =
          getChildByField(dir, "module") ??
          dir.namedChildren.find(
            (c) => c.type === "scoped_identifier" || c.type === "identifier",
          );
        if (mod) {
          this.addRef(id, getNodeText(mod, this.source), "imports", dir);
        }
      } else if (dir.type === "exports_module_directive") {
        const pkg = dir.namedChildren.find(
          (c) => c.type === "scoped_identifier" || c.type === "identifier",
        );
        if (pkg) {
          this.addRef(id, getNodeText(pkg, this.source), "exports", dir);
        }
      }
    }
  }

  private visitMember(node: TSNode): void {
    switch (node.type) {
      case "method_declaration":
        return this.extractMethod(node);
      case "constructor_declaration":
        return this.extractConstructor(node);
      case "field_declaration":
        return this.extractFields(node);
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration":
      case "record_declaration":
      case "annotation_type_declaration":
        return this.visit(node);
      case "static_initializer":
      case "block":
        return this.walkBody(node, this.scopeStack[this.scopeStack.length - 1]!);
      default:
        for (const child of node.namedChildren) this.visitMember(child);
    }
  }

  private extractHeritage(node: TSNode, fromId: string): void {
    const superclass = getChildByField(node, "superclass");
    if (superclass) {
      const typeName = typeNameOf(superclass, this.source);
      if (typeName) this.addRef(fromId, typeName, "extends", superclass);
    }
    // interfaces field name varies: super_interfaces / interfaces
    const ifaces =
      getChildByField(node, "interfaces") ??
      node.namedChildren.find(
        (c) =>
          c.type === "super_interfaces" ||
          c.type === "extends_interfaces" ||
          c.type === "type_list",
      );
    if (ifaces) {
      const list =
        ifaces.type === "type_list"
          ? ifaces
          : ifaces.namedChildren.find((c) => c.type === "type_list") ?? ifaces;
      for (const child of list.namedChildren) {
        const typeName = typeNameOf(child, this.source);
        if (!typeName) continue;
        const kind =
          node.type === "interface_declaration" ? "extends" : "implements";
        this.addRef(fromId, typeName, kind, child);
      }
    }
  }

  private extractMethod(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const returnType = typeNameOf(getChildByField(node, "type"), this.source);
    const params =
      getChildByField(node, "parameters") ??
      node.namedChildren.find((c) => c.type === "formal_parameters");
    const paramText = params ? getNodeText(params, this.source) : "()";
    const signature = returnType
      ? `${paramText} -> ${returnType}`
      : paramText;

    const id = this.createNode("method", name, node, {
      signature,
      returnType,
    });
    if (!id) return;

    if (returnType && returnType !== "void") {
      this.addRef(id, returnType, "returns", node);
    }

    const body = getChildByField(node, "body");
    if (body) this.walkBody(body, id);
  }

  private extractConstructor(node: TSNode): void {
    const params =
      getChildByField(node, "parameters") ??
      node.namedChildren.find((c) => c.type === "formal_parameters");
    const paramText = params ? getNodeText(params, this.source) : "()";
    const id = this.createNode("method", "<init>", node, {
      signature: paramText,
    });
    if (!id) return;
    const body =
      getChildByField(node, "body") ??
      node.namedChildren.find((c) => c.type === "constructor_body");
    if (body) this.walkBody(body, id);
  }

  private extractFields(node: TSNode): void {
    const mods = modifiersOf(node);
    const typeNode =
      getChildByField(node, "type") ??
      node.namedChildren.find(
        (c) =>
          c.type.endsWith("_type") ||
          c.type === "type_identifier" ||
          c.type === "generic_type" ||
          c.type === "scoped_type_identifier" ||
          c.type === "array_type",
      ) ??
      null;
    const typeName = typeNameOf(typeNode, this.source);

    for (const child of node.namedChildren) {
      if (child.type !== "variable_declarator") continue;
      const name = nameOf(child, this.source);
      if (!name) continue;
      const isConst =
        mods.isStatic &&
        mods.isFinal &&
        /^[A-Z][A-Z0-9_]*$/.test(name);
      const id = this.createNode(isConst ? "constant" : "field", name, child, {
        visibility: mods.visibility,
        isExported: mods.isPublic,
        isStatic: mods.isStatic || undefined,
        decorators: mods.decorators.length > 0 ? mods.decorators : undefined,
        signature: typeName,
      });
      if (id && typeName) {
        this.addRef(id, typeName, "type_of", node);
      }
      // field initializers may call methods
      for (const part of child.namedChildren) {
        if (part.type !== "identifier") this.walkBody(part, id ?? this.scopeStack[this.scopeStack.length - 1]!);
      }
    }
  }

  private walkBody(body: TSNode, ownerId: string): void {
    const type = body.type;

    if (type === "method_invocation") {
      this.extractCall(body, ownerId);
    } else if (type === "object_creation_expression") {
      this.extractInstantiation(body, ownerId);
    } else if (type === "method_reference") {
      this.extractMethodRef(body, ownerId);
    } else if (TYPE_DECL_TYPES.has(type)) {
      this.scopeStack.push(ownerId);
      this.visit(body);
      this.scopeStack.pop();
      return;
    } else if (type === "method_declaration" || type === "constructor_declaration") {
      this.scopeStack.push(ownerId);
      this.visitMember(body);
      this.scopeStack.pop();
      return;
    }

    for (const child of body.namedChildren) this.walkBody(child, ownerId);
  }

  private extractCall(node: TSNode, ownerId: string): void {
    const nameNode = getChildByField(node, "name");
    const objectNode = getChildByField(node, "object");
    let calleeName = nameNode ? getNodeText(nameNode, this.source) : "";
    if (!calleeName) {
      // fallback: last identifier
      const ids = node.namedChildren.filter((c) => c.type === "identifier");
      calleeName = ids.length ? getNodeText(ids[ids.length - 1]!, this.source) : "";
    }
    if (objectNode) {
      const recv = getNodeText(objectNode, this.source);
      if (SKIP_RECEIVERS.has(recv.split(".")[0] ?? "")) {
        // still emit call on method name
      }
    }
    if (calleeName) this.addRef(ownerId, calleeName, "calls", node);
  }

  private extractInstantiation(node: TSNode, ownerId: string): void {
    const typeNode = getChildByField(node, "type");
    const typeName = typeNameOf(typeNode, this.source);
    if (typeName) this.addRef(ownerId, typeName, "instantiates", node);
  }

  private extractMethodRef(node: TSNode, ownerId: string): void {
    const ids = node.namedChildren.filter(
      (c) => c.type === "identifier" || c.type === "type_identifier",
    );
    if (ids.length === 0) return;
    const methodName = getNodeText(ids[ids.length - 1]!, this.source);
    if (methodName) this.addRef(ownerId, methodName, "function_ref", node);
  }

  private addRef(
    source: string,
    targetName: string,
    kind: ExtractedEdge["kind"],
    node: TSNode,
  ): void {
    if (!targetName) return;
    this.edges.push({
      source,
      targetName,
      kind,
      line: node.startPosition.row,
      column: node.startPosition.column,
    });
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function nameOf(node: TSNode, source: string): string {
  const nameNode = getChildByField(node, "name");
  return nameNode ? getNodeText(nameNode, source) : "";
}

function typeNameOf(node: TSNode | null, source: string): string | undefined {
  if (!node) return undefined;
  if (node.type === "void_type") return "void";
  if (node.type === "type_identifier" || node.type === "identifier") {
    return getNodeText(node, source);
  }
  if (node.type === "generic_type") {
    const base =
      getChildByField(node, "type") ??
      node.namedChildren.find((c) => c.type === "type_identifier");
    return base ? getNodeText(base, source) : getNodeText(node, source);
  }
  if (node.type === "scoped_type_identifier") {
    return getNodeText(node, source);
  }
  if (node.type === "array_type") {
    const elem =
      getChildByField(node, "element") ?? node.namedChild(0);
    const base = typeNameOf(elem, source);
    return base ? `${base}[]` : undefined;
  }
  // superclass / type wrappers: first type_identifier descendant text
  const id = node.descendantsOfType("type_identifier")[0];
  if (id) return getNodeText(id, source);
  const text = getNodeText(node, source).trim();
  return text || undefined;
}

function typeParametersOf(node: TSNode, source: string): string[] | undefined {
  const params = node.namedChildren.find((c) => c.type === "type_parameters");
  if (!params) return undefined;
  const names = params.namedChildren
    .filter((c) => c.type === "type_parameter")
    .map((c) => {
      const n = getChildByField(c, "name") ?? c.namedChild(0);
      return n ? getNodeText(n, source) : "";
    })
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}

interface ModInfo {
  visibility?: "public" | "private" | "protected" | "internal";
  isPublic: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  decorators: string[];
}

function modifiersOf(node: TSNode): ModInfo {
  const info: ModInfo = {
    isPublic: false,
    isStatic: false,
    isAbstract: false,
    isFinal: false,
    decorators: [],
  };
  // modifiers may be on node or parent-wrapped; search self and direct children
  const modNode =
    node.namedChildren.find((c) => c.type === "modifiers") ??
    (node.type === "modifiers" ? node : null);

  const scan = (n: TSNode): void => {
    for (const child of n.children) {
      const t = child.type;
      if (t === "public") {
        info.isPublic = true;
        info.visibility = "public";
      } else if (t === "private") {
        info.visibility = "private";
      } else if (t === "protected") {
        info.visibility = "protected";
      } else if (t === "static") {
        info.isStatic = true;
      } else if (t === "abstract") {
        info.isAbstract = true;
      } else if (t === "final") {
        info.isFinal = true;
      } else if (t === "marker_annotation" || t === "annotation") {
        const nameNode = child.childForFieldName("name");
        if (nameNode) {
          const full = nameNode.text;
          const simple = full.includes(".")
            ? full.slice(full.lastIndexOf(".") + 1)
            : full;
          info.decorators.push(simple);
        }
      }
    }
  };

  if (modNode) scan(modNode);
  // also scan node itself for bare modifiers (interfaces methods without modifiers node sometimes)
  for (const child of node.children) {
    if (child.type === "public") {
      info.isPublic = true;
      info.visibility = "public";
    }
  }

  return info;
}

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export const javaExtractor: LanguageExtractor = {
  language: "java",
  fileExtensions: [".java"],
  grammarWasm: "tree-sitter-java.wasm",
  extract(tree: TSTree, filePath: string, source: string) {
    return new JavaWalker(filePath, source, "java").run(tree.rootNode);
  },
};
