import { z } from "zod";
import type { RecordWriter } from "../record/index.js";
import type { JobRow } from "../record/jobs.js";
import { shortHash } from "../record/project.js";
import { position, samePosition, type Position } from "../judge/evidence.js";
import { producer } from "../knowledge/producers.js";
import { sessionLearningOn } from "../knowledge/session-learning.js";
import { localSettings } from "../knowledge/state.js";
import { runModel } from "../model-runner/index.js";
import { acknowledged, ackKey, advanceConsumed, FILTER_LIMITS, filterAllowed, stageOneInput, statementsOn, type FilterParams, type ScanWindow } from "./input.js";
import { stageContinuity } from "./continuity.js";
import { parseStageOne, repeatsDeliveredNote, StageOneVerdict, stageOnePrompt, verbatimNote, VerdictCoverage } from "./verdicts.js";
import { planSessionNotes, saveSessionNotes } from "./session-notes.js";
import type { ReplyContextMode, TranscriptIssue } from "./transcript.js";

const ROWS = z.array(z.number().int().positive().safe()).max(FILTER_LIMITS.messages);
const Batch = z.object({
  version: z.literal(1), session: z.string().min(1).max(512),
  position: z.object({ branch: z.string().max(1024).nullable(), head: z.string().regex(/^[a-f0-9]{40,64}$/u).nullable() }).strict(),
  rows: ROWS.nonempty(), skipped: ROWS, retry: ROWS, unresolved: ROWS,
  verdicts: z.array(StageOneVerdict).max(FILTER_LIMITS.messages),
  delivered: z.array(z.string().max(512)).max(128),
  settled: ROWS.optional(),
  attempts: z.array(z.object({ model: z.string().min(1).max(128).nullable(), coverage: VerdictCoverage }).strict()).min(1).max(2),
}).strict().refine(value => {
  const recorded = [...value.skipped, ...value.retry, ...value.unresolved, ...value.verdicts.map(verdict => Number(verdict.id.slice(1)))];
  return value.rows.every((row, index) => index === 0 || row > value.rows[index - 1]!)
    && recorded.length === value.rows.length && new Set(recorded).size === value.rows.length
    && value.rows.every(row => recorded.includes(row)) && (!value.retry.length || value.attempts.length === 1)
    && new Set(value.settled).size === (value.settled?.length ?? 0) && (value.settled ?? []).every(row => value.rows.includes(row));
});
type Batch = z.infer<typeof Batch>;
export interface StageOneBatch { key: string; value: string; batch: Batch; }
const BATCH_BYTES = 768 << 10;
const STORE_BYTES = 8 << 20;
const BATCH_LIMIT = 128;
export const STAGE_ONE_WAIT = "Waiting: local session verdicts need consolidation";
const batchKey = (checkout: string, first: number) => "stage-one.batch." + shortHash(checkout) + "." + first;
const retryKey = (checkout: string) => "stage-one.retry." + shortHash(checkout);
const reviewKey = (key: string) => key.replace(/^stage-one\.batch\./u, "stage-one.reviewed.");

function parseBatch(key: string, raw: string): Batch {
  try {
    const batch = Batch.parse(JSON.parse(raw));
    if (batch.rows[0] === Number(key.split(".").at(-1))) return batch;
  } catch { /* Treat an invalid record as local state, never evidence. */ }
  throw new Error("A local session verdict batch is invalid; it was kept private.");
}

export function stageOneBatches(writer: RecordWriter, project: string, checkout: string, history = false): StageOneBatch[] {
  const prefix = "stage-one." + (history ? "reviewed." : "batch.") + shortHash(checkout) + ".";
  return localSettings(writer, project, prefix, BATCH_BYTES)
    .map(row => ({ ...row, batch: parseBatch(row.key, row.value) }))
    .sort((a, b) => a.batch.rows[0] - b.batch.rows[0]);
}

export function stageOneBatchNeedsDecision({ batch }: StageOneBatch): boolean {
  return batch.verdicts.some(verdict => verdict.verdict === "candidate" || verdict.verdict === "unsure");
}

/** Complete a verdict batch under the writer's transaction. Keep a bounded replay archive. */
export function settleStageOne(writer: RecordWriter, project: string, snapshots: readonly StageOneBatch[], settled: ReadonlySet<number>) {
  const put = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
  const remove = writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?");
  let archived = false;
  for (const { key, value, batch } of snapshots) {
    const rows = batch.verdicts.filter(v => v.verdict === "candidate" || v.verdict === "unsure").map(v => Number(v.id.slice(1)));
    const next = new Set(batch.settled);
    for (const row of rows) if (settled.has(row)) next.add(row);
    if (batch.retry.length || (next.size === (batch.settled?.length ?? 0) && !rows.every(row => next.has(row)))) continue;
    if (writer.setting(project, key) !== value) throw new Error("Session verdicts changed during consolidation.");
    if (rows.every(row => next.has(row))) {
      put.run(project, reviewKey(key), JSON.stringify({ ...batch, settled: undefined }));
      remove.run(project, key);
      archived = true;
    } else put.run(project, key, JSON.stringify({ ...batch, settled: [...next] }));
  }
  if (!archived) return;
  let bytes = 0, kept = 0;
  const reviewed = "stage-one.reviewed.";
  const rows = writer.db.prepare("SELECT key,length(CAST(value AS BLOB)) bytes FROM settings WHERE scope=? AND key LIKE ? ORDER BY CAST(substr(key,?) AS INTEGER) DESC")
    .all(project, reviewed + "%", reviewed.length + shortHash("").length + 2);
  for (const row of rows) {
    bytes += Number(row.bytes);
    if (++kept > BATCH_LIMIT || bytes > STORE_BYTES) remove.run(project, row.key!);
  }
}

export function stageOneEnabled(writer: RecordWriter): boolean {
  return producer("session-ongoing").active && sessionLearningOn(writer);
}

export function readStageOneBatch(writer: RecordWriter, project: string, checkout: string, first: number): Batch | undefined {
  const key = batchKey(checkout, first);
  const read = writer.db.prepare("SELECT CASE WHEN length(CAST(value AS BLOB))<=? THEN value END value FROM settings WHERE scope=? AND key=?");
  const row = read.get(BATCH_BYTES, project, key) ?? read.get(BATCH_BYTES, project, reviewKey(key));
  if (!row) return;
  return parseBatch(key, String(row.value));
}

function pendingBatch(writer: RecordWriter, project: string, checkout: string): Batch | undefined {
  const value = writer.setting(project, retryKey(checkout));
  if (value === undefined) return;
  const first = Number(value);
  const batch = Number.isSafeInteger(first) && first > 0 ? readStageOneBatch(writer, project, checkout, first) : undefined;
  if (!batch?.retry.length) throw new Error("A pending session verdict retry could not be read.");
  return batch;
}

export function stageOneRoom(writer: RecordWriter, project: string): boolean {
  const current = writer.db.prepare("SELECT count(*) n,coalesce(sum(length(CAST(value AS BLOB))),0) bytes FROM settings WHERE scope=? AND key LIKE 'stage-one.batch.%'")
    .get(project)!;
  const pending = writer.db.prepare("SELECT count(*) n FROM settings WHERE scope=? AND key LIKE 'stage-one.retry.%'").get(project)!;
  // A retry may add evidence to its original batch even when another checkout fills the store.
  return Number(current.n) < BATCH_LIMIT && Number(current.bytes) + Number(pending.n) * BATCH_BYTES <= STORE_BYTES - BATCH_BYTES;
}

export function ownedFilterWrite(writer: RecordWriter, job: JobRow, commit: () => void): void {
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    const owned = writer.db.prepare("SELECT 1 FROM jobs WHERE id=? AND owner=? AND state='running' AND request IS NULL").get(job.id, job.owner);
    if (!owned) throw new Error("Filter job ownership changed; session verdicts discarded.");
    commit();
    writer.db.exec("COMMIT");
  } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
}

function saveBatch(writer: RecordWriter, project: string, checkout: string, job: JobRow, batch: Batch, commit: () => void): void {
  const data = JSON.stringify(Batch.parse(batch));
  if (Buffer.byteLength(data) > BATCH_BYTES) throw new Error("The session verdict batch exceeds its result limit.");
  ownedFilterWrite(writer, job, () => {
    const put = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
    put.run(project, batchKey(checkout, batch.rows[0]), data);
    if (batch.retry.length) put.run(project, retryKey(checkout), String(batch.rows[0]));
    else {
      writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project, retryKey(checkout));
      const last = batch.rows.at(-1)!;
      put.run(project, ackKey(batch.session), String(Math.max(last, acknowledged(writer, project, batch.session))));
      advanceConsumed(writer, project);
    }
    commit();
  });
}

interface StageOneResult {
  summary: string; after: number; results?: number; tokens?: number; wait?: string; gaps?: boolean; contextIssues?: TranscriptIssue[];
}

export async function runStageOne(writer: RecordWriter, project: string, params: FilterParams, job: JobRow, at: Position, after: number,
  deps: { model: typeof runModel; clock: () => number; contextMode?: ReplyContextMode; enabled: () => boolean }): Promise<StageOneResult | undefined> {
  const { checkout } = params;
  const allowed = () => deps.enabled() && statementsOn(writer) && filterAllowed(writer, project, params);
  if (!allowed()) return;
  const pending = pendingBatch(writer, project, checkout);
  const retry = pending && { session: pending.session, retryRows: pending.retry };
  const scan: ScanWindow = { after };
  const mode = deps.contextMode ?? "design";
  const selected = stageOneInput(writer, project, checkout, scan, mode, retry);
  if (!selected) {
    if (scan.more) return { after: scan.through!, summary: "Scanning for finished sessions; active sessions remain unread" };
    const changes = await planSessionNotes(writer, project, checkout, deps.clock());
    if (!changes.size || !samePosition(at, await position(checkout)) || !allowed()) return;
    ownedFilterWrite(writer, job, () => {
      if (!allowed()) throw new Error("Session note consent changed.");
      saveSessionNotes(writer, changes);
    });
    return { after, summary: "Updated lifetimes for " + changes.size + " private session notes" };
  }
  if (!pending && !stageOneRoom(writer, project)) return { after, summary: STAGE_ONE_WAIT, wait: STAGE_ONE_WAIT };
  const { input, session } = selected;
  if (!allowed()) return;
  const prompt = input.messages.some(message => !message.marks) ? stageOnePrompt(input) : undefined;
  if (prompt && Buffer.byteLength(prompt) > FILTER_LIMITS.promptBytes) throw new Error("The session verdict prompt exceeds its limit.");
  const response = prompt ? await deps.model({ agent: params.agent, role: "cheap", projectRoot: checkout, purpose: "filter", prompt,
    automatic: { estimate: { input: Buffer.byteLength(prompt), cache_read: 0, cache_write: 0, output: 8192 } } }) : undefined;
  const parsed = parseStageOne(response?.text ?? '{"verdicts":[]}', input);
  const discarded = { after, summary: "Session verdicts discarded because the inputs or consent changed" };
  if (!allowed()) return discarded;
  const notes = parsed.verdicts.filter(verdict => verdict.verdict === "candidate")
    .filter(verdict => !repeatsDeliveredNote(verdict.quote.text, input.delivered_notes));
  const now = deps.clock();
  const changes = await planSessionNotes(writer, project, checkout, now, { session, sourcePosition: selected.sourcePosition, verdicts: notes });
  if (!samePosition(at, await position(checkout)) || !allowed()
    || JSON.stringify(stageOneInput(writer, project, checkout, { after }, mode, retry ?? { session })) !== JSON.stringify(selected))
    return discarded;

  const verdicts = [...(pending?.verdicts ?? []), ...parsed.verdicts].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const resolved = new Set(parsed.verdicts.map(verdict => verdict.id));
  const unresolved = pending?.retry.filter(row => !resolved.has("m" + row)) ?? [];
  const batch: Batch = {
    version: 1, position: pending?.position ?? at, session,
    rows: pending?.rows ?? input.messages.map(message => message.row) as Batch["rows"],
    skipped: pending?.skipped ?? input.messages.filter(message => !!message.marks).map(message => message.row),
    retry: pending ? [] : parsed.missing, unresolved, verdicts, delivered: pending?.delivered ?? input.delivered_notes.map(note => note.id),
    attempts: [...(pending?.attempts ?? []), { model: response?.selectedModel ?? null,
      coverage: { ...parsed.coverage, missing: pending ? unresolved.length : parsed.coverage.missing } }],
  };
  const messages = new Map(input.messages.map(message => [message.id, message]));
  const continuations = parsed.verdicts.flatMap(verdict => {
    if (verdict.verdict !== "next-session") return [];
    const message = messages.get(verdict.id)!;
    return [{ label: "next-session" as const, text: verdict.quote.text,
      source: { session, row: message.row, at: message.at, marks: message.marks, delivered: message.delivered } }];
  });
  let carried = 0;
  saveBatch(writer, project, checkout, job, batch, () => {
    if (!allowed()) throw new Error("Session verdicts discarded because consent changed.");
    saveSessionNotes(writer, changes);
    if (continuations.length && samePosition(batch.position, at))
      carried = stageContinuity(writer, project, checkout, at, continuations, now).size;
    if (!batch.retry.length && !batch.verdicts.some(v => v.verdict === "candidate" || v.verdict === "unsure")) {
      const key = batchKey(checkout, batch.rows[0]);
      settleStageOne(writer, project, [{ key, value: writer.setting(project, key)!, batch }], new Set());
    }
  });
  const noteCandidates = notes.filter(verdict => verbatimNote(verdict)).length;
  const tokens = response?.usage;
  const coverage = batch.attempts.at(-1)!.coverage;
  return { after, results: parsed.verdicts.length, tokens: tokens && tokens.input + tokens.output + tokens.cache_write + tokens.cache_read,
    gaps: unresolved.length > 0, contextIssues: scan.contextIssues,
    summary: [
      "Session verdicts batch " + (job.batch + 1) + " saved " + parsed.verdicts.length,
      noteCandidates + " verbatim note candidates",
      carried + " continuity items",
      pending ? unresolved.length + " unresolved after retry" : parsed.missing.length + " missing for retry",
      coverage.duplicate + " duplicate IDs, " + coverage.unknown + " unknown IDs, " + coverage.invalid + " invalid rows",
      (scan.messagesWithheld ?? 0) + " messages with context withheld",
    ].join(" · ") };
}
