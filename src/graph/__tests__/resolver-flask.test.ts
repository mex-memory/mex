import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import { flaskResolver } from "../resolution/frameworks/flask.js";
import { FRAMEWORK_RESOLVERS } from "../resolution/frameworks/index.js";
import type { GraphNode } from "../types.js";
import type { ResolutionContext } from "../resolution/types.js";

const FILE_PATH = "src/flask-app.py";
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "flask-app.py");
const source = readFileSync(fixturePath, "utf-8");

describe("Flask framework resolver", () => {
  let pythonNodes: GraphNode[];

  beforeAll(async () => {
    await loadGrammars(["python"]);
    pythonNodes = extractFile(FILE_PATH, source, "python")!.nodes.map((node) => ({
      ...node,
      updatedAt: 0,
    }));
  });

  it.each([
    ["a from-import of the app class", { "src/app.py": "from flask import Flask\napp = Flask(__name__)\n" }],
    ["a plain module import", { "src/app.py": "import flask\n\napp = flask.Flask(__name__)\n" }],
    ["a submodule import", { "src/views.py": "from flask.views import View\n" }],
  ])("detects Flask from %s", (_name, files) => {
    expect(flaskResolver.detect(fakeContext([], files))).toBe(true);
  });

  it("does not detect similarly named packages or unrelated Python", () => {
    const context = fakeContext([], {
      "src/app.py": "import flask_restful\nfrom flask_restful import Api\n",
      "src/other.py": "from fastapi import FastAPI\n",
    });
    expect(flaskResolver.detect(context)).toBe(false);
  });

  it("extracts stable route nodes with converters preserved and methods fanned out", () => {
    const result = flaskResolver.extract!(FILE_PATH, source);

    expect(result.nodes.map((node) => node.name)).toEqual([
      "GET /health",
      "POST /users/<int:user_id>",
      "PUT /users/<int:user_id>",
      "GET /ready",
      "DELETE /settings",
      "POST /settings",
      "GET /cache",
      "GET /probe",
      "GET /admin/settings",
    ]);
    for (const node of result.nodes) {
      expect(node).toMatchObject({ kind: "route", language: "python", filePath: FILE_PATH });
      expect(node.id.startsWith("route:")).toBe(true);
    }
    expect(result.references.map((ref) => [ref.referenceName, ref.referenceKind])).toEqual([
      ["health", "function_ref"],
      ["replace_user", "function_ref"],
      ["replace_user", "function_ref"],
      ["ready", "function_ref"],
      ["delete_settings", "function_ref"],
      ["create_settings", "function_ref"],
      ["clear_cache", "function_ref"],
      ["probe", "function_ref"],
      ["admin_settings", "function_ref"],
    ]);
  });

  it("gives a route declared twice in one file distinct ids (#177 review)", () => {
    const custom = [
      "import os",
      "from flask import Flask",
      "app = Flask(__name__)",
      "if os.environ.get('DEBUG'):",
      "    @app.route('/debug')",
      "    def debug_on():",
      "        return 'on'",
      "else:",
      "    @app.route('/debug')",
      "    def debug_off():",
      "        return 'off'",
      "",
    ].join("\n");
    const result = flaskResolver.extract!("src/conditional.py", custom);
    expect(result.nodes.map((node) => node.name)).toEqual(["GET /debug", "GET /debug"]);
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(2);
  });

  it("ignores a route decorator shown inside a docstring example (#177 review)", () => {
    const custom = [
      "from flask import Flask",
      "app = Flask(__name__)",
      "",
      "def documented():",
      '    """Example usage:',
      "",
      "    @app.route('/example')",
      "    def example():",
      "        ...",
      '    """',
      "    return 1",
      "",
      "@app.route('/real')",
      "def real():",
      "    return 2",
      "",
    ].join("\n");
    const result = flaskResolver.extract!("src/docstring.py", custom);
    expect(result.nodes.map((node) => node.name)).toEqual(["GET /real"]);
  });

  it("accepts tuple methods, skips unreadable ones, and refuses interpolated paths (#177 review)", () => {
    const custom = [
      "from flask import Flask",
      "app = Flask(__name__)",
      "ALLOWED = ['GET', 'POST']",
      "",
      '@app.route("/login", methods=("GET", "POST"))',
      "def login():",
      "    return 1",
      "",
      '@app.route("/items", methods=ALLOWED)',
      "def items():",
      "    return 2",
      "",
      '@app.route(f"/users/{1}")',
      "def dynamic():",
      "    return 3",
      "",
    ].join("\n");
    const result = flaskResolver.extract!("src/methods.py", custom);
    // Tuple fan-out emits both methods; the variable methods= and the
    // f-string path skip rather than guess.
    expect(result.nodes.map((node) => node.name)).toEqual(["GET /login", "POST /login"]);
  });

  it("treats imported app/blueprint names as receivers (#177 review)", () => {
    const views = [
      "from myapp.auth import bp",
      "from myapp import app",
      "",
      '@bp.route("/login", methods=["GET", "POST"])',
      "def login():",
      "    return 1",
      "",
      "@app.get('/status')",
      "def status():",
      "    return 2",
      "",
    ].join("\n");
    const result = flaskResolver.extract!("src/views.py", views);
    expect(result.nodes.map((node) => node.name)).toEqual([
      "GET /login",
      "POST /login",
      "GET /status",
    ]);
  });

  it("recognizes flask.Flask assignment, type annotations, and multi-line decorators (#177 review)", () => {
    const custom = [
      "import flask",
      "app = flask.Flask(__name__)",
      "api: flask.Blueprint = flask.Blueprint('api', __name__, url_prefix='/api')",
      "",
      "@api.route(",
      '    "/users/<int:user_id>",',
      '    methods=["GET", "POST"],',
      ")",
      "def users(user_id):",
      "    return 1",
      "",
    ].join("\n");
    const result = flaskResolver.extract!("src/blueprint.py", custom);
    expect(result.nodes.map((node) => node.name)).toEqual([
      "GET /api/users/<int:user_id>",
      "POST /api/users/<int:user_id>",
    ]);
  });

  it("recognizes custom instance names and skips foreign receivers and dynamic paths", () => {
    const customSource = [
      "api = Flask(__name__)",
      "client = HttpClient()",
      "route_path = '/dynamic'",
      "@api.get('/ready')",
      "def ready(): pass",
      "@client.get('/external')",
      "def external(): pass",
      "@api.route(route_path)",
      "def dynamic(): pass",
      "",
    ].join("\n");

    const result = flaskResolver.extract!("src/custom.py", customSource);
    expect(result.nodes).toMatchObject([{ kind: "route", name: "GET /ready" }]);
    expect(result.references).toMatchObject([{ referenceName: "ready" }]);
  });

  it("resolves unambiguous same-file functions and methods", () => {
    const result = flaskResolver.extract!(FILE_PATH, source);
    const context = fakeContext(pythonNodes);

    for (const handler of ["health", "replace_user", "clear_cache", "probe"]) {
      const ref = result.references.find((entry) => entry.referenceName === handler)!;
      const target = pythonNodes.find((node) => node.name === handler)!;
      expect(flaskResolver.resolve(ref, context)).toMatchObject({
        targetNodeId: target.id,
        confidence: 0.8,
        resolvedBy: "flask-route-handler",
      });
    }
  });

  it("leaves missing, cross-file-only, and ambiguous handlers unresolved", () => {
    const result = flaskResolver.extract!(FILE_PATH, source).references[0]!;
    const crossFile = node("function:cross-file", "health", "src/other.py");
    expect(flaskResolver.resolve(result, fakeContext([crossFile]))).toBeNull();
    expect(flaskResolver.resolve(result, fakeContext([]))).toBeNull();

    const sameFile = node("function:same-file", "health", FILE_PATH);
    const duplicate = node("method:duplicate", "health", FILE_PATH, "method");
    expect(flaskResolver.resolve(result, fakeContext([sameFile, duplicate]))).toBeNull();
  });

  it("ignores non-Python files and is registered", () => {
    expect(flaskResolver.extract!("src/app.ts", "@app.get('/health')\ndef health(): pass"))
      .toEqual({ nodes: [], references: [] });
    expect(FRAMEWORK_RESOLVERS).toContain(flaskResolver);
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
