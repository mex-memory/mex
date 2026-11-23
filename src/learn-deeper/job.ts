import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { EntryIdSchema, KnowledgeError, parseEntry, serializeEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { propose, summarizeResults, type GateResult, type Proposal } from "../knowledge/gate.js";
import { readNotes, recoverNotes, snapshotNotes } from "../knowledge/personal-store.js";
import { producerEntryId } from "../knowledge/producers.js";
import { claimHash } from "../knowledge/state.js";
import { ModelRunError, ModelWaitError, runModel, type ModelResult } from "../model-runner/index.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import { registerJobKind, type BatchContext, type BatchResult, type JobKind } from "../record/jobs.js";
import type { RecordWriter } from "../record/index.js";
import { refreshOwnUsage } from "../record/own-usage.js";
import { readConflict } from "../review/conflicts.js";
import { ANCHOR_KINDS, githubReviewLines, withVerifiedAnchors, type AnchorKind, type AnchorResult, type CheckContext, type ReadReviewLines } from "./anchors.js";
import { coverageKey, learningProof, makeNoteProof, noteKey, saveSourceReads, SourceRef, sourceRead, sourceRef, type TeamCoverage } from "./coverage.js";
import { filteringPrompt, hasLearningEvidence, prepareEntries, RejectionReason, retryPrompt, selectedSources, ValidationDiagnostics, writingPrompt,
  type EarlierEntry, type PreparedEntry, type WriterModel } from "./entries.js";
import { ForgeClient, hostToken, SourceError } from "./forge.js";
import { clearLearningChecks, origin, PinnedTree, repoPath } from "./git.js";
import { hosts } from "./hosts.js";
import { contextSources } from "./history.js";
import { branchScope, StaleDoc, staleDoc } from "./history-docs.js";
import { DOCS_PER_BATCH, FIRST_BATCH_PROPOSALS, LEARN_KIND, MAX_LEARNED_PROPOSALS, Plan, promptEstimate, PULLS_PER_BATCH, type LearningPlan } from "./plan.js";
import type { Reviewers } from "./reviewers.js";
import { importedSourceKey, importsEnabled, readImport, SESSIONS_PER_BATCH } from "./session-import.js";
import { cleanSourceText, DOC_PRIVACY_REASONS, documentExcerpt, sourceDigest, type LearningSource } from "./source.js";
import { readGitHubWorkflows, saveGitHubWorkflows } from "./workflows.js";
import { queuePatternRecount, quoteRefresh, RefreshDeferred, weeklySources } from "./weekly.js";
import { clearRunRows, initialState, PipelineState, runPipelineBatch } from "./pipeline.js";
import type { HarvestPlan } from "./harvest/types.js";
import { DAY_MS, nextWeeklyAt, publishWeeklyWake, saveWeeklySchedule, scheduleFromPlan, sessionsActive, WEEKLY_KIND, WeeklySchedule, weeklySchedule } from "./weekly-schedule.js";

const modelName = z.string().regex(/^[A-Za-z\d][A-Za-z\d./_:@+-]{0,127}$/u);
const writerSchema = z.object({ id: modelName, version: modelName, labels: z.array(z.string().min(1).max(80)).max(32) }).strict();
const checkpointSchema = z.object({
  pull: z.number().int().nonnegative(), doc: z.number().int().nonnegative(), gaps: z.array(z.string().max(180)).max(24),
  session: z.number().int().nonnegative().optional(),
  retryAt: z.number().optional(), recovered: z.number().int().nonnegative().optional(),
  weeklyPlan: Plan.optional(),
  rejected: z.record(RejectionReason, z.number().int().positive()).optional(),
  staleDocs: z.number().int().positive().optional(),
  writers: z.array(writerSchema).max(16).optional(),
  /** Learn deeper v2's phase state. */
  v2: PipelineState.optional(),
}).strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
type Context = BatchContext<unknown, Checkpoint>;
const docPrivacy = z.object({ path: z.string().refine(repoPath), status: z.enum(["excerpt", "skipped"]), reason: z.enum(DOC_PRIVACY_REASONS) }).strict();
const batchDiagnostics = z.object({
  reviewSources: z.number().int().nonnegative(), verifiedReviewSources: z.number().int().nonnegative(),
  verifiedPulls: z.number().int().nonnegative(), docs: z.number().int().nonnegative(), sessions: z.number().int().nonnegative(),
  skip: z.enum(["no-sources", "insufficient-review-evidence", "changed-after-shortlist", "insufficient-shortlist"]).optional(),
  validation: ValidationDiagnostics.optional(),
  staleDocs: z.array(StaleDoc).max(DOCS_PER_BATCH).optional(),
  docPrivacy: z.array(docPrivacy).max(DOCS_PER_BATCH).optional(),
  anchors: z.array(z.object({ id: EntryIdSchema, kinds: z.array(z.enum(ANCHOR_KINDS)).min(1).max(ANCHOR_KINDS.length) }).strict())
    .max(MAX_LEARNED_PROPOSALS).optional(),
  unreadRules: z.array(z.string().refine(repoPath)).max(8).optional(),
  retry: ValidationDiagnostics.optional(),
}).strict();
type BatchDiagnostics = z.infer<typeof batchDiagnostics>;
const receiptSchema = z.object({
  checkpoint: checkpointSchema, count: z.number().int().nonnegative().max(32), spent: z.number().int().nonnegative(), done: z.boolean(),
  sources: z.array(SourceRef).max(48), diagnostics: batchDiagnostics.optional(),
  gateSummary: z.string().max(1024).optional(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
const Shortlist = z.object({
  input: z.string().regex(/^sha256:[a-f0-9]{64}$/u), ids: z.array(z.string().max(360)).max(32), invalid: z.boolean(),
}).strict();

interface Dependencies {
  model: typeof runModel;
  client: (plan: Pick<LearningPlan, "checkout" | "origin">) => Promise<ForgeClient>;
  now: () => number;
  next: (now: number) => number;
}
const defaults: Dependencies = {
  model: runModel,
  client: async plan => new ForgeClient(plan.origin, await hostToken(plan.checkout, plan.origin)),
  now: Date.now,
  next: nextWeeklyAt,
};

function checkpoint(job: { checkpoint: string | null }, gaps: string[] = []): Checkpoint {
  return job.checkpoint === null ? { pull: 0, doc: 0, gaps } : checkpointSchema.parse(JSON.parse(job.checkpoint));
}

function batchKey(job: { id: string; batch: number }): string { return `learning.deep.batch.${job.id}.${job.batch}`; }

function learningOn(writer: RecordWriter, project: string, plan: Pick<LearningPlan, "checkout">, now = Date.now()): boolean {
  const checkout = writer.checkout(plan.checkout);
  return checkout?.project_id === project && checkout.path === plan.checkout && checkoutOn(checkout, now)
    && automaticWorkEnabled(writer, project, now);
}

function result(context: Context, plan: LearningPlan, saved: Receipt): BatchResult<Checkpoint> {
  const { checkpoint, count, spent, done } = saved;
  const total = plan.sessions.length;
  const summary = [...checkpoint.gaps];
  if (checkpoint.recovered) summary.push("Resumed from the last finished batch.");
  if (checkpoint.rejected) {
    const reasons = RejectionReason.options.flatMap(reason => checkpoint.rejected?.[reason] ? [`${checkpoint.rejected[reason]} ${reason}`] : []);
    if (reasons.length) summary.push(`Rejected proposals (${reasons.join(", ")}).`);
  }
  if (checkpoint.staleDocs) summary.push(`Skipped ${checkpoint.staleDocs} historically scoped ${checkpoint.staleDocs === 1 ? "doc" : "docs"}.`);
  if (saved.gateSummary) summary.push(`Producer gate · ${saved.gateSummary}.`);
  if (saved.diagnostics?.anchors?.length) {
    const counts = ANCHOR_KINDS.flatMap(kind => {
      const count = saved.diagnostics!.anchors!.filter(item => item.kinds.includes(kind)).length;
      return count ? [`${count} ${kind}`] : [];
    });
    summary.push(`Verified anchors (${counts.join(", ")}).`);
  }
  if (saved.diagnostics?.retry) summary.push(`Writer retry · ${saved.diagnostics.retry.proposed} resubmitted.`);
  for (const { id, version, labels } of checkpoint.writers ?? []) {
    summary.push(`Writer model ${id} (${version})${labels.length ? ` · ${labels.join(", ")}` : ""}.`);
  }
  return {
    checkpoint, results: count, tokens: Math.max(0, spent - context.job.tokens_used), done,
    gaps: done && checkpoint.gaps.length > 0,
    summary: summary.join(" "),
    progress: `${checkpoint.pull} of ${plan.pulls.length} merged changes and ${checkpoint.doc} of ${plan.docs.length} docs read`
      + (total ? ` · ${checkpoint.session ?? 0} of ${total} past sessions checked` : ""),
  };
}

type RetryResult = { entries: PreparedEntry[]; validation: ValidationDiagnostics; model: WriterModel };
export interface FailedEntry { entry: PreparedEntry; reason: string; detail?: string }
type Retry = (failed: readonly FailedEntry[]) => Promise<RetryResult | undefined>;
interface PublishOptions {
  tree?: PinnedTree; readReview?: ReadReviewLines; team?: TeamCoverage; schedule?: WeeklySchedule; model?: WriterModel; retry?: Retry;
}
interface Round { receipt: Receipt; gated?: GateResult[]; failed?: FailedEntry[]; partial?: string }
const RETRY_REASONS = new Set(["check-fails", "quote-not-found"]);
const retryKey = (job: { id: string; batch: number }) => `learning.deep.retry.${job.id}.${job.batch}`;
const addGap = (state: Checkpoint, gap: string) => { state.gaps = [...new Set([...state.gaps, gap])].slice(0, 24); };

/** How strongly an anchor makes delivery fire: a `when:` literal, then code, then a command, then repo-wide. */
function anchorStrength(kinds: readonly AnchorKind[]): number {
  return Math.max(0, ...kinds.map(kind => kind === "when" ? 3 : kind === "symbol" || kind === "code-scope" ? 2 : kind === "command" ? 1 : 0));
}
function storedKinds(entry: KnowledgeEntry): AnchorKind[] {
  const kinds: AnchorKind[] = [];
  if (entry.mex.scope.some(glob => !/^(?:\*\*\/)*\*\*$/u.test(glob))) kinds.push("code-scope");
  if (entry.mex.checks.some(check => check.kind === "symbol")) kinds.push("symbol");
  if (entry.mex.checks.some(check => check.kind === "command")) kinds.push("command");
  if (entry.mex.when?.length) kinds.push("when");
  return kinds.length ? kinds : ["repo-wide"];
}
function unionSources(earlier: readonly SourceRef[], later: readonly SourceRef[]): SourceRef[] {
  return [...new Map([...earlier, ...later].map(source => [source.id, source])).values()].slice(0, 8);
}
const laterDay = (a: string | undefined, b: string) => a && a > b ? a : b;

/**
 * Save one batch through the producer gate. When the gate drops entries because a check failed or a quote
 * wasn't found, the first round stores a partial receipt and the writer gets one retry for those entries.
 */
async function publish(context: Context, plan: LearningPlan, key: string, entries: PreparedEntry[], draft: Omit<Receipt, "count">,
  options: PublishOptions = {}): Promise<Receipt> {
  const first = await gateRound(context, plan, key, entries, draft, options);
  if (!first.failed) return first.receipt;
  let retried: RetryResult | undefined;
  try { retried = await options.retry!(first.failed); }
  catch { addGap(first.receipt.checkpoint, "The writer retry could not run; the first answer was kept."); }
  const base = { ...first.receipt, spent: recordedModelSpend(context.writer, context.job.id), diagnostics: first.receipt.diagnostics && retried
    ? { ...first.receipt.diagnostics, retry: retried.validation } : first.receipt.diagnostics };
  return (await gateRound(context, plan, key, retried?.entries ?? [], base,
    { ...options, model: retried?.model ?? options.model, retry: undefined }, first)).receipt;
}

/** Finish a batch whose first round was saved before an interruption, without another model call. */
async function finishPartial(context: Context, plan: LearningPlan, key: string, partial: string): Promise<Receipt> {
  const receipt = receiptSchema.parse(JSON.parse(partial));
  return (await gateRound(context, plan, key, [], receipt, {}, { receipt, partial })).receipt;
}

async function gateRound(context: Context, plan: LearningPlan, key: string, entries: PreparedEntry[], draft: Omit<Receipt, "count">,
  options: PublishOptions, previous?: Round): Promise<Round> {
  const { writer, job } = context, project = job.project_id!;
  const { team, schedule } = options;
  const state = draft.checkpoint;
  const complete = async (anchored: AnchorResult[], checked: CheckContext, unreadRules: readonly string[]): Promise<Round> => {
    if (unreadRules.length) {
      // The gate compares against the rule files it can read, as it does in a checkout. Say which it couldn't.
      addGap(state, "Some rule files could not be read, so duplicate checks skipped them.");
      if (draft.diagnostics) draft.diagnostics.unreadRules = unreadRules.filter(repoPath).slice(0, 8);
    }
    const validations = previous ? draft.diagnostics?.retry : draft.diagnostics?.validation;
    const candidates: Proposal[] = [];
    const pending = new Map<string, PreparedEntry>();
    const kinds = new Map<string, AnchorKind[]>();
    const excluded: GateResult[] = [];
    const kept = new Map<string, PreparedEntry>();
    const earlierSources = new Map<string, SourceRef[]>();
    const notes = snapshotNotes(writer, project).files;
    const ownedActive = (id: string) => {
      const raw = notes.get(id);
      const proof = raw ? learningProof(plan, raw, writer.setting(project, noteKey(id))) : undefined;
      const entry = raw && proof ? parseEntry(raw) : undefined;
      return entry && proof && entry.mex.status === "active" ? { entry, proof } : undefined;
    };
    for (const [i, result] of anchored.entries()) {
      const entry = entries[i]!;
      if (typeof result === "string") {
        validations?.rejected.push({ index: entry.index, reason: result });
        continue;
      }
      const id = producerEntryId("learn-deeper", result.key);
      const claim = claimHash(result.text);
      if (team?.retired.has(claim)) { excluded.push({ status: "dropped", reason: "forgotten" }); continue; }
      if (pending.has(id) || kept.has(id) || team?.claimed.has(claim)) { excluded.push({ status: "dropped", reason: "duplicate-entry" }); continue; }
      // The same claim from a later batch never weakens an owned active entry's anchor.
      const owned = ownedActive(id);
      if (owned && anchorStrength(result.anchorKinds) <= anchorStrength(storedKinds(owned.entry))) { kept.set(id, entry); continue; }
      if (owned) earlierSources.set(id, owned.proof.sources);
      if (result.replaces) {
        // A replacement target that changed since the writer saw it drops only this proposal.
        const target = ownedActive(result.replaces);
        if (!target || (target.proof.evidenceDay ?? target.entry.mex.created) >= entry.evidenceDay) {
          excluded.push({ status: "dropped", reason: "invalid", detail: "The replacement target changed before saving." });
          continue;
        }
      }
      candidates.push(result);
      pending.set(id, entry);
      kinds.set(id, result.anchorKinds);
    }
    validations?.rejected.sort((a, b) => a.index - b.index);
    const imported = draft.sources.filter(source => source.id.startsWith("session:"));
    const swept = new Set<string>();
    let round: Round | undefined;

    await propose(candidates, {
      projectPath: plan.checkout, home: writer.location.home, ...checked,
      ...(team?.retired.size ? { sweep: { producer: "learn-deeper" as const,
        includes: (entry: KnowledgeEntry) => {
          const retired = team.retired.has(claimHash(entry.text));
          if (retired) swept.add(entry.mex.id);
          return retired;
        },
        tombstone: { reason: "The matching rule was retired on the default branch.", by: "mex learn" },
      } } : {}),
      validate(gate) {
        const live = gate.db.prepare("SELECT owner,state FROM jobs WHERE id=?").get(job.id);
        const partial = gate.setting(project, retryKey(job));
        if (live?.owner !== job.owner || live?.state !== "running" || !learningOn(gate, project, plan) || gate.setting(project, key)
          || partial !== previous?.partial) {
          throw new Error("Learning lost its job or project registration before saving.");
        }
        if (imported.length && !importsEnabled(gate, project)) throw new Error("Past-session capture was turned off before saving.");
      },
      onAccepted(gate, accepted, results) {
        const unchanged = [...kept.keys()].map((entryId): GateResult => ({ status: "accepted", entryId, change: "unchanged" }));
        const gated = [...excluded, ...results, ...unchanged];
        const rejected = { ...state.rejected };
        for (const { reason } of validations?.rejected ?? []) rejected[reason] = (rejected[reason] ?? 0) + 1;
        if (Object.keys(rejected).length) state.rejected = rejected;
        // Model rejections and gate drops are counted in the summary. Only an unreadable answer is a gap.
        if (validations && validations.response !== "valid") addGap(state, "A model batch returned no readable entries.");
        const labels = accepted.flatMap(item => item.entry.mex.source.label ? [item.entry.mex.source.label] : []);
        if (draft.diagnostics && accepted.length) {
          draft.diagnostics.anchors = [...(draft.diagnostics.anchors ?? []),
            ...accepted.map(item => ({ id: item.entryId, kinds: kinds.get(item.entryId)! }))].slice(0, MAX_LEARNED_PROPOSALS);
        }
        if (options.model) {
          const { id, version } = options.model;
          const same = state.writers?.find(model => model.id === id && model.version === version);
          state.writers = [...(state.writers ?? []).filter(model => model !== same), {
            id, version, labels: [...new Set([...(same?.labels ?? []), ...labels])].slice(0, 32),
          }].slice(-16);
        }
        const failed = previous || !options.retry ? [] : results.flatMap((item, i) => item.status === "dropped" && RETRY_REASONS.has(item.reason)
          ? [{ entry: pending.get(producerEntryId("learn-deeper", candidates[i]!.key))!, reason: item.reason, detail: item.detail }] : []);
        const all = previous?.gated ? [...previous.gated, ...gated] : gated;
        const saved: Receipt = { ...draft, count: Math.min(32, (previous?.receipt.count ?? 0) + accepted.length + kept.size),
          ...(previous && !previous.gated && !gated.length ? {}
            : validations || all.length ? { gateSummary: summarizeResults(all) } : {}),
        };
        const set = gate.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
        const remove = gate.db.prepare("DELETE FROM settings WHERE scope=? AND key=?");
        const saveProof = (entry: KnowledgeEntry, source: PreparedEntry, earlier: readonly SourceRef[] = [], day?: string) =>
          set.run(project, noteKey(entry.mex.id), makeNoteProof(plan, serializeEntry(entry), unionSources(earlier, source.sources),
            laterDay(day, source.evidenceDay)));
        for (const { entry, entryId } of accepted) {
          const source = pending.get(entryId)!;
          saveProof(entry, source, earlierSources.get(entryId));
          if (source.proposal.replaces) remove.run(project, noteKey(source.proposal.replaces));
        }
        // A kept entry stays as it is; its proof gains the later batch's sources.
        const current = kept.size ? readNotes(gate.location.home, project).files : new Map<string, string>();
        for (const [id, source] of kept) {
          const raw = current.get(id);
          const proof = raw && learningProof(plan, raw, gate.setting(project, noteKey(id)));
          if (raw && proof) set.run(project, noteKey(id), makeNoteProof(plan, raw, unionSources(proof.sources, source.sources),
            laterDay(proof.evidenceDay, source.evidenceDay)));
        }
        for (const id of swept) remove.run(project, noteKey(id));
        // If a review is later approved unchanged, its body-free receipt is
        // already here. Never overwrite the proof for a still-active note.
        for (const item of results) if (item.status === "review") {
          const conflict = readConflict(gate, project, item.reviewId);
          if (conflict && !gate.setting(project, noteKey(conflict.entry.mex.id))) {
            saveProof(conflict.entry, pending.get(conflict.entry.mex.id)!);
          }
        }
        if (failed.length) {
          const partial = JSON.stringify(saved);
          gate.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(project, retryKey(job), partial);
          round = { receipt: saved, gated: all, failed, partial };
        } else {
          gate.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(project, key, JSON.stringify(saved));
          if (previous) remove.run(project, retryKey(job));
          round = { receipt: saved };
        }
        if (!previous) {
          for (const source of imported) set.run(project, importedSourceKey(source.id), source.hash);
          saveSourceReads(gate, project, plan, draft.sources);
          remove.run(project, `learning.deep.shortlist.${job.id}.${job.batch}`);
          if (schedule) saveWeeklySchedule(gate, project, schedule);
        }
      },
    });
    if (schedule && !previous) publishWeeklyWake(writer);
    if (!round) throw new Error("The producer gate did not record the finished learning batch.");
    return round;
  };
  if (!entries.length) return complete([], {}, []);
  let staged = false;
  try {
    return await withVerifiedAnchors(entries, options.tree!, writer.location.home, job.id, options.readReview, (anchored, checked, unread) => {
      staged = true;
      return complete(anchored, checked, unread);
    });
  } catch (error) {
    // The model call is already paid for. A staging failure finishes the batch with a gap instead of a redo.
    if (staged) throw error;
    addGap(state, "The pinned files for checking could not be staged.");
    return complete(entries.map(() => "check-verification" as const), {}, []);
  }
}

/** The job row's summary for a v2 run: every stage's counts, in plain words. */
function pipelineSummary(state: PipelineState, gaps: readonly string[]): string {
  const c = state.counts, n = (name: string) => c[name] ?? 0;
  const harvested = Object.entries(c).filter(([name]) => name.startsWith("harvested.")).reduce((sum, [, v]) => sum + v, 0);
  const dropped = Object.entries(c).filter(([name]) => name.startsWith("triage-dropped.")).reduce((sum, [, v]) => sum + v, 0);
  const parts = [`Read ${harvested} sources; kept ${n("triage-kept")} after sorting (${dropped} dropped).`];
  if (state.phase === "write" || state.phase === "finish") {
    parts.push(`Lessons: ${n("cluster.write")} corroborated, ${n("cluster.propose")} single strong, ${n("cluster.drop")} dropped.`);
    parts.push(`Saved ${n("saved")} rules: ${n("proven")} with a proven pattern, ${n("prose")} as scoped text, ${n("proposed")} waiting for your tick.`);
  }
  for (const [key, one, many] of [
    ["trial.issues", "issue source kept", "issue sources kept"], ["trial.linter", "linter suggestion saved", "linter suggestions saved"],
    ["trial.alternatives", "alternative stored", "alternatives stored"], ["trial.procedures", "procedure waiting for a tick", "procedures waiting for a tick"],
    ["trial.pr.followed", "PR description with a Decisions section", "PR descriptions with a Decisions section"],
    ["trial.pr.ignored", "PR description without a Decisions section", "PR descriptions without a Decisions section"],
  ] as const) {
    const total = c[key];
    if (total !== undefined) parts.push(`Counted ${total} ${total === 1 ? one : many}.`);
  }
  return [...parts, ...gaps].join(" ");
}

function waitOn(error: unknown, state: Checkpoint, now: number): BatchResult<Checkpoint> | undefined {
  if (error instanceof SourceError && error.problem !== "unavailable") {
    return { checkpoint: { ...state, retryAt: error.retryAt ?? now + (error.problem === "login" ? 60_000 : 30_000) }, wait: error.message };
  }
  if (error instanceof ModelRunError && (error.category === "authentication" || error.category === "usage_limit")) {
    const reset = error.resetTime ? Date.parse(error.resetTime) : NaN;
    return { checkpoint: { ...state, retryAt: Number.isFinite(reset) && reset > now ? reset : now + 60_000 }, wait: error.message };
  }
  return undefined;
}

class AgentActive extends Error {}

function waitForIdle(state: Checkpoint, now: number): BatchResult<Checkpoint> {
  return { checkpoint: { ...state, retryAt: now + 60_000 }, wait: "Waiting for agent sessions to go idle" };
}

/** The model that did most of the work; never the alias that was requested. */
export function writerModel(response: Pick<ModelResult, "selectedModel" | "usage">): WriterModel {
  const id = modelName.parse(response.selectedModel);
  const named = (value: unknown) => {
    const parsed = modelName.safeParse(value);
    return parsed.success && !["mixed", "unknown"].includes(parsed.data) ? parsed.data : undefined;
  };
  let top: { model: string; tokens: number } | undefined;
  for (const item of response.usage.byModel ?? []) {
    const model = named(item.model), tokens = tokenCount(item);
    if (model && (!top || tokens > top.tokens)) top = { model, tokens };
  }
  return { id, version: top?.model ?? named(response.usage.model) ?? "unknown" };
}

async function modelEntries(deps: Dependencies, context: Context, plan: LearningPlan, tree: PinnedTree, sources: LearningSource[],
  gaps: Set<string>, reviewers: Reviewers | undefined, weekly?: WeeklySchedule): Promise<{ entries: PreparedEntry[]; diagnostics: BatchDiagnostics; model?: WriterModel; retry?: Retry }> {
  const reviews = sources.filter(source => source.kind === "review");
  const verified = reviews.filter(source => source.writer);
  const counts = { reviewSources: reviews.length, verifiedReviewSources: verified.length, verifiedPulls: new Set(verified.map(source => source.pull)).size,
    docs: sources.filter(source => source.kind === "docs").length, sessions: sources.filter(source => source.kind === "person").length };
  const skip = (reason: BatchDiagnostics["skip"]) => ({ entries: [], diagnostics: { ...counts, skip: reason } });
  if (!sources.length) return skip("no-sources");
  if (!hasLearningEvidence(sources, plan.source.slug)) {
    gaps.add("Some review batches lacked verified reviews from two merged changes.");
    return skip("insufficient-review-evidence");
  }
  const { writer, job, progress } = context;
  const project = job.project_id!;
  const pastSessions = sources.some(source => source.kind === "person");
  const earlier: EarlierEntry[] = [];
  for (const [id, raw] of snapshotNotes(writer, project).files) {
    const proof = learningProof(plan, raw, writer.setting(project, noteKey(id)));
    if (!proof) continue;
    const entry = parseEntry(raw);
    if (entry.mex.status !== "active" || entry.mex.source.type === "person" || pastSessions) continue;
    const text = cleanSourceText(entry.text, reviewers);
    if (text) earlier.push({ id, text: text.slice(0, 600), created: proof.evidenceDay ?? entry.mex.created });
  }
  earlier.sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
  earlier.splice(12);
  // The first approved batch asks for about ten rules; later and weekly batches keep the full cap.
  const limit = !weekly && job.batch === 0 ? FIRST_BATCH_PROPOSALS : MAX_LEARNED_PROPOSALS;
  const call = async (prompt: string, role: "cheap" | "best", rules = limit) => {
    if (pastSessions && !importsEnabled(writer, project)) throw new Error("Past-session capture was turned off before the model batch.");
    if (weekly && sessionsActive(writer, deps.now())) throw new AgentActive();
    const estimate = promptEstimate(prompt, plan.agent, role === "cheap" ? 0 : rules);
    if (!weekly && tokenCount(estimate) > plan.ceiling - recordedModelSpend(writer, job.id)) throw new ModelWaitError("cap", CEILING_WAIT);
    const output = await tree.withCheckFiles(writer.location.home, job.id, [], executionDirectory => deps.model({
      agent: plan.agent, setup: plan.setup, role, projectRoot: plan.checkout, executionDirectory, allowNonGit: true,
      purpose: role === "cheap" ? "learn-deeper-filter" : LEARN_KIND, prompt,
      ...(weekly ? { automatic: { estimate, measuredUsageOnly: true } } : { consented: { ceiling: plan.ceiling, estimate } }),
    }));
    if (!output) throw new Error("The model could not start in the private learning directory.");
    return output;
  };
  let selected = sources;
  if (plan.setup === "mixed") {
    const scope = job.project_id!;
    const key = `learning.deep.shortlist.${job.id}.${job.batch}`;
    const input = sourceDigest(JSON.stringify(sources.map(source => [source.id, source.hash])));
    const saved = writer.setting(scope, key);
    let shortlist = saved ? Shortlist.parse(JSON.parse(saved)) : undefined;
    if (shortlist && shortlist.input !== input) {
      gaps.add("Some sources changed after the batch was filtered.");
      return skip("changed-after-shortlist");
    }
    if (!shortlist) {
      const prompt = filteringPrompt(sources);
      // Leave room for a writer call before spending on a new shortlist.
      const pair = tokenCount(promptEstimate(prompt, plan.agent, 0)) + tokenCount(promptEstimate(writingPrompt(sources, earlier, limit), plan.agent, limit));
      if (!weekly && pair > plan.ceiling - recordedModelSpend(writer, job.id)) throw new ModelWaitError("cap", CEILING_WAIT);
      progress?.(`Filtering ${sources.length} sources`);
      const picked = selectedSources((await call(prompt, "cheap")).text, sources);
      shortlist = { input, ids: picked?.map(source => source.id) ?? [], invalid: !picked };
      writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(scope, key, JSON.stringify(shortlist));
    }
    if (shortlist.invalid) gaps.add("The model returned an invalid source shortlist.");
    const ids = new Set(shortlist.ids);
    selected = sources.filter(source => ids.has(source.id));
  }
  if (!hasLearningEvidence(selected, plan.source.slug)) {
    if (selected.length) gaps.add("Some shortlisted batches did not contain enough evidence to keep a rule.");
    return skip("insufficient-shortlist");
  }
  progress?.(`Learning from ${selected.length} sources`);
  const response = await call(writingPrompt(selected, earlier, limit), "best");
  const model = writerModel(response);
  const validated = await prepareEntries(response.text, selected, plan, tree, model, earlier, limit);
  // One retry for entries the gate drops on a failed check or a missing quote, only while the approved
  // ceiling still covers it. Weekly runs spend from the automatic allowance and don't retry.
  const retry: Retry | undefined = weekly ? undefined : async failed => {
    const cited = [...new Map(failed.flatMap(({ entry }) => entry.citations.map(({ source }) => [source.id, source] as const))).values()];
    const prompt = retryPrompt(cited, failed.map(({ entry, reason, detail }) => ({
      kind: entry.proposal.kind, text: entry.proposal.text, oneLine: entry.proposal.oneLine ?? entry.proposal.text, scope: entry.scope,
      checks: entry.proposal.checks ?? [], evidence: entry.citations.map(({ source, quote }) => ({ id: source.id, quote })), reason, detail,
    })));
    if (tokenCount(promptEstimate(prompt, plan.agent, failed.length)) > plan.ceiling - recordedModelSpend(writer, job.id)) return undefined;
    progress?.(`Retrying ${failed.length} unverified ${failed.length === 1 ? "entry" : "entries"}`);
    const reply = await call(prompt, "best", failed.length);
    const retried = writerModel(reply);
    const prepared = await prepareEntries(reply.text, cited, plan, tree, retried, earlier, failed.length);
    return { entries: prepared.entries, validation: prepared.validation, model: retried };
  };
  return { entries: validated.entries, diagnostics: { ...counts, validation: validated.validation }, model, retry };
}

function deferWeekly(context: Context, schedule: WeeklySchedule, state: Checkpoint, due: number, why: string): BatchResult<Checkpoint> {
  const { writer, job } = context, project = job.project_id!;
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    const live = writer.db.prepare("SELECT owner,state FROM jobs WHERE id=?").get(job.id);
    if (live?.owner === job.owner && live?.state === "running" && weeklySchedule(writer, project) === JSON.stringify(schedule)) {
      saveWeeklySchedule(writer, project, { ...schedule, due });
    }
    writer.db.exec("COMMIT");
  } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
  publishWeeklyWake(writer);
  return { checkpoint: state, done: true, gaps: true, summary: why, tokens: Math.max(0, recordedModelSpend(writer, job.id) - job.tokens_used) };
}

export function createLearnKind(dependencies: Partial<Dependencies> = {}, weeklyMode = false): JobKind<unknown, Checkpoint> {
  const deps = { ...defaults, ...dependencies };
  return {
    name: weeklyMode ? WEEKLY_KIND : LEARN_KIND, label: weeklyMode ? "Weekly learning" : "Learn deeper",
    scope: "project", machineExclusive: true, sideEffects: "idempotent",
    // Raw text read during the run is deleted however it ends: done, failed or cancelled.
    ended(job, db) { if (job.project_id) clearRunRows(db, job.project_id, job.id); },
    display(job, reader) {
      const summary = reader.all<{ summary: string }>("SELECT summary FROM job_results WHERE job_id=? ORDER BY batch DESC LIMIT 1", job.id)[0]?.summary;
      return { used: recordedModelSpend(reader, job.id), ceiling: weeklyMode ? undefined : Plan.parse(JSON.parse(job.params)).ceiling, summary };
    },
    interrupted(job, writer) {
      try {
        if (writer.setting(job.project_id!, batchKey(job)) || writer.setting(job.project_id!, retryKey(job))) {
          return { progress: "Finishing the saved batch after interruption" };
        }
        const state = checkpoint(job, weeklyMode ? [] : Plan.parse(JSON.parse(job.params)).gaps);
        return { checkpoint: JSON.stringify({ ...state, recovered: (state.recovered ?? 0) + 1 }), progress: "Resuming from the last finished batch" };
      } catch { return {}; }
    },
    ready(job, writer) {
      if (job.reason === CEILING_WAIT) return false;
      const state = checkpoint(job);
      const now = deps.now();
      const parsed = JSON.parse(job.params);
      return (!state.retryAt || state.retryAt <= now) && (!weeklyMode || !sessionsActive(writer, now))
        && learningOn(writer, job.project_id!, weeklyMode ? WeeklySchedule.parse(parsed) : Plan.parse(parsed), now);
    },
    async runBatch(context) {
      const { job, writer, progress } = context;
      const project = job.project_id!;
      const weekly = weeklyMode ? WeeklySchedule.parse(context.params) : undefined;
      const quoted = weeklyMode ? undefined : Plan.parse(context.params);
      const state = checkpoint(job, quoted?.gaps);
      const params = weekly ?? quoted!;
      const key = batchKey(job);
      await clearLearningChecks(writer.location.home, job.id);
      recoverNotes(writer, project);
      const previous = writer.setting(project, key);
      if (previous) return result(context, quoted ?? state.weeklyPlan!, receiptSchema.parse(JSON.parse(previous)));
      // A first round saved before an interruption is finished as it is, without another model call.
      const partial = writer.setting(project, retryKey(job));
      if (partial) return result(context, quoted ?? state.weeklyPlan!, await finishPartial(context, quoted ?? state.weeklyPlan!, key, partial));
      const now = deps.now();
      if (weekly && weeklySchedule(writer, project) !== JSON.stringify(weekly)) return { checkpoint: state, done: true, summary: "A newer weekly schedule is in effect." };
      if (!learningOn(writer, project, params, now)) return { checkpoint: state, wait: "Waiting: MEX is off here" };
      if (weekly && sessionsActive(writer, now)) return waitForIdle(state, now);
      const spend = () => recordedModelSpend(writer, job.id);
      if (quoted && spend() >= quoted.ceiling) throw new ModelWaitError("cap", CEILING_WAIT);
      const finishGap = async (why: string, retry = now + DAY_MS): Promise<BatchResult<Checkpoint>> => weekly
        ? deferWeekly(context, weekly, state, retry, why)
        : result(context, quoted!, await publish(context, quoted!, key, [], {
          checkpoint: { ...state, gaps: [...new Set([why, ...state.gaps])].slice(0, 24) }, done: true, sources: [], spent: spend(),
        }));
      if (!isDeepStrictEqual(await origin(params.checkout), params.origin)) return finishGap("The checkout's source repository changed.");
      if (quoted?.harvest) {
        try {
          const tree = await PinnedTree.open(quoted.checkout, quoted.head);
          if (!tree) return finishGap("The approved Git revision is no longer readable in this checkout.");
          const v2 = state.v2 ?? initialState();
          // Only the harvest reads the forge; later phases never need a login.
          const client = v2.phase === "harvest" && quoted.origin.host === "github.com" ? await deps.client(quoted) : undefined;
          const gaps = new Set(state.gaps);
          const out = await runPipelineBatch({ context, plan: quoted as LearningPlan & { harvest: HarvestPlan }, state: v2,
            deps: { model: deps.model, now: deps.now, client, tree }, weekly: false, gaps });
          const next: Checkpoint = { ...state, v2: out.state, gaps: [...gaps].slice(0, 24) };
          return { checkpoint: next, results: out.results, tokens: Math.max(0, spend() - context.job.tokens_used), done: out.done,
            gaps: out.done && next.gaps.length > 0, summary: pipelineSummary(out.state, next.gaps), progress: out.progress };
        } catch (error) {
          const wait = waitOn(error, state, deps.now());
          if (wait) return wait;
          throw error;
        }
      }
      try {
        const plan = quoted ?? state.weeklyPlan;
        let team: TeamCoverage | undefined;
        let client: ForgeClient | undefined;
        let tree: PinnedTree | undefined;
        if (weekly) {
          progress?.("Checking sources on the default branch");
          let recountGap = false;
          try {
            client = await deps.client(weekly);
            ({ tree, team } = await weeklySources(client, weekly, now));
          } finally {
            if (!plan) {
              try { await queuePatternRecount(writer, project, weekly.checkout, team); }
              catch { recountGap = true; }
            }
          }
          if (!plan) {
            const next = await quoteRefresh(client, weekly, tree, now);
            try { refreshOwnUsage(writer, { maxBytes: 512 << 10, maxFiles: 12, maxDiscoveryEntries: 256 }); } catch { /* admission requires measured usage */ }
            const gaps = recountGap ? [...next.gaps, "The weekly pattern recount could not be queued."] : next.gaps;
            return { checkpoint: { ...state, weeklyPlan: next, gaps }, progress: "Weekly reviews and docs selected" };
          }
          if (tree.head !== plan.head) return finishGap("The default branch moved. Weekly learning will check the new revision on its next pass.", now + 60 * 60_000);
        } else tree = await PinnedTree.open(quoted!.checkout, quoted!.head);
        if (!plan || !tree) return finishGap("The approved Git revision is no longer readable in this checkout.");
        const activePlan = plan, pinned = tree;
        const gaps = new Set(state.gaps);
        const saveBatch = async (sources: LearningSource[], advanced: Pick<Checkpoint, "pull" | "doc" | "session">, reviewers?: Reviewers,
          staleDocs: z.infer<typeof StaleDoc>[] = [], privacy: z.infer<typeof docPrivacy>[] = []) => {
          const eligible = weekly ? sources.filter(source => !team?.read.has(coverageKey(source)) && !sourceRead(writer, project, activePlan, source)) : sources;
          const { entries, diagnostics, model, retry } = await modelEntries(deps, context, activePlan, pinned, eligible, gaps, reviewers, weekly);
          const spent = spend();
          if (!weekly && spent > activePlan.ceiling) gaps.add("The last model batch reported more tokens than the approved ceiling.");
          const done = advanced.pull >= activePlan.pulls.length && advanced.doc >= activePlan.docs.length && (advanced.session ?? 0) >= activePlan.sessions.length;
          const schedule = done && (weekly || activePlan.refresh) ? scheduleFromPlan(activePlan, deps.next(deps.now())) : undefined;
          const staleCount = (state.staleDocs ?? 0) + staleDocs.length;
          if (staleDocs.length) diagnostics.staleDocs = staleDocs;
          if (privacy.length) diagnostics.docPrivacy = privacy;
          const reviewClient = client;
          const readReview = reviewClient && activePlan.source.host === "github.com"
            ? (source: Parameters<ReadReviewLines>[0]) => githubReviewLines(reviewClient, activePlan.source, source) : undefined;
          const saved = await publish(context, activePlan, key, entries, { checkpoint: { ...advanced, weeklyPlan: state.weeklyPlan,
            gaps: [...gaps].slice(0, 24), recovered: state.recovered, rejected: state.rejected, writers: state.writers,
            ...(staleCount ? { staleDocs: staleCount } : {}),
          }, spent, done,
            sources: eligible.map(sourceRef), diagnostics,
          }, { tree: pinned, readReview, team, schedule, model, retry });
          return result(context, activePlan, saved);
        };
        if (state.pull >= plan.pulls.length && state.doc >= plan.docs.length) {
          const offset = state.session ?? 0;
          const files = plan.sessions.slice(offset, offset + SESSIONS_PER_BATCH);
          if (files.length) progress?.("Reading the approved past sessions");
          const sources = files.length ? readImport(files, { checkout: plan.checkout, project, window: plan, store: writer, home: writer.location.home, now: deps.now() }, gaps) : [];
          return await saveBatch(sources, { pull: state.pull, doc: state.doc, session: offset + files.length });
        }
        progress?.("Reading the approved reviews and docs");
        client ??= await deps.client(plan);
        const host = hosts[plan.origin.host];
        const access = await host.access(client);
        if (!isDeepStrictEqual(access.source, plan.source) || access.visibility !== plan.visibility) return finishGap("Source access changed since approval. Run mex learn for a new quote.");
        const pulls = plan.pulls.slice(state.pull, state.pull + (plan.pullsPerBatch ?? PULLS_PER_BATCH));
        const docs = plan.docs.slice(state.doc, state.doc + DOCS_PER_BATCH);
        const reviews = await host.reviews(client, { source: plan.source, pulls, since: plan.since, until: plan.until, tree,
          preferred: plan.preferred, preferDistinctPulls: plan.pullsPerBatch !== undefined });
        for (const gap of reviews.gaps) gaps.add(gap);
        if (job.batch === 0 && plan.origin.host === "github.com" && isDeepStrictEqual(plan.origin, plan.source)) {
          const status = await readGitHubWorkflows(client, tree, plan.origin, deps.now()).catch(() => undefined);
          if (status) saveGitHubWorkflows(writer, project, status);
        }
        const sources: LearningSource[] = [...reviews.reviews];
        const scope = branchScope(docs.length ? await tree.read("AGENTS.md") : undefined);
        const staleDocs: z.infer<typeof StaleDoc>[] = [];
        const docsPrivacy: z.infer<typeof docPrivacy>[] = [];
        for (const path of docs) {
          const raw = await tree.read(path);
          const reason = raw === undefined ? undefined : staleDoc(path, raw, scope);
          if (reason) {
            staleDocs.push({ path, reason });
            continue;
          }
          const { excerpt, privacy } = raw === undefined ? {} : documentExcerpt(raw, reviews.reviewers);
          if (privacy) {
            docsPrivacy.push({ path, ...privacy });
            gaps.add(privacy.status === "excerpt" ? "Some docs contributed only an excerpt that passed secret scanning."
              : privacy.reason === "private-marker" ? "Some docs were skipped because they contained a private marker."
                : "Some docs were skipped because no safe excerpt remained after secret scanning.");
          }
          if (raw !== undefined && excerpt) {
            if (!privacy && excerpt.coverage === "partial") gaps.add("Some long docs were only partly read.");
            sources.push({ id: `doc:${path}`, kind: "docs", path, ...excerpt, hash: sourceDigest(raw), at: await tree.lastChanged(path),
              link: `https://${plan.origin.host}/${plan.origin.slug}/${plan.origin.host === "gitlab.com" ? "-/" : ""}blob/${plan.head}/${path.split("/").map(encodeURIComponent).join("/")}` });
          } else if (!privacy && (raw === undefined || raw.trim())) gaps.add("Some docs could not be safely read.");
        }
        if (!weekly && job.batch === 0 && sources.length) {
          sources.push(...await contextSources(client, plan.source, plan.origin, tree, plan, reviews.reviewers, gaps));
        }
        return await saveBatch(sources, { pull: state.pull + pulls.length, doc: state.doc + docs.length }, reviews.reviewers, staleDocs, docsPrivacy);
      } catch (error) {
        if (weekly) {
          if (error instanceof AgentActive) return waitForIdle(state, deps.now());
          if (error instanceof ModelWaitError || error instanceof SourceError || error instanceof ModelRunError
            || error instanceof RefreshDeferred || error instanceof KnowledgeError) {
            const why = error instanceof ModelWaitError && error.reason === "cap"
              ? "The measured rolling 3% allowance is unavailable or cannot cover the next weekly batch."
              : error instanceof KnowledgeError && error.code !== "LEARN_SOURCES" ? "The local or team knowledge could not be read for weekly learning." : error.message;
            return finishGap(why);
          }
        }
        const wait = waitOn(error, state, deps.now());
        if (wait) return wait;
        throw error;
      }
    },
  };
}

registerJobKind(createLearnKind());
registerJobKind(createLearnKind({}, true));
