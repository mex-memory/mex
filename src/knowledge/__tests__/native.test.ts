import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { serializeEntry } from "../entry.js";
import { rebuildNative } from "../native.js";
import { note } from "../store.js";
import { entry } from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const base = mkdtempSync(join(tmpdir(), "mex-rebuild-"));
  dirs.push(base);
  const root = join(base, "repo"), home = join(base, "home");
  execFileSync("git", ["init", "-q", "repo"], { cwd: base });
  vi.stubEnv("MEX_HOME", home);
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, ".mex", "learned"), { recursive: true });
  const rule = entry("mx_team01", { source: { type: "docs", ref: "README.md" }, evidence: "docs" }, "Releases go through the release workflow, because tags trigger publishing.");
  writeFileSync(join(root, "README.md"), "# Demo\n");
  writeFileSync(join(root, ".mex", "learned", "mx_team01.md"), serializeEntry(rule));
  return { root, home: join(home, ".mex") };
}

describe("rebuilding native files", () => {
  it("writes team entries shared and personal notes hidden, for the agents in use", () => {
    const { root } = setup();
    note({ text: "I prefer small commits, because they review faster." }, { projectPath: root });
    const result = rebuildNative({ projectPath: root });
    expect(result.agents).toEqual(["claude-code"]);
    expect(result.written?.sort()).toEqual([".claude/rules/mex-local.md", ".claude/rules/mex.md"]);
    expect(readFileSync(join(root, ".claude/rules/mex.md"), "utf8")).toContain("<!-- mx_team01 -->");
    expect(readFileSync(join(root, ".claude/rules/mex-local.md"), "utf8")).toContain("small commits");
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
  });

  it("waits while a session runs in the checkout, unless told to go now", () => {
    const { root, home } = setup();
    mkdirSync(join(home, "heartbeats", "claude-code"), { recursive: true });
    const beat = join(home, "heartbeats", "claude-code", "s1");
    writeFileSync(beat, JSON.stringify({ agent: "claude-code", session_id: "s1", cwd: root }));
    const now = new Date(); utimesSync(beat, now, now);
    const waiting = rebuildNative({ projectPath: root });
    expect(waiting.deferred?.agents).toEqual(["claude-code"]);
    expect(existsSync(join(root, ".claude/rules/mex.md"))).toBe(false);
    expect(rebuildNative({ projectPath: root }, { force: true }).written).toEqual([".claude/rules/mex.md"]);
  });

  it("shared only: the files that ride the same change as a team entry", () => {
    const { root } = setup();
    note({ text: "My own note, because reasons." }, { projectPath: root });
    expect(rebuildNative({ projectPath: root }, { sharedOnly: true }).written).toEqual([".claude/rules/mex.md"]);
  });
});

describe("the background rebuild", () => {
  it("runs as a job and writes the files", async () => {
    const { root } = setup();
    await import("../../record/job-kinds.js");
    const { openRecord } = await import("../../record/index.js");
    const { runPendingInForeground } = await import("../../record/background.js");
    const { queueNativeRebuild } = await import("../native-job.js");
    const writer = openRecord({ create: true, projectPath: root });
    try {
      const projectId = writer.checkout(root)!.project_id;
      queueNativeRebuild(writer, projectId, root);
      expect(await runPendingInForeground(writer, 20_000)).toBeGreaterThan(0);
      const row = writer.db.prepare("SELECT state, reason FROM jobs WHERE kind='native-files'").get() as { state: string };
      expect(row.state).toBe("done");
    } finally { writer.close(); }
    expect(readFileSync(join(root, ".claude/rules/mex.md"), "utf8")).toContain("mx_team01");
  }, 60_000);
});
