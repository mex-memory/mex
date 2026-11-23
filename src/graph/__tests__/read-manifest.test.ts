import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphConfigIdentity } from "../config-identity.js";
import { graphManifest, corpusExtractorVersion } from "../manifest.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("read manifest compatibility", () => {
  it("records the configured extractor and resolver without compiler metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-read-manifest-")); roots.push(root);
    const manifest = graphManifest(root);
    expect(manifest.inputs).toMatchObject({ extractor: corpusExtractorVersion(), resolver: "engine-first-v4" });
    expect(manifest.inputs).not.toHaveProperty("compiler");
  });
  it("projects JSONC and hashes malformed configs by exact bytes", () => {
    const plain = '{"include":["src//one","/*path*/"],"compilerOptions":{"paths":{"#x":["src,}"]}}}';
    const commented = '\uFEFF{ /* config */ "include": ["src//one","/*path*/",], "compilerOptions": {"paths":{"#x":["src,}",],},}, }';
    expect(graphConfigIdentity("tsconfig.json", commented)).toBe(graphConfigIdentity("tsconfig.json", plain));
    for (const malformed of [
      '{"include":[,]}', '{"include":[1,,]}', '{"include":[1e309]}',
      '{"compilerOptions":{"paths":{"x":[,]}}}', '{"include":["src"]} /* unterminated',
      '{"include":["a"]} trailing', '{include:["src"]}', "{'include':['src']}", '{"include":[0x10]}',
    ]) {
      expect(graphConfigIdentity("tsconfig.json", malformed)).toBe(malformed);
    }
  });
});
