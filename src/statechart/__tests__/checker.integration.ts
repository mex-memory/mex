import { describe, expect, it } from "vitest";
import { checkArtifact, resolveTlc } from "../checker.js";
import { exampleArtifact } from "../fixtures.js";
import { statechartTerminal } from "@mex/hub-contracts/statechart";
describe("real pinned TLC qualification (tooling is required, never skipped)", () => {
  it("requires a checksum-verified real checker", () => { expect(resolveTlc()).not.toBeNull(); });
  it("checks a passing invariant and verifies its graph projection", async () => { const a = await checkArtifact(exampleArtifact()); expect(a.check.outcome).toBe("passed"); expect(a.check.modelStates).toBe(3); expect(a.diagram.validity).toBe("valid"); expect(a.reproduction.outcome).toBe("not-applicable"); });
  it("retains the ordered finite counterexample", async () => { const a = await checkArtifact(exampleArtifact("broken")); expect(a.check.outcome).toBe("violated"); expect(a.traces[0]?.steps.map(s => s.state)).toEqual(["ready", "running", "done"]); expect(statechartTerminal(a)).toContain("3. Complete via finish"); });
  it("keeps expected reachability distinct from a bug", async () => { const a = await checkArtifact(exampleArtifact("goal")); expect(a.check.outcome).toBe("goal-reached"); expect(a.traces[0]?.kind).toBe("goal"); });
  it("retains temporal failures with their full counterexample", async () => { const a = await checkArtifact(exampleArtifact("temporal")); expect(a.check.outcome).toBe("violated"); expect(a.traces[0]?.kind).toBe("temporal"); expect(a.traces[0]?.raw).toMatch(/Temporal properties were violated/); });
  it("does not mistake cancelled or limited execution for success", async () => { const c = new AbortController(); c.abort(); expect((await checkArtifact(exampleArtifact(), { signal: c.signal })).check.outcome).toBe("cancelled"); const a = await checkArtifact(exampleArtifact(), { timeoutMs: 1 }); expect(a.check.outcome).toBe("resource-limited"); });
});
it("keeps the real checked artifact intact through reviewed save and restart", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path"); const { DiagramRepository } = await import("../repository.js");
  const root = mkdtempSync(join(tmpdir(), "mex-real-checked-lifecycle-"));
  try {
    mkdirSync(join(root, ".mex")); const checked = await checkArtifact(exampleArtifact()); expect(checked.check.outcome).toBe("passed");
    const repo = new DiagramRepository(root), p = await repo.register(checked), d = repo.get("preview", p.id), saved = await repo.applySave(repo.previewSave(p.id, d.revision).token);
    const reopened = new DiagramRepository(root).get("saved", saved.id); expect(reopened.artifact).toEqual(checked); expect(reopened.outcome).toBe("passed"); expect(reopened.alignment).toBe("unverified"); expect(reopened.artifact.reproduction.outcome).toBe("not-applicable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("attributes a temporal failure without marking an unrelated passing property broken", async () => {
  const a = exampleArtifact("temporal");
  a.files[0]!.content = a.files[0]!.content.replace("====", "AlwaysSafe == []Safe\n====");
  a.files[1]!.content = "SPECIFICATION Spec\nPROPERTIES EventuallyDone AlwaysSafe\n";
  a.rules.push({ id: "AlwaysSafe", label: "The domain always remains safe", kind: "temporal", provenance: "Independent fixture property", evidence: [] });
  const result = await checkArtifact(a); expect(result.check.outcome).toBe("violated");
  expect(result.check.results.map(r => [r.rule, r.outcome])).toEqual([["EventuallyDone", "violated"], ["AlwaysSafe", "passed"]]);
  expect(result.traces.every(t => t.rule === "EventuallyDone")).toBe(true);
});
it("preserves quoted configuration constants when isolating a failing rule", async () => {
  const a = exampleArtifact("broken");
  a.files[0]!.content = a.files[0]!.content.replace("VARIABLE pc", "CONSTANT Word\nVARIABLE pc").replace("Safe == pc \\in 0..2", 'Safe == /\\ pc \\in 0..2 /\\ Word = "a  b"');
  a.files[1]!.content = 'SPECIFICATION Spec\nCONSTANT Word = "a  b"\nINVARIANTS Safe NoDone\n';
  a.rules.push({ id: "Safe", label: "The exact configured value is retained", kind: "invariant", provenance: "Independent fixture rule", evidence: [] });
  const result = await checkArtifact(a);
  expect(result.check.results.map(r => [r.rule, r.outcome])).toEqual([["NoDone", "violated"], ["Safe", "passed"]]);
});
it("names a deadlock instead of reporting a generic incomplete run", async () => {
  const a = exampleArtifact(); a.files[0]!.content = a.files[0]!.content.replace(String.raw`Next == Start \/ Finish \/ Stay`, String.raw`Next == Start \/ Finish`);
  expect(a.files[0]!.content).not.toContain("Stay\nSpec");
  const result = await checkArtifact(a); expect(result.check.outcome).toBe("incomplete"); expect(result.check.results[0]?.detail).toMatch(/deadlock/);
});
