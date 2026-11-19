import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { count, object, reportedTokens } from "../record/usage.js";
import type { CompactAgent } from "../compaction/settings.js";
import { codexRead } from "../filter/transcript.js";
import { absolutePath, realPath } from "../record/project.js";
import { INPUT_MILLITOKENS, inputTokens, ledgerRates, pricedInput, pricedUsage, type TokenClasses } from "./pricing.js";

export const toolLevers = ["outline", "shell-trim", "codex-wrapper"] as const;
export type ToolLever = typeof toolLevers[number];
export type Lever = ToolLever | "compaction";
export const observationData = z.object({
  lever: z.enum(toolLevers),
  kind: z.enum(["saving", "refetch", "denial"]),
  tokens_removed: z.number().int().min(0).max(8 << 20),
  tokens_added: z.number().int().min(0).max(8 << 20).default(0),
  hook_ms: z.number().int().min(0).max(60_000),
}).strict();
export type Observation = z.infer<typeof observationData> & { at: number };

interface Usage extends TokenClasses {
  hasCacheBreakdown: boolean;
}

interface Request {
  at: number;
  usage: Usage;
  rates: Readonly<TokenClasses>;
  model?: string;
}

export interface Boundary {
  at: number;
  compact?: { before?: number; after?: number; usage?: Usage; rates?: Readonly<TokenClasses> };
}

interface FileRead { at: number; started: number; path: string }
interface FileEdit { at: number; path: string }

export interface SessionTrace {
  agent: CompactAgent;
  requests: Request[];
  boundaries: Boundary[];
  reads: FileRead[];
  edits: FileEdit[];
  timings: { at: number; ms: number }[];
  incompleteUsage?: boolean;
  leftCheckout?: boolean;
}

export interface LedgerTerm {
  lever: string;
  tokens_removed: number;
  turns_carried: number;
  cost_tokens: number;
  refetches: number;
  saved_input_millitokens: number;
  cost_input_millitokens: number;
}

const MAX_REQUESTS = 32_000;
const MAX_FILE_EVENTS = 8192;
const MAX_BOUNDARIES = 256;
const MAX_USAGE = 2_000_000;
const MAX_PRICED_TOTAL = 2 ** 49;

function modelName(value: unknown): string | undefined {
  if (typeof value === "string" && /^[a-z0-9._-]{1,120}(?:\[1m\])?$/iu.test(value)) return value.toLowerCase();
  return undefined;
}

export interface SessionMetrics {
  model: string;
  requests: number;
  spend_input_millitokens: number;
  end_input_tokens: number;
  mex_context_tokens: number | null;
}

/** Observed requests, before any counterfactual ledger debits or credits. */
export function measureSessionUsage(trace: SessionTrace) {
  if (trace.incompleteUsage || !trace.requests.length) return undefined;
  let first = trace.requests[0]!, final = first, spend = 0;
  const models = new Set<string>();
  for (const request of trace.requests) {
    models.add(request.model ?? "unknown");
    if (request.at < first.at) first = request;
    if (request.at >= final.at) final = request;
    spend += pricedUsage(request.usage, request.rates);
  }
  const priced = Math.round(spend * INPUT_MILLITOKENS);
  if (!Number.isSafeInteger(priced) || priced > MAX_PRICED_TOTAL) return undefined;
  const metrics: SessionMetrics = {
    model: models.size === 1 ? models.values().next().value! : "mixed",
    requests: trace.requests.length,
    spend_input_millitokens: priced,
    end_input_tokens: inputTokens(final.usage),
    mex_context_tokens: null,
  };
  return { metrics, firstAt: first.at, finalAt: final.at };
}

function usage(raw: unknown, agent: CompactAgent): Usage | undefined {
  const value = object(raw);
  const tokens = reportedTokens(raw, agent === "codex" ? "codex" : "claude");
  if (!tokens || !value) return undefined;
  const creation = agent === "claude-code" ? object(value.cache_creation) : undefined;
  const short = count(creation?.ephemeral_5m_input_tokens);
  const long = count(creation?.ephemeral_1h_input_tokens);
  const aggregate = agent === "claude-code" ? count(value.cache_creation_input_tokens) : undefined;
  const split = (short ?? 0) + (long ?? 0);
  if (aggregate !== undefined && split > aggregate) return undefined;
  const observed: Usage = {
    input: tokens.input, read: tokens.cache_read, output: tokens.output,
    write1h: long ?? 0, write5m: (aggregate ?? split) - (long ?? 0),
    hasCacheBreakdown: count(value.cached_input_tokens) !== undefined || count(value.cache_read_input_tokens) !== undefined ||
      aggregate !== undefined || short !== undefined || long !== undefined,
  };
  return inputTokens(observed) <= MAX_USAGE && observed.output <= MAX_USAGE ? observed : undefined;
}

// For a new tool result the cached prefix precedes the result. Estimate the
// marginal rate from the observed writes, or from fresh input when uncached.
function firstCarryRate(request: Request, agent: CompactAgent): number {
  const { usage: tokens, rates } = request;
  const writes = tokens.write5m + tokens.write1h;
  if (writes) return (tokens.write5m * rates.write5m + tokens.write1h * rates.write1h) / writes;
  if (agent === "codex" || (tokens.hasCacheBreakdown && tokens.input > 0)) return rates.input;
  return rates.write5m;
}

function recurringCarryRate(tokens: Usage, rates: Readonly<TokenClasses>): number {
  const input = inputTokens(tokens);
  return tokens.hasCacheBreakdown && input ? pricedInput(tokens, rates) / input : rates.read;
}

function checkoutFile(checkout: string, cwd: string, file: unknown): string | undefined {
  if (typeof file !== "string" || !file || file.length > 4096 || file.includes("\0") ||
    cwd.length > 4096 || cwd.includes("\0") || !isAbsolute(cwd)) return undefined;
  const path = absolutePath(resolve(cwd, file)), within = relative(checkout, path);
  if (within && within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within)) return path;
  return undefined;
}

/** No file contents are read. An unverifiable or changed path has no charge. */
function lastFileChange(path: string): bigint | undefined {
  try {
    if (realPath(path) !== path) return undefined;
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) return undefined;
    const changed = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
    if (changed > 0n) return changed;
  } catch { /* The file may have been removed or moved. */ }
  return undefined;
}

/** Read complete host records without retaining any message or command text. */
export function readLedgerTrace(body: string, agent: CompactAgent, session: string, ended: number, checkout: string): SessionTrace | undefined {
  if (!body.endsWith("\n")) return undefined;
  const trace: SessionTrace = { agent, requests: [], boundaries: [], reads: [], edits: [], timings: [] };
  const claudeRequests = new Map<string, Request>();
  const pendingFiles = new Map<string, { path: string; started: number; edit: boolean }>();
  let cumulative: { input: number; output: number } | undefined;
  let codexCwd = checkout;
  let codexModel: string | undefined;
  let lastCwd: string | undefined;

  function seeCheckout(cwd: unknown) {
    if (trace.leftCheckout || cwd === lastCwd || typeof cwd !== "string" || cwd.length > 4096 || cwd.includes("\0") || !isAbsolute(cwd)) return;
    lastCwd = cwd;
    const path = relative(checkout, realPath(cwd));
    if (path === ".." || path.startsWith(".." + sep) || isAbsolute(path)) trace.leftCheckout = true;
  }

  function stageFile(id: unknown, file: unknown, cwd: string, started: number, edit = false) {
    const path = checkoutFile(checkout, cwd, file);
    if (typeof id === "string" && id.length <= 256 && path && !pendingFiles.has(id)) pendingFiles.set(id, { path, started, edit });
  }
  function finishFile(id: unknown, at: number, ok: boolean) {
    if (typeof id !== "string") return;
    const pending = pendingFiles.get(id);
    pendingFiles.delete(id);
    if (!ok || !pending || at < pending.started) return;
    if (pending.edit) trace.edits.push({ path: pending.path, at });
    else trace.reads.push({ path: pending.path, started: pending.started, at });
  }
  function tooManyFiles() {
    return pendingFiles.size + trace.reads.length + trace.edits.length > MAX_FILE_EVENTS;
  }

  for (let offset = 0; offset < body.length;) {
    const end = body.indexOf("\n", offset);
    const line = body.slice(offset, end);
    offset = end + 1;
    if (!line) continue;
    let row: Record<string, unknown> | undefined;
    try { row = object(JSON.parse(line)); } catch { return undefined; }
    if (!row || row.isSidechain === true || row.isSynthetic === true || row.isApiErrorMessage === true) continue;
    if (typeof row.sessionId === "string" && row.sessionId !== session) continue;
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(at) || at > ended) continue;
    const payload = object(row.payload);
    if (agent === "claude-code") {
      seeCheckout(row.cwd);
      if (typeof row.entrypoint === "string" && row.entrypoint.startsWith("sdk")) return undefined;
      if (row.type === "system" && row.subtype === "compact_boundary") {
        if (trace.boundaries.length >= MAX_BOUNDARIES) return undefined;
        const meta = object(row.compactMetadata);
        trace.boundaries.push({ at, compact: { before: count(meta?.preTokens), after: count(meta?.postTokens),
          usage: usage(meta?.usage, agent), rates: typeof meta?.model === "string" ? ledgerRates(meta.model) : undefined } });
        continue;
      }
      if (row.type === "system" && row.subtype === "turn_duration") {
        addTiming(trace, at, row.durationMs);
        continue;
      }
      const message = object(row.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      if (row.type === "user") {
        for (const item of content) {
          const result = object(item);
          if (result?.type === "tool_result") finishFile(result.tool_use_id, at, result.is_error !== true);
        }
        continue;
      }
      if (row.type !== "assistant" || row.isCompactSummary === true || message?.model === "<synthetic>" || message?.usage === undefined) continue;
      const tokens = usage(message.usage, agent), request = row.requestId ?? row.request_id ?? message.request_id;
      if (!tokens || typeof message.id !== "string" || typeof request !== "string") return undefined;
      if (!inputTokens(tokens)) continue;
      const key = JSON.stringify([message.id, request]);
      const existing = claudeRequests.get(key);
      if (existing) {
        const output = Math.max(existing.usage.output, tokens.output);
        if (inputTokens(tokens) > inputTokens(existing.usage) ||
          (inputTokens(tokens) === inputTokens(existing.usage) && tokens.hasCacheBreakdown)) existing.usage = tokens;
        existing.usage.output = output;
      } else {
        const next = { at, usage: tokens, rates: ledgerRates(message.model), model: modelName(message.model) };
        claudeRequests.set(key, next);
        trace.requests.push(next);
      }
      for (const item of content) {
        const tool = object(item);
        if (tool?.type !== "tool_use") continue;
        const input = object(tool.input), cwd = typeof row.cwd === "string" ? row.cwd : checkout;
        if (tool.name === "Read") stageFile(tool.id, input?.file_path, cwd, at);
        if (["Edit", "MultiEdit", "Write", "NotebookEdit"].some(name => name === tool.name)) {
          stageFile(tool.id, input?.file_path ?? input?.notebook_path, cwd, at, true);
        }
        if (tooManyFiles()) return undefined;
      }
    } else {
      if (row.type === "session_meta" && (payload?.source === "exec" || object(payload?.source)?.subagent !== undefined ||
        (typeof payload?.id === "string" && payload.id !== session))) return undefined;
      if (row.type === "session_meta" || row.type === "turn_context") {
        if (typeof payload?.cwd === "string") {
          codexCwd = payload.cwd;
          seeCheckout(codexCwd);
        }
        if (payload?.model !== undefined) codexModel = modelName(payload.model);
      }
      if (row.type === "compacted") {
        if (trace.boundaries.length >= MAX_BOUNDARIES) return undefined;
        const latest = object(payload?.latest_token_usage_record);
        const reported = typeof payload?.compaction_response_id === "string" &&
          payload.compaction_response_id === latest?.response_id ? usage(latest.usage, agent) : undefined;
        trace.boundaries.push({ at, compact: { usage: reported, rates: ledgerRates() } });
        continue;
      }
      if (row.type === "event_msg" && payload?.type === "task_complete") {
        addTiming(trace, at, payload.duration_ms);
        continue;
      }
      if (row.type === "event_msg" && payload?.type === "patch_apply_end" && payload.success === true) {
        const changes = object(payload.changes);
        for (const name in changes) {
          const change = object(changes[name]);
          for (const file of [name, change?.move_path]) {
            const path = checkoutFile(checkout, codexCwd, file);
            if (path) trace.edits.push({ path, at });
            if (tooManyFiles()) return undefined;
          }
        }
      }
      if (row.type === "response_item" && payload?.type === "function_call") {
        const target = codexRead(payload);
        if (target) stageFile(payload.call_id, target.path, target.cwd || codexCwd, at);
        if (tooManyFiles()) return undefined;
      }
      if (row.type === "response_item" && payload?.type === "function_call_output") {
        const output = payload.output;
        finishFile(payload.call_id, at, object(output)?.exit_code === 0 || (typeof output === "string" &&
          /(?:^|\n)(?:Process exited with code|Exit code:)\s*0(?:\s|$)/iu.test(output.slice(0, 1024))));
      }
      if (row.type !== "event_msg" || payload?.type !== "token_count") continue;
      const info = object(payload.info);
      if (!info) continue;
      const tokens = usage(info.last_token_usage, agent), total = object(info.total_token_usage);
      if (!tokens || count(total?.input_tokens) === undefined || count(total?.output_tokens) === undefined) return undefined;
      const input = Number(total!.input_tokens), output = Number(total!.output_tokens);
      // Resets and duplicate snapshots do not represent another request.
      if (!inputTokens(tokens) || (cumulative && input === cumulative.input && output === cumulative.output)) continue;
      if (cumulative && (input < cumulative.input || output < cumulative.output)) return undefined;
      if (input - (cumulative?.input ?? 0) !== inputTokens(tokens) || output - (cumulative?.output ?? 0) !== tokens.output) {
        trace.incompleteUsage = true;
      }
      cumulative = { input, output };
      trace.requests.push({ at, usage: tokens, rates: ledgerRates(), model: codexModel });
    }
    if (trace.requests.length > MAX_REQUESTS || trace.boundaries.length > MAX_BOUNDARIES) return undefined;
  }
  return trace.requests.length ? trace : undefined;
}

function addTiming(trace: SessionTrace, at: number, reported: unknown) {
  const ms = count(reported);
  if (ms && ms <= 86_400_000 && trace.timings.length < MAX_REQUESTS) trace.timings.push({ at, ms });
}

function firstAfter(requests: Request[], at: number): number {
  let left = 0, right = requests.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (requests[middle]!.at <= at) left = middle + 1;
    else right = middle;
  }
  return left;
}

// Use the observed session throughput in timed turns. With no timed turn,
// Price hook delay at measured output throughput. The fallback is 50 output
// tokens/s at the first request's rate.
function hookRate(requests: Request[], timings: SessionTrace["timings"]): { raw: number; priced: number } {
  let through = 0, time = 0, output = 0, priced = 0;
  for (const { at, ms } of [...timings].sort((a, b) => a.at - b.at)) {
    const start = Math.max(through, at - ms), end = firstAfter(requests, at);
    for (let i = firstAfter(requests, start); i < end; i++) {
      const request = requests[i]!;
      output += request.usage.output;
      priced += request.usage.output * request.rates.output;
    }
    time += Math.max(0, at - start);
    through = Math.max(through, at);
  }
  if (output && time) return { raw: output / time, priced: priced / time };
  return { raw: 0.05, priced: 0.05 * (requests[0]?.rates ?? ledgerRates()).output };
}

interface Tally {
  savings: Map<number, { removed: number; priced: number }>;
  costs: number;
  pricedCosts: number;
  refetches: number;
  hookMS: number;
  charged: Set<number>;
}

/** Carry only to the next context boundary. One billed request is charged
 * once to a lever when it consumes several refetches or denials together. */
export function settleSessionLedger(trace: SessionTrace, observations: Observation[]): LedgerTerm[] | undefined {
  const requests = [...trace.requests].sort((a, b) => a.at - b.at);
  // Prefix sums let even a long context price every carry without revisiting
  // each subsequent request for every hook observation.
  const recurring = [0];
  for (const request of requests) recurring.push(recurring.at(-1)! + recurringCarryRate(request.usage, request.rates));
  function carryPrice(start: number, end: number, previous?: Usage): number {
    if (start >= end) return 0;
    const first = requests[start]!;
    const firstRate = previous?.hasCacheBreakdown ? recurringCarryRate(previous, first.rates) : firstCarryRate(first, trace.agent);
    return firstRate + (recurring[end]! - recurring[start + 1]!);
  }
  const actions = [...observations].sort((a, b) => a.at - b.at);
  const reads = [...trace.reads].sort((a, b) => a.at - b.at);
  const edits = [...trace.edits].sort((a, b) => a.at - b.at);
  const boundaries = [...new Map(trace.boundaries.map(b => [b.at, b])).values()].sort((a, b) => a.at - b.at);
  const totals = new Map<Lever, Tally>();
  function forLever(lever: Lever): Tally {
    let total = totals.get(lever);
    if (!total) {
      total = { savings: new Map(), costs: 0, pricedCosts: 0, refetches: 0, hookMS: 0, charged: new Set() };
      totals.set(lever, total);
    }
    return total;
  }
  function save(total: Tally, removed: number, turns: number, price: number) {
    const group = total.savings.get(turns) ?? { removed: 0, priced: 0 };
    group.removed += removed;
    group.priced += removed * price;
    total.savings.set(turns, group);
  }
  function charge(total: Tally, request: number, end: number) {
    if (request >= end || total.charged.has(request)) return;
    total.charged.add(request);
    const { usage: tokens, rates } = requests[request]!;
    total.costs += inputTokens(tokens) + tokens.output;
    total.pricedCosts += pricedUsage(tokens, rates);
  }

  let action = 0, read = 0, edit = 0, previousReads = new Map<string, FileRead>(), unknownCompaction = false;
  const lastEdit = new Map<string, number>();
  const fileChanges = new Map<string, bigint | undefined>();
  for (let i = 0; i <= boundaries.length; i++) {
    const boundary = boundaries[i - 1], through = boundaries[i]?.at ?? Infinity;
    const start = firstAfter(requests, boundary?.at ?? -Infinity);
    const end = firstAfter(requests, through - 1);
    const compact = boundary?.compact, paths = new Map<string, FileRead>();

    if (compact) {
      const prior = start > firstAfter(requests, boundaries[i - 2]?.at ?? -Infinity) ? requests[start - 1] : undefined;
      const before = compact.before ?? (prior ? inputTokens(prior.usage) + prior.usage.output : undefined);
      const after = start < end ? inputTokens(requests[start]!.usage) : compact.after;
      const summary = compact.usage;
      const cost = summary ? inputTokens(summary) + summary.output : (before ?? 0) + (after ?? 0);
      if (before === undefined || before > MAX_USAGE || cost > 2 * MAX_USAGE) unknownCompaction = true;
      else {
        const total = forLever("compaction");
        const rates = compact.rates ?? prior?.rates ?? requests[start]?.rates ?? ledgerRates();
        save(total, Math.max(0, before - (after ?? before)), end - start, carryPrice(start, end, prior?.usage));
        total.costs += cost;
        total.pricedCosts += summary ? pricedUsage(summary, rates) : before * rates.input + (after ?? 0) * rates.output;
      }
    }

    while (read < reads.length && reads[read]!.at < through) {
      const current = reads[read++]!, { at, path } = current;
      while (edit < edits.length && edits[edit]!.at <= at) {
        const latest = edits[edit++]!;
        lastEdit.set(latest.path, latest.at);
      }
      const first = !paths.has(path), prior = previousReads.get(path);
      paths.set(path, current);
      if (!compact || !first || !prior || current.started <= boundary.at || (lastEdit.get(path) ?? -Infinity) >= prior.started) continue;
      const request = firstAfter(requests, at);
      if (request >= end) continue;
      if (!fileChanges.has(path)) fileChanges.set(path, lastFileChange(path));
      const changed = fileChanges.get(path);
      if (changed === undefined || changed >= BigInt(prior.started) * 1_000_000n) continue;
      const total = forLever("compaction");
      total.refetches++;
      charge(total, request, end);
    }
    previousReads = paths;

    while (action < actions.length && actions[action]!.at < through) {
      const signal = actions[action++]!;
      const total = forLever(signal.lever);
      total.hookMS += signal.hook_ms;
      const next = firstAfter(requests, signal.at);
      if (signal.kind === "saving") {
        const price = carryPrice(next, end);
        save(total, signal.tokens_removed, end - next, price);
        total.costs += signal.tokens_added * (end - next);
        total.pricedCosts += signal.tokens_added * price;
      } else {
        if (signal.kind === "refetch") total.refetches++;
        charge(total, next, end);
      }
    }
  }

  if (unknownCompaction) totals.delete("compaction");
  const rate = hookRate(requests, trace.timings);
  const terms: LedgerTerm[] = [];
  for (const [lever, total] of totals) {
    const grouped = [...total.savings].sort(([a], [b]) => a - b);
    if (grouped.length === 0) grouped.push([0, { removed: 0, priced: 0 }]);
    const pricedCost = Math.round((total.pricedCosts + total.hookMS * rate.priced) * INPUT_MILLITOKENS);
    let totalPriced = pricedCost;
    for (const [i, [turns, { removed, priced }]] of grouped.entries()) {
      const pricedSaving = Math.round(priced * INPUT_MILLITOKENS);
      totalPriced += pricedSaving;
      terms.push({ lever: i === 0 ? lever : lever + "#" + turns, tokens_removed: removed, turns_carried: turns,
        cost_tokens: i === 0 ? total.costs + Math.ceil(total.hookMS * rate.raw) : 0, refetches: i === 0 ? total.refetches : 0,
        saved_input_millitokens: pricedSaving, cost_input_millitokens: i === 0 ? pricedCost : 0 });
    }
    if (!Number.isSafeInteger(totalPriced) || totalPriced > MAX_PRICED_TOTAL) return undefined;
  }
  return terms;
}
