import { disposeTree, loadGrammars, parse } from "../graph/extraction/grammars.js";
import type { TSNode } from "../graph/extraction/types.js";
import type { Language } from "../graph/types.js";
import type { ParsedFile } from "./parse-js.js";
import type { ImportItem, Lang, OutlineItem, SymbolKind } from "./types.js";

const GRAMMAR: Partial<Record<Lang, Language>> = { py: "python", rs: "rust", cs: "csharp", ts: "typescript", tsx: "tsx", js: "javascript" };

/** Load the grammars for these languages once per process. */
export async function prepareTreeSitter(langs: Iterable<Lang>): Promise<void> {
  const wanted = [...new Set([...langs].map((lang) => GRAMMAR[lang]).filter((lang): lang is Language => lang !== undefined))];
  if (wanted.length > 0) await loadGrammars(wanted);
}

/** Outline, imports and exports for Python, Rust and C#. Grammars must be loaded first. */
export function parseTreeSitter(source: string, lang: "py" | "rs" | "cs"): ParsedFile | null {
  const tree = parse(source, GRAMMAR[lang]!);
  if (!tree) return null;
  try {
    const out = new Outline();
    if (lang === "py") python(tree.rootNode, out, undefined, false);
    else if (lang === "rs") rust(tree.rootNode, out, undefined);
    else csharp(tree.rootNode, out, undefined);
    const parsed: ParsedFile = { outline: out.items, imports: out.imports, exports: [...new Set(out.exports)] };
    if (tree.rootNode.hasError && out.items.length === 0 && out.imports.length === 0) parsed.error = "syntax errors";
    return parsed;
  } finally {
    disposeTree(tree);
  }
}

class Outline {
  readonly items: OutlineItem[] = [];
  readonly imports: ImportItem[] = [];
  readonly exports: string[] = [];
  add(name: string, kind: SymbolKind, from: TSNode, to: TSNode, parent: number | undefined): number {
    const end = to.endPosition.column === 0 && to.endPosition.row > from.startPosition.row ? to.endPosition.row : to.endPosition.row + 1;
    const item: OutlineItem = { name, kind, start: from.startPosition.row + 1, end };
    if (parent !== undefined) item.parent = parent;
    this.items.push(item);
    return this.items.length - 1;
  }
}

function field(node: TSNode, name: string): string | undefined {
  return node.childForFieldName(name)?.text;
}

// ── Python ──

function python(node: TSNode, out: Outline, parent: number | undefined, inClass: boolean, from?: TSNode): void {
  for (const child of node.namedChildren) {
    switch (child.type) {
      case "decorated_definition": {
        const definition = child.childForFieldName("definition");
        if (definition) python({ namedChildren: [definition] } as unknown as TSNode, out, parent, inClass, child);
        break;
      }
      case "function_definition": {
        const name = field(child, "name");
        if (!name) break;
        const kind: SymbolKind = /^test_?/.test(name) ? "test" : inClass ? "method" : "function";
        out.add(name, kind, from ?? child, child, parent);
        if (parent === undefined && !name.startsWith("_")) out.exports.push(name);
        break;
      }
      case "class_definition": {
        const name = field(child, "name");
        if (!name) break;
        const index = out.add(name, /^Test/.test(name) ? "test" : "class", from ?? child, child, parent);
        if (parent === undefined && !name.startsWith("_")) out.exports.push(name);
        const body = child.childForFieldName("body");
        if (body) python(body, out, index, true);
        break;
      }
      case "expression_statement": {
        if (parent !== undefined) break;
        const assignment = child.namedChildren[0];
        if (assignment?.type !== "assignment") break;
        const left = assignment.childForFieldName("left");
        if (left?.type !== "identifier") break;
        out.add(left.text, /^[A-Z][A-Z0-9_]*$/.test(left.text) ? "const" : "variable", child, child, parent);
        if (!left.text.startsWith("_")) out.exports.push(left.text);
        break;
      }
      case "import_statement":
        for (const name of child.namedChildren) {
          const module = name.type === "aliased_import" ? field(name, "name") : name.text;
          if (module) out.imports.push({ from: module, names: [module.split(".").pop()!] });
        }
        break;
      case "import_from_statement": {
        const module = field(child, "module_name");
        if (!module) break;
        const names = child.namedChildren.filter((n) => n !== child.childForFieldName("module_name"))
          .map((n) => (n.type === "aliased_import" ? field(n, "name") : n.type === "wildcard_import" ? "*" : n.text) ?? "")
          .filter(Boolean);
        out.imports.push({ from: module, names });
        break;
      }
      default:
        break;
    }
  }
}

// ── Rust ──

const RUST_ITEMS: Record<string, SymbolKind> = {
  function_item: "function", function_signature_item: "function", struct_item: "struct", enum_item: "enum",
  union_item: "struct", trait_item: "trait", mod_item: "module", const_item: "const", static_item: "const",
  type_item: "type", macro_definition: "function",
};

function rust(node: TSNode, out: Outline, parent: number | undefined, inImpl = false): void {
  let attributes: TSNode[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "attribute_item" || child.type === "line_comment" || child.type === "block_comment") {
      if (child.type === "attribute_item") attributes.push(child);
      continue;
    }
    const from = attributes[0] ?? child;
    const isTest = attributes.some((attribute) => /^#\[(tokio::)?test\b|^#\[rstest\b/.test(attribute.text));
    attributes = [];
    if (child.type === "use_declaration") {
      const argument = child.childForFieldName("argument")?.text ?? "";
      const names = [...argument.matchAll(/([A-Za-z_][A-Za-z0-9_]*|\*)\s*(?:as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*(?=[,}]|$)/g)].map((m) => m[1]!);
      out.imports.push({ from: argument.replace(/::\{[\s\S]*$/, "").replace(/::[A-Za-z_*][A-Za-z0-9_]*$/, ""), names });
      continue;
    }
    if (child.type === "impl_item") {
      const type = field(child, "type") ?? "impl";
      const trait = field(child, "trait");
      const index = out.add(trait ? `${trait} for ${type}` : type, "impl", from, child, parent);
      const body = child.childForFieldName("body");
      if (body) rust(body, out, index, true);
      continue;
    }
    const kind = RUST_ITEMS[child.type];
    if (!kind) continue;
    const name = field(child, "name");
    if (!name) continue;
    const index = out.add(name, isTest ? "test" : inImpl && kind === "function" ? "method" : kind, from, child, parent);
    const visibility = child.namedChildren.find((n) => n.type === "visibility_modifier");
    if (visibility && visibility.text.startsWith("pub") && parent === undefined) out.exports.push(name);
    if (child.type === "mod_item" || child.type === "trait_item") {
      const body = child.childForFieldName("body");
      if (body) rust(body, out, index, child.type === "trait_item");
    }
  }
}

// ── C# ──

const CSHARP_TYPES: Record<string, SymbolKind> = {
  class_declaration: "class", record_declaration: "class", struct_declaration: "struct", record_struct_declaration: "struct",
  interface_declaration: "interface", enum_declaration: "enum", delegate_declaration: "type",
};
const CSHARP_TEST_ATTRIBUTE = /\[\s*(Fact|Theory|Test|TestCase|TestMethod|DataTestMethod)\b/;

function csharp(node: TSNode, out: Outline, parent: number | undefined): void {
  for (const child of node.namedChildren) {
    switch (child.type) {
      case "using_directive": {
        const name = child.namedChildren.find((n) => n.type === "qualified_name" || n.type === "identifier" || n.type === "name");
        const target = child.namedChildren.length > 1 ? child.namedChildren[child.namedChildren.length - 1] : name;
        if (target) out.imports.push({ from: target.text, names: [] });
        break;
      }
      case "namespace_declaration":
      case "file_scoped_namespace_declaration": {
        const name = field(child, "name") ?? "namespace";
        const index = out.add(name, "namespace", child, child, parent);
        const body = child.childForFieldName("body");
        csharp(body ?? child, out, index);
        break;
      }
      case "declaration_list":
        csharp(child, out, parent);
        break;
      default: {
        const kind = CSHARP_TYPES[child.type];
        if (kind) {
          const name = field(child, "name");
          if (!name) break;
          const index = out.add(name, kind, child, child, parent);
          if (/\bpublic\b/.test(modifiers(child))) out.exports.push(name);
          const body = child.childForFieldName("body");
          if (body) csharpMembers(body, out, index);
        }
      }
    }
  }
}

function modifiers(node: TSNode): string {
  return node.namedChildren.filter((n) => n.type === "modifier").map((n) => n.text).join(" ");
}

function csharpMembers(body: TSNode, out: Outline, parent: number): void {
  for (const member of body.namedChildren) {
    if (CSHARP_TYPES[member.type]) { csharp({ namedChildren: [member] } as unknown as TSNode, out, parent); continue; }
    if (member.type === "method_declaration" || member.type === "constructor_declaration" || member.type === "destructor_declaration" || member.type === "operator_declaration") {
      const name = field(member, "name") ?? (member.type === "operator_declaration" ? "operator" : undefined);
      if (!name) continue;
      const isTest = member.namedChildren.some((n) => n.type === "attribute_list" && CSHARP_TEST_ATTRIBUTE.test(n.text));
      out.add(name, isTest ? "test" : "method", member, member, parent);
    } else if (member.type === "property_declaration" || member.type === "event_declaration") {
      const name = field(member, "name");
      if (name) out.add(name, "property", member, member, parent);
    } else if (member.type === "field_declaration" || member.type === "event_field_declaration") {
      for (const declarator of member.descendantsOfType("variable_declarator")) {
        const name = field(declarator, "name") ?? declarator.namedChildren[0]?.text;
        if (name) out.add(name, "property", member, member, parent);
      }
    }
  }
}
