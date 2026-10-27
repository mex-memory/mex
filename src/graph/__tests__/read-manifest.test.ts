import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { graphConfigIdentity } from "../config-identity.js";
import { graphManifest, CORPUS_EXTRACTOR_VERSION } from "../manifest.js";
import { TYPESCRIPT_COMPILER_EXTRACTOR_VERSION, TYPESCRIPT_COMPILER_VERSION } from "../extraction/compiler.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("read manifest compatibility", () => {
  it("keeps the compiler metadata and extractor version identical to extraction", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-read-manifest-")); roots.push(root);
    const manifest = graphManifest(root);
    expect(manifest.inputs.compiler).toBe(TYPESCRIPT_COMPILER_VERSION);
    expect(CORPUS_EXTRACTOR_VERSION).toBe(TYPESCRIPT_COMPILER_EXTRACTOR_VERSION + "+tree-sitter-v4");
  });
  it("matches the original parser for JSONC and malformed significant fields", () => {
    const cases = [
      '{"include":["src"],}', '{/*x*/"include":["src",],}',
      '{"include":[,]}', '{"include":[1,,]}', '{"include":[1e309]}',
      '{"include":["//path", "/*path*/", "comma,}"]}',
      '{"include":["a\\\\b", "a\\\"b"]}',
      '// comment\u2028{"include":["src"]}', '// comment\u2029{"include":["src"]}',
      '{"compilerOptions":{"paths":{"x":[,]}}}',
      '{"compilerOptions":{"paths":{"x":["src", /* x */]}}}',
      '{"include":["src"]} /* unterminated', '{"include":["a"]} trailing',
      '{include:["src"]}', "{'include':['src']}", '{"include":[0x10]}',
      '{"include":["a"],"include":["b"]}', '\uFEFF{"include":["src"]}',
    ];
    let seed = 282;
    for (let index = 0; index < 100; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const paths = ["src/" + seed.toString(16), "quotes\\\"///*,}\\n"];
      cases.push('{ /* configuration */ "include": ' + JSON.stringify(paths).slice(0, -1) + ",]" + ', }');
    }
    for (const source of cases) {
      const original = ts.parseConfigFileTextToJson("tsconfig.json", source);
      const expected = original.error ? source : graphConfigIdentity("tsconfig.json", JSON.stringify(original.config));
      expect(graphConfigIdentity("tsconfig.json", source), source).toBe(expected);
    }
  });
});

