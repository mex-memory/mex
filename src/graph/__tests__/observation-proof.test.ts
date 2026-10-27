import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../engine-impl.js";
import { loadFreshGraphReadSession } from "../read-session.js";
import { inspectGraphStatusWithFreshObservation, revalidateGraphReadObservation } from "../status.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(withGit = false): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mex-observation-proof-")); roots.push(root);
  writeFileSync(join(root, "source.py"), "def value():\n    return 1\n");
  if (withGit) {
    writeFileSync(join(root, ".gitignore"), ".mex/\n");
    for (const args of [["init", "-b", "fixture"], ["add", "."], ["commit", "-m", "fixture"]]) {
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { cwd: root, stdio: "pipe" });
    }
  }
  const fixed = new Date(1_700_000_000_000); utimesSync(join(root, "source.py"), fixed, fixed);
  const engine = createGraphEngine({ rootDir: root }); try { await engine.build(); } finally { engine.close(); }
  return root;
}
describe("bound final freshness proof", () => {
  it("runs two initial source proofs and one independent final proof", async () => {
    const root = await fixture(); const passes: string[] = [];
    const inspection = await inspectGraphStatusWithFreshObservation({ projectRoot: root, internal: {
      afterSourceRead: (_path, pass) => { passes.push(pass); },
    } });
    expect(inspection.graphStatus.status).toBe("fresh");
    expect(passes).toEqual(["initial", "validation"]);
    const result = await revalidateGraphReadObservation(inspection.freshObservation!);
    expect(result!.graphStatus.status).toBe("fresh");
    expect(passes).toEqual(["initial", "validation", "validation"]);
  });
  it("preserves fresh verdicts across non-source commits and dirty changes", async () => {
    const root = await fixture(true);
    const fast = await loadFreshGraphReadSession(root);
    const full = await loadFreshGraphReadSession(root, { inspectObservation: inspectGraphStatusWithFreshObservation });
    try {
      writeFileSync(join(root, "notes.md"), "notes");
      expect((await fast.session!.revalidateFreshness()).valid).toBe(true);
      expect((await full.session!.revalidateFreshness()).valid).toBe(true);
      for (const args of [["add", "notes.md"], ["commit", "-m", "notes"]]) {
        execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { cwd: root, stdio: "pipe" });
      }
      expect((await fast.session!.revalidateFreshness()).valid).toBe(true);
      expect((await full.session!.revalidateFreshness()).valid).toBe(true);
    } finally { fast.session?.close(); full.session?.close(); }
  });
  it("does not reuse caller-fabricated observation tokens", () => {
    expect(revalidateGraphReadObservation({ canonicalDbPath: "unused", databaseIdentity: "unused", snapshotRaw: "unused", snapshotHash: "unused" })).toBeNull();
  });
  it("catches same-size restored-mtime edits during the final fd-stable read", async () => {
    const root = await fixture(); let mutate = false;
    const inspection = await inspectGraphStatusWithFreshObservation({ projectRoot: root, internal: {
      afterSourceRead: () => {
        if (!mutate) return; mutate = false;
        const path = join(root, "source.py"); const before = statSync(path);
        writeFileSync(path, "def value():\n    return 2\n"); utimesSync(path, before.atime, before.mtime);
        expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
      },
    } });
    mutate = true;
    const result = await revalidateGraphReadObservation(inspection.freshObservation!);
    expect(result!.graphStatus.status).not.toBe("fresh");
    expect(result!.freshObservation).toBeNull();
  });
  it("matches the independent full inspector after edits and restoration", async () => {
    const root = await fixture();
    const fast = await loadFreshGraphReadSession(root);
    const full = await loadFreshGraphReadSession(root, { inspectObservation: inspectGraphStatusWithFreshObservation });
    expect(fast.session).not.toBeNull(); expect(full.session).not.toBeNull();
    try {
      expect((await fast.session!.revalidateFreshness()).valid).toBe(true);
      expect((await full.session!.revalidateFreshness()).valid).toBe(true);
      writeFileSync(join(root, "source.py"), "def value():\n    return 2\n");
      expect((await fast.session!.revalidateFreshness()).valid).toBe(false);
      expect((await full.session!.revalidateFreshness()).valid).toBe(false);
      writeFileSync(join(root, "source.py"), "def value():\n    return 1\n");
      expect((await fast.session!.revalidateFreshness()).valid).toBe(true);
      expect((await full.session!.revalidateFreshness()).valid).toBe(true);
    } finally { fast.session?.close(); full.session?.close(); }
  });
});
