// ============================================================================
// mex code-graph — extractor test harness  (spec §8.2 — the reference example)
// ============================================================================
//
//   >>> THIS IS THE TEST PATTERN EVERY CONTRIBUTOR LANGUAGE COPIES. <<<
//
// A new-language PR is self-verifying when it ships: (1) an extractor, (2) a
// small fixture file in the language, and (3) a unit test asserting the node/
// edge SHAPE the extractor produces. Green + a sane fixture = mergeable, so
// review is mechanical rather than a line-by-line audit.
//
// To add a language, copy this file, point it at your fixture, and assert the
// symbols/edges your grammar should yield. Keep it lightweight — assert shape
// ("fixture yields `function:greet` with a CALLS edge to formatName"), not
// exact counts that churn as the fixture grows.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.ts");

describe("TypeScript extractor", () => {
  let result: FileExtraction;

  beforeAll(async () => {
    // Grammars lazy-load; a contributor's suite loads only their language.
    await loadGrammars(["typescript"]);
    const source = readFileSync(FIXTURE, "utf-8");
    result = extractFile("fixtures/sample.ts", source, "typescript")!;
    expect(result).not.toBeNull();
  });

  // Helpers keep the assertions readable — copy these too.
  const node = (kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);
  const hasEdge = (kind: string, targetName: string) =>
    result.edges.some((e) => e.kind === kind && e.targetName === targetName);

  it("emits a file node and stamps the language", () => {
    expect(result.language).toBe("typescript");
    expect(node("file", "sample.ts")).toBeDefined();
  });

  it("extracts an exported function with its signature", () => {
    const greet = node("function", "greet");
    expect(greet).toBeDefined();
    expect(greet!.isExported).toBe(true);
    expect(greet!.signature).toContain("name");
    expect(greet!.docstring).toContain("Greets a user");
  });

  it("extracts a class, its methods, and callable-field methods", () => {
    expect(node("class", "Greeter")).toBeDefined();
    expect(node("method", "speak")).toBeDefined();
    // `onReady = () => {…}` is a callable field → a method, not a property.
    expect(node("method", "onReady")).toBeDefined();
    // `greeting = PREFIX` is a plain field → a property.
    expect(node("property", "greeting")).toBeDefined();
  });

  it("extracts an arrow-assigned const as a function", () => {
    expect(node("function", "makeGreeter")).toBeDefined();
    expect(node("constant", "PREFIX")).toBeDefined();
  });

  it("emits an import edge to the module specifier", () => {
    expect(hasEdge("imports", "./helpers")).toBe(true);
  });

  it("emits calls, extends, implements, and instantiates references", () => {
    expect(hasEdge("calls", "formatName")).toBe(true); // greet → formatName
    expect(hasEdge("calls", "greet")).toBe(true); //        speak → greet
    expect(hasEdge("extends", "Base")).toBe(true); //       Greeter extends Base
    expect(hasEdge("implements", "Speaker")).toBe(true); // Greeter implements Speaker
    expect(hasEdge("instantiates", "Warmup")).toBe(true); // speak → new Warmup()
  });

  it("nests methods under their class via contains edges", () => {
    const greeter = node("class", "Greeter")!;
    const speak = node("method", "speak")!;
    expect(
      result.edges.some(
        (e) => e.kind === "contains" && e.source === greeter.id && e.target === speak.id,
      ),
    ).toBe(true);
    // Qualified name reflects the containment (`Greeter::speak`).
    expect(speak.qualifiedName).toBe("Greeter::speak");
  });
});
