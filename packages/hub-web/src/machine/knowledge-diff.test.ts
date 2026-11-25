import { describe, expect, it } from "vitest";
import { readableDiff } from "./knowledge-diff";

const whole = (before: string[], after: string[]) => [
  "diff --git a/.mex/learned/mx_a.md b/.mex/learned/mx_a.md",
  "--- a/.mex/learned/mx_a.md",
  "+++ b/.mex/learned/mx_a.md",
  `@@ -1,${before.length} +1,${after.length} @@`,
  ...before.map((line) => "-" + line),
  ...after.map((line) => "+" + line),
  "",
].join("\n");

describe("readableDiff", () => {
  it("shows only the changed lines of a whole-file replacement, with folded context", () => {
    const before = ["---", "mex:", "  id: mx_a", "  kind: rule", "  scope:", "    - \"**\"", "  quote: Old", "---", "Old"];
    const after = ["---", "mex:", "  id: mx_a", "  kind: rule", "  scope:", "    - \"**\"", "  quote: New", "---", "New"];
    const lines = readableDiff(whole(before, after));
    expect(lines.filter((line) => line.kind === "removed").map((line) => line.text)).toEqual(["-  quote: Old", "-Old"]);
    expect(lines.filter((line) => line.kind === "added").map((line) => line.text)).toEqual(["+  quote: New", "+New"]);
    expect(lines.find((line) => line.kind === "fold")?.text).toBe("… 4 unchanged lines");
    expect(lines.slice(0, 2).map((line) => line.kind)).toEqual(["header", "header"]);
    expect(lines.some((line) => line.text.startsWith("@@") || line.text.startsWith("diff --git"))).toBe(false);
  });

  it("keeps a new file as all additions", () => {
    const diff = ["diff --git a/x b/x", "new file mode 100644", "--- /dev/null", "+++ b/x", "@@ -0,0 +1,2 @@", "+a", "+b", ""].join("\n");
    expect(readableDiff(diff).filter((line) => line.kind === "added").map((line) => line.text)).toEqual(["+a", "+b"]);
  });
});
