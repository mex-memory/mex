import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.rb");

describe("Ruby extractor", () => {
  let result: FileExtraction;

  beforeAll(async () => {
    await loadGrammars(["ruby"]);
    const source = readFileSync(FIXTURE, "utf-8");
    result = extractFile(FIXTURE, source, "ruby")!;
    expect(result).not.toBeNull();
  });

  const node = (kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);
  const hasEdge = (kind: string, targetName: string) =>
    result.edges.some((e) => e.kind === kind && e.targetName === targetName);

  it("emits a file node and stamps the language", () => {
    expect(result.language).toBe("ruby");
    expect(node("file", "sample.rb")).toBeDefined();
  });

  it("extracts a module and nested classes with containment", () => {
    expect(node("module", "Greetings")).toBeDefined();
    const greeter = node("class", "Greeter");
    expect(greeter).toBeDefined();
    expect(greeter!.qualifiedName).toBe("Greetings::Greeter");
  });

  it("extracts instance and singleton methods, marking singleton defs static", () => {
    const greet = node("method", "greet");
    expect(greet).toBeDefined();
    expect(greet!.isStatic).not.toBe(true);

    const defaultMethod = node("method", "default");
    expect(defaultMethod).toBeDefined();
    expect(defaultMethod!.isStatic).toBe(true);
  });

  it("extracts a module-scoped constant", () => {
    expect(node("constant", "PREFIX")).toBeDefined();
  });

  it("emits a require edge for require/require_relative", () => {
    expect(hasEdge("imports", "json")).toBe(true);
    expect(hasEdge("imports", "helpers")).toBe(true);
  });

  it("emits extends, implements (mixin), instantiates, and calls edges", () => {
    expect(hasEdge("extends", "Base")).toBe(true); //       Greeter < Base
    expect(hasEdge("implements", "Comparable")).toBe(true); // include Comparable
    expect(hasEdge("instantiates", "Greeter")).toBe(true); //  Greeter.new(...) in .default
    expect(hasEdge("calls", "warm_up")).toBe(true); //        speak -> warm_up
    expect(hasEdge("calls", "format_name")).toBe(true); //    greet -> format_name
  });

  it("degrades safely on a construct with no direct graph representation", () => {
    // Blocks (do...end / { ... }) passed to calls aren't modeled as their own
    // node kind; the surrounding call is still extracted without throwing.
    expect(() => extractFile(FIXTURE, "[1, 2].each { |n| puts n }", "ruby")).not.toThrow();
  });
});
