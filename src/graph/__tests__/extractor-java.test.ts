import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "spring-order-service.java");

describe("Java extractor", () => {
  let result: FileExtraction;

  beforeAll(async () => {
    await loadGrammars(["java"]);
    const source = readFileSync(FIXTURE, "utf-8");
    result = extractFile("fixtures/spring-order-service.java", source, "java")!;
    expect(result).not.toBeNull();
  });

  const node = (kind: string, name: string) =>
    result.nodes.find((entry) => entry.kind === kind && entry.name === name);
  const hasEdge = (kind: string, targetName: string) =>
    result.edges.some((edge) => edge.kind === kind && edge.targetName === targetName);

  it("emits Java file, package, imports, and type declarations", () => {
    expect(result.language).toBe("java");
    expect(node("file", "spring-order-service.java")).toBeDefined();
    expect(node("namespace", "com.example")).toBeDefined();
    expect(node("interface", "PaymentGateway")).toBeDefined();
    expect(node("class", "OrderService")).toBeDefined();
    expect(node("class", "CheckoutConfig")).toBeDefined();
    expect(hasEdge("imports", "org.springframework.stereotype.Service")).toBe(true);
  });

  it("captures annotations as decorators and decorates references", () => {
    const orderService = node("class", "OrderService");
    const beanMethod = result.nodes.find((entry) =>
      entry.kind === "method" && entry.name === "checkout" && entry.decorators?.includes("Bean")
    );
    expect(orderService?.decorators).toContain("Service");
    expect(beanMethod).toBeDefined();
    expect(hasEdge("decorates", "Service")).toBe(true);
    expect(hasEdge("decorates", "Autowired")).toBe(true);
  });

  it("extracts Java type relationships and method body references", () => {
    expect(hasEdge("implements", "PaymentGateway")).toBe(true);
    expect(hasEdge("type_of", "InventoryRepository")).toBe(true);
    expect(hasEdge("returns", "OrderDto")).toBe(true);
    expect(hasEdge("calls", "reserve")).toBe(true);
    expect(hasEdge("instantiates", "OrderDto")).toBe(true);
  });

  it("nests methods and fields under their class", () => {
    const orderService = node("class", "OrderService")!;
    const placeOrder = node("method", "placeOrder")!;
    const inventory = node("field", "inventory")!;
    expect(result.edges).toContainEqual({ source: orderService.id, target: placeOrder.id, kind: "contains" });
    expect(result.edges).toContainEqual({ source: orderService.id, target: inventory.id, kind: "contains" });
    expect(placeOrder.qualifiedName).toBe("com.example::OrderService::placeOrder");
  });
});
