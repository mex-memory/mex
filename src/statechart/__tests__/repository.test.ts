import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DiagramRepository } from "../repository.js";
import { exampleArtifact } from "../fixtures.js";
const roots: string[] = [];
function root() { const r = mkdtempSync(join(tmpdir(), "mex-diagrams-test-")); roots.push(r); mkdirSync(join(r, ".mex")); return r; }
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
describe("diagram artifact lifecycle", () => {
  it("reads without initializing, registers across processes, reviews exact writes and reopens without indexes", async () => {
    const r = root(), repo = new DiagramRepository(r); expect(repo.list()).toEqual({ items: [], truncated: false }); expect(existsSync(join(r, ".mex/local"))).toBe(false);
    writeFileSync(join(r, "unrelated.txt"), "keep"); const p = await repo.register(exampleArtifact("incomplete"));
    const other = new DiagramRepository(r), detail = other.get("preview", p.id); expect(detail.outcome).toBe("incomplete"); expect(detail.alignment).toBe("unverified");
    const plan = other.previewSave(p.id, detail.revision); expect(existsSync(join(r, ".mex/diagrams"))).toBe(false);
    const saved = await other.applySave(plan.token); expect(saved.kind).toBe("saved");
    for (const w of plan.writes) expect(readFileSync(join(r, w.path), "utf8")).toBe(w.content);
    expect(new DiagramRepository(r).get("saved", saved.id).artifact).toEqual(detail.artifact);
    expect(readFileSync(join(r, "unrelated.txt"), "utf8")).toBe("keep"); expect(existsSync(join(r, ".mex/wiki.db"))).toBe(false);
    await expect(other.applySave(plan.token)).rejects.toThrow();
  });
  it("keeps dependency change signals after restart and does not renew a baseline", async () => {
    const r = root(); writeFileSync(join(r, "code.ts"), "old"); const a = exampleArtifact(); const sha256 = createHash("sha256").update("old").digest("hex");
    a.evidence.push({ id: "source", path: "code.ts", sha256, kind: "code", explains: ["start"], note: "The entry point starts work." });
    const repo = new DiagramRepository(r), p = await repo.register(a), d = repo.get("preview", p.id); expect(d.freshness[0]?.status).toBe("unchanged");
    const s = await repo.applySave(repo.previewSave(p.id, d.revision).token); writeFileSync(join(r, "code.ts"), "new");
    const reopened = new DiagramRepository(r).get("saved", s.id); expect(reopened.freshness[0]?.status).toBe("changed"); expect(reopened.artifact.evidence[0]?.sha256).toBe(sha256);
    rmSync(join(r, "code.ts")); expect(repo.get("saved", s.id).freshness[0]?.status).toBe("missing");
  });
  it("refuses stale reviews, expiry, malformed IDs and symlink escapes without writing outside", async () => {
    const r = root(), outside = root(); let date = new Date("2026-10-26T00:00:00Z"); const repo = new DiagramRepository(r, () => date), p = await repo.register(exampleArtifact());
    expect(() => repo.get("preview", "../../escape")).toThrow(); expect(() => repo.previewSave(p.id, "0".repeat(64))).toThrow();
    const plan = repo.previewSave(p.id, repo.get("preview", p.id).revision); date = new Date(+date + 6 * 60_000); await expect(repo.applySave(plan.token)).rejects.toThrow();
    date = new Date(+date + 24 * 3600_000); expect(() => repo.get("preview", p.id)).toThrow(/expired/); expect(repo.list().items).toHaveLength(0);
    symlinkSync(join(outside, ".mex"), join(r, ".mex/diagrams")); const p2 = await repo.register(exampleArtifact()); expect(() => repo.previewSave(p2.id, repo.get("preview", p2.id).revision)).toThrow(); expect(existsSync(join(outside, ".mex/record.md"))).toBe(false);
  });
});
it("preserves earlier snapshots when a reviewed target is occupied before publication", async () => {
  const r = root(), repo = new DiagramRepository(r), p = await repo.register(exampleArtifact());
  const detail = repo.get("preview", p.id), first = await repo.applySave(repo.previewSave(p.id, detail.revision).token);
  const review = repo.previewSave(p.id, detail.revision), target = review.writes[0]!.path.split("/").slice(0, -1).join("/");
  mkdirSync(join(r, target)); writeFileSync(join(r, target, "keep.txt"), "concurrent");
  await expect(repo.applySave(review.token)).rejects.toThrow(); expect(repo.get("saved", first.id).artifact).toEqual(detail.artifact);
  expect(readFileSync(join(r, target, "keep.txt"), "utf8")).toBe("concurrent"); expect(existsSync(join(r, target, "record.md"))).toBe(false);
});
it("refuses malformed, oversized, escaping and unreviewable artifact inputs", async () => {
  const r = root(), repo = new DiagramRepository(r), a = exampleArtifact();
  await expect(repo.register({ ...a, schemaVersion: 9 })).rejects.toThrow();
  a.files.push({ name: "Bad.txt", content: "x".repeat(129 * 1024) }); await expect(repo.register(a)).rejects.toThrow();
  const b = exampleArtifact(); b.evidence.push({ id: "escape", path: "../outside", sha256: null, kind: "code", explains: ["start"], note: "Invalid evidence" }); await expect(repo.register(b)).rejects.toThrow();
  expect(existsSync(join(r, ".mex/local"))).toBe(false);
});
it("retains historical/conflicting evidence without reconciling rules or repairing missing indexes", async () => {
  const r = root(), repo = new DiagramRepository(r), a = exampleArtifact(); mkdirSync(join(r, "notes"));
  writeFileSync(join(r, "notes/history.md"), "An earlier assumption excluded completion.");
  writeFileSync(join(r, "notes/requirement.md"), "Current agreed domain includes completion.");
  a.evidence = [{ id: "history", kind: "history", path: "notes/history.md", sha256: null, explains: ["Safe"], note: "Historical assumption conflicts with the current rule; retained as history, not accepted current behavior." }, { id: "requirement", kind: "requirement", path: "notes/requirement.md", sha256: null, explains: ["Safe"], note: "The current agreed finite domain includes completion." }];
  a.rules[0]!.evidence = ["history", "requirement"]; a.rules[0]!.provenance = "Current requirement retained unchanged; the historical disagreement is visible in evidence.";
  const p = await repo.register(a), d = repo.get("preview", p.id), saved = await repo.applySave(repo.previewSave(p.id, d.revision).token);
  const reopened = new DiagramRepository(r).get("saved", saved.id); expect(reopened.artifact.rules).toEqual(a.rules); expect(reopened.artifact.evidence).toEqual(a.evidence); expect(reopened.alignment).toBe("unverified");
  expect(existsSync(join(r, ".mex/wiki.db"))).toBe(false); expect(existsSync(join(r, ".mex/graph.db"))).toBe(false);
});
it("evicts only at explicit registration and keeps preview retention bounded", async () => {
  const r = root(); let time = new Date("2026-10-26T00:00:00.000Z"); const repo = new DiagramRepository(r, () => time);
  const first = await repo.register(exampleArtifact());
  for (let i = 0; i < 20; i++) { time = new Date(+time + 1); await repo.register(exampleArtifact()); }
  expect(repo.list().items).toHaveLength(20); expect(() => repo.get("preview", first.id)).toThrow();
  const live = repo.list().items[0]!; time = new Date(+time + 25 * 3600_000); expect(repo.list().items).toHaveLength(0);
  expect(existsSync(join(r, ".mex/local/diagrams", live.id, "record.md"))).toBe(true);
});
it("keeps imported Markdown/HTML and owner-marker text inert through save and reopen", async () => {
  const r = root(), repo = new DiagramRepository(r), a = exampleArtifact();
  a.summary = '<script>window.bad = true</script>\n<!-- mex-statechart:v1 -->\n```json\n{"untrusted":true}\n```';
  const p = await repo.register(a), d = repo.get("preview", p.id), plan = repo.previewSave(p.id, d.revision), saved = await repo.applySave(plan.token);
  expect(repo.get("saved", saved.id).artifact.summary).toBe(a.summary);
  const record = plan.writes[0]!.content; expect(record.split("## Recorded verification")[0]).not.toContain("<script>");
});
it("reopens a Git-style CRLF Markdown snapshot without renewing its recorded inputs", async () => {
  const r = root(), repo = new DiagramRepository(r), a = exampleArtifact(), p = await repo.register(a), d = repo.get("preview", p.id);
  const plan = repo.previewSave(p.id, d.revision), saved = await repo.applySave(plan.token), record = plan.writes[0]!;
  writeFileSync(join(r, record.path), record.content.replace(/\n/g, "\r\n"));
  expect(new DiagramRepository(r).get("saved", saved.id).artifact).toEqual(a);
});
it("keeps listing readable diagrams when one snapshot is unreadable", async () => {
  const r = root(), repo = new DiagramRepository(r), p = await repo.register(exampleArtifact()), d = repo.get("preview", p.id);
  const plan = repo.previewSave(p.id, d.revision), saved = await repo.applySave(plan.token), bad = "f".repeat(32);
  mkdirSync(join(r, ".mex/diagrams", bad)); writeFileSync(join(r, ".mex/diagrams", bad, "record.md"), plan.writes[0]!.content.replace('"schemaVersion": 1', '"schemaVersion": 2'));
  expect(repo.list().items.map(i => i.id)).toEqual([p.id, saved.id]); expect(() => repo.get("saved", bad)).toThrow(/schemaVersion/);
});
it("treats Git line-ending conversion as unchanged evidence and verifies large sources", async () => {
  const r = root(), a = exampleArtifact(), lf = "one\ntwo\n", large = "x".repeat(200 * 1024) + "\n";
  writeFileSync(join(r, "code.ts"), lf.replace(/\n/g, "\r\n")); writeFileSync(join(r, "large.ts"), large);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  a.evidence.push({ id: "source", path: "code.ts", sha256: sha(lf), kind: "code", explains: ["start"], note: "Recorded from an LF checkout." }, { id: "large", path: "large.ts", sha256: sha(large), kind: "code", explains: ["start"], note: "A source file over the companion size limit." });
  const repo = new DiagramRepository(r), p = await repo.register(a);
  expect(repo.get("preview", p.id).freshness.map(f => f.status)).toEqual(["unchanged", "unchanged"]);
  writeFileSync(join(r, "code.ts"), "one\r\nthree\r\n"); expect(repo.get("preview", p.id).freshness[0]?.status).toBe("changed");
});
