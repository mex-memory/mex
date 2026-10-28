import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { attributePatch, parseApplyPatch, patchedFiles } from "../patch.js";
import { parseUnifiedZero } from "../../context/hook/diff.js";
import { bashReads, bashSearchPattern, bashSearchSegment, shellOutput } from "../shell.js";

const root = join(tmpdir(), "patch-project");
const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
describe("apply_patch parsing", () => {
  it.each(["\n", "\r\n"])("parses all operations and multi-file paths with %j", eol => {
    const parsed = parseApplyPatch(patch(`*** Update File: ${join(root, "src/old name.ts")}\n*** Move to: src/new name.ts\n@@\n-old\n+new\n*** Add File: src/added.ts\n+hello\n*** Delete File: src/deleted.ts`).replace(/\n/g, eol), root);
    expect(parsed.map(p => [p.file, p.kind, p.moveTo])).toEqual([
      ["src/old name.ts", "update", "src/new name.ts"], ["src/added.ts", "add", undefined], ["src/deleted.ts", "delete", undefined],
    ]);
    expect(patchedFiles(parsed)).toEqual(["src/old name.ts", "src/new name.ts", "src/added.ts", "src/deleted.ts"]);
    expect(parsed[0]!.chunks).toEqual([{ before: ["old"], after: ["new"] }]);
  });
  it("resolves relative names against cwd and excludes .mex and escaped paths", () => {
    expect(parseApplyPatch(patch("*** Update File: core.ts\n@@\n-a\n+b"), root, join(root, "src"))[0]!.file).toBe("src/core.ts");
    expect(parseApplyPatch(patch("*** Delete File: .mex/AGENTS.md\n*** Delete File: ../outside.ts\n*** Update File: src/a.ts\n*** Move to: ../../outside.ts"), root)).toEqual([]);
    expect(parseApplyPatch(patch("*** Delete File: a.ts").repeat(20_000), root)).toEqual([]);
    expect(parseApplyPatch("*** Begin Patch\n*** Delete File: a.ts", root)).toEqual([]);
  });
  it("attributes only this patch inside a Git hunk containing an older dirty line", () => {
    const diff = parseUnifiedZero("--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old dirty\n-old patch\n+prior change\n+new patch\n", true).get("a.ts")!;
    const evidence = parseApplyPatch(patch("*** Update File: a.ts\n@@\n-old patch\n+new patch"), root)[0]!;
    expect(attributePatch(evidence, "prior change\nnew patch\n", diff)?.ranges).toEqual([[2, 2]]);
  });
  it("maps edits of previously dirty lines without including adjacent older changes", () => {
    const diff = parseUnifiedZero("--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-first\n-second\n+older first\n+new second\n", true).get("a.ts")!;
    const evidence = parseApplyPatch(patch("*** Update File: a.ts\n@@\n-older second\n+new second"), root)[0]!;
    expect(attributePatch(evidence, "older first\nnew second\n", diff)?.ranges).toEqual([[2, 2]]);
  });
  it("attributes a context-free removal using its unique removed HEAD lines", () => {
    const diff = parseUnifiedZero("--- a/a.ts\n+++ b/a.ts\n@@ -2 +1,0 @@\n-remove me\n", true).get("a.ts")!;
    const evidence = parseApplyPatch(patch("*** Update File: a.ts\n@@\n-remove me"), root)[0]!;
    expect(attributePatch(evidence, "first\nlast\n", diff)?.ranges).toEqual([[2, 2]]);
  });
  it("treats re-added context as an insertion, and abstains for ambiguous postimages", () => {
    const evidence = parseApplyPatch(patch("*** Update File: a.ts\n@@\n-function add() {}\n+// adds\n+function add() {}"), root)[0]!;
    const diff = parseUnifiedZero("--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+// adds\n", true).get("a.ts")!;
    expect(attributePatch(evidence, "// adds\nfunction add() {}\n", diff)?.ranges).toEqual([[0.5, 0.5]]);
    expect(attributePatch(evidence, "// adds\nfunction add() {}\n// adds\nfunction add() {}\n", diff)).toBeNull();
  });
});

describe("PowerShell evidence", () => {
  it.each([
    ["Get-Content -Path 'src/core file.ts' -TotalCount 5", { file: "src/core file.ts", offset: 1, limit: 5 }],
    ["gc src/core.ts -Head 3", { file: "src/core.ts", offset: 1, limit: 3 }],
    ["cat -Path src/core.ts -First 4", { file: "src/core.ts", offset: 1, limit: 4 }],
    ["type src/core.ts -Tail 7", { file: "src/core.ts", tail: 7 }],
    ["Get-Content src/core.ts | Select-Object -First 2", { file: "src/core.ts", offset: 1, limit: 2 }],
    ["Get-Content src/core.ts | Select-Object -Last 2", { file: "src/core.ts", tail: 2 }],
    ["(Get-Content 'src/core.ts')[3..8]", { file: "src/core.ts", offset: 4, limit: 6 }],
    ["GET-CONTENT src/core.ts -TotalCount 10 | Select-Object -Last 3", { file: "src/core.ts", offset: 8, limit: 3 }],
    ["cd src; gc core.ts", { file: "src/core.ts" }],
  ])("maps %s to an existing read range", (command, expected) => {
    expect(bashReads(command, root)).toEqual([expected]);
  });
  it.each(["gc ../outside.ts", "Get-Content .mex/AGENTS.md", "Get-Content $path", "gc *.ts", "gc x.ts -Tail nope", "(Get-Content x.ts)[8..3]", "gc x.ts -Raw"])("abstains on %s", command => {
    expect(bashReads(command, root)).toEqual([]);
  });
  it.each([
    ["Select-String -Path src/*.ts -Pattern 'calculateOrderTotal'", "calculateOrderTotal"],
    ["sls -Pattern 'one|two' -Path src/core.ts", "one|two"],
    ["Get-ChildItem src -Recurse | Select-String -Pattern total", "total"],
  ])("finds a search and pattern in %s", (command, pattern) => {
    expect(bashSearchSegment(command)).not.toBeNull(); expect(bashSearchPattern(command)).toBe(pattern);
  });
  it("strips only a Codex execution header and preserves Claude stdout", () => {
    const body = "src/core.ts:2:total\n";
    expect(shellOutput(`Exit code: 0\nWall time: 0.1 seconds\nOutput:\n${body}`)).toBe(body);
    expect(shellOutput({ stdout: body })).toBe(body);
    expect(shellOutput(body)).toBe(body);
  });
});
