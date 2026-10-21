/** Precision-first structural hints. No graph maintenance, source reads or heavy imports. */
import { WINDOWING } from "../frozen.js";
import type { GraphNodeRow } from "../graph-reader.js";
import type { EventContext, EventOutcome, GrepHit } from "./events.js";
import { isTestPath, MAX_GROUNDING_LINES } from "./events.js";
import type { FileDiff } from "./diff.js";

export const GRAPH_CAP = 1200;
export const GRAPH_MAX_NODES = 3;
export const GRAPH_MAX_HITS = 60;
export const GRAPH_MAX_FILES = 5;
export const graphEnabled = (): boolean => process.env.MEX_HOOK_GRAPH !== "0";
const key = (id: string): string => `graph:${id}`;
/** An impact note says something a location note does not, so it has its own memory: once per edited symbol. */
const impactKey = (id: string): string => `impact:${id}`;
const location = (n: GraphNodeRow): string => `#${n.name} ${n.file}:${n.start}-${n.end}`;
const eligible = (n: GraphNodeRow): boolean => !isTestPath(n.file) && !n.name.includes("<callback") &&
  n.end >= n.start && n.end - n.start + 1 <= MAX_GROUNDING_LINES;
const impactEnabled = (): boolean => process.env.MEX_HOOK_GRAPH_IMPACT === "1";

/** Code-shaped names only: plain prose words, regexes and common search terms abstain. */
export function identifiers(text: string): string[] {
  const candidates = text.slice(0, 32000).match(/[A-Za-z_$][\w$]{3,127}/g) ?? [];
  const explicit = [...text.slice(0, 32000).matchAll(/`([A-Za-z_$][\w$]{3,127})`/g)].map(m => m[1]!);
  return [...new Set([...candidates.filter((name) => /[a-z][A-Z]|[a-zA-Z]_[a-zA-Z]|^[A-Z][a-z]+[A-Z]/.test(name)), ...explicit])].slice(0, 24);
}

function render(ctx: EventContext, nodes: readonly GraphNodeRow[], mode: "definition" | "search" | "impact", cap = GRAPH_CAP, trace = false): EventOutcome | null {
  if (!graphEnabled() || !ctx.reader) return null;
  const seen = new Set(ctx.shown);
  const lines = [`MEX graph (${mode}; indexed locations):`];
  const ids: string[] = [];
  const rows: NonNullable<EventOutcome["graphRows"]> = [];
  let traced = false;
  const visited = new Set<string>();
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    if (visited.size >= 12) break;
    visited.add(node.id);
    // An edited symbol shown earlier as a search hit or a caller has still not had its callers
    // named as the ones to check, so impact skips only symbols it already reported, and keeps
    // callers the session has seen: they are exactly what the edit may break.
    const impact = mode === "impact";
    if (ids.length >= 12 || seen.has(impact ? impactKey(node.id) : key(node.id)) || !eligible(node)) continue;
    const related = mode === "impact" ? ctx.reader.callers(node.id, 12)
      .filter(n => eligible(n) && n.id !== node.id).slice(0, 3) : [];
    const next = trace && !traced ? ctx.reader.callees(node.id, 12)
      .find(n => eligible(n) && !seen.has(key(n.id)) && n.id !== node.id) : undefined;
    if (next) { related.push(next); traced = true; }
    if (mode === "impact" && related.length === 0) continue;
    const suffix = related.length ? ` | ${mode === "impact" ? "check callers" : "next location (read body)"}: ${related.map(location).join("; ")}` : "";
    const line = `- location ${location(node)}${suffix}`;
    if (lines.join("\n").length + line.length + 1 > cap) continue;
    lines.push(line);
    rows.push({ text: line, nodes: [node, ...related].map(n => n.id),
      remember: [...[node, ...related].map(n => key(n.id)), ...(impact ? [impactKey(node.id)] : [])] });
    if (impact) seen.add(impactKey(node.id));
    for (const n of [node, ...related]) { seen.add(key(n.id)); ids.push(n.id); }
    if (lines.length > GRAPH_MAX_NODES) break;
  }
  if (!ids.length) return null;
  const remember = [...new Set(ids)].map(key);
  if (mode === "impact") remember.push(...[...seen].filter((k) => k.startsWith("impact:") && !ctx.shown.has(k)));
  return { text: lines.join("\n"), remember, ids: [], graphRows: rows, graphHeader: lines[0], graphNodes: ids, graphChars: lines.join("\n").length };
}

export function composeGraphPrompt(ctx: EventContext, prompt: string): EventOutcome | null {
  if (!graphEnabled() || !ctx.reader || /^\s*<task-notification>/.test(prompt)) return null;
  const nodes = identifiers(prompt).flatMap((name) => {
    const matches = ctx.reader!.exactName(name, 4);
    return matches.length <= 3 ? matches : [];
  });
  const long = wordCount(prompt) > WINDOWING.singleMaxWords;
  return render(ctx, nodes.filter((n) => promptDefinition(n, long)), "definition");
}

/** A class shorter than this is a marker (an exception subclass, a metaclass shell): its location adds nothing to its name. */
export const GRAPH_MIN_CLASS_LINES = 5;

/**
 * Which verified definitions a prompt note may name: callables always; a class
 * only in a prompt longer than one scoring window (a task or bug report naming
 * the classes involved), and only when it spans at least `GRAPH_MIN_CLASS_LINES`.
 */
export function promptDefinition(node: GraphNodeRow, longPrompt: boolean): boolean {
  if (node.kind === "function" || node.kind === "method") return true;
  return longPrompt && node.kind === "class" && node.end - node.start + 1 >= GRAPH_MIN_CLASS_LINES;
}

const wordCount = (text: string): number => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length);

export function composeGraphSearch(ctx: EventContext, hits: readonly GrepHit[], pattern = "", limits = { hits: GRAPH_MAX_HITS, files: GRAPH_MAX_FILES }): EventOutcome | null {
  if (!graphEnabled() || !ctx.reader || hits.length === 0 || hits.length > limits.hits || new Set(hits.map((h) => h.file)).size > limits.files) return null;
  const names = identifiers(pattern);
  if (names.length === 0) return null;
  const files = [...new Set(hits.map(h => h.file))];
  const definitions: GraphNodeRow[] = [];
  const summaries: NonNullable<EventOutcome["graphRows"]> = [];
  let verified = false;
  let summarized = false;
  for (const name of names) {
    const matches = ctx.reader.exactName(name, 100, files).filter(n => files.includes(n.file));
    verified ||= matches.length > 0 || ctx.reader.exactName(name, 1).length > 0;
    if (matches.length > 3) {
      const remember = [`definitions:${name}:${files.join(",")}`];
      if (ctx.shown.has(remember[0]!)) { summarized = true; continue; }
      const count = ctx.reader.exactNameCount?.(name, files) ?? matches.length;
      const paths = [...new Set(matches.map(n => n.file))];
      const text = `- ${count} definitions: ${paths.join(", ")} | #${name}; read bodies`;
      if (summaries.length === 0 && text.length < GRAPH_CAP / 2) summaries.push({ text, nodes: [], remember });
    } else definitions.push(...matches);
  }
  if (summarized && !summaries.length && !definitions.length) return null;
  if (!verified) return null;
  const enclosing = hits.slice(0, 12).flatMap((hit) => {
    const node = hit.line === null ? null : ctx.reader!.enclosing(hit.file, hit.line);
    if (!node || eligible(node)) return node ? [node] : [];
    return ctx.reader!.inRange(hit.file, hit.line!, hit.line!, 12).filter(eligible).slice(0, 1);
  });
  const locations = render(ctx, [...definitions, ...enclosing], "search", GRAPH_CAP, /trace|flow|chain/i.test(pattern));
  if (!summaries.length) return locations;
  const header = "MEX graph (search; indexed locations):";
  const rows = [...summaries, ...(locations?.graphRows ?? [])].slice(0, GRAPH_MAX_NODES);
  while ([header, ...rows.map(row => row.text)].join("\n").length > GRAPH_CAP) rows.pop();
  const text = [header, ...rows.map(row => row.text)].join("\n");
  return { text, ids: [], remember: rows.flatMap(row => row.remember), graphRows: rows, graphHeader: header,
    graphNodes: rows.flatMap(row => row.nodes), graphChars: text.length };

}

export function composeGraphEdit(ctx: EventContext, diffs: ReadonlyMap<string, FileDiff>, only?: readonly string[]): EventOutcome | null {
  if (!impactEnabled() || !graphEnabled() || !ctx.reader) return null;
  const nodes: GraphNodeRow[] = [];
  for (const [file, diff] of [...diffs].slice(0, 5)) {
    if (only && !only.includes(file)) continue;
    for (const [start, end] of diff.ranges.slice(0, 20)) {
      const node = ctx.reader.enclosing(file, Math.max(1, Math.ceil(start)));
      if (node && start >= node.start && end <= node.end) nodes.push(node);
    }
  }
  return render(ctx, nodes, "impact");
}

/** Two graph notes as one, so the budget can still drop the graph tail whole. */
export function joinGraph(first: EventOutcome | null, second: EventOutcome | null): EventOutcome | null {
  if (!first || !second) return first ?? second;
  const text = `${first.text}\n\n${second.text}`;
  return { text, ids: [], remember: [...first.remember, ...second.remember], graphNodes: [...(first.graphNodes ?? []), ...(second.graphNodes ?? [])], graphChars: text.length, graphRows: [...(first.graphRows ?? []), ...(second.graphRows ?? [])], graphHeader: first.graphHeader };
}

/** Knowledge wins the event cap. Graph lines are atomic, including their dedup keys. */
export function afterKnowledge(knowledge: EventOutcome | null, graph: EventOutcome | null, cap = 4000): EventOutcome | null {
  if (graph?.graphRows && knowledge) {
    const shown = new Set([...(knowledge.knowledgeNodes ?? []), ...knowledge.remember.filter(k => k.startsWith("graph:")).map(k => k.slice(6))]);
    const rows = graph.graphRows.filter(row => !row.nodes.some(id => shown.has(id)));
    if (!rows.length) return knowledge;
    const text = [graph.graphHeader, ...rows.map(row => row.text)].join("\n");
    graph = { ...graph, text, graphRows: rows, graphNodes: rows.flatMap(row => row.nodes),
      remember: rows.flatMap(row => row.remember), graphChars: text.length };
  }
  if (!graph || (knowledge?.text.length ?? 0) + graph.text.length + (knowledge?.text ? 2 : 0) > cap) return knowledge;
  return { text: [knowledge?.text, graph.text].filter(Boolean).join("\n\n"), ids: knowledge?.ids ?? [],
    knowledgeNodes: knowledge?.knowledgeNodes, pointers: knowledge?.pointers,
    remember: [...(knowledge?.remember ?? []), ...graph.remember], graphNodes: graph.graphNodes, graphChars: graph.graphChars };

}

/** Offline candidate only; deliberately not registered on the Read hook. */
export function composeGraphReadCandidate(ctx: EventContext, file: string, start: number, limit: number): EventOutcome | null {
  if (!impactEnabled() || !graphEnabled() || !ctx.reader || !start || !limit || limit > 200) return null;
  const node = ctx.reader.enclosing(file, start);
  if (!node || start + limit - 1 > node.end) return null;
  return render(ctx, [node], "impact");
}
