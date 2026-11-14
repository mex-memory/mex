import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { openRecord, type RecordWriter, type RecordReader } from "../record/index.js";
import { ownUsageStatus, decodeUsageWindows, saveUsageWindow, type UsageWindowObservation } from "../record/own-usage.js";
import { automaticWorkEnabled } from "../controls/index.js";
import { ZERO, warnUsageFailure, type Tokens } from "../record/usage.js";
import { decideAdmission, subtractHeadless, weightedTokens, type BudgetSnapshot, type PlanWindow } from "./budget-policy.js";
import { knownPrice, modelWeights, OWN_REFERENCE, PRICE_PROFILE, REFERENCE_BATCH_UNITS } from "./budget-prices.js";
import { ModelRunError } from "./errors.js";

export type ModelWaitReason = "cap" | "fallback" | "usage-window" | "off" | "queue" | "storage" | "pricing";
const REASONS: Record<ModelWaitReason, string> = {
  cap: "Waiting: MEX's automatic model allowance is used up",
  fallback: "Waiting: the seven automatic batches for unreadable usage are used up",
  "usage-window": "Waiting: the selected agent's usage window needs to reset",
  off: "Waiting: MEX is off here", queue: "Waiting: another MEX model batch is running",
  storage: "Waiting: MEX could not reserve model allowance",
  pricing: "Waiting: the selected model needs a reference-price entry",
};
export class ModelWaitError extends Error {
  constructor(readonly reason: ModelWaitReason) { super(REASONS[reason]); this.name = "ModelWaitError"; }
}
export interface ModelJobContext { jobId: string; batch: number; projectId: string | null; recordHome?: string; }
const context = new AsyncLocalStorage<ModelJobContext>();
export function withModelJob<T>(job: ModelJobContext, work: () => T): T { return context.run(job, work); }
export interface AutomaticModelBatch { estimate: Tokens; }
export interface BatchRequest {
  agent: string; model: string; projectPath: string;
  automatic?: AutomaticModelBatch;
  job?: ModelJobContext;
}
export interface ModelBatchRow {
  id: number; agent: string; requested_model: string; automatic: number;
  state: "queued" | "running" | "done" | "cancelled" | "interrupted";
  owner: string; pid: number; project_id: string | null; job_id: string | null; job_batch: number | null;
  created_at: string; admitted_at: string | null; finished_at: string | null;
  reserved_units: number; charged_units: number; estimated: number; pricing: string; wait_reason: ModelWaitReason | null;
}
interface Usage extends Tokens { model: string; estimated: boolean; byModel?: Usage[]; }
type Source = Pick<RecordReader, "all" | "setting">;
const PARAMETERS = { referenceBatchUnits: REFERENCE_BATCH_UNITS };
const MAX_PENDING = 256;
function read(writer: RecordWriter): Source {
  return { setting: (scope, key) => writer.setting(scope, key), all: <T>(sql: string, ...values: SQLInputValue[]) => writer.db.prepare(sql).all(...values) as T[] };
}
function transaction<T>(writer: RecordWriter, work: () => T): T {
  writer.db.exec("BEGIN IMMEDIATE");
  try { const value = work(); writer.db.exec("COMMIT"); return value; }
  catch (error) { writer.db.exec("ROLLBACK"); throw error; }
}
function sum(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid model allowance total.");
  return value;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function day(at: number): string { return new Date(at).toISOString().slice(0, 10); }
function since(at: number, days: number): string { return day(at - (days - 1) * 86_400_000); }
function row(writer: RecordWriter, id: number): ModelBatchRow | undefined {
  return writer.db.prepare("SELECT * FROM model_batches WHERE id=?").get(id) as unknown as ModelBatchRow | undefined;
}

/** No refresh/repair: callers can read budget projections without touching source logs. */
export function modelBudgetSnapshot(source: Source, now = Date.now()): BudgetSnapshot & { estimated: true; priceProfile: string } {
  const from = since(now, 28), today = day(now), week = since(now, 7);
  const mex = new Map<string, Tokens>();
  for (const item of source.all<Tokens & { day: string; agent: string }>(`SELECT substr(ts,1,10) day,agent,
    sum(input) input,sum(cache_write) cache_write,sum(cache_read) cache_read,sum(output) output
    FROM model_calls WHERE kind='headless' AND ts>=? AND ts<? GROUP BY day,agent`, from, day(now + 86_400_000))) mex.set(`${item.day}:${item.agent}`, item);
  let lastSevenUnits = 0, lastFourWeeksUnits = 0;
  for (const item of source.all<Tokens & { day: string; agent: string }>("SELECT * FROM own_usage WHERE day BETWEEN ? AND ?", from, today)) {
    const weights = Object.hasOwn(OWN_REFERENCE, item.agent) ? OWN_REFERENCE[item.agent] : undefined;
    if (!weights) continue;
    const units = weightedTokens(subtractHeadless(item, mex.get(`${item.day}:${item.agent}`) ?? ZERO), weights);
    lastFourWeeksUnits = sum(lastFourWeeksUnits, units);
    if (item.day >= week) lastSevenUnits = sum(lastSevenUnits, units);
  }
  const ownUsageReadable = ownUsageStatus(source).some(status => Object.hasOwn(OWN_REFERENCE, status.agent)
    && (status.status === "readable" || (status.status === "partial" && (status.usageLines ?? 0) > 0)));
  const totals = source.all<{ spent: number; reserved: number; attempts: number }>(`SELECT
    coalesce(sum(CASE WHEN state='running' THEN 0 ELSE charged_units END),0) spent,
    coalesce(sum(CASE WHEN state='running' THEN reserved_units ELSE 0 END),0) reserved,count(*) attempts
    FROM model_batches WHERE automatic=1 AND admitted_at>=?`, week)[0]!;
  // Future-dated admissions remain charged after a backwards clock adjustment.
  return { lastSevenUnits, lastFourWeeksUnits, ownUsageReadable, spentUnits: totals.spent, reservedUnits: totals.reserved, admittedAttempts: totals.attempts, estimated: true, priceProfile: PRICE_PROFILE };
}
function windows(source: Source, agent: string, now: number): PlanWindow[] {
  return source.all<{ used_percent: number | null; status: PlanWindow["status"]; resets_at: string | null }>(
    "SELECT * FROM usage_windows WHERE agent=? AND observed_at<=?", agent, new Date(now).toISOString())
    .map(item => ({ usedPercent: item.used_percent, status: item.status, resetsAt: item.resets_at }));
}
function eligibility(writer: RecordWriter, entry: ModelBatchRow, snapshot: BudgetSnapshot, now: number) {
  if (!entry.automatic) return { allowed: true, nextReset: undefined as string | undefined };
  if (!Object.hasOwn(OWN_REFERENCE, entry.agent) || !knownPrice(entry.requested_model)) return { allowed: false, reason: "pricing" as ModelWaitReason };
  if (!automaticWorkEnabled(writer, entry.project_id, now)) return { allowed: false, reason: "off" as ModelWaitReason };
  return decideAdmission(snapshot, entry.reserved_units, PARAMETERS, windows(read(writer), entry.agent, now), now);
}

/** Must run in a transaction. Never steals from a live owner on a timed lease. */
function recover(writer: RecordWriter, now: number, isAlive: (pid: number) => boolean): void {
  const entries = writer.db.prepare("SELECT * FROM model_batches WHERE state IN ('queued','running') LIMIT ?").all(MAX_PENDING) as unknown as ModelBatchRow[];
  for (const entry of entries) {
    if (isAlive(entry.pid)) continue;
    if (entry.state === "running") {
      const calls = writer.db.prepare("SELECT * FROM model_calls WHERE batch_id=?").all(entry.id) as unknown as Usage[];
      let charge = entry.reserved_units;
      try { charge = Math.max(charge, usageUnits(calls, entry.requested_model)); } catch { charge = Number.MAX_SAFE_INTEGER; }
      writer.db.prepare("UPDATE model_batches SET state='interrupted',charged_units=?,finished_at=? WHERE id=?")
        .run(charge, new Date(now).toISOString(), entry.id);
    } else writer.db.prepare("UPDATE model_batches SET state='cancelled',finished_at=? WHERE id=?").run(new Date(now).toISOString(), entry.id);
  }
}
export function recoverModelBatches(writer: RecordWriter, now = Date.now(), isAlive = alive): void {
  if (!writer.db.prepare("SELECT 1 FROM model_batches WHERE state IN ('queued','running') LIMIT 1").get()) return;
  transaction(writer, () => recover(writer, now, isAlive));
}

export function enqueueModelBatch(writer: RecordWriter, request: BatchRequest, now = Date.now()): ModelBatchRow {
  const job = request.job ?? context.getStore();
  const projectId = job?.projectId ?? writer.checkout(request.projectPath)?.project_id ?? null;
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(request.agent) || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(request.model)) throw new ModelWaitError("pricing");
  const estimate = request.automatic?.estimate;
  if (request.automatic && !projectId && !job) throw new ModelWaitError("off");
  if (estimate) {
    for (const key of ["input", "cache_write", "cache_read", "output"] as const) if (!Number.isSafeInteger(estimate[key]) || estimate[key] < 0 || estimate[key] > 10_000_000) throw new ModelWaitError("pricing");
  }
  const weights = modelWeights(request.model, estimate ?? ZERO);
  const reserved = estimate ? weightedTokens(estimate, weights) : 0;
  if (request.automatic && reserved === 0) throw new ModelWaitError("pricing");
  return transaction(writer, () => {
    recover(writer, now, alive);
    if (Number(writer.db.prepare("SELECT count(*) n FROM model_batches WHERE state IN ('queued','running')").get()!.n) >= MAX_PENDING) throw new ModelWaitError("queue");
    const owner = `model:${process.pid}:${randomUUID()}`;
    const result = writer.db.prepare(`INSERT INTO model_batches(agent,requested_model,automatic,state,owner,pid,project_id,job_id,job_batch,created_at,reserved_units,pricing)
      VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?)`).run(request.agent, request.model, Number(!!request.automatic), owner, process.pid,
        projectId, job?.jobId ?? null, job?.batch ?? null, new Date(now).toISOString(), reserved,
        JSON.stringify({ profile: PRICE_PROFILE, weights, estimated: true }));
    return row(writer, Number(result.lastInsertRowid))!;
  });
}

export function claimModelBatch(writer: RecordWriter, entry: ModelBatchRow, now = Date.now()): ModelWaitReason | undefined {
  return transaction(writer, () => {
    recover(writer, now, alive);
    const current = row(writer, entry.id);
    if (!current || current.owner !== entry.owner || current.state !== "queued") throw new ModelWaitError("storage");
    if (!current.automatic) {
      if (writer.db.prepare("SELECT 1 FROM model_batches WHERE state='running'").get()) return "queue";
      const first = writer.db.prepare("SELECT id FROM model_batches WHERE state='queued' AND automatic=0 ORDER BY id LIMIT 1").get();
      if (first?.id !== entry.id) return "queue";
      writer.db.prepare("UPDATE model_batches SET state='running',admitted_at=?,wait_reason=NULL WHERE id=?").run(new Date(now).toISOString(), entry.id);
      return undefined;
    }
    const snapshot = modelBudgetSnapshot(read(writer), now);
    const decision = eligibility(writer, current, snapshot, now);
    if (!decision.allowed) return decision.reason!;
    if (writer.db.prepare("SELECT 1 FROM model_batches WHERE state='running'").get()) return "queue";
    if (writer.db.prepare("SELECT 1 FROM model_batches WHERE state='queued' AND automatic=0 LIMIT 1").get()) return "queue";
    const pending = writer.db.prepare("SELECT * FROM model_batches WHERE state='queued' AND automatic=1 ORDER BY id LIMIT ?").all(MAX_PENDING) as unknown as ModelBatchRow[];
    const eligible = pending.map(item => ({ item, decision: eligibility(writer, item, snapshot, now) })).filter(item => item.decision.allowed);
    eligible.sort((a, b) => ((a.decision.nextReset ? Date.parse(a.decision.nextReset) : Infinity)
      - (b.decision.nextReset ? Date.parse(b.decision.nextReset) : Infinity) || a.item.id - b.item.id));
    if (eligible[0]?.item.id !== entry.id) return "queue";
    writer.db.prepare("UPDATE model_batches SET state='running',admitted_at=?,wait_reason=NULL WHERE id=?").run(new Date(now).toISOString(), entry.id);
    return undefined;
  });
}
export function cancelModelBatch(writer: RecordWriter, entry: ModelBatchRow, reason: ModelWaitReason | null = null): void {
  writer.db.prepare("UPDATE model_batches SET state='cancelled',finished_at=?,wait_reason=coalesce(?,wait_reason) WHERE id=? AND owner=? AND state='queued'")
    .run(new Date().toISOString(), reason, entry.id, entry.owner);
}
function usageUnits(calls: readonly Usage[], selectedModel: string): number {
  let charge = 0;
  for (const usage of calls) charge = sum(charge, weightedTokens(usage, modelWeights(usage.model === "unknown" ? selectedModel : usage.model, usage)));
  return charge;
}
export function settleModelBatch(writer: RecordWriter, entry: ModelBatchRow, usage: Usage, recorded = true, observations: readonly UsageWindowObservation[] = []): void {
  let measured: number;
  try { measured = usageUnits(usage.byModel ?? [usage], entry.requested_model); }
  catch { measured = Number.MAX_SAFE_INTEGER; recorded = false; }
  const charge = !recorded || usage.estimated ? Math.max(entry.reserved_units, measured) : measured;
  transaction(writer, () => {
    for (const observation of observations) saveUsageWindow(writer.db, observation);
    const changed = writer.db.prepare("UPDATE model_batches SET state=?,charged_units=?,finished_at=? WHERE id=? AND owner=? AND state='running'")
      .run(recorded ? "done" : "interrupted", charge, new Date().toISOString(), entry.id, entry.owner);
    if (Number(changed.changes) !== 1) throw new ModelWaitError("storage");
  });
}

/** Budget holds do not turn into repeated job failures or consume a new admission. */
export function modelJobReady(writer: RecordWriter, jobId: string, batch: number, reason?: string | null, projectId?: string | null): boolean {
  if (reason === REASONS.off && !automaticWorkEnabled(writer, projectId)) return false;
  const entry = writer.db.prepare("SELECT * FROM model_batches WHERE job_id=? AND job_batch=? ORDER BY id DESC LIMIT 1").get(jobId, batch) as unknown as ModelBatchRow | undefined;
  if (!entry?.wait_reason) return reason !== REASONS.pricing;
  if (entry.wait_reason === "queue" && writer.db.prepare("SELECT 1 FROM model_batches WHERE state='running'").get()) return false;
  if (!entry.automatic) return true;
  return eligibility(writer, entry, modelBudgetSnapshot(read(writer)), Date.now()).allowed;
}
export interface ModelAdmission {
  id: number;
  home: string;
  observe(event: Record<string, unknown>): void;
  finish(usage: Usage, recorded: boolean): void;
  close(): void;
}
/** Bounded process-local wait; durable work/checkpoints remain with the existing jobs table. */
export async function acquireModelAdmission(request: BatchRequest, signal?: AbortSignal, waitMs = 30_000): Promise<ModelAdmission | undefined> {
  if (signal?.aborted) throw new ModelRunError("cancelled", request.agent);
  let writer: RecordWriter;
  try { writer = openRecord({ home: context.getStore()?.recordHome, projectPath: request.projectPath }); }
  catch {
    if (request.automatic) throw new ModelWaitError("storage");
    // Retain the existing explicit-command accounting failure contract.
    warnUsageFailure(); return undefined;
  }
  let entry: ModelBatchRow | undefined, finished = false;
  try {
    entry = enqueueModelBatch(writer, request);
    const deadline = Date.now() + Math.max(1, Math.min(30_000, Number.isFinite(waitMs) ? waitMs : 30_000));
    while (true) {
      if (signal?.aborted) throw new ModelRunError("cancelled", request.agent);
      const reason = claimModelBatch(writer, entry);
      if (!reason) break;
      if (reason !== "queue" || request.automatic || Date.now() >= deadline) {
        cancelModelBatch(writer, entry, reason); throw new ModelWaitError(reason);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const owned = entry;
    const observed = new Map<string, UsageWindowObservation>();
    return {
      id: owned.id,
      home: writer.location.home,
      observe(event) {
        for (const observation of decodeUsageWindows(request.agent, event, new Date().toISOString())) {
          if (observed.size >= 64 && !observed.has(observation.window)) observed.delete(observed.keys().next().value!);
          observed.set(observation.window, observation);
        }
      },
      finish(usage, recorded) { settleModelBatch(writer, owned, usage, recorded, [...observed.values()]); finished = true; },
      close() {
        try {
          if (!finished) {
            // A launch/error path with no complete accounting must retain its reservation.
            writer.db.prepare("UPDATE model_batches SET state='interrupted',charged_units=max(charged_units,reserved_units),finished_at=? WHERE id=? AND owner=? AND state='running'")
              .run(new Date().toISOString(), owned.id, owned.owner);
          }
        } catch { warnUsageFailure(); }
        finally { try { writer.close(); } catch { warnUsageFailure(); } }
      },
    };
  } catch (error) {
    try { if (entry) cancelModelBatch(writer, entry); } catch { /* preserve the safe error */ }
    writer.close();
    if (error instanceof ModelWaitError || error instanceof ModelRunError) throw error;
    throw new ModelWaitError("storage");
  }
}
