/** Precision-first structural hints. No graph maintenance, source reads or heavy imports. */
import { WINDOWING } from "../frozen.js";
import type { GraphNodeRow } from "../graph-reader.js";
import type { EventContext, EventOutcome, GrepHit } from "./events.js";
import { isTestPath } from "./events.js";
import type { FileDiff } from "./diff.js";

export const GRAPH_CAP = 1200;
export const GRAPH_MAX_NODES = 3;
export const GRAPH_MAX_HITS = 60;
export const GRAPH_MAX_FILES = 5;
export const graphEnabled = (): boolean => process.env.MEX_HOOK_GRAPH !== "0";
const key = (id: string): string => `graph:${id}`;
const location = (n: GraphNodeRow): string => `#${n.name} ${n.file}:${n.start}-${n.end}`;

/** Code-shaped names only: plain prose words, regexes and common search terms abstain. */
export function identifiers(text: string): string[] {
  const candidates = text.slice(0, 32000).match(/[A-Za-z_$][\w$]{3,127}/g) ?? [];
  const explicit = [...text.slice(0, 32000).matchAll(/`([A-Za-z_$][\w$]{3,127})`/g)].map(m => m[1]!);
  return [...new Set([...candidates.filter((name) => /[a-z][A-Z]|[a-zA-Z]_[a-zA-Z]|^[A-Z][a-z]+[A-Z]/.test(name)), ...explicit])].slice(0, 24);
}

function render(ctx: EventContext, nodes: readonly GraphNodeRow[], mode: "definition" | "search" | "impact", cap = GRAPH_CAP): EventOutcome | null {
  if (!graphEnabled() || !ctx.reader) return null;
  const seen = new Set(ctx.shown);
  const lines = [`MEX graph (${mode}; indexed locations):`];
  const ids: string[] = [];
  const visited = new Set<string>();
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    if (visited.size >= 12) break;
    visited.add(node.id);
    if (ids.length >= 12 || seen.has(key(node.id)) || isTestPath(node.file) || node.end <= node.start) continue;
    const related = mode === "definition" ? [] : ctx.reader.callers(node.id, 12)
      .filter((n) => !isTestPath(n.file) && !seen.has(key(n.id)) && n.id !== node.id).slice(0, 3);
    // Impact without another production caller adds nothing to check.
    if (mode === "impact" && related.length === 0) continue;
    const suffix = related.length ? ` · ${mode === "impact" ? "check callers" : "callers"}: ${related.map(location).join("; ")}` : "";
    const line = `- ${location(node)}${suffix}`;
    if (lines.join("\n").length + line.length + 1 > cap) continue;
    lines.push(line);
    for (const n of [node, ...related]) { seen.add(key(n.id)); ids.push(n.id); }
    if (lines.length > GRAPH_MAX_NODES) break;
  }
  return ids.length ? { text: lines.join("\n"), remember: ids.map(key), ids: [], graphNodes: ids, graphChars: lines.join("\n").length } : null;
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
  const definitions = names.flatMap((name) => {
    const matches = ctx.reader!.exactName(name, 4);
    return matches.length <= 3 ? matches : [];
  });
  // Verified names are the evidence gate even when the enclosing hit has a different name.
  if (definitions.length === 0) return null;
  const enclosing = hits.slice(0, 12).flatMap((hit) => {
    const node = hit.line === null ? null : ctx.reader!.enclosing(hit.file, hit.line);
    return node ? [node] : [];
  });
  return render(ctx, [...definitions, ...enclosing], "search");
}

export function composeGraphEdit(ctx: EventContext, diffs: ReadonlyMap<string, FileDiff>, only?: readonly string[]): EventOutcome | null {
  if (!graphEnabled() || !ctx.reader) return null;
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

/** Knowledge wins the event cap. Graph lines are atomic, including their dedup keys. */
export function afterKnowledge(knowledge: EventOutcome | null, graph: EventOutcome | null, cap = 4000): EventOutcome | null {
  if (!graph || (knowledge?.text.length ?? 0) + graph.text.length + (knowledge?.text ? 2 : 0) > cap) return knowledge;
  return { text: [knowledge?.text, graph.text].filter(Boolean).join("\n\n"), ids: knowledge?.ids ?? [],
    pointers: knowledge?.pointers, remember: [...(knowledge?.remember ?? []), ...graph.remember], graphNodes: graph.graphNodes, graphChars: graph.graphChars };
}

/** Offline candidate only; deliberately not registered on the Read hook. */
export function composeGraphReadCandidate(ctx: EventContext, file: string, start: number, limit: number): EventOutcome | null {
  if (!graphEnabled() || !ctx.reader || !start || !limit || limit > 200) return null;
  const node = ctx.reader.enclosing(file, start);
  if (!node || start + limit - 1 > node.end) return null;
  return render(ctx, [node], "impact");
}
