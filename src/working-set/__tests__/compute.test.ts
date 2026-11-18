import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImport } from "../../file-index/imports.js";
import { realPath } from "../../record/project.js";
import { branchWords, coChangePartners, computeWorkingSet, encodeFixes, fixesFile, fixHistory, isFixSubject, pathKey, workingSetFile, writeFixTable, writeWorkingSet, WORKING_SET_LIMITS, type HistoryCommit } from "../compute.js";
import { buildCodeFacts } from "../../repo-start/history/job.js";
import { writeFactFile } from "../../repo-start/facts.js";
import type { RecordLocation } from "../../record/location.js";

const c = (files: string[], fix = false, time = 0): HistoryCommit => ({ files, time, subject: fix ? "fix: something" : "feat: something" });

describe("co-change partners from change-together facts", () => {
  it("lists each seed's partners in both directions, most supported first", () => {
    const pairs = [{ a: "a", b: "b", support: 4 }, { a: "c", b: "a", support: 9 }, { a: "x", b: "y", support: 7 }];
    expect(coChangePartners(pairs, ["a"]).get("a")).toEqual(["c", "b"]);
    expect(coChangePartners(pairs, ["q"]).size).toBe(0);
  });

  it("keeps at most 25 partners per file", () => {
    const pairs = Array.from({ length: 40 }, (_, i) => ({ a: "a", b: `p${String(i).padStart(2, "0")}`, support: 5 }));
    expect(coChangePartners(pairs, ["a"]).get("a")).toHaveLength(WORKING_SET_LIMITS.partners);
  });
});

describe("fix history", () => {
  it("keeps files with at least three fix commits and their last fix time", () => {
    const now = 1_800_000_000;
    const commits = [c(["a"], true, now - 100), c(["a", "b"], true, now - 200), c(["a"], true, now - 300), c(["b"], false, now), c(["b"], true, now - 50)];
    expect(fixHistory(commits, now)).toEqual({ a: [3, now - 100] });
  });

  it("drops histories older than 180 days and bulk commits", () => {
    const now = 1_800_000_000, old = now - 200 * 86_400;
    expect(fixHistory([c(["a"], true, old), c(["a"], true, old), c(["a"], true, old)], now)).toEqual({});
    const bulk = Array.from({ length: WORKING_SET_LIMITS.fixCommitFiles + 1 }, (_, i) => `f${i}`);
    expect(fixHistory([c(bulk, true, now), c(bulk, true, now), c(bulk, true, now)], now)).toEqual({});
  });

  it("recognizes fix subjects without matching prefix or fixture", () => {
    expect(["fix: x", "fix(api): y", "Fixes the crash", "bug in parser"].every(isFixSubject)).toBe(true);
    expect(["Add prefix option", "Update fixtures", "feat: z"].some(isFixSubject)).toBe(false);
  });
});

describe("the fix table", () => {
  it("uses FNV-1a 64 keys, the same vectors the Go reader is tested with", () => {
    expect(pathKey("")).toBe(0xcbf29ce484222325n);
    expect(pathKey("a")).toBe(0xaf63dc4c8601ec8cn);
  });

  it("writes sorted 16-byte records after the magic", () => {
    const table = encodeFixes({ "src/a.ts": [4, 1_700_000_000], "lib/c.go": [7, 1_700_200_000] });
    expect(table.subarray(0, 4).toString("ascii")).toBe("MXF1");
    expect(table.length).toBe(4 + 2 * 16);
    const first = table.readBigUInt64LE(4), second = table.readBigUInt64LE(20);
    expect(first < second).toBe(true);
    const a = first === pathKey("src/a.ts") ? 4 : 20;
    expect(table.readUInt32LE(a + 8)).toBe(4);
    expect(table.readUInt32LE(a + 12)).toBe(1_700_000_000);
  });
});

describe("branch words and imports", () => {
  it("splits branch names and drops generic words", () => {
    expect(branchWords("feat/payments-retryQueue_v2")).toEqual(["payments", "retry", "queue"]);
    expect(branchWords("main")).toEqual([]);
  });

  it("resolves relative imports to indexed files only", () => {
    const known = new Set(["src/a.ts", "src/lib/index.ts", "src/b.js"]);
    expect(resolveImport("./a", "src/x.ts", known)).toBe("src/a.ts");
    expect(resolveImport("./lib", "src/x.ts", known)).toBe("src/lib/index.ts");
    expect(resolveImport("./a.js", "src/x.ts", known)).toBe("src/a.ts");
    expect(resolveImport("../../outside", "src/x.ts", known)).toBeUndefined();
    expect(resolveImport("react", "src/x.ts", known)).toBeUndefined();
  });

});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
}

describe("computeWorkingSet on a repository", () => {
  it("seeds from uncommitted work and the branch diff, hops through co-change, and caches per checkout", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "mex-ws-")), "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    const write = (file: string, text: string) => writeFileSync(join(root, file), text);
    for (let i = 0; i < 4; i++) {
      write("src/core.ts", `core ${i}`); write("src/partner.ts", `partner ${i}`);
      git(root, "add", "."); git(root, "commit", "-q", "-m", `fix: round ${i}`);
    }
    git(root, "checkout", "-q", "-b", "feat/payments-retry");
    write("src/branch.ts", "on the branch"); git(root, "add", "."); git(root, "commit", "-q", "-m", "feat: branch work");
    write("src/core.ts", "edited, not committed");
    write("src/staged.ts", "staged"); git(root, "add", "src/staged.ts");
    const record = mkdtempSync(join(tmpdir(), "mex-ws-record-"));
    const location: RecordLocation = { home: record, directory: record, record: join(record, "record.db"), hooks: join(record, "hooks.db") };
    const project = "g-0123456789abcdef01234567";
    // One history walk: the code-facts job's, which also writes the fix table.
    const facts = await buildCodeFacts(root, project, location, undefined, (commits) => writeFixTable(record, project, root, commits));
    writeFactFile(location, project, "code-facts.json", facts);
    const now = Math.floor(Date.now() / 1000);
    const set = await computeWorkingSet({ root, projectId: project, recordDirectory: record, location, now });
    expect(set.branch).toBe("feat/payments-retry");
    expect(set.defaultBranch).toBe("main");
    expect(set.head).toMatch(/^[0-9a-f]{40}$/);
    expect(set.seeds.slice(0, 2).sort()).toEqual(["src/core.ts", "src/staged.ts"]);
    expect(set.seeds).toContain("src/branch.ts");
    expect(set.hops).toEqual(["src/partner.ts"]);
    expect(set.words).toEqual(["payments", "retry"]);
    const table = readFileSync(fixesFile(record, project, realPath(root)));
    expect(table.subarray(0, 4).toString("ascii")).toBe("MXF1");
    expect(table.length).toBe(4 + 2 * 16); // src/core.ts and src/partner.ts, four fixes each

    await writeWorkingSet({ root, projectId: project, recordDirectory: record, location, now });
    const cached = JSON.parse(readFileSync(workingSetFile(record, project, realPath(root)), "utf8"));
    expect(cached.version).toBe(1);
    expect(cached.seeds).toEqual(set.seeds);
  });

  it("works outside git with an empty set", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-ws-plain-"));
    const set = await computeWorkingSet({ root, projectId: "g-0123456789abcdef01234567", recordDirectory: mkdtempSync(join(tmpdir(), "mex-ws-r-")) });
    expect(set).toMatchObject({ head: "", branch: "", seeds: [], hops: [], words: [] });
  });
});
