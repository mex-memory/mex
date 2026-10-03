import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, runDriftCheck } from "../src/index.js";
import { commitsTouchingPathsSinceLastChange } from "../src/git.js";
import { isTemplateOwnedScaffoldFile, stalenessReferencedPaths } from "../src/drift/checkers/staleness.js";
import type { Claim, MexConfig } from "../src/types.js";

// #237: STALE_FILE counted every repository commit, so on an active repository
// it outnumbered real drift and drove the score to 0.

let root: string;
let config: MexConfig;
const today = new Date().toISOString().slice(0, 10);

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    stdio: "ignore",
  });
}

function write(path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commitTo(path: string, times: number): void {
  for (let index = 0; index < times; index += 1) {
    write(path, `export const v = ${index};\n`);
    git("add", "-A");
    git("commit", "-q", "-m", `${path} ${index}`);
  }
}

function doc(body: string): string {
  return `---\nname: doc\ndescription: a doc\nlast_updated: ${today}\n---\n\n# Doc\n\n${body}\n`;
}

function claim(value: string, negated = false): Claim {
  return { kind: "path", value, source: ".mex/context/stack.md", line: 1, section: null, negated };
}

async function staleFiles(): Promise<Record<string, string>> {
  const report = await runDriftCheck(config, { graphWarning: () => {} });
  return Object.fromEntries(report.issues
    .filter((issue) => issue.code === "STALE_FILE")
    .map((issue) => [issue.file, issue.message]));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-stale-scope-"));
  git("init", "-q");
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "export const b = 1;\n");
  write(".mex/context/stack.md", doc("The entry point is `src/a.ts`."));
  write(".mex/context/conventions.md", doc("Prefer small modules and explicit names everywhere."));
  write(".mex/patterns/README.md", doc("How to write a pattern."));
  git("add", "-A");
  git("commit", "-q", "-m", "scaffold");
  config = createConfig({
    projectRoot: root,
    scaffoldRoot: join(root, ".mex"),
    stalenessThresholds: { warnDays: 30, errorDays: 90, warnCommits: 2, errorCommits: 10 },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("STALE_FILE counts only commits to what a file describes (#237)", () => {
  it("ignores commits to code no scaffold file references", async () => {
    commitTo("src/b.ts", 5);
    expect(await staleFiles()).toEqual({});
  });

  it("counts commits to a referenced path", async () => {
    commitTo("src/b.ts", 3);
    commitTo("src/a.ts", 2);
    expect(await staleFiles()).toEqual({
      ".mex/context/stack.md": "2 commits to referenced paths since file was last updated (threshold: 2)",
    });
  });

  it("counts commits to the committed file of grounded code", async () => {
    write(".mex/context/conventions.md", doc("Prefer small modules.").replace(
      "---\n\n",
      "grounds_to:\n  - node: function:0123456789abcdef\n    fingerprint: mh2:64:AAAA\n    file: src/b.ts\n---\n\n",
    ));
    git("add", "-A");
    git("commit", "-q", "-m", "ground conventions");
    commitTo("src/b.ts", 2);
    expect((await staleFiles())[".mex/context/conventions.md"]).toBe(
      "2 commits to referenced paths since file was last updated (threshold: 2)",
    );
  });

  it("judges a file that references nothing by age alone", async () => {
    commitTo("src/a.ts", 5);
    const stale = await staleFiles();
    expect(stale[".mex/context/conventions.md"]).toBeUndefined();
  });

  it("never reports template-owned scaffold files", async () => {
    write(".mex/patterns/README.md", doc("Moved to `src/a.ts`.").replace(today, "2020-01-01"));
    git("add", "-A");
    git("commit", "-q", "-m", "readme");
    commitTo("src/a.ts", 5);
    expect(Object.keys(await staleFiles())).toEqual([".mex/context/stack.md"]);
  });

  it("still reports a file whose last_updated is old", async () => {
    write(".mex/context/conventions.md", doc("Prefer small modules.").replace(today, "2020-01-01"));
    git("add", "-A");
    git("commit", "-q", "-m", "conventions");
    expect((await staleFiles())[".mex/context/conventions.md"]).toContain("last_updated is");
  });
});

describe("commitsTouchingPathsSinceLastChange", () => {
  it("counts commits after the file's last change that touched a pathspec", async () => {
    commitTo("src/a.ts", 2);
    commitTo("src/b.ts", 4);
    const file = ".mex/context/stack.md";
    expect(await commitsTouchingPathsSinceLastChange(file, ["src/a.ts"], root)).toBe(2);
    expect(await commitsTouchingPathsSinceLastChange(file, ["src/"], root)).toBe(6);
    expect(await commitsTouchingPathsSinceLastChange(file, ["*/b.ts"], root)).toBe(4);
    expect(await commitsTouchingPathsSinceLastChange(file, ["never/existed.ts"], root)).toBe(0);
    expect(await commitsTouchingPathsSinceLastChange(file, [], root)).toBe(0);
  });

  it("returns null for a file git has never seen", async () => {
    expect(await commitsTouchingPathsSinceLastChange("untracked.md", ["src/a.ts"], root)).toBeNull();
  });
});

describe("stalenessReferencedPaths", () => {
  const scaffoldFiles = new Set([".mex/context/stack.md", ".mex/ROUTER.md"]);
  const derive = (claims: Claim[], groundedFiles: string[] = []) => stalenessReferencedPaths({
    claims,
    groundedFiles,
    projectRoot: root,
    scaffoldRoot: join(root, ".mex"),
    scaffoldFiles,
  });

  it("takes non-negated path claims and grounded files", () => {
    expect(derive([claim("./src/a.ts"), claim("src/old.ts", true)], ["src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("drops scaffold knowledge, URLs, and paths that would match everything", () => {
    expect(derive([
      claim("context/stack.md"),
      claim(".mex/patterns/"),
      claim("ROUTER.md"),
      claim("https://example.com/x"),
      claim("."),
      claim("../outside.ts"),
      claim("/etc/hosts"),
      claim(":(glob)**"),
    ])).toEqual([]);
  });

  it("matches a bare filename at any depth", () => {
    expect(derive([claim("tsconfig.json")])).toEqual(["*/tsconfig.json", "tsconfig.json"]);
  });

  it("recognizes template-owned files by scaffold-relative path", () => {
    expect(isTemplateOwnedScaffoldFile("patterns/INDEX.md")).toBe(true);
    expect(isTemplateOwnedScaffoldFile("patterns\\README.md")).toBe(true);
    expect(isTemplateOwnedScaffoldFile("context/stack.md")).toBe(false);
  });
});
