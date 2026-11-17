import { describe, expect, it } from "vitest";
import { recordFor } from "../batch.js";
import { countLiteral, isTestFile, langOf, patternId } from "../classify.js";
import { globPrefix, globToRegExp } from "../glob.js";
import { applyShifts, changesNesting, mapLine, mapSpan } from "../shifts.js";
import type { OutlineItem } from "../types.js";

async function brief(path: string, text: string): Promise<string[]> {
  const record = await recordFor(path, text);
  return (record?.outline ?? []).map((item) => `${item.kind} ${item.name} ${item.start}-${item.end}`);
}

describe("parsing", () => {
  it("starts a TypeScript symbol at its first decorator", async () => {
    const text = "@Injectable()\nexport class Service {\n  @Get(':id')\n  @Auth()\n  find() {}\n}\n";
    expect(await brief("a.ts", text)).toEqual(["class Service 1-6", "method find 3-5"]);
  });

  it("parses JSX in a plain .js file", async () => {
    expect(await brief("App.js", "export function App() {\n  return <div>hi</div>;\n}\n")).toEqual(["function App 1-3"]);
  });

  it("counts lines right after non-ASCII text and with CRLF endings", async () => {
    const text = "// ünïcödé — 日本語 🎉\r\nconst s = \"ß😀\";\r\nexport function after() {\r\n  return s;\r\n}\r\n";
    expect(await brief("u.ts", text)).toEqual(["const s 2-2", "function after 3-5"]);
    const record = await recordFor("u.ts", text);
    expect(record?.lines).toBe(5);
  });

  it("keeps imports and exports, and names the file defines or imports", async () => {
    const record = await recordFor("m.ts", "import def, { a as b, c } from './x';\nimport * as ns from 'y';\nexport { c };\nexport const d = 1;\n");
    expect(record?.imports).toEqual([{ from: "./x", names: ["default", "a", "c"] }, { from: "y", names: ["*"] }]);
    expect(record?.exports).toEqual(["c", "d"]);
    expect(record?.names).toEqual(["a", "c", "d"]);
  });

  it("records a parse failure without an outline", async () => {
    const record = await recordFor("bad.ts", "export function (\n");
    expect(record?.parse_error).toBeTruthy();
    expect(record?.outline).toEqual([]);
  });

  it("classifies languages and test files", () => {
    expect([langOf("a/b.mts"), langOf("x.tsx"), langOf("x.cjs"), langOf("x.pyi"), langOf(".eslintrc"), langOf("Makefile")]).toEqual(["ts", "tsx", "js", "py", "other", "other"]);
    expect(isTestFile("src/a.spec.ts")).toBe(true);
    expect(isTestFile("pkg/tests/helpers.py")).toBe(true);
    expect(isTestFile("src/test_store.py")).toBe(true);
    expect(isTestFile("Shop.Tests/OrderTests.cs")).toBe(true);
    expect(isTestFile("src/latest.ts")).toBe(false);
    expect(isTestFile("src/check.ts", ["vitest"])).toBe(true);
  });

  it("counts literal patterns without overlap and gives stable ids", () => {
    expect(countLiteral("aaaa", "aa")).toBe(2);
    expect(countLiteral("from 'moment'; from 'moment'", "from 'moment'")).toBe(2);
    expect(patternId("from 'moment'")).toBe(patternId("from 'moment'"));
    expect(patternId("from 'moment'")).toMatch(/^p[0-9a-f]{15}$/);
  });
});

describe("scope globs", () => {
  const cases: Array<[string, string, boolean]> = [
    ["apps/api/**", "apps/api/src/a.ts", true],
    ["apps/api/**", "apps/api", true],
    ["apps/api/**", "apps/apix/a.ts", false],
    ["apps/api/", "apps/api/a.ts", true],
    ["**/*.ts", "a.ts", true],
    ["**/*.ts", "a/b/c.ts", true],
    ["**/*.ts", "a/b/c.tsx", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/a.md", false],
    ["src/**/test/*.py", "src/test/a.py", true],
    ["src/**/test/*.py", "src/x/y/test/a.py", true],
    ["src/**/**/a.ts", "src/a.ts", true],
    ["apps/{api,web}/**", "apps/web/x.ts", true],
    ["apps/{api,web}/**", "apps/worker/x.ts", false],
    ["a?.ts", "ab.ts", true],
    ["a?.ts", "a/.ts", false],
    ["file(1).ts", "file(1).ts", true],
    ["**", "anything/at/all", true],
    ["", "x", true],
    ["./src/*.ts", "src/a.ts", true],
  ];
  it.each(cases)("%s against %s is %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
  it("finds the literal prefix for a range scan", () => {
    expect(globPrefix("apps/api/**")).toBe("apps/api/");
    expect(globPrefix("**/*.ts")).toBe("");
    expect(globPrefix("src/{a,b}/x")).toBe("src/");
    expect(globPrefix("README.md")).toBe("README.md");
  });
});

describe("line shifts", () => {
  const outline: OutlineItem[] = [
    { name: "A", kind: "class", start: 1, end: 20 },
    { name: "a", kind: "method", start: 2, end: 5, parent: 0 },
    { name: "b", kind: "method", start: 7, end: 9, parent: 0 },
    { name: "c", kind: "method", start: 11, end: 19, parent: 0 },
    { name: "f", kind: "function", start: 22, end: 30 },
  ];
  it("moves lines below a change and leaves the change itself unplaced", () => {
    const ranges = [{ from: 8, to: 8, delta: 2 }, { from: 21, to: 20, delta: 1 }];
    expect([1, 7, 8, 9, 20, 21, 22].map((line) => mapLine(line, ranges))).toEqual([1, 7, undefined, 11, 22, 24, 25]);
  });
  it("drops symbols whose first or last line changed and re-parents their children", () => {
    const result = applyShifts(outline, [{ path: "x", mtime_ns: "1", ranges: [{ from: 1, to: 1, delta: 0 }] }]);
    expect(result?.dropped).toBe(1);
    expect(result?.outline.map((item) => `${item.name}${item.parent === undefined ? "" : `<${item.parent}`}`)).toEqual(["a", "b", "c", "f"]);
  });
  it("applies several edits in order", () => {
    const result = applyShifts(outline, [
      { path: "x", mtime_ns: "1", ranges: [{ from: 3, to: 3, delta: 5 }] },
      { path: "x", mtime_ns: "2", ranges: [{ from: 1, to: 0, delta: 1 }] },
    ]);
    expect(result?.outline.map((item) => `${item.name} ${item.start}-${item.end}`)).toEqual(["A 2-26", "a 3-11", "b 13-15", "c 17-25", "f 28-36"]);
  });
  it("an unknown edit gives no outline", () => {
    expect(applyShifts(outline, [{ path: "x", mtime_ns: "1", ranges: [], unknown: true }])).toBeUndefined();
  });
});

describe("changes that alter structure", () => {
  // The same cases as TestChangesNesting in native/index/index_test.go.
  const cases: Array<[string, string[], string[], boolean]> = [
    ["ts", [], ["  // note"], false],
    ["ts", [], ["  }", "", "  bar() {"], true],
    ["ts", [], ["  const x = 1;"], false],
    ["ts", [], ["  | 'feature'"], true],
    ["ts", ["    return a +"], ["    return b"], true],
    ["ts", [], ["@Injectable()"], true],
    ["rs", [], ["#[test]"], true],
    ["cs", [], ["    [Fact]"], true],
    ["js", [], ["  [1, 2].forEach(f)"], false],
    ["ts", [], ["  /**", "   * doc", "   */"], false],
    ["ts", ["  if (a) {"], ["  if (b) {"], true],
    ["ts", ["  call(a)"], ["  call(a, b)"], false],
    ["py", [], ["    x = 1"], true],
    ["py", [], ["    # comment", ""], false],
  ];
  it.each(cases)("%s %j -> %j is %s", (lang, removed, added, expected) => {
    expect(changesNesting(lang, removed, added)).toBe(expected);
  });
  it("a structural change drops the symbols around it and right next to it, and only those", () => {
    const nest = [{ from: 10, to: 9, delta: 3, nest: true }];
    expect(mapSpan(5, 20, nest)).toBeUndefined(); // holds it
    expect(mapSpan(5, 9, nest)).toBeUndefined(); // ends right before it
    expect(mapSpan(10, 12, nest)).toBeUndefined(); // starts right after it
    expect(mapSpan(1, 8, nest)).toEqual([1, 8]);
    expect(mapSpan(11, 12, nest)).toEqual([14, 15]);
    expect(mapSpan(5, 20, [{ from: 10, to: 9, delta: 3 }])).toEqual([5, 23]);
  });
});
