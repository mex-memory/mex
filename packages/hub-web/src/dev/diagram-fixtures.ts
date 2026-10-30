import sample from "../../../../skills/mex-statechart/references/example.json" with { type: "json" };
import { StatechartArtifactSchema, statechartMermaid, type DiagramDetail, type DiagramSavePlan } from "@mex/hub-contracts/statechart";
const artifact = StatechartArtifactSchema.parse(sample);
artifact.traces = [{ id: "path1", rule: "Safe", kind: "counterexample", steps: [{ state: "ready" }, { state: "running", transition: "start" }, { state: "done", transition: "finish" }], raw: "Illustrative recorded path; this fixture is not checker evidence." }];
export const diagramFixture: DiagramDetail = { id: "1".repeat(32), title: artifact.title, summary: artifact.summary, kind: "preview", expiresAt: "2099-10-27T00:00:00.000Z", revision: "a".repeat(64), outcome: "incomplete", artifact, freshness: [], alignment: "unverified" };
export const diagramFixturePlan: DiagramSavePlan = { token: "2".repeat(32), previewId: diagramFixture.id, revision: diagramFixture.revision, expiresAt: "2099-10-27T00:00:00.000Z", writes: [{ path: `.mex/diagrams/${"3".repeat(32)}/record.md`, content: JSON.stringify(artifact, null, 2) }] };

export function nestedDiagramFixture(): DiagramDetail {
  const d = structuredClone(diagramFixture), a = d.artifact;
  a.title = "Connection and transfer change independently"; d.title = a.title;
  a.states = [{ id: "session", label: "Session", evidence: [] }, { id: "online", label: "Connection available", parent: "session", region: "connection", evidence: [] }, { id: "offline", label: "Connection interrupted - waiting for an explicit reconnect", parent: "session", region: "connection", evidence: [] }, { id: "transfer", label: "Transfer", parent: "session", region: "transferRegion", evidence: [] }, { id: "queued", label: "Files retained while the transfer waits for a valid connection", parent: "transfer", evidence: [] }, { id: "sending", label: "Sending the retained files", parent: "transfer", evidence: [] }];
  a.transitions = [{ id: "interrupt", from: "online", to: "offline", event: "Connection drops", condition: "A transfer may retain files independently.", evidence: [], rules: ["Safe"] }, { id: "send", from: "queued", to: "sending", event: "Resume with a valid session", condition: "A valid connection and session are required.", evidence: [], rules: ["Safe"] }];
  a.initial = ["online", "queued"]; a.traces = [];
  // This is illustrative browser fixture data, never production checker evidence.
  a.diagram.mermaid = statechartMermaid(a);
  return d;
}

/** The reported nine-state/eighteen-transition shape, with no claimed checker evidence. */
export function recoveryDiagramFixture(): DiagramDetail {
  const d = structuredClone(diagramFixture), a = d.artifact;
  a.title = "Setup interruption and recovery"; d.title = a.title;
  const states = { working: "Active setup and population", population: "Population needs attention", finalize: "Files audited; finalizing", retry: "Stopped run; fix and retry", ready: "Setup prepared on disk", hub_retry: "Prepared; Hub startup failed", restart: "Old CLI has stale imports", stopped: "CLI stopped; saved files remain", hub: "Commit review and completion" };
  a.states = Object.entries(states).map(([id, label]) => ({ id, label, evidence: [] }));
  const edges = [
    ["working", "population", "Agent returns with population incomplete"], ["working", "finalize", "Population audit passes"],
    ["working", "retry", "Failure or browser Cancel settles"], ["population", "working", "Reopen agent or check files"],
    ["retry", "working", "Fix cause and retry setup"], ["finalize", "retry", "Finalization fails"],
    ["finalize", "ready", "Finalization succeeds"], ["ready", "hub", "Open finishing Hub"],
    ["ready", "hub_retry", "Hub startup fails"], ["hub_retry", "ready", "Fix cause and retry Hub"],
    ["ready", "restart", "Rebuilt chunks break old imports"], ["restart", "ready", "Start current CLI with setup --browser"],
    ["working", "stopped", "Cancel terminal or process exits"], ["population", "stopped", "Finish later or cancel terminal"],
    ["finalize", "stopped", "Cancel terminal during finalization"], ["hub", "stopped", "Stop finishing Hub or CLI"],
    ["stopped", "working", "New CLI resumes unfinished setup"], ["stopped", "ready", "New CLI reopens prepared setup"],
  ];
  a.transitions = edges.map(([from, to, event], i) => ({ id: `edge${i}`, from: from!, to: to!, event: event!, condition: "", rules: [], evidence: [] }));
  a.initial = ["working"]; a.traces = []; a.evidence = []; a.mapping = [];
  a.diagram.mermaid = statechartMermaid(a);
  return d;
}
