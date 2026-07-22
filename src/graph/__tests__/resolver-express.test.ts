import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expressResolver } from "../resolution/frameworks/express.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "../resolution/types.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "express-app.ts");
const source = readFileSync(fixturePath, "utf-8");

describe("Express reference resolver", () => {
  it("detects Express and extracts a route-to-handler reference", () => {
    const context = fakeContext([], { "package.json": JSON.stringify({ dependencies: { express: "^5.0.0" } }) });
    expect(expressResolver.detect(context)).toBe(true);
    const result = expressResolver.extract!("src/express-app.ts", source);
    expect(result.nodes).toMatchObject([{ kind: "route", name: "GET /health" }]);
    expect(result.references).toMatchObject([{ referenceName: "healthHandler", referenceKind: "function_ref" }]);
  });

  it("binds the extracted route reference to its same-file handler", () => {
    const handler = node("function:handler", "healthHandler");
    const context = fakeContext([handler]);
    const ref = expressResolver.extract!("src/express-app.ts", source).references[0]!;
    expect(expressResolver.resolve(ref, context)).toMatchObject({
      targetNodeId: handler.id,
      confidence: 1,
      resolvedBy: "framework",
    });
  });
});

function node(id: string, name: string): GraphNode {
  return { id, kind: "function", name, qualifiedName: name, filePath: "src/express-app.ts",
    language: "typescript", startLine: 1, endLine: 2, startColumn: 0, endColumn: 0, updatedAt: 0 };
}

function fakeContext(nodes: GraphNode[], files: Record<string, string> = {}): ResolutionContext {
  return {
    getNodesInFile: (path) => nodes.filter((entry) => entry.filePath === path),
    getNodesByName: (name) => nodes.filter((entry) => entry.name === name),
    getNodesByQualifiedName: (name) => nodes.filter((entry) => entry.qualifiedName === name),
    getNodesByKind: (kind) => nodes.filter((entry) => entry.kind === kind),
    getNodeById: (id) => nodes.find((entry) => entry.id === id) ?? null,
    fileExists: (path) => path in files,
    readFile: (path) => files[path] ?? null,
    getProjectRoot: () => "/repo",
    getAllFiles: () => Object.keys(files),
  };
}
