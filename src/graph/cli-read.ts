import { spawnSync } from "node:child_process";
import { nativeBinary } from "../knowledge/check.js";
import { graphLocation } from "./storage.js";

export type GraphQuestion = "callers" | "callees" | "impact" | "tests";

interface GraphSymbol { id: string; name: string; path: string; start: number; end: number; kind: string; signature?: string }
interface GraphSite { path: string; line: number; in: GraphSymbol; kind: "call" | "value" }
interface GraphTest { test: GraphSymbol; reach: "direct" | "via-caller" }

/** The Go reader's answer (native/graph/answer.go). */
export interface GraphAnswer {
  ok: true;
  op: GraphQuestion;
  name: string;
  as_of: string;
  verdict: "found" | "none" | "unknown" | "ambiguous" | "missing";
  symbol?: GraphSymbol;
  matches?: GraphSymbol[];
  sites?: GraphSite[];
  tests?: GraphTest[];
  dropped: number;
  unresolved: number;
  complete: boolean;
}

export class GraphReadError extends Error {
  constructor(message: string, readonly code: "unavailable" | "no-graph" | "failed") { super(message); }
}

const READ_TIMEOUT_MS = 30_000;

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

/** The answer as lines a person reads. */
export function renderGraphAnswer(answer: GraphAnswer): string[] {
  const lines: string[] = [];
  const asOf = `(graph as of ${answer.as_of})`;
  if (answer.verdict === "missing") return [`No definition named ${answer.name} in the graph ${asOf}.`];
  if (answer.verdict === "ambiguous") {
    lines.push(`${answer.name} names ${answer.matches?.length ?? 0} definitions ${asOf}; name one by its file:`);
    for (const match of answer.matches ?? []) lines.push(`  ${match.kind} ${match.name}  ${where(match)}`);
    return lines;
  }
  const symbol = answer.symbol!;
  lines.push(`${symbol.kind} ${symbol.name}  ${where(symbol)}  ${asOf}`);
  if (symbol.signature) lines.push(`  ${symbol.signature}`);
  const label = answer.op === "callees" ? "Calls" : answer.op === "impact" ? "Impact (callers, two levels)" : answer.op === "tests" ? "Tests" : "Callers";
  if (answer.op === "tests") {
    if (answer.tests?.length) {
      lines.push(`${label}:`);
      for (const test of answer.tests) lines.push(`  ${test.reach === "direct" ? "direct" : "through a tested caller"}  ${test.test.name}  ${where(test.test)}`);
    }
  } else if (answer.sites?.length) {
    lines.push(`${label}:`);
    for (const site of answer.sites) {
      const target = answer.op === "callees" ? site.in.name : site.in.name;
      lines.push(`  ${site.path}:${site.line}  ${site.kind === "value" ? "passes" : answer.op === "callees" ? "calls" : "in"} ${target}`);
    }
  }
  const none = answer.op === "tests" ? "No tests" : answer.op === "callees" ? "Calls nothing" : "No callers";
  if (answer.verdict === "none") lines.push(`${none}: every file is indexed.`);
  if (answer.verdict === "unknown") {
    const why = [
      !answer.complete ? "some files are not indexed" : "",
      answer.dropped ? `${answer.dropped} result${answer.dropped === 1 ? "" : "s"} in changed files no longer hold` : "",
      answer.unresolved ? `${answer.unresolved} dynamic use${answer.unresolved === 1 ? "" : "s"} could not be resolved` : "",
    ].filter(Boolean).join("; ");
    lines.push(`${answer.op === "tests" ? "Tests" : answer.op === "callees" ? "Calls" : "Callers"} unknown${why ? `: ${why}` : ""}.`);
  } else if (answer.verdict === "found" && answer.dropped > 0) {
    lines.push(`${answer.dropped} result${answer.dropped === 1 ? "" : "s"} in files changed since the build no longer hold and are left out.`);
  }
  return lines;
}

export async function runGraphRead(question: GraphQuestion, name: string, options: { root?: string; json?: boolean } = {}): Promise<void> {
  const answer = askGraph(question, name, { root: options.root });
  if (options.json) console.log(JSON.stringify(answer, null, 2));
  else for (const line of renderGraphAnswer(answer)) console.log(line);
  if (answer.verdict === "missing" || answer.verdict === "ambiguous") process.exitCode = 2;
}
