import type { MachineSetupStep } from "@mex/hub-contracts/machine";

export type SetupStepAction = "pause" | "resume" | "cancel";

export function setupJobTokens({ cost }: MachineSetupStep): number {
  return cost.uncachedInput + cost.cacheWrite + cost.cacheRead + cost.output;
}
