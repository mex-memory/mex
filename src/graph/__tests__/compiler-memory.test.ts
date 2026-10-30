import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryObjects } from "node:v8";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { buildTypeScriptExtraction } from "../extraction/compiler.js";
import { flushGraphPhaseTimings } from "../phase-timing.js";

it("bounds parsed-file retention while reusing recently used library declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-compiler-cache-"));
  try {
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true }, files: ["main.ts"] }));
    writeFileSync(join(root, "main.ts"), "export const main = 1;\n");
    const stagedInputs = [
      { filePath: "main.ts", source: "export const main = 1;\n" },
      { filePath: "tsconfig.json", source: JSON.stringify({ compilerOptions: { noLib: true }, files: ["main.ts"] }) },
      // Past the shared cache's entry bound (16,384 files) and byte bound (64 MiB of text).
      ...Array.from({ length: 17_000 }, (_, index) => ({ filePath: `cache/${index}.d.ts`, source: `export declare const value${index}: number;` })),
      ...Array.from({ length: 20 }, (_, index) => ({ filePath: `large/${index}.d.ts`, source: `/*${" ".repeat(2 * 1024 * 1024)}*/` })),
    ];
    let reused = false;
    let entryEvicted = false;
    let byteEvicted = false;
    const result = buildTypeScriptExtraction(root, ["main.ts"], {
      stagedInputs,
      programFactory(options) {
        const read = (path: string) => options.host!.getSourceFile(join(root, path), ts.ScriptTarget.ES2022)!;
        const first = read("cache/0.d.ts");
        reused = read("cache/0.d.ts") === first;
        const cold = read("cache/1.d.ts");
        for (let index = 2; index < 17_000; index++) {
          read(`cache/${index}.d.ts`);
          if (index % 1000 === 0) reused &&= read("cache/0.d.ts") === first;
        }
        reused &&= read("cache/0.d.ts") === first;
        entryEvicted = read("cache/1.d.ts") !== cold;
        const large = read("large/0.d.ts");
        for (let index = 1; index < 20; index++) read(`large/${index}.d.ts`);
        byteEvicted = read("large/0.d.ts") !== large;
        return ts.createProgram(options);
      },
    });
    expect(reused).toBe(true);
    expect(entryEvicted).toBe(true);
    expect(byteEvicted).toBe(true);
    expect(result.files[0]?.nodes.some((node) => node.name === "main")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("bounds a dependency's recursive conditional types and counts truncated renders", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-compiler-render-"));
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const source = `type Tree<T, D extends unknown[] = []> = D['length'] extends 18 ? T
      : T extends { value: infer V } ? Tree<V, [...D, 0]>
      : { left: Tree<T, [...D, 0]>; right: Tree<T, [...D, 0]>;
          above: Tree<T, [...D, 0]>; below: Tree<T, [...D, 0]> };
declare function make<T>(): Tree<T>;
export function sample<T>() { return make<T>(); }
export const ordinary: number = 1;
export function identity(value: number): number { return value; }
`;
    const path = join(root, "main.ts");
    writeFileSync(path, source);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, files: ["main.ts"] }));
    const timingPath = join(root, "timings.jsonl");
    flushGraphPhaseTimings("reset");
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", timingPath);
    const started = performance.now();
    const result = buildTypeScriptExtraction(root, ["main.ts"]);
    expect(performance.now() - started).toBeLessThan(10_000);
    flushGraphPhaseTimings("render-test");
    const { phases } = JSON.parse(readFileSync(timingPath, "utf8").trim().split(/\r?\n/u)[0]!);
    expect(phases["compiler.truncatedRenders"]).toBeGreaterThan(0);
    expect(phases["compiler.renderFallbacks"]).toBe(0);
    expect(warnings.mock.calls.length).toBeGreaterThan(0);
    expect(warnings.mock.calls.length).toBeLessThanOrEqual(10);
    expect(warnings.mock.calls[0]![0]).toMatch(/main\.ts:\d+$/u);
    const nodes = result.files[0]!.nodes;
    expect(nodes.every((node) => (node.signature?.length ?? 0) <= 2_000_000)).toBe(true);

    // An independent checker avoids reusing any bounded serialization result.
    const program = ts.createProgram([path], { noLib: true, types: [] });
    const checker = program.getTypeChecker();
    const file = program.getSourceFile(path)!;
    const variable = (file.statements.find(ts.isVariableStatement)!).declarationList.declarations[0]!;
    const flags = ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.IgnoreErrors;
    const ordinary = checker.typeToTypeNode(checker.getTypeAtLocation(variable), variable, flags)!;
    const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
    expect(nodes.find((node) => node.name === "ordinary")!.signature)
      .toBe(printer.printNode(ts.EmitHint.Unspecified, ordinary, file));
    const identity = file.statements.filter(ts.isFunctionDeclaration).find((node) => node.name?.text === "identity")!;
    const signature = checker.signatureToSignatureDeclaration(checker.getSignatureFromDeclaration(identity)!,
      ts.SyntaxKind.CallSignature, identity, flags | ts.NodeBuilderFlags.WriteTypeParametersInQualifiedName)!;
    const signaturePrinter = ts.createPrinter({ removeComments: true, omitTrailingSemicolon: true });
    expect(nodes.find((node) => node.name === "identity")!.signature)
      .toBe(signaturePrinter.printNode(ts.EmitHint.Unspecified, signature, file).replace(/;$/u, ""));
  } finally {
    warnings.mockRestore();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});


it("releases executable sources between projects and keeps shared declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-compiler-project-cache-"));
  try {
    const sources = [
      { filePath: "tsconfig.json", source: JSON.stringify({ compilerOptions: { noLib: true }, files: ["main.ts"] }) },
      { filePath: "child/tsconfig.json", source: JSON.stringify({ compilerOptions: { noLib: true }, files: ["main.ts"] }) },
      { filePath: "main.ts", source: "export const main = 1;\n" },
      { filePath: "child/main.ts", source: "export const child = 1;\n" },
      { filePath: "shared.d.ts", source: "export declare const shared: number;\n" },
    ];
    for (const input of sources) {
      mkdirSync(join(root, input.filePath, ".."), { recursive: true });
      writeFileSync(join(root, input.filePath), input.source);
    }
    const seen: Array<{ source: ts.SourceFile; declaration: ts.SourceFile }> = [];
    buildTypeScriptExtraction(root, ["main.ts", "child/main.ts"], {
      stagedInputs: sources,
      programFactory(options) {
        const read = (path: string) => options.host!.getSourceFile(join(root, path), ts.ScriptTarget.ES2022)!;
        seen.push({ source: read("main.ts"), declaration: read("shared.d.ts") });
        return ts.createProgram(options);
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.source).not.toBe(seen[1]!.source);
    expect(seen[0]!.declaration).toBe(seen[1]!.declaration);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("collects completed programs and checkers before creating the next project", () => {
  class ProjectProgram {}
  class ProjectChecker {}
  const root = mkdtempSync(join(tmpdir(), "mex-compiler-project-lifetime-"));
  try {
    const config = JSON.stringify({ compilerOptions: { noLib: true, types: [] }, files: ["main.ts"] });
    const sources = [
      { filePath: "tsconfig.json", source: config },
      { filePath: "child/tsconfig.json", source: config },
      { filePath: "main.ts", source: "export const main = 1;\n" },
      { filePath: "child/main.ts", source: "export const child = 1;\n" },
      { filePath: "loose.ts", source: "export const loose = 1;\n" },
    ];
    for (const input of sources) {
      mkdirSync(join(root, input.filePath, ".."), { recursive: true });
      writeFileSync(join(root, input.filePath), input.source);
    }
    const live: Array<{ programs: number; checkers: number }> = [];
    const result = buildTypeScriptExtraction(root, ["main.ts", "child/main.ts", "loose.ts"], {
      stagedInputs: sources,
      inferredCompilerOptions: { noLib: true, types: [] },
      programFactory(options) {
        // queryObjects forces GC and counts by prototype without pinning the
        // previous targets until the next event-loop turn, as WeakRef does.
        live.push({
          programs: queryObjects(ProjectProgram, { format: "count" }),
          checkers: queryObjects(ProjectChecker, { format: "count" }),
        });
        const program = ts.createProgram(options);
        Object.setPrototypeOf(program, ProjectProgram.prototype);
        Object.setPrototypeOf(program.getTypeChecker(), ProjectChecker.prototype);
        return program;
      },
    });
    expect(result.files).toHaveLength(3);
    expect(live).toEqual(Array.from({ length: 3 }, () => ({ programs: 0, checkers: 0 })));
    expect(queryObjects(ProjectProgram, { format: "count" })).toBe(0);
    expect(queryObjects(ProjectChecker, { format: "count" })).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
