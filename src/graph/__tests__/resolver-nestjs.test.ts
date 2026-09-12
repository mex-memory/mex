import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nestjsResolver } from "../resolution/frameworks/nestjs.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "../resolution/types.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "nestjs-app.ts");
const source = readFileSync(fixturePath, "utf-8");

describe("NestJS framework resolver", () => {
  it("detects NestJS via @nestjs/core or @nestjs/common dependencies", () => {
    let context = fakeContext([], { "package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^9.0.0" } }) });
    expect(nestjsResolver.detect(context)).toBe(true);

    context = fakeContext([], { "package.json": JSON.stringify({ devDependencies: { "@nestjs/common": "^9.0.0" } }) });
    expect(nestjsResolver.detect(context)).toBe(true);

    context = fakeContext([], { "package.json": JSON.stringify({ dependencies: { "express": "^4.17.1" } }) });
    expect(nestjsResolver.detect(context)).toBe(false);
  });

  it("extracts route nodes and function references for controllers", () => {
    const result = nestjsResolver.extract!("src/nestjs-app.ts", source);

    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "GET /users" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "GET /users/:id" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "POST /users/:id/posts" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "GET /health" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "ALL /" }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: "route", name: "DELETE /admin/:id" }));

    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "findAll", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "findOne", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "createPost", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "healthCheck", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "fallback", referenceKind: "function_ref" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "remove", referenceKind: "function_ref" }));

    // NestJS versioning declares three @Get() routes with the same name; the
    // handler in the signature keeps their node ids distinct (#102 review).
    const usersRoutes = result.nodes.filter((n) => n.name === "GET /users");
    expect(usersRoutes).toHaveLength(3);
    expect(new Set(usersRoutes.map((n) => n.id)).size).toBe(3);
    expect(usersRoutes.map((n) => n.signature).sort()).toEqual([
      "GET /users -> findAll",
      "GET /users -> listV1",
      "GET /users -> listV2",
    ]);
  });

  it("keeps commented-out decorators out of the route table", () => {
    const result = nestjsResolver.extract!("src/nestjs-app.ts", source);
    expect(result.nodes.some((n) => n.name.includes("legacy"))).toBe(false);
    expect(result.references.some((r) => r.referenceName === "legacyHandler")).toBe(false);
    // The unreadable controller's routes are skipped rather than guessed.
    expect(result.nodes.some((n) => n.name.endsWith("/probe"))).toBe(false);
  });

  it("binds the extracted route reference to its same-file handler", () => {
    const findAllHandler = node("method:findAll", "findAll");
    const healthCheckHandler = node("method:healthCheck", "healthCheck");
    const context = fakeContext([findAllHandler, healthCheckHandler]);

    const result = nestjsResolver.extract!("src/nestjs-app.ts", source);
    const findAllRef = result.references.find(r => r.referenceName === "findAll")!;
    const healthCheckRef = result.references.find(r => r.referenceName === "healthCheck")!;

    expect(nestjsResolver.resolve(findAllRef, context)).toMatchObject({
      targetNodeId: findAllHandler.id,
      confidence: 0.8,
      resolvedBy: "nestjs-route-handler",
    });

    expect(nestjsResolver.resolve(healthCheckRef, context)).toMatchObject({
      targetNodeId: healthCheckHandler.id,
      confidence: 0.8,
      resolvedBy: "nestjs-route-handler",
    });
  });

  it("resolves two same-named handlers across controllers via the owning class", () => {
    const usersFindAll = node("method:users-findAll", "findAll", "UsersController::findAll", "src/two-controllers.ts");
    const adminFindAll = node("method:admin-findAll", "findAll", "AdminController::findAll", "src/two-controllers.ts");
    const context = fakeContext([usersFindAll, adminFindAll]);

    const custom = [
      "@Controller('users')",
      "export class UsersController {",
      "  @Get()",
      "  findAll() {}",
      "}",
      "",
      "@Controller('admin')",
      "export class AdminController {",
      "  @Get()",
      "  findAll() {}",
      "}",
      "",
    ].join("\n");
    const result = nestjsResolver.extract!("src/two-controllers.ts", custom);
    expect(result.references).toHaveLength(2);

    const usersRef = result.references[0]!;
    expect(usersRef.candidates).toEqual(["UsersController::findAll"]);
    expect(nestjsResolver.resolve(usersRef, context)).toMatchObject({
      targetNodeId: usersFindAll.id,
      resolvedBy: "nestjs-route-handler",
    });

    const adminRef = result.references[1]!;
    expect(nestjsResolver.resolve(adminRef, context)).toMatchObject({
      targetNodeId: adminFindAll.id,
    });
  });

  it("reads the object-form controller path and skips unreadable ones", () => {
    const custom = [
      "@Controller({ path: 'users', version: '1' })",
      "export class UsersController {",
      "  @Get(':id')",
      "  findOne() {}",
      "}",
      "",
      "@Controller(ADMIN_PATH)",
      "export class UnreadableController {",
      "  @Get('probe')",
      "  probe() {}",
      "}",
      "",
      "@Controller('users')",
      "export class SecondUsersController {",
      "  @Get('again')",
      "  again() {}",
      "}",
      "",
    ].join("\n");
    const result = nestjsResolver.extract!("src/forms.ts", custom);

    // Object form with a `path` property contributes its prefix.
    expect(result.nodes).toContainEqual(expect.objectContaining({ name: "GET /users/:id" }));
    // A constant argument is not statically readable — its routes are skipped…
    expect(result.nodes.some((n) => n.name.endsWith("/probe"))).toBe(false);
    // …and a later controller resets the prefix instead of inheriting it.
    expect(result.nodes).toContainEqual(expect.objectContaining({ name: "GET /users/again" }));
  });

  it("does not let a string with a parenthesis break decorator scanning", () => {
    const custom = [
      "@Controller('users')",
      "export class UsersController {",
      "  @ApiOperation({ summary: 'List users :)' })",
      "  @Get()",
      "  findAll() {}",
      "}",
      "",
    ].join("\n");
    const result = nestjsResolver.extract!("src/smiley.ts", custom);
    expect(result.nodes).toContainEqual(expect.objectContaining({ name: "GET /users" }));
    expect(result.references).toContainEqual(expect.objectContaining({ referenceName: "findAll" }));
  });

  it("binds a decorator written on the same line as its method (#102 review r2)", () => {
    const custom = [
      "@Controller('users')",
      "export class UsersController {",
      "  @Get() list() { return []; }",
      "  @Get(':id') findOne(@Param('id') id: string) { return { id }; }",
      "}",
      "",
    ].join("\n");
    const result = nestjsResolver.extract!("src/inline.ts", custom);
    expect(result.nodes.map((node) => node.signature)).toEqual([
      "GET /users -> list",
      "GET /users/:id -> findOne",
    ]);
  });

  it("skips an object controller whose path is not a literal, trims slashes, and refuses interpolated templates", () => {
    const custom = [
      "@Controller({ path: USERS_PATH, version: '1' })",
      "export class UnreadableController {",
      "  @Get(':id')",
      "  findOne() {}",
      "}",
      "",
      "@Controller('/users/')",
      "export class SlashedController {",
      "  @Get('/:id/')",
      "  findOne() {}",
      "",
      "  @Get(`${BASE}/x`)",
      "  templated() {}",
      "}",
      "",
    ].join("\n");
    const result = nestjsResolver.extract!("src/edge.ts", custom);
    // { path: CONSTANT } behaves like the bare-constant form: routes skipped.
    expect(result.nodes.map((node) => node.name)).toEqual(["GET /users/:id"]);
  });

  it("leaves ambiguous references unresolved unless the owning class disambiguates", () => {
    const handler1 = node("method:1", "duplicateMethod");
    const handler2 = { ...node("method:2", "duplicateMethod"), startLine: 10 };
    const context = fakeContext([handler1, handler2]);

    const result = nestjsResolver.extract!("src/nestjs-app.ts", source);
    const fakeRef = { ...result.references[0]!, referenceName: "duplicateMethod" };
    expect(nestjsResolver.resolve(fakeRef, context)).toBeNull();

    // With the owning class recorded, the same ambiguity resolves.
    const owners = [
      { ...node("method:1", "duplicateMethod"), qualifiedName: "UsersController::duplicateMethod" },
      { ...node("method:2", "duplicateMethod"), qualifiedName: "AdminController::duplicateMethod" },
    ];
    const owningContext = fakeContext(owners);
    const usersScoped = { ...fakeRef, candidates: ["UsersController::duplicateMethod"] };
    expect(nestjsResolver.resolve(usersScoped, owningContext)).toMatchObject({ targetNodeId: owners[0]!.id });
  });

  it("leaves missing handlers unresolved", () => {
    const context = fakeContext([]);
    const result = nestjsResolver.extract!("src/nestjs-app.ts", source);
    const fakeRef = { ...result.references[0]!, referenceName: "missingMethod" };
    expect(nestjsResolver.resolve(fakeRef, context)).toBeNull();
  });
});

function node(id: string, name: string, qualifiedName = name, filePath = "src/nestjs-app.ts"): GraphNode {
  return { id, kind: "method", name, qualifiedName, filePath,
    language: "typescript", startLine: 1, endLine: 2, startColumn: 0, endColumn: 0, updatedAt: 0 };
}

function fakeContext(nodes: GraphNode[], files: Record<string, string> = {}): ResolutionContext {
  return {
    getNodesInFile: (path) => nodes.filter((entry) => entry.filePath === path),
    getNodesByName: (name) => nodes.filter((entry) => entry.name === name),
    getNodesByQualifiedName: (name) => nodes.filter((entry) => entry.qualifiedName === name),
    getNodesByKind: (kind) => nodes.filter((entry) => entry.kind === kind),
    getNodeById: (id) => nodes.find((entry) => entry.id === id) ?? null,
    fileExists: (path) => path in files,
    readFile: (path) => files[path] ?? null,
    getProjectRoot: () => "/repo",
    getAllFiles: () => Object.keys(files),
  };
}
