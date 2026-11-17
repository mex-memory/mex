import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord } from "../index.js";
import { registerJobKind } from "../jobs.js";
import { runJobsAction, runJobsList } from "../jobs-command.js";

registerJobKind({ name: "test-cli", label: "Test work", scope: "project", sideEffects: "none", runBatch: () => ({ checkpoint: 1, done: true }) });

let lines: string[];
beforeEach(() => {
  vi.stubEnv("MEX_HOME", mkdtempSync(join(tmpdir(), "mex-jobs-cli-")));
  vi.stubEnv("MEX_BACKGROUND", "0");
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const writer = openRecord({ isNetwork: () => false });
  try {
    writer.db.prepare("INSERT INTO projects(id,root_path,kind,created_at) VALUES('f-a','/work/repo-a','folder','2026')").run();
    writer.db.prepare("INSERT INTO projects(id,root_path,kind,created_at) VALUES('f-b','/work/repo-b','folder','2026')").run();
    const insert = writer.db.prepare(`INSERT INTO jobs(id,project_id,kind,state,reason,progress,results,tokens_used,created_at,updated_at)
      VALUES(?,?,'test-cli',?,?,?,?,0,?,?)`);
    insert.run("old", "f-a", "done", null, "12 / 12 parsed", 12, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    insert.run("mid", "f-b", "waiting", "Paused: Claude Code is logged out", "batch 2 of 5", 1, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z");
    insert.run("new", "f-a", "queued", null, null, 0, "2026-01-03T00:00:00Z", "2026-01-03T00:00:00Z");
  } finally { writer.close(); }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("mex jobs", () => {
  it("prints every job on the machine, newest first, and says when the background process is off", () => {
    runJobsList({});
    const text = lines.join("\n");
    expect(lines[0]).toBe("Background: off. Run waiting jobs here with `mex jobs run`.");
    expect(text.indexOf("repo-a (/work/repo-a)\n    queued")).toBeLessThan(text.indexOf("repo-b"));
    expect(text).toContain("waiting: Paused: Claude Code is logged out · batch 2 of 5 · 1 result so far");
    expect(text).toContain(" 3  Test work · repo-a (/work/repo-a)\n    done · 12 results");
    expect(text).not.toContain("12 / 12 parsed");
  });
  it("prints the same rows as JSON for tools, without internal ids", () => {
    runJobsList({ json: true });
    const out = JSON.parse(lines.join("\n"));
    expect(out.background).toMatchObject({ running: false, enabled: false });
    expect(out.jobs.map((job: { position: number; state: string }) => [job.position, job.state])).toEqual([[1, "queued"], [2, "waiting"], [3, "done"]]);
    expect(JSON.stringify(out)).not.toMatch(/"id"|"old"|"mid"|"new"/);
  });
  it("pauses, resumes and cancels by list number", () => {
    runJobsAction("pause", "1");
    expect(lines.at(-1)).toBe("Test work in repo-a is paused.");
    runJobsAction("resume", "#1");
    expect(lines.at(-2)).toBe("Test work in repo-a is queued.");
    runJobsAction("cancel", "2");
    expect(lines.at(-1)).toBe("Test work in repo-b is cancelled.");
    expect(() => runJobsAction("cancel", "9")).toThrow("There is no job 9 in `mex jobs`.");
  });
  it("says so when there are no jobs yet", () => {
    vi.stubEnv("MEX_HOME", mkdtempSync(join(tmpdir(), "mex-jobs-empty-")));
    runJobsList({});
    expect(lines).toEqual(["Background: not started yet.", "No jobs yet."]);
  });
});
