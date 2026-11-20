import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openRecord } from "../../record/index.js";
import { enqueueJob, runOneBatch } from "../../record/jobs.js";
import { FAIL_PASS_KIND } from "../fail-pass-job.js";
import type { Proposal } from "../gate.js";
import { deliver, throughProducerPath, type ProducerPathOptions } from "./producer-path.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let suite: string, binary: string, base: string, options: ProducerPathOptions;

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-producer-path-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(suite, "case-")));
  const root = join(base, "repo"), home = join(base, "home");
  mkdirSync(root);
  git(base, "init", "-q", "repo");
  git(root, "config", "user.email", "t@example.test"); git(root, "config", "user.name", "T"); git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "vitest run" } }, null, 2));
  git(root, "add", "."); git(root, "commit", "-qm", "init");
  vi.stubEnv("MEX_HOME", home); vi.stubEnv("MEX_HOOK_BINARY", binary);
  options = { projectPath: root, home, binary };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

describe("a producer's entry, end to end", () => {
  // A stand-in producer: any registered producer with a complete check.
  const standIn: Proposal = { producer: "code-facts", key: "stand-in", kind: "fact", text: "Tests run with vitest through the test script.",
    source: { type: "mined", ref: "package.json" }, anchors: { scope: ["src/**"] }, model: "none", label: "stand-in producer, 1 of 1 checks",
    checks: [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }] };

  it("goes through propose to the personal store, holds in the native evaluator, and loads in Go with its label", async () => {
    const { results, verdicts, delivered } = await throughProducerPath([standIn], options);
    expect(results).toEqual([expect.objectContaining({ status: "accepted", change: "new" })]);
    const id = (results[0] as { entryId: string }).entryId;
    expect(verdicts.get(id)).toBe("held");
    expect(delivered).toEqual([{ id, verdict: "held", form: "full", text: "[stand-in producer, 1 of 1 checks] Tests run with vitest through the test script." }]);

    // When the code changes, the stored verdict follows and the entry is held back.
    writeFileSync(join(options.projectPath, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "jest" } }, null, 2));
    const later = deliver([id], options);
    expect(later.verdicts.get(id)).toBe("broken");
    expect(later.delivered).toEqual([{ id, verdict: "broken", form: "withheld" }]);
  });

  it("carries a fail-pass recipe from the journal to the Go snapshot", async () => {
    // Go creates hooks.db with its migrations; the rows are what the hook would write.
    deliver([], options);
    const writer = openRecord({ home: options.home, projectPath: options.projectPath });
    const checkout = writer.checkout(options.projectPath)!;
    const hooks = new DatabaseSync(join(writer.location.directory, "hooks.db"));
    try {
      hooks.prepare("INSERT INTO sessions VALUES('s','codex',?,?,?,?,0)").run(checkout.project_id, checkout.path, "2026-11-19T10:00:00Z", "2026-11-19T10:00:00Z");
      for (const [text, exit] of [["npm test", 1], ["TZ=UTC npm test", 0]] as const) {
        hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,exit_code) VALUES('s','2026-11-19T10:00:00Z','command',?,?)").run(text, exit);
      }
      const { job } = enqueueJob(writer, { kind: FAIL_PASS_KIND, projectId: checkout.project_id, params: { checkout: checkout.path } });
      await runOneBatch(writer, "producer-path-test", { only: new Set([job.id]) });
    } finally { hooks.close(); writer.close(); }
    const id = (await import("../producers.js")).producerEntryId("fail-pass", JSON.stringify(["variant", "npm test", "TZ=UTC npm test"]));
    const { delivered } = deliver([id], options);
    expect(delivered).toEqual([{ id, verdict: "unknown", form: "full",
      text: "[found by Codex] Run `TZ=UTC npm test`; without `TZ=UTC` it failed here (exit 1). In one session it failed, then passed with only the environment changed." }]);
  });
});
