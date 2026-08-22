import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.go");

describe("Go extractor", () => {
  let result: FileExtraction;

  beforeAll(async () => {
    await loadGrammars(["go"]);
    const source = readFileSync(FIXTURE, "utf-8");
    result = extractFile("fixtures/sample.go", source, "go")!;
    expect(result).not.toBeNull();
  });

  const node = (kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);
  const hasEdge = (kind: string, targetName: string) =>
    result.edges.some((e) => e.kind === kind && e.targetName === targetName);

  it("emits a file node and stamps the language", () => {
    expect(result.language).toBe("go");
    expect(node("file", "sample.go")).toBeDefined();
  });

  it("extracts structs", () => {
    const user = node("class", "User");
    expect(user).toBeDefined();
    expect(user!.isExported).toBe(true);
    expect(user!.docstring).toContain("represents a user");

    expect(node("property", "Name")).toBeDefined();
    expect(node("property", "Age")).toBeDefined();

    const order = node("class", "Order");
    expect(order).toBeDefined();
    expect(node("property", "ID")).toBeDefined();
    expect(node("property", "Items")).toBeDefined();
  });

  it("extracts type aliases", () => {
    expect(node("type_alias", "Role")).toBeDefined();
  });

  it("extracts functions and methods", () => {
    const createUser = node("function", "CreateUser");
    expect(createUser).toBeDefined();
    expect(createUser!.isExported).toBe(true);

    const greet = result.nodes.find(
      (n) => n.kind === "method" && n.qualifiedName === "User::Greet",
    );
    expect(greet).toBeDefined();
    expect(greet!.qualifiedName).toBe("User::Greet");
  });

  it("extracts interfaces", () => {
    const greeter = node("interface", "Greeter");
    expect(greeter).toBeDefined();
    expect(greeter!.isExported).toBe(true);

    const repo = node("interface", "Repo");
    expect(repo).toBeDefined();
    expect(repo!.typeParameters).toEqual(["T"]);
  });

  it("extracts constants and variables", () => {
    expect(node("constant", "RoleAdmin")).toBeDefined();
    expect(node("constant", "RoleMember")).toBeDefined();
    expect(node("variable", "globalFlag")).toBeDefined();
  });

  it("emits import edges", () => {
    expect(hasEdge("imports", "fmt")).toBe(true);
    expect(hasEdge("imports", "strings")).toBe(true);
  });

  it("emits calls and implements references", () => {
    expect(hasEdge("calls", "fmt.Sprintf")).toBe(true);
    expect(hasEdge("calls", "processOrder")).toBe(true);
    expect(hasEdge("calls", "consume")).toBe(true);
    expect(hasEdge("instantiates", "Box")).toBe(true);
    expect(hasEdge("instantiates", "Order")).toBe(true);
    expect(hasEdge("instantiates", "User")).toBe(true);
  });

  it("nests methods under their class via contains edges", () => {
    const userClass = node("class", "User")!;
    const greet = result.nodes.find(
      (n) => n.kind === "method" && n.qualifiedName === "User::Greet",
    )!;
    expect(
      result.edges.some(
        (e) => e.kind === "contains" && e.source === userClass.id && e.target === greet.id,
      ),
    ).toBe(true);
  });

  it("emits `type_of` edge for struct fields", () => {
    const nameField = result.nodes.find(
      (n) => n.kind === "property" && n.name === "Name",
    )!;
    expect(nameField).toBeDefined();
    expect(
      result.edges.some(
        (e) => e.kind === "type_of" && e.source === nameField.id && e.targetName === "string",
      ),
    ).toBe(true);
  });

  it("handles generic type parameters", () => {
    const box = node("class", "Box")!;
    expect(box.typeParameters).toEqual(["T"]);

    const makeBox = node("function", "makeBox")!;
    expect(makeBox.typeParameters).toEqual(["T"]);
  });
});