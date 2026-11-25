import { setImmediate } from "node:timers/promises";
import { mexHomeDir } from "../../global-config.js";
import { AGENT_NAMES } from "../../install/index.js";
import { recordedHintCounts, recordedHintExpiry } from "../../knowledge/hints.js";
import { WeeklySchedule, WEEKLY_SCHEDULE_KEY } from "../../learn-deeper/weekly-schedule.js";
import { readModelUse } from "../../model-runner/model-use.js";
import { openRecordReadOnly, type RecordReader } from "../../record/index.js";
import { backgroundSettings, leaseLive } from "../../record/background.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { sentReports } from "../../telemetry/store.js";
import { machineProjects, machineTime, type MachineProject } from "./machine-projects.js";
import { storageSnapshot } from "./machine-storage.js";
import { boundedSetting } from "./read.js";
import { captureSetting, checkoutExists, checkoutPower, deliveryPower, sharingSetting, telemetrySetting, type MachineSettings } from "./settings-values.js";

export interface MachineSettingsOptions extends LocationOptions {
  mode: MachineSettings["about"]["hubMode"];
  version: string;
  env?: NodeJS.ProcessEnv;
  now: () => number;
}

export function cliTelemetryHome(location: LocationOptions): boolean {
  return recordLocation({ ...location, create: false }).home === recordLocation({ home: mexHomeDir(), create: false }).home;
}

function weekly(reader: RecordReader | undefined, id: string) {
  const raw = reader && boundedSetting(reader, id, WEEKLY_SCHEDULE_KEY, 64 << 10);
  if (!raw) return { weekly: null, weeklyUnavailable: !!reader?.get("SELECT 1 FROM settings WHERE scope=? AND key=?", id, WEEKLY_SCHEDULE_KEY) };
  try {
    const nextRunAt = machineTime(WeeklySchedule.parse(JSON.parse(raw)).due);
    if (nextRunAt) return { weekly: { nextRunAt } };
  } catch { /* Rows from an unreadable schedule are not treated as off. */ }
  return { weekly: null, weeklyUnavailable: true };
}

function readOutbound(reader: RecordReader | undefined): MachineSettings["outbound"] {
  if (!reader) return { telemetry: [], modelCalls: [] };
  const telemetry = sentReports(reader).reverse().map(report => ({
    id: report.uuid, at: report.timestamp, event: report.event, fields: Object.keys(report.properties).sort(),
  }));
  const modelCalls = reader.all<{ id: number; ts: string; purpose: string; agent: string; tokens: number; estimated: number }>(`
    SELECT id,ts,substr(purpose,1,512) purpose,substr(agent,1,512) agent, input+cache_read+cache_write+output tokens,estimated
    FROM model_calls WHERE kind='headless' ORDER BY ts DESC,id DESC LIMIT 100`).flatMap(row => {
    const at = machineTime(row.ts);
    if (!at || !Number.isSafeInteger(row.tokens) || row.tokens < 0) return [];
    const agent = Object.hasOwn(AGENT_NAMES, row.agent) ? AGENT_NAMES[row.agent as keyof typeof AGENT_NAMES] : row.agent;
    return [{ id: String(row.id), at, agent: agent || "Unknown", purpose: row.purpose || "Model run", tokens: row.tokens, estimated: row.estimated === 1 }];
  });
  return { telemetry, modelCalls };
}

function readHints(reader: RecordReader | undefined, projects: MachineProject[], partial: boolean): MachineSettings["hints"] {
  const counts = partial ? { active: null, confirmed: null } : recordedHintCounts(reader, projects.map(({ id }) => id));
  const repos: NonNullable<MachineSettings["hints"]["repos"]> = [];
  let invalid = false;
  for (const { id, name } of projects) {
    try { repos.push({ id, name, expiryMonths: recordedHintExpiry(reader, id).months }); }
    catch { invalid = true; }
  }
  const global = (() => { try { return recordedHintExpiry(reader); } catch { return undefined; } })();
  const expiryMonths = invalid ? null : !repos.length ? global?.months ?? null
    : repos.every(repo => repo.expiryMonths === repos[0].expiryMonths) ? repos[0].expiryMonths : null;
  return { ...counts, expiryMonths, source: repos.some(repo => repo.expiryMonths !== global?.months) ? "repo" : global?.source ?? "policy", repos };
}

function readBackground(reader: RecordReader | undefined, now: number): Pick<MachineSettings["about"], "background" | "backgroundUnavailable"> {
  const lease = reader?.get<Parameters<typeof leaseLive>[0]>("SELECT owner,pid,version,started_at,heartbeat_at,request,hub_until FROM background WHERE id=1");
  if (!lease || !leaseLive(lease, backgroundSettings(reader), now)) return { background: null };
  const startedAt = machineTime(lease.started_at);
  return startedAt && lease.version ? { background: { startedAt, version: lease.version } } : { background: null, backgroundUnavailable: true };
}

export async function takeSettingsSnapshot(options: MachineSettingsOptions, signal: AbortSignal) {
  const location = recordLocation({ ...options, create: false });
  const env = options.env ?? process.env;
  const now = options.now();
  const reader = openRecordReadOnly(options);
  let readouts;
  let scope;
  try {
    if (reader?.diagnostic) throw new Error(reader.diagnostic);
    scope = machineProjects(reader);
    const repos: MachineSettings["repos"] = [];
    for (const { id, name, checkouts } of scope.projects) {
      await setImmediate(undefined, { signal });
      const hasCheckout = checkouts.some(({ path }) => checkoutExists(path));
      repos.push({ id, name, checkouts: checkouts.map(checkout => checkoutPower(reader, checkout, now, env)),
        capture: captureSetting(reader, id, hasCheckout), sharing: sharingSetting(reader, id, hasCheckout), ...weekly(reader, id) });
    }
    readouts = {
      repos, everywhere: deliveryPower(reader, env), capture: captureSetting(reader), ai: readModelUse(reader, now),
      outbound: readOutbound(reader), hints: readHints(reader, scope.projects, scope.partial), background: readBackground(reader, now),
    };
  } finally { reader?.close(); }
  const { background, ...values } = readouts;
  const settings: MachineSettings = {
    ...values,
    browser: {
      signOut: { source: "policy", disabledReason: "This browser’s sign-in expires automatically." },
      signOutEverywhere: { source: "policy", disabledReason: "Signing out every browser isn’t available in Settings." },
    },
    telemetry: telemetrySetting(location.home, env, cliTelemetryHome(options)),
    storage: await storageSnapshot(location, scope.projects, scope.partial, signal),
    about: { homePath: location.home, hubMode: options.mode, version: options.version, ...background },
  };
  return { settings, issue: scope.partial ? "Some repos or checkouts were omitted because the reading limit was reached." : undefined };
}
