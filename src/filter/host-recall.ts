import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import { absolutePath } from "../record/project.js";
import { hash } from "../judge/evidence.js";
import { checkMemorySource, discoverMemory, memoryRoots, type MemoryCandidate } from "../knowledge/host-memory.js";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import { filterSession } from "./input.js";
import type { StageTwoSource } from "./stage-two-input.js";
import { codexRolloutSession } from "./transcript.js";

const TAIL_MS = 15 * 60_000;
export const HOST_HINT_LIMIT = 16;
export interface HostMatch { id: string; ref: string; text: string; proof?: HostMemoryProof; }
export interface HostMemoryProof { id: string; memory: MemoryCandidate; source: StageTwoSource; }

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

/** Discover only for a due batch. A host fact is usable solely beside a typed, weak candidate. */
export function hostRecallMatches(writer: RecordWriter, project: string, checkout: string, sources: readonly StageTwoSource[], now: number): HostMatch[] {
  const weak = sources.filter(source => source.activeNote?.scope.kind === "seen" && source.note && source.verdict.verdict === "candidate"
    && source.verdict.outcome === "unsure" && source.verdict.kind !== "approval");
  if (!weak.length) return [];
  let hooks: ReturnType<typeof openHooksReadOnly>;
  try {
    const discovery = discoverMemory(memoryOptions(writer, checkout), new Date(now));
    const candidates = discovery.candidates.flatMap(memory => {
      const text = stripHidden(memory.text);
      if (!text || (memory.agent === "claude-code" && memory.modifiedAt > now) || hasSecret(text) || /<\s*\/?\s*private\b/iu.test(text)) return [];
      return [{ memory, text, terms: words(text) }];
    });
    if (!candidates.length) return [];
    hooks = openHooksReadOnly({ home: writer.location.home });
    if (!hooks || hooks.diagnostic) return [];
    const bySession = new Map<string, typeof candidates>();
    const matches: Array<{ match: HostMatch; score: number }> = [];
    for (const source of weak) {
      const session = source.message.session;
      let eligible = bySession.get(session);
      if (!eligible) {
        const window = source.agent === "claude-code" ? sessionWindow(hooks, session) : undefined;
        const info = source.agent === "codex" ? filterSession(writer, project, checkout, session) : undefined;
        eligible = candidates.filter(({ memory }) => memory.agent === source.agent && (source.agent === "codex"
          ? codexMatch(memory, session, info?.agent === "codex" ? info.transcript : undefined)
          : !!window && memory.modifiedAt >= window.start && memory.modifiedAt <= window.end));
        bySession.set(session, eligible);
      }
      const terms = words(source.note!.quote);
      const scored = eligible.map(({ memory, text, terms: hostTerms }) => ({ memory, text, score: [...terms].filter(term => hostTerms.has(term)).length }))
        .sort((a, b) => b.score - a.score || b.memory.modifiedAt - a.memory.modifiedAt || a.memory.observation.localeCompare(b.memory.observation));
      const seen = new Set<string>();
      for (const { memory, text, score } of scored) {
        if (seen.has(text)) continue;
        seen.add(text);
        const id = source.message.id, hint = `hint:${hash(JSON.stringify([id, memory.observation])).slice(7, 31)}`;
        matches.push({ match: { id, text, ref: memory.ref, proof: { id: hint, memory, source } }, score });
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
      const session = source.message.session;
      const key = JSON.stringify([memory.agent, memory.sourceRoot, memory.sourcePath, memory.sourceHash, memory.modifiedAt]);
      if (!checked.has(key)) checked.set(key, checkMemorySource(memory, options, roots));
      if (!checked.get(key)) continue;
      if (memory.agent === "claude-code") {
        const window = hooks && !hooks.diagnostic ? sessionWindow(hooks, session) : undefined;
        if (window && memory.modifiedAt >= window.start && memory.modifiedAt <= window.end) valid.add(id);
      } else {
        const info = filterSession(writer, project, checkout, session);
        if (codexMatch(memory, session, info?.agent === "codex" ? info.transcript : undefined)) valid.add(id);
      }
    }
  } catch { /* A changed or unavailable source provides no corroboration. */ }
  finally { hooks?.close(); }
  return valid;
}
