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
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { claimHash } from "../knowledge/state.js";
import { sourceDigest, type Repository } from "./source.js";
import { existingKnowledge } from "./existing-knowledge.js";
import { branchScope, staleDoc } from "./history-docs.js";
import { sessionsActive } from "./weekly-schedule.js";
import { z } from "zod";
import { buildIndex } from "../file-index/build.js";
import { indexDirectory } from "../file-index/store.js";
import { registerLiterals } from "../knowledge/check.js";
import { parseEntry, serializeEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { propose, type Proposal } from "../knowledge/gate.js";
import { producerEntryId } from "../knowledge/producers.js";
import { readNotes, snapshotNotes } from "../knowledge/personal-store.js";
import { ModelWaitError, type runModel } from "../model-runner/index.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import type { BatchContext } from "../record/jobs.js";
import { shortHash } from "../record/project.js";
import { applyDocQuota, clusterLessons, type Cluster, type EarlierLearned, type Triaged } from "./cluster.js";
import { coverageKey, learningProof, makeNoteProof, noteKey, readTeamCoverage, saveSourceReads, sourceRead, type SourceRef } from "./coverage.js";
import type { PinnedTree } from "./git.js";
import { hasDecisionsSection } from "./harvest/forge.js";
import { procedureProposal, procedureSamples, type ProcedureSample } from "./procedures.js";
import { harvestBatch } from "./harvest/index.js";
import { networkGroups, networkProofKey, readNetworkGroups } from "./network-proof.js";
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
/** Remove every job-scoped row: the raw text of the run. Called when the run ends, however it ends. */
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
async function call(input: PipelineInput, name: string, prompt: string, role: "cheap" | "best", rules: number): Promise<{ text: string; model: WriterModel; tokens: number }> {
  const { context, plan, deps, weekly } = input;
  const saved = load<{ text: string; model: WriterModel; tokens: number; lost?: true }>(context, `reply.${name}`);
  if (saved) {
    if (saved.lost) input.gaps.add("A paid model reply could not be recovered after an interruption.");
    return saved;
  }
  const { writer, job } = context;
  const stage = `call.${name}`;
  const started = load<{ lastBatch: number; spent: number }>(context, stage);
  if (started && writer.db.prepare("SELECT 1 FROM model_batches WHERE job_id=? AND id>? AND state='done' AND charged_units>0 LIMIT 1")
    .get(job.id, started.lastBatch)) {
    // The runner recorded the charge but died before saving the answer.
    input.gaps.add("A paid model reply could not be recovered after an interruption.");
    const reply = { text: "", lost: true, model: { id: "unknown", version: "unknown" }, tokens: Math.max(0, recordedModelSpend(writer, job.id) - started.spent) };
    save(context, `reply.${name}`, reply);
    return reply;
  }
  const spent = recordedModelSpend(writer, job.id);
  const estimate = promptEstimate(prompt, plan.agent, role === "cheap" ? 0 : rules);
  // Procedure naming is a trial on the automatic allowance, not part of the consented quote.
  const procedure = name.startsWith("procedure.");
  if (!weekly && !procedure && tokenCount(estimate) > plan.ceiling - spent) throw new ModelWaitError("cap", CEILING_WAIT);
  if (weekly && sessionsActive(writer, deps.now())) throw new AgentActive();
  const lastBatch = Number(writer.db.prepare("SELECT max(id) id FROM model_batches WHERE job_id=?").get(job.id)?.id ?? 0);
  save(context, stage, { lastBatch, spent });
  const reply = await deps.tree.withCheckFiles(writer.location.home, job.id, [], async executionDirectory => {
    const output = await deps.model({
      agent: plan.agent, setup: procedure ? "mixed" : plan.setup, role, projectRoot: plan.checkout, executionDirectory, allowNonGit: true,
      purpose: procedure ? "learn-deeper-procedure" : role === "cheap" ? "learn-deeper-filter" : LEARN_KIND, prompt,
      ...(weekly || procedure ? { automatic: { estimate, measuredUsageOnly: true } } : { consented: { ceiling: plan.ceiling, estimate } }),
    });
    const { writerModel } = await import("./job.js");
    const reply = { text: output.text, model: writerModel(output), tokens: Math.max(0, recordedModelSpend(writer, job.id) - spent) };
    save(context, `reply.${name}`, reply);
    return reply;
  });
  if (!reply) throw new Error("The model could not start in its private workspace.");
  return reply;
}

/** This producer's earlier lessons, retired ones included: a lesson someone dropped is never proposed again (R20). */
function earlierEntries(context: Context, plan: LearningPlan): Array<EarlierLearned & { retired: boolean }> {
  const project = context.job.project_id!;
  const out: Array<EarlierLearned & { retired: boolean }> = [];
  for (const [id, raw] of snapshotNotes(context.writer, project).files) {
    const proof = learningProof(plan, raw, context.writer.setting(project, noteKey(id)));
    if (!proof) continue;
    try {
      const entry = parseEntry(raw);
      if (entry.mex.source.type === "person") continue;
      out.push({ id, text: entry.text, scope: entry.mex.scope, patterns: (entry.mex.when ?? []).map(item => item.pattern),
        retired: entry.mex.status === "retired", support: proof.support });
    } catch { /* an unreadable note is no earlier lesson */ }
  }
  return out;
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
  if (reason.includes("nothing today")) return "no-scope";
  if (reason.includes("maintainer")) return "no-maintainer-reason";
  if (reason.includes("restates")) return "restated-source";
  if (reason.includes("linter config")) return "already-enforced";
  return "no-check";
}

/** Write, prove, repair once, route and publish one batch of clusters. */
async function writeUnit(input: PipelineInput, state: PipelineState, name: string, clusters: Cluster[]): Promise<number> {
  const { context, plan, deps } = input;
  const counts: Record<string, number> = {};
  // A unit published before an interruption is finished: never publish or pay for it twice.
  if (!clusters.length) return 0;
  const saved = load<{ accepted: number; counts: Record<string, number>; gaps: string[] }>(context, `${name}.done`);
  if (saved) {
    for (const [counted, n] of Object.entries(saved.counts)) add(state.counts, counted, n);
    for (const gap of saved.gaps) input.gaps.add(gap);
    return saved.accepted;
  }
  const writerContext: WriterContext = { linters: linters(deps.tree) };
  const first = await call(input, `${name}.write`, writerPrompt(clusters, writerContext), "best", clusters.length);
  add(counts, "tokens.write", first.tokens);
  const byKey = new Map(clusters.map(cluster => [cluster.key, cluster]));
  const parsed = parseWriter(first.text, clusters);
  if (parsed.response !== "valid") input.gaps.add("A model batch returned no readable entries.");
  for (const item of parsed.rejected) add(counts, `writer-rejected.${item.reason}`);
  const areas = [...new Set(clusters.flatMap(cluster => [...cluster.files, ...cluster.members.flatMap(m => m.candidate.changedPaths ?? [])]))];
  const verify = (repair?: { entries: WriterEntry[]; model: WriterModel }) => withProofContext(
    input, [...parsed.entries, ...(repair?.entries ?? [])], areas, async (proofContext, checked) => {
    const prove = (entry: WriterEntry) => proveEntry(entry, byKey.get(entry.cluster)!, proofContext);
    const proofs: ProofResult[] = [];
    for (const entry of parsed.entries) proofs.push(await prove(entry));
    const failing = proofs.filter(proof => proof.failures.length);
    if (failing.length && !repair) return { failing };
    for (const entry of repair?.entries ?? []) {
      const again = await prove(entry);
      const index = proofs.findIndex(proof => proof.draft.cluster === entry.cluster);
      // Keep the repair only when it proves at least as much as the first answer.
      if (index >= 0 && !again.dropped && (proofs[index]!.dropped || again.when.length >= proofs[index]!.when.length)) proofs[index] = again;
    }
    const model = repair?.model ?? first.model;
    const routed = proofs.map(proof => ({ proof, routed: routeEntry(proof, plan.origin, model) }));
    const project = context.job.project_id!;
    const team = input.weekly ? await readTeamCoverage(plan.checkout, plan.head, plan.since) : undefined;
    const duplicate = await existingKnowledge(deps.tree);
    const before = snapshotNotes(context.writer, project).files;
    const proposals: Proposal[] = [];
    const carry = new Map<string, { entry: KnowledgeEntry; raw: string; proposal: Proposal }>();
    const sources = new Map<Proposal, Candidate[]>();
    const routedOf = new Map<Proposal, { proof: ProofResult; proven: boolean }>();
    for (const { proof, routed: item } of routed) {
      if ("dropped" in item) {
        add(counts, "dropped");
        add(counts, `proof-dropped.${proofDropReason(item.dropped)}`);
        continue;
      }
      const claim = claimHash(item.proposal.text);
      if (team?.retired.has(claim) || team?.claimed.has(claim)) { add(counts, "team-covered"); continue; }
      if (!proof.cluster.earlier && duplicate(item.proposal.text, proof.claim)) {
        add(counts, "duplicate-existing");
        continue;
      }
      sources.set(item.proposal, item.sources);
      routedOf.set(item.proposal, { proof, proven: item.proven });
      const id = proof.cluster.earlier;
      const raw = id && before.get(id);
      if (id && raw && !item.proven) {
        const prior = parseEntry(raw);
        if (prior.mex.status === "active" && prior.mex.checks.some(check => check.kind === "fixture")
          && claimHash(prior.mex.one_line) === claimHash(proof.claim)) {
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
    await propose(proposals, {
      projectPath: plan.checkout, home: context.writer.location.home, ...checked,
      validate(gate) {
        const live = gate.db.prepare("SELECT owner,state FROM jobs WHERE id=?").get(context.job.id);
        const checkout = gate.checkout(plan.checkout);
        if (live?.owner !== context.job.owner || live?.state !== "running" || gate.setting(project, key(context.job, `${name}.done`))
          || checkout?.project_id !== project || !checkoutOn(checkout, deps.now()) || !automaticWorkEnabled(gate, project, deps.now())) {
          throw new Error("Learning lost its job before saving.");
        }
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
        }

        // The review list's rows: no source text, only what the person decides on. Kept after the run's cleanup.
        const reviewKey = reviewRowsKey(context.job.id);
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
        set.run(project, reviewKey, JSON.stringify([...rows.values()].slice(-200)));
        for (const result of gated) if (result.status === "dropped") add(counts, `gate-dropped.${result.reason}`);
        set.run(project, key(context.job, `${name}.done`), JSON.stringify({ accepted: acceptedCount, counts, gaps: [...input.gaps] }));
      },
    });
    for (const [counted, n] of Object.entries(counts)) add(state.counts, counted, n);
    return { acceptedCount };
  });

  const firstPass = await verify();
  if (firstPass.failing === undefined) return firstPass.acceptedCount;
  const failing = firstPass.failing;
  let repair = { entries: [] as WriterEntry[], model: first.model };
  // Close the staged proof tree before opening the model's separate, empty workspace.
  try {
    const answer = await call(input, `${name}.repair`,
      repairPrompt(failing.map(proof => ({ cluster: proof.cluster, entry: proof.draft, failures: proof.failures })), writerContext), "best", failing.length);
    add(counts, "tokens.repair", answer.tokens);
    repair = { entries: parseWriter(answer.text, failing.map(proof => proof.cluster)).entries, model: answer.model };
    add(counts, "repaired", repair.entries.length);
  } catch (error) {
    if (error instanceof AgentActive || error instanceof ModelWaitError && error.reason !== "cap") throw error;
    input.gaps.add(error instanceof ModelWaitError ? "The allowance could not cover a repair. Only the proven parts were kept."
      : "The repair turn could not run. Only the proven parts were kept.");
  }
  const checked = await verify(repair);
  return checked.acceptedCount ?? 0;
}

/** Stage the pinned files the proof and the gate read, with a file index that counts learned literals. */
async function withProofContext<T>(input: PipelineInput, entries: readonly WriterEntry[], areas: readonly string[],
  run: (context: ProofContext, checked: Pick<ProofContext["check"], "checkTree" | "checkIndex">) => Promise<T>): Promise<T> {
  const { deps, context } = input;
  const { globToRegExp } = await import("../file-index/glob.js");
  const scopes = [...new Set(entries.flatMap(entry => entry.scope))].flatMap(glob => { try { return [globToRegExp(glob)]; } catch { return []; } });
  const folders = areas.map(path => path.split("/").slice(0, -1).join("/")).filter(Boolean);
  const needed = new Set([...areas, ...entries.flatMap(entry => [entry.symbol?.file, entry.lint?.config, entry.until?.file])]);
  const wanted: string[] = [];
  for (const path of deps.tree.paths()) {
    if (needed.has(path) || scopes.some(re => re.test(path)) || folders.some(folder => path.startsWith(folder + "/")) || /(?:^|\/)(?:package\.json|AGENTS\.md|CLAUDE\.md)$/u.test(path)) wanted.push(path);
    if (wanted.length >= PIPELINE_LIMITS.stagedFiles) { input.gaps.add("Some scopes were too large to stage in full for checking."); break; }
  }
  const literals = entries.flatMap(entry => [...entry.when.filter(w => w.match === "literal").map(w => w.pattern)]);
  return deps.tree.withCheckTree(context.writer.location.home, context.job.id, wanted, async (checkTree, _staged, unreadRules) => {
    if (unreadRules.length) input.gaps.add("Some rule files could not be read for duplicate checks.");
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
  if (snapshotNotes(context.writer, project).files.has(id)) return 0;
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
        const reviewKey = reviewRowsKey(context.job.id);
        const rows = reviewRows(gate, project, context.job.id);
        rows.push({ entryId: item.entryId, claim: item.entry.mex.one_line, label: proposal.label!, support: sample.commits.length,
          reviewers: 0, proven: false, status: "proposed", route: "procedure", signal: "weak", link: proposal.source.ref });
        set.run(project, reviewKey, JSON.stringify(rows.slice(-200)));
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
      for (const chunk of chunkCandidates(candidates)) save(context, `cand.${state.chunks++}`, chunk);
      for (const candidate of batch.candidates) add(state.counts, `harvested.${candidate.kind}`);
      add(state.counts, "covered-sources", current.length - candidates.length);
      add(state.counts, "historical-docs", batch.candidates.length - current.length);
      if (context.writer.setting(context.job.project_id!, "learning.prDecisions") === "true") {
        for (const candidate of batch.candidates) {
          if (candidate.kind !== "pr-text" && candidate.kind !== "closed-pr") continue;
          add(state.counts, hasDecisionsSection(candidate.prText ?? "") ? "trial.pr.followed" : "trial.pr.ignored");
        }
      }
      state.cursor = batch.cursor;
      state.harvestDone = batch.done;
      if (!state.early && state.chunks) state.phase = "triage";
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
        // First rules early: the strongest single items of the first batch, written now.
        const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
        const strong: Triaged[] = outcome.results.filter(result => result.keep && byId.get(result.id)?.signal === "strong")
          .map(result => ({ candidate: byId.get(result.id)!, triage: result })).slice(0, PIPELINE_LIMITS.earlyRules);
        const earlier = earlierEntries(context, plan);
        const clusters = clusterLessons(strong, { earlier }).filter(cluster => cluster.decision !== "drop" && cluster.source !== "docs" && !cluster.earlier);
        if (clusters.length) {
          progress(`Writing the first ${clusters.length} rules`);
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
      const earlier = earlierEntries(context, plan);
      const retired = new Set(earlier.filter(entry => entry.retired).map(entry => entry.id));
      const clusters = applyDocQuota(clusterLessons(items, { earlier }), 0.25, hasReviewHistory(plan, state));
      for (const cluster of clusters) add(state.counts, `cluster.${cluster.decision}`);
      const forgotten = clusters.filter(cluster => cluster.earlier && retired.has(cluster.earlier));
      add(state.counts, "cluster.forgotten", forgotten.length);
      // A single strong item already written early needs no second call; a dropped lesson is never written again.
      const write = clusters.filter(cluster => cluster.decision !== "drop" && !(cluster.earlier && retired.has(cluster.earlier))
        && !(cluster.earlier && cluster.members.every(member => early.has(member.candidate.id))));
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
