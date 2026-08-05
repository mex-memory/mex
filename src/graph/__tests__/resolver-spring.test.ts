import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import { springResolver } from "../resolution/frameworks/spring.js";
import type { ResolutionContext } from "../resolution/types.js";
import type { GraphNode } from "../types.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "spring-order-service.java");
const filePath = "src/main/java/com/example/SpringOrderService.java";
const source = readFileSync(fixturePath, "utf-8");

describe("Spring reference resolver", () => {
  let nodes: GraphNode[];
  let context: ResolutionContext;

  beforeAll(async () => {
    await loadGrammars(["java"]);
    const extraction = extractFile(filePath, source, "java")!;
    nodes = extraction.nodes.map((node) => ({ ...node, updatedAt: 0 }));
    context = fakeContext(nodes, {
      [filePath]: source,
      "pom.xml": `<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>`,
    });
  });

  it("detects Spring from Maven or Java source evidence", () => {
    expect(springResolver.detect(context)).toBe(true);
    expect(springResolver.detect(fakeContext(nodes, { [filePath]: source }))).toBe(true);
    expect(springResolver.detect(fakeContext([], { "pom.xml": "<project />" }))).toBe(false);
  });

  it("extracts constructor, Lombok-required-args, and bean-method dependency references", () => {
    const refs = springResolver.extract!(filePath, source).references;
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: "PaymentGateway", candidates: ["spring:di", "qualifier:stripe"] }),
      expect.objectContaining({ referenceName: "InventoryRepository", candidates: ["spring:di"] }),
    ]));

    const report = node("class", "ReportService");
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: report.id, referenceName: "InventoryRepository" }),
    ]));

    const beanMethod = nodes.find((entry) =>
      entry.kind === "method" && entry.name === "checkout" && entry.decorators?.includes("Bean")
    )!;
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: beanMethod.id, referenceName: "PaymentGateway" }),
    ]));
  });

  it("binds qualifier-aware interface injection to the matching Spring bean", () => {
    const ref = springResolver.extract!(filePath, source).references.find((entry) =>
      entry.referenceName === "PaymentGateway" && entry.candidates?.includes("qualifier:stripe")
    )!;
    expect(springResolver.resolve(ref, context)).toMatchObject({
      targetNodeId: node("class", "StripePaymentGateway").id,
      confidence: 0.95,
      resolvedBy: "framework",
    });
  });

  it("binds unqualified dependencies to unique component beans", () => {
    const ref = springResolver.extract!(filePath, source).references.find((entry) =>
      entry.referenceName === "InventoryRepository"
    )!;
    expect(springResolver.resolve(ref, context)).toMatchObject({
      targetNodeId: node("class", "InventoryRepository").id,
      resolvedBy: "framework",
    });
  });

  function node(kind: string, name: string): GraphNode {
    const hit = nodes.find((entry) => entry.kind === kind && entry.name === name);
    expect(hit, `expected ${kind} ${name}`).toBeDefined();
    return hit!;
  }
});

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
    getAllFiles: () => [...new Set([...nodes.map((entry) => entry.filePath), ...Object.keys(files)])].sort(),
  };
}
