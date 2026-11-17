import { describe, expect, it } from "vitest";
import { ownedWatchHook } from "../watch-hook.js";

const original = '#!/bin/sh\n# mex-drift-check\n# Auto-installed by mex watch — runs drift check after each commit\nSCORE=$(node "/repo/dist/cli.js" check --quiet 2>&1) || true\n# Only show output if there are issues (not a perfect score)\ncase "$SCORE" in\n  *"100/100"*) ;;\n  *) echo "$SCORE" ;;\nesac\n# mex-drift-check-end\n';
describe("old watch ownership", () => {
  it("recognizes the complete generated hook with LF or CRLF", () => {
    expect(ownedWatchHook(original)).toBe(true);
    expect(ownedWatchHook(original.replace(/\n/gu, "\r\n"))).toBe(true);
    expect(ownedWatchHook(original.replace('node "/repo/dist/cli.js"', "npx mex").replace("# mex-drift-check-end\n", ""))).toBe(true);
  });
  it("leaves mixed, edited and malformed hooks for review", () => {
    for (const text of ["#!/bin/sh\necho human\n\n" + original, original + "echo human\n", original.replace("case", "echo human\ncase"), original.replace("# mex-drift-check-end", "# malformed end"), original.replace("cli.js", "human.js")]) expect(ownedWatchHook(text)).toBe(false);
  });
});
