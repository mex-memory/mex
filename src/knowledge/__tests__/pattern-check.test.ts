import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../../file-index/build.js";
import { knowledgeProject } from "../context.js";
import { checkPatterns, keptPatterns, PATTERN_CHECK_MAX, type PatternCandidate } from "../pattern-check.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const moment: PatternCandidate = { type: "anti", match: "literal", pattern: "from 'moment'", objected: "import m from 'moment'", fixed: "import { format } from 'date-fns'" };
const logging: PatternCandidate = { type: "anti", match: "structural", pattern: "console.log($$$)", objected: "console.log(x)", fixed: "logger.info(x)" };

describe("pattern self-check without the native binary", () => {
  it("keeps no pattern when the check can't run", () => {
    const options = { projectPath: tmpdir(), env: { ...process.env, MEX_HOOK_BINARY: join(tmpdir(), "no-such-mex-hook") } };
    expect(checkPatterns([moment], ["**"], options)).toBeNull();
    expect(keptPatterns([moment], null)).toEqual([]);
    expect(checkPatterns([], ["**"], options)).toEqual([]);
    expect(checkPatterns(Array(PATTERN_CHECK_MAX + 1).fill(moment), ["**"], options)).toBeNull();
  });

  it("keeps only the candidates the check kept, without their review text", () => {
    const verdicts = [{ keep: true, reason: "ok", files: 3, matched: 0 }, { keep: false, reason: "common", files: 3, matched: 2 }];
    expect(keptPatterns([moment, logging], verdicts)).toEqual([{ type: "anti", match: "literal", pattern: "from 'moment'" }]);
  });
});

const enabled = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"]).status === 0;

describe.skipIf(!enabled)("pattern self-check with the native binary", () => {
  let binary: string;
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "mex-pattern-check-bin-")); roots.push(base);
    binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve(__dirname, "../../../native"), timeout: 240_000, stdio: "pipe" });
  }, 300_000);

  it("drops a pattern the area already uses and keeps a rare one", async () => {
    const base = mkdtempSync(join(tmpdir(), "mex-pattern-check-")); roots.push(base);
    const root = join(base, "repo"); mkdirSync(join(root, "apps/api"), { recursive: true });
    execFileSync("git", ["init", "-q", root]);
    const files: Record<string, string> = {
      "apps/api/a.ts": "import { format } from 'date-fns'\n",
      "apps/api/b.ts": "export const b = 1\n",
      "apps/api/c.ts": "console.log('debug')\n",
      "apps/api/d.ts": "console.log('more')\n",
      "apps/api/e.ts": "console.log('again')\n",
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    const options = { projectPath: root, env: { ...process.env, MEX_HOME: join(base, "home"), MEX_HOOK_BINARY: binary } };
    const project = knowledgeProject(options);
    await buildIndex({ root, projectId: project.projectId, recordDirectory: project.location.directory, workers: 0 });

    const verdicts = checkPatterns([moment, logging], ["apps/api/**"], options);
    expect(verdicts?.map(v => [v.keep, v.files, v.matched])).toEqual([[true, 5, 0], [false, 5, 3]]);
    expect(keptPatterns([moment, logging], verdicts)).toEqual([{ type: "anti", match: "literal", pattern: "from 'moment'" }]);
  }, 60_000);
});
