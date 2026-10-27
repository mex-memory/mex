import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupStaleSetupPrompts, createAgentPromptSession } from "../../agent-prompt.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("removes old unowned setup prompts while retaining recent, live and unrelated sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-clean-prompts-")); roots.push(root);
  const local = join(root, ".mex/local"); mkdirSync(local, { recursive: true });
  const old = new Date(Date.now() - 3_600_001);
  for (const name of ["setup-population-old", "setup-population-recent", "setup-population-bad-owner", "agent-review-old"]) {
    const path = join(local, name); mkdirSync(path);
    if (name.endsWith("bad-owner")) writeFileSync(join(path, "owner.json"), "{");
    if (!name.endsWith("recent")) utimesSync(path, old, old);
  }
  const session = createAgentPromptSession("Keep this prompt", root, "setup-population");
  // Capture its actual directory from the instruction without depending on randomness.
  const pointer = /`([^`]+)`/u.exec(session.instruction)![1]!;
  const live = join(root, pointer, ".."); utimesSync(live, old, old);
  cleanupStaleSetupPrompts(root);
  expect(existsSync(join(local, "setup-population-old"))).toBe(false);
  expect(existsSync(join(local, "setup-population-bad-owner"))).toBe(false);
  expect(existsSync(join(local, "setup-population-recent"))).toBe(true);
  expect(existsSync(join(local, "agent-review-old"))).toBe(true);
  expect(existsSync(join(root, pointer))).toBe(true);
  session.cleanup();
});

it("uses the age fallback for a dead parent and retains sessions whose owner may be live", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-clean-prompts-")); roots.push(root);
  const local = join(root, ".mex/local"); mkdirSync(local, { recursive: true });
  for (const pid of [12345, 12346]) {
    const path = join(local, `setup-population-${pid}`); mkdirSync(path);
    writeFileSync(join(path, "owner.json"), JSON.stringify({ pid }));
  }
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    throw Object.assign(new Error("liveness"), { code: pid === 12345 ? "ESRCH" : "EPERM" });
  });
  cleanupStaleSetupPrompts(root);
  expect(existsSync(join(local, "setup-population-12345"))).toBe(true);
  cleanupStaleSetupPrompts(root, Date.now() + 7_200_000);
  expect(existsSync(join(local, "setup-population-12345"))).toBe(false);
  expect(existsSync(join(local, "setup-population-12346"))).toBe(true);
});

it("does not follow a setup prompt junction or a linked local directory", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-clean-prompts-")); roots.push(root);
  const outside = join(root, "outside"); mkdirSync(outside);
  const local = join(root, ".mex/local"); mkdirSync(local, { recursive: true });
  writeFileSync(join(outside, "prompt.md"), "retain");
  symlinkSync(outside, join(local, "setup-population-linked"), "junction");
  cleanupStaleSetupPrompts(root, Date.now() + 7_200_000);
  expect(existsSync(join(outside, "prompt.md"))).toBe(true);
  rmSync(local, { recursive: true, force: true });
  symlinkSync(outside, local, "junction");
  cleanupStaleSetupPrompts(root, Date.now() + 7_200_000);
  expect(existsSync(join(outside, "prompt.md"))).toBe(true);
});
