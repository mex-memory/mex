import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { KnowledgeError, parseEntry, serializeEntry } from "../knowledge/entry.js";
import { publishNotes, recoverNotes, snapshotNotes } from "../knowledge/personal-store.js";
import { claimHash, retiredClaimHashes, saveTombstone } from "../knowledge/state.js";
import { ModelRunError, ModelWaitError, runModel } from "../model-runner/index.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import { registerJobKind, type BatchContext, type BatchResult, type JobKind } from "../record/jobs.js";
import type { RecordWriter } from "../record/index.js";
import { refreshOwnUsage } from "../record/own-usage.js";
import { coverageKey, makeNoteProof, matchesProof, noteKey, saveSourceReads, SourceRef, sourceRead, sourceRef, type TeamCoverage } from "./coverage.js";
import { filteringPrompt, selectedSources, validatedEntries, writingPrompt, type EarlierEntry, type LearnedEntry } from "./entries.js";
import { ForgeClient, hostToken, SourceError } from "./forge.js";
import { clearLearningChecks, origin, PinnedTree } from "./git.js";
import { hosts } from "./hosts.js";
import { contextSources } from "./history.js";
import { DOCS_PER_BATCH, fitsQuote, LEARN_KIND, Plan, promptEstimate, PULLS_PER_BATCH, type LearningPlan } from "./plan.js";
import type { Reviewers } from "./reviewers.js";
import { importedSourceKey, importsEnabled, readImport, SESSIONS_PER_BATCH } from "./session-import.js";
import { cleanSourceText, documentExcerpt, sourceDigest, type LearningSource } from "./source.js";
import { readGitHubWorkflows, saveGitHubWorkflows } from "./workflows.js";
import { queuePatternRecount, quoteRefresh, RefreshDeferred, weeklySources } from "./weekly.js";
import { DAY_MS, nextWeeklyAt, publishWeeklyWake, saveWeeklySchedule, scheduleFromPlan, sessionsActive, WEEKLY_KIND, WeeklySchedule, weeklySchedule } from "./weekly-schedule.js";

const checkpointSchema = z.object({
  pull: z.number().int().nonnegative(), doc: z.number().int().nonnegative(), gaps: z.array(z.string().max(180)).max(24),
  session: z.number().int().nonnegative().optional(),
  retryAt: z.number().optional(), recovered: z.number().int().nonnegative().optional(),
  weeklyPlan: Plan.optional(),
}).strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
type Context = BatchContext<unknown, Checkpoint>;
const receiptSchema = z.object({
  checkpoint: checkpointSchema, count: z.number().int().nonnegative().max(16), spent: z.number().int().nonnegative(), done: z.boolean(),
  sources: z.array(SourceRef).max(48),
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
  return {
    checkpoint, results: count, tokens: Math.max(0, spent - context.job.tokens_used), done,
    gaps: done && checkpoint.gaps.length > 0,
    summary: [...checkpoint.gaps, ...(checkpoint.recovered ? ["Resumed from the last finished batch."] : [])].join(" "),
    progress: `${checkpoint.pull} of ${plan.pulls.length} merged changes and ${checkpoint.doc} of ${plan.docs.length} docs read`
      + (total ? ` · ${checkpoint.session ?? 0} of ${total} past sessions checked` : ""),
  };
}

function publish(context: Context, plan: LearningPlan, key: string, entries: LearnedEntry[], draft: Omit<Receipt, "count">,
  team?: TeamCoverage, schedule?: WeeklySchedule): Receipt {
  const { writer, job } = context, project = job.project_id!;
  const before = snapshotNotes(writer, project);
  const existing = new Set(team?.claimed);
  const forgotten = retiredClaimHashes(writer, project);
  for (const claim of team?.retired ?? []) forgotten.add(claim);
  const next = new Map(before.files);
  const added: string[] = [];
  const newNotes = new Map<string, string>(), replaced: ReturnType<typeof parseEntry>[] = [];
  for (const [id, raw] of before.files) {
    const note = parseEntry(raw), claim = claimHash(note.text);
    existing.add(claim);
    if (note.mex.status !== "active" || !team?.retired.has(claim) || !/^mx_deep[a-f0-9]{32}$/u.test(id)) continue;
    const retired = { reason: "The matching rule was retired on the default branch.", by: "mex learn", at: plan.until.slice(0, 10) };
    replaced.push({ ...note, mex: { ...note.mex, status: "retired", retired } });
    next.set(id, serializeEntry(replaced.at(-1)!));
  }
  for (const { entry, sources, replaces } of entries) {
    const claim = claimHash(entry.text);
    if (existing.has(claim) || forgotten.has(claim) || next.has(entry.mex.id)) continue;
    if (replaces) {
      const raw = next.get(replaces);
      if (!raw || !matchesProof(plan, raw, writer.setting(project, noteKey(replaces)))) continue;
      const old = parseEntry(raw);
      if (old.mex.status !== "active" || old.mex.created >= entry.mex.created) continue;
      const retired = { reason: "Superseded by later verified sources.", by: "mex learn", at: entry.mex.created };
      replaced.push({ ...old, mex: { ...old.mex, status: "retired", retired } });
      next.set(replaces, serializeEntry(replaced.at(-1)!));
    }
    existing.add(claim);
    const raw = serializeEntry(entry);
    next.set(entry.mex.id, raw);
    newNotes.set(entry.mex.id, makeNoteProof(plan, raw, sources));
    added.push(claim);
  }
  const saved: Receipt = { ...draft, count: added.length };
  const imported = draft.sources.filter(source => source.id.startsWith("session:"));
  const validate = () => {
    const live = writer.db.prepare("SELECT owner,state FROM jobs WHERE id=?").get(job.id);
    if (live?.owner !== job.owner || live?.state !== "running" || !learningOn(writer, project, plan)) {
      throw new Error("Learning lost its job or project registration before saving.");
    }
    const retired = retiredClaimHashes(writer, project);
    if (added.some(claim => retired.has(claim))) throw new Error("A rule was forgotten while learning was saving it.");
    if (imported.length && !importsEnabled(writer, project)) throw new Error("Past-session capture was turned off before saving.");
  };
  const save = () => {
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(project, key, JSON.stringify(saved));
    const set = writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)");
    const remove = writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?");
    for (const [id, proof] of newNotes) set.run(project, noteKey(id), proof);
    for (const source of imported) set.run(project, importedSourceKey(source.id), source.hash);
    saveSourceReads(writer, project, plan, draft.sources);
    for (const old of replaced) {
      saveTombstone(writer, project, old, old.mex.retired!);
      remove.run(project, noteKey(old.mex.id));
    }
    writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project, `learning.deep.shortlist.${job.id}.${job.batch}`);
    if (schedule) saveWeeklySchedule(writer, project, schedule);
  };
  if (added.length || replaced.length) publishNotes(writer, project, before, next, save, { validate });
  else {
    writer.db.exec("BEGIN IMMEDIATE");
    try { validate(); save(); writer.db.exec("COMMIT"); }
    catch (error) { writer.db.exec("ROLLBACK"); throw error; }
  }
  if (schedule) publishWeeklyWake(writer);
  return saved;
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

async function modelEntries(deps: Dependencies, context: Context, plan: LearningPlan, tree: PinnedTree, sources: LearningSource[],
  gaps: Set<string>, reviewers: Reviewers | undefined, weekly?: WeeklySchedule): Promise<LearnedEntry[]> {
  if (!sources.length) return [];
  const { writer, job, progress } = context;
  const project = job.project_id!;
  const pastSessions = sources.some(source => source.kind === "person");
  const earlier: EarlierEntry[] = [];
  for (const [id, raw] of snapshotNotes(writer, project).files) {
    if (!matchesProof(plan, raw, writer.setting(project, noteKey(id)))) continue;
    const entry = parseEntry(raw);
    if (entry.mex.status !== "active" || entry.mex.source.type === "person" || pastSessions) continue;
    const text = cleanSourceText(entry.text, reviewers);
    if (text) earlier.push({ id, text: text.slice(0, 600), created: entry.mex.created });
  }
  earlier.sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
  earlier.splice(12);
  const call = async (prompt: string, role: "cheap" | "best") => {
    if (pastSessions && !importsEnabled(writer, project)) throw new Error("Past-session capture was turned off before the model batch.");
    if (weekly && sessionsActive(writer, deps.now())) throw new AgentActive();
    if (!weekly && !fitsQuote(prompt, plan.ceiling - recordedModelSpend(writer, job.id))) throw new ModelWaitError("cap", CEILING_WAIT);
    const estimate = promptEstimate(prompt);
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
      return [];
    }
    if (!shortlist) {
      const prompt = filteringPrompt(sources);
      // Leave room for a writer call before spending on a new shortlist.
      const pair = tokenCount(promptEstimate(prompt)) + tokenCount(promptEstimate(writingPrompt(sources, earlier)));
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
  if (!selected.length) return [];
  progress?.(`Learning from ${selected.length} sources`);
  const response = await call(writingPrompt(selected, earlier), "best");
  const validated = await validatedEntries(response.text, selected, plan, tree, writer.location.home, job.id, earlier);
  if (validated.rejected) gaps.add("Some proposed entries could not be verified.");
  return validated.entries;
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
    display(job, reader) {
      const summary = reader.all<{ summary: string }>("SELECT summary FROM job_results WHERE job_id=? ORDER BY batch DESC LIMIT 1", job.id)[0]?.summary;
      return { used: recordedModelSpend(reader, job.id), ceiling: weeklyMode ? undefined : Plan.parse(JSON.parse(job.params)).ceiling, summary };
    },
    interrupted(job, writer) {
      try {
        if (writer.setting(job.project_id!, batchKey(job))) return { progress: "Finishing the saved batch after interruption" };
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
      const now = deps.now();
      if (weekly && weeklySchedule(writer, project) !== JSON.stringify(weekly)) return { checkpoint: state, done: true, summary: "A newer weekly schedule is in effect." };
      if (!learningOn(writer, project, params, now)) return { checkpoint: state, wait: "Waiting: MEX is off here" };
      if (weekly && sessionsActive(writer, now)) return waitForIdle(state, now);
      const spend = () => recordedModelSpend(writer, job.id);
      if (quoted && spend() >= quoted.ceiling) throw new ModelWaitError("cap", CEILING_WAIT);
      const finishGap = (why: string, retry = now + DAY_MS): BatchResult<Checkpoint> => weekly
        ? deferWeekly(context, weekly, state, retry, why)
        : result(context, quoted!, publish(context, quoted!, key, [], {
          checkpoint: { ...state, gaps: [...new Set([why, ...state.gaps])].slice(0, 24) }, done: true, sources: [], spent: spend(),
        }));
      if (!isDeepStrictEqual(await origin(params.checkout), params.origin)) return finishGap("The checkout's source repository changed.");
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
        const saveBatch = async (sources: LearningSource[], advanced: Pick<Checkpoint, "pull" | "doc" | "session">, reviewers?: Reviewers) => {
          const eligible = weekly ? sources.filter(source => !team?.read.has(coverageKey(source)) && !sourceRead(writer, project, activePlan, source)) : sources;
          const entries = await modelEntries(deps, context, activePlan, pinned, eligible, gaps, reviewers, weekly);
          const spent = spend();
          if (!weekly && spent > activePlan.ceiling) gaps.add("The last model batch reported more tokens than the approved ceiling.");
          const done = advanced.pull >= activePlan.pulls.length && advanced.doc >= activePlan.docs.length && (advanced.session ?? 0) >= activePlan.sessions.length;
          const schedule = done && (weekly || activePlan.refresh) ? scheduleFromPlan(activePlan, deps.next(deps.now())) : undefined;
          const saved = publish(context, activePlan, key, entries, { checkpoint: { ...advanced, weeklyPlan: state.weeklyPlan, gaps: [...gaps].slice(0, 24), recovered: state.recovered }, spent, done,
            sources: eligible.map(sourceRef),
          }, team, schedule);
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
        const pulls = plan.pulls.slice(state.pull, state.pull + PULLS_PER_BATCH);
        const docs = plan.docs.slice(state.doc, state.doc + DOCS_PER_BATCH);
        const reviews = await host.reviews(client, { source: plan.source, pulls, since: plan.since, until: plan.until, tree, preferred: plan.preferred });
        for (const gap of reviews.gaps) gaps.add(gap);
        if (job.batch === 0 && plan.origin.host === "github.com" && isDeepStrictEqual(plan.origin, plan.source)) {
          const status = await readGitHubWorkflows(client, tree, plan.origin, deps.now()).catch(() => undefined);
          if (status) saveGitHubWorkflows(writer, project, status);
        }
        const sources: LearningSource[] = [...reviews.reviews];
        for (const path of docs) {
          const raw = await tree.read(path);
          const excerpt = raw === undefined ? undefined : documentExcerpt(raw, reviews.reviewers);
          if (raw !== undefined && excerpt) {
            if (excerpt.coverage === "partial") gaps.add("Some long docs were only partly read.");
            sources.push({ id: `doc:${path}`, kind: "docs", path, ...excerpt, hash: sourceDigest(raw), at: await tree.lastChanged(path),
              link: `https://${plan.origin.host}/${plan.origin.slug}/${plan.origin.host === "gitlab.com" ? "-/" : ""}blob/${plan.head}/${path.split("/").map(encodeURIComponent).join("/")}` });
          } else if (raw === undefined || raw.trim()) gaps.add("Some docs could not be safely read.");
        }
        if (!weekly && job.batch === 0 && sources.length) {
          sources.push(...await contextSources(client, plan.source, plan.origin, tree, plan, reviews.reviewers, gaps));
        }
        return await saveBatch(sources, { pull: state.pull + pulls.length, doc: state.doc + docs.length }, reviews.reviewers);
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
