import { lstatSync, opendirSync } from "node:fs";
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
import { replyContexts, type ReplyContextMode, type TranscriptIssue } from "./transcript.js";
import { deliveredContext, deliveredNoteLookup } from "./delivered.js";
import { sessionWorkEnabled } from "../judge/session.js";

export const FILTER_LIMITS = { rows: 4096, messages: 64, notes: 8, characters: 1200, promptBytes: 256 << 10,
  files: 16, fileBytes: 16 << 10, idleMs: 10 * 60_000, ageMs: 24 * 60 * 60_000 } as const;
export interface FilterParams { checkout: string; agent: "claude" | "codex"; generation?: string; sessionId?: string; }
export interface Message { id: string; row: number; session: string; at: string; text: string; marks: string;
  previous_reply: string | null; delivered: string[]; }
export interface NoteInput { id: string; path: string; hash: string; entry: KnowledgeEntry; }
export interface FilterInput { messages: Message[]; notes: NoteInput[]; files: Array<{ path: string; text: string; hash: string }>;
  delivered_notes: Array<{ id: string; text: string | null }>; }
export interface ScanWindow { after: number; carry?: number[]; deferred?: number[]; through?: number; more?: boolean; contextIssues?: TranscriptIssue[]; }
interface Journal { id: number; session_id: string; ts: string; text: string; marks: string; last_seen_at: string; paused: number; agent: string; }
const Metadata = z.object({ version: z.literal(1), project_id: z.string(), checkout: z.string(), agent: z.string(),
  session_id: z.string(), seen_at: z.string().datetime({ offset: true }), finished: z.boolean(), transcript: z.string().max(4096),
  branch: z.string().min(1).max(1024).optional(), head: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(), position_at: z.string().datetime({ offset: true }).optional() }).strict();
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
    && writer.setting(project, "capture.enabled") !== "false" && sessionWorkEnabled(writer, params.agent, params.sessionId);
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
export function timestampNs(value: string): bigint | undefined {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const fraction = (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u)?.[1] ?? "").padEnd(9, "0").slice(3, 9);
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction || "0");
}
function heartbeat(writer: RecordWriter, agent: string, session: string): bigint | undefined {
  if (agent !== "codex" && agent !== "claude-code") return 0n;
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
    if (`${entry.mex.id}.md` !== name || entry.mex.status !== "active" || entry.mex.checks.length
      || writer.setting(project, `knowledge.retired.${entry.mex.id}`)
      || writer.setting(project, `filter.note.${entry.mex.id}`) === hash(raw)) continue;
    notes.push({ id: entry.mex.id, path, hash: hash(raw), entry });
    if (notes.length === FILTER_LIMITS.notes) break;
  }
  check(); return notes;
}
/** Bounded repository context helps the same text-only call propose check targets. */
function contextFiles(checkout: string, messages: Message[], notes: NoteInput[]): FilterInput["files"] {
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
export function filterInput(writer: RecordWriter, project: string, params: FilterParams, cheap: boolean, now = Date.now(), scan?: ScanWindow,
  contextMode: ReplyContextMode = "design"): FilterInput | undefined {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  const messages: Message[] = [];
  const transcripts = new Map<string, { path: string; agent: "claude" | "codex" }>();
  const delivered = new Set<string>();
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
      if (row.paused || row.id <= acknowledged(writer, project, row.session_id)) return false;
      const meta = filterSession(writer, project, params.checkout, row.session_id);
      const lastSeen = timestampNs(row.last_seen_at), beat = heartbeat(writer, row.agent, row.session_id);
      if (lastSeen === undefined || beat === undefined) return false;
      const activity = lastSeen > beat ? lastSeen : beat, recorded = meta ? timestampNs(meta.seen_at) : undefined;
      const seen = recorded !== undefined && recorded > activity ? recorded : activity;
      const finished = meta?.finished && recorded !== undefined && recorded >= activity;
      if (!finished && seen > BigInt(Math.trunc(now - FILTER_LIMITS.idleMs)) * 1_000_000n) return false;
      if (meta?.transcript) transcripts.set(row.session_id, { path: meta.transcript, agent: meta.agent === "claude-code" ? "claude" : "codex" });
      return true;
    });
    // Learning from typed statements is opt-in: while it is off the filter
    // only gives explicit notes their checks, and typed text never reaches it.
    if (!statementsOn(writer)) eligible.length = 0;
    if (scan) scan.deferred = !cheap && eligible.length < 20 ? eligible.map(r => r.id).slice(0, 19) : [];
    const notes = personalNotes(writer, project);
    if (!notes.length && (!eligible.length || (!cheap && eligible.length < 20 && Date.parse(eligible[0]!.ts) > now - FILTER_LIMITS.ageMs))) return undefined;
    const readyMessages = cheap || eligible.length >= 20 || (eligible.length > 0 && Date.parse(eligible[0]!.ts) <= now - FILTER_LIMITS.ageMs);
    for (const row of (readyMessages ? eligible : []).slice(0, FILTER_LIMITS.messages)) {
      messages.push({ id: `m${row.id}`, row: row.id, session: row.session_id, at: row.ts,
        text: Array.from(row.text).slice(0, FILTER_LIMITS.characters).join(""), marks: row.marks,
        previous_reply: null, delivered: [] });
    }
    // Read each selected session once. Reply context is transient and never supplies a saved quote.
    const bySession = new Map<string, Message[]>();
    for (const message of messages) {
      const group = bySession.get(message.session) ?? [];
      group.push(message);
      bySession.set(message.session, group);
    }
    const lookup = deliveredNoteLookup(writer.location.home, project, params.checkout);
    const contextIssues = new Map<string, TranscriptIssue>();
    for (const [session, group] of bySession) {
      const { ids, masks } = deliveredContext(hooks!, session, lookup);
      ids.forEach(id => delivered.add(id));
      for (const message of group) message.delivered = ids;
      const transcript = transcripts.get(session);
      const issue = masks === null ? "delivered-notes" : transcript
        ? replyContexts(transcript.path, transcript.agent, group, contextMode, { checkout: params.checkout, notes: masks }) : "unavailable";
      if (issue) contextIssues.set(session, issue);
    }
    let deliveredBytes = 0;
    const input = { messages, notes, files: contextFiles(params.checkout, messages, notes),
      delivered_notes: [...delivered].sort().map(id => {
        const text = lookup(id)[0]?.text, bounded = text ? Array.from(text).slice(0, 1200).join("") : null;
        deliveredBytes += bounded ? Buffer.byteLength(bounded) : 0;
        return { id, text: deliveredBytes <= 16 << 10 ? bounded : null };
      }) };
    // Split the batch deterministically, leaving omitted inputs unacknowledged.
    while (Buffer.byteLength(JSON.stringify(input)) > 200 << 10) {
      if (input.files.length) input.files.pop();
      else if (input.notes.length > 1) input.notes.pop();
      else if (input.messages.length) input.messages.pop();
      else throw new Error("One filter input exceeds the batch limit.");
    }
    if (scan && contextIssues.size) {
      const retained = new Set(input.messages.map(message => message.session));
      scan.contextIssues = [...contextIssues].filter(([session]) => retained.has(session)).map(([, issue]) => issue);
    }
    assertNoSecrets(input);
    return input;
  } finally { hooks?.close(); }
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
