import { isAbsolute } from "node:path";
import { z } from "zod";
import { ImportFile, MAX_SESSIONS, readSessionImport } from "../learn-deeper/session-import.js";
import { importLearningOn, sessionRunner, SESSION_RUNNERS } from "../knowledge/session-learning.js";
import type { RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";
import { assertNoSecrets, hasSecret, stripHidden } from "../knowledge/gates.js";
import { acknowledged, FILTER_LIMITS, type Message, type SessionInput, type SessionSelection } from "./input.js";
import { replyContexts, type ReplyContextMode } from "./transcript.js";

const Window = z.object({ since: z.string().datetime(), until: z.string().datetime() }).strict().refine(value => value.since < value.until);
const Checkout = z.string().min(1).max(4096).refine(isAbsolute);
export const SessionImportPlan = z.object({ checkout: Checkout, window: Window, mode: z.enum(SESSION_RUNNERS),
  files: z.array(ImportFile).nonempty().max(MAX_SESSIONS), gaps: z.array(z.string().max(256)).max(16) }).strict();
export type SessionImportPlan = z.infer<typeof SessionImportPlan>;
const Receipt = z.object({ checkout: Checkout, window: Window, file: ImportFile, mode: z.enum(SESSION_RUNNERS) }).strict();
const PREFIX = "session-import.receipt.";

export const importSession = (file: ImportFile) => "import:" + shortHash(JSON.stringify([file.agent, file.path]));
export const isImportedSession = (id: string) => /^import:[a-f0-9]{24}$/u.test(id);

/** The import owns a distinct, stable row namespace without writing the hook journal. */
function importedRow(session: string, index: number): number {
  return 4_000_000_000_000_000 + Number.parseInt(session.slice(7, 19), 16) * 8 + index;
}

/** Receipts contain the approved file identity and scope, never transcript text. */
export function rememberImport(writer: RecordWriter, project: string, plan: SessionImportPlan, file: ImportFile) {
  const key = PREFIX + importSession(file);
  const receipt = Receipt.parse({ checkout: plan.checkout, window: plan.window, file, mode: plan.mode });
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(project, key, JSON.stringify(receipt));
  // The active and reviewed verdict stores are bounded too. Retain receipts for both.
  writer.db.prepare("DELETE FROM settings WHERE scope=? AND key IN (SELECT key FROM settings WHERE scope=? AND key LIKE ? ORDER BY rowid DESC LIMIT -1 OFFSET 256)")
    .run(project, project, `${PREFIX}%`);
}

export function importedSessionInput(writer: RecordWriter, project: string, checkout: string, session: string, now: number,
  mode: ReplyContextMode = "none", gaps = new Set<string>()): SessionInput | undefined {
  if (!isImportedSession(session) || !importLearningOn(writer)) return;
  const stored = writer.setting(project, PREFIX + session);
  if (!stored || stored.length > 16 << 10) return;
  let receipt;
  try { receipt = Receipt.parse(JSON.parse(stored)); } catch { return; }
  if (receipt.checkout !== checkout || importSession(receipt.file) !== session || receipt.mode !== sessionRunner(writer)?.mode) return;
  const options = { checkout, project, window: receipt.window, store: writer, home: writer.location.home, now };
  const parsed = readSessionImport(receipt.file, options, gaps);
  if (!parsed?.messages.length) return;
  const agent = receipt.file.agent === "claude" ? "claude-code" : "codex";
  const messages = parsed.messages.map((source, index): Message => {
    const row = importedRow(session, index);
    return { row, id: "m" + row, session, at: source.at, text: Array.from(source.text).slice(0, FILTER_LIMITS.characters).join(""),
      marks: "", previous_reply: null, delivered: [] };
  });
  if (mode !== "none" && receipt.file.transcript_digest) {
    const issue = replyContexts(parsed.path, receipt.file.agent, messages, mode,
      { checkout, maxFullReplyBytes: 12_000, includeOptions: true });
    if (issue) gaps.add("Some approved reply context was unavailable.");
    for (const message of messages) if (message.previous_reply && (hasSecret(message.previous_reply)
      || stripHidden(message.previous_reply) !== message.previous_reply || /<\s*\/?\s*private\b/iu.test(message.previous_reply))) {
      message.previous_reply = null;
      message.previous_options = [];
    }
    if (!readSessionImport(receipt.file, options, gaps)) return;
  }
  const timestamps = messages.map(message => message.at).sort();
  const host = { id: parsed.session, path: parsed.path, first: timestamps[0]!, last: timestamps.at(-1)! };
  const input = { messages, notes: [], files: [], delivered_notes: [] };
  assertNoSecrets(input);
  return { session, agent, host, input };
}

export function selectImportedInput(writer: RecordWriter, project: string, checkout: string, session: string, now: number,
  mode: ReplyContextMode, selection: SessionSelection | undefined, gaps: Set<string>): SessionInput | undefined {
  const id = selection?.session ?? session;
  const input = id === session ? importedSessionInput(writer, project, checkout, id, now, mode, gaps) : undefined;
  const retry = selection?.retryRows;
  // A changed or removed file still resolves its one existing retry as a gap.
  if (!input) return retry ? { session: id, input: { messages: [], notes: [], files: [], delivered_notes: [] } } : undefined;
  const after = acknowledged(writer, project, id);
  input.input.messages = input.input.messages.filter(message => message.row > after && (!retry || retry.includes(message.row)));
  return input.input.messages.length || retry ? input : undefined;
}
