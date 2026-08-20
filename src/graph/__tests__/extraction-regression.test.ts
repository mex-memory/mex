import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("Graph Extraction Regression", () => {
  beforeAll(async () => {
    await loadGrammars(["typescript", "javascript", "tsx", "jsx", "python", "rust"]);
  });

  const extractFixture = (filename: string): FileExtraction => {
    const path = join(FIXTURES_DIR, filename);
    const source = readFileSync(path, "utf-8");
    const result = extractFile(`fixtures/${filename}`, source);
    expect(result).not.toBeNull();
    return result!;
  };

  const node = (result: FileExtraction, kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);
  const hasEdge = (result: FileExtraction, kind: string, targetName: string) =>
    result.edges.some((e) => e.kind === kind && e.targetName === targetName);
  const hasContainsEdge = (result: FileExtraction, sourceId: string, targetId: string) =>
    result.edges.some((e) => e.kind === "contains" && e.source === sourceId && e.target === targetId);

  describe("TypeScript Edge Cases", () => {
    let result: FileExtraction;
    beforeAll(() => {
      result = extractFixture("typescript-edge-cases.ts");
    });

    it("detects language correctly", () => {
      expect(result.language).toBe("typescript");
    });

    it("extracts interfaces, types, and enums", () => {
      expect(node(result, "interface", "ProcessorOptions")).toBeDefined();
      expect(node(result, "type_alias", "Status")).toBeDefined();
      expect(node(result, "enum", "ErrorCode")).toBeDefined();
      expect(node(result, "enum_member", "Timeout")).toBeDefined();
    });

    it("extracts classes with visibility modifiers and return types", () => {
      const cls = node(result, "class", "Processor");
      expect(cls).toBeDefined();

      const options = node(result, "property", "options");
      expect(options).toBeDefined();
      expect(options!.visibility).toBe("protected");

      const run = node(result, "method", "run");
      expect(run).toBeDefined();
      expect(run!.visibility).toBe("public");
      expect(run!.isAsync).toBe(true);
      expect(run!.returnType).toBe("Promise<void>");
    });

    it("captures qualified names and containment", () => {
      const cls = node(result, "class", "Processor");
      const run = node(result, "method", "run");
      expect(run!.qualifiedName).toBe("Processor::run");
      expect(hasContainsEdge(result, cls!.id, run!.id)).toBe(true);
    });

    it("captures imports and calls", () => {
      expect(hasEdge(result, "imports", "external-lib")).toBe(true);
      expect(hasEdge(result, "calls", "externalHelper")).toBe(true);
    });
  });

  describe("JavaScript Edge Cases", () => {
    let result: FileExtraction;
    beforeAll(() => {
      result = extractFixture("javascript-edge-cases.js");
    });

    it("detects language correctly", () => {
      expect(result.language).toBe("javascript");
    });

    it("extracts classes, static methods, and calls", () => {
      expect(node(result, "class", "Manager")).toBeDefined();
      
      const create = node(result, "method", "create");
      expect(create).toBeDefined();
      expect(create!.isStatic).toBe(true);

      expect(hasEdge(result, "instantiates", "Manager")).toBe(true);
      expect(hasEdge(result, "calls", "api.save")).toBe(true);
    });

    it("degrades gracefully on ambiguous syntax", () => {
      expect(result.health.status).toBe("partial");
      // A declaration intersecting a parser diagnostic is not a trustworthy
      // graph fact; valid declarations elsewhere in the file remain indexed.
      expect(node(result, "function", "withWeirdSyntax")).toBeUndefined();
      expect(node(result, "class", "Manager")).toBeDefined();
    });
  });

  describe("TSX Components", () => {
    let result: FileExtraction;
    beforeAll(() => {
      result = extractFixture("tsx-component.tsx");
    });

    it("detects language correctly", () => {
      expect(result.language).toBe("tsx");
    });

    it("extracts components, arrow functions, and calls", () => {
      expect(node(result, "interface", "Props")).toBeDefined();
      expect(result.health.status).toBe("partial");
      expect(node(result, "function", "Widget")).toBeUndefined();
      
      // Widget intersects the invalid JSX line, so calls inside it are withheld
      // with the declaration instead of being presented as trusted structure.
      expect(hasEdge(result, "calls", "setCount")).toBe(false);
    });

    it("captures JSX component usage via imports", () => {
      expect(hasEdge(result, "imports", "react")).toBe(true);
      expect(hasEdge(result, "imports", "./Header")).toBe(true);
    });
  });

  describe("JSX Components", () => {
    let result: FileExtraction;
    beforeAll(() => {
      result = extractFixture("jsx-component.jsx");
    });

    it("detects language correctly", () => {
      expect(result.language).toBe("jsx");
    });

    it("extracts functions and internal arrow functions", () => {
      const page = node(result, "function", "Page");
      expect(page).toBeDefined();

      // Local arrow functions are not extracted, but their instantiations attribute to the parent
      expect(hasEdge(result, "instantiates", "Promise")).toBe(true);
    });

    it("captures promise instantiations", () => {
      expect(hasEdge(result, "instantiates", "Promise")).toBe(true);
    });
  });

  describe("fallback parser recovery", () => {
    it("keeps healthy Python declarations and withholds declarations intersecting errors", () => {
      const result = extractFile(
        "src/recovery.py",
        "def healthy_python():\n    return 1\n\ndef broken_python(:\n    return 2\n",
      )!;
      expect(result.health.status).toBe("partial");
      expect(node(result, "function", "healthy_python")).toBeDefined();
      expect(node(result, "function", "broken_python")).toBeUndefined();
    });

    it("keeps healthy Rust declarations and withholds declarations intersecting errors", () => {
      const result = extractFile(
        "src/recovery.rs",
        "pub fn healthy_rust() -> u8 { 1 }\nfn broken_rust( { 2 }\n",
      )!;
      expect(result.health.status).toBe("partial");
      expect(node(result, "function", "healthy_rust")).toBeDefined();
      expect(node(result, "function", "broken_rust")).toBeUndefined();
    });
  });
});
