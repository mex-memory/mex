import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImport } from "../../file-index/imports.js";
import { realPath } from "../../record/project.js";
import { branchWords, coChangePartners, computeWorkingSet, encodeFixes, fixesFile, fixHistory, isFixSubject, parseLog, pathKey, workingSetFile, writeWorkingSet, WORKING_SET_LIMITS, type Commit } from "../compute.js";

const c = (files: string[], fix = false, time = 0): Commit => ({ files, fix, time });

describe("co-change partners", () => {
  it("needs two focused shared commits and orders by decayed weight", () => {
    // Newest first. b shares two focused commits with a; c shares one.
    const commits = [c(["a", "b"]), c(["a", "c"]), c(["a", "b"]), c(["x", "y"])];
    expect(coChangePartners(commits, ["a"]).get("a")).toEqual(["b"]);
  });

  it("decays by commit order, so recent partners rank first", () => {
    const older = Array.from({ length: 1200 }, () => c(["q"]));
    const commits = [c(["a", "new"]), c(["a", "new"]), ...older, c(["a", "old"]), c(["a", "old"]), c(["a", "old"])];
    expect(coChangePartners(commits, ["a"]).get("a")).toEqual(["new", "old"]);
  });

  it("skips commits over the pair limit and counts only focused ones as support", () => {
    const wide = Array.from({ length: WORKING_SET_LIMITS.pairFiles + 1 }, (_, i) => `f${i}`);
    const unfocused = ["a", "b", ...Array.from({ length: WORKING_SET_LIMITS.focusedFiles }, (_, i) => `g${i}`)];
    expect(coChangePartners([c(["a", ...wide]), c(["a", ...wide])], ["a"]).get("a") ?? []).toEqual([]);
    // Two shared commits, but only one of them is focused: not enough support.
    expect(coChangePartners([c(unfocused), c(["a", "b"])], ["a"]).get("a")).toEqual([]);
  });

  it("keeps at most 25 partners per file and ignores the 2,000-commit tail", () => {
    const many = Array.from({ length: 28 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const commits = [c(["a", ...many]), c(["a", ...many])];
    expect(coChangePartners(commits, ["a"]).get("a")).toHaveLength(WORKING_SET_LIMITS.partners);
    const tail = [...Array.from({ length: WORKING_SET_LIMITS.window }, () => c(["q"])), c(["a", "z"]), c(["a", "z"])];
    expect(coChangePartners(tail, ["a"]).get("a")).toBeUndefined();
  });
});

describe("fix history", () => {
  it("keeps files with at least three fix commits and their last fix time", () => {
    const now = 1_800_000_000;
    const commits = [c(["a"], true, now - 100), c(["a", "b"], true, now - 200), c(["a"], true, now - 300), c(["b"], false, now), c(["b"], true, now - 50)];
    expect(fixHistory(commits, now)).toEqual({ a: [3, now - 100] });
  });

  it("drops histories older than a year", () => {
    const now = 1_800_000_000, old = now - 400 * 86_400;
    expect(fixHistory([c(["a"], true, old), c(["a"], true, old), c(["a"], true, old)], now)).toEqual({});
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

  it("parses git log records", () => {
    const text = "\x01" + "100\x02fix: one\n" + "\na.ts\0b.ts\0" + "\x01" + "90\x02feat: two\n" + "\nc.ts\0";
    expect(parseLog(text)).toEqual([{ files: ["a.ts", "b.ts"], time: 100, fix: true }, { files: ["c.ts"], time: 90, fix: false }]);
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
    for (let i = 0; i < 3; i++) {
      write("src/core.ts", `core ${i}`); write("src/partner.ts", `partner ${i}`);
      git(root, "add", "."); git(root, "commit", "-q", "-m", `fix: round ${i}`);
    }
    git(root, "checkout", "-q", "-b", "feat/payments-retry");
    write("src/branch.ts", "on the branch"); git(root, "add", "."); git(root, "commit", "-q", "-m", "feat: branch work");
    write("src/core.ts", "edited, not committed");
    write("src/staged.ts", "staged"); git(root, "add", "src/staged.ts");
    const record = mkdtempSync(join(tmpdir(), "mex-ws-record-"));
    const now = Math.floor(Date.now() / 1000);
    const set = await computeWorkingSet({ root, projectId: "g-0123456789abcdef01234567", recordDirectory: record, now });
    expect(set.branch).toBe("feat/payments-retry");
    expect(set.defaultBranch).toBe("main");
    expect(set.head).toMatch(/^[0-9a-f]{40}$/);
    expect(set.seeds.slice(0, 2).sort()).toEqual(["src/core.ts", "src/staged.ts"]);
    expect(set.seeds).toContain("src/branch.ts");
    expect(set.hops).toEqual(["src/partner.ts"]);
    expect(set.words).toEqual(["payments", "retry"]);
    expect(set.fixes["src/core.ts"]?.[0]).toBe(3);

    await writeWorkingSet({ root, projectId: "g-0123456789abcdef01234567", recordDirectory: record, now });
    const cached = JSON.parse(readFileSync(workingSetFile(record, "g-0123456789abcdef01234567", realPath(root)), "utf8"));
    expect(cached.version).toBe(1);
    expect(cached.seeds).toEqual(set.seeds);
    expect(readFileSync(fixesFile(record, "g-0123456789abcdef01234567", realPath(root))).subarray(0, 4).toString("ascii")).toBe("MXF1");
  });

  it("works outside git with an empty set", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-ws-plain-"));
    const set = await computeWorkingSet({ root, projectId: "g-0123456789abcdef01234567", recordDirectory: mkdtempSync(join(tmpdir(), "mex-ws-r-")) });
    expect(set).toMatchObject({ head: "", branch: "", seeds: [], hops: [], words: [] });
  });
});
