// Spring Boot 4 FrameworkResolver — routes + constructor injection.
// Express-style source scan; Boot 4 detection only.

import { generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode } from "../../types.js";
import { isSpringBoot4Project } from "./spring-boot-detect.js";
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolvedRef,
  UnresolvedRef,
} from "../types.js";

const MAPPING_ANN =
  /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(\s*([^)]*)\s*\))?/g;

const CLASS_DECL =
  /(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/g;

const METHOD_ANN_THEN_DECL =
  /(@(?:GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\([^)]*\))?)\s*(?:(?:public|protected|private|static|final|synchronized|native|abstract|default)\s+)*[\w.<>,\[\]\s]+\s+([A-Za-z_]\w*)\s*\(/g;

const HTTP_FROM_ANN: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
};

const PRIMITIVE_OR_WRAPPER = new Set([
  "byte",
  "short",
  "int",
  "long",
  "float",
  "double",
  "boolean",
  "char",
  "void",
  "Byte",
  "Short",
  "Integer",
  "Long",
  "Float",
  "Double",
  "Boolean",
  "Character",
  "String", // not a bean injection target for MVP
]);

export const springBootResolver: FrameworkResolver = {
  name: "spring-boot",
  languages: ["java"],
  detect(context) {
    return isSpringBoot4Project(context);
  },
  claimsReference: (name) => /^[A-Za-z_]\w*$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];
    if (!filePath.endsWith(".java")) return { nodes, references };

    const classes = findClasses(content);
    for (const cls of classes) {
      const classPath = classLevelPath(cls.header);
      const classNodeId = generateNodeId(filePath, "class", cls.name);

      // --- Routes ---
      for (const match of cls.body.matchAll(METHOD_ANN_THEN_DECL)) {
        const annBlock = match[1]!;
        const methodName = match[2]!;
        if (methodName === cls.name) continue; // constructor mis-match guard

        const annMatch = annBlock.match(
          /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(\s*([^)]*)\s*\))?/,
        );
        if (!annMatch) continue;
        const annName = annMatch[1]!;
        const args = annMatch[2] ?? "";
        const httpMethod = httpMethodOf(annName, args);
        if (!httpMethod) continue;
        const paths = pathLiterals(args);
        const pathList = paths.length > 0 ? paths : [""];

        for (const methodPath of pathList) {
          const fullPath = joinPaths(classPath, methodPath);
          const routeName = `${httpMethod} ${fullPath}`;
          const line = lineOf(content, cls.start + (match.index ?? 0));
          const id = generateNodeId(filePath, "route", routeName);
          nodes.push({
            id,
            kind: "route",
            name: routeName,
            qualifiedName: routeName,
            filePath,
            language: "java",
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            isExported: false,
            updatedAt: 0,
          });
          references.push({
            fromNodeId: id,
            referenceName: methodName,
            referenceKind: "function_ref",
            filePath,
            language: "java",
            line: line - 1,
            column: 0,
          });
        }
      }

      // --- Constructor injection ---
      for (const typeName of injectableParamTypes(cls, content)) {
        const line = lineOf(content, cls.start);
        references.push({
          fromNodeId: classNodeId,
          referenceName: typeName,
          referenceKind: "references",
          filePath,
          language: "java",
          line: line - 1,
          column: 0,
        });
      }
    }

    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind === "function_ref") {
      const candidates = context
        .getNodesByName(ref.referenceName)
        .filter((node) => node.kind === "function" || node.kind === "method");
      const sameFile = candidates.filter((node) => node.filePath === ref.filePath);
      const target =
        sameFile.length === 1
          ? sameFile[0]
          : candidates.length === 1
            ? candidates[0]
            : null;
      return target
        ? {
            original: ref,
            targetNodeId: target.id,
            confidence: 1,
            resolvedBy: "framework",
          }
        : null;
    }

    if (ref.referenceKind === "references") {
      const from = context.getNodeById(ref.fromNodeId);
      if (!from || from.kind !== "class") return null;

      const candidates = context
        .getNodesByName(ref.referenceName)
        .filter((node) => node.kind === "class" && node.id !== from.id);

      if (candidates.length === 1) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 1,
          resolvedBy: "framework",
        };
      }

      if (candidates.length > 1) {
        const fromDir = dirOf(from.filePath);
        const sameDir = candidates.filter((node) => dirOf(node.filePath) === fromDir);
        if (sameDir.length === 1) {
          return {
            original: ref,
            targetNodeId: sameDir[0]!.id,
            confidence: 1,
            resolvedBy: "framework",
          };
        }
      }
      return null;
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// Class / annotation parsing helpers
// ---------------------------------------------------------------------------

interface ClassSpan {
  name: string;
  /** Annotations + modifiers text before `{`. */
  header: string;
  body: string;
  start: number;
}

function findClasses(content: string): ClassSpan[] {
  const results: ClassSpan[] = [];
  CLASS_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_DECL.exec(content)) !== null) {
    const name = m[1]!;
    const brace = content.indexOf("{", m.index + m[0].length);
    if (brace < 0) continue;
    const headerStart = findHeaderStart(content, m.index);
    const header = content.slice(headerStart, brace);
    const bodyEnd = matchBrace(content, brace);
    if (bodyEnd < 0) continue;
    results.push({
      name,
      header,
      body: content.slice(brace + 1, bodyEnd),
      start: headerStart,
    });
  }
  return results;
}

/** Walk backward over annotations / whitespace before `class`. */
function findHeaderStart(content: string, classKeywordIndex: number): number {
  let i = classKeywordIndex;
  // include modifiers before class
  while (i > 0 && /[\s\w]/.test(content[i - 1]!)) i--;
  // walk annotation lines above
  let start = i;
  const before = content.slice(0, i);
  const lines = before.split(/\r?\n/);
  let lineIdx = lines.length - 1;
  while (lineIdx >= 0) {
    const line = lines[lineIdx]!.trim();
    if (line === "" || line.startsWith("@") || /^(public|protected|private|abstract|final)$/.test(line)) {
      lineIdx--;
      continue;
    }
    // stop at package, import, previous member
    break;
  }
  // recompute start from kept lines
  if (lineIdx + 1 < lines.length) {
    const kept = lines.slice(lineIdx + 1).join("\n");
    start = before.length - kept.length;
    if (start < 0) start = 0;
  }
  return start;
}

function matchBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    const c = content[i]!;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'") {
      // skip string
      const q = c;
      i++;
      while (i < content.length && content[i] !== q) {
        if (content[i] === "\\") i++;
        i++;
      }
    } else if (c === "/" && content[i + 1] === "/") {
      i += 2;
      while (i < content.length && content[i] !== "\n") i++;
    } else if (c === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i++;
    }
  }
  return -1;
}

function classLevelPath(header: string): string {
  MAPPING_ANN.lastIndex = 0;
  let path = "";
  let m: RegExpExecArray | null;
  while ((m = MAPPING_ANN.exec(header)) !== null) {
    if (m[1] !== "RequestMapping") continue;
    const paths = pathLiterals(m[2] ?? "");
    if (paths.length > 0) {
      path = paths[0]!;
      break;
    }
  }
  return path;
}

function httpMethodOf(annName: string, args: string): string | null {
  if (annName !== "RequestMapping") {
    return HTTP_FROM_ANN[annName] ?? null;
  }
  const methodMatch = args.match(
    /method\s*=\s*RequestMethod\.([A-Z]+)/,
  );
  if (methodMatch) return methodMatch[1]!;
  // Bare @RequestMapping → default GET (documented MVP choice)
  return "GET";
}

function pathLiterals(args: string): string[] {
  if (!args.trim()) return [];
  // path = "..." or value = "..."
  const named = [
    ...args.matchAll(/(?:path|value)\s*=\s*"([^"]*)"/g),
    ...args.matchAll(/(?:path|value)\s*=\s*\{([^}]*)\}/g),
  ];
  if (named.length > 0) {
    const out: string[] = [];
    for (const n of named) {
      const body = n[1]!;
      if (body.includes('"')) {
        for (const s of body.matchAll(/"([^"]*)"/g)) out.push(s[1]!);
      } else {
        out.push(body);
      }
    }
    if (out.length > 0) return out;
  }
  // bare string "@GetMapping("/x")"
  const bare = args.match(/^\s*"([^"]*)"\s*$/);
  if (bare) return [bare[1]!];
  // first string literal anywhere
  const any = [...args.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
  return any;
}

function joinPaths(classPath: string, methodPath: string): string {
  const a = normalizePath(classPath);
  const b = normalizePath(methodPath);
  if (!a && !b) return "/";
  if (!a) return b.startsWith("/") ? b : `/${b}`;
  if (!b) return a.startsWith("/") ? a : `/${a}`;
  const left = a.endsWith("/") ? a.slice(0, -1) : a;
  const right = b.startsWith("/") ? b : `/${b}`;
  const joined = `${left}${right}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function normalizePath(p: string): string {
  return p.trim();
}

function lineOf(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split("\n").length;
}

function dirOf(filePath: string): string {
  const n = filePath.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i < 0 ? "" : n.slice(0, i);
}

function injectableParamTypes(cls: ClassSpan, _fullContent: string): string[] {
  const ctors: Array<{ annotated: boolean; params: string; name: string }> = [];
  // Constructors share the class name. Optional @Autowired/@Inject above.
  const ctorRe = new RegExp(
    `(@(?:Autowired|Inject)\\s+)?(?:public|protected|private)\\s+${cls.name}\\s*\\(([^)]*)\\)\\s*\\{`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = ctorRe.exec(cls.body)) !== null) {
    ctors.push({
      annotated: Boolean(m[1]),
      params: m[2] ?? "",
      name: cls.name,
    });
  }

  if (ctors.length === 0) return [];

  const injectable =
    ctors.length === 1
      ? ctors
      : ctors.filter((c) => c.annotated);

  const types: string[] = [];
  const seen = new Set<string>();
  for (const ctor of injectable) {
    for (const t of paramTypeNames(ctor.params)) {
      if (seen.has(t)) continue;
      seen.add(t);
      types.push(t);
    }
  }
  return types;
}

function paramTypeNames(params: string): string[] {
  if (!params.trim()) return [];
  const parts = splitParams(params);
  const out: string[] = [];
  for (const part of parts) {
    const cleaned = part
      .replace(/@\w+(?:\([^)]*\))?\s*/g, "")
      .replace(/final\s+/g, "")
      .trim();
    if (!cleaned) continue;
    // Type is everything except last identifier (param name)
    const tokens = cleaned.split(/\s+/);
    if (tokens.length < 2) continue;
    const typeToken = tokens[0]!;
    // strip generics: List<Foo> → List; Foo → Foo
    const simple = simpleTypeName(typeToken);
    if (!simple) continue;
    if (PRIMITIVE_OR_WRAPPER.has(simple)) continue;
    if (!/^[A-Z]/.test(simple)) continue;
    out.push(simple);
  }
  return out;
}

function splitParams(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of params) {
    if (c === "<" || c === "(") depth++;
    else if (c === ">" || c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function simpleTypeName(typeToken: string): string {
  // Foo, com.example.Foo, List<Foo>, Foo[]
  let t = typeToken.replace(/\[\]/g, "").trim();
  const gen = t.indexOf("<");
  if (gen >= 0) t = t.slice(0, gen);
  if (t.includes(".")) t = t.slice(t.lastIndexOf(".") + 1);
  return t;
}

