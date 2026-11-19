import { basename } from "node:path";
import { filterSession } from "../filter/input.js";
import { codexRead, transcriptTail } from "../filter/transcript.js";
import { openHooksReadOnly, type RecordReader, type RecordWriter } from "../record/index.js";
import type { RecordLocation } from "../record/location.js";
import { count, object, reportedTokens } from "../record/usage.js";
import { ledgerShouldTurnOff, sessionLeverNet, type LedgerNet } from "../ledger/view.js";
import { pauseReason, windowOffer, type CompactionEvidence, type KeptRateCheck, type PauseReason, type SessionEvidence } from "./policy.js";
import type { CompactAgent, CompactChoice, CompactScope } from "./settings.js";

interface SessionRow { session_id: string; project_id: string; checkout: string }
interface CheckoutEvidence extends SessionEvidence { checkout: string }
const MAX_SESSIONS = 32;
const TAIL_BYTES = 4 << 20;
const MAX_READS = 40;
const MIN_CONTEXT = 1_000_000;

// Codex emits the usable window, which can be 95% of a nominal 1M context.
export const minimumCapacity = (agent: CompactAgent) => agent === "codex" ? 950_000 : MIN_CONTEXT;
// Claude's modelSettings uses the canonical name for dated and [1m] IDs.
export const compactModel = (model: string, agent: CompactAgent) => agent === "claude-code"
  ? model.toLowerCase().replace(/\[1m\]$/u, "").replace(/-\d{8}$/u, "") : model.toLowerCase();

function claudeCapacity(model: string): number {
  // Extended-context families still have to pass the measured 300k gate.
  return /^claude-(?:opus-(?:4-[6-9]|[5-9](?:-\d+)?)(?:-\d+)?|sonnet-(?:4-6|[5-9](?:-\d+)?)(?:-\d+)?|haiku-5-5|fable-[1-9](?:-\d+)?)$/u.test(model)
    ? MIN_CONTEXT : 0;
}

/** Only sizes, model names and counts leave the transcript parser. */
export function measureSession(body: string, session: string, agent: CompactAgent): SessionEvidence[] {
  const models = new Map<string, SessionEvidence>();
  let model = "", window = 0, pending: CompactionEvidence | undefined;
  let previousReads: string[] = [], reads: string[] = [], readsSince = 0, priorRepeats = 0, repeats = 0;
  const seenCalls = new Set<string>();
  function setModel(next: string) {
    if (model === next) return;
    model = next;
    window = agent === "claude-code" ? claudeCapacity(model) : 0;
    reads = [];
    pending = undefined;
  }
  function read(id: unknown, path: unknown) {
    if (typeof id !== "string" || typeof path !== "string" || path.length > 4096 || seenCalls.has(id)) return;
    seenCalls.add(id);
    reads.push(path);
    if (reads.length > MAX_READS) reads.shift();
    if (!pending || ++readsSince > MAX_READS) return;
    if (previousReads.includes(path)) repeats++;
    if (previousReads.length >= 5 && readsSince >= 5) pending.rereads = { before: priorRepeats, after: repeats };
  }

  // A partial final JSONL record is not a context observation.
  for (const line of body.slice(0, body.lastIndexOf("\n") + 1).split("\n")) {
    if (!line) continue;
    let row: Record<string, unknown> | undefined;
    try { row = object(JSON.parse(line)); } catch { continue; }
    if (!row || row.isSidechain === true || row.isSynthetic === true || row.isApiErrorMessage === true) continue;
    if (typeof row.sessionId === "string" && row.sessionId !== session) continue;
    const payload = object(row.payload);
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    if (agent === "codex" && row.type === "turn_context" && typeof payload?.model === "string") {
      setModel(compactModel(payload.model, agent));
    }
    if ((agent === "codex" && row.type === "compacted") ||
      (agent === "claude-code" && row.type === "system" && row.subtype === "compact_boundary")) {
      const sample = models.get(model);
      if (sample) {
        pending = { at };
        sample.compactions.push(pending);
        if (sample.compactions.length > 16) sample.compactions.shift();
      } else pending = undefined;
      previousReads = reads;
      priorRepeats = previousReads.length - new Set(previousReads).size;
      reads = [];
      readsSince = 0;
      repeats = 0;
      continue;
    }

    let tokens;
    if (agent === "claude-code" && row.type === "assistant" && row.isCompactSummary !== true) {
      const message = object(row.message);
      if (!message || typeof message.model !== "string" || message.model === "<synthetic>") continue;
      setModel(compactModel(message.model, agent));
      tokens = reportedTokens(message.usage, "claude");
      for (const item of Array.isArray(message.content) ? message.content : []) {
        const call = object(item);
        if (call?.type === "tool_use" && call.name === "Read") read(call.id, object(call.input)?.file_path);
      }
    } else if (agent === "codex" && row.type === "event_msg" && payload?.type === "token_count") {
      const info = object(payload.info);
      if (!info) continue;
      window = count(info.model_context_window) ?? window;
      // total_token_usage is cumulative. The last request gives the context.
      tokens = reportedTokens(info.last_token_usage, "codex");
    } else if (agent === "codex" && row.type === "response_item" && payload?.type === "function_call" && model) {
      const target = codexRead(payload);
      if (target) read(payload.call_id, target.cwd === undefined ? target.path : JSON.stringify([target.cwd, target.path]));
    }
    if (!tokens || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(model)) continue;
    const context = tokens.input + tokens.cache_write + tokens.cache_read;
    if (!Number.isSafeInteger(context) || context <= 0 || context > 2_000_000) continue;
    const sample = models.get(model) ?? { session, model, capacity: window, peak: 0, compactions: [] };
    sample.capacity = Math.max(sample.capacity, window);
    sample.peak = Math.max(sample.peak, context);
    if (pending) pending.tokensAfter ??= context;
    models.set(model, sample);
  }
  return [...models.values()];
}

function measureCheckouts(hooks: RecordReader, location: RecordLocation, agent: CompactAgent, checkout?: string, since = 0): CheckoutEvidence[] {
  const from = new Date(Math.max(since, Date.now() - 35 * 86_400_000)).toISOString().slice(0, 19);
  const sessions = hooks.all<SessionRow>(
    "SELECT session_id,project_id,checkout FROM sessions WHERE agent=? AND (? IS NULL OR checkout=?) AND last_seen_at>=? " +
    "ORDER BY last_seen_at DESC,session_id LIMIT ?", agent, checkout ?? null, checkout ?? null, from, MAX_SESSIONS);
  return sessions.flatMap(s => {
    const meta = filterSession({ location }, s.project_id, s.checkout, s.session_id);
    if (!meta || meta.agent !== agent) return [];
    const name = basename(meta.transcript);
    if (!(agent === "claude-code" ? name === s.session_id + ".jsonl" : name.endsWith("-" + s.session_id + ".jsonl"))) return [];
    const body = transcriptTail(meta.transcript, agent === "claude-code" ? "claude" : "codex", TAIL_BYTES);
    return body ? measureSession(body, s.session_id, agent).map(sample => ({ ...sample, checkout: s.checkout })) : [];
  });
}

export function compactEvidence(location: RecordLocation, agent: CompactAgent, checkout?: string): CheckoutEvidence[] {
  const hooks = openHooksReadOnly({ home: location.home });
  try { return hooks && !hooks.diagnostic ? measureCheckouts(hooks, location, agent, checkout) : []; }
  finally { hooks?.close(); }
}

export function findWindowOffer(samples: SessionEvidence[], agent: CompactAgent, requestedModel?: string) {
  const models = requestedModel ? [compactModel(requestedModel, agent)] : [...new Set(samples.map(s => s.model))];
  for (const model of models) {
    const evidence = windowOffer(samples, model, minimumCapacity(agent));
    if (evidence) return { model, evidence };
  }
  return undefined;
}

interface CheckInput { checkout: string; agent: CompactAgent; model: string; scope: CompactScope; choice: CompactChoice; since: number }
export function healthPause(writer: Pick<RecordWriter, "location">, input: CheckInput): PauseReason | undefined {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic) return undefined;
    const samples = measureCheckouts(hooks, writer.location, input.agent, input.scope === "repo" ? input.checkout : undefined, input.since);
    const modelScoped = input.agent === "claude-code" && input.choice === "window";
    const relevant = samples.filter(s => !modelScoped || s.model === input.model);
    const checks: KeptRateCheck[] = [];
    const checked = new Set<string>();
    const ledger: LedgerNet[] = [];
    let rereads: CompactionEvidence["rereads"];
    const counted = new Set<string>();
    for (const sample of relevant) {
      const boundaries = sample.compactions.filter(c => c.at >= input.since);
      if (input.agent === "claude-code" && boundaries.length && !checked.has(sample.session)) {
        checked.add(sample.session);
        checks.push(...recentKeptChecks(hooks, samples.filter(other => other.session === sample.session), input.since,
          modelScoped ? input.model : undefined));
      }
      rereads ??= boundaries.find(c => pauseReason({ rereads: c.rereads }) === "rereads")?.rereads;
      // A per-session ledger row can't isolate models in a mixed Claude
      // session. Use it only when the whole row belongs to the setting.
      if (!counted.has(sample.session) && (!modelScoped || !samples.some(s => s.session === sample.session && s.model !== sample.model))) {
        counted.add(sample.session);
        const row = sessionLeverNet(hooks, sample.session, "compaction");
        if (row && Date.parse(row.started) >= input.since) ledger.push(row);
      }
    }
    const latest = ledger.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10).map(row => row.net_millitokens);
    const net = latest.reduce((sum, n) => sum + n, 0);
    return pauseReason({ checks, rereads, net }) ?? (ledgerShouldTurnOff(latest) ? "ledger" : undefined);
  } finally { hooks?.close(); }
}

function recentKeptChecks(hooks: RecordReader, samples: CheckoutEvidence[], since: number, model?: string): KeptRateCheck[] {
  const sample = samples[0]!;
  const boundaries = samples.flatMap(s => s.compactions.map(boundary => ({ boundary, model: s.model })));
  const rows = hooks.all<{ detail: string; ts: string }>(
    "SELECT detail,ts FROM deliveries WHERE session_id=? AND agent_id='' AND checkout=? " +
    "AND moment='compaction-check' AND action='control' ORDER BY epoch DESC LIMIT 16", sample.session, sample.checkout);
  const checks: KeptRateCheck[] = [];
  const used = new Set<CompactionEvidence>();
  for (const row of rows) {
    const at = Date.parse(row.ts);
    if (!Number.isFinite(at) || at < since || row.detail.length > 64) continue;
    // Attach a receipt to its nearest transcript boundary before selecting
    // the affected model. A single compaction contributes at most one check.
    const nearest = boundaries.map(c => ({ ...c, distance: Math.abs(at - c.boundary.at) }))
      .filter(c => c.distance <= 60_000).sort((a, b) => a.distance - b.distance);
    const match = nearest[0];
    if (!match || nearest[1]?.distance === match.distance || match.boundary.at < since ||
      (model && match.model !== model) || used.has(match.boundary)) continue;
    try {
      const data = object(JSON.parse(row.detail));
      const kept = count(data?.kept), checked = count(data?.checked);
      if (kept !== undefined && checked !== undefined && data?.estimated === true &&
        (data.partial === undefined || data.partial === false)) {
        used.add(match.boundary);
        checks.push({ at, kept, checked, estimated: true });
      }
    } catch { /* skip an unrecognized or incomplete observation */ }
  }
  return checks;
}
