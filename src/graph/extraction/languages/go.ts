import type { Language, NodeKind } from "../../types.js";
import type {
  ExtractedEdge,
  ExtractedNode,
  LanguageExtractor,
  TSNode,
  TSTree,
} from "../types.js";
import {
  canonicalNodeIdentity,
  generateNodeId,
  getChildByField,
  getNodeText,
} from "../node-id.js";

const FUNCTION_TYPES = new Set(["function_declaration"]);
const METHOD_TYPES = new Set(["method_declaration"]);
const STRUCT_TYPES = new Set(["struct_type"]);
const INTERFACE_TYPES = new Set(["interface_type"]);
const TYPE_DECL_TYPES = new Set(["type_declaration", "type_spec", "type_alias"]);
const CONST_TYPES = new Set(["const_declaration"]);
const VAR_TYPES = new Set(["var_declaration", "var_spec", "var_spec_list"]);
const CALL_TYPES = new Set(["call_expression"]);
const IMPORT_TYPES = new Set(["import_declaration"]);
const COMPOSITE_LITERAL_TYPES = new Set(["composite_literal"]);

function getGoDocstring(node: TSNode, source: string): string | undefined {
  const docs: string[] = [];
  let cur: TSNode | null = node.previousSibling;
  while (cur && cur.type === "comment") {
    const text = getNodeText(cur, source).trim();
    if (text.startsWith("//")) {
      docs.unshift(text.slice(2).trim());
    }
    cur = cur.previousSibling;
  }
  if (docs.length === 0 && node.parent) {
    cur = node.parent.previousSibling;
    while (cur && cur.type === "comment") {
      const text = getNodeText(cur, source).trim();
      if (text.startsWith("//")) {
        docs.unshift(text.slice(2).trim());
      }
      cur = cur.previousSibling;
    }
  }
  return docs.length > 0 ? docs.join("\n") : undefined;
}

function isExported(name: string): boolean {
  return name.length > 0 && name[0] === name[0].toUpperCase();
}

function visibilityOf(node: TSNode, source: string): ExtractedNode["visibility"] {
  const name = nameOf(node, source);
  return name && isExported(name) ? "public" : "private";
}

class GoWalker {
  private readonly nodes: ExtractedNode[] = [];
  private readonly edges: ExtractedEdge[] = [];
  private scopeStack: string[] = [];
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

    for (const child of root.namedChildren) {
      this.visit(child);
    }

    this.scopeStack.pop();

    return { nodes: this.nodes, edges: this.edges };
  }

  private visit(node: TSNode): void {
    const type = node.type;

    if (type === "package_clause") return this.extractPackage(node);
    if (FUNCTION_TYPES.has(type)) return this.extractFunction(node);
    if (METHOD_TYPES.has(type)) return this.extractMethod(node);
    if (TYPE_DECL_TYPES.has(type)) return this.extractType(node);
    if (CONST_TYPES.has(type)) return this.extractConst(node);
    if (VAR_TYPES.has(type)) return this.extractVar(node);
    if (IMPORT_TYPES.has(type)) return this.extractImport(node);

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
    const newNode = {
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
      docstring: getGoDocstring(node, this.source),
      isExported: isExported(name),
      ...extra,
    };
    this.nodes.push(newNode);

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

  private extractPackage(node: TSNode): void {
    const pkgNode = getChildByField(node, "name");
    if (pkgNode) {
      const pkgName = getNodeText(pkgNode, this.source);
      this.edges.push({
        source: this.scopeStack[0],
        targetName: pkgName,
        kind: "imports",
        line: node.startPosition.row,
        column: node.startPosition.column,
      });
    }
  }

  private extractFunction(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;

    const id = this.createNode("function", name, node, {
      signature: signatureOf(node, this.source),
      returnType: returnTypeOf(node, this.source),
      typeParameters: typeParametersOf(node, this.source),
    });
    if (!id) return;

    const body = getChildByField(node, "body");
    if (body) this.walkBody(body, id);
  }

  private extractMethod(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;

    const receiver = getChildByField(node, "receiver");
    let receiverType = "";
    if (receiver) {
      for (const param of receiver.namedChildren) {
        if (param.type === "parameter_declaration") {
          const typeNode = getChildByField(param, "type");
          if (typeNode) {
            receiverType = baseTypeName(typeNode, this.source);
            break;
          }
        }
      }
    }

    // Determine qualified name based on receiver type
    let qualifiedName = name;
    if (receiverType) {
      qualifiedName = `${receiverType}::${name}`;
    }

    const id = this.createNode("method", name, node, {
      signature: signatureOf(node, this.source),
      returnType: returnTypeOf(node, this.source),
      visibility: visibilityOf(node, this.source),
      typeParameters: typeParametersOf(node, this.source),
    });
    if (!id) return;

    // Override the qualifiedName if we have a receiver type
    if (receiverType) {
      const methodNode = this.nodes.find(n => n.id === id);
      if (methodNode) {
        methodNode.qualifiedName = qualifiedName;
      }
    }

    if (receiverType) {
      this.addRef(id, receiverType, "receiver", node);
      // Also create a contains edge from the receiver type to this method
      const receiverNode = this.nodes.find(n => n.name === receiverType && (n.kind === "class" || n.kind === "interface"));
      if (receiverNode) {
        this.edges.push({ source: receiverNode.id, target: id, kind: "contains" });
      }
    }

    const body = getChildByField(node, "body");
    if (body) this.walkBody(body, id);
  }

  private extractType(node: TSNode): void {
    if (node.type === "type_alias") {
      const nameNode = getChildByField(node, "name");
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        this.createNode("type_alias", name, node);
      }
      return;
    }

    if (node.type === "type_spec" || node.type === "type_declaration") {
      for (const child of node.namedChildren) {
        if (child.type === "type_spec") {
          this.extractTypeSpec(child);
        }
      }
      return;
    }
  }

  private extractTypeSpec(node: TSNode): void {
    const nameNode = getChildByField(node, "name");
    const typeNode = getChildByField(node, "type");
    if (!nameNode || !typeNode) return;

    const name = getNodeText(nameNode, this.source);
    const typeKind = typeNode.type;

    if (typeKind === "struct_type") {
      const id = this.createNode("class", name, node, {
        visibility: visibilityOf(node, this.source),
        typeParameters: typeParametersOf(node, this.source),
      });
      if (!id) return;

      this.extractStructBody(typeNode, id);
    } else if (typeKind === "interface_type") {
      const id = this.createNode("interface", name, node, {
        visibility: visibilityOf(node, this.source),
        typeParameters: typeParametersOf(node, this.source),
      });
      if (!id) return;

      this.extractInterfaceBody(typeNode, id);
    } else {
      this.createNode("type_alias", name, node, {
        signature: getNodeText(typeNode, this.source).slice(0, 200),
      });
    }
  }

  private extractStructBody(structNode: TSNode, ownerId: string): void {
    // struct_type has field_declaration_list as a direct named child, not a "body" field
    const fieldList = structNode.namedChildren.find(c => c.type === "field_declaration_list");
    if (!fieldList) return;

    this.scopeStack.push(ownerId);
    for (const member of fieldList.namedChildren) {
      if (member.type === "field_declaration") {
        const names = member.namedChildren.filter(c => c.type === "field_identifier");
        const typeNode = getChildByField(member, "type");
        for (const nameNode of names) {
          const fieldName = getNodeText(nameNode, this.source);
          const id = this.createNode("property", fieldName, member, {
            visibility: visibilityOf(member, this.source),
          });
          if (id && typeNode) {
            const fieldTypeName = baseTypeName(typeNode, this.source);
            if (fieldTypeName) {
              this.addRef(id, fieldTypeName, "type_of", member);
            }
          }
        }
      }
    }
    this.scopeStack.pop();
  }

  private extractInterfaceBody(interfaceNode: TSNode, ownerId: string): void {
    this.scopeStack.push(ownerId);
    for (const member of interfaceNode.namedChildren) {
      if (member.type === "method_elem" || member.type === "method_spec") {
        const nameNode = getChildByField(member, "name");
        if (nameNode) {
          const name = getNodeText(nameNode, this.source);
          this.createNode("method", name, member, {
            signature: signatureOf(member, this.source),
            returnType: returnTypeOf(member, this.source),
          });
        }
      } else if (member.type === "type_elem") {
        for (const typeChild of member.namedChildren) {
          const typeName = baseTypeName(typeChild, this.source);
          if (typeName) {
            this.addRef(ownerId, typeName, "implements", member);
          }
        }
      }
    }
    this.scopeStack.pop();
  }

  private extractConst(node: TSNode): void {
    for (const spec of node.namedChildren) {
      if (spec.type === "const_spec") {
        for (const nameNode of spec.namedChildren) {
          if (nameNode.type === "identifier") {
            const name = getNodeText(nameNode, this.source);
            const valueNode = getChildByField(spec, "value");
            this.createNode("constant", name, spec, {
              signature: valueNode ? getNodeText(valueNode, this.source).slice(0, 200) : undefined,
              visibility: visibilityOf(spec, this.source),
            });
          }
        }
      }
    }
  }

  private extractVar(node: TSNode): void {
    if (node.type === "var_spec_list") {
      for (const spec of node.namedChildren) {
        if (spec.type === "var_spec") this.extractVarSpec(spec);
      }
      return;
    }
    if (node.type === "var_spec") return this.extractVarSpec(node);
    if (node.type === "var_declaration") {
      for (const spec of node.namedChildren) {
        if (spec.type === "var_spec") this.extractVarSpec(spec);
      }
    }
  }

  private extractVarSpec(node: TSNode): void {
    const left = getChildByField(node, "left") ?? node.namedChild(0);
    if (!left) return;

    let names: TSNode[] = [];
    if (left.type === "identifier") {
      names = [left];
    } else if (left.type === "expression_list") {
      names = left.namedChildren.filter(c => c.type === "identifier");
    }

    const right = getChildByField(node, "right");
    const typeNode = getChildByField(node, "type");

    for (const nameNode of names) {
      const name = getNodeText(nameNode, this.source);
      const isConst = false;
      this.createNode(isConst ? "constant" : "variable", name, node, {
        signature: right ? getNodeText(right, this.source).slice(0, 200) : (typeNode ? getNodeText(typeNode, this.source) : undefined),
        visibility: visibilityOf(node, this.source),
      });
    }
  }

  private extractImport(node: TSNode): void {
    const fileId = this.scopeStack[0];
    if (!fileId) return;

    for (const spec of node.namedChildren) {
      if (spec.type === "import_spec" || spec.type === "import_spec_list") {
        if (spec.type === "import_spec_list") {
          for (const inner of spec.namedChildren) {
            if (inner.type === "import_spec") this.processImportSpec(fileId, inner);
          }
        } else {
          this.processImportSpec(fileId, spec);
        }
      }
    }
  }

  private processImportSpec(fileId: string, spec: TSNode): void {
    const pathNode = getChildByField(spec, "path");
    if (!pathNode) return;
    const moduleSpecifier = getNodeText(pathNode, this.source).replace(/^"|"$/g, '');
    const nameNode = getChildByField(spec, "name");
    let localName = "";
    if (nameNode) {
      localName = getNodeText(nameNode, this.source);
    }
    this.addRef(fileId, moduleSpecifier, "imports", spec, {
      bindings: [{ localName: localName || moduleSpecifier.split("/").pop() || moduleSpecifier, importedName: "*" }],
    });
  }

  private walkBody(body: TSNode, ownerId: string): void {
    const type = body.type;

    if (CALL_TYPES.has(type)) {
      this.extractCall(body, ownerId);
    } else if (COMPOSITE_LITERAL_TYPES.has(type)) {
      this.extractCompositeLiteral(body, ownerId);
    } else if (FUNCTION_TYPES.has(type) || METHOD_TYPES.has(type)) {
      this.scopeStack.push(ownerId);
      this.visit(body);
      this.scopeStack.pop();
      return;
    }

    for (const child of body.namedChildren) this.walkBody(child, ownerId);
  }

  private extractCall(node: TSNode, ownerId: string): void {
    const fn = getChildByField(node, "function");
    let calleeName = "";
    if (fn) {
      if (fn.type === "selector_expression") {
        const field = getChildByField(fn, "field");
        const operand = getChildByField(fn, "operand");
        const methodName = field ? getNodeText(field, this.source) : "";
        const pkgName = operand ? getNodeText(operand, this.source) : "";
        calleeName = pkgName && methodName ? `${pkgName}.${methodName}` : methodName;
      } else if (fn.type === "identifier") {
        calleeName = getNodeText(fn, this.source);
      } else {
        calleeName = getNodeText(fn, this.source);
      }
    }
    if (calleeName) this.addRef(ownerId, calleeName, "calls", node);

    const args = getChildByField(node, "arguments");
    if (args) for (const child of args.namedChildren) this.walkBody(child, ownerId);
  }

  private extractCompositeLiteral(node: TSNode, ownerId: string): void {
    const typeNode = getChildByField(node, "type");
    if (typeNode) {
      const structName = baseTypeName(typeNode, this.source);
      if (structName) this.addRef(ownerId, structName, "instantiates", node);
    }
    const body = getChildByField(node, "body");
    if (body) {
      for (const child of body.namedChildren) this.walkBody(child, ownerId);
    }
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

function nameOf(node: TSNode, source: string): string {
  const nameNode = getChildByField(node, "name");
  return nameNode ? getNodeText(nameNode, source) : "";
}

function signatureOf(node: TSNode, source: string): string | undefined {
  const params = getChildByField(node, "parameters");
  if (!params) return undefined;
  let sig = getNodeText(params, source);
  const ret = getChildByField(node, "result");
  if (ret) sig += " " + getNodeText(ret, source);
  return sig;
}

function returnTypeOf(node: TSNode, source: string): string | undefined {
  const ret = getChildByField(node, "result");
  if (!ret) return undefined;
  return getNodeText(ret, source);
}

function typeParametersOf(node: TSNode, source: string): string[] | undefined {
  const typeParams = getChildByField(node, "type_parameters");
  if (!typeParams) return undefined;
  const params: string[] = [];
  for (let i = 0; i < typeParams.namedChildCount; i++) {
    const child = typeParams.namedChild(i);
    if (child && child.type === "parameter_declaration") {
      const nameNode = getChildByField(child, "name");
      if (nameNode) {
        params.push(getNodeText(nameNode, source));
      }
    } else if (child) {
      params.push(getNodeText(child, source));
    }
  }
  return params.length > 0 ? params : undefined;
}

function baseTypeName(node: TSNode, source: string): string | undefined {
  if (node.type === "generic_type") {
    const base = node.namedChild(0);
    return base ? baseTypeName(base, source) : undefined;
  }
  if (node.type === "qualified_type") {
    const name = getChildByField(node, "name");
    return name ? getNodeText(name, source) : undefined;
  }
  if (node.type === "pointer_type") {
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) return baseTypeName(child, source);
    }
    return undefined;
  }
  return getNodeText(node, source);
}

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export const goExtractor: LanguageExtractor = {
  language: "go",
  fileExtensions: [".go"],
  grammarWasm: "tree-sitter-go.wasm",
  extract(tree: TSTree, filePath: string, source: string) {
    return new GoWalker(filePath, source, "go").run(tree.rootNode);
  },
};