import { spawnSync } from "node:child_process";
import { DEFAULT_MODELS, type ModelAgent } from "../model-runner/models.js";
import type { CaptureAgent } from "./profiles.js";

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
