import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { buildIndex } from "../file-index/build.js";
import { indexDirectory } from "../file-index/store.js";
import { registerLiterals } from "../knowledge/check.js";
import { isLearnedEntry, parseEntry, serializeEntry } from "../knowledge/entry.js";
import { propose } from "../knowledge/gate.js";
import { learnedRefused, learnedRefusalKey, learnedWaitingKey } from "../knowledge/mutations.js";
import { readNotes, snapshotNotes } from "../knowledge/personal-store.js";
import { producerEntryId } from "../knowledge/producers.js";
import { claimHash, retiredClaimHashes, tombstone } from "../knowledge/state.js";
import { ModelWaitError, type runModel } from "../model-runner/index.js";
import { modelAgent } from "../model-runner/agents.js";
import { recoverModelBatches, withModelJob } from "../model-runner/budget-queue.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import type { RecordWriter } from "../record/index.js";
import type { BatchContext } from "../record/jobs.js";
import { learningRunPrefix } from "../record/learning-rows.js";
import { shortHash } from "../record/project.js";
import { activityFor, sourceSubject, stageOfCall, type DeepActivity, type Subject } from "./activity.js";
import { rememberNote, rememberObservationLinks, rememberObservations, rememberSetting } from "./cancel.js";
import { coverageKey, learningProof, makeNoteProof, noteKey, readTeamCoverage, saveSourceReads, sourceRead, type SourceRef } from "./coverage.js";
import { dispositionKey, mergeDispositions, readDispositions, type CandidateDisposition } from "./dispositions.js";
import type { WriterModel } from "./entries.js";
import type { PinnedTree } from "./git.js";
import { PATTERNS_PER_BATCH, packDocumentSources } from "./harvest/estimate.js";
import { harvestBatch } from "./harvest/index.js";
import type { Candidate, HarvestCursor, HarvestDeps, HarvestPlan } from "./harvest/types.js";
import { branchScope, staleDoc } from "./history-docs.js";
import { networkGroups, networkProofKey, networkRowKey, readNetworkGroups } from "./network-proof.js";
import { collectGateEvidence, gateBatches, gatePrompt, parseGate, type GateRule, type GateVerdict } from "./norm-gate.js";
import { docsPrompt, normPrompt, packObservations, parseDocs, parseNorms, type Draft, type EarlierNorm } from "./norm-writer.js";
import { observationCutoff, readObservations, saveObservations, supportObservations } from "./observations.js";
import { LEARN_KIND, promptEstimate, type LearningPlan } from "./plan.js";
import { packUnits, prUnits, renderUnits, type PRUnit } from "./pr-units.js";
import { procedureProposal, procedureSamples, type ProcedureSample } from "./procedures.js";
import { gitHistory, proveEntry, stoppingType, type ProofContext, type ProofResult } from "./prove.js";
import { routeEntry, type Routed } from "./route.js";
import { sourceDigest, type Repository } from "./source.js";
import { parseTriage, triagePrompt, type Observation } from "./triage.js";
import { replyJson } from "./reply.js";
import { sessionsActive } from "./weekly-schedule.js";
import { evidencePairs, parsePatterns, patternPrompt, type PatternInput, type WriterEntry } from "./write.js";

export const PIPELINE_LIMITS = { stagedFiles: 2000 } as const;
export const Phase = z.enum(["harvest", "triage", "write", "finish"]);
export const trialReceiptKey = (jobId: string) => "learning.deep.trials." + jobId;
type TrialEntry = { id: string; issues?: number; procedure?: true; learned?: true; linter?: true; alternatives?: number };
export const PipelineState = z.object({
  version: z.literal(22), phase: Phase, cursor: z.unknown().optional(),
  chunks: z.number().int().nonnegative(), harvestDone: z.boolean(), triaged: z.number().int().nonnegative(),
  early: z.boolean(), batches: z.number().int().nonnegative(), written: z.number().int().nonnegative(),
  counts: z.record(z.string().max(64), z.number().finite().nonnegative()),
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
  ({ version: 22, phase: "harvest", cursor, chunks: 0, triaged: 0, early: false, harvestDone: false, batches: 0, written: 0, counts: {} });

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
  /** The live view's state for this batch, and what the next model call reads. Observing never holds up the job. */
  activityState?: PipelineState;
  subject?: Subject;
}

const key = (job: { id: string }, name: string) => learningRunPrefix(job.id) + name;
export function publishedBatch(reader: Pick<RecordWriter, "setting">, job: Context["job"]): boolean {
  if (!job.checkpoint || !job.project_id) return false;
  const parsed = PipelineState.safeParse(JSON.parse(job.checkpoint).v2);
  if (!parsed.success) return false;
  const { phase, early } = parsed.data;
  const name = phase === "write" ? "window" : phase === "triage" && !early ? "early" : undefined;
  return !!name && !!reader.setting(job.project_id, key(job, name + ".done"));
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

/** A durable per-candidate reason. The key is not job-scoped, so cleanup keeps it. */
function noteDispositions(context: Context, rows: readonly CandidateDisposition[]): void {
  if (!rows.length || !context.job.project_id) return;
  const project = context.job.project_id;
  const stored = dispositionKey(context.job.id);
  const merged = mergeDispositions(readDispositions(context.writer.setting(project, stored)), rows);
  const saved = context.writer.db.prepare(`INSERT INTO settings(scope,key,value)
    SELECT ?,?,? FROM jobs WHERE id=? AND owner=? AND state='running'
    ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value`)
    .run(project, stored, JSON.stringify(merged), context.job.id, context.job.owner);
  if (!saved.changes) throw new Error("Learning lost its job before saving.");
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

function updateActivity(input: PipelineInput, item?: Subject, result?: string, stage?: number): void {
  const { context, plan, deps, activityState } = input;
  if (!activityState) return;
  try {
    const old = load<DeepActivity>(context, "activity");
    const recent = item && result ? [{ ...item, result }, ...(old?.recent ?? [])].slice(0, 5) : old?.recent;
    const activity = activityFor(activityState, plan.agent, old?.startedAt ?? new Date(deps.now()).toISOString(),
      recordedModelSpend(context.writer, context.job.id), recent, stage);
    if (item && !result) activity.current = { ...item, startedAt: new Date(deps.now()).toISOString() };
    save(context, "activity", activity);
  } catch { /* Observing a job cannot hold up the job. */ }
}

/** What the live view says a finished call returned, from the reply's own shape. */
function replySummary(text: string): string {
  const parsed = replyJson(text);
  const list = (name: string) => {
    const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[name] : undefined;
    return Array.isArray(value) ? value.length : undefined;
  };
  const observations = list("observations"), norms = list("norms"), rules = list("rules"), patterns = list("patterns"), verdicts = list("verdicts");
  if (observations !== undefined) return `${observations} observations kept`;
  if (norms !== undefined || rules !== undefined) return `${(norms ?? 0) + (rules ?? 0)} rules drafted`;
  if (patterns !== undefined) return `${patterns} patterns proposed`;
  if (verdicts !== undefined) return `${verdicts} rules checked`;
  return "Reply received";
}

/** One model call under the run's consent: the approved ceiling, or weekly's automatic allowance. */
interface Reply { text: string; model: WriterModel; tokens: number; lost?: true; promptHash?: string }
async function call(input: PipelineInput, name: string, prompt: string, role: "cheap" | "best", rules: number): Promise<Reply> {
  const { context, plan, deps, weekly } = input;
  const promptHash = sourceDigest(prompt);
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
  const step = stageOfCall(name);
  const subject = input.subject ?? { subject: "Rules and evidence" };
  updateActivity(input, subject, undefined, step);
  const reply = await deps.tree.withCheckFiles(writer.location.home, job.id, [], async executionDirectory => {
    const output = await withModelJob({ jobId: job.id, batch: job.batch, projectId: job.project_id,
      recordHome: writer.location.home, stage }, () => deps.model({
      agent: modelAgent(plan.agent), setup: procedure ? "mixed" : plan.setup, role, projectRoot: plan.checkout, executionDirectory, allowNonGit: true,
      purpose: procedure ? "learn-deeper-procedure" : role === "cheap" ? "learn-deeper-filter" : LEARN_KIND, prompt,
      ...(weekly || procedure ? { automatic: { estimate, measuredUsageOnly: true } } : { consented: { ceiling: plan.ceiling, estimate } }),
    }));
    const { writerModel } = await import("./job.js");
    const reply: Reply = { text: output.text, model: writerModel(output), tokens: Math.max(0, recordedModelSpend(writer, job.id) - spent), promptHash };
    save(context, `reply.${name}`, reply);
    return reply;
  }).catch(error => {
    updateActivity(input, subject, "Paused or interrupted", step);
    throw error;
  });
  if (!reply) throw new Error("The model could not start in its private workspace.");
  updateActivity(input, subject, replySummary(reply.text), step);
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

function candidateRef(plan: LearningPlan, candidate: Candidate): SourceRef {
  const { id, hash, link } = candidate;
  if (!candidate.document || !candidate.path) return { id, hash, link };
  const { host, slug } = plan.origin;
  const path = candidate.path.split("/").map(encodeURIComponent).join("/");
  const fragment = link.slice(link.indexOf("#") + 1);
  return { id, hash, link: `https://${host}/${slug}/${host === "gitlab.com" ? "-/" : ""}blob/${plan.head}/${path}#${fragment}` };
}

async function withProofContext<T>(input: PipelineInput, entries: readonly WriterEntry[], areas: readonly string[],
  run: (context: ProofContext, checked: Pick<ProofContext["check"], "checkTree" | "checkIndex">) => Promise<T>,
  checkLiterals: readonly string[] = []): Promise<T> {
  const { deps, context } = input;
  const { globToRegExp } = await import("../file-index/glob.js");
  const { discoverFiles } = await import("../file-index/discover.js");
  const scopeGlobs = [...new Set(entries.flatMap(entry => entry.scope.filter(scope => scope !== "**" || entry.when.length)))];
  const scopes = scopeGlobs.flatMap(glob => { try { return [globToRegExp(glob)]; } catch { return []; } });
  // Keep an exact repair scope readable even if the original glob reaches the staging cap.
  const wanted = new Set([...scopeGlobs, ...areas, ...entries.flatMap(entry => [entry.symbol?.file, entry.lint?.config, entry.until?.file])]
    .filter((path): path is string => path !== undefined && deps.tree.has(path)));
  for (const path of deps.tree.paths()) {
    if (wanted.has(path)) continue;
    if (scopes.some(re => re.test(path)) || /(?:^|\/)(?:package\.json|AGENTS\.md|CLAUDE\.md)$/u.test(path)) {
      if (wanted.size >= PIPELINE_LIMITS.stagedFiles) { input.gaps.add("Some scopes were too large to stage in full for checking."); break; }
      wanted.add(path);
    }
  }
  // A repo-wide prose scope only needs a live file for its presence check.
  if (entries.some(entry => entry.scope.includes("**")) && !wanted.size) {
    const first = deps.tree.paths()[Symbol.iterator]().next().value;
    if (first) wanted.add(first);
  }
  const literals = [...checkLiterals, ...entries.flatMap(entry => entry.when.filter(w => w.match === "literal").map(w => w.pattern))];
  return deps.tree.withPatternCheckTree(context.writer.location.home, context.job.id, [...wanted], PIPELINE_LIMITS.stagedFiles, async (checkTree, _staged, unreadRules, coverage) => {
    if (unreadRules.length) input.gaps.add("Some rule files could not be read for duplicate checks.");
    const recordDirectory = join(checkTree, ".mex");
    const projectId = "f-" + shortHash(checkTree);
    mkdirSync(indexDirectory(recordDirectory, projectId), { recursive: true });
    registerLiterals(recordDirectory, projectId, literals);
    const discovered = await discoverFiles(checkTree);
    await buildIndex({ root: checkTree, projectId, recordDirectory, workers: 0 });
    const checked = { checkTree, checkIndex: { projectId, recordDirectory } };
    const patternStage = { binary: coverage.binary, readable: new Set(discovered.paths.filter(path => coverage.readable.has(path))) };
    return run({ tree: deps.tree, check: { projectPath: checkTree, ...checked }, patternStage, history: gitHistory(deps.tree), gaps: input.gaps }, checked);
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

export const learnedTrialKey = (id: string) => "learning.deep.trial." + id;

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
        const raw = serializeEntry(item.entry), proof = makeNoteProof(plan, raw, []);
        rememberNote(gate, context.job, item.entryId, undefined, raw);
        rememberSetting(gate, context.job, noteKey(item.entryId), proof);
        set.run(project, noteKey(item.entryId), proof);
      }
      set.run(project, key(context.job, `${name}.done`), JSON.stringify(count));
    },
  }));
  return count;
}


function ensureOwner(input: PipelineInput, writer = input.context.writer): void {
  const { plan, context: { job }, deps } = input;
  const live = writer.db.prepare("SELECT owner,state FROM jobs WHERE id=?").get(job.id);
  const checkout = writer.checkout(plan.checkout);
  if (live?.owner !== job.owner || live?.state !== "running" || !checkout || checkout.project_id !== job.project_id
    || !checkoutOn(checkout, deps.now()) || !automaticWorkEnabled(writer, job.project_id, deps.now())) {
    throw new Error("Learning lost its job before saving.");
  }
}

function cutoff({ context, deps }: PipelineInput): string {
  return observationCutoff(deps.now(), context.writer.setting(context.job.project_id!, "learning.deep.observationDays"));
}

function saveChecked(input: PipelineInput, items: readonly Observation[]): void {
  const { db } = input.context.writer, project = input.context.job.project_id!;
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureOwner(input);
    rememberObservations(input.context.writer, input.context.job, saveObservations(db, project, items, cutoff(input)));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function allCandidates(context: Context, state: PipelineState): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (let i = 0; i < state.chunks; i++) for (const value of load<Candidate[]>(context, "cand." + i) ?? []) candidates.set(value.id, value);
  return [...candidates.values()];
}

const lineKey = (item: PRUnit["lines"][number]) => JSON.stringify([item.candidate, item.line.id]);

async function triage(input: PipelineInput, state: PipelineState, units: readonly PRUnit[],
  candidates: ReadonlyMap<string, Candidate>, name: string, half = false): Promise<Observation[]> {
  const prompt = triagePrompt(units);
  const read = async (suffix: string, optional: boolean) => {
    const result = await (optional ? retry : call)(input, name + suffix, prompt, "cheap", 0);
    if (!result) return;
    add(state.counts, "tokens.triage", result.tokens);
    add(state.counts, "calls.triage");
    return { parsed: parseTriage(result.text, units, candidates), lost: result.lost };
  };
  const first = await read("", false);
  const invalid = (result: typeof first) => result?.parsed.response !== "valid";
  const empty = (result: typeof first) => !result?.parsed.observations.length;
  // An empty answer on a large batch can mean the model skimmed it, so the batch is split once. The halves' answers
  // stand: stretches of PRs with no team expectation are common, and every call has a fixed cost of thousands of tokens.
  const large = !half && units.length > 1 && renderUnits(units).text.length >= 24_000;
  let result = first;
  if (!first?.lost && invalid(first)) result = await read(".retry", true) ?? first;
  if (large && !result?.lost && (invalid(result) || empty(result))) {
    add(state.counts, "triage-splits");
    const half = Math.floor(units.length / 2);
    return [...await triage(input, state, units.slice(0, half), candidates, name + ".a", true),
      ...await triage(input, state, units.slice(half), candidates, name + ".b", true)];
  }
  for (const [reason, count] of Object.entries(result?.parsed.drops ?? {})) add(state.counts, "triage-dropped." + reason, count);
  if (invalid(result)) {
    add(state.counts, "triage-dropped." + (result?.parsed.response ?? "no-reply"));
    input.gaps.add("Some PR discussions could not be sorted.");
  }
  return result?.parsed.observations ?? [];
}

interface SavedNorm extends EarlierNorm {
  raw: string;
  entry: ReturnType<typeof parseEntry>;
  proof: ReturnType<typeof learningProof>;
}

function priorNorms(input: PipelineInput): SavedNorm[] {
  const { context: { writer, job }, plan } = input, project = job.project_id!;
  const out: SavedNorm[] = [];
  for (const [id, raw] of snapshotNotes(writer, project).files) {
    try {
      const entry = parseEntry(raw);
      if (!isLearnedEntry(entry.mex)) continue;
      const refused = !!tombstone(writer, project, id) || learnedRefused(writer, project, entry, raw) || entry.mex.status === "retired";
      const proof = learningProof(plan, raw, writer.setting(project, noteKey(id)));
      if (proof || refused) out.push({ id, raw, entry, claim: entry.mex.one_line, refused, proof });
    } catch { /* Malformed entries cannot support a norm. */ }
  }
  return out.sort((a, b) => Number(b.refused) - Number(a.refused) || b.entry.mex.created.localeCompare(a.entry.mex.created));
}

function rememberMetrics(counts: PipelineState["counts"], key: string, drops: Record<string, number>): void {
  for (const [reason, number] of Object.entries(drops)) add(counts, key + "." + reason, number);
}

async function writeDrafts(input: PipelineInput, name: string, counts: PipelineState["counts"], observations: readonly Observation[],
  candidates: readonly Candidate[], prior: readonly EarlierNorm[]): Promise<Array<Draft & { model: WriterModel }>> {
  const paths = [...input.deps.tree.paths()];
  const map = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const drafts: Array<Draft & { model: WriterModel }> = [];
  for (const [i, batch] of packObservations(observations, prior).entries()) {
    const reply = await call(input, "norm." + name + "." + i, normPrompt(batch, prior), "best", Math.min(48, Math.ceil(batch.length / 3)));
    add(counts, "tokens.norm", reply.tokens);
    add(counts, "calls.norm");
    const parsed = parseNorms(reply.text, batch, prior, map, paths);
    rememberMetrics(counts, "norm-dropped", parsed.drops);
    add(counts, "norms", parsed.drafts.length);
    drafts.push(...parsed.drafts.map(draft => ({ ...draft, model: reply.model })));
  }
  const documents = name === "early" ? [] : candidates.filter(candidate => candidate.kind === "doc" && !candidate.document?.consumerUsage);
  for (const [i, batch] of packDocumentSources(documents).entries()) {
    const reply = await call(input, "docs." + i, docsPrompt(batch), "best", Math.min(48, batch.length));
    add(counts, "tokens.docs", reply.tokens);
    add(counts, "calls.docs");
    const parsed = parseDocs(reply.text, batch, paths);
    rememberMetrics(counts, "doc-dropped", parsed.drops);
    add(counts, "doc-rules", parsed.drafts.length);
    drafts.push(...parsed.drafts.map(draft => ({ ...draft, model: reply.model })));
  }
  return drafts;
}

async function proveDrafts(input: PipelineInput, name: string, counts: PipelineState["counts"], drafts: Awaited<ReturnType<typeof writeDrafts>>) {
  const queue: PatternInput[] = drafts.flatMap(({ entry, support, patternable }) => {
    const stop = stoppingType(entry), pairs = evidencePairs(support.members);
    return patternable && stop && pairs.length && !support.earlier ? [{ id: support.key, claim: entry.claim, scope: entry.scope, stop, pairs }] : [];
  });
  const proofs = new Map<string, ProofResult>();
  const context = { tree: input.deps.tree, check: { projectPath: input.plan.checkout }, gaps: input.gaps };
  for (let start = 0; start < queue.length; start += PATTERNS_PER_BATCH) {
    const list = queue.slice(start, start + PATTERNS_PER_BATCH);
    const stage = "pattern." + name + "." + start;
    const reply = await call(input, stage, patternPrompt(list), "best", list.length);
    add(counts, "calls.pattern");
    add(counts, "tokens.pattern", reply.tokens);
    let fields = parsePatterns(reply.text, list);
    const prove = async (items: PatternInput[]) => {
      const pending = items.flatMap(({ id }) => {
        const pattern = fields.get(id), draft = drafts.find(item => item.support.key === id);
        return pattern && draft ? [{ support: draft.support, entry: { ...draft.entry, ...pattern } }] : [];
      });
      if (!pending.length) return;
      await withProofContext(input, pending.map(item => item.entry), pending.flatMap(item => item.support.members.flatMap(member =>
        member.candidate.path ? [member.candidate.path] : [])), async proof => {
        for (const item of pending) proofs.set(item.support.key, await proveEntry(item.entry, item.support, proof));
      });
    };
    await prove(list);
    const repairs = list.flatMap(item => {
      const proof = proofs.get(item.id), previous = fields.get(item.id);
      return proof && previous?.when.length && !proof.when.length && !proof.dropped
        ? [{ ...item, previous: { fields: previous, failures: proof.failures } }] : [];
    });
    if (repairs.length) {
      const repair = await retry(input, stage + ".repair", patternPrompt(repairs), "best", repairs.length);
      if (repair) {
        add(counts, "calls.pattern-repair");
        add(counts, "tokens.pattern", repair.tokens);
        fields = parsePatterns(repair.text, repairs);
        await prove(repairs);
      }
    }
  }
  return Promise.all(drafts.map(async draft => ({
    draft, proof: proofs.get(draft.support.key) ?? await proveEntry(draft.entry, draft.support, context),
  })));
}

async function evaluateDrafts(input: PipelineInput, name: string, counts: PipelineState["counts"],
  rules: GateRule[], earlier: readonly EarlierNorm[]): Promise<Map<string, GateVerdict>> {
  const verdicts = new Map<string, GateVerdict>();
  if (!rules.length) return verdicts;
  const evidence = await collectGateEvidence(input.deps.tree, rules, earlier.filter(rule => !rule.refused));
  for (const [i, batch] of gateBatches(rules, evidence).entries()) {
    const apply = (text: string, requested: readonly GateRule[]) => {
      const outcome = parseGate(text, requested);
      for (const result of outcome.results) if (requested.some(rule => rule.id === result.id)) verdicts.set(result.id, result.verdict);
      return requested.filter(rule => outcome.missing.includes(rule.id) || !verdicts.has(rule.id));
    };
    const stage = "gate." + name + "." + i;
    const reply = await call(input, stage, gatePrompt(batch, evidence), "best", batch.length);
    add(counts, "calls.gate");
    add(counts, "tokens.gate", reply.tokens);
    const missing = reply.lost ? [...batch] : apply(reply.text, batch);
    if (missing.length && !reply.lost) {
      const again = await retry(input, stage + ".retry", gatePrompt(missing, evidence), "best", missing.length);
      if (again) {
        add(counts, "calls.gate");
        add(counts, "tokens.gate", again.tokens);
        if (!again.lost) apply(again.text, missing);
      }
    }
  }
  for (const rule of rules) add(counts, "gate." + (verdicts.get(rule.id) ?? "missing"));
  return verdicts;
}

type DraftToPublish = { routed: Routed; draft: Draft; proofWhen: WriterEntry["when"]; earlier?: SavedNorm };

async function publishDrafts(input: PipelineInput, name: string, drafts: DraftToPublish[], counts: PipelineState["counts"]): Promise<number> {
  const { context, plan, deps } = input, project = context.job.project_id!;
  const retired = retiredClaimHashes(context.writer, project);
  drafts = drafts.filter(({ routed, draft, earlier }) => {
    if (earlier?.refused || retired.has(claimHash(routed.proposal.oneLine ?? "")) || retired.has(claimHash(routed.proposal.text))) {
      add(counts, "producer-dropped.forgotten");
      return false;
    }
    return !(earlier && draft.support.refused);
  });
  const publications = drafts.filter(item => !item.earlier);
  const proposals = publications.map(item => item.routed.proposal);
  const byId = new Map(publications.map(item => {
    const p = item.routed.proposal;
    return [p.id ?? producerEntryId(p.producer, p.key), item];
  }));
  const current = new Set(allCandidates(context, input.state).map(candidate => candidate.id));
  let saved = 0;
  const areas = publications.flatMap(item => item.routed.sources.flatMap(member => member.path ? [member.path] : []));
  let live: ReadonlyMap<string, string> | undefined;
  const record = (gate: RecordWriter, item: DraftToPublish, entry: ReturnType<typeof parseEntry>, raw: string, prior?: SavedNorm) => {
    const id = entry.mex.id, support = item.draft.support;
    const previous = prior?.proof;
    const originIds = new Map(support.observations.map(observation => [observation.id, observation.source.id]));
    const sources = item.routed.sources.map(candidate => candidateRef(plan, { ...candidate, id: originIds.get(candidate.id) ?? candidate.id }));
    const refs = [...new Map([...(previous?.sources ?? []), ...sources].map(ref => [ref.id, ref])).values()].slice(-8);
    const day = [...item.routed.sources.map(candidate => candidate.at.slice(0, 10)), previous?.evidenceDay ?? ""].sort().at(-1);
    const combined = {
      pulls: [...new Set([...(previous?.support?.pulls ?? []), ...support.pulls])].slice(-256),
      commits: [...new Set([...(previous?.support?.commits ?? []), ...support.commits])].slice(-256),
      reviewers: [...new Set([...(previous?.support?.reviewers ?? []), ...support.reviewerKeys])].slice(-256),
    };
    const upsert = gate.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
    // Every durable write outside the run's own rows is journaled, so a cancelled run leaves nothing behind.
    const set = { run: (scope: string, name: string, value: string) => {
      if (!name.startsWith(learningRunPrefix(context.job.id))) rememberSetting(gate, context.job, name, value);
      return upsert.run(scope, name, value);
    } };
    if (!prior) rememberNote(gate, context.job, id, undefined, raw);
    set.run(project, noteKey(id), makeNoteProof(plan, raw, refs, day || undefined, combined));
    saveSourceReads(gate, project, plan, sources, (name, value) => rememberSetting(gate, context.job, name, value));
    const linked = support.observations.map(observation => observation.id);
    rememberObservationLinks(gate, context.job, id, linked);
    supportObservations(gate.db, project, id, linked);
    if (!prior) {
      const groups = networkGroups(entry, item.routed.sources);
      set.run(project, networkProofKey(id), JSON.stringify(groups));
      for (const group of groups) if (group.complete && item.routed.sources.some(source =>
        source.link === group.url && source.hash === group.hash && current.has(originIds.get(source.id) ?? source.id))) {
        set.run(project, networkRowKey(group.url, group.hash), JSON.stringify({ state: "same", at: new Date(deps.now()).toISOString() }));
      }
      if (entry.mex.status === "active") set.run(project, learnedTrialKey(id), "trial");
      const rows = new Map(reviewRows(gate, project, context.job.id).map(row => [row.entryId, row]));
      const proven = item.routed.proven;
      rows.set(id, { entryId: id, claim: entry.mex.one_line, label: entry.mex.source.label ?? "", support: combined.pulls.length,
        reviewers: combined.reviewers.length, proven, status: entry.mex.status,
        route: item.routed.route, signal: combined.pulls.length >= 2 || proven ? "strong" : "weak", link: entry.mex.source.ref });
      saveReviewRows(upsert, project, context.job.id, [...rows.values()]);
      add(counts, proven ? "proven" : "prose");
      if (item.routed.route === "code-rule" && support.source !== "docs") {
        add(counts, "code-norms");
        if (proven) add(counts, "proven-code-norms");
      }
      if (entry.mex.status === "proposed") add(counts, "proposed");
      if (item.routed.convertedPitfall) add(counts, "pitfall-as-rule");
      const linter = !proven && item.draft.entry.lint && entry.text.includes("enable `" + item.draft.entry.lint.rule + "`");
      const alternatives = item.draft.entry.alternatives?.filter(item => entry.text.includes("Considered and ruled out: " + item.option + " (")).length;
      const issues = item.routed.sources.filter(source => source.kind === "issue").length;
      if (issues || linter || alternatives || entry.mex.status === "active") set.run(project, key(context.job, "trial." + id),
        JSON.stringify({ id, ...(issues ? { issues } : {}), ...(linter ? { linter: true } : {}),
          ...(alternatives ? { alternatives } : {}), ...(entry.mex.status === "active" ? { learned: true } : {}) }));
    }
    saved++;
  };
  const publish = async (checked: Pick<ProofContext["check"], "checkTree" | "checkIndex"> = {}) =>
    propose(proposals, {
      projectPath: plan.checkout, home: context.writer.location.home, ...checked,
      validate(gate) {
        ensureOwner(input, gate);
        if (gate.setting(project, key(context.job, name + ".done"))) throw new Error("Learning already saved this batch.");
        const suppressed = new Set(readObservations(gate.db, project, cutoff(input)).filter(item => item.forgotten).map(item => item.id));
        if (drafts.some(item => item.draft.support.observations.some(observation => suppressed.has(observation.id)))) {
          throw new Error("A supporting observation was forgotten while learning.");
        }
        // The note store is sealed for readers by the time the acceptance callback runs.
        live = drafts.some(item => item.earlier) ? readNotes(gate.location.home, project).files : undefined;
      },
      onAccepted(gate, accepted, results) {
        for (const acceptedEntry of accepted) {
          const selected = byId.get(acceptedEntry.entryId);
          if (selected) record(gate, selected, acceptedEntry.entry, serializeEntry(acceptedEntry.entry));
        }
        for (const selected of drafts) {
          const old = selected.earlier;
          if (!old || live?.get(old.id) !== old.raw || tombstone(gate, project, old.id) || learnedRefused(gate, project, old.entry, old.raw)) continue;
          record(gate, selected, old.entry, old.raw, old);
          add(counts, "support-updates");
        }
        for (const result of results) if (result.status === "dropped") add(counts, "producer-dropped." + result.reason);
        add(counts, "saved", saved);
        counts["proven-share"] = (counts["proven-code-norms"] ?? 0) / Math.max(1, counts["code-norms"] ?? 0);
        const set = gate.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
        set.run(project, key(context.job, name + ".done"), JSON.stringify({ saved, counts, gaps: [...input.gaps] }));
      },
    });
  const checkLiterals = proposals.flatMap(proposal => (proposal.checks ?? []).flatMap(check =>
    check.kind === "pattern" && check.target.match === "literal" ? [check.target.pattern] : []));
  if (proposals.length) await withProofContext(input, publications.map(item => ({ ...item.draft.entry,
    scope: item.routed.proposal.anchors?.scope ?? [], when: item.proofWhen })), areas, (_proof, checked) => publish(checked), checkLiterals);
  else await publish();
  return saved;
}

async function writeWindow(input: PipelineInput, state: PipelineState, name: string, candidates: readonly Candidate[],
  observations: readonly Observation[]): Promise<number> {
  const saved = load<{ saved: number; counts: PipelineState["counts"]; gaps: string[] }>(input.context, name + ".done");
  if (saved) {
    state.counts = { ...saved.counts };
    for (const gap of saved.gaps) input.gaps.add(gap);
    return saved.saved;
  }
  const project = input.context.job.project_id!;
  const stored = readObservations(input.context.writer.db, project, cutoff(input));
  const current = new Set(observations.map(observation => observation.id));
  const eligible = stored.filter(item => !item.forgotten && (!item.normId || current.has(item.id)));
  // Early publication reads only the first batch; the full window may
  // still promote otherwise unsupported one-off observations later.
  const selected = observations.length ? eligible.filter(item => name !== "early" || current.has(item.id)) : [];
  const savedNorms = priorNorms(input);
  const earlier = savedNorms.slice(0, 128).map(({ id, claim, refused }) => ({ id, claim, refused }));
  const counts = { ...state.counts };
  const drafts = await writeDrafts(input, name, counts, selected, candidates, earlier);
  const unique = [...new Map(drafts.map(draft => [draft.support.key, draft])).values()];
  const proved = await proveDrafts(input, name, counts, unique);
  const queue = proved.flatMap(({ draft, proof }) => {
    const old = savedNorms.find(item => item.id === draft.support.earlier || claimHash(item.claim) === claimHash(draft.entry.claim));
    if (old?.refused) {
      add(counts, "producer-dropped.forgotten");
      return [];
    }
    if (old && !draft.support.observations.some(observation => !stored.find(item => item.id === observation.id)?.normId)) return [];
    if (old && input.context.writer.setting(project, learnedWaitingKey(old.id))) draft.support.refused = true;
    const routed = routeEntry(proof, input.plan.origin, draft.model);
    if ("dropped" in routed) { add(counts, "proof-dropped"); return []; }
    const rule: GateRule = { id: draft.support.key, text: routed.proposal.text, kind: routed.proposal.kind,
      route: routed.route, scope: routed.proposal.anchors?.scope ?? [], source: draft.support.source };
    return [{ draft, proof, old, rule }];
  });
  const verdicts = await evaluateDrafts(input, name, counts, queue.filter(item => !item.old).map(item => item.rule), earlier);
  const publish = queue.flatMap(item => {
    const verdict = item.old ? "keep" : verdicts.get(item.rule.id);
    if (verdict && verdict !== "keep") {
      noteDispositions(input.context, item.draft.support.observations.map(({ source }) => ({
        id: source.id, disposition: verdict === "drop-duplicate" ? "duplicate" as const : "dropped" as const, detail: verdict,
      })));
      return [];
    }
    const routed = routeEntry(item.proof, input.plan.origin, item.draft.model, verdict === "keep");
    return "dropped" in routed ? [] : [{ draft: { ...item.draft, support: item.proof.cluster }, routed, proofWhen: item.proof.draft.when, earlier: item.old }];
  });
  const number = await publishDrafts(input, name, publish, counts);
  state.counts = counts;
  return number;
}

/** The live view names the first pull request of a triage batch. */
function unitSubject(units: readonly PRUnit[], candidates: ReadonlyMap<string, Candidate>): Subject {
  for (const unit of units) for (const line of unit.lines) {
    const candidate = line.candidate === undefined ? undefined : candidates.get(line.candidate);
    if (candidate) return sourceSubject(candidate, "Pull requests");
  }
  return { subject: "Pull requests" };
}

function pendingUnits(context: Context, candidates: Candidate[]): PRUnit[] {
  const sent = new Set(load<string[]>(context, "early.lines") ?? []);
  return prUnits(candidates).map(unit => ({ ...unit, lines: unit.lines.filter(item => !sent.has(lineKey(item))) }));
}

/** One checkpointed unit. A paid reply has a name tied to the unit and can be reused after a wait. */
export async function runPipelineBatch(input: PipelineInput): Promise<{ state: PipelineState; done: boolean; progress: string; results: number }> {
  const { context, plan, deps } = input, state = structuredClone(input.state), project = context.job.project_id!;
  input.activityState = state;
  updateActivity(input);
  const result = (progress: string, results = 0, done = false) => {
    updateActivity(input);
    return { state, done, progress, results };
  };
  switch (state.phase) {
    case "harvest": {
      const batch = await harvestBatch(plan.harvest, state.cursor as HarvestCursor | undefined, deps);
      for (const gap of batch.gaps) input.gaps.add(gap);
      const current = await currentCandidates(input, batch.candidates);
      const fresh = input.weekly ? await unreadCandidates(input, current) : current;
      if (fresh.length) save(context, "cand." + state.chunks++, fresh);
      for (const candidate of batch.candidates) add(state.counts, "harvested." + candidate.kind);
      add(state.counts, "covered-sources", current.length - fresh.length);
      add(state.counts, "historical-docs", batch.candidates.length - current.length);
      if (context.writer.setting(project, "learning.prDecisions") === "true") {
        add(state.counts, "trial.pr.followed", batch.descriptions.decisions);
        add(state.counts, "trial.pr.ignored", batch.descriptions.plain);
      }
      state.cursor = batch.cursor;
      state.harvestDone = batch.done;
      if (batch.done || !input.weekly && !state.early) {
        const candidates = allCandidates(context, state);
        const units = pendingUnits(context, candidates);
        if (batch.done || units.length >= (deps.firstRules ?? 30)) {
          const planned = batch.done ? packUnits(units) : packUnits(units).slice(0, 1);
          if (batch.done) {
            const all = prUnits(candidates);
            state.counts.units = all.length;
            state.counts["pr-units"] = all.filter(unit => unit.header.startsWith("=== PR #")).length;
          }
          planned.forEach((unit, i) => save(context, "triage.units." + (state.triaged + i), unit));
          state.batches = state.triaged + planned.length;
          state.phase = planned.length ? "triage" : batch.done ? "write" : "harvest";
        }
      }
      return result("Reading reviews, past fixes and docs");
    }
    case "triage": {
      const units = load<PRUnit[]>(context, "triage.units." + state.triaged);
      if (!units) throw new Error("The run's sources were cleared. Start a new quote.");
      const candidates = allCandidates(context, state);
      const map = new Map(candidates.map(candidate => [candidate.id, candidate]));
      input.subject = unitSubject(units, map);
      const observations = await triage(input, state, units, map, "triage." + state.triaged);
      saveChecked(input, observations);
      save(context, "observations." + state.triaged, observations.map(item => item.id));
      for (const observation of observations) add(state.counts, "observations." + observation.sourceKind);
      add(state.counts, "triage-kept", observations.length);
      add(state.counts, "trial.issues", observations.filter(item => item.sourceKind === "issue").length);
      state.triaged++;
      let saved = 0;
      if (!state.early && !input.weekly) {
        if (!state.harvestDone || state.batches > state.triaged) saved = await writeWindow(input, state, "early", candidates, observations);
        save(context, "early.lines", units.flatMap(unit => unit.lines.map(lineKey)));
        state.early = true;
      }
      if (!state.harvestDone) state.phase = "harvest";
      else if (state.triaged >= state.batches) state.phase = "write";
      return result("Sorted " + state.triaged + " batches of source units", saved);
    }
    case "write": {
      const ids = new Set<string>();
      for (let i = 0; i < state.triaged; i++) for (const id of load<string[]>(context, "observations." + i) ?? []) ids.add(id);
      const observations = readObservations(context.writer.db, project, cutoff(input)).filter(item => ids.has(item.id));
      const candidates = allCandidates(context, state);
      const saved = await writeWindow(input, state, "window", candidates, observations);
      state.phase = "finish";
      state.written++;
      return result("Checked the learned rules", saved);
    }
    case "finish": {
      if (plan.procedures && context.writer.setting(project, "learning.procedures") === "true") {
        state.counts["trial.procedures"] ??= 0;
        const existing = load<ProcedureSample[]>(context, "procedures");
        const samples = existing ?? await procedureSamples(context.writer, project, deps.tree);
        if (!existing) save(context, "procedures", samples);
        const index = state.procedures ?? 0, sample = samples[index];
        if (sample) {
          const accepted = await writeProcedure(input, project, index, sample);
          state.procedures = index + 1;
          add(state.counts, "trial.procedures", accepted);
          return result("Checked procedure " + (index + 1) + " of " + samples.length, accepted);
        }
      }
      saveChecked(input, []);
      const prefix = key(context.job, "trial.");
      const entries = context.writer.db.prepare("SELECT value FROM settings WHERE scope=? AND substr(key,1,?)=? ORDER BY key")
        .all(project, prefix.length, prefix).map(row => JSON.parse(String(row.value)) as TrialEntry);
      add(state.counts, "trial.linter", entries.filter(entry => entry.linter).length);
      add(state.counts, "trial.alternatives", entries.reduce((sum, entry) => sum + (entry.alternatives ?? 0), 0));
      state.counts["proven-share"] ??= 0;
      saveTrialReceipt(context, project, { counts: state.counts, entries });
      return result("Done", 0, true);
    }
  }
}
