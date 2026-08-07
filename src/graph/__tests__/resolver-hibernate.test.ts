import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateNodeId } from "../extraction/node-id.js";
import { hibernateResolver } from "../resolution/frameworks/hibernate.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "../resolution/types.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const orderPath = "src/main/java/com/example/Order.java";
const orderSource = readFileSync(
  join(fixtures, "hibernate-boot4-app", orderPath),
  "utf-8",
);
const repoPath = "src/main/java/com/example/OrderRepository.java";
const repoSource = readFileSync(
  join(fixtures, "hibernate-boot4-app", repoPath),
  "utf-8",
);
const pom = readFileSync(join(fixtures, "hibernate-boot4-app", "pom.xml"), "utf-8");

describe("Hibernate 7 reference resolver", () => {
  it("detects Boot 4 + data-jpa fixture", () => {
    expect(hibernateResolver.detect(fakeContext([], { "pom.xml": pom }))).toBe(true);
  });

  it("does not detect Boot 3 + data-jpa", () => {
    const ctx = fakeContext([], {
      "pom.xml": `
        <parent>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-starter-parent</artifactId>
          <version>3.5.0</version>
        </parent>
        <dependency>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-starter-data-jpa</artifactId>
        </dependency>`,
    });
    expect(hibernateResolver.detect(ctx)).toBe(false);
  });

  it("extracts ManyToOne association from Order to Widget", () => {
    const orderId = generateNodeId(orderPath, "class", "Order");
    const result = hibernateResolver.extract!(orderPath, orderSource);
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: orderId,
          referenceName: "Widget",
          referenceKind: "references",
        }),
      ]),
    );
  });

  it("does not emit association for plain String field on entity", () => {
    const source = `
@Entity
public class Widget {
  private String name;
  @ManyToOne
  private Order order;
}
`;
    const result = hibernateResolver.extract!("Widget.java", source);
    const names = result.references.map((r) => r.referenceName);
    expect(names).toContain("Order");
    expect(names).not.toContain("String");
    expect(names).not.toContain("name");
  });

  it("unwraps OneToMany List type argument", () => {
    const source = `
@Entity
public class Order {
  @OneToMany
  private List<LineItem> items;
}
`;
    const result = hibernateResolver.extract!("Order.java", source);
    expect(result.references.map((r) => r.referenceName)).toContain("LineItem");
  });

  it("extracts JpaRepository entity type param", () => {
    const repoId = generateNodeId(repoPath, "interface", "OrderRepository");
    const result = hibernateResolver.extract!(repoPath, repoSource);
    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: repoId,
          referenceName: "Order",
          referenceKind: "references",
        }),
      ]),
    );
  });

  it("extracts CrudRepository entity type param", () => {
    const source = `public interface WidgetRepository extends CrudRepository<Widget, UUID> {}`;
    const result = hibernateResolver.extract!("WidgetRepository.java", source);
    expect(result.references.map((r) => r.referenceName)).toEqual(["Widget"]);
  });

  it("resolves unique Widget class for association", () => {
    const orderId = generateNodeId(orderPath, "class", "Order");
    const widget = node("class:w", "Widget", "class", "src/main/java/com/example/Widget.java");
    const order = node(orderId, "Order", "class", orderPath);
    const context = fakeContext([widget, order]);
    const ref = hibernateResolver
      .extract!(orderPath, orderSource)
      .references.find((r) => r.referenceName === "Widget")!;
    expect(hibernateResolver.resolve(ref, context)).toMatchObject({
      targetNodeId: widget.id,
      resolvedBy: "framework",
    });
  });

  it("returns null when two Widget classes exist", () => {
    const orderId = generateNodeId(orderPath, "class", "Order");
    const a = node("class:a", "Widget", "class", "src/a/Widget.java");
    const b = node("class:b", "Widget", "class", "src/b/Widget.java");
    const order = node(orderId, "Order", "class", orderPath);
    const context = fakeContext([a, b, order]);
    const ref = hibernateResolver
      .extract!(orderPath, orderSource)
      .references.find((r) => r.referenceName === "Widget")!;
    expect(hibernateResolver.resolve(ref, context)).toBeNull();
  });

  it("prefers targetEntity override", () => {
    const source = `
@Entity
public class Order {
  @ManyToOne(targetEntity = Widget.class)
  private Object widget;
}
`;
    const result = hibernateResolver.extract!("Order.java", source);
    expect(result.references.map((r) => r.referenceName)).toContain("Widget");
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
