import { generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode } from "../../types.js";
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolvedRef,
  UnresolvedRef,
} from "../types.js";

const FRAMEWORK_INSTANCE = /^\s*([A-Za-z_]\w*)\s*=\s*(?:FastAPI|APIRouter)\s*\(/gm;
const ROUTE_DECORATOR = /^(\s*)@([A-Za-z_]\w*)\.(get|post|put|patch|delete|options|head)\s*\(\s*(["'])([^"'\\]*)\4(?:\s*,.*)?\)\s*(?:#.*)?$/;
const ENDPOINT = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PYPROJECT_DEPENDENCY = /(?:^\s*fastapi\s*=|["']fastapi(?:\[[^\]]+\])?(?:\s*(?:[<>=!~]=?|@)[^"']*)?["'])/im;
const REQUIREMENTS_DEPENDENCY = /^\s*fastapi(?:\[[^\]]+\])?(?:\s*(?:[<>=!~]=?|@)[^;#\s]+)?(?:\s*;[^#]+)?\s*(?:#.*)?$/im;

interface PendingRoute {
  method: string;
  path: string;
  line: number;
  startColumn: number;
  endColumn: number;
}

export const fastAPIResolver: FrameworkResolver = {
  name: "fastapi",
  languages: ["python"],
  detect(context) {
    return context.getAllFiles().some((filePath) => {
      const normalizedPath = filePath.replace(/\\/g, "/");
      const content = context.readFile(filePath);
      if (!content) return false;

      if (/(^|\/)pyproject\.toml$/i.test(normalizedPath)) {
        return PYPROJECT_DEPENDENCY.test(content);
      }
      if (/(^|\/)requirements(?:[-_.][^/]*)?\.(?:txt|in)$/i.test(normalizedPath)) {
        return REQUIREMENTS_DEPENDENCY.test(content);
      }
      return false;
    });
  },
  claimsReference: (name) => /^[A-Za-z_]\w*$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    if (!filePath.toLowerCase().endsWith(".py")) {
      return { nodes: [], references: [] };
    }

    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];
    const pendingRoutes: PendingRoute[] = [];
    const routeReceivers = new Set(
      [...content.matchAll(FRAMEWORK_INSTANCE)].map((match) => match[1]!),
    );
    const lines = content.split(/\r?\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!;
      const decorator = ROUTE_DECORATOR.exec(line);
      if (decorator && routeReceivers.has(decorator[2]!)) {
        pendingRoutes.push({
          method: decorator[3]!.toUpperCase(),
          path: decorator[5]!,
          line: lineIndex,
          startColumn: decorator[1]!.length,
          endColumn: line.length,
        });
        continue;
      }

      if (pendingRoutes.length === 0) continue;
      if (/^\s*@/.test(line)) continue;

      const endpoint = ENDPOINT.exec(line);
      if (endpoint) {
        addRoutes(filePath, endpoint[1]!, pendingRoutes, nodes, references);
      }
      pendingRoutes.length = 0;
    }

    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind !== "function_ref") return null;
    const candidates = context.getNodesInFile(ref.filePath).filter((node) => (
      (node.kind === "function" || node.kind === "method")
      && node.name === ref.referenceName
    ));
    if (candidates.length !== 1) return null;

    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 1,
      resolvedBy: "framework",
    };
  },
};

function addRoutes(
  filePath: string,
  endpoint: string,
  routes: PendingRoute[],
  nodes: GraphNode[],
  references: UnresolvedRef[],
): void {
  for (const route of routes) {
    const name = `${route.method} ${route.path}`;
    const id = generateNodeId(filePath, "route", name);
    nodes.push({
      id,
      kind: "route",
      name,
      qualifiedName: name,
      filePath,
      language: "python",
      startLine: route.line + 1,
      endLine: route.line + 1,
      startColumn: route.startColumn,
      endColumn: route.endColumn,
      isExported: false,
      updatedAt: 0,
    });
    references.push({
      fromNodeId: id,
      referenceName: endpoint,
      referenceKind: "function_ref",
      filePath,
      language: "python",
      line: route.line,
      column: route.startColumn,
    });
  }
}
