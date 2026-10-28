import { graphlib, layout, type EdgeLabel, type GraphLabel, type NodeLabel, type Point } from "@dagrejs/dagre";
import type { StatechartArtifact } from "@mex/hub-contracts/statechart";

export interface GraphBox { x: number; y: number; width: number; height: number }
export interface StatechartGraph {
  width: number;
  height: number;
  nodes: Map<string, GraphBox>;
  groups: { id: string; state: string; region?: string; box: GraphBox }[];
  edges: Map<string, { points: Point[]; label: GraphBox }>;
}
export interface StatechartView { x: number; y: number; scale: number }

const stateKey = (id: string) => `state:${id}`;
const groupKey = (id: string) => `group:${id}`;
const labelHeight = (text: string, columns: number, line: number) => (Math.ceil(text.length / columns) + 1) * line;

/** Layout only: every visible state and edge keeps its artifact identity. No generated HTML or CSS. */
export function layoutStatechartGraph(artifact: StatechartArtifact): StatechartGraph {
  const graph = new graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ compound: true, multigraph: true });
  graph.setGraph({ rankdir: "TB", ranker: "longest-path", nodesep: 42, ranksep: 32, edgesep: 24, marginx: 44, marginy: 44 });
  const parents = new Set(artifact.states.flatMap(state => state.parent ? [state.parent] : []));
  const groups: { id: string; state: string; region?: string }[] = [];
  for (const state of artifact.states) {
    graph.setNode(stateKey(state.id), { width: 172, height: 36 + labelHeight(state.label, 22, 16) });
    if (parents.has(state.id)) {
      graph.setNode(groupKey(state.id), { width: 0, height: 0, padding: 28 });
      groups.push({ id: groupKey(state.id), state: state.id });
      // A composite's state is a real leaf inside its container. This also supports
      // transitions to/from composites, which Dagre cannot route to cluster nodes.
      graph.setParent(stateKey(state.id), groupKey(state.id));
    }
  }
  for (const state of artifact.states) {
    if (!state.parent) continue;
    let parent = groupKey(state.parent);
    if (state.region) {
      const region = `region:${state.parent}:${state.region}`;
      if (!graph.hasNode(region)) {
        graph.setNode(region, { width: 0, height: 0, padding: 24 });
        graph.setParent(region, parent);
        groups.push({ id: region, state: state.parent, region: state.region });
      }
      parent = region;
    }
    graph.setParent(parents.has(state.id) ? groupKey(state.id) : stateKey(state.id), parent);
    // Invisible layout constraints place a composite's header before its children;
    // they are never returned as transitions or drawn as behavior.
    graph.setEdge(stateKey(state.parent), stateKey(state.id), { weight: 2 }, `containment:${state.id}`);
  }
  for (const transition of artifact.transitions) {
    graph.setEdge(stateKey(transition.from), stateKey(transition.to), {
      width: 148, height: 12 + labelHeight(transition.event, 23, 14), labelpos: "c",
    }, transition.id);
  }
  layout(graph);
  const box = (node: NodeLabel): GraphBox => ({ x: node.x! - node.width / 2, y: node.y! - node.height / 2, width: node.width, height: node.height });
  return {
    width: graph.graph().width!, height: graph.graph().height!,
    nodes: new Map(artifact.states.map(state => [state.id, box(graph.node(stateKey(state.id))!)])),
    groups: groups.map(group => ({ ...group, box: box(graph.node(group.id)!) })),
    edges: new Map(artifact.transitions.map(transition => {
      const edge = graph.edge({ v: stateKey(transition.from), w: stateKey(transition.to), name: transition.id })!;
      return [transition.id, { points: edge.points!, label: { x: edge.x! - 74, y: edge.y! - edge.height! / 2, width: 148, height: edge.height! } }];
    })),
  };
}

/** Smooth the layout's routed polyline without filling or inventing graph edges. */
export function statechartEdgePath(points: readonly Point[]): string {
  if (!points.length) return "";
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!, next = points[i + 1]!;
    path += ` Q ${p.x} ${p.y} ${(p.x + next.x) / 2} ${(p.y + next.y) / 2}`;
  }
  const last = points[points.length - 1]!;
  return `${path} L ${last.x} ${last.y}`;
}

export function fitStatechartView(graph: Pick<StatechartGraph, "width" | "height">, size: { width: number; height: number }): StatechartView {
  const scale = Math.min(1, size.width / graph.width, (size.height - 66) / graph.height);
  return { scale, x: (size.width - graph.width * scale) / 2, y: (size.height - 66 - graph.height * scale) / 2 };
}
