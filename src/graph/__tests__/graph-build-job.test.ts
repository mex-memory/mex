/**
 * The code map job setup queues (contracts/setup-jobs.md): it builds the graph
 * in the background, says "N of M files" while reading code, and ends with a
 * plain summary. A second run finds the map current.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { runOneBatch, type JobRow } from "../../record/jobs.js";
import "../../record/job-kinds.js";
import { graphBuildProgress } from "../jobs.js";
import { queueGraphBuild } from "../queue.js";
import { readGraphPointer, graphLocation } from "../storage.js";

describe("the code map job", () => {
  let root: string, checkout: string, writer: RecordWriter, projectId: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mex-graph-build-job-"));
    vi.stubEnv("MEX_HOME", join(root, "home"));
    checkout = join(root, "repo");
    mkdirSync(join(checkout, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: checkout });
    writeFileSync(join(checkout, "src", "a.ts"), "export function a(): number {\n  return 1;\n}\n");
    writeFileSync(join(checkout, "src", "b.ts"), "import { a } from \"./a\";\nexport const b = () => a() + 1;\n");
    writer = openRecord({ projectPath: checkout });
    projectId = writer.checkout(checkout)!.project_id;
  });

  afterAll(() => {
    writer?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const job = (id: string) => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow;
  const summary = (id: string) => (writer.db.prepare("SELECT summary FROM job_results WHERE job_id=? ORDER BY rowid DESC LIMIT 1").get(id) as { summary: string } | undefined)?.summary;

  it("builds the map in the background and says what it did", async () => {
    const id = queueGraphBuild(writer, projectId, checkout);
    // Queued twice, it's the same job.
    expect(queueGraphBuild(writer, projectId, checkout)).toBe(id);
    await runOneBatch(writer, "test", { only: new Set([id]) });
    expect(job(id).state).toBe("done");
    expect(summary(id)).toMatch(/^Code map built: 2 files, \d+ definitions$/u);
    expect(readGraphPointer(graphLocation(checkout))?.base).toMatch(/^graph-base-/u);
  }, 180_000);

  it("finds the map current the second time", async () => {
    const id = queueGraphBuild(writer, projectId, checkout);
    await runOneBatch(writer, "test", { only: new Set([id]) });
    expect(job(id).state).toBe("done");
    expect(summary(id)).toBe("The code map was already current");
  }, 180_000);

  it("reports progress the way the file index does", () => {
    expect(graphBuildProgress({ phase: "parse", completed: 1200, total: 4500 })).toBe("1,200 of 4,500 files");
    expect(graphBuildProgress({ phase: "resolve" })).toBe("connecting calls and imports");
  });
});
