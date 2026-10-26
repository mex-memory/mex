import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type { StatechartArtifact } from "@mex/hub-contracts/statechart";
const ProjectionSchema = z.object({ states: z.array(z.object({ state: z.string(), values: z.record(z.union([z.string(), z.number(), z.boolean()])) }).strict()).min(1).max(100_000), actions: z.record(z.union([z.string(), z.array(z.string()).min(1).max(200)])).refine(v => Object.keys(v).length <= 200) }).strict();
type Vars = Record<string, unknown>;
type RawTrace = { invariant: string; steps: { action: string | null; vars: Vars }[] };
interface ParsedGraph { nodes: Map<string, { id: string; vars: Vars; init: boolean }>; edges: { from: string; to: string; action: string }[]; loops: { from: string; to: string; action: string }[] }
async function baselineParsers(): Promise<{ parseTraces(s: string): RawTrace[]; parseDot(s: string): ParsedGraph }> {
  const candidates = [new URL("../upstream/scripts/lib.mjs", import.meta.url), new URL("../../skills/mex-statechart/upstream/scripts/lib.mjs", import.meta.url)];
  const url = candidates.find(u => existsSync(fileURLToPath(u))); if (!url) throw new Error("Packaged baseline parsers unavailable.");
  return import(pathToFileURL(fileURLToPath(url)).href);
}
export function checkerTraceText(output: string): string {
  const lines = output.split("\n");
  const start = lines.findIndex(line => /^Error: (Invariant|Temporal|Action property|Property)/u.test(line));
  if (start < 0) return "";
  const end = lines.findIndex((line, i) => i > start && /^(?:\d[\d,]* states generated|Finished in|Progress\(|Model checking completed)/u.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
}
/** Pure data maps TLC valuations/actions into reviewed graph identities; no executable mapping on reads. */
export async function projectChecker(a: StatechartArtifact, dot: string, output: string): Promise<{ traces: StatechartArtifact["traces"]; complete: boolean }> {
  const f = a.files.find(x => x.name === "Projection.json"); if (!f) return { traces: [], complete: false };
  const projection = ProjectionSchema.parse(JSON.parse(f.content));
  const { parseDot, parseTraces } = await baselineParsers();
  const graph = parseDot(dot);
  const stateOf = (vars: Vars) => {
    const matches = projection.states.filter(p => Object.entries(p.values).every(([key, value]) => vars[key] === value));
    if (matches.length !== 1 || !a.states.some(s => s.id === matches[0]!.state)) throw new Error("Unmapped or ambiguous TLC state.");
    return matches[0]!.state;
  };
  const edgeFor = (action: string, from: string, to: string) => { const mapped = projection.actions[action]; const ids = typeof mapped === "string" ? [mapped] : mapped ?? []; const edges = a.transitions.filter(t => ids.includes(t.id) && t.from === from && t.to === to); if (edges.length !== 1) throw new Error("Unmapped or ambiguous TLC transition."); return edges[0]!; };
  const covered = new Set<string>(), visited = new Set<string>();
  for (const node of graph.nodes.values()) { const id = stateOf(node.vars); visited.add(id); if (node.init && !a.initial.includes(id)) throw new Error("Initial states differ from the checked model."); }
  for (const e of [...graph.edges, ...graph.loops]) {
    const from = stateOf(graph.nodes.get(e.from)!.vars), to = stateOf(graph.nodes.get(e.to)!.vars);
    if (from === to) continue; // Overview projection omits internal/stuttering actions explicitly.
    const edge = edgeFor(e.action, from, to);
    if (!edge) throw new Error("A checked model transition is absent from the graph."); covered.add(edge.id);
  }
  const traces: StatechartArtifact["traces"] = [];
  for (const raw of parseTraces(output)) {
    const rule = a.rules.find(r => r.id === raw.invariant); if (!rule) continue;
    const steps: StatechartArtifact["traces"][number]["steps"] = [];
    for (const s of raw.steps) {
      const state = stateOf(s.vars), previous = steps.at(-1)?.state;
      if (previous === state) continue;
      const transition = previous ? edgeFor(s.action ?? "", previous, state).id : undefined;
      if (previous && !transition) throw new Error("Counterexample action is unmapped.");
      steps.push({ state, ...(transition ? { transition } : {}) });
    }
    traces.push({ id: `trace${traces.length + 1}`, rule: rule.id, kind: rule.kind === "goal" ? "goal" : "counterexample", steps, raw: checkerTraceText(output) });
  }
  return { traces, complete: a.transitions.every(t => covered.has(t.id)) && a.states.filter(s => !a.states.some(x => x.parent === s.id)).every(s => visited.has(s.id)) };
}
