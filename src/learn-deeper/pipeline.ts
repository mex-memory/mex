/**
 * Learn deeper v2, phase by phase: harvest (no model) -> triage (cheap) -> first rules early -> cluster
 * (cheap comparisons) -> write, judge quotes, prove, repair once, route and publish -> finish.
 *
 * Each `runBatch` does one bounded unit. A saved reply can be reused and an already charged call is
 * never repeated. Raw text (candidates, triage replies, drafts) lives in job-scoped rows until cleanup;
 * only the published entries, their proofs and the kept quote remain.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { claimHash, localSettings, retiredClaimHashes, tombstone } from "../knowledge/state.js";
import { learnedRefused, learnedRefusalKey, learnedWaitingKey } from "../knowledge/mutations.js";
import { sourceDigest, type Repository } from "./source.js";
import { existingKnowledge } from "./existing-knowledge.js";
import { branchScope, staleDoc } from "./history-docs.js";
import { sessionsActive } from "./weekly-schedule.js";
import { z } from "zod";
import { buildIndex } from "../file-index/build.js";
import { indexDirectory } from "../file-index/store.js";
import { registerLiterals } from "../knowledge/check.js";
import { isLearnedEntry, parseEntry, serializeEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { propose, type Proposal } from "../knowledge/gate.js";
import { producerEntryId } from "../knowledge/producers.js";
import { readNotes, snapshotNotes } from "../knowledge/personal-store.js";
import { ModelWaitError, type runModel } from "../model-runner/index.js";
import { recoverModelBatches, withModelJob } from "../model-runner/budget-queue.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import type { BatchContext } from "../record/jobs.js";
import type { RecordWriter } from "../record/index.js";
import { learningRunPrefix } from "../record/learning-rows.js";
import { shortHash } from "../record/project.js";
import { applyDocQuota, earlierCandidates, earlierClaim, earlierPair, planClusters, type Cluster, type ClusterOptions, type EarlierLearned, type Triaged } from "./cluster.js";
import { coverageKey, learningProof, makeNoteProof, noteKey, readTeamCoverage, saveSourceReads, sourceRead, type SourceRef } from "./coverage.js";
import type { PinnedTree } from "./git.js";
import { procedureProposal, procedureSamples, type ProcedureSample } from "./procedures.js";
import { BYTES_PER_TOKEN, TRIAGE_BATCH, TRIAGE_INPUT_LIMIT, TRIAGE_METADATA } from "./harvest/estimate.js";
import { harvestBatch } from "./harvest/index.js";
import { networkGroups, networkProofKey, networkRowKey, readNetworkGroups } from "./network-proof.js";
import type { Candidate, HarvestCursor, HarvestDeps, HarvestPlan } from "./harvest/types.js";
import { LEARN_KIND, promptEstimate, type LearningPlan } from "./plan.js";
import { gitHistory, proveEntry, quoteChecks, type ProofContext, type ProofJudgment, type ProofResult } from "./prove.js";
import { LESSON_PAIR_BATCH, MEANING_PURPOSE, meaningPrompt, meaningVerdicts, type MeaningQuestion, type MeaningVerdict } from "./meaning.js";
import { routeEntry } from "./route.js";
import { parseTriage, triageCounts, triagePrompt, type TriageResult } from "./triage.js";
import { packClusters, parseWriter, repairPrompt, writerPrompt, type WriterContext, type WriterEntry } from "./write.js";
import type { WriterModel } from "./entries.js";

export const PIPELINE_LIMITS = {
  /** Candidates per stored chunk, and so per triage call: what the quote counted on. */
  chunkCandidates: TRIAGE_BATCH,
  chunkBytes: TRIAGE_INPUT_LIMIT * BYTES_PER_TOKEN,
  /** First rules early: strong candidates written right after the first triage call. */
  earlyRules: 5,
  /** Strong candidates worth a triage call of their own before the first chunk is full. */
  firstRules: 3,
  /** Files staged for the native matcher's area check and the gate's observations. */
  stagedFiles: 2000,
} as const;

/**
 * What the first triage batch writes. Strong kept items go out as usual. When that batch kept
 * none, the early writer call still runs, on the best-supported kept items, and they wait for a tick.
 * Ranking matches clustering, without the strong bonus those items do not have.
 */
export function earlyLessons(kept: readonly Triaged[], limit: number): { items: Triaged[]; waiting: boolean } {
  const strong = kept.filter(item => item.candidate.signal === "strong").slice(0, limit);
  if (strong.length) return { items: strong, waiting: false };
  const score = (item: Triaged) => (item.candidate.weights.actedOn ? 2 : 0) + (item.candidate.weights.familiar ? 1 : 0);
  const ranked = [...kept].sort((a, b) => score(b) - score(a)
    || b.candidate.at.localeCompare(a.candidate.at) || a.candidate.id.localeCompare(b.candidate.id));
  return { items: ranked.slice(0, limit), waiting: ranked.length > 0 };
}

/** A weak lesson from a first batch with no strong item becomes a waiting rule instead of being dropped. */
export function markEarlyWaiting(clusters: readonly Cluster[], waiting: boolean): Cluster[] {
  return clusters
    .filter(cluster => (waiting || cluster.decision !== "drop") && cluster.source !== "docs" && !cluster.earlier)
    .map(cluster => waiting && cluster.decision === "drop"
      ? { ...cluster, decision: "propose", waiting: true, why: "best supported in a first batch with no strong signal" }
      : cluster);
}

/** Clusters for that early write. Obvious pairs join here; the pipeline asks the model about the rest. */
export function earlyClusters(items: readonly Triaged[], waiting: boolean, options?: ClusterOptions): Cluster[] {
  return markEarlyWaiting(planClusters(items, options).resolve(), waiting);
}

/** Every member was already in the early write, so a later write would pay for the same evidence. */
export function alreadyWrittenEarly(cluster: Cluster, early: ReadonlySet<string>): boolean {
  return cluster.members.every(member => early.has(member.candidate.id));
}

export const Phase = z.enum(["harvest", "triage", "cluster", "write", "finish"]);
export const trialReceiptKey = (jobId: string) => `learning.deep.trials.${jobId}`;
type TrialEntry = { id: string; issues?: number; linter?: true; alternatives?: number; procedure?: true };
const Counts = z.record(z.string().max(64), z.number().int().nonnegative());
export const PipelineState = z.object({
  phase: Phase,
  cursor: z.unknown().optional(),
  chunks: z.number().int().nonnegative(),
  harvestDone: z.boolean().optional(),
  triaged: z.number().int().nonnegative(),
  early: z.boolean(),
  batches: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  counts: Counts,
  procedures: z.number().int().nonnegative().max(5).optional(),
}).strict();
export type PipelineState = z.infer<typeof PipelineState>;
export const CURSOR_KEY = "learning.deep.cursor";

export function savedCursor(reader: { setting(scope: string, key: string): string | undefined | null }, project: string): HarvestCursor | undefined {
  try {
    const cursor = JSON.parse(reader.setting(project, CURSOR_KEY) ?? "null") as HarvestCursor | null;
    if (cursor?.sources) return cursor;
  } catch { /* An unreadable cursor starts a new scan. */ }
}

export const initialState = (cursor?: HarvestCursor): PipelineState =>
  ({ phase: "harvest", cursor, chunks: 0, triaged: 0, early: false, batches: 0, written: 0, counts: {} });

export class AgentActive extends Error {}

/** The checkout's upstream can be a different repository on the same forge. */
export function harvestClient(client: NonNullable<HarvestDeps["client"]>, source: Repository): NonNullable<HarvestDeps["client"]> {
  return { repo: source, anonymous: client.anonymous, get: client.get.bind(client), graphql: client.graphql.bind(client) };
}

type Context = BatchContext<unknown, unknown>;
export interface PipelineDeps {
  model: typeof runModel;
  now: () => number;
  /** Forge access for the harvest; undefined for local-only runs. */
  client?: HarvestDeps["client"];
  tree: PinnedTree;
  /** Strong candidates that start the first rules, when not the usual number. */
  firstRules?: number;
}
export interface PipelineInput {
  context: Context;
  plan: LearningPlan & { harvest: HarvestPlan };
  state: PipelineState;
  deps: PipelineDeps;
  weekly: boolean;
  gaps: Set<string>;
}

const key = (job: { id: string }, name: string) => learningRunPrefix(job.id) + name;
export function publishedBatch(reader: { setting(scope: string, key: string): string | undefined | null }, job: Context["job"]): boolean {
  if (!job.checkpoint || !job.project_id) return false;
  const state = JSON.parse(job.checkpoint).v2 as PipelineState | undefined;
  const name = state?.phase === "write" ? `batch.${state.written}` : state?.phase === "triage" && !state.early ? "early" : undefined;
  return !!name && !!reader.setting(job.project_id, key(job, `${name}.done`));
}
const add = (counts: PipelineState["counts"], name: string, n = 1) => { if (n) counts[name] = (counts[name] ?? 0) + n; };

function save({ writer, job }: Context, name: string, value: unknown): void {
  const saved = writer.db.prepare(`INSERT INTO settings(scope,key,value)
    SELECT ?,?,? FROM jobs WHERE id=? AND owner=? AND state='running'
    ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value`)
    .run(job.project_id!, key(job, name), JSON.stringify(value), job.id, job.owner);
  if (!saved.changes) throw new Error("Learning lost its job before saving.");
}
function load<T>(context: Context, name: string): T | undefined {
  const raw = context.writer.setting(context.job.project_id!, key(context.job, name));
  return raw ? JSON.parse(raw) as T : undefined;
}

/** One learned entry of a run, as the review list shows it (job E2; the Hub's Review page reads the same rows). */
export interface ReviewRow {
  entryId: string; claim: string; label: string; support: number; reviewers: number; proven: boolean;
  status: "active" | "proposed" | "retired"; route: string; signal: "strong" | "weak"; link: string;
}
/** The review rows of one learning run; this row is not job-scoped, so it outlives the run's raw text. */
export const reviewRowsKey = (jobId: string) => `learning.deep.review.${jobId}`;
export function reviewRows(reader: { setting(scope: string, key: string): string | undefined | null }, project: string, jobId: string): ReviewRow[] {
  try {
    const key = reviewRowsKey(jobId);
    return [...JSON.parse(reader.setting(project, key + ".overflow") ?? "[]"), ...JSON.parse(reader.setting(project, key) ?? "[]")] as ReviewRow[];
  } catch { return []; }
}

function saveReviewRows(set: ReturnType<RecordWriter["db"]["prepare"]>, project: string, jobId: string, rows: ReviewRow[]): void {
  const key = reviewRowsKey(jobId);
  // Older readers still see the newest 200. The terminal can review the whole run.
  set.run(project, key, JSON.stringify(rows.slice(-200)));
  if (rows.length > 200) set.run(project, key + ".overflow", JSON.stringify(rows.slice(0, -200)));
}

/** Split a harvest batch into chunks a triage call can take. */
export function chunkCandidates(candidates: readonly Candidate[]): Candidate[][] {
  const chunks: Candidate[][] = [];
  let current: Candidate[] = [], bytes = 0;
  for (const candidate of candidates) {
    const size = Buffer.byteLength(candidate.text) + TRIAGE_METADATA * BYTES_PER_TOKEN;
    if (current.length && (current.length >= PIPELINE_LIMITS.chunkCandidates || bytes + size > PIPELINE_LIMITS.chunkBytes)) {
      chunks.push(current); current = []; bytes = 0;
    }
    current.push(candidate); bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** One model call under the run's consent: the approved ceiling, or weekly's automatic allowance. */
interface Reply { text: string; model: WriterModel; tokens: number; lost?: true; promptHash?: string }
async function call(input: PipelineInput, name: string, prompt: string, role: "cheap" | "best", rules: number, bindPrompt = false): Promise<Reply> {
  const { context, plan, deps, weekly } = input;
  const promptHash = bindPrompt ? sourceDigest(prompt) : undefined;
  const saved = load<Reply>(context, `reply.${name}`);
  if (saved) {
    if (saved.lost) input.gaps.add("A paid model reply could not be recovered after an interruption.");
    // Earlier entries can change while a job is paused. A saved answer only describes its original questions.
    return saved.promptHash === promptHash ? saved : { ...saved, text: "" };
  }
  const { writer, job } = context;
  const stage = `call.${name}`;
  const started = load<{ lastBatch: number }>(context, stage);
  const attempts = writer.db.prepare(`SELECT id,state,charged_units FROM model_batches
    WHERE job_id=? AND (charged_units>0 OR state='running')
    AND (json_extract(pricing,'$.stage')=? OR (json_extract(pricing,'$.stage') IS NULL AND id>?))
    ORDER BY charged_units DESC LIMIT 1`);
  // Untagged old admissions can only be matched with the saved attempt boundary.
  const findAttempt = () => attempts.get(job.id, stage, started?.lastBatch ?? null);
  let prior = findAttempt();
  // A dead running row must become charged before deciding whether to retry.
  if (prior?.state === "running") {
    recoverModelBatches(writer);
    prior = findAttempt();
  }
  if (prior?.charged_units) {
    // The runner recorded the charge but died before saving the answer.
    input.gaps.add("A paid model reply could not be recovered after an interruption.");
    const reply: Reply = { text: "", lost: true, model: { id: "unknown", version: "unknown" }, tokens: recordedModelSpend(writer, job.id, Number(prior.id)), promptHash };
    save(context, `reply.${name}`, reply);
    return reply;
  }
  if (prior?.state === "running") throw new ModelWaitError("queue");
  const spent = recordedModelSpend(writer, job.id);
  const estimate = promptEstimate(prompt, plan.agent, role === "cheap" ? 0 : rules);
  // Procedure naming is a trial on the automatic allowance, not part of the consented quote.
  const procedure = name.startsWith("procedure.");
  if (!weekly && !procedure && tokenCount(estimate) > plan.ceiling - spent) throw new ModelWaitError("cap", CEILING_WAIT);
  if (weekly && sessionsActive(writer, deps.now())) throw new AgentActive();
  const lastBatch = started?.lastBatch ?? Number(writer.db.prepare("SELECT max(id) id FROM model_batches WHERE job_id=?").get(job.id)?.id ?? 0);
  save(context, stage, started ?? { lastBatch });
  const reply = await deps.tree.withCheckFiles(writer.location.home, job.id, [], async executionDirectory => {
    const output = await withModelJob({ jobId: job.id, batch: job.batch, projectId: job.project_id,
      recordHome: writer.location.home, stage }, () => deps.model({
      agent: plan.agent, setup: procedure || bindPrompt ? "mixed" : plan.setup, role, projectRoot: plan.checkout, executionDirectory, allowNonGit: true,
      purpose: procedure ? "learn-deeper-procedure" : bindPrompt ? MEANING_PURPOSE : role === "cheap" ? "learn-deeper-filter" : LEARN_KIND, prompt,
      ...(weekly || procedure ? { automatic: { estimate, measuredUsageOnly: true } } : { consented: { ceiling: plan.ceiling, estimate } }),
    }));
    const { writerModel } = await import("./job.js");
    const reply: Reply = { text: output.text, model: writerModel(output), tokens: Math.max(0, recordedModelSpend(writer, job.id) - spent), promptHash };
    save(context, `reply.${name}`, reply);
    return reply;
  });
  if (!reply) throw new Error("The model could not start in its private workspace.");
  return reply;
}

/** One more try at an answer that couldn't be read, when the allowance covers it. Nothing waits for it. */
async function retry(...[input, name, prompt, role, rules]: Parameters<typeof call>): Promise<Reply | undefined> {
  try { return await call(input, name, prompt, role, rules); }
  catch (error) {
    if (!(error instanceof ModelWaitError && error.reason === "cap")) throw error;
    return undefined;
  }
}

async function judgeMeaning(input: PipelineInput, counts: PipelineState["counts"], name: string, metric: "pairs" | "quotes",
  questions: readonly MeaningQuestion[]): Promise<MeaningVerdict[] | undefined> {
  if (!questions.length) return [];
  const { context } = input;
  const { writer, job } = context;
  const spent = recordedModelSpend(writer, job.id);
  const gap = `A lesson ${metric === "pairs" ? "comparison" : "evidence"} batch could not be judged.`;
  const skipped = `unavailable.${name}`;
  try {
    const unavailable = load<{ tokens: number }>(context, skipped);
    if (unavailable) { add(counts, `tokens.${metric}`, unavailable.tokens); input.gaps.add(gap); return; }
    const reply = await call(input, name, meaningPrompt(questions), "cheap", 0, true);
    add(counts, `tokens.${metric}`, reply.tokens);
    const verdicts = meaningVerdicts(reply.text, questions);
    if (!verdicts) input.gaps.add(gap);
    return verdicts;
  } catch {
    const tokens = Math.max(0, recordedModelSpend(writer, job.id) - spent);
    save(context, skipped, { tokens });
    add(counts, `tokens.${metric}`, tokens);
    input.gaps.add(gap);
  }
}

async function groupLessons(input: PipelineInput, counts: PipelineState["counts"], name: string, items: readonly Triaged[],
  earlier?: readonly EarlierLearned[]): Promise<Cluster[]> {
  const plan = planClusters(items, { earlier });
  const verdicts: Array<MeaningVerdict | undefined> = [];
  for (let start = 0; start < plan.questions.length; start += LESSON_PAIR_BATCH) {
    const questions = plan.questions.slice(start, start + LESSON_PAIR_BATCH);
    const answers = await judgeMeaning(input, counts, `${name}.pairs.${start / LESSON_PAIR_BATCH}`, "pairs", questions);
    if (answers) answers.forEach((answer, i) => { verdicts[start + i] = answer; });
  }
  return plan.resolve(verdicts);
}

type PriorLesson = EarlierLearned & { refused: boolean; waiting: boolean };

function earlierEntries(writer: RecordWriter, project: string, plan: LearningPlan): PriorLesson[] {
  const out: PriorLesson[] = [];
  for (const [id, raw] of snapshotNotes(writer, project).files) {
    try {
      const entry = parseEntry(raw);
      if (!isLearnedEntry(entry.mex)) continue;
      const refused = !!tombstone(writer, project, id) || learnedRefused(writer, project, entry, raw) || entry.mex.status === "retired";
      const proof = learningProof(plan, raw, writer.setting(project, noteKey(id)));
      // Refusals survive status changes and rewritten receipts.
      if (!refused && !proof) continue;
      out.push({ id, text: entry.text, claim: entry.mex.one_line, scope: entry.mex.scope, patterns: (entry.mex.when ?? []).map(item => item.pattern),
        refused, waiting: entry.mex.status === "proposed" && !!writer.setting(project, learnedWaitingKey(id)), support: proof?.support });
    } catch { /* An unreadable note is no earlier lesson. */ }
  }
  // An overlapping live rule must not hide an earlier refusal.
  return out.sort((a, b) => Number(b.refused) - Number(a.refused));
}

function clusterEntryId(plan: LearningPlan, cluster: Cluster): string {
  return producerEntryId("learn-deeper", JSON.stringify([plan.origin.host, plan.origin.slug.toLowerCase(), "lesson", cluster.key]));
}

const clusterAliasKey = (id: string) => `learning.deep.cluster.${id}`;

/** Whether two scope globs can cover the same file, judged by their fixed leading folders. */
function scopesMeet(a: string, b: string): boolean {
  const fixed = (glob: string) => glob.split(/[*?[{]/u, 1)[0]!;
  const [x, y] = [fixed(a), fixed(b)];
  return x.startsWith(y) || y.startsWith(x);
}

function reviewRefusals(writer: RecordWriter, project: string, plan: LearningPlan) {
  const earlier = earlierEntries(writer, project, plan);
  const refused = earlier.filter(entry => entry.refused);
  const refusedIds = new Set(refused.map(entry => entry.id));
  const claims = retiredClaimHashes(writer, project);
  for (const row of localSettings(writer, project, learnedRefusalKey(""), 512)) {
    for (const hash of z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/u)).max(2).parse(JSON.parse(row.value))) claims.add(hash);
  }
  const idRefused = (id: string | undefined) => !!id &&
    (refusedIds.has(id) || !!writer.setting(project, learnedRefusalKey(id)) || !!tombstone(writer, project, id));
  return {
    earlier, refused,
    claim: (text: string) => claims.has(claimHash(text)),
    /** Clearly the lesson someone refused: nothing is spent on it. */
    cluster(cluster: Cluster): boolean {
      const id = clusterEntryId(plan, cluster);
      return idRefused(cluster.earlier) || idRefused(id) || idRefused(writer.setting(project, clusterAliasKey(id)))
        || cluster.members.some(member => claims.has(claimHash(member.triage.lesson)));
    },
    /**
     * Refused rules about the same thing, when this isn't clearly one of them. The lesson may be a different one,
     * so it is written, but the writer is told what was refused and the result waits for a tick.
     */
    related(cluster: Cluster): PriorLesson[] {
      return refused.filter(entry => cluster.relatedRefusals?.includes(entry.id)).slice(0, 8);
    },
    /** The trigger of a refused rule coming back under other words: it would stop the edits the person refused. */
    trigger(when: ReadonlyArray<{ type: string; pattern: string }> | undefined, scope: readonly string[]): boolean {
      // A narrower or broader spelling of it stops the same edits.
      const meets = (a: string, b: string) => a.includes(b) || b.includes(a);
      return (when ?? []).some(item => item.type !== "required" && refused.some(entry => entry.patterns.some(pattern => meets(pattern, item.pattern))
        && entry.scope.some(a => scope.some(b => scopesMeet(a, b)))));
    },
  };
}

function candidateRef(plan: LearningPlan, candidate: Candidate): SourceRef {
  const { id, hash, link } = candidate;
  if (!candidate.document || !candidate.path) return { id, hash, link };
  const { host, slug } = plan.origin;
  const path = candidate.path.split("/").map(encodeURIComponent).join("/");
  const fragment = link.slice(link.indexOf("#") + 1);
  return { id, hash, link: `https://${host}/${slug}/${host === "gitlab.com" ? "-/" : ""}blob/${plan.head}/${path}#${fragment}` };
}

function linters(tree: PinnedTree): string[] {
  const names = /(?:^|\/)(?:\.eslintrc(?:\.\w+)?|eslint\.config\.\w+|biome\.jsonc?|\.ruff\.toml|ruff\.toml|\.golangci\.ya?ml|\.rubocop\.yml|\.stylelintrc(?:\.\w+)?|clippy\.toml|\.flake8|\.pylintrc)$/u;
  return [...tree.paths()].filter(path => names.test(path) && path.split("/").length <= 3).slice(0, 8);
}

function proofDropReason(reason: string): string {
  if (reason.includes("verbatim quote")) return "unverified-claim";
  if (reason.includes("backs the claim")) return "one-weak-source";
  if (reason.includes("nothing today")) return "no-scope";
  if (reason.includes("maintainer")) return "no-maintainer-reason";
  if (reason.includes("restates")) return "restated-source";
  if (reason.includes("linter config")) return "already-enforced";
  return "no-check";
}

async function judgeDrafts(input: PipelineInput, counts: PipelineState["counts"], name: string, drafts: readonly WriterEntry[],
  clusters: ReadonlyMap<string, Cluster>, current: ReturnType<typeof reviewRefusals>) {
  const questions: MeaningQuestion[] = [];
  const checks = drafts.map(draft => {
    const cluster = clusters.get(draft.cluster)!;
    const citations = quoteChecks(draft, cluster).flatMap(({ citations }) => citations.flatMap(({ citation, question }) => {
      if (!question) return [];
      return [{ citation, index: questions.push(question) - 1 }];
    }));
    const prior = current.earlier.find(entry => entry.id === cluster.earlier && !entry.refused && earlierClaim(entry) === cluster.earlierClaim);
    const nominated = earlierCandidates(cluster, draft.claim, current.refused);
    const lesson = cluster.members[0]!.triage.lesson;
    const compare = (entry: EarlierLearned) => questions.push({ lesson: earlierPair(lesson, entry, draft.claim) }) - 1;
    return { draft, citations, prior: prior && compare(prior), refused: nominated.map(compare) };
  });
  const verdicts = await judgeMeaning(input, counts, name, "quotes", questions);
  const judgments = new Map<WriterEntry, ProofJudgment>();
  const refused = new Set<WriterEntry>(), related = new Set<WriterEntry>();
  for (const check of checks) {
    judgments.set(check.draft, {
      supportingQuotes: new Set(check.citations.filter(({ index }) => verdicts?.[index] === "supports").map(({ citation }) => citation)),
      sameEarlier: check.prior !== undefined && verdicts?.[check.prior] === "same",
    });
    if (check.refused.some(index => verdicts?.[index] === "same")) refused.add(check.draft);
    if (check.refused.some(index => verdicts?.[index] === "related")) related.add(check.draft);
  }
  return { judgments, refused, related, unavailable: verdicts === undefined };
}

/** Write, prove, repair once, route and publish one batch of clusters. */
async function writeUnit(input: PipelineInput, state: PipelineState, name: string, clusters: Cluster[]): Promise<number> {
  const { context, plan, deps } = input;
  const counts: Record<string, number> = {};
  const project = context.job.project_id!;
  // A unit published before an interruption is finished: never publish or pay for it twice.
  if (!clusters.length) return 0;
  const saved = load<{ accepted: number; counts: Record<string, number>; gaps: string[] }>(context, `${name}.done`);
  if (saved) {
    for (const [counted, n] of Object.entries(saved.counts)) add(state.counts, counted, n);
    for (const gap of saved.gaps) input.gaps.add(gap);
    return saved.accepted + await writeUnbacked(input, state, name);
  }
  const refusals = reviewRefusals(context.writer, project, plan);
  const allowed = clusters.filter(cluster => !refusals.cluster(cluster));
  add(counts, "cluster.forgotten", clusters.length - allowed.length);
  if (!allowed.length) {
    add(state.counts, "cluster.forgotten", clusters.length);
    return 0;
  }
  clusters = allowed;
  const near = new Map(clusters.map(cluster => [cluster.key, refusals.related(cluster)] as const).filter(([, entries]) => entries.length));
  add(counts, "cluster.near-refused", near.size);
  const writerContext: WriterContext = { linters: linters(deps.tree),
    refused: new Map([...near].map(([cluster, entries]) => [cluster, entries.map(entry => entry.claim ?? entry.text)])) };
  let first = await call(input, `${name}.write`, writerPrompt(clusters, writerContext), "best", clusters.length);
  add(counts, "tokens.write", first.tokens);
  const byKey = new Map(clusters.map(cluster => [cluster.key, cluster]));
  let parsed = parseWriter(first.text, clusters);
  if (parsed.response !== "valid" && !first.lost) {
    const again = await retry(input, `${name}.write.again`, writerPrompt(clusters, writerContext), "best", clusters.length);
    if (again) {
      add(counts, "tokens.write", again.tokens);
      parsed = parseWriter(again.text, clusters);
      first = again;
    }
  }
  if (parsed.response !== "valid") input.gaps.add("A model batch returned no readable entries.");
  for (const item of parsed.rejected) add(counts, `writer-rejected.${item.reason}`);
  const areas = [...new Set(clusters.flatMap(cluster => [...cluster.files, ...cluster.members.flatMap(m => m.candidate.changedPaths ?? [])]))];
  const checkedRefusals = reviewRefusals(context.writer, project, plan);
  const checkedDrafts = await judgeDrafts(input, counts, `${name}.quotes`, parsed.entries, byKey, checkedRefusals);
  const verify = (repair?: { entries: WriterEntry[]; model: WriterModel; judged: Awaited<ReturnType<typeof judgeDrafts>> }) => withProofContext(
    input, [...parsed.entries, ...(repair?.entries ?? [])], areas, async (proofContext, checked) => {
    const prove = (entry: WriterEntry, judged: Awaited<ReturnType<typeof judgeDrafts>>) =>
      proveEntry(entry, byKey.get(entry.cluster)!, proofContext, judged.judgments.get(entry));
    const proofs: ProofResult[] = [];
    for (const entry of parsed.entries) proofs.push(await prove(entry, checkedDrafts));
    const refusedDraft = (draft: WriterEntry) => checkedDrafts.refused.has(draft) || repair?.judged.refused.has(draft);
    const failing = proofs.filter(proof => proof.failures.length && !refusedDraft(proof.draft));
    if (failing.length && !repair && !checkedDrafts.unavailable) return { failing };
    if (repair) for (const entry of repair.entries) {
      const again = await prove(entry, repair.judged);
      const index = proofs.findIndex(proof => proof.draft.cluster === entry.cluster);
      // Keep the repair only when it proves at least as much as the first answer.
      if (!refusedDraft(entry) && index >= 0 && !again.dropped
        && (proofs[index]!.dropped || again.when.length >= proofs[index]!.when.length)) proofs[index] = again;
    }
    const model = repair?.model ?? first.model;
    const unbacked = proofs.filter(proof => !proof.dropped && !refusedDraft(proof.draft)).flatMap(proof => proof.unbacked);
    if (unbacked.length) save(context, `${name}.unbacked`, unbacked);
    const routed = proofs.map(proof => ({ proof, routed: routeEntry(proof, plan.origin, model) }));
    const team = input.weekly ? await readTeamCoverage(plan.checkout, plan.head, plan.since) : undefined;
    const duplicate = await existingKnowledge(deps.tree);
    const before = snapshotNotes(context.writer, project).files;
    let proposals: Proposal[] = [];
    const carry = new Map<string, { entry: KnowledgeEntry; raw: string; proposal: Proposal }>();
    const sources = new Map<Proposal, Candidate[]>();
    const routedOf = new Map<Proposal, { proof: ProofResult; proven: boolean }>();
    for (const { proof, routed: item } of routed) {
      if (refusedDraft(proof.draft)) { add(counts, "cluster.forgotten"); continue; }
      if ("dropped" in item) {
        add(counts, "dropped");
        add(counts, `proof-dropped.${proofDropReason(item.dropped)}`);
        continue;
      }
      const claim = claimHash(item.proposal.text);
      if (refusals.claim(item.proposal.text) || refusals.claim(proof.claim) || refusals.trigger(item.proposal.anchors?.when, proof.scope)) {
        add(counts, "cluster.forgotten");
        continue;
      }
      // About something the person refused a rule on: a person decides, even when the code proves it.
      if (near.has(proof.cluster.key) || checkedDrafts.related.has(proof.draft) || repair?.judged.related.has(proof.draft)) item.proposal.status = "proposed";
      if (team?.retired.has(claim) || team?.claimed.has(claim)) { add(counts, "team-covered"); continue; }
      if (!proof.cluster.earlier && duplicate(item.proposal.text, proof.claim)) {
        add(counts, "duplicate-existing");
        continue;
      }
      if (proof.draft.route === "decision" || proof.draft.route === "ruled-out") {
        item.proposal.decisionPairing = proof.draft.route;
      }
      sources.set(item.proposal, item.sources);
      routedOf.set(item.proposal, { proof, proven: item.proven });
      const id = proof.cluster.earlier;
      // A stable candidate ID can already name an entry from a previous run.
      // Writing over it still requires a same verdict for the final claim.
      if (!id && before.has(clusterEntryId(plan, proof.cluster))) { add(counts, "duplicate-existing"); continue; }
      const raw = id && before.get(id);
      if (id && raw && !item.proven) {
        const prior = parseEntry(raw);
        if (prior.mex.status === "active" && prior.mex.checks.some(check => check.kind === "fixture")) {
          carry.set(id, { entry: prior, raw, proposal: item.proposal });
          continue;
        }
      }
      proposals.push(item.proposal);
    }
    // The gate records pattern checks from the staged index: count the fix and baseline literals first.
    const fixLiterals = proofs.flatMap(proof => [...(proof.fixLiteral ? [proof.fixLiteral] : []), ...(proof.lint ? [proof.lint.rule] : [])]);
    if (fixLiterals.length && checked.checkIndex) {
      registerLiterals(checked.checkIndex.recordDirectory, checked.checkIndex.projectId, fixLiterals);
      await buildIndex({ root: checked.checkTree!, projectId: checked.checkIndex.projectId, recordDirectory: checked.checkIndex.recordDirectory, workers: 0 });
    }
    let acceptedCount = 0;
    // A review can be saved while the writer or the check evaluator is running.
    // Recheck under the gate's writer lock, then retry only the unaffected proposals.
    let blocked = new Set<Proposal>();
    const held = new Set<Proposal>();
    const publish = () => propose(proposals, {
      projectPath: plan.checkout, home: context.writer.location.home, ...checked,
      validate(gate) {
        const live = gate.db.prepare("SELECT owner,state FROM jobs WHERE id=?").get(context.job.id);
        const checkout = gate.checkout(plan.checkout);
        if (live?.owner !== context.job.owner || live?.state !== "running" || gate.setting(project, key(context.job, `${name}.done`))
          || checkout?.project_id !== project || !checkoutOn(checkout, deps.now()) || !automaticWorkEnabled(gate, project, deps.now())) {
          throw new Error("Learning lost its job before saving.");
        }
        const current = reviewRefusals(gate, project, plan);
        const currentById = new Map(current.earlier.map(entry => [entry.id, entry]));
        const newlyRefused = current.refused.filter(entry => !checkedRefusals.refused.some(old =>
          old.id === entry.id && earlierClaim(old) === earlierClaim(entry)));
        blocked = new Set([...proposals, ...[...carry.values()].map(item => item.proposal)].filter(proposal => {
          const cluster = routedOf.get(proposal)!.proof.cluster;
          const earlier = cluster.earlier && currentById.get(cluster.earlier);
          const storedId = clusterEntryId(plan, cluster);
          return current.cluster(cluster) || current.claim(proposal.text) || current.claim(proposal.oneLine ?? "")
            || current.trigger(proposal.anchors?.when, proposal.anchors?.scope ?? [])
            || (cluster.earlier ? !earlier || earlierClaim(earlier) !== cluster.earlierClaim : currentById.has(storedId));
        }));
        // A newly refused subject needs review if it appeared after the evidence judgment.
        for (const proposal of proposals) {
          const { cluster, claim } = routedOf.get(proposal)!.proof;
          if (proposal.status !== "proposed" && !blocked.has(proposal) && earlierCandidates(cluster, claim, newlyRefused).length) held.add(proposal);
        }
        if (blocked.size || held.size) throw new Error("The review changed before learning could save.");
      },
      onAccepted(gate, accepted, gated) {

        // Results come back one per proposal, in order.
        const proposalOf = new Map<string, Proposal>();
        gated.forEach((result, i) => { if (result.status === "accepted") proposalOf.set(result.entryId, proposals[i]!); });
        // An overlapping prose draft can contribute evidence to the original proof without replacing it.
        // Recheck the stored revision inside the gate transaction before updating the receipt.
        const current = carry.size ? readNotes(gate.location.home, project).files : undefined;
        const retained = [...carry].flatMap(([entryId, item]) => {
          if (proposalOf.has(entryId) || current?.get(entryId) !== item.raw) return [];
          proposalOf.set(entryId, item.proposal);
          return [{ entryId, entry: item.entry }];
        });
        const savedEntries = [...accepted, ...retained];
        acceptedCount = savedEntries.length;
        add(counts, "saved", acceptedCount);
        const set = gate.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
        for (const item of savedEntries) {
          const proposal = proposalOf.get(item.entryId);
          const members = (proposal && sources.get(proposal)) ?? [];
          const raw = before.get(item.entryId);
          const previous = raw && learningProof(plan, raw, gate.setting(project, noteKey(item.entryId)));
          const refs = [...new Map([...(previous ? previous.sources : []), ...members.map(candidate => candidateRef(plan, candidate))]
            .map(ref => [ref.id, ref])).values()].slice(-8);
          const day = [...members.map(candidate => candidate.at.slice(0, 10)), ...(previous && previous.evidenceDay ? [previous.evidenceDay] : [])]
            .sort().at(-1) ?? plan.until.slice(0, 10);
          const cluster = proposal && routedOf.get(proposal)?.proof.cluster;
          const support = cluster && { pulls: cluster.pulls.slice(-256), commits: cluster.commits.slice(-256),
            reviewers: (cluster.reviewerKeys ?? []).slice(-256) };
          if (cluster) {
            const derivedId = clusterEntryId(plan, cluster);
            if (derivedId !== item.entryId) set.run(project, clusterAliasKey(derivedId), item.entryId);
          }
          const proof = proposal && routedOf.get(proposal);
          const issues = members.filter(candidate => candidate.kind === "issue").length;
          const linter = proof?.proof.lint && !proof.proven
            && item.entry.text.includes(`enable \`${proof.proof.lint.rule}\` in \`${proof.proof.lint.config}\`.`);
          const alternatives = proof?.proof.alternatives.filter(({ option, reason }) =>
            item.entry.text.includes(`Considered and ruled out: ${option} (${reason}).`)).length ?? 0;
          if (issues || linter || alternatives) {
            const record: TrialEntry = { id: item.entryId, ...(issues ? { issues } : {}),
              ...(linter ? { linter: true } : {}), ...(alternatives ? { alternatives } : {}) };
            set.run(project, key(context.job, `trial.${item.entryId}`), JSON.stringify(record));
          }
          set.run(project, noteKey(item.entry.mex.id), makeNoteProof(plan, serializeEntry(item.entry), refs, day, support));
          saveSourceReads(gate, project, plan, refs);
          // The node group behind each URL check, for the weekly network pass. A check whose evidence came from an
          // earlier run keeps the group that run stored.
          const stored = readNetworkGroups(gate.setting(project, networkProofKey(item.entryId)) ?? "[]");
          const groups = networkGroups(item.entry, members).map(group => group.complete ? group
            : stored.find(old => old.url === group.url && old.hash === group.hash) ?? group);
          set.run(project, networkProofKey(item.entry.mex.id), JSON.stringify(groups));
          // This run read those comments, so a link isn't unknown until the first weekly pass: the rule files take only
          // what holds.
          for (const { url, hash, complete } of groups) {
            if (complete && members.some(candidate => candidate.link === url && candidate.hash === hash)) {
              set.run(project, networkRowKey(url, hash), JSON.stringify({ state: "same", at: context.job.created_at }));
            }
          }
        }

        // The review list's rows: no source text, only what the person decides on. Kept after the run's cleanup.
        const rows = new Map(reviewRows(gate, project, context.job.id).map(row => [row.entryId, row]));
        for (const item of savedEntries) {
          const proposal = proposalOf.get(item.entryId);
          const routed = proposal && routedOf.get(proposal);
          if (!routed) continue;
          const cluster = routed.proof.cluster;
          if (!rows.has(item.entryId)) add(counts, cluster.source === "docs" ? "saved-docs" : "saved-other");
          const proven = routed.proven || carry.has(item.entryId) && item.entry.mex.checks.some(check => check.kind === "fixture");
          add(counts, proven ? "proven" : "prose");
          if (item.entry.mex.status === "proposed") add(counts, "proposed");
          rows.set(item.entryId, { entryId: item.entryId, claim: item.entry.mex.one_line, label: item.entry.mex.source.label ?? "",
            support: cluster.support, reviewers: cluster.reviewers, proven, status: item.entry.mex.status,
            route: routed.proof.draft.route, signal: cluster.strong ? "strong" : "weak", link: proposal.source.ref });
        }
        saveReviewRows(set, project, context.job.id, [...rows.values()]);
        for (const result of gated) if (result.status === "dropped") add(counts, `gate-dropped.${result.reason}`);
        const unchecked = gated.filter(result => result.status === "dropped" && result.reason === "checks-unavailable").length;
        if (unchecked) input.gaps.add(`${unchecked} ${unchecked === 1 ? "lesson" : "lessons"} could not be checked, so nothing was saved from ${unchecked === 1 ? "it" : "them"}.`);
        set.run(project, key(context.job, `${name}.done`), JSON.stringify({ accepted: acceptedCount, counts, gaps: [...input.gaps] }));
      },
    });
    for (;;) {
      try {
        await publish();
        break;
      } catch (error) {
        if (!blocked.size && !held.size) throw error;
        for (const proposal of held) proposal.status = "proposed";
        held.clear();
        if (blocked.size) add(counts, "cluster.forgotten", blocked.size);
        proposals = proposals.filter(proposal => !blocked.has(proposal));
        for (const [id, item] of carry) if (blocked.has(item.proposal)) carry.delete(id);
        blocked.clear();
      }
    }
    for (const [counted, n] of Object.entries(counts)) add(state.counts, counted, n);
    return { acceptedCount };
  });

  const firstPass = await verify();
  if (firstPass.failing === undefined) return firstPass.acceptedCount + await writeUnbacked(input, state, name);
  const current = reviewRefusals(context.writer, project, plan);
  const failing = firstPass.failing.filter(proof => !current.cluster(proof.cluster) && !current.claim(proof.claim));
  if (!failing.length) return ((await verify({ entries: [], model: first.model, judged: checkedDrafts })).acceptedCount ?? 0) + await writeUnbacked(input, state, name);
  let repair = { entries: [] as WriterEntry[], model: first.model };
  // Close the staged proof tree before opening the model's separate, empty workspace.
  try {
    const answer = await call(input, `${name}.repair`,
      // The writer's pair numbers are those of the whole cluster it was shown.
      repairPrompt(failing.map(proof => ({ cluster: byKey.get(proof.draft.cluster)!, entry: proof.draft, failures: proof.failures })), writerContext), "best", failing.length);
    add(counts, "tokens.repair", answer.tokens);
    repair = { entries: parseWriter(answer.text, failing.map(proof => byKey.get(proof.draft.cluster)!)).entries, model: answer.model };
    add(counts, "repaired", repair.entries.length);
  } catch (error) {
    if (error instanceof AgentActive || error instanceof ModelWaitError && error.reason !== "cap") throw error;
    input.gaps.add(error instanceof ModelWaitError ? "The allowance could not cover a repair. Only the proven parts were kept."
      : "The repair turn could not run. Only the proven parts were kept.");
  }
  const judged = await judgeDrafts(input, counts, `${name}.repair.quotes`, repair.entries, byKey, checkedRefusals);
  const checked = await verify({ ...repair, judged });
  return (checked.acceptedCount ?? 0) + await writeUnbacked(input, state, name);
}

/** Members a written rule didn't rest on: grouped with what they don't say, they may hold a lesson of their own. One round only. */
async function writeUnbacked(input: PipelineInput, state: PipelineState, name: string): Promise<number> {
  if (name.endsWith(".own")) return 0;
  // A member already written early backs the rule it was written for: it isn't left over.
  const early = new Set(load<string[]>(input.context, "early.members") ?? []);
  const items = (load<Triaged[]>(input.context, `${name}.unbacked`) ?? []).filter(item => !early.has(item.candidate.id));
  if (!items.length) return 0;
  // No earlier entry is matched, and the key is its own: these were grouped with a rule they didn't back, so they must
  // not be saved over it. The gate still drops a lesson that turns out to repeat one.
  const clusters = (await groupLessons(input, state.counts, `${name}.own`, items)).filter(cluster => cluster.decision !== "drop" && cluster.source !== "docs")
    .map(cluster => ({ ...cluster, key: sourceDigest(`own:${cluster.key}`).slice(7, 31) }));
  if (!load(input.context, `${name}.own.done`)) add(state.counts, "cluster.unbacked", items.length);
  return writeUnit(input, state, `${name}.own`, clusters);
}

/** Stage the pinned files the proof and the gate read, with a file index that counts learned literals. */
async function withProofContext<T>(input: PipelineInput, entries: readonly WriterEntry[], areas: readonly string[],
  run: (context: ProofContext, checked: Pick<ProofContext["check"], "checkTree" | "checkIndex">) => Promise<T>): Promise<T> {
  const { deps, context } = input;
  const { globToRegExp } = await import("../file-index/glob.js");
  const { discoverFiles } = await import("../file-index/discover.js");
  const scopeGlobs = [...new Set(entries.flatMap(entry => entry.scope))];
  const scopes = scopeGlobs.flatMap(glob => { try { return [globToRegExp(glob)]; } catch { return []; } });
  const folders = areas.map(path => path.split("/").slice(0, -1).join("/")).filter(Boolean);
  // Keep an exact repair scope readable even if the original glob reaches the staging cap.
  const wanted = new Set([...scopeGlobs, ...areas, ...entries.flatMap(entry => [entry.symbol?.file, entry.lint?.config, entry.until?.file])]
    .filter((path): path is string => path !== undefined && deps.tree.has(path)));
  for (const path of deps.tree.paths()) {
    if (wanted.has(path)) continue;
    if (scopes.some(re => re.test(path)) || folders.some(folder => path.startsWith(folder + "/")) || /(?:^|\/)(?:package\.json|AGENTS\.md|CLAUDE\.md)$/u.test(path)) {
      if (wanted.size >= PIPELINE_LIMITS.stagedFiles) { input.gaps.add("Some scopes were too large to stage in full for checking."); break; }
      wanted.add(path);
    }
  }
  const literals = entries.flatMap(entry => [...entry.when.filter(w => w.match === "literal").map(w => w.pattern)]);
  return deps.tree.withPatternCheckTree(context.writer.location.home, context.job.id, [...wanted], PIPELINE_LIMITS.stagedFiles, async (checkTree, _staged, unreadRules, coverage) => {
    if (unreadRules.length) input.gaps.add("Some rule files could not be read for duplicate checks.");
    const recordDirectory = join(checkTree, ".mex");
    const projectId = "f-" + shortHash(checkTree);
    mkdirSync(indexDirectory(recordDirectory, projectId), { recursive: true });
    registerLiterals(recordDirectory, projectId, literals);
    const discovered = await discoverFiles(checkTree);
    await buildIndex({ root: checkTree, projectId, recordDirectory, workers: 0 });
    const checked = { checkTree, checkIndex: { projectId, recordDirectory } };
    // The fix literals the proof picks are registered as they are found; the index recounts on the next build,
    // so register them up front from every draft's fix range too.
    const patternStage = { binary: coverage.binary, readable: new Set(discovered.paths.filter(path => coverage.readable.has(path))) };
    return run({ tree: deps.tree, check: { projectPath: checkTree, ...checked }, patternStage, history: gitHistory(deps.tree) }, checked);
  }) as Promise<T>;
}

async function currentCandidates({ deps, gaps }: PipelineInput, candidates: Candidate[]): Promise<Candidate[]> {
  if (!candidates.some(item => item.document)) return candidates;
  const branch = branchScope(await deps.tree.read("AGENTS.md"));
  const stale = new Map<string, boolean>();
  const out: Candidate[] = [];
  for (const item of candidates) {
    if (item.document && item.path) {
      if (!stale.has(item.path)) {
        const raw = await deps.tree.read(item.path);
        stale.set(item.path, raw !== undefined && staleDoc(item.path, raw, branch) !== undefined);
      }
      if (stale.get(item.path)) continue;
    }
    out.push(item);
  }
  if (out.length < candidates.length) gaps.add("Some historical docs were skipped.");
  return out;
}

async function unreadCandidates({ context, plan, deps }: PipelineInput, candidates: Candidate[]): Promise<Candidate[]> {
  if (!candidates.length) return candidates;
  const { writer, job } = context, project = job.project_id!;
  const team = await readTeamCoverage(plan.checkout, plan.head, plan.since);
  const fresh: Candidate[] = [];
  const docs = new Map<string, string | undefined>();
  for (const candidate of candidates) {
    const seen = (ref: SourceRef) => team.read.has(coverageKey(ref)) || sourceRead(writer, project, plan, ref);
    if (seen(candidate)) continue;
    // A legacy full-document receipt covers every passage of that exact revision.
    if (candidate.kind === "doc" && candidate.path) {
      if (!docs.has(candidate.path)) docs.set(candidate.path, await deps.tree.read(candidate.path));
      const raw = docs.get(candidate.path);
      if (raw !== undefined && seen({ ...candidate, id: `doc:${candidate.path}`, hash: sourceDigest(raw), coverage: "full" })) continue;
    }
    fresh.push(candidate);
  }
  return fresh;
}

function hasReviewHistory(plan: PipelineInput["plan"], state: PipelineState): boolean {
  return !!plan.harvest.inventory?.bands.some(band => band.source === "merged" && band.count > 0)
    || !!(state.cursor as HarvestCursor | undefined)?.sources.merged;
}

function saveTrialReceipt(context: Context, project: string, receipt: { counts: Record<string, number>; entries: TrialEntry[] }): void {
  context.writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(project, trialReceiptKey(context.job.id), JSON.stringify(receipt));
}

async function writeProcedure(input: PipelineInput, project: string, index: number, sample: ProcedureSample): Promise<number> {
  const { context, plan } = input;
  const name = `procedure.${index}`;
  const previous = load<number>(context, `${name}.done`);
  if (previous !== undefined) return previous;
  const id = producerEntryId("learn-deeper", JSON.stringify([plan.origin, "procedure", sample.roles]));
  if (tombstone(context.writer, project, id) || context.writer.setting(project, learnedRefusalKey(id))
    || snapshotNotes(context.writer, project).files.has(id)) return 0;
  const reply = await call(input, name, sample.prompt, "cheap", 0);
  const proposal = procedureProposal(sample, reply.text, reply.model, plan);
  if (!proposal) return 0;
  let count = 0;
  await withProofContext(input, [], sample.paths, async (_proof, checked) => propose([proposal], {
    projectPath: plan.checkout, home: context.writer.location.home, ...checked,
    validate(gate) {
      const live = gate.db.prepare("SELECT owner,state FROM jobs WHERE id=?").get(context.job.id);
      if (live?.owner !== context.job.owner || live?.state !== "running") throw new Error("Learning lost its job before saving.");
    },
    onAccepted(gate, accepted) {
      count = accepted.length;
      const set = gate.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
      for (const item of accepted) {
        const rows = reviewRows(gate, project, context.job.id);
        rows.push({ entryId: item.entryId, claim: item.entry.mex.one_line, label: proposal.label!, support: sample.commits.length,
          reviewers: 0, proven: false, status: "proposed", route: "procedure", signal: "weak", link: proposal.source.ref });
        saveReviewRows(set, project, context.job.id, rows);
        set.run(project, key(context.job, `trial.${item.entryId}`), JSON.stringify({ id: item.entryId, procedure: true }));
        set.run(project, noteKey(item.entryId), makeNoteProof(plan, serializeEntry(item.entry), []));
      }
      set.run(project, key(context.job, `${name}.done`), JSON.stringify(count));
    },
  }));
  return count;
}

/** One bounded unit of the run. Returns the next state, or done. */
export async function runPipelineBatch(input: PipelineInput): Promise<{ state: PipelineState; done: boolean; progress: string; results: number }> {
  const { context, plan, deps } = input;
  const state = structuredClone(input.state);
  const progress = (text: string) => context.progress?.(text);
  switch (state.phase) {
    case "harvest": {
      progress("Reading reviews, past fixes and docs");
      const batch = await harvestBatch(plan.harvest, state.cursor as HarvestCursor | undefined, { client: deps.client, tree: deps.tree });
      for (const gap of batch.gaps) input.gaps.add(gap);
      const current = await currentCandidates(input, batch.candidates);
      const candidates = input.weekly ? await unreadCandidates(input, current) : current;
      // A batch reads a few sources. They join the last chunk while nobody has sorted it: every call has a fixed cost.
      const open = state.chunks > state.triaged ? state.chunks - 1 : state.chunks;
      const fresh = new Set(candidates.map(candidate => candidate.id));
      const waiting = open < state.chunks ? (load<Candidate[]>(context, `cand.${open}`) ?? []).filter(candidate => !fresh.has(candidate.id)) : [];
      const chunks = chunkCandidates([...waiting, ...candidates]);
      chunks.forEach((chunk, i) => save(context, `cand.${open + i}`, chunk));
      state.chunks = open + chunks.length;
      for (const candidate of batch.candidates) add(state.counts, `harvested.${candidate.kind}`);
      add(state.counts, "covered-sources", current.length - candidates.length);
      add(state.counts, "historical-docs", batch.candidates.length - current.length);
      if (context.writer.setting(context.job.project_id!, "learning.prDecisions") === "true") {
        add(state.counts, "trial.pr.followed", batch.descriptions.decisions);
        add(state.counts, "trial.pr.ignored", batch.descriptions.plain);
      }
      state.cursor = batch.cursor;
      state.harvestDone = batch.done;
      const strong = chunks.flat().filter(candidate => candidate.signal === "strong").length;
      if (!state.early && (state.chunks > 1 || strong >= (deps.firstRules ?? PIPELINE_LIMITS.firstRules))) state.phase = "triage";
      else if (batch.done) state.phase = state.triaged < state.chunks ? "triage" : state.chunks ? "cluster" : "finish";
      return { state, done: false, progress: `${state.chunks} chunks of sources read`, results: 0 };
    }
    case "triage": {
      const candidates = load<Candidate[]>(context, `cand.${state.triaged}`);
      if (!candidates) throw new Error("The run's sources were cleared. Start a new quote to learn again.");
      progress(`Sorting ${candidates.length} sources`);
      const reply = await call(input, `triage.${state.triaged}`, triagePrompt(candidates), "cheap", 0);
      add(state.counts, "tokens.triage", reply.tokens);
      const outcome = parseTriage(reply.text, candidates);
      if (outcome.missing.length && !reply.lost) {
        // What the reply left out, or all of an unreadable one, is asked for once more. The cursor is already past it.
        const left = candidates.filter(candidate => outcome.missing.includes(candidate.id));
        const again = await retry(input, `triage.${state.triaged}.again`, triagePrompt(left), "cheap", 0);
        if (again) {
          add(state.counts, "tokens.triage", again.tokens);
          const second = parseTriage(again.text, left);
          outcome.results.push(...second.results);
          outcome.missing = second.missing;
          if (second.response === "valid") outcome.response = "valid";
        }
      }
      if (outcome.response !== "valid") input.gaps.add("A triage batch returned no readable answer.");
      save(context, `triage.${state.triaged}`, outcome.results);
      const { kept, dropped } = triageCounts(outcome.results);
      add(state.counts, "triage-kept", kept);
      const issueIds = new Set(candidates.filter(candidate => candidate.kind === "issue").map(candidate => candidate.id));
      add(state.counts, "trial.issues", outcome.results.filter(result => result.keep && issueIds.has(result.id)).length);
      for (const [category, n] of Object.entries(dropped)) add(state.counts, `triage-dropped.${category}`, n);
      add(state.counts, "triage-missing", outcome.missing.length);
      state.triaged++;
      let results = 0;
      if (!state.early) {
        // First rules early. Strong items of this batch are written now. A batch that kept none
        // still spends the early writer call on its best-supported items, saved as waiting rules.
        const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
        const kept: Triaged[] = outcome.results.flatMap(result => {
          const candidate = byId.get(result.id);
          return result.keep && candidate ? [{ candidate, triage: result }] : [];
        });
        const picked = earlyLessons(kept, PIPELINE_LIMITS.earlyRules);
        let grouped = load<{ clusters: Cluster[]; counts: PipelineState["counts"]; gaps: string[] }>(context, "early.grouped");
        if (!grouped) {
          const refusals = reviewRefusals(context.writer, context.job.project_id!, plan);
          const counts: PipelineState["counts"] = {};
          const clusters = markEarlyWaiting(await groupLessons(input, counts, "early", picked.items, refusals.earlier), picked.waiting)
            .filter(cluster => !refusals.cluster(cluster));
          grouped = { clusters, counts, gaps: [...input.gaps] };
          save(context, "early.grouped", grouped);
        }
        const { clusters, counts, gaps } = grouped;
        for (const [metric, n] of Object.entries(counts)) add(state.counts, metric, n);
        for (const gap of gaps) input.gaps.add(gap);
        if (clusters.length) {
          progress(picked.waiting ? `Writing the first ${clusters.length} rules, waiting for a tick` : `Writing the first ${clusters.length} rules`);
          results = await writeUnit(input, state, "early", clusters);
          save(context, "early.members", clusters.flatMap(cluster => cluster.members.map(member => member.candidate.id)));
        }
        state.early = true;
      }
      if (state.harvestDone === false) state.phase = "harvest";
      else if (state.triaged >= state.chunks) state.phase = "cluster";
      return { state, done: false, progress: `${state.triaged} of ${state.chunks} source chunks sorted`, results };
    }
    case "cluster": {
      progress("Grouping lessons across the whole window");
      const items: Triaged[] = [];
      for (let i = 0; i < state.chunks; i++) {
        const candidates = new Map((load<Candidate[]>(context, `cand.${i}`) ?? []).map(candidate => [candidate.id, candidate]));
        for (const triage of load<TriageResult[]>(context, `triage.${i}`) ?? []) {
          const candidate = candidates.get(triage.id);
          if (candidate) items.push({ candidate, triage });
        }
      }
      const early = new Set(load<string[]>(context, "early.members") ?? []);
      const refusals = reviewRefusals(context.writer, context.job.project_id!, plan);
      const waiting = new Set(refusals.earlier.filter(entry => entry.waiting).map(entry => entry.id));
      const clusters = await groupLessons(input, state.counts, "cluster", items, refusals.earlier);
      for (const cluster of clusters) add(state.counts, `cluster.${cluster.decision}`);
      const eligible = clusters.filter(cluster => !refusals.cluster(cluster));
      add(state.counts, "cluster.forgotten", clusters.length - eligible.length);
      const write = applyDocQuota(eligible, 0.25, hasReviewHistory(plan, state)).filter(cluster => cluster.decision !== "drop"
        && !(cluster.earlier && waiting.has(cluster.earlier) && cluster.pulls.length < 2)
        // Written early already, kept or not: the same evidence would be paid for twice.
        && !alreadyWrittenEarly(cluster, early));
      // Count accepted review and history entries before spending on docs.
      const writerContext = { linters: linters(deps.tree) };
      const batches = [write.filter(cluster => cluster.source !== "docs"), write.filter(cluster => cluster.source === "docs")]
        .flatMap(group => packClusters(group, writerContext));
      batches.forEach((batch, i) => save(context, `clusters.${i}`, batch));
      state.batches = batches.length;
      state.phase = batches.length ? "write" : "finish";
      return { state, done: false, progress: `${write.length} lessons to write`, results: 0 };
    }
    case "write": {
      const clusters = load<Cluster[]>(context, `clusters.${state.written}`);
      if (!clusters) throw new Error("The run's sources were cleared. Start a new quote to learn again.");
      const quota = Math.max(0, Math.floor((state.counts["saved-other"] ?? 0) / 3) - (state.counts["saved-docs"] ?? 0));
      const selected = hasReviewHistory(plan, state) && clusters[0]?.source === "docs" ? clusters.slice(0, quota) : clusters;
      add(state.counts, "doc-quota", clusters.length - selected.length);
      progress(`Writing and checking ${selected.length} lessons`);
      const results = await writeUnit(input, state, `batch.${state.written}`, selected);
      state.written++;
      if (state.written >= state.batches) state.phase = "finish";
      return { state, done: false, progress: `${state.written} of ${state.batches} writer batches checked`, results };
    }
    case "finish": {
      const project = context.job.project_id!;
      if (plan.procedures && context.writer.setting(project, "learning.procedures") === "true") {
        state.counts["trial.procedures"] ??= 0;
        const existing = load<ProcedureSample[]>(context, "procedures");
        const samples = existing ?? await procedureSamples(context.writer, project, deps.tree);
        if (!existing) save(context, "procedures", samples);
        const index = state.procedures ?? 0;
        const sample = samples[index];
        if (sample) {
          progress(`Naming procedure ${index + 1} of ${samples.length}`);
          const accepted = await writeProcedure(input, project, index, sample);
          state.procedures = index + 1;
          add(state.counts, "trial.procedures", accepted);
          return { state, done: false, progress: `${index + 1} of ${samples.length} procedure samples checked`, results: accepted };
        }
      }
      const entries = context.writer.db.prepare("SELECT value FROM settings WHERE scope=? AND substr(key,1,?)=? ORDER BY key")
        .all(project, key(context.job, "trial.").length, key(context.job, "trial."))
        .map(row => JSON.parse(String(row.value)) as TrialEntry);
      add(state.counts, "trial.linter", entries.filter(entry => entry.linter).length);
      add(state.counts, "trial.alternatives", entries.reduce((total, entry) => total + (entry.alternatives ?? 0), 0));
      const counts = Object.fromEntries(Object.entries(state.counts).filter(([name]) => name.startsWith("trial.")));
      if (plan.harvest.issues) { counts["trial.issues"] ??= 0; state.counts["trial.issues"] ??= 0; }
      if (entries.length || Object.keys(counts).length) saveTrialReceipt(context, project, { counts, entries });
      return { state, done: true, progress: "Done", results: 0 };
    }
  }
}
