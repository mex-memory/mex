import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { KnowledgeError } from "../knowledge/entry.js";
import { recoverNotes } from "../knowledge/personal-store.js";
import { ModelRunError, ModelWaitError, runModel, type ModelResult } from "../model-runner/index.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import { registerJobKind, type BatchContext, type BatchResult, type JobKind } from "../record/jobs.js";
import type { RecordWriter } from "../record/index.js";
import { refreshOwnUsage } from "../record/own-usage.js";
import { ForgeClient, hostToken, SourceError } from "./forge.js";
import { clearLearningChecks, origin, PinnedTree } from "./git.js";
import { hosts } from "./hosts.js";
import { LEARN_KIND, Plan, type LearningPlan } from "./plan.js";
import { AgentActive, clearRunRows, CURSOR_KEY, harvestClient, initialState, PipelineState, publishedBatch, runPipelineBatch, savedCursor } from "./pipeline.js";
import type { HarvestPlan } from "./harvest/types.js";
import { planWeekly, queuePatternRecount, RefreshDeferred, sweepWeeklyRetirements, weeklySources } from "./weekly.js";
import { DAY_MS, nextWeeklyAt, publishWeeklyWake, SCHEDULE, scheduleFromPlan, sessionsActive, WEEKLY_KIND, WeeklySchedule, weeklySchedule } from "./weekly-schedule.js";
import type { WriterModel } from "./entries.js";

const modelName = z.string().regex(/^[A-Za-z\d][A-Za-z\d./_:@+-]{0,127}$/u);
const checkpointSchema = z.object({
  // Older checkpoints can still be read so an obsolete approved run can report a fresh quote.
  pull: z.number().int().nonnegative().optional(), doc: z.number().int().nonnegative().optional(),
  gaps: z.array(z.string().max(180)).max(24),
  retryAt: z.number().optional(), recovered: z.number().int().nonnegative().optional(),
  weeklyPlan: Plan.optional(), v2: PipelineState.optional(),
  finish: z.boolean().optional(), home: z.string().optional(), weeklyDue: z.number().optional(),
}).passthrough();
type Checkpoint = z.infer<typeof checkpointSchema>;
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
    parts.push(`Lessons: ${n("cluster.write")} corroborated, ${n("cluster.propose")} single strong, ${n("cluster.drop")} dropped.`);
    parts.push(`Saved ${n("saved")} entries, including updates. ${n("proven")} had a proven pattern, ${n("prose")} had scoped text, and ${n("proposed")} await your tick.`);
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
    name: weeklyMode ? WEEKLY_KIND : LEARN_KIND, label: weeklyMode ? "Weekly learning" : "Learn deeper",
    scope: "project", machineExclusive: true, sideEffects: "idempotent",
    ended(job, db) {
      const project = job.project_id;
      if (!project) return;
      clearRunRows(db, project, job.id);
      const state = checkpoint(job);
      if (!["done", "done with gaps"].includes(job.state)) return;
      const due = state.weeklyDue;
      if (!state.finish && due === undefined) return;
      const plan = state.finish ? (weeklyMode ? state.weeklyPlan! : Plan.parse(JSON.parse(job.params))) : undefined;
      const set = db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
      if (state.finish && state.v2?.cursor) set.run(project, CURSOR_KEY, JSON.stringify(state.v2.cursor));
      if (weeklyMode || plan?.refresh) {
        const source = weeklyMode ? WeeklySchedule.parse(JSON.parse(job.params)) : undefined;
        const saved = db.prepare("SELECT value FROM settings WHERE scope=? AND key=?").get(project, SCHEDULE)?.value;
        if (source && saved !== JSON.stringify(source)) return;
        const schedule = plan ? scheduleFromPlan(plan, deps.next(deps.now())) : { ...source!, due: due! };
        set.run(project, SCHEDULE, JSON.stringify(schedule));
        if (state.home) publishWeeklyWake({ db, location: { home: state.home } });
      }
    },
    display(job, reader) {
      const summary = reader.all<{ summary: string }>("SELECT summary FROM job_results WHERE job_id=? ORDER BY batch DESC LIMIT 1", job.id)[0]?.summary;
      return { used: recordedModelSpend(reader, job.id), ceiling: weeklyMode ? undefined : Plan.parse(JSON.parse(job.params)).ceiling, summary };
    },
    interrupted(job, writer) {
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
      const finishGap = (why: string, retry = now + DAY_MS): BatchResult<Checkpoint> => ({
        checkpoint: { ...state, home: writer.location.home, weeklyDue: weekly ? retry : undefined },
        done: true, gaps: true, summary: why, tokens: spent(),
      });
      if (weekly && weeklySchedule(writer, project) !== JSON.stringify(weekly)) return { checkpoint: state, done: true, summary: "A newer weekly schedule is in effect." };
      if (!learningOn(writer, project, params.checkout, now)) return { checkpoint: state, wait: "Waiting: MEX is off here" };
      if (weekly && sessionsActive(writer, now)) return waitForIdle(state, now);
      await clearLearningChecks(writer.location.home, job.id);
      recoverNotes(writer, project);
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
          try { refreshOwnUsage(writer, { maxBytes: 512 << 10, maxFiles: 12, maxDiscoveryEntries: 256 }); } catch { /* admission requires measured usage */ }
          const gaps = recountGap ? [...next.gaps, "The weekly pattern recount could not be queued."] : next.gaps;
          return { checkpoint: { gaps, weeklyPlan: next }, progress: "Weekly sources selected" };
        }
        if (!plan?.harvest) return finishGap("This run needs a new quote. Run mex learn to use the current pipeline.");
        const tree = await PinnedTree.open(plan.checkout, plan.head);
        if (!tree) return finishGap("The approved Git revision is no longer readable in this checkout.");
        const v2 = state.v2 ?? initialState(savedCursor(writer, project));
        if (v2.phase === "harvest") {
          client = await deps.client(plan);
          if (client.anonymous && (weekly || (plan.harvest as unknown as HarvestPlan).inventory?.bands.length)) throw new SourceError("login");
          const access = await hosts[plan.origin.host].access(client);
          if (!isDeepStrictEqual(access.source, plan.source) || access.visibility !== plan.visibility) {
            return finishGap("Source access changed. Run mex learn for a new quote.");
          }
        }
        const gaps = new Set(state.gaps);
        const out = await runPipelineBatch({ context, plan: plan as LearningPlan & { harvest: HarvestPlan }, state: v2,
          deps: { model: deps.model, now: deps.now, client: client && harvestClient(client, plan.source), tree, firstRules: deps.firstRules }, weekly: !!weekly, gaps });
        if (!weekly && recordedModelSpend(writer, job.id) > plan.ceiling) gaps.add("The last model batch reported more tokens than the approved ceiling.");
        // A learned pattern has no count until the index is built with it. The first rules don't wait for the rest.
        if (out.results && !job.results || out.done && job.results + out.results > 0) {
          try { await queuePatternRecount(writer, project, plan.checkout); }
          catch { gaps.add("The learned patterns could not be counted yet."); }
        }
        const next: Checkpoint = { ...state, retryAt: undefined, v2: out.state, gaps: [...gaps].slice(0, 24), finish: out.done,
          home: out.done ? writer.location.home : undefined };
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
