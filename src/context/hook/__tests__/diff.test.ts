import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUnifiedZero, readHead, touches } from "../diff.js";
import { readRange } from "../events.js";
import { git } from "./fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), "mex-diff-"));
  roots.push(root);
  return root;
};

describe("parseUnifiedZero", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3 +3 @@",
    "-old",
    "+new",
    "@@ -10,2 +10,0 @@",
    "-gone one",
    "-gone two",
    "@@ -20,0 +21,2 @@",
    "+added one",
    "+added two",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-a",
    "-b",
    "-c",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+x",
    "+y",
    "diff --git a/with space.ts b/with space.ts",
    "--- a/with space.ts\t",
    "+++ b/with space.ts\t",
    "@@ -5 +5 @@",
    "-q",
    "+r",
  ].join("\n");

  it("returns base-side ranges per file", () => {
    const files = parseUnifiedZero(diff);
    expect(files.get("src/a.ts")!.ranges).toEqual([[3, 3], [10, 11], [20.5, 20.5]]);
    expect(files.get("src/gone.ts")!.ranges).toEqual([[1, 3]]);
    expect(files.get("with space.ts")!.ranges).toEqual([[5, 5]]);
    expect(files.get("src/new.ts")!.ranges).toEqual([[0.5, 0.5]]);
  });

  it("signs a change so an identical one is recognisable", () => {
    const a = parseUnifiedZero(diff).get("src/a.ts")!.signature;
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(parseUnifiedZero(diff).get("src/a.ts")!.signature).toBe(a);
    expect(parseUnifiedZero(diff.replace("+new", "+newer")).get("src/a.ts")!.signature).not.toBe(a);
  });

  it("counts an insertion as touching a symbol only when it falls inside the symbol", () => {
    const insertion: Array<[number, number]> = [[20.5, 20.5]];
    expect(touches(insertion, 15, 25)).toBe(true);
    // After the last line of a symbol, or before the first one, is outside it.
    expect(touches(insertion, 10, 20)).toBe(false);
    expect(touches(insertion, 21, 30)).toBe(false);
    expect(touches([[3, 3]], 1, 3)).toBe(true);
    expect(touches([[3, 3]], 4, 9)).toBe(false);
  });
});

describe("readRange", () => {
  it("is the whole file with no offset or limit, otherwise the lines the Read tool returned", () => {
    expect(readRange({})).toBeNull();
    expect(readRange({ offset: 0, limit: 0 })).toBeNull();
    expect(readRange({ offset: 100, limit: 50 })).toEqual([100, 149]);
    expect(readRange({ limit: 30 })).toEqual([1, 30]);
    expect(readRange({ offset: 400 })).toEqual([400, 2399]);
    expect(readRange({ offset: Number.NaN, limit: -5 })).toBeNull();
  });
});

describe("readHead", () => {
  it("reads HEAD without a process: a loose ref, a packed ref and a detached head", () => {
    const root = temp();
    git(root, "init", "-q");
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const sha = git(root, "rev-parse", "HEAD").trim();
    expect(readHead(root)).toBe(sha);
    // From a subdirectory of the project.
    mkdirSync(join(root, "sub"));
    expect(readHead(join(root, "sub"))).toBe(sha);
    git(root, "pack-refs", "--all");
    expect(readHead(root)).toBe(sha);
    git(root, "checkout", "-q", "--detach");
    expect(readHead(root)).toBe(sha);
  });

  it("is null outside a Git checkout", () => {
    expect(readHead(temp())).toBeNull();
  });
});
