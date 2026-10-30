import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractClaims } from "../claims.js";
import { checkPaths } from "../checkers/path.js";
import { checkCommands } from "../checkers/command.js";

let root: string;
function write(file: string, content: string) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function claims(markdown: string) {
  write(".mex/guide.md", markdown);
  return extractClaims(join(root, ".mex/guide.md"), ".mex/guide.md");
}
function missing(markdown: string) {
  return checkPaths(claims(markdown), root, join(root, ".mex")).map((issue) => issue.claim!.value);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-references-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reference context", () => {
  it("excludes explicit compound suffixes while retaining file typos", () => {
    expect(missing("Published `.d.ts`; same name plus `.test.ts` or `.test.tsx`. Use `READNE.md` and `src/typo.ts`."))
      .toEqual(["READNE.md", "src/typo.ts"]);
  });
  it("requires sibling receiver notation or an explicit method signature", () => {
    expect(missing("Response methods (`c.text`, `c.json`, `c.html`, `c.res`).\n\n`Context#html()` (`c.html`) resolves callbacks."))
      .toEqual([]);
    expect(missing("Read `c.html`, `report.json` and `READNE.md`."))
      .toEqual(["c.html", "report.json", "READNE.md"]);
    expect(missing("Read `c.html`.\n\nElsewhere `c.text` is a method."))
      .toEqual(["c.html"]);
    expect(missing("Files `note.html` and `note.text`."))
      .toEqual(["note.html"]);
  });
  it("accepts exact quoted missing paths in tracked production source only", () => {
    write("build/build.ts", "const excluded = ['src/mod.ts', 'src/longer.ts.backup'];");
    write("src/app.test.ts", "const sample = 'src/test-only.ts';");
    write("src/legacy.ts", "export {};");
    write("README.md", "`src/doc-only.ts`");
    execFileSync("git", ["add", "build", "src", "README.md"], { cwd: root });
    unlinkSync(join(root, "src/legacy.ts"));
    write("build/untracked.ts", "const excluded = 'src/untracked.ts';");
    expect(missing("The build names `src/mod.ts`.\n\nUse `src/longer.ts`.\n\nUse `src/test-only.ts`.\n\nUse `src/doc-only.ts`.\n\nUse `src/untracked.ts`.\n\nUse `src/legacy.ts`."))
      .toEqual(["src/longer.ts", "src/test-only.ts", "src/doc-only.ts", "src/untracked.ts", "src/legacy.ts"]);
  });
  it("checks every compact script alternative and reports the missing one", () => {
    write("package.json", JSON.stringify({ scripts: { "test:node": "", "test:web": "", "test:edge": "" } }));
    expect(checkCommands(claims("`bun run test:node|test:web|test:edge`"), root)).toEqual([]);
    const issues = checkCommands(claims("`bun run test:node|test:missing|test:web`"), root);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"test:missing"');
  });
  it("does not reinterpret shell pipelines or double pipes as script lists", () => {
    write("package.json", JSON.stringify({ scripts: { "test:node": "" } }));
    expect(checkCommands(claims("`bun run test:node | cat`"), root)).toEqual([]);
    expect(checkCommands(claims("`bun run test:node||missing`"), root)[0].message).toContain('"test:node||missing"');
  });
});
