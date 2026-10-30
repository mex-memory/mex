import { describe, expect, it } from "vitest";
import { parseJsonc } from "./jsonc.js";

describe("parseJsonc", () => {
  it("preserves comment markers, URLs, escapes, and comma-like text in strings", () => {
    const value = { url: "https://example.test/a//b", comment: "/* literal */ // literal", escaped: 'a\\b"//c', commas: ",] ,}", unicode: "😀" };
    expect(parseJsonc(JSON.stringify(value))).toEqual(value);
  });

  it("reads comments and trailing commas in nested paths maps, objects, and arrays", () => {
    expect(parseJsonc(`{
      // project configuration
      "compilerOptions": { /* aliases */
        "paths": {
          "@app/*": ["src/*", /* fallback */ "lib/*",],
          // a comment between mappings
          "@test/*": ["test/*",],
        },
      },
    }`)).toEqual({ compilerOptions: { paths: { "@app/*": ["src/*", "lib/*"], "@test/*": ["test/*"] } } });
  });

  it("handles line endings and comments at the input boundaries", () => {
    expect(parseJsonc('// start\r\n[1,\r// middle\r2, /* end */]\n// finish')).toEqual([1, 2]);
    expect(parseJsonc('/* start */{}/* end */')).toEqual({});
  });

  it.each([
    '{"a":', '{"a": "unterminated}', '{"a": "bad\\q"}',
    '{"a": 1 /* unfinished', '{"a": 1} garbage', '{unquoted: 1}',
    '[,]', '{,}', '[1,,]', '{"a":,}', '[1/* gap */2]',
    '/* outer /* inner */ still outside */{}',
  ])("rejects malformed input: %s", (text) => {
    expect(() => parseJsonc(text)).toThrow(SyntaxError);
  });

  it("bounds input before allocating the parsing buffers", () => {
    expect(() => parseJsonc(" ".repeat(1_048_577))).toThrow(RangeError);
  });
});
