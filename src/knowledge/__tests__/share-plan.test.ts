import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeEntry } from "../entry.js";
import { defaultBase, prepareShare } from "../share-plan.js";
import { note } from "../store.js";
import { shareRepo } from "./share-fixtures.js";

describe("planning a share", () => {
  it("branches from the default branch, not yours", () => {
    const { root, git } = shareRepo();
    const main = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feature"); writeFileSync(join(root, "x.txt"), "x"); git("add", "."); git("commit", "-qm", "feature");
    expect(defaultBase(root)).toEqual({ sha: main, name: "main" });
  });

  it("offers strong notes, blocks private ones, skips what the default branch already has", () => {
    const { root, git } = shareRepo();
    const a = note({ text: "Use date-fns, not moment, because moment is unmaintained." }, { projectPath: root }).entry;
    const b = note({ text: "Ask sam@acme.test before changing the schema, because he owns it." }, { projectPath: root }).entry;
    const c = note({ text: "Release from tags, because CI publishes on tags.", scope: ["src/release/**"] }, { projectPath: root }).entry;
    mkdirSync(join(root, ".mex", "learned"), { recursive: true });
    writeFileSync(join(root, ".mex", "learned", `${c.mex.id}.md`), serializeEntry(c));
    git("add", "."); git("commit", "-qm", "shared before");
    const plan = prepareShare({ projectPath: root }, { now: new Date("2026-11-15T12:00:00Z") });
    expect(plan.share.map(s => s.id)).toEqual([a.mex.id]);
    expect(plan.blocked).toEqual([{ id: b.mex.id, reason: "contains an email address" }]);
    expect(plan.skipped).toEqual([{ id: c.mex.id, reason: "already shared on main" }]);
    expect(plan.branch).toBe("mex/share-2026-11-15");
    expect(prepareShare({ projectPath: root }, { now: new Date("2026-11-15T13:00:00Z") }).revision).toBe(plan.revision);
    expect(prepareShare({ projectPath: root }, { skip: [a.mex.id], now: new Date("2026-11-15T12:00:00Z") }).share).toEqual([]);
  });
});
