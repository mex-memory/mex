import type { DatabaseSync } from "node:sqlite";
import { openRecord, type RecordReader, type RecordWriter } from "./index.js";
import type { LocationOptions } from "./location.js";

export interface Tokens { input: number; cache_write: number; cache_read: number; output: number; }
export const ZERO: Tokens = { input: 0, cache_write: 0, cache_read: 0, output: 0 };
export const TOKEN_CLASSES = ["input", "cache_write", "cache_read", "output"] as const;
export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** Codex's cached input is included in input; reasoning is already included in output. */
export function reportedTokens(value: unknown, agent: string): Tokens | undefined {
  const u = object(value);
  if (!u || count(u.input_tokens) === undefined || count(u.output_tokens) === undefined) return;
  const cached = count(u.cached_input_tokens) ?? count(u.cache_read_input_tokens) ?? 0;
  if (agent === "codex" && cached > Number(u.input_tokens)) return;
  return {
    input: Number(u.input_tokens) - (agent === "codex" ? cached : 0),
    cache_read: cached, cache_write: agent === "codex" ? 0 : count(u.cache_creation_input_tokens) ?? 0,
    output: Number(u.output_tokens),
  };
}
export function utcDay(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid usage timestamp");
  return date.toISOString().slice(0, 10);
}
export interface ModelCall extends Tokens {
  purpose: string; agent: string; model: string; estimated: boolean;
  projectId?: string; projectPath?: string; timestamp?: string;
  /** The agent's own session id for a headless run, when its output reports one. */
  sessionId?: string;
}
/**
 * An interactive session MEX opens is driven and watched by the person. Its real tokens land in the
 * agent's own logs, which the own-usage reader counts, so the row records the launch with no numbers.
 */
export interface InteractiveLaunch { purpose: string; agent: string; projectPath?: string; timestamp?: string; }
export interface ModelCallOptions extends LocationOptions {
  warn?: (message: string) => void;
  /** Test seam; not exposed through any command or request. */
  open?: typeof openRecord;
}
export const USAGE_WARNING = "MEX could not record model usage; the command continues.";
let warningPending = false;
/**
 * A failed write must not print into a full-screen view (setup draws one), so the default warning
 * is printed once per process, on exit, after any screen is gone.
 */
function warnOnExit(): void {
  if (warningPending) return;
  warningPending = true;
  process.once("exit", () => { try { process.stderr.write(`${USAGE_WARNING}
`); } catch { /* observation only */ } });
}
/** Test seam: whether a deferred warning is waiting for process exit. */
export function usageWarningPending(): boolean { return warningPending; }

function insertCall(call: ModelCall & { kind: "headless" | "interactive" }, options: ModelCallOptions): boolean {
  let writer: RecordWriter | undefined;
  try {
    for (const key of TOKEN_CLASSES) if (count(call[key]) === undefined) throw new Error("Invalid tokens");
    const ts = new Date(call.timestamp ?? Date.now()).toISOString();
    writer = (options.open ?? openRecord)({ ...options, projectPath: call.projectPath });
    const project = call.projectId ?? (call.projectPath ? writer.checkout(call.projectPath)?.project_id : undefined);
    const session = typeof call.sessionId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(call.sessionId) ? call.sessionId : null;
    writer.db.prepare(`INSERT INTO model_calls(ts,project_id,purpose,agent,model,input,cache_write,cache_read,output,estimated,kind,session_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(ts, project ?? null, call.purpose, call.agent, call.model,
        call.input, call.cache_write, call.cache_read, call.output, Number(call.estimated), call.kind, session);
    return true;
  } catch {
    try { if (options.warn) options.warn(USAGE_WARNING); else warnOnExit(); } catch { /* observation only */ }
    return false;
  } finally { try { writer?.close(); } catch { /* observation only */ } }
}
/** Accounting is observation only. Never leak an exception or private DB diagnostics to a command. */
export function recordModelCall(call: ModelCall, options: ModelCallOptions = {}): boolean {
  return insertCall({ ...call, kind: "headless" }, options);
}
export function recordInteractiveLaunch(launch: InteractiveLaunch, options: ModelCallOptions = {}): boolean {
  return insertCall({ ...launch, ...ZERO, model: "unknown", estimated: false, kind: "interactive" }, options);
}

export interface UsageTotal extends Tokens { day: string; agent: string; purpose: string; kind: "headless" | "interactive"; estimated: number; calls: number; }
/** Inclusive UTC day range. Read-only projection; callers decide when to open a record. */
export function modelCallTotals(reader: Pick<RecordReader, "all">, from: string, through: string): UsageTotal[] {
  const start = utcDay(from), end = utcDay(through);
  if (start > end) throw new Error("Usage range starts after it ends");
  const before = new Date(new Date(`${end}T00:00:00.000Z`).getTime() + 86_400_000).toISOString();
  return reader.all<UsageTotal>(`SELECT substr(ts,1,10) day,agent,purpose,kind,
    sum(input) input,sum(cache_write) cache_write,sum(cache_read) cache_read,sum(output) output,
    max(estimated) estimated,count(*) calls FROM model_calls WHERE ts>=? AND ts<?
    GROUP BY day,agent,purpose,kind ORDER BY day,agent,purpose,kind`, `${start}T00:00:00.000Z`, before);
}
/**
 * What MEX itself spent: headless runs only. Interactive launches are counted separately, because the
 * person's own usage already includes their tokens.
 */
export function mexSpendTotals(reader: Pick<RecordReader, "all">, from: string, through: string): { spend: UsageTotal[]; interactiveLaunches: number } {
  const rows = modelCallTotals(reader, from, through);
  return { spend: rows.filter((row) => row.kind === "headless"), interactiveLaunches: rows.filter((row) => row.kind === "interactive").reduce((sum, row) => sum + row.calls, 0) };
}

/** Bounded JSONL decoder. No provider text is retained past the current record. */
export function jsonLines(consume: (event: Record<string, unknown>) => void, invalid: () => void = () => {}, max = 1024 * 1024) {
  let pending = Buffer.alloc(0), dropping = false;
  function line(bytes: Buffer) {
    if (bytes.length === 0) return;
    try { const event = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); if (event) consume(event); else invalid(); }
    catch { invalid(); }
  }
  return {
    write(chunk: Buffer) {
      let start = 0;
      while (start < chunk.length) {
        const nl = chunk.indexOf(10, start), end = nl < 0 ? chunk.length : nl;
        if (!dropping) {
          if (pending.length + end - start > max) { pending = Buffer.alloc(0); dropping = true; invalid(); }
          else pending = Buffer.concat([pending, chunk.subarray(start, end)]);
        }
        if (nl >= 0) { if (!dropping) line(pending); pending = Buffer.alloc(0); dropping = false; }
        start = nl < 0 ? chunk.length : nl + 1;
      }
    },
    end() { if (!dropping) line(pending); pending = Buffer.alloc(0); },
  };
}

/** One headless invocation, including every reported turn; Claude's terminal total wins. */
export function createCallUsage(agent: string, sent: string) {
  let outputBytes = 0, model = "unknown", terminal: Tokens | undefined, sessionId: string | undefined;
  let byModel: Array<Tokens & { model: string; estimated: boolean }> | undefined;
  let incomplete = false;
  const models = new Set<string>();
  let summed: Tokens | undefined, turn = 0;
  const seen = new Map<string, Tokens>();
  const add = (key: string, tokens: Tokens) => {
    const previous = seen.get(key) ?? ZERO;
    const next = { ...tokens };
    summed ??= { ...ZERO };
    for (const field of TOKEN_CLASSES) {
      next[field] = Math.max(previous[field], tokens[field]);
      summed[field] += next[field] - previous[field];
    }
    seen.set(key, next);
  };
  const decoder = jsonLines((e) => {
    const message = object(e.message);
    const label = message?.model ?? e.model;
    if (typeof label === "string" && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(label)) { model = label; models.add(label); }
    // Claude Code stream events carry session_id; Codex reports thread.started with thread_id.
    const session = agent === "codex" && e.type === "thread.started" ? e.thread_id : e.session_id;
    if (typeof session === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(session)) sessionId ??= session;
    if (agent === "claude") {
      if (e.type === "result") {
        terminal = reportedTokens(e.usage, agent) ?? terminal;
        const reported = object(e.modelUsage);
        if (reported) {
          const entries = Object.entries(reported).map(([name, value]) => {
            const u = object(value);
            const tokens = reportedTokens({ input_tokens: u?.inputTokens, output_tokens: u?.outputTokens,
              cache_read_input_tokens: u?.cacheReadInputTokens, cache_creation_input_tokens: u?.cacheCreationInputTokens }, agent);
            return tokens && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(name) ? { ...tokens, model: name, estimated: false } : undefined;
          });
          if (entries.length && entries.every((entry) => entry !== undefined)) {
            const totals = { ...ZERO };
            for (const entry of entries) for (const k of TOKEN_CLASSES) totals[k] += entry![k];
            if (!terminal || TOKEN_CLASSES.every((k) => totals[k] === terminal![k])) byModel = entries as NonNullable<typeof byModel>;
          }
        }
      }
      else if (e.type === "assistant" && typeof message?.id === "string") {
        const tokens = reportedTokens(message.usage, agent);
        if (tokens) add(JSON.stringify([message.id, e.requestId ?? e.request_id ?? ""]), tokens);
        else incomplete = true;
      }
    } else if (agent === "codex") {
      if (e.type === "turn.started") turn++;
      if (e.type === "turn.completed") {
        const tokens = reportedTokens(e.usage, agent);
        if (tokens) add(String(e.turn_id ?? turn), tokens);
        else incomplete = true;
      }
    } else {
      // Documented generic terminal usage, when present; otherwise estimate honestly.
      if (e.type === "result") terminal = reportedTokens(e.usage, agent) ?? terminal;
      if (agent === "opencode" && e.type === "step_finish") {
        const part = object(e.part), u = object(part?.tokens), cache = object(u?.cache);
        if (u && count(u.input) !== undefined && count(u.output) !== undefined && typeof part?.id === "string") {
          add(part.id, { input: Number(u.input), output: Number(u.output) + (count(u.reasoning) ?? 0),
            cache_read: count(cache?.read) ?? 0, cache_write: count(cache?.write) ?? 0 });
        }
      }
    }
  }, () => { incomplete = true; });
  return {
    write(chunk: Buffer) { outputBytes += chunk.length; decoder.write(chunk); },
    finish() {
      decoder.end();
      const tokens = terminal ?? summed;
      return { ...(tokens ?? { ...ZERO, input: Math.ceil(Buffer.byteLength(sent) / 4), output: Math.ceil(outputBytes / 4) }),
        model: models.size > 1 ? "mixed" : model, estimated: tokens === undefined || (!terminal && incomplete),
        ...(sessionId ? { sessionId } : {}), ...(byModel ? { byModel } : {}) };
    },
  };
}

export function addOwnUsage(db: DatabaseSync, day: string, agent: string, tokens: Tokens): void {
  db.prepare("INSERT OR IGNORE INTO own_usage VALUES(?,?,0,0,0,0,0)").run(day, agent);
  db.prepare(`UPDATE own_usage SET input=input+?,cache_write=cache_write+?,cache_read=cache_read+?,output=output+? WHERE day=? AND agent=?`)
    .run(tokens.input, tokens.cache_write, tokens.cache_read, tokens.output, day, agent);
}
