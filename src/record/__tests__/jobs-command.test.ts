import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord } from "../index.js";
import { listJobs, registerJobKind } from "../jobs.js";
import { renderJobs, runCancel, runJobsAction, runJobsList } from "../jobs-command.js";
import { Rich } from "../../repo-start/rich.js";
import { stripVTControlCharacters } from "node:util";

registerJobKind({ name: "test-cli", label: "Test work", scope: "project", sideEffects: "none", runBatch: () => ({ checkpoint: 1, done: true }),
  details: () => "Additional detail about this run.",
});

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
  it("shows the latest run per repo, and keeps the original job number in history", async () => {
    await runJobsList({});
    const text = lines.join("\n");
    expect(lines[0]).toBe("Background: off · run waiting jobs here with mex jobs run");
    expect(text).toMatch(/repo-a  \/work\/repo-a\n\s+1 \.\. Test work\s+queued[\s\S]+repo-b/u);
    expect(text).toContain("waiting · Paused: Claude Code is logged out · batch 2 of 5 · 1 result so far");
    expect(text).not.toMatch(/\b3 ok Test work/u);
    expect(text).not.toContain("12 / 12 parsed");
    expect(text).not.toContain("Additional detail");
    await runJobsList({ all: true, details: true });
    const history = lines.join("\n");
    expect(history).toMatch(/repo-a  \/work\/repo-a\n\s+1 \.\. Test work\s+queued\n[^\n]+\n\s+3 ok Test work\s+\d+ h ago · 12 results/u);
    expect(history).toContain("Additional detail about this run.");
  });
  it("prints the same rows as JSON for tools, without internal ids", async () => {
    await runJobsList({ json: true });
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
  it("says so when there are no jobs yet", async () => {
    vi.stubEnv("MEX_HOME", mkdtempSync(join(tmpdir(), "mex-jobs-empty-")));
    await runJobsList({});
    expect(lines).toEqual(["Background: not started yet.", "No jobs yet."]);
  });
  it("shows running and queued work before newer ended jobs, and colours commands", () => {
    const writer = openRecord();
    try {
      const items = listJobs({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never }, -1, { latest: true });
      const [queued, waiting] = items;
      const running = { ...queued!, position: 5, state: "running" as const };
      const done = { ...queued!, position: 2, state: "done" as const, finishedAt: "2026-01-03T00:00:00Z", summary: "453 files" };
      const fresh = { ...done, position: 3, finishedAt: "2026-01-03T00:02:30Z", summary: "12 files" };
      const rich = new Rich();
      const lines = renderJobs([queued!, done, fresh, waiting!, running], { enabled: false, running: false }, {
        rich, now: Date.parse("2026-01-03T00:03:00Z"),
      });
      const rendered = lines.map(stripVTControlCharacters).join("\n");
      expect(lines[0]).toContain(rich.cmd("mex jobs run"));
      expect(rendered).toMatch(/MEX JOBS[\s\S]+repo-a  \/work\/repo-a[\s\S]+repo-b  \/work\/repo-b/u);
      expect(rendered).toMatch(/5 ◐ Test work\s+running[^\n]*\n\s+1 ◌ Test work\s+queued\n\s+3 ✓ Test work\s+just now · 12 files\n\s+2 ✓ Test work\s+3 min ago · 453 files/u);
      expect(lines.slice(-3, -1).map(stripVTControlCharacters)).toEqual([
        "   mex cancel stops running jobs in this repo · mex jobs cancel <n> stops one",
        "   --all shows history · --details shows notes",
      ]);
    } finally { writer.close(); }
  });
  it("requires --yes in a script and cancels every live job with it", async () => {
    expect(await runCancel({ all: true })).toBe(1);
    expect(lines.at(-1)).toBe("Pass --yes to confirm: mex cancel --all --yes");
    expect(await runCancel({ all: true, yes: true })).toBe(0);
    expect(lines).toContain("Stopped test work in repo-a.");
    expect(lines).toContain("Stopped test work in repo-b.");
    expect(await runCancel({ all: true, yes: true })).toBe(0);
    expect(lines.at(-1)).toBe("No live jobs on this computer.");
  });
});
