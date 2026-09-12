import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import { generateNodeId } from "../extraction/node-id.js";
import { deriveRoutePath, nextjsResolver } from "../resolution/frameworks/nextjs.js";
import { FRAMEWORK_RESOLVERS } from "../resolution/frameworks/index.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "../resolution/types.js";

const usersFixture = join(
  dirname(fileURLToPath(import.meta.url)), "fixtures", "nextjs-users-route.ts",
);
const itemsFixture = join(
  dirname(fileURLToPath(import.meta.url)), "fixtures", "nextjs-items-route.js",
);

describe("Next.js App Router resolver", () => {
  let usersNodes: GraphNode[];

  beforeAll(async () => {
    await loadGrammars(["typescript"]);
    const source = readFileSync(usersFixture, "utf-8");
    usersNodes = extractFile("app/api/users/[id]/route.ts", source, "typescript")!.nodes
      .map((node) => ({ ...node, updatedAt: 0 }));
  });

  it.each([
    ["the next dependency in package.json", { "package.json": '{"dependencies": {"next": "^15.0.0"}}' }, true],
    ["a route file in the tree without a manifest", { "app/x/route.ts": "export function GET() {}\n" }, true],
    ["no route files and no next dependency", { "src/index.ts": "export const x = 1;\n" }, false],
  ])("detects Next.js from %s", (_name, files, expected) => {
    expect(nextjsResolver.detect(fakeContext([], files))).toBe(expected);
  });

  it("derives route paths from both app/ and src/app/ roots", () => {
    expect(deriveRoutePath("app/api/users/route.ts")).toBe("/api/users");
    expect(deriveRoutePath("src/app/api/users/route.ts")).toBe("/api/users");
    expect(deriveRoutePath("app/route.ts")).toBe("/");
    expect(deriveRoutePath("app/(marketing)/pricing/route.ts")).toBe("/pricing");
    expect(deriveRoutePath("app/blog/[slug]/route.ts")).toBe("/blog/[slug]");
    expect(deriveRoutePath("app/docs/[...path]/route.ts")).toBe("/docs/[...path]");
  });

  it("locates the App Router root as a segment, not a substring (#179 review)", () => {
    expect(deriveRoutePath("apps/web/app/api/orders/route.ts")).toBe("/api/orders");
    expect(deriveRoutePath("packages/webapp/app/api/users/route.ts")).toBe("/api/users");
    expect(deriveRoutePath("apps/web/src/app/api/orders/route.ts")).toBe("/api/orders");
  });

  it("opts private folders and everything under them out of routing", () => {
    expect(deriveRoutePath("app/_lib/route.ts")).toBeNull();
    expect(deriveRoutePath("app/users/_components/route.ts")).toBeNull();
    expect(deriveRoutePath("app/_internal/api/route.ts")).toBeNull();
    expect(nextjsResolver.extract!("app/_lib/route.ts", "export function GET() {}\n"))
      .toEqual({ nodes: [], references: [] });
  });

  it("returns null for paths outside an App Router root", () => {
    expect(deriveRoutePath("pages/api/users.ts")).toBeNull();
    expect(deriveRoutePath("src/components/route.ts")).toBeNull();
    expect(deriveRoutePath("app/nested/page.tsx")).toBeNull();
  });

  it("emits at most one route node per method, so repeated declarations cannot collide (#179 review)", () => {
    const overloaded = [
      "export function GET(a: Request): Response;",
      "export function GET(a: Request, b: unknown): Response;",
      "export function GET(a: Request, b?: unknown): Response { return new Response(); }",
      "",
      "/*",
      "export function GET(stale: Request): Response { return new Response(); }",
      "*/",
    ].join("\n");

    const result = nextjsResolver.extract!("app/api/x/route.ts", overloaded);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.name).toBe("GET /api/x");
  });

  it("emits one route node per exported HTTP handler and references it", () => {
    const source = readFileSync(usersFixture, "utf-8");
    const result = nextjsResolver.extract!("app/api/users/[id]/route.ts", source);

    expect(result.nodes.map((node) => node.name)).toEqual([
      "GET /api/users/[id]",
      "POST /api/users/[id]",
    ]);
    for (const node of result.nodes) {
      expect(node).toMatchObject({ kind: "route", language: "typescript", filePath: "app/api/users/[id]/route.ts" });
      expect(node.id).toBe(generateNodeId(
        "app/api/users/[id]/route.ts", "route", node.name, node.name, "nextjs-route", node.signature,
      ));
    }
    expect(result.references.map((ref) => ref.referenceName)).toEqual(["GET", "POST"]);
    expect(result.references.map((ref) => ref.referenceKind)).toEqual(["function_ref", "function_ref"]);
  });

  it("handles typed arrow-function exports and javascript route files", () => {
    const custom = "export const GET: RouteHandler = async () => {\n  return new Response();\n};\n";
    const typed = nextjsResolver.extract!("app/typed/route.ts", custom);
    expect(typed.nodes.map((node) => node.name)).toEqual(["GET /typed"]);

    const source = readFileSync(itemsFixture, "utf-8");
    const result = nextjsResolver.extract!("app/items/route.js", source);
    expect(result.nodes.map((node) => node.name)).toEqual([
      "DELETE /items",
      "HEAD /items",
    ]);
    expect(result.references.map((ref) => ref.referenceName)).toEqual(["DELETE", "HEAD"]);
    expect(result.nodes.every((node) => node.language === "javascript")).toBe(true);
  });

  it("ignores non-route files and non-handler exports", () => {
    expect(nextjsResolver.extract!("app/page.tsx", "export default function Page() {}\n"))
      .toEqual({ nodes: [], references: [] });
    expect(nextjsResolver.extract!("lib/api.ts", "export async function GET() {}\n"))
      .toEqual({ nodes: [], references: [] });

    const result = nextjsResolver.extract!("app/api/users/[id]/route.ts", readFileSync(usersFixture, "utf-8"));
    expect(result.references.some((ref) => ref.referenceName === "helper")).toBe(false);
  });

  it("resolves the unambiguous same-file handler function", () => {
    const source = readFileSync(usersFixture, "utf-8");
    const result = nextjsResolver.extract!("app/api/users/[id]/route.ts", source);
    const context = fakeContext(usersNodes);

    const ref = result.references[0]!;
    const target = usersNodes.find((node) => node.name === "GET")!;
    expect(nextjsResolver.resolve(ref, context)).toMatchObject({
      targetNodeId: target.id,
      confidence: 0.8,
      resolvedBy: "nextjs-route-handler",
    });
  });

  it("leaves missing and ambiguous handlers unresolved", () => {
    const source = readFileSync(usersFixture, "utf-8");
    const result = nextjsResolver.extract!("app/api/users/[id]/route.ts", source);
    const ref = result.references[0]!;

    expect(nextjsResolver.resolve(ref, fakeContext([]))).toBeNull();

    const first = node("function:first", "GET");
    const second = node("method:second", "GET", "method");
    expect(nextjsResolver.resolve(ref, fakeContext([first, second]))).toBeNull();
  });

  it("is registered in the framework registry", () => {
    expect(FRAMEWORK_RESOLVERS).toContain(nextjsResolver);
  });
});

function node(
  id: string,
  name: string,
  kind: "function" | "method" = "function",
): GraphNode {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath: "app/api/users/[id]/route.ts",
    language: "typescript",
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
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
