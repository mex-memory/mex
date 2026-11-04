import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriftStatusSchema } from "@mex/hub-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphAwareDriftReport } from "../../drift/index.js";
import type { DriftIssue } from "../../types.js";
import { summarizeDrift } from "../detect.js";
import { runDriftDetectionProcess } from "../detect-process.js";
import { selectSyncWork } from "../work.js";

function issue(code: DriftIssue["code"], severity: DriftIssue["severity"], file: string): DriftIssue {
  return { code, severity, file, line: null, message: code };
}

function report(issues: DriftIssue[], graph = "fresh"): GraphAwareDriftReport {
  return {
    score: 100,
    issues,
    filesChecked: 1,
    timestamp: "2026-11-04T12:00:00.000Z",
    graphStatus: { status: graph },
  } as unknown as GraphAwareDriftReport;
}

describe("selectSyncWork", () => {
  it("keeps grounding findings and files with an error, and leaves out warning-only files", () => {
    const grounding = issue("GROUNDING_DRIFT", "warning", "a.md");
    const error = issue("MISSING_PATH", "error", "b.md");
    const warningBesideError = issue("STALE_FILE", "warning", "b.md");
    const warningOnly = issue("STALE_FILE", "warning", "c.md");
    const work = selectSyncWork([grounding, error, warningBesideError, warningOnly]);
    expect(work.relevantIssues).toEqual([grounding, error, warningBesideError]);
    expect(selectSyncWork([warningOnly], true).relevantIssues).toEqual([warningOnly]);
  });

  it("never hands a notice to a session", () => {
    const notices = [
      issue("GROUNDING_MOVED", "info", "a.md"),
      issue("GROUNDING_MOVED_BY_NEIGHBORS", "info", "a.md"),
      issue("GROUNDING_NEARBY_DRIFT", "info", "a.md"),
      issue("GROUNDING_COMMENT_DRIFT", "info", "a.md"),
    ];
    const work = selectSyncWork(notices);
    expect(work.issues).toEqual([]);
    expect(work.relevantIssues).toEqual([]);
    expect(work.commentOnly).toEqual([notices[3]]);
  });
});

describe("summarizeDrift", () => {
  it("reports needs_sync only for findings sync acts on, per file", () => {
    const status = summarizeDrift(report([
      issue("MISSING_PATH", "error", "b.md"),
      issue("STALE_FILE", "warning", "b.md"),
      issue("GROUNDING_DRIFT", "warning", "a.md"),
      issue("STALE_FILE", "warning", "c.md"),
    ]));
    expect(DriftStatusSchema.parse(status)).toEqual({
      state: "needs_sync",
      checkedAt: "2026-11-04T12:00:00.000Z",
      issueCount: 3,
      fileCount: 2,
      files: [
        { path: "b.md", errors: 1, warnings: 1 },
        { path: "a.md", errors: 0, warnings: 1 },
      ],
      commentOnlyCount: 0,
      warningOnlyCount: 1,
      codeLinks: "checked",
    });
  });

  it("does not ask for a sync when only warnings or notices remain", () => {
    expect(summarizeDrift(report([issue("STALE_FILE", "warning", "c.md")]))).toMatchObject({
      state: "in_sync",
      warningOnlyCount: 1,
    });
    expect(summarizeDrift(report([issue("GROUNDING_MOVED", "info", "a.md")])).state).toBe("in_sync");
    expect(summarizeDrift(report([])).state).toBe("in_sync");
  });

  it("reports a comment review only when sync would offer one", () => {
    const comment = issue("GROUNDING_COMMENT_DRIFT", "info", "a.md");
    expect(summarizeDrift(report([comment]))).toMatchObject({ state: "comment_review", commentOnlyCount: 1 });
    // Sync stops at "only warnings remain" before it reaches the comment review.
    expect(summarizeDrift(report([comment, issue("STALE_FILE", "warning", "c.md")])).state).toBe("in_sync");
  });

  it("marks the check partial unless the graph is fresh", () => {
    expect(summarizeDrift(report([], "stale")).codeLinks).toBe("partial");
    expect(summarizeDrift(report([], "missing")).codeLinks).toBe("partial");
  });

  it("stays inside the contract when more files drift than it lists", () => {
    const issues = Array.from({ length: 150 }, (_, index) => issue("MISSING_PATH", "error", `${index}.md`));
    const status = DriftStatusSchema.parse(summarizeDrift(report(issues)));
    expect(status.fileCount).toBe(150);
    expect(status.files).toHaveLength(100);
  });
});

describe("runDriftDetectionProcess", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function script(source: string): { root: string; entrypoint: string } {
    const root = mkdtempSync(join(tmpdir(), "mex-drift-process-"));
    roots.push(root);
    const entrypoint = join(root, "entry.mjs");
    writeFileSync(entrypoint, source);
    return { root, entrypoint };
  }

  it("passes the project root and returns the parsed output", async () => {
    const { root, entrypoint } = script("process.stdout.write(JSON.stringify({ root: process.argv[2] }));");
    await expect(runDriftDetectionProcess(root, { entrypoint })).resolves.toEqual({ root });
  });

  it("turns telemetry off for the private process", async () => {
    const { root, entrypoint } = script("process.stdout.write(JSON.stringify({ telemetry: process.env.MEX_TELEMETRY }));");
    await expect(runDriftDetectionProcess(root, { entrypoint })).resolves.toEqual({ telemetry: "0" });
  });

  it("rejects a failed run and unreadable output", async () => {
    const failed = script("process.exitCode = 3;");
    await expect(runDriftDetectionProcess(failed.root, failed)).rejects.toThrow("exited with code 3");
    const unreadable = script("process.stdout.write('not json');");
    await expect(runDriftDetectionProcess(unreadable.root, unreadable)).rejects.toThrow("unreadable output");
  });

  it("stops a run that hangs or writes too much", async () => {
    const hung = script("setInterval(() => {}, 1000);");
    await expect(runDriftDetectionProcess(hung.root, { ...hung, timeoutMs: 200 })).rejects.toThrow("timed out");
    const flood = script("const chunk = 'x'.repeat(65536); const write = () => process.stdout.write(chunk, write); write();");
    await expect(runDriftDetectionProcess(flood.root, flood)).rejects.toThrow("too much output");
  }, 20_000);
});
