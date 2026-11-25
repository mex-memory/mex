/**
 * The telemetry on/off switch, apart from the capture entry point, so the Hub's
 * Settings page can change the preference without importing event capture.
 */
import { ensureMexHomeDir, mexHomeDir } from "../global-config.js";
import { withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import { disableTelemetry, enableTelemetry } from "./index.js";

/** Serialize explicit preference changes from the terminal and the Hub. */
export async function changeTelemetryPreference(enabled: boolean, check?: () => void): Promise<{ purged: boolean }> {
  ensureMexHomeDir();
  return withContainedArtifactLock(mexHomeDir(), "telemetry", ".preference.lock", () => {
    check?.();
    if (!enabled) return disableTelemetry();
    enableTelemetry();
    return { purged: true };
  });
}
