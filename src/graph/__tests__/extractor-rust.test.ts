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

  it("extracts traits", () => {
    expect(node("interface", "Greeter")).toBeDefined();
  });

  it("extracts impl blocks and methods", () => {
    const greet = node("method", "greet");
    expect(greet).toBeDefined();
    expect(greet!.qualifiedName).toBe("User::greet");
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
});
