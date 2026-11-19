import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ruleFindings } from "../command.js";
import { scanRuleFiles } from "../../knowledge/rule-files.js";

it("reuses stale and conflicting review rows, locating at most three inline", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-screen-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"vitest"}}');
  writeFileSync(join(root, "CLAUDE.md"), '# Tests\nUse `npm run missing`.\nUse `src/gone.ts`.\nUse `src/old.ts`.\nUse `src/older.ts`.\n');
  writeFileSync(join(root, "AGENTS.md"), '# Tests\nUse `npm test`.\n');
  const cache = scanRuleFiles(root);
  const findings = ruleFindings(cache, root);
  expect(findings[0].state).toBe("attention");
  expect(findings[0].details).toHaveLength(4);
  expect(findings[0].details![0]).toContain("AGENTS.md:1, CLAUDE.md:1");
  expect(findings[0].details![1]).toContain("CLAUDE.md:2");
  expect(findings[0].details![2]).toContain("CLAUDE.md:3");
  expect(findings[0].details![3]).toBe("… and 2 more: mex rules");
  expect(findings.at(-1)!.text).not.toContain("they agree");
});

it("says rule files agree only when there is no review", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-screen-"));
  writeFileSync(join(root, "AGENTS.md"), '# Tests\nRun the tests.\n');
  expect(ruleFindings(scanRuleFiles(root), root)).toEqual([{ state: "ok", text: "1 rule file read (AGENTS.md); they agree" }]);
});
