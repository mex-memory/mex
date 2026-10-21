import { expect, it } from "vitest";
import { normalizeIncrementalReferences } from "../incremental-references.js";

it("drops a compiler reference whose source was excluded and demotes an absent target", () => {
  const file: Parameters<typeof normalizeIncrementalReferences>[0][number] = {
    record: { path: "src/check.ts", contentHash: "hash", language: "typescript", size: 1, modifiedAt: 0, indexedAt: 0, nodeCount: 2 },
    nodes: [{ id: "function:check" }, { id: "class:Revision" }],
    edges: [
      { source: "function:excluded", target: "class:Revision", kind: "instantiates" },
      { source: "function:check", target: "class:excluded", kind: "instantiates" },
      { source: "function:check", target: "class:Revision", kind: "instantiates" },
    ], references: [], imports: [],
  };
  normalizeIncrementalReferences([file]);
  expect(file.edges).toEqual([{ source: "function:check", target: "class:Revision", kind: "instantiates" }]);
  expect(file.references).toMatchObject([{ fromNodeId: "function:check", status: "unresolved", candidates: [] }]);
  expect(file.record.errors).toMatchObject([{ type: "INCREMENTAL_REFERENCE_OUTSIDE_CORPUS", count: 2 }]);
  normalizeIncrementalReferences([file]);
  expect(file.record.errors).toHaveLength(1);
});
