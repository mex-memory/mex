import { describe, expect, it } from "vitest";
import { diagramFixture, nestedDiagramFixture } from "../dev/diagram-fixtures";
import { fitStatechartView, layoutStatechartGraph, type GraphBox } from "./statechart-graph";

const contains = (outer: GraphBox, inner: GraphBox) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
describe("Statechart graph layout", () => {
  it("retains artifact identities and leaves source data unchanged", () => {
    const artifact = structuredClone(diagramFixture.artifact), before = structuredClone(artifact);
    const graph = layoutStatechartGraph(artifact);
    expect([...graph.nodes.keys()]).toEqual(artifact.states.map(state => state.id));
    expect([...graph.edges.keys()]).toEqual(artifact.transitions.map(edge => edge.id));
    expect(artifact).toEqual(before);
    expect(layoutStatechartGraph(artifact)).toEqual(graph);
  });
  it("preserves distinct parallel, reverse and self transitions", () => {
    const artifact = structuredClone(diagramFixture.artifact), edge = artifact.transitions[0]!;
    artifact.transitions.push({ ...edge, id: "parallel" }, { ...edge, id: "reverse", from: edge.to, to: edge.from }, { ...edge, id: "self", to: edge.from });
    const graph = layoutStatechartGraph(artifact);
    expect(graph.edges.size).toBe(artifact.transitions.length);
    expect(graph.edges.get(edge.id)!.points).not.toEqual(graph.edges.get("parallel")!.points);
    for (const { points, label } of graph.edges.values()) {
      expect(points.length).toBeGreaterThan(2);
      expect([...points.flatMap(point => [point.x, point.y]), ...Object.values(label)].every(Number.isFinite)).toBe(true);
    }
  });
  it("contains composite states and keeps independent regions separate, including parent transitions", () => {
    const artifact = nestedDiagramFixture().artifact;
    artifact.transitions.push({ ...artifact.transitions[0]!, id: "closeSession", from: "session", to: "offline" });
    const graph = layoutStatechartGraph(artifact);
    const session = graph.groups.find(group => group.state === "session" && !group.region)!;
    for (const node of graph.nodes.values()) expect(contains(session.box, node)).toBe(true);
    const connection = graph.groups.find(group => group.region === "connection")!;
    const transfer = graph.groups.find(group => group.region === "transferRegion")!;
    expect(contains(connection.box, graph.nodes.get("online")!)).toBe(true);
    expect(contains(transfer.box, graph.nodes.get("sending")!)).toBe(true);
    expect(contains(connection.box, graph.nodes.get("sending")!)).toBe(false);
    expect(graph.edges.size).toBe(artifact.transitions.length);
  });
  it("lays out the contract maximum with long labels and cycles without dropping behavior", () => {
    const artifact = structuredClone(diagramFixture.artifact);
    artifact.states = Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, label: "A long state label that must remain readable ".repeat(4).slice(0, 180), evidence: [] }));
    artifact.transitions = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, from: `s${i % 80}`, to: `s${(i + 1) % 80}`, event: "An event changes the system", condition: "", evidence: [], rules: [] }));
    artifact.initial = ["s0"];
    const graph = layoutStatechartGraph(artifact);
    expect(graph.nodes.size).toBe(80); expect(graph.edges.size).toBe(200);
    const world = { x: 0, y: 0, width: graph.width, height: graph.height };
    for (const node of graph.nodes.values()) expect(contains(world, node)).toBe(true);
    for (const { points, label } of graph.edges.values()) expect([...points.flatMap(point => [point.x, point.y]), ...Object.values(label)].every(Number.isFinite)).toBe(true);
  });
  it.each([480, 850])("fits the actual graph bounds at %ipx without clipping controls", width => {
    const graph = layoutStatechartGraph(nestedDiagramFixture().artifact), size = { width, height: 620 };
    const view = fitStatechartView(graph, size);
    expect(view.x).toBeGreaterThanOrEqual(0); expect(view.y).toBeGreaterThanOrEqual(0);
    expect(view.x + graph.width * view.scale).toBeLessThanOrEqual(width);
    expect(view.y + graph.height * view.scale).toBeLessThanOrEqual(size.height - 66);
  });
});
