import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isValidSessionId,
  loadShown,
  MAX_SESSION_FILES,
  MAX_SHOWN_PER_SESSION,
  recordShown,
  SESSION_MAX_AGE_MS,
  sessionDirOf,
} from "../session.js";
import { cleanupProjects, createProject } from "./fixture.js";

afterEach(cleanupProjects);

describe("session state", () => {
  it("remembers shown ids per session id", () => {
    const { context } = createProject();
    expect([...loadShown(context.localDir, "s1")]).toEqual([]);
    recordShown(context.localDir, "s1", ["a", "b"]);
    recordShown(context.localDir, "s1", ["b", "c"]);
    recordShown(context.localDir, "s2", ["z"]);
    expect([...loadShown(context.localDir, "s1")]).toEqual(["a", "b", "c"]);
    expect([...loadShown(context.localDir, "s2")]).toEqual(["z"]);
  });

  it("stores state under .mex/local/context-sessions with no raw session id in the file name", () => {
    const { context } = createProject();
    recordShown(context.localDir, "../../escape\\attempt", ["a"]);
    const files = readdirSync(sessionDirOf(context.localDir));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{40}\.json$/);
  });

  it("bounds the ids kept per session, keeping the newest", () => {
    const { context } = createProject();
    const many = Array.from({ length: MAX_SHOWN_PER_SESSION + 25 }, (_, i) => `id-${i}`);
    recordShown(context.localDir, "s", many);
    const shown = [...loadShown(context.localDir, "s")];
    expect(shown).toHaveLength(MAX_SHOWN_PER_SESSION);
    expect(shown.at(-1)).toBe(`id-${MAX_SHOWN_PER_SESSION + 24}`);
    expect(shown).not.toContain("id-0");
  });

  it("prunes session files that have gone stale", () => {
    const { context } = createProject();
    recordShown(context.localDir, "old", ["a"]);
    const dir = sessionDirOf(context.localDir);
    const [oldFile] = readdirSync(dir);
    const ancient = new Date(Date.now() - SESSION_MAX_AGE_MS - 60_000);
    utimesSync(join(dir, oldFile!), ancient, ancient);

    recordShown(context.localDir, "fresh", ["b"]);
    expect(existsSync(join(dir, oldFile!))).toBe(false);
    expect([...loadShown(context.localDir, "fresh")]).toEqual(["b"]);
  });

  it("keeps at most a bounded number of session files", () => {
    const { context } = createProject();
    const dir = sessionDirOf(context.localDir);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < MAX_SESSION_FILES + 10; i += 1) {
      const path = join(dir, `${String(i).padStart(40, "0")}.json`);
      writeFileSync(path, "{}");
      const t = new Date(Date.now() - (MAX_SESSION_FILES + 10 - i) * 1000);
      utimesSync(path, t, t);
    }
    recordShown(context.localDir, "newest", ["a"]);
    expect(readdirSync(dir).length).toBeLessThanOrEqual(MAX_SESSION_FILES);
    expect([...loadShown(context.localDir, "newest")]).toEqual(["a"]);
  });

  it("reads a corrupt or foreign file as an empty session", () => {
    const { context } = createProject();
    recordShown(context.localDir, "s", ["a"]);
    const dir = sessionDirOf(context.localDir);
    writeFileSync(join(dir, readdirSync(dir)[0]!), "{ not json");
    expect([...loadShown(context.localDir, "s")]).toEqual([]);
  });

  it("validates session ids", () => {
    expect(isValidSessionId("abc-123")).toBe(true);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("x".repeat(257))).toBe(false);
    expect(isValidSessionId("line\nbreak")).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
  });
});
