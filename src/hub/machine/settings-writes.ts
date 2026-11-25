import { setCaptureEnabled, setCheckoutEnabled, setGlobalEnabled, setLearningSharing } from "../../controls/index.js";
import { rebuildNative } from "../../knowledge/native.js";
import { openRecord, type CheckoutRow, type RecordWriter } from "../../record/index.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { waitForRecordWriter } from "../../record/writer-wait.js";
import { changeTelemetryPreference } from "../../telemetry/index.js";
import { machinePath } from "./machine-projects.js";
import { HubRequestError } from "./security.js";
import { cliTelemetryHome } from "./settings-snapshot.js";
import { captureSetting, checkoutExists, checkoutPower, deliveryPower, sharingSetting, telemetrySetting, type SettingsApply } from "./settings-values.js";

type RecordChange = Exclude<SettingsApply["change"], { type: "telemetry" }>;

function changed(): HubRequestError {
  return new HubRequestError(409, "REVISION_CONFLICT", "The setting changed", "Refresh Settings and review your change again.");
}

export function checkSetting(expected: string, current: { revision?: string; disabledReason?: string }) {
  if (current.revision !== expected) throw changed();
  if (current.disabledReason) throw new HubRequestError(409, "REVISION_CONFLICT", "This setting can’t be changed", current.disabledReason);
}

function projectCheckout(writer: RecordWriter, repo: string): string {
  if (!/^[gf]-[a-f0-9]{24}$/u.test(repo) || !writer.project(repo)) throw changed();
  const paths = writer.db.prepare("SELECT path FROM checkouts WHERE project_id=? ORDER BY path LIMIT 64").all(repo);
  const path = paths.map(row => String(row.path)).find(path => machinePath(path) && checkoutExists(path));
  if (!path) throw changed();
  return path;
}

function exactCheckout(writer: RecordWriter, path: string): CheckoutRow {
  if (!machinePath(path) || !checkoutExists(path)) throw changed();
  const row = writer.checkout(path);
  if (row?.path !== path) throw changed();
  return row;
}

/** Callers schedule the CLI’s best-effort rule file refresh outside the request. */
export function refreshCheckoutRules(location: LocationOptions, path: string): void {
  try { rebuildNative({ ...location, projectPath: path }, { force: true }); }
  catch { /* The next rebuild catches up, as after a terminal switch. */ }
}

export async function applyRecordSetting(
  location: LocationOptions, env: NodeJS.ProcessEnv, clock: () => number, change: RecordChange, expected: string,
): Promise<string | undefined> {
  const writer = await waitForRecordWriter(location);
  const now = clock();
  try {
    switch (change.type) {
      case "globalPower":
        setGlobalEnabled(writer, change.enabled, () => checkSetting(expected, deliveryPower(writer, env)));
        return;
      case "checkoutPower": {
        const { path, power } = change;
        exactCheckout(writer, path);
        const until = power.state === "offUntil" ? new Date(power.until).toISOString() : null;
        if (until && Date.parse(until) <= now) {
          throw new HubRequestError(400, "INVALID_REQUEST", "Choose a future time", "Set a future time to turn MEX back on.");
        }
        setCheckoutEnabled(writer, path, power.state === "on", until, current => {
          if (current.path !== path) throw changed();
          checkSetting(expected, checkoutPower(writer, current, now, env));
        });
        return path;
      }
      case "capture": {
        const path = change.repoId === undefined ? undefined : projectCheckout(writer, change.repoId);
        setCaptureEnabled(writer, change.enabled, path, scope => {
          if (scope !== (change.repoId ?? "global") || path && exactCheckout(writer, path).project_id !== scope) throw changed();
          checkSetting(expected, captureSetting(writer, change.repoId));
        });
        return;
      }
      case "sharing": {
        const path = projectCheckout(writer, change.repoId);
        setLearningSharing(writer, change.mode, path, scope => {
          if (scope !== change.repoId || exactCheckout(writer, path).project_id !== scope) throw changed();
          checkSetting(expected, sharingSetting(writer, scope, true));
        });
        return;
      }
    }
  } finally { writer.close(); }
}


export async function applyTelemetrySetting(location: LocationOptions, env: NodeJS.ProcessEnv, enabled: boolean, expected: string) {
  const { home } = recordLocation({ ...location, create: false });
  const writable = cliTelemetryHome(location);
  const check = () => checkSetting(expected, telemetrySetting(home, env, writable));
  check();
  (await waitForRecordWriter(location)).close();
  const { purged } = await changeTelemetryPreference(enabled, () => {
    check();
    // Fail on an already busy or newer record before changing the opt-out marker.
    const writer = openRecord({ ...location, create: false, busyTimeoutMs: 0 });
    writer.close();
  });
  return purged ? undefined : "Telemetry is off. The local queue couldn’t be cleared.";
}
