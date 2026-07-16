import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.rs");

describe("Rust extractor", () => {
  let result: FileExtraction;

  beforeAll(async () => {
    await loadGrammars(["rust"]);
    const source = readFileSync(FIXTURE, "utf-8");
    result = extractFile("fixtures/sample.rs", source, "rust")!;
    expect(result).not.toBeNull();
  });

  const node = (kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);
  const hasEdge = (kind: string, targetName: string) =>
    result.edges.some((e) => e.kind === kind && e.targetName === targetName);

  it("emits a file node and stamps the language", () => {
    expect(result.language).toBe("rust");
    expect(node("file", "sample.rs")).toBeDefined();
  });

  it("extracts structs and enums", () => {
    const user = node("class", "User");
    expect(user).toBeDefined();
    expect(user!.isExported).toBe(true);
    expect(user!.docstring).toContain("A simple user struct");
    
    expect(node("property", "name")).toBeDefined();
    expect(node("property", "age")).toBeDefined();
    
    const role = node("enum", "Role");
    expect(role).toBeDefined();
    expect(node("enum_member", "Admin")).toBeDefined();
  });

  it("extracts functions", () => {
    const create = node("function", "create_user");
    expect(create).toBeDefined();
    expect(create!.isExported).toBe(true);
  });

  it("extracts modules and namespaces", () => {
    expect(node("namespace", "admin")).toBeDefined();
    const isAdmin = node("function", "is_admin");
    expect(isAdmin).toBeDefined();
    expect(isAdmin!.qualifiedName).toBe("admin::is_admin");
  });

  it("extracts constants and statics", () => {
    expect(node("constant", "MAX_AGE")).toBeDefined();
    expect(node("variable", "GLOBAL_FLAG")).toBeDefined();
  });

  it("emits an import edge for use declarations", () => {
    expect(hasEdge("imports", "std::collections::HashMap")).toBe(true);
  });

  it("emits calls and implements references", () => {
    expect(hasEdge("implements", "Greeter")).toBe(true);
    expect(hasEdge("calls", "HashMap::new")).toBe(true);
    expect(hasEdge("calls", "insert")).toBe(true);
    expect(hasEdge("calls", "admin::is_admin")).toBe(true);
  });
  
  it("nests methods under their class via contains edges", () => {
    const userClass = node("class", "User")!;
    const greet = node("method", "greet")!;
    expect(
      result.edges.some(
        (e) => e.kind === "contains" && e.source === userClass.id && e.target === greet.id,
      ),
    ).toBe(true);
  });

  // NEW REGRESSION TESTS

  it("extracts traits and trait methods (1)", () => {
    const greeter = node("interface", "Greeter");
    expect(greeter).toBeDefined();
    
    // Trait method without body
    const traitMethod = node("method", "greet");
    expect(traitMethod).toBeDefined();

    const methods = result.nodes.filter(n => n.kind === "method" && n.name === "greet");
    expect(methods.length).toBe(2);
    expect(methods.some(m => m.qualifiedName === "Greeter::greet")).toBe(true);
    expect(methods.some(m => m.qualifiedName === "User::greet")).toBe(true);
  });

  it("extracts struct instantiation references (2)", () => {
    // Should emit instantiates -> User exactly once
    const instantiatesUser = result.edges.filter(e => e.kind === "instantiates" && e.targetName === "User");
    expect(instantiatesUser.length).toBe(1);
  });

  it("extracts generic type parameters (3)", () => {
    const make = node("function", "make")!;
    expect(make.typeParameters).toEqual(["T"]);

    const box = node("class", "Box")!;
    expect(box.typeParameters).toEqual(["T"]);

    const repo = node("interface", "Repo")!;
    expect(repo.typeParameters).toEqual(["T"]);

    const res = node("enum", "Result")!;
    expect(res.typeParameters).toEqual(["T", "E"]);
  });

  it("handles declaration order independently (4)", () => {
    // Order: impl Order then struct Order
    // The impl's `process` method should be attached to the class `Order`.
    const orderClass = node("class", "Order");
    expect(orderClass).toBeDefined();

    const processMethod = node("method", "process")!;
    expect(processMethod).toBeDefined();
    expect(processMethod.qualifiedName).toBe("Order::process");

    // Check containment edge
    expect(
      result.edges.some(
        (e) => e.kind === "contains" && e.source === orderClass!.id && e.target === processMethod.id,
      ),
    ).toBe(true);

    // There should be no namespace created for Order
    const orderNamespace = node("namespace", "Order");
    expect(orderNamespace).toBeUndefined();
  });

  it("avoids duplicate call edges (5)", () => {
    // consume(make::<i32>())
    // Should have exactly one `calls` to `consume` and exactly one to `make` (or `make::<i32>`).
    const callsConsume = result.edges.filter(e => e.kind === "calls" && e.targetName === "consume");
    expect(callsConsume.length).toBe(1);

    const callsMake = result.edges.filter(e => e.kind === "calls" && (e.targetName === "make" || e.targetName === "make::<i32>"));
    expect(callsMake.length).toBe(1);
  });
});
