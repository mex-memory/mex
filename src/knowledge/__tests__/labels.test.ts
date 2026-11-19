import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { entryLabel, type KnowledgeLevel } from "../labels.js";
import { entry } from "./fixtures.js";
import type { KnowledgeEntry } from "../entry.js";

const labels = JSON.parse(readFileSync(new URL("../../../native/delivery/entries/testdata/labels.json", import.meta.url), "utf8")) as Array<{
  id?: string; source_type: KnowledgeEntry["mex"]["source"]["type"]; ref: string; evidence: KnowledgeEntry["mex"]["evidence"]; level: KnowledgeLevel; expected: string;
}>;
it("matches the shared Go and Node label golden", () => {
  for (const label of labels) expect(entryLabel(entry(label.id ?? "mx_label1", { source: { type: label.source_type, ref: label.ref }, evidence: label.evidence }), label.level)).toBe(label.expected);
});
