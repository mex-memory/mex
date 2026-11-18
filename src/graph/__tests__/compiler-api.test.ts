import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTypeScriptExtraction, type CompilerExtractionResult } from "../extraction/compiler.js";
import {
  ApiProjectCompiler,
  loadTsrsServer,
  rawCompilerOptions,
  translateCompilerOptions,
  tsgoServer,
  type TypeScriptApiServer,
} from "../extraction/compiler-api.js";
import { compareCompilerExtractions, parityHolds } from "../extraction/compiler-parity.js";

const temporaryRoots: string[] = [];
let servers: TypeScriptApiServer[] = [];

beforeAll(async () => {
  servers = [tsgoServer(), await loadTsrsServer()];
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mex-compiler-api-"));
  temporaryRoots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, source, "utf8");
  }
  return root;
}

function extract(root: string, server?: TypeScriptApiServer, visitOrder?: (files: readonly string[]) => readonly string[]): CompilerExtractionResult {
  const compiler = server ? new ApiProjectCompiler(server) : undefined;
  return buildTypeScriptExtraction(root, undefined, {
    ...(compiler ? { selectCompiler: () => compiler } : {}),
    ...(visitOrder ? { visitOrder } : {}),
  });
}

/** Every reference form the extractor records, across two projects. */
const COVERAGE_FIXTURE: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
      experimentalDecorators: true, allowJs: true, checkJs: false, paths: { "@lib/*": ["./src/lib/*"] },
    },
    include: ["src/**/*.ts", "src/**/*.js"],
  }),
  "tools/tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
    include: ["**/*.ts"],
  }),
  "src/lib/base.ts": [
    "/** The base. */",
    "export abstract class Base {",
    "  protected abstract run(): string;",
    "  static make(): void {}",
    "}",
    "export interface Shape { area(): number }",
    "export enum Color { Red, Green }",
    "export namespace Geometry { export const unit = 1; export function scale(n: number) { return n * unit; } }",
    "",
  ].join("\n"),
  "src/service.ts": [
    "import { Base as Parent, type Shape, Color, Geometry } from '@lib/base';",
    "import * as base from '@lib/base';",
    "function logged(_target: unknown, _key: string) {}",
    "export class Circle extends Parent implements Shape {",
    "  constructor(private readonly r: number) { super(); }",
    "  protected run(): string { return 'circle'; }",
    "  area(): number { return Math.PI * this.r ** 2; }",
    "  @logged decorated(): void {}",
    "  get size(): number { return this.r; }",
    "}",
    "export function over(x: string): string;",
    "export function over(x: number): number;",
    "export function over(x: string | number): string | number { return x; }",
    "export const helper = (n: number) => n + 1;",
    "export function each(items: number[], visit: (n: number) => void): void { for (const item of items) visit(item); }",
    "export function rest(...handlers: Array<() => void>): void { handlers[0](); }",
    "export function run(shape?: Shape, pick?: boolean): number {",
    "  const c = new Circle(2);",
    "  over('x'); over(1);",
    "  each([1, 2], helper);",
    "  each([3], (n) => { over(n); });",
    "  rest(() => {}, () => {});",
    "  Parent.make();",
    "  base.Geometry.scale(Color.Green);",
    "  const chosen = pick ? helper : Geometry.scale;",
    "  chosen(1);",
    "  for (const f of [helper, Geometry.scale]) f(2);",
    "  shape?.area();",
    "  return c.area() + c.size + (shape ? shape.area() : 0);",
    "}",
    "",
  ].join("\n"),
  "src/legacy.js": [
    "export function helperJs() { return 1; }",
    "export const viaJs = () => helperJs();",
    "",
  ].join("\n"),
  "tools/cli.ts": [
    "import { run, over } from '../src/service';",
    "export function main(): void { run(); over('cli'); }",
    "",
  ].join("\n"),
  "scripts/loose.ts": "export function loose() { return 1; }\n",
};

describe("TypeScript 7.1 API extraction", () => {
  it.each(["tsgo", "tsrs"] as const)("matches the 5.9 extractor node for node and edge for edge (%s)", (name) => {
    const root = project(COVERAGE_FIXTURE);
    const legacy = extract(root);
    const api = extract(root, servers.find((server) => server.name === name));
    const report = compareCompilerExtractions(legacy, api);
    expect({
      onlyLegacyNodes: report.nodes.onlyLeft, onlyApiNodes: report.nodes.onlyRight,
      fields: report.nodeFieldDifferences,
      onlyLegacyEdges: report.edges.onlyLeft, onlyApiEdges: report.edges.onlyRight,
      imports: report.imports.differences,
    }).toEqual({ onlyLegacyNodes: [], onlyApiNodes: [], fields: [], onlyLegacyEdges: [], onlyApiEdges: [], imports: [] });
    expect(parityHolds(report)).toBe(true);
    expect(report.edges.matched).toBeGreaterThan(30);
    // A compiler switch keeps every node id and every reference id.
    const ids = (result: CompilerExtractionResult) => result.files.map((file) => [
      file.filePath, file.nodes.map((node) => node.id), file.references.map((reference) => reference.id),
    ]);
    expect(ids(api)).toEqual(ids(legacy));
    expect(report.unresolved.right).toEqual(report.unresolved.left);
    // Files keep the projects that own them.
    const owners = (result: CompilerExtractionResult) => Object.fromEntries(result.files.map((file) => [file.filePath, file.projectId]));
    expect(owners(api)).toEqual(owners(legacy));
  });

  it.each(["tsgo", "tsrs"] as const)("binds CommonJS assignments in JavaScript the way TypeScript 7 does (%s)", (name) => {
    // TypeScript 7 no longer merges `app.init = ...` into `app`'s declarations,
    // and binds `module` in `module.exports` to the file itself. Pinned here
    // so a compiler update that changes it is noticed.
    const root = project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true, module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }),
      "src/legacy.js": "const app = {};\napp.init = function () { return 1; };\nmodule.exports = app;\n",
    });
    const report = compareCompilerExtractions(extract(root), extract(root, servers.find((server) => server.name === name)));
    expect(report.nodes.onlyLeft).toEqual([]);
    expect(report.nodes.onlyRight).toEqual([]);
    expect(report.nodeFieldDifferences.map((entry) => entry.detail)).toEqual(["endLine: 2 → 1", "endColumn: 3 → 14"]);
    expect(report.edges.onlyLeft.map((entry) => entry.key)).toEqual([
      "src/legacy.js|file|src/legacy.js|source-file -references-> src/legacy.js|constant|app|variable @src/legacy.js:3:0",
    ]);
    expect(report.edges.onlyRight.map((entry) => entry.key)).toEqual([
      "src/legacy.js|function|app.init|function-assignment -references-> src/legacy.js|constant|app|variable @src/legacy.js:2:0",
    ]);
  });

  it.each(["tsgo", "tsrs"] as const)("records which compiler built each project (%s)", (name) => {
    const root = project(COVERAGE_FIXTURE);
    const server = servers.find((candidate) => candidate.name === name)!;
    const result = extract(root, server);
    expect(Object.values(result.projectCompilers)).not.toHaveLength(0);
    for (const compiler of Object.values(result.projectCompilers)) expect(compiler).toBe(`${name}-${server.version}`);
    expect(extract(root).projectCompilers).toEqual(
      Object.fromEntries(Object.keys(result.projectCompilers).map((id) => [id, expect.stringMatching(/^typescript-5\./u)])),
    );
  });

  it("gives the same output in any file visit order", () => {
    const root = project(COVERAGE_FIXTURE);
    const server = servers.find((candidate) => candidate.name === "tsrs")!;
    const forward = extract(root, server);
    const backward = extract(root, server, (files) => [...files].reverse());
    const strip = (result: CompilerExtractionResult) => result.files.map((file) => ({
      filePath: file.filePath, nodes: file.nodes, references: file.references, importBindings: file.importBindings,
    }));
    expect(strip(backward)).toEqual(strip(forward));
  });

  it("keeps node ids independent of the checkout directory", () => {
    const first = project(COVERAGE_FIXTURE);
    const second = project(COVERAGE_FIXTURE);
    const server = servers.find((candidate) => candidate.name === "tsrs")!;
    const ids = (result: CompilerExtractionResult) => result.files.flatMap((file) => file.nodes.map((node) => node.id));
    expect(ids(extract(second, server))).toEqual(ids(extract(first, server)));
  });

  it("reads the repository through the input ledger: staged bytes win over the disk", () => {
    const root = project({
      "tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
      "src/a.ts": "export function onDisk() {}\n",
    });
    const compiler = new ApiProjectCompiler(servers[1]!);
    const result = buildTypeScriptExtraction(root, ["src/a.ts"], {
      selectCompiler: () => compiler,
      stagedInputs: [
        { filePath: "tsconfig.json", source: JSON.stringify({ include: ["src/**/*.ts"] }) },
        { filePath: "src/a.ts", source: "export function staged() {}\n" },
      ],
    });
    expect(result.files[0]!.nodes.map((node) => node.name)).toEqual(["a.ts", "staged"]);
  });

  it("passes 5.9's parsed options through with the same enum values", () => {
    expect(rawCompilerOptions({ target: 9, module: 99, moduleResolution: 100, strict: true, configFilePath: "x" }))
      .toEqual({ target: 9, module: 99, moduleResolution: 100, strict: true });
  });
});

describe("tsconfig translation for TypeScript 7", () => {
  it("translates removed options in memory and says what changed", () => {
    const translated = translateCompilerOptions({
      target: 1, module: 1, baseUrl: "/repo/src", paths: { "@app/*": ["app/*"] },
      esModuleInterop: false, downlevelIteration: true, importsNotUsedAsValues: 0,
    });
    expect(translated.options).toEqual({
      target: 2, module: 200, moduleResolution: 100,
      paths: { "@app/*": [expect.stringMatching(/\/repo\/src\/app\/\*$/u)], "*": [expect.stringMatching(/\/repo\/src\/\*$/u)] },
      pathsBasePath: expect.stringMatching(/\/repo\/src$/u),
    });
    expect(translated.changes).toEqual([
      "moduleResolution node10 → bundler", "module commonjs → preserve", "target es5 → es2015",
      "baseUrl → paths", "esModuleInterop false → true", "downlevelIteration removed",
      "importsNotUsedAsValues removed",
    ]);
    expect(translated.affectsResolution).toBe(true);
  });

  it("leaves a modern config as it is, with 5.9's defaults written out", () => {
    const translated = translateCompilerOptions({ target: 9, module: 99, moduleResolution: 100, strict: true });
    expect(translated).toEqual({
      options: { target: 9, module: 99, moduleResolution: 100, strict: true }, changes: [], affectsResolution: false,
    });
  });

  it.each(["tsgo", "tsrs"] as const)("resolves a baseUrl project after translation, with parity (%s)", (name) => {
    const root = project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "commonjs", baseUrl: "src", strict: true }, include: ["src"] }),
      "src/lib/thing.ts": "export function thing(): number { return 1; }\n",
      "src/main.ts": "import { thing } from 'lib/thing';\nexport function main(): number { return thing(); }\n",
    });
    const api = extract(root, servers.find((server) => server.name === name));
    const report = compareCompilerExtractions(extract(root), api);
    expect(parityHolds(report)).toBe(true);
    expect(report.edges.matched).toBeGreaterThan(0);
    expect(Object.values(api.projectCompilers)).toEqual([expect.stringMatching(new RegExp(`^${name}-`, "u"))]);
    expect(api.projectCompilerNotes["config:tsconfig.json"]).toEqual([
      "moduleResolution node10 → bundler", "module commonjs → preserve", "target es5 → es2015", "baseUrl → paths",
    ]);
  });

  it("extracts a project with 5.9 when the translation loses an import, and says why", () => {
    // node10 reads `pkg/internal` from disk; bundler honours the package's
    // `exports`, which do not expose it.
    const root = project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "commonjs", strict: true }, include: ["src"] }),
      "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", exports: { ".": { types: "./index.d.ts" } }, types: "index.d.ts" }),
      "node_modules/pkg/index.d.ts": "export declare const root: number;\n",
      "node_modules/pkg/internal.d.ts": "export declare function hidden(): number;\n",
      "src/main.ts": "import { hidden } from 'pkg/internal';\nexport function main(): number { return hidden(); }\n",
    });
    const result = extract(root, servers.find((server) => server.name === "tsrs"));
    expect(result.projectCompilers["config:tsconfig.json"]).toMatch(/^typescript-5\./u);
    expect(result.projectCompilerNotes["config:tsconfig.json"]).toEqual([
      expect.stringMatching(/leaves 1 import unresolved that TypeScript 5\.9 resolves \(for example 'pkg\/internal' in src\/main\.ts\)$/u),
    ]);
    expect(parityHolds(compareCompilerExtractions(extract(root), result))).toBe(true);
  });

  it("extracts with 5.9 when the server cannot start, and says why", () => {
    const root = project(COVERAGE_FIXTURE);
    const broken: TypeScriptApiServer = { ...servers[1]!, start: () => { throw new Error("no binary for this platform"); } };
    const result = extract(root, broken);
    expect(Object.values(result.projectCompilers).every((compiler) => compiler.startsWith("typescript-5."))).toBe(true);
    expect(Object.values(result.projectCompilerNotes).flat()).toContainEqual(
      expect.stringMatching(new RegExp(`^tsrs-${broken.version.replaceAll(".", "[.]")} failed [(]no binary for this platform[)]; typescript-5[.]`, "u")),
    );
    expect(parityHolds(compareCompilerExtractions(extract(root), result))).toBe(true);
  });
});
