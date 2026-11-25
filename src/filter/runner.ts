import { spawnSync } from "node:child_process";
import { DEFAULT_MODELS, type ModelAgent } from "../model-runner/models.js";
import type { CaptureAgent } from "./profiles.js";
import { sessionRunner, SESSION_RUNNER_WAIT } from "../knowledge/session-learning.js";
import type { RecordWriter } from "../record/index.js";
import type { runModel } from "../model-runner/index.js";
import { ModelWaitError } from "../model-runner/budget-queue.js";
import { runSessionApi } from "../model-runner/session-api.js";
import { sessionApiKey, SESSION_API_AUTH_WAIT, SESSION_API_KEY_WAIT, SESSION_API_LIMIT_WAIT } from "../model-runner/session-api-policy.js";
import { filterAllowed, type FilterParams } from "./input.js";

export const FILTER_RUNNER_WAIT = "Waiting: install a supported background model CLI";

export function sourceModelAgent(agent: CaptureAgent | undefined): ModelAgent | undefined {
  if (agent === "claude-code") return "claude";
  if (agent === "codex") return agent;
}

const onPath = (agent: ModelAgent): boolean => spawnSync(process.platform === "win32" ? "where.exe" : "which", [agent], {
  stdio: "ignore", windowsHide: true, timeout: 1500,
}).status === 0;

/** Only approved text-mode runners with a cheap tier can run this job. */
export function filterRunner(source: CaptureAgent, installed = onPath): ModelAgent | undefined {
  const preferred = sourceModelAgent(source);
  const supported = Object.keys(DEFAULT_MODELS) as ModelAgent[];
  const order = preferred ? [preferred, ...supported.filter(agent => agent !== preferred)] : supported;
  return order.find(agent => DEFAULT_MODELS[agent].cheap && installed(agent));
}

export function prepareSessionRunner(writer: RecordWriter, params: FilterParams, model: typeof runModel,
  choose: typeof filterRunner = filterRunner, api: typeof runSessionApi = runSessionApi) {
  const runner = sessionRunner(writer);
  if (!runner) throw new ModelWaitError("off", SESSION_RUNNER_WAIT);
  const sourceAgent = params.sourceAgent ?? (params.agent === "claude" ? "claude-code" : "codex");
  const agent = runner.mode === "cli" ? choose(sourceAgent) : params.agent;
  if (!agent) throw new ModelWaitError("storage", FILTER_RUNNER_WAIT);
  if (runner.mode === "api" && !sessionApiKey()) throw new ModelWaitError("storage", SESSION_API_KEY_WAIT);
  const scoped = { ...params, sourceAgent, agent, runner };
  const project = writer.checkout(params.checkout)?.project_id;
  return {
    params: scoped,
    model: ((request) => {
      if (!project || !filterAllowed(writer, project, scoped) || runner.mode === "none" || !request.automatic)
        throw new ModelWaitError("off", SESSION_RUNNER_WAIT);
      return (runner.mode === "api" ? api : model)({ ...request, automatic: { ...request.automatic, sessionRunner: runner, sessionImport: params.importing } });
    }) satisfies typeof runModel,
  };
}

export function sessionRunnerReady(writer: RecordWriter, reason: string | null, source: CaptureAgent, choose = filterRunner): boolean {
  const runner = sessionRunner(writer);
  if (reason === SESSION_RUNNER_WAIT) return !!runner;
  if (reason === FILTER_RUNNER_WAIT) return !!runner && (runner.mode !== "cli" || !!choose(source));
  if (reason === SESSION_API_KEY_WAIT) return !!runner && (runner.mode !== "api" || !!sessionApiKey());
  if (reason === SESSION_API_AUTH_WAIT || reason === SESSION_API_LIMIT_WAIT) return !!runner && runner.mode !== "api";
  return true;
}
