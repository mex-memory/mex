import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverBoundedGraphPaths, GRAPH_CONFIG_GLOBS, GRAPH_CORPUS_GLOB_OPTIONS, GRAPH_CORPUS_IGNORE_GLOBS, GRAPH_SUPPORTED_SOURCE_GLOB } from "../corpus-policy.js";
import { discoverGraphReadPaths, withFullGraphDiscovery } from "../read-discovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-read-discovery-")); roots.push(root);
  for (const file of ["a.ts", "UPPER.TS", "src/a.py", "src/deep/x.rs", "src/a.txt", "package.json", "tsconfig.json", "src/jsconfig.extra.json", "src/PACKAGE.JSON", "src/tsconfigXjson", ".hidden/a.ts", "src/.hidden.ts", "node_modules/a.ts", "src/node_modules/b.ts", "dist/output.js", "build/tsconfig.json", "src/out/result.cs"]) {
    const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "{}");
  }
  return root;
}
function compare(root: string, ignore: string[] = [...GRAPH_CORPUS_IGNORE_GLOBS]): void {
  const options = { ...GRAPH_CORPUS_GLOB_OPTIONS, cwd: root, ignore };
  for (const pattern of [GRAPH_SUPPORTED_SOURCE_GLOB, [...GRAPH_CONFIG_GLOBS]]) {
    expect(discoverGraphReadPaths(pattern, options, 2000)).toEqual(discoverBoundedGraphPaths(pattern, options, 2000));
    expect(withFullGraphDiscovery(() => discoverGraphReadPaths(pattern, options, 2000))).toEqual(discoverBoundedGraphPaths(pattern, options, 2000));
  }
}
describe("exact graph read discovery", () => {
  it("matches source/config glob semantics including case, dots, nesting and ignored directories", () => compare(fixture()));
  it("falls back for configured ignore globs", () => compare(fixture(), [...GRAPH_CORPUS_IGNORE_GLOBS, "src/deep/**", "**/a.py"]));
  it("falls back for directory junctions without traversing ignored dependencies", () => {
    const root = fixture(); symlinkSync(join(root, "src/deep"), join(root, "linked"), "junction"); compare(root);
  });
  it("observes additions, deletions and case-only renames on every call", () => {
    const root = fixture(); compare(root);
    writeFileSync(join(root, "src/new.ts"), "new"); compare(root);
    renameSync(join(root, "a.ts"), join(root, "temporary")); renameSync(join(root, "temporary"), join(root, "A.ts")); compare(root);
    rmSync(join(root, "src/a.py")); compare(root);
  });
  it("retains corpus count bounds", () => {
    const root = fixture(); const options = { ...GRAPH_CORPUS_GLOB_OPTIONS, cwd: root, ignore: [...GRAPH_CORPUS_IGNORE_GLOBS] };
    expect(() => discoverGraphReadPaths(GRAPH_SUPPORTED_SOURCE_GLOB, options, 1)).toThrow("maxSourceFiles");
  });
});
