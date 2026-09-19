import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractClaims } from "../claims.js";
import { checkPaths } from "../checkers/path.js";

/**
 * Cases from issue #143 (MISSING_PATH false positives) plus the
 * version-shaped-ref case found on 0.8.x. Each scaffold is its own git
 * repository so `git check-ignore` resolves against the fixture rather than
 * whatever repository the temp directory happens to sit inside.
 */
function runScaffold(markdown: string, extraFiles: Record<string, string> = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "mex-drift-"));
  execFileSync("git", ["init", "-q"], { cwd: projectRoot });

  const scaffoldRoot = join(projectRoot, ".mex");
  mkdirSync(scaffoldRoot, { recursive: true });

  for (const [relative, contents] of Object.entries(extraFiles)) {
    const target = join(projectRoot, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }

  const docPath = join(scaffoldRoot, "ROUTER.md");
  writeFileSync(docPath, markdown);

  const claims = extractClaims(docPath, ".mex/ROUTER.md");
  return checkPaths(claims, projectRoot, scaffoldRoot);
}

const missingPaths = (markdown: string, extraFiles?: Record<string, string>) =>
  runScaffold(markdown, extraFiles)
    .filter((issue) => issue.code === "MISSING_PATH")
    .map((issue) => issue.claim?.value);

describe("MISSING_PATH false positives", () => {
  it("does not claim a file the document says was deleted (#143 defect 1)", () => {
    expect(
      missingPaths("# Changelog\n\n- Deleted orphaned files: `check_commands.js`\n")
    ).toEqual([]);
  });

  it("does not claim a bare trailing directory (#143 defect 2)", () => {
    expect(missingPaths("# Layout\n\n- Screenshots live in `screenshots/`\n")).toEqual([]);
  });

  it("does not claim a numeric delta (#143 defect 2)", () => {
    expect(missingPaths("# Rating\n\n- Net movement was `+12/-5` this week\n")).toEqual([]);
  });

  it("finds a file inside a dot-directory (#143 defect 3)", () => {
    expect(
      missingPaths("# CI\n\n- The workflow is `deploy.yml`\n", {
        ".github/workflows/deploy.yml": "name: deploy\n",
      })
    ).toEqual([]);
  });

  it("does not claim a version-shaped branch name", () => {
    expect(
      missingPaths(
        "# Release\n\n- Work landed on `release/2.1.0`, `python/3.11`, and `node/20.11`\n"
      )
    ).toEqual([]);
  });

  it("still claims a missing file with an alphabetic extension", () => {
    // Tightening the extension check must not treat `docs/foo.bar` as unrooted
    // prose: `.bar` is a file type, so the claim stays a missing path.
    expect(missingPaths("# Docs\n\n- See `docs/foo.bar`\n")).toEqual(["docs/foo.bar"]);
  });

  it("does not claim a pseudo-path pair such as overall/overall", () => {
    expect(missingPaths("# Stats\n\n- Rating shown as `overall/overall`\n")).toEqual([]);
  });

  it("does not claim middot-separated pseudo-paths", () => {
    expect(missingPaths("# Modes\n\n- Queues: `8ball/pro` · `9ball/pro`\n")).toEqual([]);
  });

  it("does not claim a glob", () => {
    expect(
      missingPaths("# Routes\n\n- Admin routes live in `web/routes/admin/*.js`\n")
    ).toEqual([]);
  });

  // Markdown wraps prose freely, so negation has to be scoped to the enclosing
  // paragraph. Scoping it to the raw line missed both of these.
  it("honours negation when the reference is on a continuation line", () => {
    expect(
      missingPaths(
        "# Cleanup\n\n- Deleted orphaned files during the sweep:\n  `check_commands.js`\n"
      )
    ).toEqual([]);
  });

  it("honours negation across a wrapped sentence", () => {
    expect(
      missingPaths("# Cleanup\n\n- The helper was removed, so\n  `legacy_client.py` is gone\n")
    ).toEqual([]);
  });

  it("still checks a directory reference rooted at a directory that exists", () => {
    // The trailing-separator change must not turn every documented directory
    // into prose: `.mex/local/` roots at a real directory and stays a claim.
    expect(missingPaths("# State\n\n- Local state lives in `.mex/local/`\n")).toEqual([
      ".mex/local/",
    ]);
  });
});
