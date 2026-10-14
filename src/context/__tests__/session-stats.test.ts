import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadShown, loadStats, MAX_STATS_PER_SESSION, recordShown, recordStats, sessionDirOf } from "../session.js";

let local: string;
beforeEach(() => {
  local = mkdtempSync(join(tmpdir(), "mex-session-stats-"));
});
afterEach(() => rmSync(local, { recursive: true, force: true }));

describe("session source-file signatures", () => {
  it("round-trips per session and merges later writes", () => {
    expect(loadStats(local, "a")).toEqual({});
    recordStats(local, "a", { "src/x.ts": "10:1" });
    recordStats(local, "a", { "src/y.ts": "20:2", "src/x.ts": "11:3" });
    expect(loadStats(local, "a")).toEqual({ "src/x.ts": "11:3", "src/y.ts": "20:2" });
    expect(loadStats(local, "b")).toEqual({});
  });

  it("is kept apart from the shown ids", () => {
    recordShown(local, "a", ["mx_1"]);
    recordStats(local, "a", { "src/x.ts": "10:1" });
    expect([...loadShown(local, "a")]).toEqual(["mx_1"]);
    expect(readdirSync(sessionDirOf(local)).filter((n) => n.endsWith(".stat.json"))).toHaveLength(1);
  });

  it("keeps only the newest signatures when the map outgrows its bound", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_STATS_PER_SESSION + 50 }, (_, i) => [`src/f${i}.ts`, `${i}:0`]));
    recordStats(local, "a", many);
    const kept = loadStats(local, "a");
    expect(Object.keys(kept)).toHaveLength(MAX_STATS_PER_SESSION);
    expect(kept[`src/f${MAX_STATS_PER_SESSION + 49}.ts`]).toBeDefined();
    expect(kept["src/f0.ts"]).toBeUndefined();
  });

  it("reads a damaged or foreign file as empty", () => {
    recordStats(local, "a", { "src/x.ts": "10:1" });
    const dir = sessionDirOf(local);
    for (const name of readdirSync(dir)) writeFileSync(join(dir, name), "{ nope");
    expect(loadStats(local, "a")).toEqual({});
  });
});
