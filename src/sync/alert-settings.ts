import { installDriftAlertHook, removeDriftAlertHook } from "./alert-hook.js";
import { readDriftAlertState, updateDriftAlertState, type DriftAlertState } from "./alert-state.js";

function installHook(projectRoot: string): boolean {
  try { return installDriftAlertHook(projectRoot); }
  catch { return false; }
}

/** Explicit Hub/watch startup owns default installation; reads never install hooks. */
export async function initializeDriftAlerts(projectRoot: string): Promise<void> {
  if (!readDriftAlertState(projectRoot).enabled) return;
  await updateDriftAlertState(projectRoot, (current) => current.enabled
    ? { ...current, commitHook: installHook(projectRoot) }
    : current);
}

export async function setDriftAlertsEnabled(projectRoot: string, enabled: boolean): Promise<DriftAlertState> {
  if (enabled) return updateDriftAlertState(projectRoot, (current) => ({ ...current, enabled, commitHook: installHook(projectRoot) }));
  // Persist off first, so even an unremovable hook becomes inert.
  const state = await updateDriftAlertState(projectRoot, () => ({
    enabled, commitHook: false, lastDelivery: "none", checkedFingerprint: null, alerted: {},
  }));
  removeDriftAlertHook(projectRoot);
  return state;
}
