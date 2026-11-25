import type { MachineSettingsApplyRequestSchema, MachineSettingsSchema } from "@mex/hub-contracts/machine";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import type { z } from "zod";
import { checkoutOn } from "../../controls/index.js";
import { readGlobalConfig, readTelemetryPreference } from "../../global-config.js";
import type { CheckoutRow, RecordReader } from "../../record/index.js";
import { telemetryEnabled } from "../../telemetry/policy.js";
import { machineTime } from "./machine-projects.js";

export type MachineSettings = z.infer<typeof MachineSettingsSchema>;
export type SettingsApply = z.infer<typeof MachineSettingsApplyRequestSchema>;
type Source = Pick<RecordReader, "setting"> | undefined;

function revision(...fields: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export function deliveryPower(reader: Source, env: NodeJS.ProcessEnv): MachineSettings["everywhere"] {
  const raw = reader?.setting("global", "enabled");
  if (env.MEX_OFF === "1") return { enabled: false, source: "environment", disabledReason: "MEX_OFF=1 turns off MEX in the terminal that started this Hub." };
  return { enabled: raw !== "false", source: raw === undefined ? "default" : "global", revision: revision("everywhere", raw) };
}

export function checkoutExists(path: string): boolean {
  try { return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false; }
  catch { return false; }
}

export function checkoutPower(reader: Source, checkout: CheckoutRow, now: number, env: NodeJS.ProcessEnv): MachineSettings["repos"][number]["checkouts"][number] {
  const { path, project_id, state, off_until } = checkout;
  const until = machineTime(off_until);
  const power = checkoutOn(checkout, now) ? { state: "on" as const }
    : state === "off until" && until ? { state: "offUntil" as const, until } : { state: "off" as const };
  const global = deliveryPower(reader, env);
  const disabledReason = !checkoutExists(path) ? "This checkout’s folder couldn’t be found."
    : global.disabledReason ?? (!global.enabled ? "MEX is off everywhere. Turn it on to change this checkout." : undefined);
  return { path, power, source: "checkout", disabledReason,
    revision: revision("checkout", path, project_id, state, off_until, global.revision) };
}

export function captureSetting(reader: Source, repoId?: string, hasCheckout = true): MachineSettings["capture"] {
  const global = reader?.setting("global", "capture.enabled");
  const local = repoId ? reader?.setting(repoId, "capture.enabled") : undefined;
  const effective = global !== "false" && local !== "false";
  const disabledReason = repoId && !hasCheckout ? "This repo needs an existing checkout."
    : repoId && global === "false" ? "Capture is off everywhere. Turn it on to change this repo." : undefined;
  return { enabled: effective, source: (repoId && global !== "false" && local !== undefined) ? "repo" : global !== undefined ? "global" : "default",
    disabledReason, revision: revision("capture", repoId, global, local) };
}

export function sharingSetting(reader: Source, repoId: string, hasCheckout: boolean): MachineSettings["repos"][number]["sharing"] {
  const raw = reader?.setting(repoId, "learning.sharing");
  return { mode: raw === "manual" ? "manual" : "automatic", source: raw === undefined ? "default" : "repo",
    disabledReason: !hasCheckout ? "This repo needs an existing checkout." : undefined, revision: revision("sharing", repoId, raw) };
}

export function telemetrySetting(home: string, env: NodeJS.ProcessEnv, writable: boolean): MachineSettings["telemetry"] {
  const preference = readTelemetryPreference(home);
  const { enabled, reason } = telemetryEnabled({ home, env });
  const disabledReason = reason === "config_unavailable" || preference === "unavailable" ? "The telemetry preference couldn’t be read. Check mex telemetry status."
    : reason === "dev" ? "Telemetry is off in the MEX development checkout."
    : reason && reason !== "config" ? "Telemetry is off because " + reason + " is set."
    : !writable ? "Use mex telemetry on or mex telemetry off in the terminal for this MEX home." : undefined;
  const source = disabledReason && reason !== "config" ? reason === "dev" ? "policy" : ["DO_NOT_TRACK", "MEX_TELEMETRY", "MEX_OFFLINE"].includes(reason ?? "") ? "environment" : "global"
    : preference === "off" || readGlobalConfig(home).telemetry === "on" ? "global" : "default";
  return { enabled, source, disabledReason, revision: revision("telemetry", preference) };
}
