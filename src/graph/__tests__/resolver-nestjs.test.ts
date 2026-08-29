import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nestjsResolver } from "../resolution/frameworks/nestjs.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "../resolution/types.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "nestjs-app.ts");
const source = readFileSync(fixturePath, "utf-8");

describe("NestJS framework resolver", () => {
  it("detects NestJS via @nestjs/core or @nestjs/common dependencies", () => {
    let context = fakeContext([], { "package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^9.0.0" } }) });
    expect(nestjsResolver.detect(context)).toBe(true);
    
    context = fakeContext([], { "package.json": JSON.stringify({ devDependencies: { "@nestjs/common": "^9.0.0" } }) });
    expect(nestjsResolver.detect(context)).toBe(true);
    
    context = fakeContext([], { "package.json": JSON.stringify({ dependencies: { "express": "^4.17.1" } }) });
    expect(nestjsResolver.detect(context)).toBe(false);
  });

  it("extracts route nodes and function references for controllers", () => {
    const result = nestjsResolver.extract!("src/nestjs-app.ts", source);
    
    // Check nodes (route paths normalized)
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "GET /users" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "GET /users/:id" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "POST /users/:id/posts" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "DELETE /users/anonymous" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "GET /health" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "ALL /" }));

    // Check references (handler methods)
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "findAll", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "findOne", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "createPost", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "deleteUser", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "healthCheck", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "fallback", referenceKind: "function_ref" }));
    
    // Ensure no false positives
    expect(result.nodes.length).toBe(6);
    expect(result.references.length).toBe(6);
  });

  it("binds the extracted route reference to its same-file handler", () => {
    const findAllHandler = node("method:findAll", "findAll");
    const healthCheckHandler = node("method:healthCheck", "healthCheck");
    const context = fakeContext([findAllHandler, healthCheckHandler]);
    
    const result = nestjsResolver.extract!("src/nestjs-app.ts", source);
    const findAllRef = result.references.find(r => r.referenceName === "findAll")!;
    const healthCheckRef = result.references.find(r => r.referenceName === "healthCheck")!;
    
    expect(nestjsResolver.resolve(findAllRef, context)).toMatchObject({
      targetNodeId: findAllHandler.id,
      confidence: 1,
      resolvedBy: "framework",
    });
    
    expect(nestjsResolver.resolve(healthCheckRef, context)).toMatchObject({
      targetNodeId: healthCheckHandler.id,
      confidence: 1,
      resolvedBy: "framework",
    });
  });

  it("leaves ambiguous references unresolved when multiple identical method names exist", () => {
    // If a method is found in another file, it should NOT resolve because NestJS dictates same-file.
    // If multiple in the same file, it also shouldn't guess.
    const handler1 = node("method:1", "duplicateMethod");
    const handler2 = { ...node("method:2", "duplicateMethod"), startLine: 10 };
    const context = fakeContext([handler1, handler2]);
    
    const result = nestjsResolver.extract!("src/nestjs-app.ts", source);
    // Let's pretend one of the extracted references was named 'duplicateMethod'
    const fakeRef = { ...result.references[0]!, referenceName: "duplicateMethod" };
    
    expect(nestjsResolver.resolve(fakeRef, context)).toBeNull();
  });
  
  it("leaves missing handlers unresolved", () => {
    const context = fakeContext([]);
    const result = nestjsResolver.extract!("src/nestjs-app.ts", source);
    const fakeRef = { ...result.references[0]!, referenceName: "missingMethod" };
    expect(nestjsResolver.resolve(fakeRef, context)).toBeNull();
  });
});

function node(id: string, name: string): GraphNode {
  return { id, kind: "method", name, qualifiedName: name, filePath: "src/nestjs-app.ts",
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
