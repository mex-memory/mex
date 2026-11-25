import { isDevRepo, readGlobalConfig, readTelemetryPreference } from "../global-config.js";

export const TELEMETRY_NOTICE_VERSION = 3;
/** CI detection lives with the shared caller check; telemetry keeps its import site. */
export { isCI } from "../repo-start/caller.js";

export function telemetryEnabled({ home, env = process.env }: { home?: string; env?: NodeJS.ProcessEnv } = {}): { enabled: boolean; reason?: string } {
  if (env.DO_NOT_TRACK === "1") return { enabled: false, reason: "DO_NOT_TRACK" };
  if (env.MEX_TELEMETRY === "0") return { enabled: false, reason: "MEX_TELEMETRY" };
  if (env.MEX_OFFLINE === "1") return { enabled: false, reason: "MEX_OFFLINE" };
  if (isDevRepo(env)) return { enabled: false, reason: "dev" };
  const preference = readTelemetryPreference(home);
  if (preference === "off") return { enabled: false, reason: "config" };
  if (preference === "unavailable") return { enabled: false, reason: "config_unavailable" };
  return { enabled: true };
}

/** The old v2 notice is insufficient: upgrading users see the new explanation once. */
export function reportingAllowed(): boolean {
  return telemetryEnabled().enabled && readGlobalConfig().telemetryNoticeVersion === TELEMETRY_NOTICE_VERSION;
}
