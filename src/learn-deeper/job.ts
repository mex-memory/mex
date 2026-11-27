import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { KnowledgeError } from "../knowledge/entry.js";
import { recoverNotes } from "../knowledge/personal-store.js";
import { ModelRunError, ModelWaitError, runModel, type ModelResult } from "../model-runner/index.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import { registerJobKind, type BatchContext, type BatchResult, type JobKind } from "../record/jobs.js";
import type { RecordWriter } from "../record/index.js";
import { clearLearningRows } from "../record/learning-rows.js";
import { refreshOwnUsage } from "../record/own-usage.js";
import { nativeBinary } from "../knowledge/check.js";
import { ForgeClient, hostToken, SourceError } from "./forge.js";
import { clearLearningChecks, origin, PinnedTree } from "./git.js";
import { hosts } from "./hosts.js";
import { DEEP_ANALYSIS, LEARN_KIND, Plan, type LearningPlan } from "./plan.js";
import { AgentActive, CURSOR_KEY, harvestClient, initialState, PipelineState, publishedBatch, reviewRows, runPipelineBatch, savedCursor } from "./pipeline.js";
import type { HarvestPlan } from "./harvest/types.js";
import { planWeekly, queuePatternRecount, RefreshDeferred, sweepExpiredTrials, sweepWeeklyRetirements, weeklySources } from "./weekly.js";
import { DAY_MS, nextWeeklyAt, publishWeeklyWake, SCHEDULE, scheduleFromPlan, sessionsActive, WEEKLY_KIND, WeeklySchedule, weeklySchedule } from "./weekly-schedule.js";
import { cancelLearning, clearRunEffects } from "./cancel.js";
import { sourcesRead, type DeepOutcome } from "./activity.js";
import type { WriterModel } from "./entries.js";

const modelName = z.string().regex(/^[A-Za-z\d][A-Za-z\d./_:@+-]{0,127}$/u);
const checkpointSchema = z.object({
  // Older checkpoints can still be read so an obsolete approved run can report a fresh quote.
  pull: z.number().int().nonnegative().optional(), doc: z.number().int().nonnegative().optional(),
  gaps: z.array(z.string().max(180)).max(24),
  retryAt: z.number().optional(), recovered: z.number().int().nonnegative().optional(),
  weeklyPlan: Plan.optional(), v2: z.unknown().optional(),
  finish: z.boolean().optional(), home: z.string().optional(), weeklyDue: z.number().optional(), rawPurged: z.literal(true).optional(),
}).passthrough();
type Checkpoint = z.infer<typeof checkpointSchema> & { outcome?: DeepOutcome };
type Context = BatchContext<unknown, Checkpoint>;

interface Dependencies {
  model: typeof runModel;
  client: (plan: Pick<LearningPlan, "checkout" | "origin">) => Promise<ForgeClient>;
  firstRules?: number;
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
  return job.checkpoint === null ? { gaps } : checkpointSchema.parse(JSON.parse(job.checkpoint));
}

export function learningOn(writer: RecordWriter, project: string, checkoutPath: string, now: number): boolean {
  const checkout = writer.checkout(checkoutPath);
  return checkout?.project_id === project && checkout.path === checkoutPath && checkoutOn(checkout, now)
    && automaticWorkEnabled(writer, project, now);
}

function waitForIdle(state: Checkpoint, now: number): BatchResult<Checkpoint> {
  return { checkpoint: { ...state, retryAt: now + 60_000 }, wait: "Waiting for agent sessions to go idle" };
}

function pipelineSummary(state: PipelineState, gaps: readonly string[]): string {
  const c = state.counts, n = (name: string) => c[name] ?? 0;
  const harvested = Object.entries(c).filter(([name]) => name.startsWith("harvested.")).reduce((sum, [, v]) => sum + v, 0);
  const dropped = Object.entries(c).filter(([name]) => name.startsWith("triage-dropped.")).reduce((sum, [, v]) => sum + v, 0);
  const parts = [`Read ${harvested} sources and kept ${n("triage-kept")} after sorting (${dropped} dropped).`];
  if (state.phase === "write" || state.phase === "finish") {
    parts.push(`Wrote ${n("norms")} norms and ${n("doc-rules")} doc rules. The evidence gate kept ${n("gate.keep")}.`);
    parts.push(`Saved ${n("saved")} entries, including updates. ${n("proven")} had a proven pattern, ${n("prose")} had prose, and ${n("proposed")} await your tick.`);
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
    const wait = error.category === "usage_limit"
      ? "The selected agent reached its usage limit. Learning will retry. Saved work is kept."
      : error.message;
    return { checkpoint: { ...state, retryAt: Number.isFinite(reset) && reset > now ? reset : now + 60_000 }, wait };
  }
  return undefined;
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

export function createLearnKind(dependencies: Partial<Dependencies> = {}, weeklyMode = false) {
  const deps = { ...defaults, ...dependencies };
  const kind: JobKind<unknown, Checkpoint> = {
    name: weeklyMode ? WEEKLY_KIND : LEARN_KIND, label: weeklyMode ? "Weekly learning" : DEEP_ANALYSIS,
    scope: "project", machineExclusive: true, sideEffects: "idempotent",
    ...(!weeklyMode ? { cancel: cancelLearning } : {}),
    ended(job, db) {
      const project = job.project_id;
      if (!project) return;
      clearLearningRows(db, project, job.id);
      if (!["done", "done with gaps"].includes(job.state)) return;
      if (!weeklyMode) clearRunEffects(db, job);
      const state = checkpoint(job);
      const due = state.weeklyDue;
      if (!state.finish && due === undefined) return;
      const plan = state.finish ? (weeklyMode ? state.weeklyPlan! : Plan.parse(JSON.parse(job.params))) : undefined;
      const set = db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
      const pipeline = PipelineState.safeParse(state.v2);
      if (state.finish && pipeline.success && pipeline.data.cursor) set.run(project, CURSOR_KEY, JSON.stringify(pipeline.data.cursor));
      if (weeklyMode || plan?.refresh) {
        const source = weeklyMode ? WeeklySchedule.parse(JSON.parse(job.params)) : undefined;
        const saved = db.prepare("SELECT value FROM settings WHERE scope=? AND key=?").get(project, SCHEDULE)?.value;
        if (source && saved !== JSON.stringify(source)) return;
        const schedule = plan ? scheduleFromPlan(plan, deps.next(deps.now())) : { ...source!, due: due! };
        set.run(project, SCHEDULE, JSON.stringify(schedule));
        if (state.home) publishWeeklyWake({ db, location: { home: state.home } });
      }
    },
    details(job, reader) {
      return reader.all<{ summary: string }>("SELECT summary FROM job_results WHERE job_id=? ORDER BY batch DESC LIMIT 1", job.id)[0]?.summary;
    },
    display(job, reader) {
      const { outcome, gaps, rawPurged } = checkpoint(job);
      const finalReason = (!outcome || rawPurged) && job.state === "done with gaps" ? kind.details?.(job, reader) : undefined;
      const action = [rawPurged ? finalReason : undefined, job.reason, ...gaps, finalReason].find(gap => gap &&
        /sign in|private repo|approved ceiling|run mex learn|paid model reply could not be recovered/iu.test(gap));
      const summary = outcome ? [`read ${outcome.sources} sources`, `${outcome.learned} ${outcome.learned === 1 ? "rule" : "rules"} learned`,
        ...(outcome.toConfirm ? [`${outcome.toConfirm} to confirm`] : []), ...(action ? [action] : [])].join(" \u00b7 ")
        : action ?? undefined;
      const plan = weeklyMode ? undefined : Plan.safeParse(JSON.parse(job.params));
      return { used: Math.max(job.tokens_used, recordedModelSpend(reader, job.id)), ceiling: plan?.data?.ceiling, summary };
    },
    interrupted(job, writer, backgroundStartup) {
      if (backgroundStartup) {
        const project = job.project_id!;
        clearLearningRows(writer.db, project, job.id);
        const state = checkpoint(job);
        // Sources can be read again for free. A paid batch may already have
        // run, so keep only durable results after clearing temporary data.
        const admitted = writer.db.prepare("SELECT 1 FROM model_batches WHERE job_id=? AND admitted_at IS NOT NULL").get(job.id);
        const saved = job.results || reviewRows(writer, project, job.id).length;
        return state.rawPurged || admitted || saved
          ? { checkpoint: JSON.stringify({ ...state, finish: false, rawPurged: true }), progress: "Finishing after interrupted learning was cleared" }
          : { checkpoint: JSON.stringify({ ...state, v2: undefined }), progress: "Reading sources again after interruption" };
      }
      if (publishedBatch(writer, job)) return { progress: "Finishing the saved batch after interruption" };
      return { progress: "Resuming from the last finished batch" };
    },
    ready(job, writer) {
      if (job.reason === CEILING_WAIT) return false;
      const state = checkpoint(job), now = deps.now();
      const parsed = JSON.parse(job.params);
      return (!state.retryAt || state.retryAt <= now) && (!weeklyMode || !sessionsActive(writer, now))
        && learningOn(writer, job.project_id!, (weeklyMode ? WeeklySchedule.parse(parsed) : Plan.parse(parsed)).checkout, now);
    },
    async runBatch(context) {
      const { job, writer, progress } = context, project = job.project_id!, now = deps.now();
      const weekly = weeklyMode ? WeeklySchedule.parse(context.params) : undefined;
      const quoted = weekly ? undefined : Plan.parse(context.params);
      const state = checkpoint(job, quoted?.gaps);
      const params = weekly ?? quoted!;
      const spent = () => Math.max(0, recordedModelSpend(writer, job.id) - job.tokens_used);
      const outcomeFor = (v2: PipelineState): DeepOutcome => {
        const rows = reviewRows(writer, project, job.id);
        return { sources: sourcesRead(v2), learned: rows.length,
          keptAutomatically: rows.filter(row => row.status === "active").length,
          toConfirm: rows.filter(row => row.status === "proposed").length,
          dropped: Object.entries(v2.counts).filter(([name]) => name.startsWith("gate.drop-")).reduce((sum, [, n]) => sum + n, 0),
          tokens: recordedModelSpend(writer, job.id), minutes: Math.max(0, (deps.now() - Date.parse(job.created_at)) / 60_000) };
      };
      const finishGap = (why: string, retry = now + DAY_MS): BatchResult<Checkpoint> => ({
        checkpoint: { ...state, home: writer.location.home, weeklyDue: weekly ? retry : undefined,
          outcome: PipelineState.safeParse(state.v2).success ? outcomeFor(PipelineState.parse(state.v2)) : undefined },
        done: true, gaps: true, summary: why, tokens: spent(),
      });
      if (!state.rawPurged) {
        if (weekly && weeklySchedule(writer, project) !== JSON.stringify(weekly)) return { checkpoint: state, done: true, summary: "A newer weekly schedule is in effect." };
        if (!learningOn(writer, project, params.checkout, now)) return { checkpoint: state, wait: "Waiting: MEX is off here" };
        if (weekly && sessionsActive(writer, now)) return waitForIdle(state, now);
        // Without it nothing that is paid for could be checked, or saved.
        if (!nativeBinary()) return { checkpoint: { ...state, retryAt: now + 60_000 }, wait: "Waiting: learning needs the installed check evaluator" };
      }
      await clearLearningChecks(writer.location.home, job.id);
      recoverNotes(writer, project);
      if (state.rawPurged) {
        // No source cursor advances when a run loses its input or model replies.
        const saved = reviewRows(writer, project, job.id).length;
        const summary = "Learning stopped after an interruption. Temporary sources and model replies were cleared. Run mex learn to start a new run.";
        return { ...finishGap(summary), results: Math.max(0, saved - job.results) };
      }
      try {
        if (!isDeepStrictEqual(await origin(params.checkout), params.origin)) return finishGap("The checkout's source repository changed.");
        let client: ForgeClient | undefined;
        const plan = quoted ?? state.weeklyPlan;
        if (weekly && !plan?.harvest) {
          progress?.("Checking sources on the default branch");
          let team, tree, recountGap = false;
          try {
            client = await deps.client(weekly);
            ({ tree, team } = await weeklySources(client, weekly, now));
          } finally {
            try { await queuePatternRecount(writer, project, weekly.checkout, team); }
            catch { recountGap = true; }
          }
          const next = await planWeekly(client, weekly, tree, now, savedCursor(writer, project), writer.setting(project, "learning.deep.issues") === "true");
          await sweepWeeklyRetirements(context, next, team);
          await sweepExpiredTrials(context, next, now);
          try { refreshOwnUsage(writer, { maxBytes: 512 << 10, maxFiles: 12, maxDiscoveryEntries: 256 }); } catch { /* admission requires measured usage */ }
          const gaps = recountGap ? [...next.gaps, "The weekly pattern recount could not be queued."] : next.gaps;
          return { checkpoint: { gaps, weeklyPlan: next }, progress: "Weekly sources selected" };
        }
        if (!plan?.harvest) return finishGap("This run needs a new quote. Run mex learn to use the current pipeline.");
        const tree = await PinnedTree.open(plan.checkout, plan.head);
        if (!tree) return finishGap("The approved Git revision is no longer readable in this checkout.");
        const decoded = PipelineState.safeParse(state.v2);
        if (state.v2 && !decoded.success) return finishGap("This run needs a new quote. Run mex learn to use the current pipeline.");
        const v2 = decoded.success ? decoded.data : initialState(savedCursor(writer, project));
        let active = plan;
        if (v2.phase === "harvest") {
          client = await deps.client(active);
          if (client.anonymous && (weekly || (active.harvest as unknown as HarvestPlan).inventory?.bands.length)) throw new SourceError("login");
          const access = await hosts[active.origin.host].access(client);
          const renamed = client.renamed;
          if (!isDeepStrictEqual(access.source, active.source) || access.visibility !== active.visibility) {
            if (renamed && isDeepStrictEqual(access.source, renamed) && access.visibility === active.visibility && renamed.host === active.origin.host) {
              active = { ...active, source: access.source, origin: { ...active.origin, slug: access.source.slug } };
            } else return finishGap("Source access changed. Run mex learn for a new quote.");
          }
        }
        const gaps = new Set(state.gaps);
        const out = await runPipelineBatch({ context, plan: active as LearningPlan & { harvest: HarvestPlan }, state: v2,
          deps: { model: deps.model, now: deps.now, client: client && harvestClient(client, active.source), tree, firstRules: deps.firstRules }, weekly: !!weekly, gaps });
        if (!weekly && recordedModelSpend(writer, job.id) > active.ceiling) gaps.add("The last model batch reported more tokens than the approved ceiling.");
        // A learned pattern has no count until the index is built with it. The first rules don't wait for the rest.
        if (out.results && !job.results || out.done && job.results + out.results > 0) {
          try { await queuePatternRecount(writer, project, plan.checkout); }
          catch { gaps.add("The learned patterns could not be counted yet."); }
        }
        const next: Checkpoint = { ...state, retryAt: undefined, v2: out.state, gaps: [...gaps].slice(0, 24), finish: out.done,
          home: out.done ? writer.location.home : undefined };
        if (out.done) next.outcome = outcomeFor(out.state);
        return { checkpoint: next, results: out.results, tokens: spent(), done: out.done,
          gaps: out.done && next.gaps.length > 0, summary: pipelineSummary(out.state, next.gaps), progress: out.progress };
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
        if (error instanceof SourceError && error.problem === "moved") return finishGap(error.message);
        const wait = waitOn(error, state, deps.now());
        if (wait) return wait;
        throw error;
      }
    },
  };
  return kind;
}

registerJobKind(createLearnKind());
registerJobKind(createLearnKind({}, true));
