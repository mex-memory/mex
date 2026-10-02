import { beforeAll, describe, expect, it } from "vitest";
import { codeHash, codeHashOfBody, prepareCodeHashing } from "../code-hash.js";

beforeAll(async () => {
  await prepareCodeHashing();
});

/** The hash of a whole file's text, for cases where the node is the file. */
function whole(file: string, text: string): string | null {
  return codeHash(file, text, 1, text.split("\n").length);
}

describe("codeHash (#236)", () => {
  const method = "export class Cart {\n  total(items: number[]): number {\n    const tax = 0.18;\n    const url = 'http://x';\n    return items.reduce((a, b) => a + b, 0) * (1 + tax);\n  }\n}\n";

  it("sees past comments in a method read in its class", () => {
    const commented = "export class Cart {\n  total(items: number[]): number {\n    // VAT for India\n    const tax = 0.18; /* rate */\n    const url = 'http://x';\n    return items.reduce((a, b) => a + b, 0) * (1 + tax);\n  }\n}\n";
    const base = codeHash("a.ts", method, 2, 6);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash("a.ts", commented, 2, 7)).toBe(base);
  });

  it("sees an edited constant, string or identifier", () => {
    const base = codeHash("a.ts", method, 2, 6);
    for (const edit of [method.replace("0.18", "0.21"), method.replace("http://x", "http://y"), method.replace("tax)", "rate)")]) {
      expect(codeHash("a.ts", edit, 2, 6)).not.toBe(base);
    }
  });

  it("treats comment syntax inside a string as code", () => {
    const text = "export const marker = '// keep';\n";
    expect(whole("a.ts", text)).not.toBe(whole("a.ts", text.replace("// keep", "// gone")));
  });

  it("reads each shipped grammar's comments as comments", () => {
    const pairs: Array<[string, string, string]> = [
      ["a.js", "function f(x) {\n  return x + 1;\n}\n", "function f(x) {\n  // add one\n  return x + 1; /* done */\n}\n"],
      ["a.py", "def f(x):\n    y = x + 1\n    return y\n", "def f(x):\n    # add one\n    y = x + 1  # inline\n    return y\n"],
      ["a.rs", "fn f(x: i32) -> i32 {\n    x + 1\n}\n", "/// Adds one.\nfn f(x: i32) -> i32 {\n    // add /* nested */\n    x + 1 /* a /* b */ c */\n}\n"],
      ["a.cs", "class A {\n  int M(int x) {\n    return x + 1;\n  }\n}\n", "class A {\n  /// <summary>Adds.</summary>\n  int M(int x) {\n    // one\n    return x + 1; /* done */\n  }\n}\n"],
    ];
    for (const [file, base, commented] of pairs) {
      expect(whole(file, commented), file).toBe(whole(file, base));
      expect(whole(file, base), file).not.toBeNull();
    }
  });

  it("treats a Python docstring as code", () => {
    const base = "def f(x):\n    \"\"\"Add one.\"\"\"\n    return x + 1\n";
    expect(whole("a.py", base.replace("Add one.", "Add two."))).not.toBe(whole("a.py", base));
  });

  it("returns null whenever it cannot be sure", () => {
    // A parse error inside the span.
    expect(codeHash("a.ts", method.replace("0.18;", "0.18 +;"), 2, 6)).toBeNull();
    // No grammar for the language.
    expect(whole("a.go", "package main\nfunc f() {}\n")).toBeNull();
    // A span holding only comments.
    expect(whole("a.ts", "// nothing but a comment\n")).toBeNull();
  });

  it("hashes an old body on its own when it parses cleanly", () => {
    const body = "function f(x) {\n  return x + 1;\n}";
    expect(codeHashOfBody("a.js", body)).toBe(whole("a.js", `${body}\n`));
  });
});
