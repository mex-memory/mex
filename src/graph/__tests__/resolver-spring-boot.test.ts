import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateNodeId } from "../extraction/node-id.js";
import { springBootResolver } from "../resolution/frameworks/spring-boot.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "../resolution/types.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const controllerPath =
  "src/main/java/com/example/WidgetController.java";
const controllerSource = readFileSync(
  join(fixtures, "spring-boot-app", controllerPath),
  "utf-8",
);
const pom4 = readFileSync(join(fixtures, "spring-boot-app", "pom.xml"), "utf-8");
const gradle4 = readFileSync(
  join(fixtures, "spring-boot-gradle", "build.gradle.kts"),
  "utf-8",
);

describe("Spring Boot 4 reference resolver", () => {
  it("detects Boot 4 from Maven pom fixture", () => {
    const context = fakeContext([], { "pom.xml": pom4 });
    expect(springBootResolver.detect(context)).toBe(true);
  });

  it("detects Boot 4 from Gradle kts fixture", () => {
    const context = fakeContext([], { "build.gradle.kts": gradle4 });
    expect(springBootResolver.detect(context)).toBe(true);
  });

  it("does not detect Boot 3 pom", () => {
    const context = fakeContext([], {
      "pom.xml": `
        <parent>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-starter-parent</artifactId>
          <version>3.5.0</version>
        </parent>`,
    });
    expect(springBootResolver.detect(context)).toBe(false);
  });

  it("extracts GET /api/widgets route and handler ref", () => {
    const result = springBootResolver.extract!(controllerPath, controllerSource);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "route", name: "GET /api/widgets" }),
      ]),
    );
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceName: "list",
          referenceKind: "function_ref",
        }),
      ]),
    );
  });

  it("emits constructor-injection reference from controller to WidgetService", () => {
    const classId = generateNodeId(controllerPath, "class", "WidgetController");
    const result = springBootResolver.extract!(controllerPath, controllerSource);
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: classId,
          referenceName: "WidgetService",
          referenceKind: "references",
        }),
      ]),
    );
  });

  it("binds the extracted route reference to its same-file method", () => {
    const handler = node(
      "method:list",
      "list",
      "method",
      controllerPath,
    );
    const context = fakeContext([handler]);
    const ref = springBootResolver
      .extract!(controllerPath, controllerSource)
      .references.find((r) => r.referenceKind === "function_ref")!;
    expect(springBootResolver.resolve(ref, context)).toMatchObject({
      targetNodeId: handler.id,
      confidence: 1,
      resolvedBy: "framework",
    });
  });

  it("resolves unique WidgetService class for injection", () => {
    const controllerId = generateNodeId(controllerPath, "class", "WidgetController");
    const service = node(
      "class:service",
      "WidgetService",
      "class",
      "src/main/java/com/example/WidgetService.java",
    );
    const controller = node(
      controllerId,
      "WidgetController",
      "class",
      controllerPath,
    );
    const context = fakeContext([service, controller]);
    const ref = springBootResolver
      .extract!(controllerPath, controllerSource)
      .references.find((r) => r.referenceName === "WidgetService")!;
    expect(springBootResolver.resolve(ref, context)).toMatchObject({
      targetNodeId: service.id,
      resolvedBy: "framework",
    });
  });

  it("returns null when two WidgetService classes exist", () => {
    const controllerId = generateNodeId(controllerPath, "class", "WidgetController");
    const a = node(
      "class:a",
      "WidgetService",
      "class",
      "src/a/WidgetService.java",
    );
    const b = node(
      "class:b",
      "WidgetService",
      "class",
      "src/b/WidgetService.java",
    );
    const controller = node(
      controllerId,
      "WidgetController",
      "class",
      controllerPath,
    );
    const context = fakeContext([a, b, controller]);
    const ref = springBootResolver
      .extract!(controllerPath, controllerSource)
      .references.find((r) => r.referenceName === "WidgetService")!;
    expect(springBootResolver.resolve(ref, context)).toBeNull();
  });

  it("skips primitives on constructor params", () => {
    const source = `
public class Mixed {
  public Mixed(int n, WidgetService service) {}
}
`;
    const result = springBootResolver.extract!("Mixed.java", source);
    const inject = result.references.filter((r) => r.referenceKind === "references");
    expect(inject.map((r) => r.referenceName)).toEqual(["WidgetService"]);
  });

  it("multi-constructor: only @Autowired ctor params emit", () => {
    const source = `
public class Multi {
  public Multi() {}
  @Autowired
  public Multi(WidgetService service) {}
}
`;
    const result = springBootResolver.extract!("Multi.java", source);
    const inject = result.references.filter((r) => r.referenceKind === "references");
    expect(inject.map((r) => r.referenceName)).toEqual(["WidgetService"]);
  });
});

function node(
  id: string,
  name: string,
  kind: GraphNode["kind"],
  filePath: string,
): GraphNode {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: "java",
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
}

function fakeContext(
  nodes: GraphNode[],
  files: Record<string, string> = {},
): ResolutionContext {
  return {
    getNodesInFile: (path) => nodes.filter((entry) => entry.filePath === path),
    getNodesByName: (name) => nodes.filter((entry) => entry.name === name),
    getNodesByQualifiedName: (name) =>
      nodes.filter((entry) => entry.qualifiedName === name),
    getNodesByKind: (kind) => nodes.filter((entry) => entry.kind === kind),
    getNodeById: (id) => nodes.find((entry) => entry.id === id) ?? null,
    fileExists: (path) => path in files,
    readFile: (path) => files[path] ?? null,
    getProjectRoot: () => "/repo",
    getAllFiles: () => Object.keys(files),
  };
}
