import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPaths } from "../checkers/path.js";
import type { Claim } from "../../types.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-ignore-batch-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, ".mex"));
  writeFileSync(join(root, ".gitignore"), ".mex/graph.db\n.mex/local/\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("batched ignore checks", () => {
  it.each([
    "/index.html",
    "\\index.html",
    "C:/index.html",
    "C:\\index.html",
    "C:index.html",
    "../outside.html",
    "nested/../../outside.html",
    "nested\\..\\..\\outside.html",
  ])("keeps ignored state out of findings when the batch includes %s", (outside) => {
    const values = [outside, ".mex/graph.db", ".mex/local/", "about/index.html"];
    const claims: Claim[] = values.map((value) => ({
      kind: "path", value, source: ".mex/guide.md", line: 1,
      section: "Paths", negated: false,
    }));
    const issues = checkPaths(claims, root, join(root, ".mex"));
    expect(issues.map((issue) => issue.claim?.value)).toEqual([
      ...(outside === "/index.html" ? [] : [outside]), "about/index.html",
    ]);
  });

  it("still checks relative paths with parent segments contained in the root", () => {
    const claims: Claim[] = [{
      kind: "path", value: ".mex/../.mex/graph.db", source: ".mex/guide.md",
      line: 1, section: "Paths", negated: false,
    }];
    expect(checkPaths(claims, root, join(root, ".mex"))).toEqual([]);
  });
});
