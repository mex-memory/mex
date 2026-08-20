import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTypeScriptExtraction,
  canonicalCompilerIdentity,
  discoverTypeScriptProjects,
  normalizedCompilerTokens,
} from "../extraction/compiler.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mex-compiler-extraction-"));
  temporaryRoots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, source, "utf8");
  }
  return root;
}

function mainFixture(): { root: string; candidates: string[] } {
  const root = project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@lib/*": ["src/lib/*"] },
        strict: true,
        skipLibCheck: true,
      },
      include: ["src/**/*.ts"],
      references: [{ path: "packages/child" }],
    }),
    "packages/child/tsconfig.json": JSON.stringify({
      compilerOptions: { composite: true, target: "ES2022", module: "ESNext" },
      include: ["src/**/*.ts"],
    }),
    "packages/child/src/child.ts": "export const child = 1;\n",
    "src/lib/base.ts": [
      "export class Base {",
      "  protected baseRun(): string { return 'base'; }",
      "}",
      "",
    ].join("\n"),
    "src/helper.ts": "export function duplicate(): void {}\n",
    "src/use.ts": "import { duplicate } from './helper'; export function use(): void { duplicate(); }\n",
    "test/helper.test.ts": "export function duplicate(): void {}\n",
    "src/service.ts": [
      "import { Base as Parent } from '@lib/base';",
      "export class Alpha extends Parent {",
      "  private same(value: string): string;",
      "  private same(value: number): number;",
      "  private same(value: string | number): string | number { return value; }",
      "  execute(): string { return this.same('ok'); }",
      "}",
      "export class Beta { same(): string { return 'beta'; } }",
      "export function invoke(callback: () => void): void { callback(); }",
      "export function helper(): void {}",
      "export function boot(): void { invoke(() => helper()); }",
      "interface First { act(): void }",
      "interface Second { act(): void }",
      "export function dispatch(value: First | Second): void { value.act(); }",
      "",
    ].join("\n"),
    // Outside the configured include: this must be owned by one inferred program.
    "loose.js": "export function loose() { return 1 }\n",
  });
  return {
    root,
    candidates: [
      "src/lib/base.ts",
      "src/service.ts",
      "src/helper.ts",
      "src/use.ts",
      "test/helper.test.ts",
      "packages/child/src/child.ts",
      "loose.js",
    ],
  };
}

describe("TypeScript compiler extraction", () => {
  it("discovers configs, project references, and one inferred program for uncovered files", () => {
    const { root, candidates } = mainFixture();
    const discovered = discoverTypeScriptProjects(root, candidates);
    expect(discovered.map((entry) => entry.configPath)).toEqual([
      "packages/child/tsconfig.json",
      "tsconfig.json",
    ]);
    expect(discovered.find((entry) => entry.configPath === "tsconfig.json")?.projectReferences)
      .toEqual(["packages/child/tsconfig.json"]);

    const result = buildTypeScriptExtraction(root, candidates);
    expect(result.compilerVersion).toBe("5.9.3");
    expect(result.projects.filter((entry) => entry.id === "inferred")).toHaveLength(1);
    expect(result.files.find((entry) => entry.filePath === "loose.js")?.projectId).toBe("inferred");
  });

  it("uses container-qualified canonical ids and coalesces overload declarations", () => {
    const { root, candidates } = mainFixture();
    const result = buildTypeScriptExtraction(root, candidates);
    const file = result.files.find((entry) => entry.filePath === "src/service.ts")!;
    const alphaSame = file.nodes.find((node) => node.qualifiedName === "Alpha::same")!;
    const betaSame = file.nodes.find((node) => node.qualifiedName === "Beta::same")!;

    expect(alphaSame.id).not.toBe(betaSame.id);
    expect(alphaSame.containerId).toBe(file.nodes.find((node) => node.name === "Alpha")?.id);
    expect(alphaSame.visibility).toBe("private");
    expect(alphaSame.declarationSpans).toHaveLength(3);
    expect(file.nodes.filter((node) => node.qualifiedName === "Alpha::same")).toHaveLength(1);
  });

  it("resolves aliases, paths, inheritance, signatures, and proven callback wiring", () => {
    const { root, candidates } = mainFixture();
    const result = buildTypeScriptExtraction(root, candidates);
    const service = result.files.find((entry) => entry.filePath === "src/service.ts")!;
    const base = result.files.find((entry) => entry.filePath === "src/lib/base.ts")!
      .nodes.find((node) => node.name === "Base")!;
    const alpha = service.nodes.find((node) => node.name === "Alpha")!;
    const alphaSame = service.nodes.find((node) => node.qualifiedName === "Alpha::same")!;
    const invoke = service.nodes.find((node) => node.name === "invoke")!;
    const callback = service.nodes.find((node) => node.declarationRole === "callback-argument:invoke:0")!;

    expect(service.importBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        localName: "Parent",
        importedName: "Base",
        resolvedFilePath: "src/lib/base.ts",
        targetId: base.id,
        confidence: 1,
      }),
    ]));
    expect(service.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: alpha.id, targetId: base.id, kind: "extends", confidence: 1 }),
      expect.objectContaining({ targetId: alphaSame.id, kind: "calls", confidence: 1 }),
      expect.objectContaining({
        sourceId: invoke.id,
        targetId: callback.id,
        kind: "calls",
        confidence: 0.85,
        resolutionMethod: "typescript-callback-parameter",
      }),
    ]));
    const ambiguous = service.references.find((reference) => reference.targetName === "act" && reference.kind === "calls")!;
    expect(ambiguous).toMatchObject({
      status: "ambiguous",
      targetId: undefined,
      confidence: 0.75,
    });
    expect(ambiguous.candidates).toHaveLength(2);
  });

  it("keeps identities stable across line shifts and candidate ordering", () => {
    const { root, candidates } = mainFixture();
    const before = buildTypeScriptExtraction(root, candidates);
    const servicePath = join(root, "src/service.ts");
    const original = before.files.find((entry) => entry.filePath === "src/service.ts")!;
    writeFileSync(servicePath, `// shifted\n// twice\n${readFileSync(servicePath, "utf8")}`, "utf8");
    const after = buildTypeScriptExtraction(root, [...candidates].reverse());

    const ids = (file: typeof original) => Object.fromEntries(
      file.nodes
        .map((node) => [node.qualifiedName, node.id]),
    );
    expect(ids(after.files.find((entry) => entry.filePath === "src/service.ts")!)).toEqual(ids(original));
    expect(after.files.map((file) => file.filePath)).toEqual([...before.files.map((file) => file.filePath)].sort());
  });

  it("does not bind a production call to a same-named test symbol or duplicate a callsite", () => {
    const { root, candidates } = mainFixture();
    const result = buildTypeScriptExtraction(root, candidates);
    const productionTarget = result.files.find((file) => file.filePath === "src/helper.ts")!
      .nodes.find((node) => node.name === "duplicate")!;
    const testTarget = result.files.find((file) => file.filePath === "test/helper.test.ts")!
      .nodes.find((node) => node.name === "duplicate")!;
    const useFile = result.files.find((file) => file.filePath === "src/use.ts")!;
    const call = useFile.references.find((reference) => reference.kind === "calls" && reference.targetName === "duplicate")!;

    expect(call.targetId).toBe(productionTarget.id);
    expect(call.targetId).not.toBe(testTarget.id);

    const semanticKeys = result.files.flatMap((file) => file.references)
      .filter((reference) => reference.targetId)
      .map((reference) => [reference.sourceId, reference.targetId, reference.kind, reference.line, reference.column].join(":"));
    expect(new Set(semanticKeys).size).toBe(semanticKeys.length);
  });

  it("does not map excess callback arguments onto an ordinary final parameter", () => {
    const root = project({
      "callbacks.ts": [
        "export function invoke(callback: () => void): void { callback(); }",
        "export function invokeFirst(...callbacks: Array<() => void>): void { callbacks[0](); }",
        "export function real(): void {}",
        "export function decoy(): void {}",
        "export function boot(): void {",
        "  invoke(real, decoy);",
        "  invokeFirst(real, decoy);",
        "}",
        "",
      ].join("\n"),
    });
    const file = buildTypeScriptExtraction(root, ["callbacks.ts"]).files[0]!;
    const invoke = file.nodes.find((node) => node.name === "invoke")!;
    const invokeFirst = file.nodes.find((node) => node.name === "invokeFirst")!;
    const real = file.nodes.find((node) => node.name === "real")!;
    const decoy = file.nodes.find((node) => node.name === "decoy")!;
    const synthesizedTargets = (sourceId: string): string[] => file.references
      .filter((reference) => reference.sourceId === sourceId && reference.provenance === "callback-synthesis")
      .map((reference) => reference.targetId!);

    expect(synthesizedTargets(invoke.id)).toEqual([real.id]);
    // A real rest parameter is handled per element: only callbacks[0]() is
    // proven, so the second actual argument cannot acquire a traversable edge.
    expect(synthesizedTargets(invokeFirst.id)).toEqual([real.id]);
    expect(synthesizedTargets(invoke.id)).not.toContain(decoy.id);
    expect(synthesizedTargets(invokeFirst.id)).not.toContain(decoy.id);
  });

  it("reports partial syntax health and excludes only intersecting declarations", () => {
    const root = project({
      "broken.ts": [
        "export function sound(): number { return 1; }",
        "export function broken(): number { return @@@; }",
        "export function alsoSound(): number { return 2; }",
      ].join("\n"),
    });
    const result = buildTypeScriptExtraction(root, ["broken.ts"]);
    const file = result.files[0];
    expect(file.health.status).toBe("partial");
    expect(file.health.syntacticDiagnosticCount).toBeGreaterThan(0);
    expect(file.health.diagnosticByteCoverage).toBeLessThanOrEqual(0.25);
    expect(file.nodes.some((node) => node.name === "sound")).toBe(true);
    expect(file.nodes.some((node) => node.name === "alsoSound")).toBe(true);
    expect(file.nodes.some((node) => node.name === "broken")).toBe(false);
    expect(file.health.excludedDeclarationCount).toBeGreaterThan(0);
  });

  it("indexes the Hono Context response-construction regression symbols and call edge", () => {
    const root = project({
      "src/context.ts": [
        "type Data = BodyInit | string;",
        "type StatusCode = number;",
        "type HeaderRecord = Record<string, string>;",
        "type ResponseOrInit = { headers?: HeadersInit; status?: StatusCode } | Response;",
        "const createResponseInstance = (body?: BodyInit | null, init?: ResponseInit): Response => new Response(body, init);",
        "export class Context<E = unknown> {",
        "  #preparedHeaders: Headers | undefined;",
        "  #status: StatusCode = 200;",
        "  #newResponse(data: Data | null, arg?: StatusCode | ResponseOrInit, headers?: HeaderRecord): Response {",
        "    const status = typeof arg === 'number' ? arg : (arg?.status ?? this.#status);",
        "    return createResponseInstance(data, { status, headers: this.#preparedHeaders ?? headers });",
        "  }",
        "  newResponse = (...args: Parameters<Context['newResponse']>): Response => this.#newResponse(...args);",
        "}",
        "",
      ].join("\n"),
    });
    const result = buildTypeScriptExtraction(root, ["src/context.ts"]);
    const file = result.files[0]!;
    const context = file.nodes.find((node) => node.name === "Context")!;
    const privateResponse = file.nodes.find((node) => node.name === "#newResponse")!;
    const responseFactory = file.nodes.find((node) => node.name === "createResponseInstance")!;

    expect(file.health.status).toBe("ok");
    expect(context.kind).toBe("class");
    expect(privateResponse).toMatchObject({ kind: "method", qualifiedName: "Context::#newResponse" });
    // Arrow-function bindings are callable symbols in the compiler graph.
    expect(responseFactory.kind).toBe("function");
    expect(file.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: privateResponse.id,
        targetId: responseFactory.id,
        kind: "calls",
        provenance: "typescript-compiler",
      }),
    ]));
  });

  it("makes the canonical identity independent of source positions", () => {
    const input = {
      filePath: "src/service.ts",
      kind: "method" as const,
      qualifiedName: "Alpha::same",
      declarationRole: "method",
      signature: "(value: string): string",
    };
    expect(canonicalCompilerIdentity(input)).toBe(canonicalCompilerIdentity(input));
    expect(canonicalCompilerIdentity(input)).not.toContain("line");
  });

  it("normalizes compiler fingerprint tokens without identifier or literal spellings", () => {
    const source = [
      "export function alpha(value: string): string { return value + 'one'; }",
      "export function beta(input: string): string { return input + 'two'; }",
    ].join("\n");
    const root = project({ "tokens.ts": source });
    const file = buildTypeScriptExtraction(root, ["tokens.ts"]).files[0];
    const alpha = file.nodes.find((node) => node.name === "alpha")!;
    const beta = file.nodes.find((node) => node.name === "beta")!;
    const tokens = normalizedCompilerTokens(source, [alpha, beta]);

    expect(tokens.get(alpha.id)).toEqual(tokens.get(beta.id));
    expect(tokens.get(alpha.id)).toContain("FunctionKeyword");
    expect(tokens.get(alpha.id)).toContain("Identifier");
    expect(tokens.get(alpha.id)).toContain("StringLiteral");
    expect(tokens.get(alpha.id)).not.toContain("alpha");
    expect(tokens.get(alpha.id)).not.toContain("one");
  });
});
