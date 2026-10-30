import { describe, it, expect } from "vitest";
import { StatechartArtifactSchema, statechartMermaid, statechartTerminal } from "@mex/hub-contracts/statechart";
import { exampleArtifact } from "../fixtures.js";
describe("statechart artifact seam", () => {
  it.each(["valid", "broken", "goal", "temporal", "incomplete"] as const)("retains an honest %s candidate", mode => { const a = exampleArtifact(mode); expect(StatechartArtifactSchema.parse(a)).toEqual(a); expect(a.check.outcome).toBe("incomplete"); expect(statechartTerminal(a)).toContain("model check: incomplete"); });
  it("refuses mismatched Mermaid, markup, unresolved identities and false success", () => {
    const a = exampleArtifact();
    expect(StatechartArtifactSchema.safeParse({ ...a, diagram: { validity: "valid", mermaid: "stateDiagram-v2\n click ready evil()" } }).success).toBe(false);
    expect(StatechartArtifactSchema.safeParse({ ...a, states: [{ ...a.states[0], label: '<script>alert(1)</script>' }] }).success).toBe(false);
    expect(StatechartArtifactSchema.safeParse({ ...a, initial: ["missing"] }).success).toBe(false);
    expect(StatechartArtifactSchema.safeParse({ ...a, check: { ...a.check, outcome: "passed" } }).success).toBe(false);
  });
  it("keeps nested and independent regions in both presentations", () => {
    const a = exampleArtifact(); a.states = [{ id: "session", label: "Session", evidence: [] }, { id: "online", label: "Connection online", parent: "session", region: "connection", evidence: [] }, { id: "active", label: "Transfer active", parent: "session", region: "transfer", evidence: [] }]; a.transitions = []; a.initial = ["session"]; a.diagram.mermaid = statechartMermaid(a);
    expect(StatechartArtifactSchema.parse(a).diagram.mermaid).toContain("    --"); expect(statechartTerminal(a)).toContain("session / transfer");
  });
  it("refuses out-of-order finite paths", () => { const a = exampleArtifact("broken"); a.traces = [{ id: "trace1", rule: "NoDone", kind: "counterexample", raw: "TLC", steps: [{ state: "ready" }, { state: "done", transition: "finish" }] }]; expect(StatechartArtifactSchema.safeParse(a).success).toBe(false); });
});
it("caps normalized graph work before browser rendering", () => { const a = exampleArtifact(); a.states = Array.from({ length: 81 }, (_, i) => ({ id: `s${i}`, label: `State ${i}`, evidence: [] })); a.transitions = []; a.initial = ["s0"]; a.diagram.mermaid = statechartMermaid(a); expect(StatechartArtifactSchema.safeParse(a).success).toBe(false); });
it("counts UTF-8 bytes as well as characters at file boundaries", () => { const a = exampleArtifact(); a.files.push({ name: "Unicode.txt", content: "🙂".repeat(40_000) }); expect(StatechartArtifactSchema.safeParse(a).success).toBe(false); });
it("refuses names that collide on case-insensitive filesystems or with snapshot ownership", () => {
  const a = exampleArtifact(); a.files.push({ ...a.files[0]!, name: "job.tla" }); expect(StatechartArtifactSchema.safeParse(a).success).toBe(false);
  const b = exampleArtifact(); b.files.push({ name: "Record.md", content: "Untrusted owner" }); expect(StatechartArtifactSchema.safeParse(b).success).toBe(false);
});
