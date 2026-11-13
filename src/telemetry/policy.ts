import { isDevRepo, readGlobalConfig, readTelemetryPreference } from "../global-config.js";

export const TELEMETRY_NOTICE_VERSION = 3;
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "TF_BUILD", "BUILDKITE", "CIRCLECI"].some((key) => {
    const value = env[key]?.trim().toLowerCase();
    return value !== undefined && value !== "" && !["0", "false", "no"].includes(value);
  }) || !!env.JENKINS_URL;
}

export function telemetryEnabled(): { enabled: boolean; reason?: string } {
  if (process.env.DO_NOT_TRACK === "1") return { enabled: false, reason: "DO_NOT_TRACK" };
  if (process.env.MEX_TELEMETRY === "0") return { enabled: false, reason: "MEX_TELEMETRY" };
  if (process.env.MEX_OFFLINE === "1") return { enabled: false, reason: "MEX_OFFLINE" };
  if (isDevRepo()) return { enabled: false, reason: "dev" };
  const preference = readTelemetryPreference();
  if (preference === "off") return { enabled: false, reason: "config" };
  if (preference === "unavailable") return { enabled: false, reason: "config_unavailable" };
  return { enabled: true };
}

/** The old v2 notice is insufficient: upgrading users see the new explanation once. */
export function reportingAllowed(): boolean {
  return telemetryEnabled().enabled && readGlobalConfig().telemetryNoticeVersion === TELEMETRY_NOTICE_VERSION;
}
