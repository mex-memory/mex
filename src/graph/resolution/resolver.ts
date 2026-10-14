// ============================================================================
// mex code-graph — cross-file reference resolution  (A4)
// ============================================================================
//
// Extractors emit references UNRESOLVED (a `targetName` symbol, never a node id)
// because a name in one file may bind to a symbol in ANOTHER. After the whole
// project is indexed, this pass binds each reference to a concrete node and
// produces the persisted reference edges (calls / imports / extends / …).
//
// Fallback-language bindings are intentionally conservative: lexical scope and
// explicit import/use evidence only. Framework resolvers may add relationships
// through their frozen seam, but repository-global name uniqueness is never
// treated as proof. Kept pure (nodes + refs in → edges out) so build and sync
// share the exact same deterministic resolution pass.

import type { EdgeKind, GraphEdge, GraphNode, Language, NodeKind } from "../types.js";
import type { UnresolvedRefRecord } from "../db/store.js";
import type { FrameworkResolver, ResolutionContext } from "./types.js";

/** Module-file extensions tried when resolving a relative import specifier. */
const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Node kinds a reference of a given kind is allowed to bind to. */
const TARGET_KINDS: Record<string, NodeKind[]> = {
  calls: ["function", "method"],
  extends: ["class", "interface"],
  implements: ["interface", "class"],
  instantiates: ["class"],
  references: [], // any kind
  function_ref: ["function", "method"],
};

/** Receivers that lexically name the calling body's own instance or class. */
const LEXICAL_SELF_RECEIVERS = new Set(["self", "this", "cls"]);

/**
 * Resolve every unresolved reference against the full node set. Returns the
 * reference edges to persist (`contains` edges are already resolved by the
 * extractor and are not touched here).
 */
export function resolveReferences(
  nodes: GraphNode[],
  refs: UnresolvedRefRecord[],
  framework: { resolvers: readonly FrameworkResolver[]; context: ResolutionContext } | null = null,
): GraphEdge[] {
  const byId = new Map<string, GraphNode>();
  const byName = new Map<string, GraphNode[]>();
  const fileNodeByPath = new Map<string, string>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (node.kind === "file") {
      fileNodeByPath.set(node.filePath, node.id);
    } else {
      const list = byName.get(node.name);
      if (list) list.push(node);
      else byName.set(node.name, [node]);
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>(); // dedup one semantic callsite
  const importsByFile = new Map<string, Set<string>>(); // file → imported file paths
  const bindingsByFile = new Map<string, Map<string, Array<{
    importedName: string; targetPath: string;
  }>>>();

  const push = (
    source: string,
    target: string,
    kind: EdgeKind,
    ref: UnresolvedRefRecord,
    provenance: GraphEdge["provenance"] = "lexical",
    confidence = 1,
    resolutionMethod = "lexical",
    evidence?: Record<string, unknown>,
  ) => {
    const key = `${source}|${target}|${kind}|${ref.line ?? -1}|${ref.column ?? -1}`;
    if (seen.has(key)) return;
    seen.add(key);
    ref.status = "resolved";
    ref.targetId = target;
    ref.confidence = confidence;
    ref.resolver = resolutionMethod;
    edges.push({
      source,
      target,
      kind,
      line: ref.line,
      column: ref.column,
      provenance,
      confidence,
      resolutionMethod,
      evidence: evidence ? [evidence] : undefined,
    });
  };

  // Pass 1: imports. Resolve each specifier to the imported file's `file:` node,
  // and record file→file import relationships for the call-resolution preference.
  for (const ref of refs) {
    if (ref.referenceKind !== "imports") continue;
    const fromNode = byId.get(ref.fromNodeId);
    if (!fromNode) continue;

    const targetPath = resolveModulePath(
      fromNode.filePath,
      ref.referenceName,
      ref.language,
      fileNodeByPath,
    );
    if (!targetPath) continue;
    const targetFileId = fileNodeByPath.get(targetPath);
    if (!targetFileId) continue;
    push(ref.fromNodeId, targetFileId, "imports", ref, "lexical", 1, "explicit-import", {
      moduleSpecifier: ref.referenceName,
    });
    let set = importsByFile.get(fromNode.filePath);
    if (!set) importsByFile.set(fromNode.filePath, (set = new Set()));
    set.add(targetPath);
    for (const binding of importBindings(ref)) {
      let byLocal = bindingsByFile.get(fromNode.filePath);
      if (!byLocal) bindingsByFile.set(fromNode.filePath, (byLocal = new Map()));
      const entries = byLocal.get(binding.localName) ?? [];
      entries.push({ importedName: binding.importedName, targetPath });
      byLocal.set(binding.localName, entries);
    }
  }

  const csharp = createCSharpScope(nodes, refs, byId);

  // Pass 2: symbol references (calls, extends, implements, instantiates, …).
  for (const ref of refs) {
    if (ref.referenceKind === "imports") continue;
    const fromNode = byId.get(ref.fromNodeId);
    if (!fromNode) continue;

    // C# types are visible through the enclosing namespaces and `using`
    // directives, never by name alone: bind a type reference, or a call on a
    // type-named receiver, only when exactly one visible type answers it.
    if (ref.language === "csharp") {
      const target = csharp.resolve(ref, fromNode);
      if (target) {
        const kind = ref.referenceKind === "function_ref" ? "references" : ref.referenceKind as EdgeKind;
        push(ref.fromNodeId, target.id, kind, ref, "lexical", 1,
          target.filePath === fromNode.filePath ? "lexical-scope" : "namespace-scope");
        continue;
      }
    }

    const frameworkResolution = framework?.resolvers
      .filter((resolver) => !resolver.languages || resolver.languages.includes(ref.language))
      .map((resolver) => resolver.resolve(ref, framework.context))
      .find((result) => result !== null);
    if (frameworkResolution) {
      const kind = ref.referenceKind === "function_ref"
        ? "references"
        : ref.referenceKind as EdgeKind;
      push(
        ref.fromNodeId,
        frameworkResolution.targetNodeId,
        kind,
        ref,
        "framework",
        frameworkResolution.confidence,
        frameworkResolution.resolvedBy,
        {
          resolver: frameworkResolution.resolvedBy,
          wiringSite: { filePath: ref.filePath, line: ref.line, column: ref.column },
        },
      );
      continue;
    }

    // A `recv.method` callee resolves on its method name (last segment).
    const referencedName = lastSegment(ref.referenceName);
    const qualifier = firstQualifier(ref.referenceName);
    const directBindings = bindingsByFile.get(fromNode.filePath)?.get(referencedName) ?? [];
    const qualifierBindings = qualifier
      ? bindingsByFile.get(fromNode.filePath)?.get(qualifier) ?? []
      : [];
    const symbolBindings = directBindings.filter((binding) => binding.importedName !== "*");
    const uniqueDirect = symbolBindings.length === 1
      ? symbolBindings[0]
      : undefined;
    const simpleName = uniqueDirect?.importedName ?? referencedName;
    const candidates = byName.get(simpleName);
    if (!candidates || candidates.length === 0) continue;

    const allowedKinds = TARGET_KINDS[ref.referenceKind] ?? [];
    // A recursive call is still a candidate for itself. Removing it can
    // turn an unresolved overload set into a false, confident sibling edge.
    // Outside C#, only an unimported bare name inside a function, or a
    // lexical self receiver inside a method, can name the calling body:
    // `super().save()`, `other.save()`, or an imported `dumps` inside a
    // method of the same name each name a different body.
    const selfReceiver = (ref.receiver ?? ref.referenceName.split(".").slice(0, -1).join(".")).trim();
    const lexicalSelfCall = directBindings.length === 0 && (selfReceiver === ""
      ? fromNode.kind === "function"
      : fromNode.kind === "method" && LEXICAL_SELF_RECEIVERS.has(selfReceiver));
    const allowSelf = (ref.referenceKind === "calls" || ref.referenceKind === "function_ref")
      && (ref.language === "csharp" || lexicalSelfCall);
    const filtered = candidates.filter((node) =>
      (allowedKinds.length === 0 || allowedKinds.includes(node.kind))
      && (allowSelf || node.id !== ref.fromNodeId),
    );
    if (filtered.length === 0) continue;

    const provenFiles = new Set([
      ...directBindings.map((binding) => binding.targetPath),
      ...qualifierBindings.map((binding) => binding.targetPath),
    ]);
    const target = pickBest(
      filtered,
      fromNode,
      ref,
      provenFiles.size > 0 ? provenFiles : importsByFile.get(fromNode.filePath),
      qualifierBindings.length > 0,
    );
    if (!target) continue;

    const edgeKind: EdgeKind =
      ref.referenceKind === "function_ref" ? "references" : (ref.referenceKind as EdgeKind);
    push(
      ref.fromNodeId,
      target.id,
      edgeKind,
      ref,
      "lexical",
      1,
      target.filePath === fromNode.filePath ? "lexical-scope" : "explicit-import",
    );
  }

  for (const ref of refs) {
    if (ref.status === "pending" || ref.status === undefined) {
      ref.status = (ref.candidates?.length ?? 0) > 1 ? "ambiguous" : "unresolved";
      ref.confidence = ref.status === "ambiguous" ? 0.75 : 0;
    }
  }
  return edges;
}

/**
 * Choose the best target among same-named candidates:
 *   1. one defined in the SAME file as the reference,
 *   2. one in a file the reference's file IMPORTS,
 *   otherwise null (ambiguous — better no edge than a wrong one).
 */
function pickBest(
  candidates: GraphNode[],
  fromNode: GraphNode,
  ref: UnresolvedRefRecord,
  importedFiles: Set<string> | undefined,
  explicitQualifier = false,
): GraphNode | null {
  const receiver = ref.receiver ?? ref.referenceName.split(".").slice(0, -1).join(".");
  // A C# qualifier may name an object, namespace, type, or alias. Syntax alone
  // cannot bind it to a same-named lexical symbol, including in heritage and
  // construction references. Only `this` calls have a proven lexical receiver.
  if (ref.language === "csharp") {
    const isThisCall = receiver.trim() === "this"
      && (ref.referenceKind === "calls" || ref.referenceKind === "function_ref");
    const isQualified = receiver.trim() !== "" || ref.referenceName.includes("::");
    if (isQualified && !isThisCall) return null;
  }
  // Rust member-call extraction retains the receiver. Only `self` proves a
  // lexical impl owner; a same-named method in that file does not type `other`.
  // Explicit imported module qualifiers can still bind in their own file.
  if (ref.language === "rust" && receiver && receiver !== "self" && !explicitQualifier) return null;

  const sameFile = candidates.filter((n) => n.filePath === fromNode.filePath);
  if (sameFile.length > 0) {
    // `this`/`super` and unqualified names may bind only inside the lexical
    // container. Never pick the first same-named method in the file.
    const lexical = sameFile.filter((node) => {
      // `this.M()` names a member, never a local function named M in the
      // calling method. Nested/local functions have no proven type receiver.
      if (ref.language === "csharp" && receiver === "this") {
        return node.kind === "method" && node.containerId === fromNode.containerId;
      }
      return node.containerId === fromNode.containerId || node.containerId === fromNode.id;
    });
    if (lexical.length === 1) return lexical[0]!;
    if (lexical.length > 1) return null;
    const moduleLevel = sameFile.filter((node) => !node.containerId);
    if (!receiver && moduleLevel.length === 1) return moduleLevel[0]!;
    return null;
  }

  if (importedFiles) {
    const imported = candidates.filter((n) => importedFiles.has(n.filePath));
    if (imported.length === 1) return imported[0]!;
  }
  return null;
}

/** The segment after the last `.` (`obj.method` → `method`; `free` → `free`). */
const CSHARP_TYPE_KINDS = new Set<string>(["class", "interface", "struct", "enum"]);

/** C# namespace visibility: enclosing namespaces plus `using` directives, per file. */
function createCSharpScope(
  nodes: GraphNode[],
  refs: UnresolvedRefRecord[],
  byId: Map<string, GraphNode>,
): { resolve(ref: UnresolvedRefRecord, fromNode: GraphNode): GraphNode | null } {
  const typesByName = new Map<string, GraphNode[]>();
  const usingsByFile = new Map<string, Set<string>>();
  const namespaceOf = new Map<string, string>();
  const childrenByContainer = new Map<string, GraphNode[]>();
  const membersCache = new Map<string, Map<string, GraphNode[]>>();
  const usings = (file: string): Set<string> => {
    let set = usingsByFile.get(file);
    if (!set) usingsByFile.set(file, (set = new Set()));
    return set;
  };
  const enclosingNamespace = (node: GraphNode): string => {
    const known = namespaceOf.get(node.id);
    if (known !== undefined) return known;
    const names: string[] = [];
    for (let current = byId.get(node.containerId ?? ""); current; current = byId.get(current.containerId ?? "")) {
      if (current.kind === "namespace") names.unshift(current.name);
    }
    const name = names.join(".");
    namespaceOf.set(node.id, name);
    return name;
  };
  let any = false;
  for (const node of nodes) {
    if (node.language !== "csharp") continue;
    any = true;
    if (node.containerId) {
      const siblings = childrenByContainer.get(node.containerId);
      if (siblings) siblings.push(node); else childrenByContainer.set(node.containerId, [node]);
    }
    if (CSHARP_TYPE_KINDS.has(node.kind)) {
      const list = typesByName.get(node.name);
      if (list) list.push(node); else typesByName.set(node.name, [node]);
    }
  }
  if (!any) return { resolve: () => null };
  for (const ref of refs) {
    if (ref.language !== "csharp" || ref.referenceKind !== "imports") continue;
    const name = ref.referenceName.replace(/^global::/, "").trim();
    if (name.startsWith("static ") || name.includes("=")) continue;
    usings(ref.filePath).add(name);
  }

  /** C# lookup order: enclosing types, then each enclosing namespace inward-out, then usings and the global namespace. */
  const resolveType = (raw: string, fromNode: GraphNode): GraphNode | null => {
    const explicitGlobal = raw.trim().startsWith("global::");
    const name = raw.replace(/^\s*global::/, "").replace(/<.*$/s, "").replace(/\?$/, "").trim();
    if (!/^[A-Za-z_][\w.]*$/.test(name)) return null;
    const dot = name.lastIndexOf(".");
    const simple = dot < 0 ? name : name.slice(dot + 1);
    const qualifier = dot < 0 ? "" : name.slice(0, dot);
    const candidates = typesByName.get(simple) ?? [];
    if (candidates.length === 0) return null;
    const unique = (list: GraphNode[]): GraphNode | null | undefined =>
      list.length === 1 ? list[0]! : list.length > 1 ? null : undefined;
    const within = (namespace: string) => candidates.filter((type) =>
      enclosingNamespace(type) === namespace && !CSHARP_TYPE_KINDS.has(byId.get(type.containerId ?? "")?.kind ?? ""));
    if (explicitGlobal) return unique(within(qualifier)) ?? null;
    if (qualifier === "") {
      const ancestors = new Set<string>();
      for (let node = byId.get(fromNode.containerId ?? ""); node; node = byId.get(node.containerId ?? "")) ancestors.add(node.id);
      ancestors.add(fromNode.id);
      const nested = unique(candidates.filter((type) => type.containerId !== undefined && ancestors.has(type.containerId)
        && byId.get(type.containerId)?.kind !== "namespace"));
      if (nested !== undefined) return nested;
    }
    const enclosing = enclosingNamespace(fromNode);
    const parts = enclosing === "" ? [] : enclosing.split(".");
    for (let length = parts.length; length > 0; length -= 1) {
      const prefix = parts.slice(0, length).join(".");
      const found = unique(within(qualifier === "" ? prefix : `${prefix}.${qualifier}`));
      if (found !== undefined) return found;
    }
    if (qualifier !== "") return unique(within(qualifier)) ?? null;
    const imported = usings(fromNode.filePath);
    return unique(candidates.filter((type) => {
      const namespace = enclosingNamespace(type);
      return (namespace === "" || imported.has(namespace)) && !CSHARP_TYPE_KINDS.has(byId.get(type.containerId ?? "")?.kind ?? "");
    })) ?? null;
  };

  return {
    resolve(ref, fromNode) {
      if (ref.referenceKind === "extends" || ref.referenceKind === "implements" || ref.referenceKind === "instantiates") {
        const type = resolveType(ref.referenceName, fromNode);
        return type && type.id !== fromNode.id ? type : null;
      }
      if (ref.referenceKind !== "calls") return null;
      const dot = ref.referenceName.lastIndexOf(".");
      if (dot < 0) return null;
      const receiver = ref.referenceName.slice(0, dot);
      if (receiver === "this" || receiver === "base") return null;
      const type = resolveType(receiver, fromNode);
      if (!type) return null;
      const method = ref.referenceName.slice(dot + 1);
      const members = membersByType(type.id).get(method) ?? [];
      return members.length > 0 && members.every((member) => member.qualifiedName === members[0]!.qualifiedName)
        ? members[0]!
        : null;
    },
  };

  function membersByType(typeId: string): Map<string, GraphNode[]> {
    let members = membersCache.get(typeId);
    if (members) return members;
    members = new Map();
    for (const node of childrenByContainer.get(typeId) ?? []) {
      if (node.kind !== "method") continue;
      const list = members.get(node.name);
      if (list) list.push(node); else members.set(node.name, [node]);
    }
    membersCache.set(typeId, members);
    return members;
  }
}

function lastSegment(name: string): string {
  const dot = name.lastIndexOf(".");
  const rust = name.lastIndexOf("::");
  const index = Math.max(dot, rust);
  return index < 0 ? name : name.slice(index + (index === rust ? 2 : 1));
}

function firstQualifier(name: string): string | undefined {
  const match = name.match(/^([A-Za-z_$][\w$]*)(?:(?:::)|\.)/);
  return match?.[1];
}

function importBindings(ref: UnresolvedRefRecord): Array<{ localName: string; importedName: string }> {
  const raw = ref.metadata?.bindings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is { localName: string; importedName: string } => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.localName === "string" && typeof candidate.importedName === "string";
  });
}

/**
 * Resolve a relative module specifier to a project file path that has a `file:`
 * node. Tries the bare path, each source extension, and an `index.*` under it.
 * Bare (non-relative) specifiers are external packages — unresolved (null).
 */
function resolveModulePath(
  fromFile: string,
  specifier: string,
  language: Language,
  fileNodeByPath: Map<string, string>,
): string | null {
  if (language === "python") {
    return resolvePythonModulePath(fromFile, specifier, fileNodeByPath);
  }
  if (language === "rust") {
    return resolveRustModulePath(fromFile, specifier, fileNodeByPath);
  }
  if (!specifier.startsWith(".")) return null; // external package
  const base = posixJoin(posixDirname(fromFile), specifier);
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((ext) => base + ext),
    ...MODULE_EXTENSIONS.map((ext) => posixJoin(base, "index") + ext),
  ];
  for (const candidate of candidates) {
    if (fileNodeByPath.has(candidate)) return candidate;
  }
  return null;
}

/** Resolve a local Rust `use` path to the module file which owns its symbols. */
function resolveRustModulePath(
  fromFile: string,
  specifier: string,
  fileNodeByPath: Map<string, string>,
): string | null {
  const normalized = specifier.replace(/^\s*pub\s+/, "").replace(/\s+as\s+[^:,{]+$/, "").trim();
  const bracePrefix = normalized.includes("{") ? normalized.slice(0, normalized.indexOf("{")).replace(/::$/, "") : normalized;
  const parts = bracePrefix.split("::").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const fromDir = posixDirname(fromFile);
  const sourceRoot = rustCrateRoot(fromFile, fileNodeByPath)
    ?? (fromFile.includes("/") ? fromFile.split("/", 1)[0]! : "");
  let base = fromDir;
  const sibling = parts[0] === "crate" || parts[0] === "self" || parts[0] === "super"
    ? null
    : rustWorkspaceCrateRoot(parts[0]!, fileNodeByPath);
  if (parts[0] === "crate") {
    parts.shift();
    base = sourceRoot;
  } else if (sibling !== null) {
    // `use ignore::types::Types` from another workspace member names that
    // member's library root, the unique indexed `<name>/src/lib.rs`.
    parts.shift();
    base = sibling;
  } else if (parts[0] === "self") {
    parts.shift();
    base = rustModuleDirectory(fromFile);
  } else {
    while (parts[0] === "super") {
      parts.shift();
      base = posixDirname(base);
    }
  }

  const bases = [...new Set([base, sourceRoot].filter((entry) => entry !== undefined))];
  // A use path may end in either a module or a symbol. Try longest module path
  // first, then peel symbol segments until an indexed local module is proven.
  for (let length = parts.length; length > 0; length -= 1) {
    const moduleParts = parts.slice(0, length);
    for (const candidateBase of bases) {
      const moduleBase = posixJoin(candidateBase, ...moduleParts);
      for (const candidate of [`${moduleBase}.rs`, posixJoin(moduleBase, "mod.rs")]) {
        if (fileNodeByPath.has(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** The nearest ancestor holding the crate root (`lib.rs` or `main.rs`). */
function rustCrateRoot(fromFile: string, fileNodeByPath: Map<string, string>): string | null {
  for (let dir = posixDirname(fromFile); ; dir = posixDirname(dir)) {
    if (fileNodeByPath.has(posixJoin(dir, "lib.rs")) || fileNodeByPath.has(posixJoin(dir, "main.rs"))) return dir;
    if (dir === "" || dir === ".") return null;
  }
}

/** The library root of a workspace member whose directory names the crate, when unique. */
function rustWorkspaceCrateRoot(crate: string, fileNodeByPath: Map<string, string>): string | null {
  let members = rustMembersByIndex.get(fileNodeByPath);
  if (members === undefined) {
    members = new Map();
    for (const path of fileNodeByPath.keys()) {
      if (!path.endsWith("/src/lib.rs")) continue;
      const memberDir = posixDirname(posixDirname(path));
      const member = memberDir.slice(memberDir.lastIndexOf("/") + 1).replace(/-/g, "_");
      members.set(member, members.has(member) ? null : posixDirname(path));
    }
    rustMembersByIndex.set(fileNodeByPath, members);
  }
  return members.get(crate) ?? null;
}
const rustMembersByIndex = new WeakMap<Map<string, string>, Map<string, string | null>>();

function rustModuleDirectory(fromFile: string): string {
  const dir = posixDirname(fromFile);
  const file = fromFile.slice(fromFile.lastIndexOf("/") + 1);
  if (file === "mod.rs" || file === "lib.rs" || file === "main.rs") return dir;
  return posixJoin(dir, file.replace(/\.rs$/, ""));
}

/** Resolve Python's dotted absolute and package-relative module syntax. */
function resolvePythonModulePath(
  fromFile: string,
  specifier: string,
  fileNodeByPath: Map<string, string>,
): string | null {
  const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
  const moduleName = specifier.slice(leadingDots);
  const modulePath = moduleName.replace(/\./g, "/");

  let base: string;
  if (leadingDots > 0) {
    // One dot means the current package; each additional dot ascends once.
    let packageDir = posixDirname(fromFile);
    for (let level = 1; level < leadingDots; level++) {
      packageDir = posixDirname(packageDir);
    }
    base = modulePath ? posixJoin(packageDir, modulePath) : packageDir;
  } else {
    // Absolute Python imports are rooted at the indexed project. Runtime
    // sys.path customization is intentionally outside static graph extraction.
    base = modulePath;
  }

  if (!base) return null;
  const candidates = [base, `${base}.py`, posixJoin(base, "__init__.py")];
  for (const candidate of candidates) {
    if (fileNodeByPath.has(candidate)) return candidate;
  }
  return null;
}

// --- Minimal posix path helpers (graph paths are always forward-slash) -------

function posixDirname(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
}

/** Join + normalize forward-slash path segments, collapsing `.` and `..`. */
function posixJoin(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}
