import { spawnSync } from "node:child_process";
import { nativeBinary } from "../knowledge/check.js";
import { graphLocation } from "./storage.js";

export type GraphQuestion = "callers" | "callees" | "impact" | "tests";

interface GraphSymbol { id: string; name: string; path: string; start: number; end: number; kind: string; signature?: string }
interface GraphSite { path: string; line: number; in: GraphSymbol; owner?: GraphSymbol; kind: "call" | "value" }
interface GraphTest { test: GraphSymbol; line: number; reach: "direct" | "via-caller" }
interface GraphMatch extends GraphSymbol { query?: string }

/** The Go reader's answer (native/graph/answer.go). */
export interface GraphAnswer {
  ok: true;
  op: GraphQuestion;
  name: string;
  as_of: string;
  verdict: "found" | "none" | "unknown" | "ambiguous" | "missing";
  symbol?: GraphSymbol;
  matches?: GraphMatch[];
  sites?: GraphSite[];
  tests?: GraphTest[];
  dropped: number;
  unresolved: number;
  /** Files changed since the build that use the name; -1 when it couldn't be told. */
  changed: number;
  complete: boolean;
}

export class GraphReadError extends Error {
  constructor(message: string, readonly code: "unavailable" | "no-graph" | "failed") { super(message); }
}

const READ_TIMEOUT_MS = 30_000;
/** Lines of uses or tests printed before the rest is counted. */
const SHOWN = 25;

/** Ask the native graph reader one question about a name. Never builds or refreshes. */
export function askGraph(question: GraphQuestion, name: string, options: { root?: string; binary?: string | null; env?: NodeJS.ProcessEnv } = {}): GraphAnswer {
  const root = options.root ?? process.cwd();
  const binary = options.binary === undefined ? nativeBinary(options.env) : options.binary;
  if (!binary) throw new GraphReadError("Graph reads need MEX's native binary for this platform; reinstall MEX or set MEX_HOOK_BINARY.", "unavailable");
  const location = graphLocation(root);
  const result = spawnSync(binary, ["--graph-read"], {
    input: JSON.stringify({ op: question, name, checkout: location.root, project_id: location.projectId, record_directory: location.recordDirectory }),
    encoding: "utf8", timeout: READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  let reply: { ok?: boolean; error?: string } & Partial<GraphAnswer>;
  try { reply = JSON.parse(String(result.stdout ?? "").trim().split("\n").at(-1) ?? ""); }
  catch { throw new GraphReadError(`The graph reader gave no answer${result.error ? `: ${result.error.message}` : ""}.`, "failed"); }
  if (!reply.ok) {
    if (result.status === 3) throw new GraphReadError("No graph for this checkout yet. Run mex graph to build it.", "no-graph");
    throw new GraphReadError(`The graph reader failed: ${reply.error ?? "unknown error"}.`, "failed");
  }
  return reply as GraphAnswer;
}

function where(symbol: GraphSymbol): string {
  return `${symbol.path}:${symbol.start}${symbol.end > symbol.start ? `-${symbol.end}` : ""}`;
}

/** An anonymous callback ("<callback:it[1]>") reads as the call it's passed to. */
function named(symbol: GraphSymbol): string {
  const callback = /^<callback:([^[>]+)/u.exec(symbol.name);
  if (!callback) return symbol.name;
  return callback[1] === "ReturnStatement" || callback[1] === "BinaryExpression" ? "a callback" : `a ${callback[1]}() callback`;
}

function inWhat(site: GraphSite): string {
  if (site.owner) return site.owner.name;
  return named(site.in);
}

function plural(n: number, word: string): string { return `${n} ${word}${n === 1 ? "" : "s"}`; }

/** The answer as lines a person reads. */
export function renderGraphAnswer(answer: GraphAnswer): string[] {
  const lines: string[] = [];
  const asOf = `(graph as of ${answer.as_of})`;
  if (answer.verdict === "missing") return [`No definition named ${answer.name} in the graph ${asOf}.`];
  if (answer.verdict === "ambiguous") {
    lines.push(`${answer.name} names ${answer.matches?.length ?? 0} definitions ${asOf}. Ask about one of them:`);
    for (const match of answer.matches ?? []) {
      lines.push(`  ${match.query ? `mex graph ${answer.op} ${match.query}` : `${match.kind} ${match.name}`}  (${match.kind} at ${where(match)})`);
    }
    return lines;
  }
  const symbol = answer.symbol!;
  lines.push(`${symbol.kind} ${symbol.name}  ${where(symbol)}  ${asOf}`);
  if (symbol.signature) lines.push(`  ${symbol.signature}`);
  if (answer.op === "tests") {
    const tests = answer.tests ?? [];
    if (tests.length) {
      const direct = tests.filter((t) => t.reach === "direct");
      const via = tests.filter((t) => t.reach !== "direct");
      for (const [label, list] of [["Direct tests", direct], ["Tests that reach it through a caller", via]] as const) {
        if (!list.length) continue;
        lines.push(`${label} (${list.length}):`);
        for (const t of list.slice(0, SHOWN)) lines.push(`  ${t.test.path}:${t.line || t.test.start}  in ${named(t.test)}`);
        if (list.length > SHOWN) lines.push(`  +${list.length - SHOWN} more`);
      }
    }
  } else if (answer.sites?.length) {
    const sites = answer.sites;
    const label = answer.op === "callees" ? "Calls" : answer.op === "impact" ? "Impact (callers, two levels)" : "Callers";
    lines.push(`${label} (${sites.length}):`);
    for (const site of sites.slice(0, SHOWN)) {
      if (answer.op === "callees") lines.push(`  ${site.path}:${site.line}  ${site.kind === "value" ? "passes" : "calls"} ${site.in.name}  (${where(site.in)})`);
      else lines.push(`  ${site.path}:${site.line}  ${site.kind === "value" ? "passed as a value in" : "in"} ${inWhat(site)}`);
    }
    if (sites.length > SHOWN) lines.push(`  +${sites.length - SHOWN} more (--json lists every one)`);
  }
  const none = answer.op === "tests" ? "No tests" : answer.op === "callees" ? "No calls into other code" : "No callers";
  if (answer.verdict === "none") lines.push(`${none}: every file is indexed and none changed since the build uses it.`);
  if (answer.verdict === "unknown") {
    const why = [
      !answer.complete ? "some files are not indexed" : "",
      answer.dropped ? `${plural(answer.dropped, "result")} in changed files no longer hold` : "",
      answer.unresolved ? `${plural(answer.unresolved, answer.op === "callees" ? "call" : "dynamic use")} could not be resolved` : "",
      answer.changed > 0 ? `${plural(answer.changed, "file")} changed since the build use the name` : "",
      answer.changed < 0 && answer.complete && !answer.dropped && !answer.unresolved ? "files changed since the build could not be checked" : "",
    ].filter(Boolean).join("; ");
    lines.push(`${answer.op === "tests" ? "Tests" : answer.op === "callees" ? "Calls" : "Callers"} unknown${why ? `: ${why}` : ""}.`);
  } else if (answer.verdict === "found" && answer.dropped > 0) {
    lines.push(`${plural(answer.dropped, "result")} in files changed since the build no longer hold and are left out.`);
  }
  return lines;
}

export async function runGraphRead(question: GraphQuestion, name: string, options: { root?: string; json?: boolean } = {}): Promise<void> {
  const answer = askGraph(question, name, { root: options.root });
  if (options.json) console.log(JSON.stringify(answer, null, 2));
  else for (const line of renderGraphAnswer(answer)) console.log(line);
  if (answer.verdict === "missing" || answer.verdict === "ambiguous") process.exitCode = 2;
}
