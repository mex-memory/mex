import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncTarget } from "../../types.js";
import { buildCombinedBrief, buildSyncBrief } from "../brief-builder.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("grounding review briefs", () => {
  it("requires complete-list and negative-claim review before renewing a baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-brief-safety-"));
    roots.push(root);
    mkdirSync(join(root, ".mex", "context"), { recursive: true });
    writeFileSync(join(root, ".mex", "context", "cors.md"), "# CORS defaults\n");
    const target: SyncTarget = { file: ".mex/context/cors.md", gitDiff: null, issues: [{
      code: "GROUNDING_DRIFT", severity: "warning", file: ".mex/context/cors.md", line: null,
      message: "Grounded node body changed: function:cors", verdict: "changed",
      entity: { id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAA", title: "CORS defaults" },
    }] };
    for (const brief of [await buildSyncBrief(target, root), await buildCombinedBrief([target], root)]) {
      expect(brief).toContain("complete lists, exclusions, defaults, and negative claims");
      expect(brief).toContain("Adding QUERY falsifies that");
      expect(brief).toContain("every previously named method is still present");
      expect(brief).toContain("Successful agent execution and renewed hashes are not semantic approval");
      expect(brief).toContain("If evidence is incomplete, choose UNSURE");
      expect(brief).toContain("--reason");
    }
  });
});
