import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import { generateNodeId } from "../extraction/node-id.js";
import { fastAPIResolver } from "../resolution/frameworks/fastapi.js";
import { FRAMEWORK_RESOLVERS } from "../resolution/frameworks/index.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "../resolution/types.js";

const FILE_PATH = "src/fastapi-app.py";
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fastapi-app.py");
const source = readFileSync(fixturePath, "utf-8");

describe("FastAPI framework resolver", () => {
  let pythonNodes: GraphNode[];

  beforeAll(async () => {
    await loadGrammars(["python"]);
    pythonNodes = extractFile(FILE_PATH, source, "python")!.nodes.map((node) => ({
      ...node,
      updatedAt: 0,
    }));
  });

  it.each([
    ["pyproject project dependencies", { "pyproject.toml": "[project]\ndependencies = [\"fastapi>=0.115\"]\n" }],
    ["Poetry dependencies", { "pyproject.toml": "[tool.poetry.dependencies]\nfastapi = \"^0.115\"\n" }],
    ["requirements file", { "requirements-dev.txt": "pytest==8.0\nfastapi[standard]>=0.115\n" }],
  ])("detects FastAPI from %s", (_name, files) => {
    expect(fastAPIResolver.detect(fakeContext([], files))).toBe(true);
  });

  it("does not detect similarly named or unrelated dependencies", () => {
    const context = fakeContext([], {
      "pyproject.toml": "[project]\ndependencies = [\"flask\"]\n",
      "requirements.txt": "fastapi-utils==0.8.0\n",
    });
    expect(fastAPIResolver.detect(context)).toBe(false);
  });

  it("extracts stable route nodes and endpoint references", () => {
    const result = fastAPIResolver.extract!(FILE_PATH, source);
    const expectedRoutes = [
      "GET /health",
      "POST /users/{user_id}",
      "PATCH /users/{user_id}",
      "PUT /users/{user_id}",
      "OPTIONS /users",
      "HEAD /users",
      "DELETE /admin/{user_id}",
    ];

    expect(result.nodes.map((node) => node.name)).toEqual(expectedRoutes);
    for (const node of result.nodes) {
      expect(node).toMatchObject({ kind: "route", language: "python", filePath: FILE_PATH });
      expect(node.id).toBe(generateNodeId(FILE_PATH, "route", node.name));
    }
    expect(result.references.map((ref) => [ref.referenceName, ref.referenceKind])).toEqual([
      ["health", "function_ref"],
      ["update_user", "function_ref"],
      ["update_user", "function_ref"],
      ["replace_user", "function_ref"],
      ["inspect_users", "function_ref"],
      ["inspect_users", "function_ref"],
      ["delete_user", "function_ref"],
    ]);
  });

  it("recognizes custom instance names and skips dynamic or unrelated routes", () => {
    const customSource = [
      "api = FastAPI()",
      "client = HttpClient()",
      "route_path = '/dynamic'",
      "@api.get('/ready')",
      "def ready(): pass",
      "@client.get('/external')",
      "def external(): pass",
      "@api.get(route_path)",
      "def dynamic(): pass",
      "",
    ].join("\n");

    const result = fastAPIResolver.extract!("src/custom.py", customSource);
    expect(result.nodes).toMatchObject([{ kind: "route", name: "GET /ready" }]);
    expect(result.references).toMatchObject([{ referenceName: "ready" }]);
  });

  it("resolves unambiguous same-file functions and methods", () => {
    const result = fastAPIResolver.extract!(FILE_PATH, source);
    const context = fakeContext(pythonNodes);

    for (const endpoint of ["health", "update_user", "delete_user"]) {
      const ref = result.references.find((entry) => entry.referenceName === endpoint)!;
      const target = pythonNodes.find((node) => node.name === endpoint)!;
      expect(fastAPIResolver.resolve(ref, context)).toMatchObject({
        targetNodeId: target.id,
        confidence: 1,
        resolvedBy: "framework",
      });
    }
  });

  it("leaves missing, cross-file-only, and ambiguous endpoints unresolved", () => {
    const ref = fastAPIResolver.extract!(FILE_PATH, source).references[0]!;
    const crossFile = node("function:cross-file", "health", "src/other.py");
    expect(fastAPIResolver.resolve(ref, fakeContext([crossFile]))).toBeNull();
    expect(fastAPIResolver.resolve(ref, fakeContext([]))).toBeNull();

    const sameFile = node("function:same-file", "health", FILE_PATH);
    const duplicate = node("method:duplicate", "health", FILE_PATH, "method");
    expect(fastAPIResolver.resolve(ref, fakeContext([sameFile, duplicate]))).toBeNull();
  });

  it("ignores non-Python files and is registered", () => {
    expect(fastAPIResolver.extract!("src/app.ts", "@app.get('/health')\ndef health(): pass"))
      .toEqual({ nodes: [], references: [] });
    expect(FRAMEWORK_RESOLVERS).toContain(fastAPIResolver);
  });
});

function node(
  id: string,
  name: string,
  filePath: string,
  kind: "function" | "method" = "function",
): GraphNode {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: "python",
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
