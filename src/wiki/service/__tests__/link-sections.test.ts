import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { wikiLinkSections } from "../link-sections.js";
import { inventoryScaffold } from "../../migration/inventory.js";

const ROOT = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHILD = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const NESTED = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(extra = "") {
  const scaffoldRoot = mkdtempSync(join(tmpdir(), "mex-section-links-"));
  roots.push(scaffoldRoot);
  mkdirSync(join(scaffoldRoot, "context"));
  const file = join(scaffoldRoot, "context", "architecture.md");
  const text = `---\nname: keep-me\nmex:\n  id: ${ROOT}\n  type: architecture\n  status: promoted\n  revision: 1\n---\n# Architecture\n\nRoot prose.\n\n<!-- mex:entity\nid: ${CHILD}\ntype: component\nstatus: promoted\nrevision: 1\n-->\n## Queue\n\nPreserve exact behavior prose.\n\n${extra}<!-- mex:entity\nid: ${NESTED}\ntype: fact\nstatus: promoted\nrevision: 1\n-->\n### Retries\n\nRetries are bounded.\n`;
  writeFileSync(file, text);
  return { scaffoldRoot, file, text };
}
describe("structural Wiki section connections", () => {
  it("previews without writes, applies only supported parents, preserves prose and is idempotent", () => {
    const f = fixture();
    const before = inventoryScaffold(f).files[0]!.parsed.entities.map(x => [x.entity.id, x.entity.body, x.entity.groundsTo]);
    const preview = wikiLinkSections(f);
    expect(preview.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect(preview.data.links).toMatchObject([{ source: CHILD, target: ROOT }, { source: NESTED, target: CHILD }]);
    expect(readFileSync(f.file, "utf8")).toBe(f.text);
    expect(wikiLinkSections({ ...f, apply: true }).data.applied).toBe(true);
    const after = inventoryScaffold(f).files[0]!.parsed.entities;
    expect(after.map(x => [x.entity.id, x.entity.body, x.entity.groundsTo])).toEqual(before);
    expect(after[1]!.entity.relations).toMatchObject([{ type: "refines", target: ROOT }]);
    expect(wikiLinkSections({ ...f, apply: true }).data.links).toEqual([]);
    expect(readFileSync(f.file, "utf8")).toContain("name: keep-me");
  });
  it("does not infer nesting across an intervening peer heading", () => {
    const f = fixture("## Unannotated peer\n\nOther prose.\n\n");
    expect(wikiLinkSections(f).data.links[1]).toMatchObject({ source: NESTED, target: ROOT });
  });
  it("preserves a recorded code baseline without accepting drift", () => {
    const f = fixture();
    writeFileSync(f.file, f.text.replace(`id: ${CHILD}\ntype: component`,
      `id: ${CHILD}\ngrounds_to:\n  - node: function:1111111111111111\n    fingerprint: mh:4:11111111\n    bodyHash: ${"a".repeat(64)}\ntype: component`));
    const before = inventoryScaffold(f).files[0]!.parsed.entities[1]!.entity.groundsTo;
    expect(before).toHaveLength(1);
    expect(wikiLinkSections({ ...f, apply: true }).data.applied).toBe(true);
    expect(inventoryScaffold(f).files[0]!.parsed.entities[1]!.entity.groundsTo).toEqual(before);
  });
  it("honors read-only paths and blocks duplicate identities without writing", () => {
    const f = fixture();
    expect(wikiLinkSections({ ...f, readOnly: ["context/**"], apply: true }).data.links).toEqual([]);
    writeFileSync(join(f.scaffoldRoot, "context", "duplicate.md"), f.text);
    const result = wikiLinkSections({ ...f, apply: true });
    expect(result.diagnostics.some(d => d.code === "DUPLICATE_ENTITY_ID")).toBe(true);
    expect(readFileSync(f.file, "utf8")).toBe(f.text);
  });
  it("leaves Spec hierarchies unchanged", () => {
    const f = fixture();
    const text = f.text.replace("type: architecture", "type: spec");
    writeFileSync(f.file, text);
    expect(wikiLinkSections({ ...f, apply: true }).data.links).toEqual([]);
    expect(readFileSync(f.file, "utf8")).toBe(text);
  });
  it("leaves ordinary entity kinds stored under specs unchanged", () => {
    const f = fixture();
    mkdirSync(join(f.scaffoldRoot, "specs"));
    const target = join(f.scaffoldRoot, "specs", "ordinary.md");
    writeFileSync(target, f.text);
    rmSync(f.file);
    expect(wikiLinkSections({ ...f, apply: true }).data.links).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe(f.text);
  });
});
