// Express FrameworkResolver — reference implementation for contributors.
import { generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode, Language } from "../../types.js";
import type { FrameworkExtractionResult, FrameworkResolver, ResolvedRef, UnresolvedRef } from "../types.js";

const ROUTE = /\b(?:app|router)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(["'`])([^"'`]+)\2\s*,\s*([A-Za-z_$][\w$]*)/g;

export const expressResolver: FrameworkResolver = {
  name: "express",
  languages: ["typescript", "javascript", "tsx", "jsx"],
  detect(context) {
    const pkg = context.readFile("package.json");
    if (!pkg) return false;
    try {
      const parsed = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return Boolean(parsed.dependencies?.express ?? parsed.devDependencies?.express);
    } catch { return false; }
  },
  claimsReference: (name) => /^[A-Za-z_$][\w$]*$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];
    const language = languageFor(filePath);
    if (!language) return { nodes, references };
    for (const match of content.matchAll(ROUTE)) {
      const name = `${match[1]!.toUpperCase()} ${match[3]!}`;
      const handler = match[4]!;
      const line = content.slice(0, match.index).split("\n").length;
      const id = generateNodeId(filePath, "route", name);
      nodes.push({ id, kind: "route", name, qualifiedName: name, filePath, language,
        startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
        isExported: false, updatedAt: 0 });
      references.push({ fromNodeId: id, referenceName: handler, referenceKind: "function_ref",
        filePath, language, line: line - 1, column: 0 });
    }
    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind !== "function_ref") return null;
    const candidates = context.getNodesByName(ref.referenceName)
      .filter((node) => node.kind === "function" || node.kind === "method");
    const sameFile = candidates.filter((node) => node.filePath === ref.filePath);
    const target = sameFile.length === 1 ? sameFile[0] : candidates.length === 1 ? candidates[0] : null;
    return target ? { original: ref, targetNodeId: target.id, confidence: 1, resolvedBy: "framework" } : null;
  },
};

function languageFor(filePath: string): Language | null {
  if (/\.(ts|mts|cts)$/.test(filePath)) return "typescript";
  if (/\.tsx$/.test(filePath)) return "tsx";
  if (/\.(js|mjs|cjs)$/.test(filePath)) return "javascript";
  if (/\.jsx$/.test(filePath)) return "jsx";
  return null;
}
