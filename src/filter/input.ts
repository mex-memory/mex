import { lstatSync, opendirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { automaticWorkEnabled } from "../controls/index.js";
import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";
import { containedDirectory, readBoundedTextFile, readEntryFile, personalReadGuard } from "../knowledge/files.js";
import { parseEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { repoFile } from "../knowledge/references.js";
import { assertNoSecrets } from "../knowledge/gates.js";
import { hash } from "../judge/evidence.js";
import { cachedReplyContext, replyContexts, type ReplyContextMode, type ReplyOption, type TranscriptIssue } from "./transcript.js";
import { deliveredContext, deliveredNoteLookup } from "./delivered.js";
import { sessionWorkEnabled } from "../judge/session.js";
import { NOTE_ATTEMPT_LIMIT, noteAttempt, type NoteAttempt } from "./note-attempts.js";
import { captureProfiles, typedCapture, type CaptureAgent, type TranscriptAgent } from "./profiles.js";
import { readReplyCache, type ReplyCache } from "./reply-cache.js";
import { timestampNs } from "./time.js";
export { timestampNs } from "./time.js";

export const FILTER_LIMITS = { rows: 4096, messages: 64, notes: 8, characters: 1200, inputBytes: 200 << 10, promptBytes: 256 << 10,
  files: 16, fileBytes: 16 << 10, idleMs: 10 * 60_000, ageMs: 24 * 60 * 60_000 } as const;
export interface FilterParams { checkout: string; agent: "claude" | "codex"; sourceAgent?: CaptureAgent; generation?: string; sessionId?: string; request?: string; }
export interface Message { id: string; row: number; session: string; at: string; text: string; marks: string;
  previous_reply: string | null; previous_options?: ReplyOption[]; delivered: string[]; }
export interface NoteInput { id: string; path: string; hash: string; entry: KnowledgeEntry; attempt?: NoteAttempt; }
export interface FilterInput { messages: Message[]; notes: NoteInput[]; files: Array<{ path: string; text: string; hash: string }>;
  delivered_notes: Array<{ id: string; text: string | null }>; }
export interface ScanWindow { after: number; carry?: number[]; deferred?: number[]; through?: number; more?: boolean;
  contextIssues?: TranscriptIssue[]; messagesWithheld?: number; }
interface Journal { id: number; session_id: string; ts: string; text: string; marks: string; last_seen_at: string; paused: number; agent: string; }
type CaptureSession = Pick<Journal, "session_id" | "last_seen_at" | "paused" | "agent">;
type Transcript = { path: string; agent: TranscriptAgent };
type Hooks = ReturnType<typeof openHooksReadOnly>;
const Metadata = z.object({ version: z.literal(1), project_id: z.string(), checkout: z.string(), agent: z.string(),
  session_id: z.string(), seen_at: z.string().datetime({ offset: true }), finished: z.boolean(), transcript: z.string().max(4096),
  branch: z.string().min(1).max(1024).optional(), head: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(), position_at: z.string().datetime({ offset: true }).optional(),
  idle: z.boolean().optional(), prompt_at: z.string().datetime({ offset: true }).optional(), outside_at: z.string().datetime({ offset: true }).optional() }).strict();
export const ackKey = (session: string) => `filter.session.${shortHash(session)}`;
export function acknowledged(writer: RecordWriter, project: string, session: string): number {
  const n = Number(writer.setting(project, ackKey(session)) ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
export function filterAllowed(writer: RecordWriter, project: string, params: FilterParams): boolean {
  const checkout = writer.checkout(params.checkout);
  return !!checkout && checkout.project_id === project && checkout.state !== "off"
    && !(checkout.state === "off until" && Date.parse(checkout.off_until ?? "") > Date.now())
    && automaticWorkEnabled(writer, project) && writer.setting("global", "capture.enabled") !== "false"
    && writer.setting(project, "capture.enabled") !== "false" && sessionWorkEnabled(writer, params.sourceAgent ?? params.agent, params.sessionId);
}
export function filterSession(writer: Pick<RecordWriter, "location">, project: string, checkout: string, session: string) {
  const dir = containedDirectory(writer.location.directory, ["filter-sessions"]);
  if (!dir) return undefined;
  const raw = readBoundedTextFile(join(dir, `${shortHash(project + "\0" + session)}.json`), 16 << 10);
  if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  const parsed = Metadata.safeParse(value);
  return parsed.success && parsed.data.project_id === project && parsed.data.checkout === checkout && parsed.data.session_id === session ? parsed.data : undefined;
}

export function recordedTranscript(meta: ReturnType<typeof filterSession>, agent: CaptureAgent): Transcript | undefined {
  const dialect = captureProfiles[agent].transcript;
  if (!dialect || meta?.agent !== agent) return;
  if (meta.transcript) return { path: meta.transcript, agent: dialect };
  // Copilot hooks can omit transcriptPath. Its local event file is scoped by a single validated session id.
  if (agent === "copilot" && /^[A-Za-z0-9_-]{1,128}$/u.test(meta.session_id)) {
    const root = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
    return { path: join(root, "session-state", meta.session_id, "events.jsonl"), agent: dialect };
  }
}
export interface SessionPosition { branch?: string; head?: string; position_at?: string; seen_at: string; }
export function capturedPositionAt(meta: SessionPosition | undefined, at: string) {
  if (!meta?.branch || !meta.head || !meta.position_at) return;
  const source = timestampNs(at), since = timestampNs(meta.position_at), seen = timestampNs(meta.seen_at);
  if (source !== undefined && since !== undefined && seen !== undefined && source >= since && source <= seen)
    return { branch: meta.branch, head: meta.head };
}
function heartbeat(writer: RecordWriter, agent: string, session: string): bigint | undefined {
  if (!typedCapture(agent)) return 0n;
  const directory = containedDirectory(writer.location.home, ["heartbeats", agent]);
  if (!directory) return 0n;
  const name = Buffer.from(session).map(c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || [45, 46, 95].includes(c) ? c : 95).toString();
  const path = join(directory, !name || name === "." || name === ".." ? "_" : name);
  try {
    const raw = readBoundedTextFile(path, 4096);
    if (!raw) return 0n;
    const value = JSON.parse(raw);
    // A sanitized-name collision is uncertainty, never proof of inactivity.
    if (value.session_id !== session || value.agent !== agent) return undefined;
    return lstatSync(path, { bigint: true }).mtimeNs;
  } catch { return undefined; }
}
function sessionActivity(writer: RecordWriter, project: string, checkout: string, row: CaptureSession, now: number) {
  if (row.paused || !typedCapture(row.agent)) return;
  const meta = filterSession(writer, project, checkout, row.session_id);
  const agent = row.agent;
  // Older journal rows can name one of the two original agents while the
  // session metadata records the other adapter that supplied the transcript.
  let transcriptHost: CaptureAgent = agent;
  if (meta && meta.agent !== agent) {
    if ((agent !== "claude-code" && agent !== "codex") || (meta.agent !== "claude-code" && meta.agent !== "codex")) return;
    transcriptHost = meta.agent;
  }
  const lastSeen = timestampNs(row.last_seen_at), beat = heartbeat(writer, row.agent, row.session_id);
  if (lastSeen === undefined || beat === undefined) return;
  const activity = lastSeen > beat ? lastSeen : beat, recorded = meta ? timestampNs(meta.seen_at) : undefined;
  const profile = captureProfiles[agent];
  const transcript = recordedTranscript(meta, transcriptHost);
  const seen = recorded !== undefined && recorded > activity ? recorded : activity;
  const ended = recorded !== undefined && (meta?.finished && recorded >= activity
    || profile.finish === "idle" && meta?.idle && seen <= BigInt(Math.trunc(now - FILTER_LIMITS.idleMs)) * 1_000_000n);
  return { seen,
    finished: ended, agent, transcript, meta };
}

export function finishedCaptureSession(writer: RecordWriter, project: string, checkout: string, session: string, now: number): boolean {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic) return false;
    const row = hooks.get<CaptureSession>("SELECT session_id,agent,last_seen_at,paused FROM sessions WHERE project_id=? AND checkout=? AND session_id=?",
      project, checkout, session);
    return !!row && !!sessionActivity(writer, project, checkout, row, now)?.finished;
  } finally { hooks?.close(); }
}
function personalNotes(writer: RecordWriter, project: string): NoteInput[] {
  const check = personalReadGuard(join(writer.location.home, "projects", project, "notes"));
  const dir = containedDirectory(writer.location.home, ["projects", project, "notes"]);
  if (!dir) return [];
  const names: string[] = [], handle = opendirSync(dir);
  try {
    let child;
    while ((child = handle.readSync())) {
      if (names.length >= 10_000) throw new Error("The filter's note limit was reached.");
      names.push(child.name);
    }
  } finally { handle.closeSync(); }
  const notes: NoteInput[] = [];
  for (const name of names.sort()) {
    if (!/^mx_[a-z0-9]{6,64}\.md$/u.test(name)) continue;
    const path = join(dir, name), raw = readEntryFile(path);
    if (raw === undefined) continue;
    const entry = parseEntry(raw);
    const digest = hash(raw);
    if (`${entry.mex.id}.md` !== name || entry.mex.status !== "active" || entry.mex.checks.length
      || writer.setting(project, `knowledge.retired.${entry.mex.id}`)
      || writer.setting(project, `filter.note.${entry.mex.id}`) === digest) continue;
    const attempt = noteAttempt(writer, project, entry.mex.id, digest);
    if (attempt?.failures === NOTE_ATTEMPT_LIMIT) continue;
    notes.push({ id: entry.mex.id, path, hash: digest, entry, attempt });
    if (notes.length === FILTER_LIMITS.notes) break;
  }
  check(); return notes;
}
/** Bounded repository context helps the same text-only call propose check targets. */
export function contextFiles(checkout: string, messages: Message[], notes: NoteInput[]): FilterInput["files"] {
  const paths = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "README.md"]);
  for (const text of [...messages.map(m => m.text), ...notes.map(n => n.entry.text)]) {
    for (const m of text.matchAll(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/gu)) if (paths.size < FILTER_LIMITS.files) paths.add(m[0]);
  }
  const files: FilterInput["files"] = [];
  for (const path of paths) {
    const full = repoFile(checkout, path);
    if (!full) continue;
    // Oversized context is explicitly absent; no truncated file can mint a baseline.
    let text: string | undefined;
    try { text = readBoundedTextFile(full, FILTER_LIMITS.fileBytes); } catch { continue; }
    if (text !== undefined) files.push({ path, text, hash: hash(text) });
  }
  return files;
}
function capturedMessage(row: Pick<Journal, "id" | "ts" | "session_id" | "text" | "marks">, typed: boolean): Message {
  return { id: "m" + row.id, row: row.id, session: row.session_id, at: row.ts,
    text: typed ? Array.from(row.text).slice(0, FILTER_LIMITS.characters).join("") : "", marks: row.marks,
    previous_reply: null, delivered: [] };
}

export function filterInput(writer: RecordWriter, project: string, params: FilterParams, cheap: boolean, now = Date.now(), scan?: ScanWindow,
  contextMode: ReplyContextMode = "design", notesOnly = false): FilterInput | undefined {
  if (notesOnly) {
    const notes = personalNotes(writer, project);
    return notes.length ? completeInput(writer, project, params.checkout, undefined, [], notes, new Map(), contextMode, scan) : undefined;
  }
  const hooks = openHooksReadOnly({ home: writer.location.home });
  const transcripts = new Map<string, Transcript>();
  try {
    if (hooks?.diagnostic) throw new Error("The filter needs a compatible capture journal.");
    const after = Math.max(scan?.after ?? 0, Number(writer.setting(project, "journal.consumed") ?? 0));
    const carry = (scan?.carry ?? []).filter(n => Number.isSafeInteger(n) && n > 0).slice(0, 19);
    const rows = hooks?.all<Journal>(`SELECT j.id,j.session_id,j.ts,j.text,j.marks,s.last_seen_at,s.paused,s.agent FROM journal j
      JOIN sessions s ON s.session_id=j.session_id WHERE s.project_id=? AND s.checkout=? AND j.kind='typed' AND (j.id>? ${carry.length ? `OR j.id IN (${carry.map(() => "?").join(",")})` : ""})
      ORDER BY j.id LIMIT ?`, project, params.checkout, after, ...carry, FILTER_LIMITS.rows + carry.length) ?? [];
    if (scan) {
      const page = rows.filter(r => r.id > after);
      scan.through = page.at(-1)?.id ?? scan.after; scan.more = page.length >= FILTER_LIMITS.rows;
    }
    const eligible = rows.filter(row => {
      if (row.id <= acknowledged(writer, project, row.session_id)) return false;
      const activity = sessionActivity(writer, project, params.checkout, row, now);
      if (!activity || (!activity.finished && activity.seen > BigInt(Math.trunc(now - FILTER_LIMITS.idleMs)) * 1_000_000n)) return false;
      if (activity.transcript) transcripts.set(row.session_id, activity.transcript);
      return true;
    });
    // Learning from typed statements is opt-in: while it is off the filter
    // only gives explicit notes their checks, and typed text never reaches it.
    if (!statementsOn(writer)) eligible.length = 0;
    if (scan) scan.deferred = !cheap && eligible.length < 20 ? eligible.map(r => r.id).slice(0, 19) : [];
    const notes = personalNotes(writer, project);
    if (!notes.length && (!eligible.length || (!cheap && eligible.length < 20 && Date.parse(eligible[0]!.ts) > now - FILTER_LIMITS.ageMs))) return undefined;
    const readyMessages = cheap || eligible.length >= 20 || (eligible.length > 0 && Date.parse(eligible[0]!.ts) <= now - FILTER_LIMITS.ageMs);
    const messages = (readyMessages ? eligible : []).slice(0, FILTER_LIMITS.messages).map(row => capturedMessage(row, true));
    return completeInput(writer, project, params.checkout, hooks, messages, notes, transcripts, contextMode, scan);
  } finally { hooks?.close(); }
}

interface SessionSelection { session: string; retryRows?: readonly number[]; }
/** Select one finished session, with a bounded page for unusually long sessions. */
export function stageOneInput(writer: RecordWriter, project: string, checkout: string, scan: ScanWindow, contextMode: ReplyContextMode,
  selection?: SessionSelection, now = Date.now()): { session: string; input: FilterInput; sourcePosition?: SessionPosition; cache?: string } | undefined {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (hooks?.diagnostic) throw new Error("The filter needs a compatible capture journal.");
    if (!hooks) return;
    const consumed = Number(writer.setting(project, "journal.consumed") ?? 0);
    const after = Math.max(scan.after, consumed);
    const select = (session: string) => hooks.get<CaptureSession>(
      "SELECT session_id,agent,last_seen_at,paused FROM sessions WHERE project_id=? AND checkout=? AND session_id=?", project, checkout, session);
    const retryRows = selection?.retryRows;
    let session = selection?.session, activity: ReturnType<typeof sessionActivity>;
    if (session) {
      const row = select(session);
      if (!row && !retryRows) return;
      activity = row && sessionActivity(writer, project, checkout, row, now);
      if (row && (!activity?.finished || !sessionWorkEnabled(writer, activity.agent, session))) return;
    } else {
      const rows = hooks.all<CaptureSession & { id: number }>("SELECT j.id,s.session_id,s.agent,s.last_seen_at,s.paused FROM journal j JOIN sessions s ON s.session_id=j.session_id WHERE s.project_id=? AND s.checkout=? AND j.kind='typed' AND j.id>? ORDER BY j.id LIMIT ?",
        project, checkout, after, FILTER_LIMITS.rows);
      scan.through = rows.at(-1)?.id ?? after;
      scan.more = rows.length === FILTER_LIMITS.rows;
      const visited = new Set<string>();
      for (const row of rows) {
        if (visited.has(row.session_id) || row.id <= acknowledged(writer, project, row.session_id)) continue;
        visited.add(row.session_id);
        activity = sessionActivity(writer, project, checkout, row, now);
        if (activity?.finished && sessionWorkEnabled(writer, activity.agent, row.session_id)) { session = row.session_id; break; }
      }
    }
    if (!session) return;
    const minRow = Math.max(consumed, acknowledged(writer, project, session));
    const rows = hooks.all<Pick<Journal, "id" | "ts" | "session_id" | "text" | "marks">>(
      "SELECT j.id,j.ts,j.session_id,CASE WHEN j.marks='' THEN j.text ELSE '' END text,j.marks FROM journal j JOIN sessions s ON s.session_id=j.session_id "
      + "WHERE s.project_id=? AND s.checkout=? AND s.paused=0 AND j.session_id=? AND j.kind='typed' AND j.id>?"
      + (retryRows ? " AND j.id IN (" + retryRows.map(() => "?").join(",") + ")" : "") + " ORDER BY j.id LIMIT ?",
      project, checkout, session, minRow, ...(retryRows ?? []), FILTER_LIMITS.messages);
    if (!rows.length && !retryRows) return;
    const transcripts = new Map<string, Transcript>();
    if (activity?.transcript) transcripts.set(session, activity.transcript);
    const profile = activity && captureProfiles[activity.agent];
    const cache = activity && profile?.cache ? readReplyCache(writer, project, checkout, activity.agent, session, now) : undefined;
    const input = completeInput(writer, project, checkout, hooks, rows.map(row => capturedMessage(row, !row.marks)), [], transcripts, contextMode, scan,
      retryRows ? "retry" : "page", activity?.agent, cache);
    const meta = activity?.meta;
    const sourcePosition = meta && { branch: meta.branch, head: meta.head, position_at: meta.position_at, seen_at: meta.seen_at };
    return { session, input, sourcePosition, cache: cache?.file };
  } finally { hooks?.close(); }
}

function completeInput(writer: RecordWriter, project: string, checkout: string, hooks: Hooks, messages: Message[], notes: NoteInput[],
  transcripts: ReadonlyMap<string, Transcript>, contextMode: ReplyContextMode, scan?: ScanWindow, stageOne?: "page" | "retry",
  agent?: CaptureAgent, cache?: ReplyCache): FilterInput {
  const delivered = new Set<string>();
  // Read each selected session once. Reply context is transient and never supplies a saved quote.
  const bySession = new Map<string, Message[]>();
  for (const message of messages) {
    if (stageOne && message.marks) continue;
    const group = bySession.get(message.session) ?? [];
    group.push(message);
    bySession.set(message.session, group);
  }
  const lookup = deliveredNoteLookup(writer.location.home, project, checkout);
  const contextIssues = new Map<string, TranscriptIssue>();
  const withheld = new Set<number>();
  for (const [session, group] of bySession) {
    const { ids, masks } = deliveredContext(hooks!, session, lookup);
    ids.forEach(id => delivered.add(id));
    for (const message of group) message.delivered = ids;
    if (contextMode === "none") continue;
    const transcript = transcripts.get(session);
    if (agent && !captureProfiles[agent].transcript && !captureProfiles[agent].cache) continue;
    let issue: TranscriptIssue | undefined = masks === null ? "delivered-notes" : transcript
      ? replyContexts(transcript.path, transcript.agent, group, contextMode,
        { checkout, notes: masks, withheld, maxFullReplyBytes: FILTER_LIMITS.inputBytes, includeOptions: !!stageOne }) : "unavailable";
    if (cache && masks && (!transcript || issue === "unavailable")) {
      const at = timestampNs(cache.at)!;
      const next = messages.find(message => message.at === cache.promptAt && (timestampNs(message.at) ?? 0n) > at);
      if (next && !next.marks && !withheld.has(next.row)) cachedReplyContext(next, cache.text, contextMode, masks);
      issue = undefined;
    }
    if (issue) {
      contextIssues.set(session, issue);
      for (const message of group) withheld.add(message.row);
    }
  }
  let deliveredBytes = 0;
  const input = { messages, notes, files: stageOne ? [] : contextFiles(checkout, messages, notes),
    delivered_notes: [...delivered].sort().map(id => {
      const text = lookup(id)[0]?.text, bounded = text ? Array.from(text).slice(0, 1200).join("") : null;
      deliveredBytes += bounded ? Buffer.byteLength(bounded) : 0;
      return { id, text: deliveredBytes <= 16 << 10 ? bounded : null };
    }) };
  const withhold = (message: Message) => {
    message.previous_reply = null;
    if (message.previous_options) message.previous_options = [];
    withheld.add(message.row);
  };
  if (contextMode === "full" || stageOne) {
    // Keep the typed message if its full reply cannot fit even as the only input.
    const overhead = Buffer.byteLength(JSON.stringify({ ...input, messages: [], notes: [], files: [] }));
    for (const message of input.messages) {
      if (message.previous_reply === null || overhead + Buffer.byteLength(JSON.stringify(message)) <= FILTER_LIMITS.inputBytes) continue;
      withhold(message);
    }
  }
  // Split the batch deterministically, leaving omitted inputs unacknowledged.
  while (Buffer.byteLength(JSON.stringify(input)) > FILTER_LIMITS.inputBytes) {
    if (input.files.length) input.files.pop();
    else if (input.notes.length > 1) input.notes.pop();
    else if (stageOne === "retry") {
      const message = input.messages.slice().reverse().find(message => message.previous_reply !== null);
      if (!message) throw new Error("The filter's retry inputs exceed the batch limit.");
      withhold(message);
    }
    else if (input.messages.length) input.messages.pop();
    else throw new Error("One filter input exceeds the batch limit.");
  }
  if (scan) {
    const retained = new Set(input.messages.map(message => message.session));
    scan.contextIssues = [...contextIssues].filter(([session]) => retained.has(session)).map(([, issue]) => issue);
    scan.messagesWithheld = input.messages.filter(message => withheld.has(message.row)).length;
  }
  assertNoSecrets(input);
  return input;
}
/** Learning from what people type runs only when they turn it on (`mex config set learning.statements on`). */
export function statementsOn(writer: Pick<RecordWriter, "setting">): boolean {
  return writer.setting("global", "learning.statements") === "on";
}

/**
 * With statement learning off, typed rows are never read by the filter, so
 * they count as handled: the journal prefix can still be pruned, and turning
 * learning on later starts from new text rather than old sessions. Only rows
 * after `journal.consumed` are read: consumed rows stay in the journal until
 * retention, and the earliest sessions are acknowledged first so the cursor moves.
 */
export function acknowledgeTyped(writer: RecordWriter, project: string, checkout: string): void {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic) return;
    const consumed = Number(writer.setting(project, "journal.consumed") ?? 0);
    const after = Number.isSafeInteger(consumed) && consumed > 0 ? consumed : 0;
    const rows = hooks.all<{ session_id: string; last: number }>(`SELECT j.session_id, MAX(j.id) AS last FROM journal j JOIN sessions s ON s.session_id=j.session_id
      WHERE s.project_id=? AND s.checkout=? AND j.kind='typed' AND j.id>? GROUP BY j.session_id ORDER BY MIN(j.id) LIMIT 4096`, project, checkout, after);
    const due = rows.filter(row => row.last > acknowledged(writer, project, row.session_id));
    if (due.length) {
      // One transaction: a pass can acknowledge thousands of sessions.
      const put = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
      writer.db.exec("BEGIN IMMEDIATE");
      try { for (const row of due) put.run(project, ackKey(row.session_id), String(row.last)); writer.db.exec("COMMIT"); }
      catch (error) { try { writer.db.exec("ROLLBACK"); } catch { /* already ended */ } throw error; }
    }
  } finally { hooks?.close(); }
  advanceConsumed(writer, project);
}

/** Only a fully acknowledged prefix may be pruned by Go, including other worktrees. */
export function advanceConsumed(writer: RecordWriter, project: string): void {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic) return;
    const before = Number(writer.setting(project, "journal.consumed") ?? 0);
    const rows = hooks.all<{ id: number; session_id: string; kind: string }>(`SELECT j.id,j.session_id,j.kind FROM journal j JOIN sessions s ON s.session_id=j.session_id
      WHERE s.project_id=? AND j.id>? ORDER BY j.id LIMIT ?`, project, before, FILTER_LIMITS.rows);
    let safe = before;
    for (const row of rows) {
      if (row.kind === "typed" && row.id > acknowledged(writer, project, row.session_id)) break;
      safe = row.id;
    }
    if (safe > before) writer.db.prepare("INSERT INTO settings VALUES(?, 'journal.consumed', ?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(project, String(safe));
  } finally { hooks?.close(); }
}
