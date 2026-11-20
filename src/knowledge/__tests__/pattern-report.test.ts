import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { knowledgeProject } from "../context.js";
import { serializeEntry } from "../entry.js";
import { formatPatternReport, patternReport } from "../pattern-report.js";
import { entry } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());

const anti = (pattern: string) => [{ type: "anti" as const, match: "literal" as const, pattern }];

function repo() {
  const base = mkdtempSync(join(tmpdir(), "mex-pattern-report-")); roots.push(base);
  const root = join(base, "repo"); mkdirSync(join(root, ".mex", "learned"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  vi.stubEnv("MEX_HOME", join(base, "home"));
  const options = { projectPath: root };
  const team = (id: string, over: Parameters<typeof entry>[1], text: string) =>
    writeFileSync(join(root, ".mex", "learned", `${id}.md`), serializeEntry(entry(id, over, text)));
  const monitor = (entries: Record<string, unknown>) => {
    const project = knowledgeProject(options);
    const dir = join(project.location.directory, "projects", project.projectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pattern-monitor.json"), JSON.stringify({ version: 1, entries }));
  };
  return { options, team, monitor };
}

// Team entries pass the secret and evidence gates, which call git per
// entry: slow on a busy machine, hence the longer timeouts.
describe("pattern monitoring in mex report", () => {
  it("lists patterns silent for 90 days and the ones in the digest", () => {
    const { options, team, monitor } = repo();
    const now = new Date("2026-11-19T12:00:00Z");
    team("mx_silent", { created: "2026-06-01", when: anti("legacyCall(") }, "Don't call legacyCall, because it was replaced.");
    team("mx_firedx", { created: "2026-06-01", when: anti("moment(") }, "Use date-fns, because moment is unmaintained.");
    team("mx_younger", { created: "2026-10-01", when: anti("oldApi(") }, "Use newApi, because oldApi is gone.");
    team("mx_nopatt", { created: "2026-06-01" }, "Keep handlers small, because they are hard to test.");
    team("mx_digest", { created: "2026-06-01", when: anti("console.log(") }, "Log through the logger, because logs are shipped.");
    team("mx_oldfire", { created: "2026-01-01", when: anti("var ") }, "Use const, because var hoists.");
    monitor({
      mx_firedx: { last_fired: "2026-11-10", window: "2026-11-01", fired: 2, violations: 1 },
      mx_digest: { last_fired: "2026-11-18", window: "2026-11-01", fired: 12, violations: 0 },
      mx_oldfire: { last_fired: "2026-07-01", window: "2026-07-01", fired: 1, violations: 0 },
    });
    const report = patternReport(options, now);
    // Never fired, or last fired before the 90 days; too-young and
    // pattern-less entries are left out.
    expect(report.silent.map(row => row.id)).toEqual(["mx_silent", "mx_oldfire"]);
    expect(report.silent[1]?.last_fired).toBe("2026-07-01");
    expect(report.digest.map(row => row.id)).toEqual(["mx_digest"]);
    const lines = formatPatternReport(report).join("\n");
    expect(lines).toContain("haven't fired in 90 days");
    expect(lines).toContain("mx_silent Don't call legacyCall, because it was replaced. (last fired never)");
    expect(lines).toContain("area digest");
  }, 60_000);

  it("says nothing without patterns, and survives a broken monitor file", () => {
    const { options, team, monitor } = repo();
    team("mx_nopatt", { created: "2026-01-01" }, "Keep handlers small, because they are hard to test.");
    monitor({ mx_nopatt: "not an object" });
    const report = patternReport(options, new Date("2026-11-19T12:00:00Z"));
    expect(report).toEqual({ silent: [], digest: [] });
    expect(formatPatternReport(report)).toEqual([]);
  }, 60_000);
});
