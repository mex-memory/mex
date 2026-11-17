import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { entriesFor, ruleFormat, scanRuleFiles } from "../rule-files.js";
import { sectionText, sections, textHash } from "../sections.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mex-rules-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const CLAUDE = `# Project

Intro line for the whole project.

## Testing

Run \`npm test\` before every commit.

## Style

Use date-fns, not moment, because moment is unmaintained.

<!-- mex-agent:skills:start -->
## MEX agent skills
- Read the router first.
<!-- mex-agent:skills:end -->
`;

describe("sections", () => {
  it("match the Go evaluator: subsections count, fences don't, setext headings work", () => {
    const text = "# A\n\none\n\n## B\n\ntwo\n\n```md\n## not a heading\n```\n\nC\n-\n\nthree\n";
    expect(sections(text).map(s => [s.heading, s.level])).toEqual([["A", 1], ["B", 2], ["C", 2]]);
    expect(sectionText(text, "A")).toContain("two");
    expect(sectionText(text, "B")).toContain("## not a heading");
    expect(sectionText(text, "C")?.trim()).toBe("three");
    expect(textHash("a\n\n  b ")).toBe(textHash("a b"));
  });
});

describe("rule files", () => {
  it("does not import a linked file or a tracked path behind a redirected folder", () => {
    const outside = repo({ "CLAUDE.md": "# Private\n\nOutside instructions.\n" });
    const root = repo({ "apps/api/CLAUDE.md": "# API\n\nOriginal instructions.\n" });
    execFileSync("git", ["-C", root, "add", "."]);
    rmSync(join(root, "apps/api"), { recursive: true });
    try {
      symlinkSync(outside, join(root, "apps/api"), process.platform === "win32" ? "junction" : "dir");
      symlinkSync(join(outside, "CLAUDE.md"), join(root, "AGENTS.md"));
    } catch { return; }
    expect(scanRuleFiles(root).files).toEqual([]);
    expect(scanRuleFiles(root).entries).toEqual([]);
  });
  it("knows each format", () => {
    expect(ruleFormat("CLAUDE.md")).toBe("claude");
    expect(ruleFormat("apps/api/AGENTS.md")).toBe("agents");
    expect(ruleFormat(".claude/rules/api.md")).toBe("claude-rules");
    expect(ruleFormat(".cursor/rules/ts.mdc")).toBe("cursor-rules");
    expect(ruleFormat(".github/instructions/db.instructions.md")).toBe("copilot-instructions");
    expect(ruleFormat("docs/README.md")).toBeUndefined();
  });

  it("turns sections into entries with section checks, skipping MEX's own blocks", () => {
    const root = repo({ "CLAUDE.md": CLAUDE, "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    const scan = scanRuleFiles(root, "2026-11-15");
    const lines = scan.entries.map(e => e.entry.mex.one_line);
    expect(lines).toEqual(["Project: Intro line for the whole project.", "Testing: Run npm test before every commit.", "Style: Use date-fns, not moment, because moment is unmaintained."]);
    expect(lines.join(" ")).not.toContain("router");
    const testing = scan.entries[1].entry;
    expect(testing.mex).toMatchObject({ kind: "rule", scope: ["**"], source: { type: "rule-file", ref: "CLAUDE.md" }, evidence: "docs" });
    expect(testing.mex.checks[0]).toMatchObject({ kind: "section", role: "complete", target: { file: "CLAUDE.md", heading: "Testing" }, saw: { hash: textHash(sectionText(CLAUDE, "Testing")!) } });
    // Ids are stable across edits to the body.
    const again = scanRuleFiles(repo({ "CLAUDE.md": CLAUDE.replace("before every commit", "before you push") }), "2026-11-15");
    expect(again.entries[1].entry.mex.id).toBe(testing.mex.id);
  });

  it("never takes a code block's language tag for the claim", () => {
    const rules = [
      "# Safe tests", "", "Run tests only with NODE_ENV=test.", "",
      "## Forbidden", "", "```bash", "# never: drops the dev database", "npx mocha 'src/**/*.spec.ts'", "```", "",
      "## Notes", "", "```", "pnpm i", "```", "", "Install first, then build.", "",
    ].join("\n");
    const lines = scanRuleFiles(repo({ "CLAUDE.md": rules }), "2026-11-17").entries.map(e => e.entry.mex.one_line);
    expect(lines).toContain("Forbidden: `npx mocha 'src/**/*.spec.ts'`");
    expect(lines).toContain("Notes: Install first, then build.");
    expect(lines.join(" ")).not.toMatch(/: bash\b/u);
  });

  it("keeps identifiers with underscores while dropping emphasis", () => {
    const rules = [
      "# Tests", "", "Never run tests without `NODE_ENV=test` **set**; it drops my_db.", "",
      "## Style", "", "Use _plain_ names and __never__ snake_case_ids in URLs.", "",
    ].join("\n");
    const lines = scanRuleFiles(repo({ "CLAUDE.md": rules }), "2026-11-17").entries.map(e => e.entry.mex.one_line);
    expect(lines).toContain("Tests: Never run tests without NODE_ENV=test set; it drops my_db.");
    expect(lines).toContain("Style: Use plain names and never snake_case_ids in URLs.");
  });

  it("tags who loads each file, so an agent only gets what it doesn't load", () => {
    const root = repo({
      "CLAUDE.md": "# Claude\n\nClaude only.\n",
      "AGENTS.md": "# Shared\n\nFor Codex and friends.\n",
      "apps/web/AGENTS.md": "# Web\n\nWeb rules.\n",
      ".cursor/rules/ts.mdc": "---\nglobs: src/**/*.ts, test/**/*.ts\n---\n# TS\n\nStrict mode on.\n",
      ".github/instructions/db.instructions.md": "---\napplyTo: \"db/**\"\n---\nUse migrations.\n",
      ".claude/rules/api.md": "---\npaths:\n  - apps/api/**\n---\n# API\n\nValidate input.\n",
    });
    const scan = scanRuleFiles(root);
    const by = (path: string) => scan.files.find(f => f.path === path)!;
    expect(by("CLAUDE.md").agents).toEqual(["claude-code"]);
    expect(by("AGENTS.md").agents).toEqual(["codex", "cursor", "copilot", "opencode"]);
    // The root CLAUDE.md means Claude Code reads no AGENTS.md, so their rules are passed to Claude.
    expect(by("apps/web/AGENTS.md")).toMatchObject({ agents: ["codex", "cursor", "copilot"], scope: ["apps/web/**"] });
    expect(entriesFor(scan, "claude-code").map(e => e.path)).toContain("apps/web/AGENTS.md");
    expect(scanRuleFiles(repo({ "apps/web/AGENTS.md": "# Web

Web rules.
" })).files[0]?.agents).toEqual(["claude-code", "codex", "cursor", "copilot"]);
    expect(by(".cursor/rules/ts.mdc").scope).toEqual(["src/**/*.ts", "test/**/*.ts"]);
    expect(by(".github/instructions/db.instructions.md").scope).toEqual(["db/**"]);
    expect(by(".claude/rules/api.md").scope).toEqual(["apps/api/**"]);
    expect(entriesFor(scan, "codex").map(e => e.path).sort()).toEqual([".claude/rules/api.md", ".cursor/rules/ts.mdc", ".github/instructions/db.instructions.md", "CLAUDE.md"]);
    expect(entriesFor(scan, "claude-code").map(e => e.path)).not.toContain("CLAUDE.md");
  });

  it("sends disagreements and stale mentions to Review", () => {
    const root = repo({
      "CLAUDE.md": "## Testing\n\nRun `npm test`.\n\n## Layout\n\nRoutes live in `src/routes/index.ts`.\n",
      "AGENTS.md": "## Testing\n\nRun `pnpm test:unit`.\n",
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    });
    const review = scanRuleFiles(root).review;
    expect(review).toContainEqual(expect.objectContaining({ kind: "conflict", heading: "Testing", paths: ["AGENTS.md", "CLAUDE.md"] }));
    expect(review).toContainEqual(expect.objectContaining({ kind: "stale", paths: ["AGENTS.md"], message: expect.stringContaining("pnpm test:unit") }));
    expect(review).toContainEqual(expect.objectContaining({ kind: "stale", message: "Mentions src/routes/index.ts, which doesn't exist." }));
  });

  it("reports only confident misses in a workspace: package scripts, scoped paths, installs and outputs", () => {
    const root = repo({
      "package.json": JSON.stringify({ scripts: { build: "turbo build" } }),
      "apps/api/package.json": JSON.stringify({ name: "@acme/api", scripts: { "lint:openapi": "x", "build:generate": "y" } }),
      "apps/api/e2e/setup.ts": "export {}\n",
      ".cursor/rules/api.mdc": [
        "---", "globs: apps/api/**/*", "---",
        "## Commands", "", "Run `npm run lint:openapi` and `pnpm --filter @acme/api build:generate`.", "",
        "## Setup", "", "Tests share `e2e/setup.ts`. Types come from `node_modules/next/dist/types.d.ts`.", "",
        "## Report", "", "Read `.cursor/report.json`; if missing, run `tool scan --write-report .cursor/report.json`.", "",
        "## Gone", "", "Use `pnpm tools:missing`. See `docs/removed/page.mdx`.", "",
      ].join("\n"),
    });
    const stale = scanRuleFiles(root).review.filter(r => r.kind === "stale").map(r => r.message);
    expect(stale).toEqual(['Names the command "pnpm tools:missing", which the repo doesn\'t define.', "Mentions docs/removed/page.mdx, which doesn't exist."]);
  });

  it("never reads back files MEX generated", () => {
    const root = repo({ ".claude/rules/mex-api.md": "<!-- mex:generated from .mex/learned -->\n# API\n\nGenerated.\n" });
    expect(scanRuleFiles(root).files).toEqual([]);
  });
});
