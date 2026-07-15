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
} from "../node-id.js";

const FUNCTION_TYPES = new Set(["function_item"]);
const CLASS_TYPES = new Set(["struct_item", "enum_item"]);
const CALL_TYPES = new Set(["call_expression"]);

/**
 * Extract docstrings. Rust uses `line_comment` or `block_comment`.
 * Doc comments usually start with `///` or `//!`.
 */
function getRustDocstring(node: TSNode, source: string): string | undefined {
  const docs: string[] = [];
  let cur: TSNode | null = node.previousNamedSibling;
  while (cur && (cur.type === "line_comment" || cur.type === "block_comment")) {
    const text = getNodeText(cur, source).trim();
    if (text.startsWith("///") || text.startsWith("//!")) {
      docs.unshift(text);
    }
    cur = cur.previousNamedSibling;
  }
  return docs.length > 0 ? docs.join("\n") : undefined;
}

class RustWalker {
  private readonly nodes: ExtractedNode[] = [];
  private readonly edges: ExtractedEdge[] = [];
  private readonly scopeStack: string[] = [];

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
    const type = node.type;

    if (FUNCTION_TYPES.has(type)) return this.extractFunction(node);
    if (CLASS_TYPES.has(type)) return this.extractClassOrEnum(node);
    if (type === "trait_item") return this.extractTrait(node);
    if (type === "impl_item") return this.extractImpl(node);
    if (type === "mod_item") return this.extractModule(node);
    if (type === "const_item") return this.extractConst(node);
    if (type === "static_item") return this.extractStatic(node);
    if (type === "use_declaration") return this.extractUse(node);
    if (type === "macro_invocation") return this.extractMacro(node);

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
      docstring: getRustDocstring(node, this.source),
      isExported: isExported(node),
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

  private extractFunction(node: TSNode, isMethod = false): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode(isMethod ? "method" : "function", name, node, {
      signature: signatureOf(node, this.source),
      returnType: returnTypeOf(node, this.source),
      visibility: visibilityOf(node),
    });
    if (!id) return;
    const body = getChildByField(node, "body");
    if (body) this.walkBody(body, id);
  }

  private extractClassOrEnum(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const kind = node.type === "struct_item" ? "class" : "enum";
    const id = this.createNode(kind, name, node, {
      visibility: visibilityOf(node),
    });
    if (!id) return;

    const body = getChildByField(node, "body") ?? node.namedChildren.find(c => c.type === "field_declaration_list" || c.type === "enum_variant_list");
    if (body) {
      this.scopeStack.push(id);
      for (const member of body.namedChildren) {
        if (member.type === "enum_variant") {
          const variantName = nameOf(member, this.source) || getNodeText(member, this.source);
          if (variantName) this.createNode("enum_member", variantName, member);
        } else if (member.type === "field_declaration") {
          const fieldName = nameOf(member, this.source);
          if (fieldName) this.createNode("property", fieldName, member, {
              visibility: visibilityOf(member)
          });
        }
      }
      this.scopeStack.pop();
    }
  }

  private extractTrait(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("interface", name, node, {
      visibility: visibilityOf(node),
    });
    if (!id) return;
    const body = getChildByField(node, "body");
    if (!body) return;
    this.scopeStack.push(id);
    for (const member of body.namedChildren) {
      if (member.type === "function_item") {
         this.extractFunction(member, true);
      }
    }
    this.scopeStack.pop();
  }

  private extractImpl(node: TSNode): void {
    // Inherent impl (impl Foo) or trait impl (impl Trait for Foo)
    const typeNode = getChildByField(node, "type");
    const traitNode = getChildByField(node, "trait");
    
    const typeName = typeNode ? getNodeText(typeNode, this.source) : "";
    if (!typeName) return;

    // We don't create a node for `impl` blocks themselves. They extend the type.
    // Instead we map containment to the type if we can, but since target is just
    // a name, we'll nest methods under a pseudo-scope so their qualified name is
    // correct (e.g. `Foo::method`). 
    
    // Check if the struct/enum is already in the file.
    let ownerId: string | null | undefined = this.nodes.find(n => n.name === typeName && (n.kind === "class" || n.kind === "enum" || n.kind === "interface"))?.id;
    
    if (!ownerId) {
       // If type is not in this file (e.g. adding methods to foreign type),
       // we create a namespace node to hold them.
       ownerId = this.createNode("namespace", typeName, node);
    }
    
    if (!ownerId) return;

    if (traitNode) {
      const traitName = getNodeText(traitNode, this.source);
      if (traitName) {
         this.addRef(ownerId, traitName, "implements", node);
      }
    }

    const body = getChildByField(node, "body");
    if (!body) return;

    this.scopeStack.push(ownerId);
    for (const member of body.namedChildren) {
      if (member.type === "function_item") {
         this.extractFunction(member, true);
      } else {
         this.visit(member);
      }
    }
    this.scopeStack.pop();
  }

  private extractModule(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("namespace", name, node, {
      visibility: visibilityOf(node),
    });
    if (!id) return;
    
    const body = getChildByField(node, "body");
    if (body) {
      this.scopeStack.push(id);
      for (const child of body.namedChildren) this.visit(child);
      this.scopeStack.pop();
    }
  }

  private extractConst(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (name) this.createNode("constant", name, node, {
       visibility: visibilityOf(node)
    });
  }

  private extractStatic(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (name) this.createNode("variable", name, node, {
       visibility: visibilityOf(node)
    });
  }

  private extractUse(node: TSNode): void {
    // A use statement might import multiple things.
    // e.g., `use std::collections::{HashMap, HashSet};`
    // We can just add a reference to the textual path for simplicity.
    const arg = node.namedChild(0); // use_clause or scoped_identifier
    if (!arg) return;
    const path = getNodeText(arg, this.source);
    if (path) {
      this.addRef(`file:${this.filePath}`, path, "imports", node);
    }
  }

  private extractMacro(node: TSNode): void {
    // Try to parse the token tree of the macro for any functions/structs inside.
    // Only descend if it looks like a block macro: `macro! { ... }`.
    const tokenTree = node.namedChildren.find(c => c.type === "token_tree");
    if (tokenTree) {
      // Very conservative degradation: we just visit children to find items
      // if they parse correctly within the token tree.
      for (const child of tokenTree.namedChildren) {
         this.visit(child);
      }
    }
  }

  private walkBody(body: TSNode, ownerId: string): void {
    const type = body.type;

    if (CALL_TYPES.has(type)) {
      this.extractCall(body, ownerId);
    } else if (FUNCTION_TYPES.has(type)) {
      this.scopeStack.push(ownerId);
      this.extractFunction(body);
      this.scopeStack.pop();
      return;
    } else if (CLASS_TYPES.has(type)) {
      this.scopeStack.push(ownerId);
      this.extractClassOrEnum(body);
      this.scopeStack.pop();
      return;
    }

    for (const child of body.namedChildren) this.walkBody(child, ownerId);
  }

  private extractCall(node: TSNode, ownerId: string): void {
    const fn = getChildByField(node, "function") ?? node.namedChild(0);
    let calleeName = "";
    if (fn) {
      if (fn.type === "field_expression") {
        const field = getChildByField(fn, "field");
        if (field) calleeName = getNodeText(field, this.source);
      } else if (fn.type === "scoped_identifier") {
        calleeName = getNodeText(fn, this.source);
      } else {
        calleeName = getNodeText(fn, this.source);
      }
    }
    if (calleeName) this.addRef(ownerId, calleeName, "calls", node);
    
    const args = getChildByField(node, "arguments");
    if (args) for (const child of args.namedChildren) this.walkBody(child, ownerId);
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

function nameOf(node: TSNode, source: string): string {
  const nameNode = getChildByField(node, "name");
  return nameNode ? getNodeText(nameNode, source) : "";
}

function signatureOf(node: TSNode, source: string): string | undefined {
  const params = getChildByField(node, "parameters");
  if (!params) return undefined;
  let sig = getNodeText(params, source);
  const ret = getChildByField(node, "return_type");
  if (ret) sig += " " + getNodeText(ret, source);
  return sig;
}

function returnTypeOf(node: TSNode, source: string): string | undefined {
  const ret = getChildByField(node, "return_type");
  if (!ret) return undefined;
  return getNodeText(ret, source).replace(/^->\s*/, "");
}

function isExported(node: TSNode): boolean {
  return visibilityOf(node) !== undefined;
}

function visibilityOf(node: TSNode): ExtractedNode["visibility"] {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "visibility_modifier") {
      const text = child.text;
      if (text.includes("pub")) return "public";
    }
  }
  return undefined;
}

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash < 0 ? filePath : filePath.slice(slash + 1);
}

export const rustExtractor: LanguageExtractor = {
  language: "rust",
  fileExtensions: [".rs"],
  grammarWasm: "tree-sitter-rust.wasm",
  extract(tree: TSTree, filePath: string, source: string) {
    return new RustWalker(filePath, source, "rust").run(tree.rootNode);
  },
};
