import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIndex } from "../../file-index/build.js";
import { runPendingInForeground } from "../../record/background.js";
import { openRecord } from "../../record/index.js";
import { realPath } from "../../record/project.js";
import { workingSetFile } from "../compute.js";
import { queueWorkingSetRequests, workingSetPending, workingSetPendingMarker, workingSetRequests } from "../job.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("working-set requests", () => {
  it("turn a hook's request into a job that writes the cache, with imports as hops", async () => {
    const base = mkdtempSync(join(tmpdir(), "mex-ws-job-"));
    vi.stubEnv("MEX_HOME", join(base, "home"));
    const checkout = join(base, "repo");
    mkdirSync(join(checkout, "src"), { recursive: true });
    git(base, "init", "-q", "-b", "main", "repo");
    writeFileSync(join(checkout, "src", "a.ts"), "import { b } from \"./b\";\nexport const a = b;\n");
    writeFileSync(join(checkout, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(checkout, "src", "c.ts"), "export const c = 1;\n");
    git(checkout, "add", "."); git(checkout, "commit", "-q", "-m", "start");
    writeFileSync(join(checkout, "src", "a.ts"), "import { b } from \"./b\";\nexport const a = b + 1;\n");

    let writer = openRecord({ projectPath: checkout });
    const projectId = writer.checkout(checkout)!.project_id;
    const records = writer.location.directory;
    writer.close();
    await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });

    // What the hook writes at session start.
    mkdirSync(workingSetRequests(records), { recursive: true });
    writeFileSync(join(workingSetRequests(records), `${projectId}~x.json`), JSON.stringify({ project: projectId, root: realPath(checkout) }));
    writeFileSync(join(workingSetRequests(records), "bad.json"), "{not json");
    writeFileSync(workingSetPendingMarker(records), "");
    expect(workingSetPending(records)).toBe(true);

    writer = openRecord({ projectPath: checkout });
    try {
      expect(queueWorkingSetRequests(writer)).toBe(1);
      expect(workingSetPending(records)).toBe(false);
      expect(await runPendingInForeground(writer, 120_000)).toBeGreaterThan(0);
    } finally { writer.close(); }
    const file = workingSetFile(records, projectId, realPath(checkout));
    expect(existsSync(file)).toBe(true);
    const set = JSON.parse(readFileSync(file, "utf8"));
    expect(set.seeds).toEqual(["src/a.ts"]);
    expect(set.hops).toEqual(["src/b.ts"]);
    expect(existsSync(join(workingSetRequests(records), "bad.json"))).toBe(false);
  });
});
