import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import { absolutePath } from "../record/project.js";
import { hash } from "../judge/evidence.js";
import { checkMemorySource, discoverMemory, memoryRoots, type MemoryCandidate } from "../knowledge/host-memory.js";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import { filterSession, type Message, type SessionHost, type SessionInput } from "./input.js";
import type { StageTwoSource } from "./stage-two-input.js";
import { codexRolloutSession } from "./transcript.js";
import { captureProfiles, type CaptureAgent } from "./profiles.js";

const TAIL_MS = 15 * 60_000;
export const HOST_HINT_LIMIT = 16;
export interface HostMatch { id: string; ref: string; text: string; proof?: HostMemoryProof; }
interface HostSource { agent: CaptureAgent; message: Pick<Message, "id" | "session">; host?: SessionHost; }
export interface HostMemoryProof { id: string; memory: MemoryCandidate; source: HostSource; }
type Hooks = ReturnType<typeof openHooksReadOnly>;

function sessionWindow(hooks: NonNullable<ReturnType<typeof openHooksReadOnly>>, session: string) {
  const first = hooks.get<{ ts: string }>("SELECT ts FROM journal WHERE session_id=? AND kind='typed' ORDER BY id LIMIT 1", session);
  const last = hooks.get<{ ts: string }>("SELECT ts FROM journal WHERE session_id=? AND kind='typed' ORDER BY id DESC LIMIT 1", session);
  const start = Date.parse(first?.ts ?? ""), end = Date.parse(last?.ts ?? "");
  return start <= end ? { start, end: end + TAIL_MS } : undefined;
}

const memoryOptions = (writer: RecordWriter, checkout: string) => ({ projectPath: checkout, home: writer.location.home });
const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);

function codexMatch(memory: MemoryCandidate, session: string, rollout: string | undefined) {
  const reference = memory.sessionReference;
  if (reference?.id) return reference.id === session;
  return !!reference?.path && !!rollout && absolutePath(reference.path) === absolutePath(rollout) && codexRolloutSession(rollout) === session;
}

function hostBinding(writer: RecordWriter, project: string, checkout: string, source: HostSource, hooks: Hooks) {
  const id = source.host?.id ?? source.message.session;
  if (source.agent === "codex") {
    const meta = source.host ? undefined : filterSession(writer, project, checkout, id);
    const path = source.host?.path ?? (meta?.agent === "codex" ? meta.transcript : undefined);
    return (memory: MemoryCandidate) => memory.agent === source.agent && codexMatch(memory, id, path);
  }
  const window = source.host ? { start: Date.parse(source.host.first), end: Date.parse(source.host.last) + TAIL_MS }
    : hooks && !hooks.diagnostic ? sessionWindow(hooks, id) : undefined;
  return (memory: MemoryCandidate) => memory.agent === source.agent && !!window && memory.modifiedAt >= window.start && memory.modifiedAt <= window.end;
}

function memoryCandidates(writer: RecordWriter, checkout: string, now: number) {
  return discoverMemory(memoryOptions(writer, checkout), new Date(now)).candidates.flatMap(memory => {
    const text = stripHidden(memory.text);
    if (!text || (memory.agent === "claude-code" && memory.modifiedAt > now) || hasSecret(text) || /<\s*\/?\s*private\b/iu.test(text)) return [];
    return [{ memory, text }];
  });
}

function hintProof(source: HostSource, memory: MemoryCandidate): HostMemoryProof {
  return { id: `hint:${hash(JSON.stringify([source.message.id, memory.observation])).slice(7, 31)}`, memory, source };
}

/** Mechanical corroboration is deliberately limited to a complete typed claim repeated in host memory. */
export function exactHostMatches(writer: RecordWriter, project: string, checkout: string, input: SessionInput, now: number) {
  const { agent, host } = input;
  if (!agent || !captureProfiles[agent].memory) return [];
  const eligible = input.input.messages.filter(message => !message.marks
    && /^\s*(?:always|never|from now on|going forward|in this (?:repo|project|codebase))\b[\s,:-]+\S/iu.test(message.text)
    && !hasSecret(message.text) && stripHidden(message.text) === message.text && !/<\s*\/?\s*private\b/iu.test(message.text));
  if (!eligible.length) return [];
  let hooks: Hooks;
  try {
    if (!host) hooks = openHooksReadOnly({ home: writer.location.home });
    const source: HostSource = { agent, host, message: eligible[0]! };
    const bound = hostBinding(writer, project, checkout, source, hooks);
    const lines = new Map<string, MemoryCandidate>();
    for (const { memory, text } of memoryCandidates(writer, checkout, now)) if (bound(memory)) {
      for (const line of text.split("\n")) lines.set(line.replace(/^\s*[-*]\s+/u, "").trim(), memory);
    }
    return eligible.flatMap(message => {
      const memory = lines.get(message.text.trim());
      return memory ? [{ message, proof: hintProof({ agent, host, message }, memory) }] : [];
    });
  } catch { return []; }
  finally { hooks?.close(); }
}

/** Discover only for a due batch. A host fact is usable solely beside a typed, weak candidate. */
export function hostRecallMatches(writer: RecordWriter, project: string, checkout: string, sources: readonly StageTwoSource[], now: number): HostMatch[] {
  const weak = sources.filter(source => captureProfiles[source.agent].memory && source.activeNote?.scope.kind === "seen" && source.note && source.verdict.verdict === "candidate"
    && source.verdict.outcome === "unsure" && source.verdict.kind !== "approval");
  if (!weak.length) return [];
  let hooks: ReturnType<typeof openHooksReadOnly>;
  try {
    const candidates = memoryCandidates(writer, checkout, now).map(candidate => ({ ...candidate, terms: words(candidate.text) }));
    if (!candidates.length) return [];
    hooks = openHooksReadOnly({ home: writer.location.home });
    const bySession = new Map<string, typeof candidates>();
    const matches: Array<{ match: HostMatch; score: number }> = [];
    for (const source of weak) {
      const session = source.message.session;
      let eligible = bySession.get(session);
      if (!eligible) {
        const bound = hostBinding(writer, project, checkout, source, hooks);
        eligible = candidates.filter(({ memory }) => bound(memory));
        bySession.set(session, eligible);
      }
      const terms = words(source.note!.quote);
      const scored = eligible.map(({ memory, text, terms: hostTerms }) => ({ memory, text, score: [...terms].filter(term => hostTerms.has(term)).length }))
        .sort((a, b) => b.score - a.score || b.memory.modifiedAt - a.memory.modifiedAt || a.memory.observation.localeCompare(b.memory.observation));
      const seen = new Set<string>();
      for (const { memory, text, score } of scored) {
        if (seen.has(text)) continue;
        seen.add(text);
        matches.push({ match: { id: source.message.id, text, ref: memory.ref, proof: hintProof(source, memory) }, score });
        if (seen.size === 3) break;
      }
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, HOST_HINT_LIMIT).map(({ match }) => match);
  } catch { return []; /* Unreadable host memory leaves the typed pass available. */ }
  finally { hooks?.close(); }
}

/** Recheck the selected hint bytes and path binding before using model corroboration. */
export function currentHostProofs(writer: RecordWriter, project: string, checkout: string, proofs: readonly HostMemoryProof[]): Set<string> {
  const valid = new Set<string>();
  if (!proofs.length) return valid;
  let hooks: ReturnType<typeof openHooksReadOnly>;
  try {
    const options = memoryOptions(writer, checkout), roots = memoryRoots(options);
    if (proofs.some(proof => proof.memory.agent === "claude-code")) hooks = openHooksReadOnly({ home: writer.location.home });
    const checked = new Map<string, boolean>();
    for (const { id, memory, source } of proofs) {
      if (source.agent !== memory.agent) continue;
      const key = JSON.stringify([memory.agent, memory.sourceRoot, memory.sourcePath, memory.sourceHash, memory.modifiedAt]);
      if (!checked.has(key)) checked.set(key, checkMemorySource(memory, options, roots));
      if (!checked.get(key)) continue;
      if (hostBinding(writer, project, checkout, source, hooks)(memory)) valid.add(id);
    }
  } catch { /* A changed or unavailable source provides no corroboration. */ }
  finally { hooks?.close(); }
  return valid;
}
