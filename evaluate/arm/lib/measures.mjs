// Offline, deterministic transcript measures. No model calls or index writes.
import { shellSegments } from "./classify.mjs";

export const MODEL_PRICES = Object.freeze({
  "claude-sonnet-5-5": { input: 2, write: 4, read: 0.1, output: 10 },
});
export function priceUsage(usage, model) {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  return (usage.uncachedInput * p.input + usage.cacheWrite * p.write + usage.cacheRead * p.read + usage.output * p.output) / 1e6;
}
export const median = (values) => {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  return a.length ? (a[Math.floor(a.length / 2)] + a[Math.floor((a.length - 1) / 2)]) / 2 : null;
};
export function streamEvents(raw) {
  return String(raw).split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
export function firstCall(raw) {
  const event = streamEvents(raw).find((e) => e.type === "assistant" && e.message?.usage);
  if (!event) return null;
  const u = event.message.usage;
  return { model: event.message.model, cacheRead: Number(u.cache_read_input_tokens ?? 0), cacheWrite: Number(u.cache_creation_input_tokens ?? 0) };
}
export function neutralizeRows(rows) {
  const prefix = median(rows.map((r) => r.firstCall?.cacheRead).filter((n) => n > 0));
  for (const row of rows) {
    const p = MODEL_PRICES[row.firstCall?.model];
    const cold = row.firstCall?.cacheRead === 0;
    row.metrics.neutralCostUsd = cold ? (prefix !== null && p && row.firstCall.cacheWrite >= prefix
      ? row.metrics.costUsd - prefix * (p.write - p.read) / 1e6 : null) : row.metrics.costUsd;
    row.neutralPricing = { prefixTokens: prefix, adjusted: cold, available: row.metrics.neutralCostUsd !== null };
  }
  return rows;
}
export function isSearch(call) {
  return ["Grep", "Glob"].includes(call.name) || call.name === "Bash" && shellSegments(call.input?.command).some((s) => /^(?:rg|grep|egrep|fgrep|find|fd|git\s+(?:grep|ls-files)|ls|tree|dir)\b/.test(s));
}
const norm = (s) => String(s ?? "").replaceAll("\\", "/");
const pathsIn = (text) => [...new Set([...norm(text).matchAll(/(?:[\w.@-]+\/)+[\w.@-]+\.[\w]+/g)].map((m) => m[0]))];
// Symbols a note names: `#name` (graph and edit notes) and backticked code. A bare "in <word>" also
// matched prose ("in the", "in using"), and such words occur in nearly every later call, so an
// injection read as used whatever the agent did. Short or keyword-like spans are not symbols either.
const NOT_SYMBOLS = new Set(["None", "True", "False", "null", "undefined", "true", "false", "this", "self", "the"]);
const symbolsIn = (text) => [...new Set([...text.matchAll(/#([A-Za-z_$][\w.$]*)|`#?([A-Za-z_$][\w.$]*)(?:\(\))?`/g)].map((m) => m[1] ?? m[2]))]
  .filter((name) => name.length >= 4 && !NOT_SYMBOLS.has(name));
function touches(call, paths, symbols) {
  if (!["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "Bash"].includes(call.name)) return false;
  // Match inputs, never tool output (which would count the injection itself).
  const input = norm(JSON.stringify(call.input ?? {}));
  return paths.some((p) => input.includes(p)) || symbols.some((s) => input.includes(s));
}
export function measureSession({ raw, calls, entries = [], task, answer = "", contextIndex = null }) {
  const events = streamEvents(raw);
  const toolTimes = new Map();
  for (const e of events) if (e.type === "assistant") for (const b of e.message?.content ?? []) {
    if (b.type === "tool_use" && !toolTimes.has(b.id)) toolTimes.set(b.id, Date.parse(e.timestamp));
  }
  let aligned = 0;
  const injections = entries.filter((e) => e.chars > 0 && (e.ids?.length || e.injected || e.kind === "graph" || e.event === "graph")).map((e) => {
    const at = Date.parse(e.at);
    // PostToolUse follows its triggering tool; only later calls can show uptake.
    const after = Number.isInteger(e.toolCallIndex) ? e.toolCallIndex : calls.filter((c) => Number.isFinite(at) && toolTimes.get(c.id) <= at).length;
    if (Number.isFinite(at) || Number.isInteger(e.toolCallIndex)) aligned++;
    const entities = (contextIndex?.entities ?? []).filter((x) => e.ids?.includes(x.id));
    const text = String(e.text ?? "");
    const paths = pathsIn(text);
    const symbols = [...new Set([...symbolsIn(text), ...entities.flatMap((x) => x.symbols ?? []).map((s) => typeof s === "string" ? s : s.name).filter((s) => s && text.includes(s))])];
    const cited = [...paths, ...symbols, ...(e.ids ?? [])].some((s) => String(answer).includes(s));
    const used = calls.slice(after, after + 5).some((c) => touches(c, paths, symbols)) || cited;
    const gold = task.gold?.knowledge ?? [];
    const sources = [...paths, ...entities.map((x) => x.file ?? x.path ?? x.source?.file).filter(Boolean)];
    const offGold = e.event === "prompt" && gold.length > 0 && !gold.some((g) =>
      e.ids?.includes(g) || sources.some((p) => norm(g).includes(p.replace(/^\.mex\//, ""))));
    const graph = e.kind === "graph" || e.event === "graph" || e.note?.startsWith("graph") || /^MEX \(search hits/.test(text);
    return { event: e.event, kind: graph ? "graph" : "knowledge", ids: e.ids ?? [], afterToolCall: after, paths, symbols, used, offGold,
      followingCalls: offGold ? calls.slice(after).map((c) => ({ name: c.name, input: c.input })) : [] };
  });
  const searches = calls.filter(isSearch);
  const redundant = calls.flatMap((c, i) => isSearch(c) && injections.some((e) => e.afterToolCall <= i && e.symbols.some((s) => {
    const query = c.name === "Bash" ? c.input?.command : c.input?.pattern;
    return String(query ?? "").includes(s) && e.paths.length;
  })) ? [i + 1] : []);
  const goldPaths = (task.gold?.code ?? []).map((g) => norm(g.path));
  const first = calls.findIndex((c) => ["Read", "Edit", "Write", "MultiEdit"].includes(c.name)
    ? goldPaths.some((p) => norm(c.input?.file_path).endsWith(p))
    : c.name === "Bash" && /\b(?:cat|sed|head|tail|bat|nl)\b/.test(c.input?.command ?? "") && touches(c, goldPaths, []));
  return { discoveryCalls: searches.length, injections, injectionsUsed: injections.filter((e) => e.used).length,
    injectionsIgnored: injections.filter((e) => !e.used).length, redundantSearches: redundant.length, redundantSearchCallIndices: redundant,
    offGoldInjections: injections.filter((e) => e.offGold), turnsToGoldFile: first < 0 ? null : first + 1,
    wikiShowCalls: calls.filter((c) => c.name === "Bash" && /\bmex(?:\.cmd)?\s+wiki\s+show\b/.test(c.input?.command ?? "")).length,
    graphInjections: injections.filter((e) => e.kind === "graph").length, knowledgeInjections: injections.filter((e) => e.kind === "knowledge").length,
    alignment: aligned === injections.length ? "timestamp-or-explicit" : "partial" };
}
