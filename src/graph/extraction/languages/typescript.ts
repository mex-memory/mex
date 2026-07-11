// ============================================================================
// mex code-graph — TypeScript / JavaScript extractor  (REFERENCE IMPLEMENTATION)
// ============================================================================
//
//   >>> THIS FILE IS THE COPY-TEMPLATE EVERY CONTRIBUTOR LANGUAGE CLONES. <<<
//
// It is the reference implementation of the FROZEN `LanguageExtractor` seam
// (`../types.ts`, spec §8.1). To add a language in the 0.7.x program you copy
// THIS file, rename the walker, and swap the tree-sitter node-type strings /
// field names for your grammar — nothing in the engine changes. So it is kept
// deliberately clean, total, and commented; its quality sets the ceiling on
// every contributed extractor.
//
// The contract an extractor honors (see `../types.ts`):
//   * Pure & deterministic: same (tree, filePath, source) → same output.
//   * One file in isolation — no I/O, no LLM, no cross-file lookups.
//   * Emit every symbol node in the file, and every edge/reference LEAVING those
//     nodes. In-file structure (`contains`) is emitted with both endpoints
//     resolved; anything that may point at ANOTHER file (calls, imports,
//     extends/implements, instantiations) is emitted UNRESOLVED — `targetName`
//     only — and the engine binds it after the full index pass.
//   * The engine assigns `bodyHash` + `updatedAt`; an extractor never does.

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

// Tree-sitter node types this grammar family uses, grouped by concept. Keeping
// them in named sets (rather than inline string literals) is what makes the
// clone-and-swap workflow mechanical for a contributor.
const FUNCTION_TYPES = new Set(["function_declaration"]);
const FUNCTION_VALUE_TYPES = new Set(["arrow_function", "function_expression"]);
const CLASS_TYPES = new Set(["class_declaration", "abstract_class_declaration"]);
const VARIABLE_DECL_TYPES = new Set(["lexical_declaration", "variable_declaration"]);
const CALL_TYPES = new Set(["call_expression"]);
const NEW_TYPES = new Set(["new_expression"]);
// Call receivers that don't help cross-file resolution (`this.foo()` → `foo`).
const SKIP_RECEIVERS = new Set(["this", "super"]);

/**
 * A single `extract()` run. One instance per file — extractor singletons keep no
 * mutable state, so `extract()` news up a fresh walker each call (purity).
 */
class TsFamilyWalker {
  private readonly nodes: ExtractedNode[] = [];
  private readonly edges: ExtractedEdge[] = [];
  /** Ids of the enclosing scopes; the last element is the current parent. */
  private readonly scopeStack: string[] = [];

  constructor(
    private readonly filePath: string,
    private readonly source: string,
    private readonly language: Language,
  ) {}

  run(root: TSNode): { nodes: ExtractedNode[]; edges: ExtractedEdge[] } {
    // A `file` node roots every file's containment tree. Its id is a stable
    // `file:<path>` (import resolution binds module specifiers to it).
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

  // --------------------------------------------------------------------------
  // Dispatch
  // --------------------------------------------------------------------------

  /** Route one node to its extractor. Returns after handling a construct whose
   *  own extractor already walked the relevant children. */
  private visit(node: TSNode): void {
    const type = node.type;

    if (FUNCTION_TYPES.has(type)) return this.extractFunction(node);
    if (CLASS_TYPES.has(type)) return this.extractClass(node);
    if (type === "interface_declaration") return this.extractInterface(node);
    if (type === "enum_declaration") return this.extractEnum(node);
    if (type === "type_alias_declaration") return this.extractTypeAlias(node);
    if (VARIABLE_DECL_TYPES.has(type) && this.atModuleScope()) {
      return this.extractVariableDeclaration(node);
    }
    if (type === "import_statement") return this.extractImport(node);
    if (type === "export_statement") {
      // `export { X } from "./y"` is a dependency on another module, like an
      // import. Otherwise the wrapper is transparent: descend so the inner
      // declaration is dispatched (its `isExported` walks the parent chain).
      if (getChildByField(node, "source")) this.extractReExport(node);
      for (const child of node.namedChildren) this.visit(child);
      return;
    }

    // Any other node: keep descending.
    for (const child of node.namedChildren) this.visit(child);
  }

  // --------------------------------------------------------------------------
  // Node creation
  // --------------------------------------------------------------------------

  /** Create a symbol node (+ its `contains` edge from the enclosing scope) and
   *  return its id, or null when the node has no usable name. */
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
      ...extra,
    });

    const parent = this.scopeStack[this.scopeStack.length - 1];
    if (parent) {
      this.edges.push({ source: parent, target: id, kind: "contains" });
    }
    return id;
  }

  /** Qualified name = enclosing (non-file) scope names + this name, `::`-joined. */
  private qualify(name: string): string {
    const parts: string[] = [];
    for (const scopeId of this.scopeStack) {
      const scope = this.nodes.find((n) => n.id === scopeId);
      if (scope && scope.kind !== "file") parts.push(scope.name);
    }
    parts.push(name);
    return parts.join("::");
  }

  /** True when the current scope is the file / a namespace (not a function or
   *  class body) — where top-level const/var/function declarations live. */
  private atModuleScope(): boolean {
    const parentId = this.scopeStack[this.scopeStack.length - 1];
    if (!parentId) return false;
    const parent = this.nodes.find((n) => n.id === parentId);
    return !!parent && (parent.kind === "file" || parent.kind === "namespace");
  }

  // --------------------------------------------------------------------------
  // Declarations
  // --------------------------------------------------------------------------

  private extractFunction(node: TSNode, nameOverride?: string): void {
    const name = nameOverride ?? nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("function", name, node, {
      signature: signatureOf(node, this.source),
      isAsync: isAsync(node),
      returnType: returnTypeOf(node, this.source),
    });
    if (!id) return;
    const body = getChildByField(node, "body");
    if (body) this.walkBody(body, id);
  }

  private extractClass(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("class", name, node, {
      isAbstract: node.type === "abstract_class_declaration",
    });
    if (!id) return;

    this.extractHeritage(node, id);
    const body = getChildByField(node, "body");
    if (body) {
      this.scopeStack.push(id);
      for (const member of body.namedChildren) this.visitClassMember(member);
      this.scopeStack.pop();
    }
  }

  /** A class-body member: method, or a field (property, or a method when its
   *  value is a function). */
  private visitClassMember(member: TSNode): void {
    const type = member.type;
    if (type === "method_definition") {
      const name = nameOf(member, this.source);
      if (!name) return;
      const id = this.createNode("method", name, member, {
        signature: signatureOf(member, this.source),
        visibility: visibilityOf(member),
        isAsync: isAsync(member),
        isStatic: isStatic(member),
        returnType: returnTypeOf(member, this.source),
      });
      if (!id) return;
      const body = getChildByField(member, "body");
      if (body) this.walkBody(body, id);
      return;
    }

    if (type === "public_field_definition" || type === "field_definition") {
      const name = nameOf(member, this.source);
      if (!name) return;
      const value = getChildByField(member, "value");
      const fn = value ? unwrapCallableValue(value) : null;
      if (fn) {
        // `onClick = () => {…}` — a callable field is really a method.
        const id = this.createNode("method", name, member, {
          visibility: visibilityOf(member),
          isStatic: isStatic(member),
        });
        const body = getChildByField(fn, "body");
        if (id && body) this.walkBody(body, id);
      } else {
        const id = this.createNode("property", name, member, {
          visibility: visibilityOf(member),
          isStatic: isStatic(member),
        });
        // A non-function initializer can still call/instantiate (`x = build()`).
        if (id && value) this.walkBody(value, id);
      }
    }
  }

  private extractInterface(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("interface", name, node);
    if (id) this.extractHeritage(node, id);
  }

  private extractEnum(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (!name) return;
    const id = this.createNode("enum", name, node);
    if (!id) return;
    const body = getChildByField(node, "body");
    if (!body) return;
    this.scopeStack.push(id);
    for (const member of body.namedChildren) {
      // `Red` → property_identifier; `Green = 2` → enum_assignment(name, value).
      const nameNode =
        member.type === "enum_assignment"
          ? getChildByField(member, "name")
          : member.type === "property_identifier"
            ? member
            : null;
      if (nameNode) {
        this.createNode("enum_member", getNodeText(nameNode, this.source), member);
      }
    }
    this.scopeStack.pop();
  }

  private extractTypeAlias(node: TSNode): void {
    const name = nameOf(node, this.source);
    if (name) this.createNode("type_alias", name, node);
  }

  /** A `const`/`let`/`var` statement: one node per declarator. A declarator
   *  whose value is a function becomes a `function` node, not a constant. */
  private extractVariableDeclaration(node: TSNode): void {
    const isConst = node.type === "lexical_declaration" && declKeyword(node) === "const";
    for (const declarator of node.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const nameNode = getChildByField(declarator, "name");
      if (!nameNode) continue;
      const name = getNodeText(nameNode, this.source);
      const value = getChildByField(declarator, "value");
      const fn = value ? unwrapCallableValue(value) : null;
      if (fn) {
        // `const make = () => {…}` — name comes from the declarator, body from fn.
        const id = this.createNode("function", name, declarator, {
          signature: signatureOf(fn, this.source),
          isAsync: isAsync(fn),
          returnType: returnTypeOf(fn, this.source),
        });
        const body = getChildByField(fn, "body");
        if (id && body) this.walkBody(body, id);
      } else {
        const id = this.createNode(isConst ? "constant" : "variable", name, declarator, {
          signature: value ? getNodeText(value, this.source).slice(0, 200) : undefined,
        });
        // A plain initializer can still call/instantiate (`const x = build()`).
        if (id && value) this.walkBody(value, id);
      }
    }
  }

  // --------------------------------------------------------------------------
  // References (emitted UNRESOLVED — the engine binds them cross-file)
  // --------------------------------------------------------------------------

  /** `extends` / `implements` on a class or interface → unresolved refs. */
  private extractHeritage(node: TSNode, fromId: string): void {
    for (const clause of node.namedChildren) {
      if (clause.type === "class_heritage") {
        for (const sub of clause.namedChildren) {
          if (sub.type === "extends_clause") {
            const value = getChildByField(sub, "value") ?? sub.namedChild(0);
            if (value) this.addRef(fromId, baseTypeName(value, this.source), "extends", value);
          } else if (sub.type === "implements_clause") {
            for (const t of sub.namedChildren) {
              this.addRef(fromId, baseTypeName(t, this.source), "implements", t);
            }
          }
        }
      } else if (clause.type === "extends_type_clause") {
        // Interface heritage: `interface A extends B, C`.
        for (let i = 0; i < clause.namedChildCount; i++) {
          const t = clause.namedChild(i);
          if (t) this.addRef(fromId, baseTypeName(t, this.source), "extends", t);
        }
      }
    }
  }

  private extractImport(node: TSNode): void {
    const sourceNode = getChildByField(node, "source");
    if (!sourceNode) return;
    const specifier = getNodeText(sourceNode, this.source).replace(/['"]/g, "");
    if (!specifier) return;
    const fileId = `file:${this.filePath}`;
    // File-level dependency on the imported module. The engine resolves the
    // specifier to the imported file's `file:` node.
    this.addRef(fileId, specifier, "imports", node);
  }

  private extractReExport(node: TSNode): void {
    const sourceNode = getChildByField(node, "source");
    if (!sourceNode) return;
    const specifier = getNodeText(sourceNode, this.source).replace(/['"]/g, "");
    if (specifier) this.addRef(`file:${this.filePath}`, specifier, "imports", node);
  }

  /**
   * Walk a function/method/initializer body for the references it emits: calls,
   * instantiations, and any NAMED nested functions/classes (which become their
   * own nodes). Anonymous callbacks are descended-through so their inner calls
   * attribute to the enclosing symbol.
   */
  private walkBody(body: TSNode, ownerId: string): void {
    const type = body.type;

    if (CALL_TYPES.has(type)) {
      this.extractCall(body, ownerId);
    } else if (NEW_TYPES.has(type)) {
      this.extractInstantiation(body, ownerId);
    } else if (FUNCTION_TYPES.has(type)) {
      // A named nested function declaration becomes its own node.
      this.scopeStack.push(ownerId);
      this.extractFunction(body);
      this.scopeStack.pop();
      return;
    } else if (CLASS_TYPES.has(type)) {
      this.scopeStack.push(ownerId);
      this.extractClass(body);
      this.scopeStack.pop();
      return;
    }

    for (const child of body.namedChildren) this.walkBody(child, ownerId);
  }

  private extractCall(node: TSNode, ownerId: string): void {
    const fn = getChildByField(node, "function") ?? node.namedChild(0);
    let calleeName = "";
    if (fn) {
      if (fn.type === "member_expression") {
        // `receiver.method()` — the method name is what resolves; keep the
        // receiver as a hint only when it's a plain identifier (not this/super).
        const property = getChildByField(fn, "property");
        const receiver = getChildByField(fn, "object");
        const method = property ? getNodeText(property, this.source) : "";
        if (method) {
          const recvName =
            receiver && receiver.type === "identifier"
              ? getNodeText(receiver, this.source)
              : "";
          calleeName = recvName && !SKIP_RECEIVERS.has(recvName) ? `${recvName}.${method}` : method;
        }
      } else {
        calleeName = getNodeText(fn, this.source);
      }
    }
    if (calleeName) this.addRef(ownerId, calleeName, "calls", node);
    // Still descend into the arguments for nested calls (`f(g())`).
    const args = getChildByField(node, "arguments");
    if (args) for (const child of args.namedChildren) this.walkBody(child, ownerId);
  }

  private extractInstantiation(node: TSNode, ownerId: string): void {
    const ctor = getChildByField(node, "constructor");
    if (ctor) this.addRef(ownerId, baseTypeName(ctor, this.source), "instantiates", node);
    // Descend into constructor args for nested calls (`new Foo(bar())`).
    const args = getChildByField(node, "arguments");
    if (args) for (const child of args.namedChildren) this.walkBody(child, ownerId);
  }

  /** Emit an unresolved edge: `source` is a node we created, `targetName` is a
   *  symbolic name the engine resolves to a node id after the full index pass. */
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
// Pure node helpers (no walker state — reusable by any TS-family extractor)
// ----------------------------------------------------------------------------

/** The `name` field's text, or "" (anonymous). */
function nameOf(node: TSNode, source: string): string {
  const nameNode = getChildByField(node, "name");
  return nameNode ? getNodeText(nameNode, source) : "";
}

/** The bare (last-segment) name of a type/constructor expression: `identifier`,
 *  `type_identifier`, or the `property` of a `member_expression` (`pkg.Thing`). */
function baseTypeName(node: TSNode, source: string): string {
  if (node.type === "member_expression") {
    const property = getChildByField(node, "property");
    return property ? getNodeText(property, source) : getNodeText(node, source);
  }
  if (node.type === "generic_type") {
    const base = node.namedChild(0);
    return base ? baseTypeName(base, source) : getNodeText(node, source);
  }
  return getNodeText(node, source);
}

/** Unwrap a declarator/field value to the function it holds, if any:
 *  a bare arrow/function-expression, or one wrapped in a HOF call
 *  (`throttle(() => {…})`). Returns null for non-function values. */
function unwrapCallableValue(value: TSNode): TSNode | null {
  if (FUNCTION_VALUE_TYPES.has(value.type)) return value;
  if (value.type === "call_expression") {
    const args = getChildByField(value, "arguments");
    if (args) {
      for (const arg of args.namedChildren) {
        if (FUNCTION_VALUE_TYPES.has(arg.type)) return arg;
      }
    }
  }
  return null;
}

/** Parameter + return-type text, e.g. `(name: string): string`. */
function signatureOf(node: TSNode, source: string): string | undefined {
  const params = getChildByField(node, "parameters");
  if (!params) return undefined;
  let sig = getNodeText(params, source);
  const ret = getChildByField(node, "return_type");
  if (ret) sig += ": " + getNodeText(ret, source).replace(/^:\s*/, "");
  return sig;
}

/** Normalized return-type name, when annotated. */
function returnTypeOf(node: TSNode, source: string): string | undefined {
  const ret = getChildByField(node, "return_type");
  if (!ret) return undefined;
  const inner = ret.namedChild(0);
  return inner ? getNodeText(inner, source) : undefined;
}

/** Any ancestor is an `export_statement`. Handles nested cases like
 *  `export const x = () => {…}` where the function is several levels deep. */
function isExported(node: TSNode): boolean {
  let cur: TSNode | null = node.parent;
  while (cur) {
    if (cur.type === "export_statement") return true;
    cur = cur.parent;
  }
  return false;
}

/** A direct `async` modifier child. */
function isAsync(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === "async") return true;
  }
  return false;
}

/** A direct `static` modifier child (class members). */
function isStatic(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === "static") return true;
  }
  return false;
}

/** TS accessibility modifier on a class member, when present. */
function visibilityOf(node: TSNode): ExtractedNode["visibility"] {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "accessibility_modifier") {
      const text = child.text;
      if (text === "public" || text === "private" || text === "protected") return text;
    }
  }
  return undefined;
}

/** The `const` / `let` / `var` keyword of a declaration. */
function declKeyword(node: TSNode): string {
  for (let i = 0; i < node.childCount; i++) {
    const t = node.child(i)?.type;
    if (t === "const" || t === "let" || t === "var") return t;
  }
  return "";
}

/** Basename of a forward-slash path (`src/a/b.ts` → `b.ts`). */
function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash < 0 ? filePath : filePath.slice(slash + 1);
}

// ----------------------------------------------------------------------------
// The frozen `LanguageExtractor` objects (one per language id in the family)
// ----------------------------------------------------------------------------

/** Build a `LanguageExtractor` for one member of the TS/JS grammar family. The
 *  `extract` fn news up a fresh {@link TsFamilyWalker} per call, so the exported
 *  singleton stays stateless (the purity contract). */
function makeTsFamilyExtractor(
  language: Language,
  fileExtensions: string[],
  grammarWasm: string,
): LanguageExtractor {
  return {
    language,
    fileExtensions,
    grammarWasm,
    extract(tree: TSTree, filePath: string, source: string) {
      return new TsFamilyWalker(filePath, source, language).run(tree.rootNode);
    },
  };
}

/** TypeScript (`.ts` / `.mts` / `.cts`). */
export const typescriptExtractor = makeTsFamilyExtractor(
  "typescript",
  [".ts", ".mts", ".cts"],
  "tree-sitter-typescript",
);

/** TypeScript + JSX (`.tsx`). */
export const tsxExtractor = makeTsFamilyExtractor("tsx", [".tsx"], "tree-sitter-tsx");

export { makeTsFamilyExtractor };
