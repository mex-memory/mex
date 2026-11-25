import type { JobKind } from "../record/jobs.js";
import { registerJobKind } from "../record/jobs.js";
import { importLearningOn, sessionRunner, SESSION_LEARN_KIND, SESSION_RUNNER_WAIT } from "../knowledge/session-learning.js";
import { producer } from "../knowledge/producers.js";
import { nativeBinary } from "../knowledge/check.js";
import { position, samePosition, type Position } from "../judge/evidence.js";
import { recordChecks } from "../judge/native.js";
import { ModelRunError, ModelWaitError, runModel } from "../model-runner/index.js";
import { filterAllowed, type FilterParams } from "./input.js";
import { importSession, rememberImport, selectImportedInput, SessionImportPlan } from "./import-data.js";
import { STAGE_TWO_WAIT } from "./pending.js";
import { filterRunner, prepareSessionRunner, sessionRunnerReady } from "./runner.js";
import { ownedFilterWrite, runStageOne, stageOneRoom, STAGE_ONE_WAIT } from "./stage-one.js";
import { runStageTwo, stageTwoDue, stageTwoPending } from "./stage-two.js";

const OFF_WAIT = "Waiting: past-session learning is off here.";
const MODE_WAIT = "Waiting: choose the runner approved for this import, or cancel it and preview again.";
const CHECKS_WAIT = "Waiting: the filter needs the installed check evaluator";
type Progress = { index: number; position: Position; gaps: string[] };
type Ports = { model?: typeof runModel; choose?: typeof filterRunner; recordChecks?: typeof recordChecks; clock?: () => number; checksReady?: () => boolean };

function filterParams(plan: SessionImportPlan, index: number): FilterParams {
  return { checkout: plan.checkout, agent: plan.files[Math.min(index, plan.files.length - 1)]!.agent, importing: true };
}

export function createSessionImportKind(ports: Ports = {}): JobKind<SessionImportPlan, Progress> {
  const clock = ports.clock ?? Date.now;
  return {
    name: SESSION_LEARN_KIND, label: "Learning from past sessions", scope: "project", machineExclusive: true, sideEffects: "idempotent",
    reserved: producer("session-import").active ? undefined : "Learning from past sessions isn't available in this version yet; nothing was queued.",
    async runBatch({ writer, job, params, checkpoint }) {
      const plan = SessionImportPlan.parse(params), project = job.project_id!, at = await position(plan.checkout);
      const state = checkpoint ?? { position: at, index: 0, gaps: plan.gaps };
      const source = filterParams(plan, state.index), enabled = () => importLearningOn(writer);
      if (!enabled() || !filterAllowed(writer, project, source)) return { checkpoint: state, wait: OFF_WAIT };
      if (!samePosition(at, state.position) || project.startsWith("g-") && !at.head) {
        return { checkpoint: state, done: true, gaps: true, summary: "Checkout changed after approval. Review a new session import." };
      }
      const preference = sessionRunner(writer);
      if (!preference) return { checkpoint: state, wait: SESSION_RUNNER_WAIT };
      if (preference.mode !== plan.mode) return { checkpoint: state, wait: MODE_WAIT };
      const gaps = new Set(state.gaps);
      const next = (index = state.index) => ({ index, position: at, gaps: [...gaps].slice(0, 16) });
      const done = () => ({ checkpoint: next(), done: true, gaps: gaps.size > 0,
        summary: ["Finished the approved past-session import", ...gaps].join(" · ") });
      try {
        const { params, model } = prepareSessionRunner(writer, source, ports.model ?? runModel, ports.choose);
        const stageTwo = () => runStageTwo(writer, project, params, job, at,
          { model, clock, enabled, recordChecks: ports.recordChecks ?? recordChecks, checksReady: ports.checksReady ?? (() => !!nativeBinary()) });
        const local = params.runner.mode === "none";
        const file = plan.files[state.index];
        if (file) {
          const session = importSession(file);
          ownedFilterWrite(writer, job, () => {
            if (!enabled() || !filterAllowed(writer, project, params)) throw new ModelWaitError("off", OFF_WAIT);
            rememberImport(writer, project, plan, file);
          });
          const input = await runStageOne(writer, project, params, job, at, 0, { model, clock, enabled,
            imported: (selection, now, mode) => selectImportedInput(writer, project, plan.checkout, session, now, mode, selection, gaps) });
          const progress = `${state.index} of ${plan.files.length} past sessions labelled`;
          if (input?.gaps) gaps.add("Some approved prompts had no verified verdict after retry.");
          if (input?.wait === STAGE_ONE_WAIT && !local && stageTwoDue(writer, project, clock())) {
            const result = await stageTwo();
            if (result) return { ...result, checkpoint: next(), progress };
          }
          return input ? { ...input, checkpoint: next(), gaps: undefined, progress }
            : { checkpoint: next(state.index + 1), progress: `${state.index + 1} of ${plan.files.length} past sessions labelled` };
        }
        if (local) return done();
        const checked = await stageTwo();
        if (checked?.tokens !== undefined && !checked.wait) return { ...done(), ...checked, summary: [checked.summary, ...gaps].join(" · ") };
        if (checked) return { ...checked, checkpoint: next() };
        if (!stageTwoDue(writer, project, clock()) && stageTwoPending(writer, project, plan.checkout, clock(), at.branch, true))
          return { checkpoint: next(), wait: STAGE_TWO_WAIT };
        return done();
      } catch (error) {
        if (error instanceof ModelWaitError || error instanceof ModelRunError && ["authentication", "usage_limit"].includes(error.category))
          return { checkpoint: next(), wait: error.message };
        throw error;
      }
    },
    ready(job, writer) {
      const plan = SessionImportPlan.parse(JSON.parse(job.params)), project = job.project_id!;
      const state = job.checkpoint ? JSON.parse(job.checkpoint) as Progress : undefined;
      const source = filterParams(plan, state?.index ?? 0);
      if (!importLearningOn(writer) || !filterAllowed(writer, project, source) || sessionRunner(writer)?.mode !== plan.mode) return false;
      if (!sessionRunnerReady(writer, job.reason, source.agent === "claude" ? "claude-code" : "codex", ports.choose)) return false;
      if (job.reason === CHECKS_WAIT) return (ports.checksReady ?? (() => !!nativeBinary()))();
      if (job.reason === STAGE_TWO_WAIT) return stageTwoDue(writer, project, clock());
      if (job.reason === STAGE_ONE_WAIT) return stageOneRoom(writer, project) || stageTwoDue(writer, project, clock())
        && stageTwoPending(writer, project, plan.checkout, clock(), state?.position.branch, true);
      return !["Sign in to the selected agent CLI before retrying.", "The selected agent reached its usage limit."].includes(job.reason ?? "");
    },
  };
}

registerJobKind(createSessionImportKind());
