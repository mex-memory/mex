/**
 * Learn deeper v2, phase by phase: harvest (no model) -> triage (cheap) -> first rules early -> cluster
 * (no model) -> write, prove, repair once, route and publish (best) -> finish.
 *
 * Each `runBatch` does one bounded unit, so a restart redoes at most one unit. Every model reply is saved
 * before its result is used, so an interruption never pays for the same call twice. All raw text the run
 * reads (candidates, triage replies, drafts) lives in job-scoped rows and is deleted when the run ends;
 * only the published entries, their proofs and the kept quote remain.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { buildIndex } from "../file-index/build.js";
import { indexDirectory } from "../file-index/store.js";
import { registerLiterals } from "../knowledge/check.js";
import { parseEntry, serializeEntry } from "../knowledge/entry.js";
import { propose, summarizeResults, type GateResult, type Proposal } from "../knowledge/gate.js";
import { snapshotNotes } from "../knowledge/personal-store.js";
import { ModelWaitError, type runModel } from "../model-runner/index.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import type { BatchContext, BatchResult } from "../record/jobs.js";
import { shortHash } from "../record/project.js";
import { applyDocQuota, clusterLessons, type Cluster, type EarlierLearned, type Triaged } from "./cluster.js";
import { learningProof, makeNoteProof, noteKey, type SourceRef } from "./coverage.js";
import type { PinnedTree } from "./git.js";
import { harvestBatch } from "./harvest/index.js";
import type { Candidate, HarvestCursor, HarvestDeps, HarvestPlan } from "./harvest/types.js";
import { LEARN_KIND, promptEstimate, type LearningPlan } from "./plan.js";
import { gitHistory, proveEntry, type ProofContext, type ProofResult } from "./prove.js";
import { routeEntry } from "./route.js";
import { parseTriage, triageCounts, triagePrompt, type TriageResult } from "./triage.js";
import { packClusters, parseWriter, repairPrompt, writerPrompt, type WriterContext, type WriterEntry } from "./write.js";
import type { WriterModel } from "./entries.js";

export const PIPELINE_LIMITS = {
  /** Candidates per stored chunk, and so per triage call. */
  chunkCandidates: 32,
  chunkBytes: 48 << 10,
  /** First rules early: strong candidates written right after the first triage call. */
  earlyRules: 5,
  /** Files staged for the native matcher's area check and the gate's observations. */
  stagedFiles: 2000,
} as const;

export const Phase = z.enum(["harvest", "triage", "cluster", "write", "finish"]);
const Counts = z.record(z.string().max(64), z.number().int().nonnegative());
export const PipelineState = z.object({
  phase: Phase,
  cursor: z.unknown().optional(),
  chunks: z.number().int().nonnegative(),
  triaged: z.number().int().nonnegative(),
  early: z.boolean(),
  batches: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  counts: Counts,
}).strict();
export type PipelineState = z.infer<typeof PipelineState>;
export const initialState = (): PipelineState => ({ phase: "harvest", chunks: 0, triaged: 0, early: false, batches: 0, written: 0, counts: {} });

type Context = BatchContext<unknown, unknown>;
export interface PipelineDeps {
  model: typeof runModel;
  now: () => number;
  /** Forge access for the harvest; undefined for local-only runs. */
  client?: HarvestDeps["client"];
  tree: PinnedTree;
}
export interface PipelineInput {
  context: Context;
  plan: LearningPlan & { harvest: HarvestPlan };
  state: PipelineState;
  deps: PipelineDeps;
  weekly: boolean;
  gaps: Set<string>;
}

const prefix = (job: { id: string }) => `learning.deep.v2.${job.id}.`;
const key = (job: { id: string }, name: string) => `${prefix(job)}${name}`;
const add = (counts: PipelineState["counts"], name: string, n = 1) => { if (n) counts[name] = (counts[name] ?? 0) + n; };

function save(context: Context, name: string, value: unknown): void {
  context.writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(context.job.project_id!, key(context.job, name), JSON.stringify(value));
}
function load<T>(context: Context, name: string): T | undefined {
  const raw = context.writer.setting(context.job.project_id!, key(context.job, name));
  return raw ? JSON.parse(raw) as T : undefined;
}
/** Remove every job-scoped row: the raw text of the run. Called when the run ends, however it ends. */
export function clearRun(writer: Context["writer"], project: string, jobId: string): void {
  clearRunRows(writer.db, project, jobId);
}
export function clearRunRows(db: { prepare(sql: string): unknown }, project: string, jobId: string): void {
  // Job ids carry no LIKE wildcards, but escape them anyway so a prefix can never widen the delete.
  const like = prefix({ id: jobId }).replace(/[%_!]/gu, char => "!" + char) + "%";
  (db.prepare("DELETE FROM settings WHERE scope=? AND key LIKE ? ESCAPE '!'") as { run(...args: unknown[]): unknown }).run(project, like);
}

/** One learned entry of a run, as the review list shows it (job E2; the Hub's Review page reads the same rows). */
export interface ReviewRow {
  entryId: string; claim: string; label: string; support: number; reviewers: number; proven: boolean;
  status: "active" | "proposed" | "retired"; route: string; signal: "strong" | "weak"; link: string;
}
/** The review rows of one learning run; this row is not job-scoped, so it outlives the run's raw text. */
export const reviewRowsKey = (jobId: string) => `learning.deep.review.${jobId}`;
export function reviewRows(reader: { setting(scope: string, key: string): string | undefined | null }, project: string, jobId: string): ReviewRow[] {
  try { return JSON.parse(reader.setting(project, reviewRowsKey(jobId)) ?? "[]") as ReviewRow[]; } catch { return []; }
}

/** Split a harvest batch into chunks a triage call can take. */
export function chunkCandidates(candidates: readonly Candidate[]): Candidate[][] {
  const chunks: Candidate[][] = [];
  let current: Candidate[] = [], bytes = 0;
  for (const candidate of candidates) {
    const size = Buffer.byteLength(candidate.text) + 256;
    if (current.length && (current.length >= PIPELINE_LIMITS.chunkCandidates || bytes + size > PIPELINE_LIMITS.chunkBytes)) {
      chunks.push(current); current = []; bytes = 0;
    }
    current.push(candidate); bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** One model call under the run's consent: the approved ceiling, or weekly's automatic allowance. */
async function call(input: PipelineInput, name: string, prompt: string, role: "cheap" | "best", rules: number): Promise<{ text: string; model: WriterModel }> {
  const { context, plan, deps, weekly } = input;
  const saved = load<{ text: string; model: WriterModel }>(context, `reply.${name}`);
  if (saved) return saved;
  const estimate = promptEstimate(prompt, plan.agent, role === "cheap" ? 0 : rules);
  if (!weekly && tokenCount(estimate) > plan.ceiling - recordedModelSpend(context.writer, context.job.id)) throw new ModelWaitError("cap", CEILING_WAIT);
  const output = await deps.tree.withCheckFiles(context.writer.location.home, context.job.id, [], executionDirectory => deps.model({
    agent: plan.agent, setup: plan.setup, role, projectRoot: plan.checkout, executionDirectory, allowNonGit: true,
    purpose: role === "cheap" ? "learn-deeper-filter" : LEARN_KIND, prompt,
    ...(weekly ? { automatic: { estimate, measuredUsageOnly: true } } : { consented: { ceiling: plan.ceiling, estimate } }),
  }));
  if (!output) throw new Error("The model could not start in the private learning directory.");
  const { writerModel } = await import("./job.js");
  const reply = { text: output.text, model: writerModel(output) };
  save(context, `reply.${name}`, reply);
  return reply;
}

/** This producer's earlier lessons, retired ones included: a lesson someone dropped is never proposed again (R20). */
function earlierEntries(context: Context, plan: LearningPlan): Array<EarlierLearned & { retired: boolean }> {
  const project = context.job.project_id!;
  const out: Array<EarlierLearned & { retired: boolean }> = [];
  for (const [id, raw] of snapshotNotes(context.writer, project).files) {
    if (!learningProof(plan, raw, context.writer.setting(project, noteKey(id)))) continue;
    try {
      const entry = parseEntry(raw);
      if (entry.mex.source.type === "person") continue;
      out.push({ id, text: entry.text, scope: entry.mex.scope, patterns: (entry.mex.when ?? []).map(item => item.pattern),
        retired: entry.mex.status === "retired" });
    } catch { /* an unreadable note is no earlier lesson */ }
  }
  return out;
}

function linters(tree: PinnedTree): string[] {
  const names = /(?:^|\/)(?:\.eslintrc(?:\.\w+)?|eslint\.config\.\w+|biome\.jsonc?|\.ruff\.toml|ruff\.toml|\.golangci\.ya?ml|\.rubocop\.yml|\.stylelintrc(?:\.\w+)?|clippy\.toml|\.flake8|\.pylintrc)$/u;
  return [...tree.paths()].filter(path => names.test(path) && path.split("/").length <= 3).slice(0, 8);
}

/** Write, prove, repair once, route and publish one batch of clusters. */
async function writeUnit(input: PipelineInput, state: PipelineState, name: string, clusters: Cluster[]): Promise<{ results: GateResult[]; counts: Record<string, number> }> {
  const { context, plan, deps } = input;
  const counts: Record<string, number> = {};
  // A unit published before an interruption is finished: never publish or pay for it twice.
  if (!clusters.length || load(context, `${name}.done`)) return { results: [], counts };
  const writerContext: WriterContext = { linters: linters(deps.tree) };
  const first = await call(input, `${name}.write`, writerPrompt(clusters, writerContext), "best", clusters.length);
  const byKey = new Map(clusters.map(cluster => [cluster.key, cluster]));
  const parsed = parseWriter(first.text, clusters);
  if (parsed.response !== "valid") input.gaps.add("A model batch returned no readable entries.");
  add(counts, "writer-rejected", parsed.rejected.length);
  const areas = [...new Set(clusters.flatMap(cluster => [...cluster.files, ...cluster.members.flatMap(m => m.candidate.changedPaths ?? [])]))];
  return withProofContext(input, parsed.entries, areas, async (proofContext, checked) => {
    const prove = (entry: WriterEntry) => proveEntry(entry, byKey.get(entry.cluster)!, proofContext);
    let proofs: ProofResult[] = [];
    for (const entry of parsed.entries) proofs.push(await prove(entry));
    const failing = proofs.filter(proof => proof.failures.length && (proof.dropped?.includes("claim") || proof.draft.when.length > proof.when.length || proof.failures.length));
    let model = first.model;
    if (failing.length && !input.weekly) {
      try {
        const repaired = await call(input, `${name}.repair`, repairPrompt(failing.map(proof => ({ cluster: proof.cluster, entry: proof.draft, failures: proof.failures })), writerContext),
          "best", failing.length);
        model = repaired.model;
        const fixed = parseWriter(repaired.text, failing.map(proof => proof.cluster));
        add(counts, "repaired", fixed.entries.length);
        for (const entry of fixed.entries) {
          const again = await prove(entry);
          const index = proofs.findIndex(proof => proof.draft.cluster === entry.cluster);
          // Keep the repair only when it proves at least as much as the first answer.
          if (index >= 0 && !again.dropped && (proofs[index]!.dropped || again.when.length >= proofs[index]!.when.length)) proofs[index] = again;
        }
      } catch (error) {
        if (error instanceof ModelWaitError) throw error;
        input.gaps.add("The repair turn could not run; the first answer was kept.");
      }
    }
    const routed = proofs.map(proof => ({ proof, routed: routeEntry(proof, plan.origin, model) }));
    const proposals: Proposal[] = [];
    const sources = new Map<Proposal, Candidate[]>();
    const routedOf = new Map<Proposal, { proof: ProofResult; proven: boolean }>();
    for (const { proof, routed: item } of routed) {
      if ("dropped" in item) { add(counts, "dropped"); continue; }
      proposals.push(item.proposal);
      sources.set(item.proposal, item.sources);
      routedOf.set(item.proposal, { proof, proven: item.proven });
      add(counts, item.proven ? "proven" : "prose");
      if (item.status === "proposed") add(counts, "proposed");
    }
    const project = context.job.project_id!;
    // The gate records pattern checks from the staged index: count the fix and baseline literals first.
    const fixLiterals = proofs.flatMap(proof => proof.fixLiteral ? [proof.fixLiteral] : []);
    if (fixLiterals.length && checked.checkIndex) {
      registerLiterals(checked.checkIndex.recordDirectory, checked.checkIndex.projectId, fixLiterals);
      await buildIndex({ root: checked.checkTree!, projectId: checked.checkIndex.projectId, recordDirectory: checked.checkIndex.recordDirectory, workers: 0 });
    }
    proofs = [];
    let results: GateResult[] = [];
    await propose(proposals, {
      projectPath: plan.checkout, home: context.writer.location.home, ...checked,
      validate(gate) {
        const live = gate.db.prepare("SELECT owner,state FROM jobs WHERE id=?").get(context.job.id);
        if (live?.owner !== context.job.owner || live?.state !== "running" || gate.setting(project, key(context.job, `${name}.done`))) {
          throw new Error("Learning lost its job before saving.");
        }
      },
      onAccepted(gate, accepted, gated) {
        results = [...gated];
        // Results come back one per proposal, in order.
        const proposalOf = new Map<string, Proposal>();
        gated.forEach((result, i) => { if (result.status === "accepted") proposalOf.set(result.entryId, proposals[i]!); });
        const set = gate.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
        for (const item of accepted) {
          const proposal = proposalOf.get(item.entryId);
          const members = (proposal && sources.get(proposal)) ?? [];
          const refs: SourceRef[] = members.slice(0, 8).map(candidate => ({ id: candidate.id, hash: candidate.hash, link: candidate.link }));
          const day = members.map(candidate => candidate.at.slice(0, 10)).sort().at(-1) ?? plan.until.slice(0, 10);
          set.run(project, noteKey(item.entry.mex.id), makeNoteProof(plan, serializeEntry(item.entry), refs, day));
          // Per-comment node ids and hashes, for the weekly network pass (job E1 reads this row).
          set.run(project, `learning.deep.nodes.${item.entry.mex.id}`, JSON.stringify(members.flatMap(candidate =>
            candidate.nodeIds.map(id => ({ id, hash: candidate.commentHashes?.[id] ?? candidate.hash, link: candidate.link }))).slice(0, 32)));
        }
        set.run(project, key(context.job, `${name}.done`), JSON.stringify({ at: deps.now(), summary: summarizeResults(gated) }));
        // The review list's rows: no source text, only what the person decides on. Kept after the run's cleanup.
        const reviewKey = reviewRowsKey(context.job.id);
        const rows: ReviewRow[] = JSON.parse(gate.setting(project, reviewKey) ?? "[]");
        for (const item of accepted) {
          const proposal = proposalOf.get(item.entryId);
          const routed = proposal && routedOf.get(proposal);
          if (!routed) continue;
          const cluster = routed.proof.cluster;
          rows.push({ entryId: item.entryId, claim: item.entry.mex.one_line, label: item.entry.mex.source.label ?? "",
            support: cluster.support, reviewers: cluster.reviewers, proven: routed.proven, status: item.entry.mex.status,
            route: routed.proof.draft.route, signal: cluster.strong ? "strong" : "weak", link: proposal.source.ref });
        }
        set.run(project, reviewKey, JSON.stringify(rows.slice(-200)));
        for (const [counted, n] of Object.entries(counts)) add(state.counts, counted, n);
        for (const result of gated) if (result.status === "dropped") add(state.counts, `gate-dropped.${result.reason}`);
      },
    });
    add(counts, "saved", results.filter(item => item.status === "accepted").length);
    return { results, counts };
  });
}

/** Stage the pinned files the proof and the gate read, with a file index that counts learned literals. */
async function withProofContext<T>(input: PipelineInput, entries: readonly WriterEntry[], areas: readonly string[],
  run: (context: ProofContext, checked: Pick<ProofContext["check"], "checkTree" | "checkIndex">) => Promise<T>): Promise<T> {
  const { deps, context } = input;
  const { globToRegExp } = await import("../file-index/glob.js");
  const scopes = [...new Set(entries.flatMap(entry => entry.scope))].flatMap(glob => { try { return [globToRegExp(glob)]; } catch { return []; } });
  const folders = areas.map(path => path.split("/").slice(0, -1).join("/")).filter(Boolean);
  const wanted: string[] = [];
  for (const path of deps.tree.paths()) {
    if (scopes.some(re => re.test(path)) || folders.some(folder => path.startsWith(folder + "/")) || /(?:^|\/)(?:package\.json|AGENTS\.md|CLAUDE\.md)$/u.test(path)) wanted.push(path);
    if (wanted.length >= PIPELINE_LIMITS.stagedFiles) { input.gaps.add("Some scopes were too large to stage in full for checking."); break; }
  }
  const literals = entries.flatMap(entry => [...entry.when.filter(w => w.match === "literal").map(w => w.pattern)]);
  return deps.tree.withCheckTree(context.writer.location.home, context.job.id, wanted, async (checkTree) => {
    const recordDirectory = join(checkTree, ".mex");
    const projectId = "f-" + shortHash(checkTree);
    mkdirSync(indexDirectory(recordDirectory, projectId), { recursive: true });
    registerLiterals(recordDirectory, projectId, literals);
    await buildIndex({ root: checkTree, projectId, recordDirectory, workers: 0 });
    const checked = { checkTree, checkIndex: { projectId, recordDirectory } };
    // The fix literals the proof picks are registered as they are found; the index recounts on the next build,
    // so register them up front from every draft's fix range too.
    return run({ tree: deps.tree, check: { projectPath: checkTree, ...checked }, history: gitHistory(deps.tree) }, checked);
  }) as Promise<T>;
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
      for (const chunk of chunkCandidates(batch.candidates)) save(context, `cand.${state.chunks++}`, chunk);
      for (const candidate of batch.candidates) add(state.counts, `harvested.${candidate.kind}`);
      state.cursor = batch.cursor;
      if (batch.done) state.phase = state.chunks ? "triage" : "finish";
      return { state, done: false, progress: `${state.chunks} chunks of sources read`, results: 0 };
    }
    case "triage": {
      const candidates = load<Candidate[]>(context, `cand.${state.triaged}`) ?? [];
      progress(`Sorting ${candidates.length} sources`);
      const reply = await call(input, `triage.${state.triaged}`, triagePrompt(candidates), "cheap", 0);
      const outcome = parseTriage(reply.text, candidates);
      if (outcome.response !== "valid") input.gaps.add("A triage batch returned no readable answer.");
      save(context, `triage.${state.triaged}`, outcome.results);
      const { kept, dropped } = triageCounts(outcome.results);
      add(state.counts, "triage-kept", kept);
      for (const [category, n] of Object.entries(dropped)) add(state.counts, `triage-dropped.${category}`, n);
      add(state.counts, "triage-missing", outcome.missing.length);
      state.triaged++;
      let results = 0;
      if (!state.early) {
        // First rules early: the strongest single items of the first batch, written now.
        const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
        const strong: Triaged[] = outcome.results.filter(result => result.keep && byId.get(result.id)?.signal === "strong")
          .map(result => ({ candidate: byId.get(result.id)!, triage: result })).slice(0, PIPELINE_LIMITS.earlyRules);
        const clusters = clusterLessons(strong).filter(cluster => cluster.decision !== "drop");
        if (clusters.length) {
          progress(`Writing the first ${clusters.length} rules`);
          results = (await writeUnit(input, state, "early", clusters)).results.filter(item => item.status === "accepted").length;
          save(context, "early.members", clusters.flatMap(cluster => cluster.members.map(member => member.candidate.id)));
        }
        state.early = true;
      }
      if (state.triaged >= state.chunks) state.phase = "cluster";
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
      const earlier = earlierEntries(context, plan);
      const retired = new Set(earlier.filter(entry => entry.retired).map(entry => entry.id));
      const clusters = applyDocQuota(clusterLessons(items, { earlier }));
      for (const cluster of clusters) add(state.counts, `cluster.${cluster.decision}`);
      const forgotten = clusters.filter(cluster => cluster.earlier && retired.has(cluster.earlier));
      add(state.counts, "cluster.forgotten", forgotten.length);
      // A single strong item already written early needs no second call; a dropped lesson is never written again.
      const write = clusters.filter(cluster => cluster.decision !== "drop" && !(cluster.earlier && retired.has(cluster.earlier))
        && !(cluster.earlier && cluster.members.every(member => early.has(member.candidate.id))));
      const batches = packClusters(write, { linters: linters(deps.tree) });
      batches.forEach((batch, i) => save(context, `clusters.${i}`, batch));
      state.batches = batches.length;
      state.phase = batches.length ? "write" : "finish";
      return { state, done: false, progress: `${write.length} lessons to write`, results: 0 };
    }
    case "write": {
      const clusters = load<Cluster[]>(context, `clusters.${state.written}`) ?? [];
      progress(`Writing and checking ${clusters.length} lessons`);
      const { results } = await writeUnit(input, state, `batch.${state.written}`, clusters);
      state.written++;
      if (state.written >= state.batches) state.phase = "finish";
      return { state, done: false, progress: `${state.written} of ${state.batches} writer batches checked`, results: results.filter(item => item.status === "accepted").length };
    }
    case "finish": {
      clearRun(context.writer, context.job.project_id!, context.job.id);
      context.writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
        .run(context.job.project_id!, "learning.deep.cursor", JSON.stringify(state.cursor ?? {}));
      return { state, done: true, progress: "Done", results: 0 };
    }
  }
}
