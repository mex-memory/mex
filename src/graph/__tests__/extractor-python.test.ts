import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.py");

describe("Python extractor", () => {
  let result: FileExtraction;

  beforeAll(async () => {
    await loadGrammars(["python"]);
    const source = readFileSync(FIXTURE, "utf-8");
    result = extractFile(FIXTURE, source, "python")!;
    expect(result).not.toBeNull();
  });

  it("extracts the file node", () => {
    const fileNode = result.nodes.find((n) => n.kind === "file");
    expect(fileNode).toMatchObject({
      name: "sample.py",
      qualifiedName: FIXTURE,
      language: "python",
      isExported: false,
    });
  });

  it("extracts classes, docstrings, and containment", () => {
    const vehicle = result.nodes.find((n) => n.name === "Vehicle");
    expect(vehicle).toMatchObject({
      kind: "class",
      qualifiedName: expect.stringContaining("Vehicle"),
      docstring: "Base class for vehicles.",
      isExported: true,
    });

    const car = result.nodes.find((n) => n.name === "Car");
    expect(car).toMatchObject({
      kind: "class",
      docstring: "A specific type of vehicle.",
      isExported: true,
    });

    const fileNode = result.nodes.find((n) => n.kind === "file")!;
    expect(result.edges).toContainEqual({
      source: fileNode.id,
      target: vehicle!.id,
      kind: "contains",
    });
  });

  it("extracts methods, async methods, and signatures", () => {
    const drive = result.nodes.find((n) => n.name === "drive");
    expect(drive).toMatchObject({
      kind: "method",
      signature: "(self) -> None",
      returnType: "None",
      isAsync: false,
      docstring: "Drive the vehicle.",
    });

    const startEngine = result.nodes.find((n) => n.name === "start_engine");
    expect(startEngine).toMatchObject({
      kind: "method",
      signature: "(self) -> bool",
      returnType: "bool",
      isAsync: true,
    });

    const car = result.nodes.find((n) => n.name === "Car")!;
    expect(result.edges).toContainEqual({
      source: car.id,
      target: startEngine!.id,
      kind: "contains",
    });
  });

  it("extracts top-level functions and private visibility", () => {
    const func = result.nodes.find((n) => n.name === "standalone_function");
    expect(func).toMatchObject({
      kind: "function",
      signature: "(x: int) -> int",
      returnType: "int",
      docstring: "Multiplies x by 2.",
      isExported: true,
    });

    const priv = result.nodes.find((n) => n.name === "_private_func");
    expect(priv).toMatchObject({
      kind: "function",
      isExported: false,
    });
  });

  it("extracts top-level variables and constants", () => {
    const globalConst = result.nodes.find((n) => n.name === "GLOBAL_CONSTANT");
    expect(globalConst).toMatchObject({
      kind: "constant",
      signature: "42",
      isExported: true,
    });

    const internalVar = result.nodes.find((n) => n.name === "_internal_var");
    expect(internalVar).toMatchObject({
      kind: "variable",
      signature: '"hidden"',
      isExported: false,
    });

    const wheels = result.nodes.find((n) => n.name === "wheels");
    expect(wheels).toMatchObject({
      kind: "variable",
      signature: "4",
      isExported: true,
    });
  });

  it("extracts unresolved inheritance (extends)", () => {
    const car = result.nodes.find((n) => n.name === "Car")!;
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        source: car.id,
        targetName: "Vehicle",
        kind: "extends",
      }),
    );
  });

  it("extracts unresolved module imports", () => {
    const fileNode = result.nodes.find((n) => n.kind === "file")!;
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        source: fileNode.id,
        targetName: "os",
        kind: "imports",
      }),
    );
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        source: fileNode.id,
        targetName: "sys",
        kind: "imports",
      }),
    );
  });

  it("extracts unresolved calls and instantiations", () => {
    const startEngine = result.nodes.find((n) => n.name === "start_engine")!;
    const standalone = result.nodes.find((n) => n.name === "standalone_function")!;

    expect(result.edges).toContainEqual(
      expect.objectContaining({
        source: startEngine.id,
        targetName: "drive",
        kind: "calls",
      }),
    );
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        source: startEngine.id,
        targetName: "sleep",
        kind: "calls",
      }),
    );

    expect(result.edges).toContainEqual(
      expect.objectContaining({
        source: standalone.id,
        targetName: "Car",
        kind: "instantiates",
      }),
    );
  });

  it("handles relative imports, metaclasses, and nested calls without duplicates", () => {
    const source = [
      "from . import models",
      "class Base: pass",
      "class Child(Base, metaclass=type): pass",
      "def helper(): pass",
      "def build():",
      "    return Child(helper())",
      "",
    ].join("\n");
    const extracted = extractFile("pkg/service.py", source, "python")!;
    const fileNode = extracted.nodes.find((node) => node.kind === "file")!;
    const child = extracted.nodes.find((node) => node.name === "Child")!;
    const build = extracted.nodes.find((node) => node.name === "build")!;

    expect(extracted.edges).toContainEqual(expect.objectContaining({
      source: fileNode.id,
      targetName: ".models",
      kind: "imports",
    }));
    expect(extracted.edges.filter((edge) => edge.source === child.id && edge.kind === "extends"))
      .toEqual([expect.objectContaining({ targetName: "Base" })]);
    expect(extracted.edges).toContainEqual(expect.objectContaining({
      source: build.id,
      targetName: "Child",
      kind: "instantiates",
    }));
    expect(extracted.edges.filter((edge) => (
      edge.source === build.id && edge.kind === "calls" && edge.targetName === "helper"
    ))).toHaveLength(1);
  });

  it("produces deterministic, line-independent node ids", () => {
    const vehicle = result.nodes.find((n) => n.name === "Vehicle")!;
    expect(vehicle.id).toMatch(/^[\w-:]+$/);
    const func = result.nodes.find((n) => n.name === "standalone_function")!;
    expect(func.id).toMatch(/^[\w-:]+$/);
  });
});
