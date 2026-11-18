import { describe, expect, it } from "vitest";
import { diffFiles } from "../cli.js";

describe("upgrade preview summary", () => {
  it("lists each file a diff touches with what happens to it", () => {
    const diff = [
      "diff --git a/.agents/skills/mex-inbox/SKILL.md b/.agents/skills/mex-inbox/SKILL.md", "deleted file mode 100644", "--- a/x", "+++ /dev/null", "@@ -1 +0,0 @@", "-x",
      "diff --git a/.mex/learned/mx_a.md b/.mex/learned/mx_a.md", "new file mode 100644", "--- /dev/null", "+++ b/x", "@@ -0,0 +1 @@", "+x",
      "diff --git a/AGENTS.md b/AGENTS.md", "--- a/AGENTS.md", "+++ b/AGENTS.md", "@@ -1 +1 @@", "-a", "+b",
    ].join("\n");
    expect(diffFiles(diff)).toEqual([
      { path: ".agents/skills/mex-inbox/SKILL.md", change: "removed" },
      { path: ".mex/learned/mx_a.md", change: "new" },
      { path: "AGENTS.md", change: "changed" },
    ]);
  });
});
