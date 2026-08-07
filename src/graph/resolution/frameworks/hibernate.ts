// Hibernate 7 FrameworkResolver — entity associations + Spring Data JPA repos.
// Active only on Spring Boot 4 projects with Hibernate 7 / data-jpa evidence.

import { generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode } from "../../types.js";
import { isHibernate7OnSpringBoot4 } from "./hibernate-detect.js";
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolvedRef,
  UnresolvedRef,
} from "../types.js";

const CLASS_DECL =
  /(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/g;

const INTERFACE_DECL =
  /(?:public\s+|protected\s+|private\s+)?interface\s+([A-Za-z_]\w*)\s+extends\s+([^{]+)/g;

const ASSOC_ANN = /@(ManyToOne|OneToOne|OneToMany|ManyToMany)\b/;

const SPRING_DATA_REPO =
  /\b(JpaRepository|CrudRepository|PagingAndSortingRepository|ListCrudRepository|ListPagingAndSortingRepository)\s*<\s*([A-Za-z_][\w.]*)\s*,/;

const COLLECTION_TYPES = new Set([
  "List",
  "Set",
  "Collection",
  "Optional",
  "Iterable",
  "Map",
]);

const SKIP_TYPES = new Set([
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
  "String",
  "Object",
  "LocalDate",
  "LocalDateTime",
  "LocalTime",
  "Instant",
  "UUID",
  "BigDecimal",
  "BigInteger",
]);

export const hibernateResolver: FrameworkResolver = {
  name: "hibernate",
  languages: ["java"],
  detect(context) {
    return isHibernate7OnSpringBoot4(context);
  },
  claimsReference: (name) => /^[A-Za-z_]\w*$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];
    if (!filePath.endsWith(".java")) return { nodes, references };

    for (const cls of findClasses(content)) {
      if (!isEntity(cls.header)) continue;

      const classNodeId = generateNodeId(filePath, "class", cls.name);
      const targets = associationTargets(cls.body);
      const seen = new Set<string>();
      for (const target of targets) {
        if (seen.has(target)) continue;
        seen.add(target);
        const line = lineOf(content, cls.start);
        references.push({
          fromNodeId: classNodeId,
          referenceName: target,
          referenceKind: "references",
          filePath,
          language: "java",
          line: line - 1,
          column: 0,
        });
      }
    }

    for (const iface of findRepositoryInterfaces(content)) {
      const ifaceId = generateNodeId(filePath, "interface", iface.name);
      const line = lineOf(content, iface.start);
      references.push({
        fromNodeId: ifaceId,
        referenceName: iface.entityType,
        referenceKind: "references",
        filePath,
        language: "java",
        line: line - 1,
        column: 0,
      });
    }

    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind !== "references") return null;
    const from = context.getNodeById(ref.fromNodeId);
    if (!from || (from.kind !== "class" && from.kind !== "interface")) {
      return null;
    }

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
  },
};

// ---------------------------------------------------------------------------

interface ClassSpan {
  name: string;
  header: string;
  body: string;
  start: number;
}

interface RepoIface {
  name: string;
  entityType: string;
  start: number;
}

function isEntity(header: string): boolean {
  return /@Entity\b/.test(header);
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

function findHeaderStart(content: string, classKeywordIndex: number): number {
  let i = classKeywordIndex;
  while (i > 0 && /[\s\w]/.test(content[i - 1]!)) i--;
  let start = i;
  const before = content.slice(0, i);
  const lines = before.split(/\r?\n/);
  let lineIdx = lines.length - 1;
  while (lineIdx >= 0) {
    const line = lines[lineIdx]!.trim();
    if (
      line === "" ||
      line.startsWith("@") ||
      /^(public|protected|private|abstract|final)$/.test(line)
    ) {
      lineIdx--;
      continue;
    }
    break;
  }
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

/**
 * Find association target type names from entity body.
 * Handles field annotations immediately above a field declaration.
 */
function associationTargets(body: string): string[] {
  const targets: string[] = [];
  // Split roughly into field-ish chunks: annotation lines then declaration
  const fieldRe =
    /((?:@\w+(?:\([^;()]*\))?\s*)+)(?:private|protected|public)\s+([\w.<>,\s\[\]]+?)\s+([A-Za-z_]\w*)\s*[;=]/g;

  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(body)) !== null) {
    const anns = m[1]!;
    const typeText = m[2]!.trim();
    if (!ASSOC_ANN.test(anns)) continue;

    const fromTargetEntity = targetEntityArg(anns);
    if (fromTargetEntity) {
      targets.push(fromTargetEntity);
      continue;
    }

    const simple = fieldTypeToEntity(typeText);
    if (simple) targets.push(simple);
  }
  return targets;
}

function targetEntityArg(anns: string): string | null {
  const m = anns.match(/targetEntity\s*=\s*([A-Za-z_][\w.]*)\s*\.class/);
  if (!m) return null;
  return simpleTypeName(m[1]!);
}

function fieldTypeToEntity(typeText: string): string | null {
  let t = typeText.replace(/\s+/g, " ").trim();
  // Map<K,V> → skip value side for MVP (rare for associations)
  if (/^Map\s*</.test(t)) {
    const inner = t.match(/^Map\s*<\s*[^,]+,\s*([A-Za-z_][\w.]*)/);
    if (inner) return acceptableEntityType(simpleTypeName(inner[1]!));
    return null;
  }
  // List<Foo> / Set<Foo> / Collection<Foo> / Optional<Foo>
  const gen = t.match(/^([A-Za-z_]\w*)\s*<\s*([A-Za-z_][\w.]*)/);
  if (gen) {
    const outer = gen[1]!;
    const inner = gen[2]!;
    if (COLLECTION_TYPES.has(outer)) {
      return acceptableEntityType(simpleTypeName(inner));
    }
  }
  return acceptableEntityType(simpleTypeName(t));
}

function acceptableEntityType(name: string | null): string | null {
  if (!name) return null;
  if (SKIP_TYPES.has(name)) return null;
  if (!/^[A-Z]/.test(name)) return null;
  return name;
}

function simpleTypeName(typeToken: string): string {
  let t = typeToken.replace(/\[\]/g, "").trim();
  const gen = t.indexOf("<");
  if (gen >= 0) t = t.slice(0, gen);
  if (t.includes(".")) t = t.slice(t.lastIndexOf(".") + 1);
  return t;
}

function findRepositoryInterfaces(content: string): RepoIface[] {
  const results: RepoIface[] = [];
  INTERFACE_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTERFACE_DECL.exec(content)) !== null) {
    const name = m[1]!;
    const extendsClause = m[2]!;
    const repo = extendsClause.match(SPRING_DATA_REPO);
    if (!repo) continue;
    const entityRaw = repo[2]!;
    const entityType = simpleTypeName(entityRaw);
    if (!acceptableEntityType(entityType)) continue;
    results.push({ name, entityType: entityType!, start: m.index });
  }
  return results;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split("\n").length;
}

function dirOf(filePath: string): string {
  const n = filePath.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i < 0 ? "" : n.slice(0, i);
}
