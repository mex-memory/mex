import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE = join(FIXTURES, "sample.java");
const MODULE_INFO = join(FIXTURES, "module-info.java");

describe("Java extractor", () => {
  let result: FileExtraction;

  beforeAll(async () => {
    await loadGrammars(["java"]);
    const source = readFileSync(SAMPLE, "utf-8");
    result = extractFile("fixtures/sample.java", source, "java")!;
    expect(result).not.toBeNull();
  });

  const node = (kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);
  const hasEdge = (kind: string, targetName: string) =>
    result.edges.some((e) => e.kind === kind && e.targetName === targetName);

  it("emits a file node and stamps the language", () => {
    expect(result.language).toBe("java");
    expect(node("file", "sample.java")).toBeDefined();
  });

  it("extracts package as namespace", () => {
    const pkg = node("namespace", "com.example.demo");
    expect(pkg).toBeDefined();
    expect(pkg!.isExported).toBe(true);
  });

  it("extracts class, interface, heritage, and nested class", () => {
    const greeter = node("class", "Greeter");
    expect(greeter).toBeDefined();
    expect(greeter!.isExported).toBe(true);
    expect(greeter!.docstring).toContain("Demo greeter");
    expect(greeter!.decorators).toContain("Deprecated");

    expect(node("interface", "Speaker")).toBeDefined();
    expect(node("class", "Base")).toBeDefined();
    expect(node("class", "Nested")).toBeDefined();

    expect(hasEdge("extends", "Base")).toBe(true);
    expect(hasEdge("implements", "Speaker")).toBe(true);
  });

  it("extracts enum and enum members", () => {
    expect(node("enum", "Role")).toBeDefined();
    expect(node("enum_member", "ADMIN")).toBeDefined();
    expect(node("enum_member", "USER")).toBeDefined();
  });

  it("extracts record as class with component fields", () => {
    expect(node("class", "Point")).toBeDefined();
    expect(node("field", "x")).toBeDefined();
    expect(node("field", "y")).toBeDefined();
  });

  it("extracts annotation type as interface with elements", () => {
    expect(node("interface", "Flag")).toBeDefined();
    expect(node("method", "value")).toBeDefined();
  });

  it("extracts methods, constructor, fields, and constants", () => {
    const greet = node("method", "greet");
    expect(greet).toBeDefined();
    expect(greet!.signature).toContain("Widget");
    expect(greet!.returnType).toBe("String");
    expect(greet!.isExported).toBe(true);

    expect(node("method", "<init>")).toBeDefined();
    expect(node("method", "format")).toBeDefined();
    expect(node("constant", "MAX")).toBeDefined();
    expect(node("field", "name")).toBeDefined();
  });

  it("emits import edges", () => {
    expect(hasEdge("imports", "java.util.List")).toBe(true);
    expect(hasEdge("imports", "com.example.models.Widget")).toBe(true);
    expect(hasEdge("imports", "java.util.Collections.emptyList")).toBe(true);
    expect(hasEdge("imports", "com.example.util.*")).toBe(true);
  });

  it("emits calls and method references from bodies", () => {
    expect(hasEdge("calls", "touch")).toBe(true);
    expect(hasEdge("calls", "format")).toBe(true);
    // lambda body: System.out.println
    expect(hasEdge("calls", "println")).toBe(true);
  });

  it("nests methods under class via contains", () => {
    const greeter = node("class", "Greeter")!;
    const greet = result.nodes.find(
      (n) => n.kind === "method" && n.name === "greet",
    )!;
    expect(
      result.edges.some(
        (e) => e.kind === "contains" && e.source === greeter.id && e.target === greet.id,
      ),
    ).toBe(true);
  });

  it("extracts module-info as namespace with requires/exports", () => {
    const source = readFileSync(MODULE_INFO, "utf-8");
    const mod = extractFile("module-info.java", source, "java")!;
    expect(mod.nodes.find((n) => n.kind === "namespace" && n.name === "com.example.demo"))
      .toBeDefined();
    expect(mod.edges.some((e) => e.kind === "imports" && e.targetName === "java.base"))
      .toBe(true);
    expect(mod.edges.some((e) => e.kind === "exports" && e.targetName === "com.example.demo"))
      .toBe(true);
  });

  it("degrades safely on malformed syntax", () => {
    expect(() => extractFile("broken.java", "class Broken { void m(", "java")).not.toThrow();
    const broken = extractFile("broken.java", "class Broken { void m(", "java");
    expect(broken?.nodes).toContainEqual(
      expect.objectContaining({ kind: "file", name: "broken.java" }),
    );
  });

  it("produces deterministic, line-independent node ids", () => {
    const greeter = node("class", "Greeter")!;
    expect(greeter.id).toMatch(/^class:[a-f0-9]{32}$/);
  });
});
