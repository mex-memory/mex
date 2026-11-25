import { isDeepStrictEqual } from "node:util";
import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import { hash } from "../judge/evidence.js";
import { sessionWorkEnabled } from "../judge/session.js";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import { parseEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { readNotes } from "../knowledge/personal-store.js";
import { learningMetadata } from "./metadata.js";
import { deliveredContext, deliveredNoteLookup } from "./delivered.js";
import { contextFiles, FILTER_LIMITS, filterSession, type FilterInput, type Message } from "./input.js";
import { replyContextDigest, replyContexts, type ReplyContextMode } from "./transcript.js";
import { sessionNoteHistory, sessionNoteId, type SessionNote } from "./session-notes.js";
import { stageOneBatchNeedsDecision, stageOneBatches, type StageOneBatch } from "./stage-one.js";
import { repeatsDeliveredNote, type StageOneVerdict } from "./verdicts.js";

type Candidate = Extract<StageOneVerdict, { verdict: "candidate" }>;
type Verdict = Candidate | Extract<StageOneVerdict, { verdict: "unsure" }>;
interface Selection {
  batch: StageOneBatch;
  verdict: Verdict;
  note?: SessionNote;
  activeNote?: SessionNote;
  current: boolean;
}
export interface StageTwoSource extends Selection { message: Message; }
export interface ExistingNote { entry: KnowledgeEntry; at: string; raw: string; }
export interface HostMatch { id: string; ref: string; text: string; }
export interface StageTwoInput {
  batches: StageOneBatch[];
  exhausted: Set<number>;
  sources: StageTwoSource[];
  existing: ExistingNote[];
  files: FilterInput["files"];
  sessions: number;
  unchecked: boolean;
}
const SOURCE_LIMIT = 64;
const HISTORY_LIMIT = 16;

function observation(notes: ReadonlyMap<string, SessionNote>, project: string, session: string, verdict: Verdict, now: number) {
  const note = notes.get(sessionNoteId(project, session, verdict.id));
  if (!note || note.at > now) return;
  // An exact restatement can supply older independent evidence while the
  // replacement is still live. Expiry and corrections end that evidence.
  let active = note;
  for (let depth = 0; active.retired && depth < SOURCE_LIMIT; depth++) {
    const replacement = active.retired.reason === "restated" && active.retired.replacement && notes.get(active.retired.replacement);
    if (!replacement) return;
    active = replacement;
  }
  if (!active.retired) return { note, activeNote: active };
}

function sourceRows(writer: RecordWriter, project: string, checkout: string, selected: readonly Selection[], contextMode?: ReplyContextMode): StageTwoSource[] | undefined {
  if (!selected.length) return [];
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic) return;
    const ids = selected.map(source => Number(source.verdict.id.slice(1)));
    type Row = { id: number; session_id: string; ts: string; text: string; marks: string; agent: string; paused: number };
    const raw = hooks.all<Row>("SELECT j.id,j.session_id,j.ts,j.text,j.marks,s.agent,s.paused FROM journal j JOIN sessions s ON s.session_id=j.session_id"
      + " WHERE j.kind='typed' AND s.project_id=? AND s.checkout=? AND j.id IN (" + ids.map(() => "?").join(",") + ")", project, checkout, ...ids);
    const rows = new Map(raw.map(row => [row.id, row]));
    const bySession = new Map<string, StageTwoSource[]>();
    for (const source of selected) {
      const { verdict, note } = source, row = rows.get(Number(verdict.id.slice(1)));
      if (!row || row.session_id !== source.batch.batch.session || row.marks || row.paused || !Number.isFinite(Date.parse(row.ts))) continue;
      const text = Array.from(row.text).slice(0, FILTER_LIMITS.characters).join("");
      if (!text || hasSecret(text)) continue;
      if (verdict.verdict === "candidate" && (verdict.at !== row.ts || hash(text) !== verdict.message_hash
        || text.slice(verdict.quote.start, verdict.quote.end) !== verdict.quote.text || note?.quote !== verdict.quote.text)) continue;
      const message: Message = { id: verdict.id, row: row.id, session: row.session_id, at: row.ts, text, marks: "", previous_reply: null, delivered: [] };
      const sources = bySession.get(row.session_id) ?? [];
      sources.push({ ...source, message });
      bySession.set(row.session_id, sources);
    }
    const out: StageTwoSource[] = [];
    const lookup = deliveredNoteLookup(writer.location.home, project, checkout);
    for (const [session, items] of bySession) {
      const agent = rows.get(items[0]!.message.row)!.agent;
      if (!sessionWorkEnabled(writer, agent === "claude-code" ? "claude" : "codex", session)) continue;
      const { ids, masks } = deliveredContext(hooks, session, lookup);
      const delivered = ids.map(id => ({ id, text: lookup(id)[0]?.text ?? null }));
      const trusted = items.filter(({ batch, verdict }) => isDeepStrictEqual(batch.batch.delivered, ids)
        && !(verdict.verdict === "candidate" && repeatsDeliveredNote(verdict.quote.text, delivered)));
      const meta = filterSession(writer, project, checkout, session);
      const mode = contextMode ?? "design";
      if (contextMode !== undefined && mode !== "none" && masks && meta?.transcript && meta.agent === agent) {
        replyContexts(meta.transcript, meta.agent === "claude-code" ? "claude" : "codex", trusted.map(item => item.message), mode,
          { checkout, notes: masks, maxFullReplyBytes: 12_000, includeOptions: true });
      }
      for (const item of trusted) {
        const { message, verdict } = item;
        message.delivered = ids;
        if (message.previous_reply && (hasSecret(message.previous_reply) || verdict.verdict !== "candidate"
          || replyContextDigest(message) !== verdict.reply_context_hash || !verdict.reply_context_hash)) {
          message.previous_reply = null;
          message.previous_options = [];
        }
        out.push(item);
      }
    }
    return out.sort((a, b) => a.message.row - b.message.row);
  } finally { hooks?.close(); }
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? [];

function select(rows: StageOneBatch[], current: boolean, notes: ReadonlyMap<string, SessionNote>, project: string, now: number): Selection[] {
  return rows.flatMap(batch => batch.batch.verdicts.flatMap(verdict => {
    if (verdict.verdict !== "candidate" && (verdict.verdict !== "unsure" || !current)) return [];
    if (current && batch.batch.settled?.includes(Number(verdict.id.slice(1)))) return [];
    return [{ batch, verdict, ...observation(notes, project, batch.batch.session, verdict, now), current }];
  }));
}

const qualified = (source: Selection) => source.verdict.verdict === "candidate" && source.verdict.outcome === "personal"
  && source.activeNote !== undefined && source.activeNote.scope.kind !== "seen" && source.note?.retired === undefined;

function pendingSelections(writer: RecordWriter, project: string, checkout: string, now: number, branch?: string | null) {
  const batches = stageOneBatches(writer, project, checkout).filter(row => !row.batch.retry.length);
  const notes = new Map(batches.length ? sessionNoteHistory(writer, project).map(note => [note.id, note]) : []);
  const pending = select(batches, true, notes, project, now);
  const exhausted = new Set(pending.filter(s => s.verdict.verdict === "candidate" && !s.note).map(s => Number(s.verdict.id.slice(1))));
  const usable = pending.filter(s => {
    const scope = s.activeNote?.scope;
    return !exhausted.has(Number(s.verdict.id.slice(1)))
      && (branch === undefined || scope?.kind !== "branch" || branch === "refs/heads/" + scope.origin.name);
  });
  return { batches, notes, exhausted, usable };
}

function trigger(sources: readonly Selection[]) {
  // Only three distinct new sessions can trigger the count. Replayed history
  // may corroborate a claim, but never starts another daily model call.
  return { sessions: new Set(sources.map(s => s.batch.batch.session)).size, unchecked: sources.some(qualified) };
}

export function stageTwoPending(writer: RecordWriter, project: string, checkout: string, now: number, branch?: string | null): boolean {
  const { batches, exhausted, usable } = pendingSelections(writer, project, checkout, now, branch);
  const { sessions, unchecked } = trigger(usable);
  return !!exhausted.size || sessions >= 3 || unchecked || batches.some(batch => !stageOneBatchNeedsDecision(batch));
}

export function readStageTwoInput(writer: RecordWriter, project: string, checkout: string, now: number, branch: string | null, contextMode: ReplyContextMode = "design"): StageTwoInput {
  const { batches, notes, exhausted, usable } = pendingSelections(writer, project, checkout, now, branch);
  const demand = trigger(usable);
  const empty = { batches, exhausted, sources: [], existing: [], files: [], sessions: 0, unchecked: false };
  if ((demand.sessions < 3 && !demand.unchecked) || exhausted.size) return empty;
  // Include the oldest pending row from three different sessions and the
  // first unchecked note, so one large session cannot starve the trigger.
  const first = new Set<Selection>();
  const unchecked = usable.find(qualified);
  if (unchecked) first.add(unchecked);
  const distinct = new Set<string>();
  for (const source of usable) {
    const { session } = source.batch.batch;
    if (distinct.has(session)) continue;
    distinct.add(session);
    first.add(source);
    if (distinct.size === 3) break;
  }
  for (const source of usable) {
    first.add(source);
    if (first.size === SOURCE_LIMIT) break;
  }
  const terms = new Set([...first].flatMap(({ verdict }) => verdict.verdict === "candidate" ? words(verdict.quote.text) : []));
  const historical = select(stageOneBatches(writer, project, checkout, true), false, notes, project, now)
    .concat(select(batches, false, notes, project, now).filter(source => source.batch.batch.settled?.includes(Number(source.verdict.id.slice(1)))))
    .filter(s => s.note && s.verdict.verdict === "candidate" && words(s.verdict.quote.text).some(term => terms.has(term)))
    .sort((a, b) => (b.note?.at ?? 0) - (a.note?.at ?? 0)).slice(0, HISTORY_LIMIT);
  const sources = sourceRows(writer, project, checkout, [...first, ...historical], contextMode);
  if (!sources) return empty;
  const verified = new Set(sources.map(source => source.message.row));
  for (const { verdict } of first) {
    const row = Number(verdict.id.slice(1));
    if (!verified.has(row)) exhausted.add(row);
  }
  const active = trigger(sources.filter(s => s.current));
  const existing: ExistingNote[] = [];
  if (active.sessions) {
    const candidates = [...readNotes(writer.location.home, project).files.values()].flatMap(raw => {
      const entry = parseEntry(raw);
      if (entry.mex.status !== "active" || writer.setting(project, "knowledge.retired." + entry.mex.id) || hasSecret(raw)) return [];
      const score = new Set(words(entry.text).filter(word => terms.has(word))).size;
      return score ? [{ entry, raw, score }] : [];
    }).sort((a, b) => b.score - a.score || a.entry.mex.id.localeCompare(b.entry.mex.id)).slice(0, 16);
    for (const { entry, raw } of candidates) {
      const at = learningMetadata(writer, project, entry.mex.id).at ?? entry.mex.created;
      existing.push({ entry, at, raw });
    }
  }
  const files = active.sessions ? contextFiles(checkout, sources.map(source => source.message), [])
    .filter(file => !hasSecret(file.text) && !file.path.split("/").includes(".mex")) : [];
  return { batches, exhausted, sources, existing, files, ...active };
}

/** Compare the journal bytes and delivery receipts without opening transcripts under the write lock. */
export function stageTwoSourcesCurrent(writer: RecordWriter, project: string, checkout: string, sources: readonly StageTwoSource[], now: number): boolean {
  const confirmed = sourceRows(writer, project, checkout, sources);
  if (!confirmed || confirmed.length !== sources.length) return false;
  const notes = new Map(sessionNoteHistory(writer, project).map(note => [note.id, note]));
  return confirmed.every((source, i) => {
    const old = sources[i]!, verified = observation(notes, project, source.message.session, source.verdict, now);
    return source.message.id === old.message.id && source.message.text === old.message.text && source.message.at === old.message.at
      && isDeepStrictEqual(source.message.delivered, old.message.delivered) && isDeepStrictEqual(verified?.activeNote, old.activeNote)
      && isDeepStrictEqual(verified?.note, old.note);
  });
}
