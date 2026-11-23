import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { graphEngineBinary, type EngineStagedFile } from "../native-engine.js";
import { stageEcmaScript } from "./engine-stage-fixture.js";

const engine = graphEngineBinary();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mex-engine-extraction-"));
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
    // Outside the configured include: still indexed as a source file.
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

/** Signatures and identities must be checkout-independent across imports. */
function crossModuleTypeFixture(): Record<string, string> {
  return {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
      include: ["src/**/*.ts"],
    }),
    "node_modules/ext-pkg/package.json": JSON.stringify({ name: "ext-pkg", types: "index.d.ts" }),
    "node_modules/ext-pkg/index.d.ts": [
      "export interface Handle { id: number }",
      "export declare function open(): Handle;",
      "",
    ].join("\n"),
    "src/jsx/base.ts": [
      "export namespace JSX { export interface Element { tag: string } }",
      "export function element(): JSX.Element { return { tag: 'div' }; }",
      "export interface Fragment { children: string[] }",
      "export interface Portal { target: string }",
      "export interface Slot { name: string }",
      "export interface Text { value: string }",
      "export const defineHelper = () => (",
      "  fragment: Fragment,",
      "  portal: Portal,",
      "  events: (slot: Slot) => Omit<Text, 'value'> | Promise<Omit<Text, 'value'>>,",
      ") => events({ name: fragment.children.join(portal.target) });",
      "",
    ].join("\n"),
    "src/page.ts": [
      "import { defineHelper, element } from './jsx/base';",
      "export const buildPage = () => element;",
      "export function render() { return element(); }",
      "export const pick = defineHelper();",
      "",
    ].join("\n"),
    "src/ext.ts": [
      "import { open } from 'ext-pkg';",
      "export const openHandle = () => open();",
      "",
    ].join("\n"),
  };
}

function identitySurface(result: { files: EngineStagedFile[] }): unknown {
  return result.files.map((file) => ({
    path: file.path,
    nodes: file.nodes.map((node) => [node.id, node.qualifiedName, node.signature, node.returnType]),
    edges: file.edges,
  }));
}

const extract = (root: string, paths: string[]) => stageEcmaScript(engine!, root, paths);

describe.skipIf(!engine)("ECMAScript extraction", async () => {
  it("names property-assigned functions and attributes their own calls to that symbol", async () => {
    const root = project({
      "application.js": [
        "const app = {};",
        "function initialize() {}",
        "app.init = function () { initialize(); };",
        "app['handle'] = () => initialize();",
        "function boot() { app.init(); app.handle(); }",
        "app.recur = function named() { named(); };",
        "",
      ].join("\n"),
    });
    const file = (await extract(root, ["application.js"])).files[0]!;
    const init = file.nodes.find((node) => node.name === "app.init")!;
    const handle = file.nodes.find((node) => node.name === "app.handle")!;
    const initialize = file.nodes.find((node) => node.name === "initialize")!;
    const boot = file.nodes.find((node) => node.name === "boot")!;
    const recur = file.nodes.find((node) => node.name === "app.recur")!;
    expect(init).toMatchObject({ kind: "function", startLine: 3 });
    expect(handle).toMatchObject({ kind: "function", startLine: 4 });
    expect(file.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: init.id, target: initialize.id, kind: "calls" }),
      expect.objectContaining({ source: handle.id, target: initialize.id, kind: "calls" }),
      expect.objectContaining({ source: recur.id, target: recur.id, kind: "calls" }),
    ]));
    expect(file.unresolved.filter(ref => ref.fromNodeId === boot.id && ref.referenceKind === "calls"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ referenceName: "init", status: "unresolved" }),
        expect.objectContaining({ referenceName: "handle", status: "unresolved" }),
      ]));
    expect(file.nodes.some((node) => node.name === "<callback:BinaryExpression>")).toBe(false);
  });

  it("keeps dynamic assignment targets anonymous", async () => {
    const root = project({ "application.js": "const app = {}; let key = 'init'; app[key] = function () {};\n" });
    const file = (await extract(root, ["application.js"])).files[0]!;
    expect(file.nodes.some((node) => node.identityKey?.split("\0").includes("function-assignment"))).toBe(false);
  });

  it("keeps factory calls with the factory while a returned closure owns its own calls", async () => {
    const root = project({
      "factory.js": [
        "function initialize() {}",
        "function mixin(target, source) {}",
        "const proto = {};",
        "export function createApplication() {",
        "  const app = function () { initialize(); };",
        "  mixin(app, proto);",
        "  initialize();",
        "  return app;",
        "}",
        "",
      ].join("\n"),
    });
    const file = (await extract(root, ["factory.js"])).files[0]!;
    const factory = file.nodes.find((node) => node.name === "createApplication")!;
    const app = file.nodes.find((node) => node.qualifiedName === "createApplication::app")!;
    const initialize = file.nodes.find((node) => node.name === "initialize")!;
    const mixin = file.nodes.find((node) => node.name === "mixin")!;
    expect(file.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: factory.id, target: mixin.id, kind: "calls", line: 6 }),
      expect.objectContaining({ source: factory.id, target: initialize.id, kind: "calls", line: 7 }),
      expect.objectContaining({ source: app.id, target: initialize.id, kind: "calls", line: 5 }),
    ]));
  });

  it("renders accessors nested in type literals without failing the extraction", async () => {
    // A getter in a getter's type made the canonical rewrite throw
    // "Lexical environment is suspended", which failed a whole repository build.
    const root = project({
      "settings.ts": [
        "export type Nested = { get inner(): { get value(): string | number } };",
        "export function read(source: { get inner(): { get value(): string | number } }): Nested {",
        "  return source;",
        "}",
        "",
      ].join("\n"),
    });
    const file = (await extract(root, ["settings.ts"])).files[0]!;
    expect(file.nodes.find((node) => node.name === "read")).toBeDefined();
  });

  it("preserves symbol and reference identity across LF and CRLF checkouts", async () => {
    const source = [
      "export function helper() {}",
      "export function invoke(callback: () => void) { callback(); }",
      "export function run() {",
      "  invoke(",
      "    () => helper()",
      "  );",
      "}",
      "",
    ].join("\n");
    const lf = project({ "module.ts": source });
    const crlf = project({ "module.ts": source.replace(/\n/gu, "\r\n") });
    expect(identitySurface(await extract(crlf, ["module.ts"])))
      .toEqual(identitySurface(await extract(lf, ["module.ts"])));
  });

  it("indexes both configured projects and JavaScript outside the configured include", async () => {
    const { root, candidates } = mainFixture();
    const result = await extract(root, candidates);
    expect(result.files.map((file) => file.path).sort()).toEqual([...candidates].sort());
  });

  it("uses container-qualified canonical ids and coalesces overload declarations", async () => {
    const { root, candidates } = mainFixture();
    const result = await extract(root, candidates);
    const file = result.files.find((entry) => entry.path === "src/service.ts")!;
    const alphaSame = file.nodes.find((node) => node.qualifiedName === "Alpha::same")!;
    const betaSame = file.nodes.find((node) => node.qualifiedName === "Beta::same")!;

    expect(alphaSame.id).not.toBe(betaSame.id);
    expect(alphaSame.containerId).toBe(file.nodes.find((node) => node.name === "Alpha")?.id);
    expect(alphaSame.visibility).toBe("private");
    expect(alphaSame).toMatchObject({ startLine: 3, endLine: 5 });
    expect(file.nodes.filter((node) => node.qualifiedName === "Alpha::same")).toHaveLength(1);
  });

  it("resolves aliases, paths, inheritance, signatures, and proven callback wiring", async () => {
    const { root, candidates } = mainFixture();
    const result = await extract(root, candidates);
    const service = result.files.find((entry) => entry.path === "src/service.ts")!;
    const base = result.files.find((entry) => entry.path === "src/lib/base.ts")!
      .nodes.find((node) => node.name === "Base")!;
    const alpha = service.nodes.find((node) => node.name === "Alpha")!;
    const alphaSame = service.nodes.find((node) => node.qualifiedName === "Alpha::same")!;
    const invoke = service.nodes.find((node) => node.name === "invoke")!;
    const callback = service.nodes.find((node) => node.identityKey?.split("\0").includes("callback-argument:invoke:0"))!;

    expect(service.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        localName: "Parent",
        importedName: "Base",
        resolvedFilePath: "src/lib/base.ts",
        targetId: base.id,
      }),
    ]));
    expect(service.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: alpha.id, target: base.id, kind: "extends", confidence: 1 }),
      expect.objectContaining({ target: alphaSame.id, kind: "calls", confidence: 1 }),
      expect.objectContaining({
        source: invoke.id,
        target: callback.id,
        kind: "calls",
        confidence: 0.85,
        resolutionMethod: "engine-ecmascript",
      }),
    ]));
    expect(service.unresolved).toContainEqual(expect.objectContaining({
      referenceName: "act", referenceKind: "calls", status: "unresolved", confidence: 0,
    }));
  });

  it("keeps identities stable across line shifts and candidate ordering", async () => {
    const { root, candidates } = mainFixture();
    const before = await extract(root, candidates);
    const servicePath = join(root, "src/service.ts");
    const original = before.files.find((entry) => entry.path === "src/service.ts")!;
    writeFileSync(servicePath, `// shifted\n// twice\n${readFileSync(servicePath, "utf8")}`, "utf8");
    const after = await extract(root, [...candidates].reverse());

    const ids = (file: typeof original) => Object.fromEntries(
      file.nodes
        .map((node) => [node.qualifiedName, node.id]),
    );
    expect(ids(after.files.find((entry) => entry.path === "src/service.ts")!)).toEqual(ids(original));
    expect(after.files.map((file) => file.path).sort()).toEqual(before.files.map((file) => file.path).sort());
  });

  it("does not bind a production call to a same-named test symbol or duplicate a callsite", async () => {
    const { root, candidates } = mainFixture();
    const result = await extract(root, candidates);
    const productionTarget = result.files.find((file) => file.path === "src/helper.ts")!
      .nodes.find((node) => node.name === "duplicate")!;
    const testTarget = result.files.find((file) => file.path === "test/helper.test.ts")!
      .nodes.find((node) => node.name === "duplicate")!;
    const useFile = result.files.find((file) => file.path === "src/use.ts")!;
    const call = useFile.edges.find((reference) => reference.kind === "calls" && reference.metadata?.targetName === "duplicate")!;

    expect(call.target).toBe(productionTarget.id);
    expect(call.target).not.toBe(testTarget.id);

    const semanticKeys = result.files.flatMap((file) => file.edges)
      .filter((reference) => reference.target)
      .map((reference) => [reference.source, reference.target, reference.kind, reference.line, reference.column].join(":"));
    expect(new Set(semanticKeys).size).toBe(semanticKeys.length);
  });

  it("does not map excess callback arguments onto an ordinary final parameter", async () => {
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
    const file = (await extract(root, ["callbacks.ts"])).files[0]!;
    const invoke = file.nodes.find((node) => node.name === "invoke")!;
    const invokeFirst = file.nodes.find((node) => node.name === "invokeFirst")!;
    const real = file.nodes.find((node) => node.name === "real")!;
    const decoy = file.nodes.find((node) => node.name === "decoy")!;
    const synthesizedTargets = (sourceId: string): string[] => file.edges
      .filter((reference) => reference.source === sourceId && reference.provenance === "callback-synthesis")
      .map((reference) => reference.target!);

    expect(synthesizedTargets(invoke.id)).toEqual([real.id]);
    // A real rest parameter is handled per element: only callbacks[0]() is
    // proven, so the second actual argument cannot acquire a traversable edge.
    expect(synthesizedTargets(invokeFirst.id)).toEqual([real.id]);
    expect(synthesizedTargets(invoke.id)).not.toContain(decoy.id);
    expect(synthesizedTargets(invokeFirst.id)).not.toContain(decoy.id);
  });

  it("reports partial syntax health and excludes only intersecting declarations", async () => {
    const root = project({
      "broken.ts": [
        "export function sound(): number { return 1; }",
        "export function broken(): number { return @@@; }",
        "export function alsoSound(): number { return 2; }",
      ].join("\n"),
    });
    const result = await extract(root, ["broken.ts"]);
    const file = result.files[0];
    expect(file.health.status).toBe("partial");
    expect(file.health.diagnosticCount).toBeGreaterThan(0);
    expect(file.health.errorCoverage).toBeLessThanOrEqual(0.25);
    expect(file.nodes.some((node) => node.name === "sound")).toBe(true);
    expect(file.nodes.some((node) => node.name === "alsoSound")).toBe(true);
    expect(file.nodes.some((node) => node.name === "broken")).toBe(false);
  });

  it("indexes the Hono Context response-construction regression symbols and call edge", async () => {
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
    const result = await extract(root, ["src/context.ts"]);
    const file = result.files[0]!;
    const context = file.nodes.find((node) => node.name === "Context")!;
    const privateResponse = file.nodes.find((node) => node.name === "#newResponse")!;
    const responseFactory = file.nodes.find((node) => node.name === "createResponseInstance")!;

    expect(file.health.status).toBe("ok");
    expect(context.kind).toBe("class");
    expect(privateResponse).toMatchObject({ kind: "method", qualifiedName: "Context::#newResponse" });
    // Arrow-function bindings are callable symbols.
    expect(responseFactory.kind).toBe("function");
    expect(file.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: privateResponse.id,
        target: responseFactory.id,
        kind: "calls",
        provenance: "typescript-compiler",
      }),
    ]));
  });

  it("keeps a declaration id when its signature display text changes", async () => {
    const root = project({ "a.ts": "export function f(): number { return 1; }" });
    const previous = ((await extract(root, ["a.ts"]))).files[0]!.nodes.find(node => node.name === "f")!;
    writeFileSync(join(root, "a.ts"), "export function f(): string { return 'one'; }");
    const changed = ((await extract(root, ["a.ts"]))).files[0]!.nodes.find(node => node.name === "f")!;
    expect(changed.id).toBe(previous.id);
    expect(changed.signature).not.toBe(previous.signature);
  });

  it("sketches the same structure despite identifier and literal edits", async () => {
    const source = [
      "export function alpha(value: string): string { return value + 'one'; }",
      "export function beta(input: string): string { return input + 'two'; }",
    ].join("\n");
    const root = project({ "tokens.ts": source });
    const file = (await extract(root, ["tokens.ts"])).files[0];
    const alpha = file.nodes.find((node) => node.name === "alpha")!;
    const beta = file.nodes.find((node) => node.name === "beta")!;
    expect(alpha.tokenCount).toBeGreaterThan(0);
    expect(alpha.tokenCount).toBe(beta.tokenCount);
    expect(alpha.minhash).toEqual(beta.minhash);
  });

  it("renders the same ids, references and signatures from any checkout directory (#240)", async () => {
    const files = crossModuleTypeFixture();
    const shallow = project(files);
    const deep = project(Object.fromEntries(
      Object.entries(files).map(([path, source]) => [`nested/${"deeper".repeat(12)}/other-checkout/${path}`, source]),
    ));
    const deepRoot = join(deep, "nested", "deeper".repeat(12), "other-checkout");
    const candidates = Object.keys(files).filter((path) => path.startsWith("src/"));
    const first = await extract(shallow, candidates);
    const second = await extract(deepRoot, candidates);

    expect(identitySurface(second)).toEqual(identitySurface(first));
    for (const [result, root] of [[first, shallow], [second, deepRoot]] as const) {
      const serialized = JSON.stringify(result.files);
      expect(serialized).not.toContain(root.replaceAll("\\", "/"));
      expect(serialized).not.toContain(JSON.stringify(root).slice(1, -1));
      expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/u);
      expect(serialized).not.toMatch(/import\(\\"\//u);
    }
  });

});
