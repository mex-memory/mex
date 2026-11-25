/** Read-only machine and checkout status. No refresh, registration or model work. */
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { VERSION } from "./version.js";
import { AGENT_NAMES as NAMES, installationChanges, type InstallRow } from "./install/index.js";
import { MAX_SETTINGS_BYTES, readSnapshot, snapshotBytes } from "./install/files.js";
import { EVENTS, installSettings, object, parseSettings, type Agent } from "./install/settings.js";
import { binaryFileName, selfTestBinary } from "./hooks/shim/binary.js";
import { openHooksReadOnly, openRecordReadOnly, recordLocation, type CheckoutRow, type RecordReader } from "./record/index.js";
import { realPath } from "./record/project.js";
import type { LocationOptions } from "./record/location.js";
import { listJobs } from "./record/jobs.js";
import { readModelUse } from "./model-runner/model-use.js";
import { cachedVerdicts, type Verdict } from "./knowledge/check.js";
import { knowledgeProject, type KnowledgeOptions } from "./knowledge/context.js";
import { entryInventory } from "./knowledge/inventory.js";
import type { KnowledgeEntry } from "./knowledge/entry.js";
import { containedDirectory } from "./knowledge/files.js";
import { hintStatus } from "./knowledge/hints.js";

type Switch = "on" | "off" | "unknown";
export interface AgentStatus { agent: Agent; installed: boolean | null; events: number | null; lastCall?: string; }
export interface KnowledgeStatus { personal: number; team: number; hints: number; checks: Record<Verdict, number> | null; }
export interface StatusView {
  version: string;
  outputLevers?: "on" | "off";
  repository: { state: Switch; capture: Switch } | null;
  agents: AgentStatus[];
  binary: { state: "native" | "missing" | "unknown"; version?: string };
  knowledge: KnowledgeStatus | null;
  background: { waiting: number; running: number; lastRun?: { name: string; at: string } } | null;
  modelUse: { runs: number; percent: number | null; capPercent: number; estimated: true } | null;
}
export interface StatusOptions extends LocationOptions { cwd?: string; env?: NodeJS.ProcessEnv; now?: number; }
function attempt<T>(read: () => T): T | null { try { return read(); } catch { return null; } }
function checkedReader(reader: RecordReader | undefined): RecordReader | undefined {
  if (reader?.diagnostic) { reader.close(); throw new Error("Unreadable record"); }
  return reader;
}

/** Find a checkout by its directory marker or existing registration, without git. */
function checkoutRoot(cwd: string, reader: RecordReader | undefined): { root: string; row?: CheckoutRow } | undefined {
  let current = realPath(cwd);
  while (true) {
    const row = attempt(() => reader?.get<CheckoutRow>("SELECT * FROM checkouts WHERE path=?", current)) ?? undefined;
    if (row || existsSync(join(current, ".git"))) return { root: current, row };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Inspect the installed handlers, allowing unrelated changes to user settings. */
export function installedAgent(agent: Agent, rows: InstallRow[]): AgentStatus {
  const row = rows.find(row => row.agent === agent && row.key === "file-v1:settings");
  if (!row) return { agent, installed: false, events: 0 };
  const runtime = [...new Set(rows.filter(row => row.key === "file-v1:runtime" && ["mex-hook", "mex-hook.exe", "mex-hook.cjs"].includes(basename(row.path))).map(row => row.path))];
  const profiles = runtime.map(path => parseSettings(installSettings(null, agent, path.endsWith(".cjs") ? { path: "node", args: [path] } : { path, args: [] }, process.platform)));
  const actual = parseSettings(snapshotBytes(readSnapshot(row.path, MAX_SETTINGS_BYTES)));
  let events = 0;
  for (const event of EVENTS[agent]) {
    const handlers = (settings: Record<string, unknown>) => object(settings.hooks) && Array.isArray(settings.hooks[event])
      ? settings.hooks[event].flatMap(group => object(group) && Array.isArray(group.hooks) ? group.hooks : []) : [];
    const wanted = profiles.flatMap(handlers);
    if (handlers(actual).some(handler => wanted.some(item => JSON.stringify(item) === JSON.stringify(handler)))) events++;
  }
  return { agent, installed: events === EVENTS[agent].length, events };
}

function knowledge(options: KnowledgeOptions): KnowledgeStatus {
  const project = knowledgeProject(options);
  const verdicts = cachedVerdicts(options, project.projectId, project.root);
  const counts: Record<Verdict, number> = { held: 0, changed: 0, broken: 0, unknown: 0 };
  const entries = entryInventory(project.retired);
  const count = (entry: KnowledgeEntry) => { counts[verdicts?.get(entry.mex.id) ?? "unknown"]++; };
  const personalDir = existsSync(project.location.home) ? containedDirectory(project.location.home, ["projects", project.projectId, "notes"]) : undefined;
  const hintsDir = existsSync(project.location.home) ? containedDirectory(project.location.home, ["projects", project.projectId, "hints"]) : undefined;
  const personal = entries(personalDir, 0, count);
  if (existsSync(join(project.root, ".mex")) && lstatSync(join(project.root, ".mex")).isSymbolicLink()) throw new Error("Redirected team store");
  const team = entries(join(project.root, ".mex", "learned"), 1, count);
  entries(hintsDir, 0, count);
  return { personal, team, hints: hintStatus(options).active, checks: existsSync(project.location.hooks) && !verdicts ? null : counts };
}

export function readStatus(options: StatusOptions = {}): StatusView {
  const now = options.now ?? Date.now(), env = options.env ?? process.env;
  const location = attempt(() => recordLocation({ ...options, create: false }));
  const reader = attempt(() => checkedReader(openRecordReadOnly(options))) ?? undefined;
  const root = attempt(() => checkoutRoot(options.cwd ?? process.cwd(), reader));
  const view: StatusView = { version: VERSION, repository: root ? { state: "unknown", capture: "unknown" } : null,
    agents: [], binary: { state: "unknown" }, knowledge: null, background: null, modelUse: null };
  try {
    view.outputLevers = (env.MEX_LEVERS === "on" || env.MEX_LEVERS !== "off" && reader?.setting("global", "levers.output") === "on") ? "on" : "off";
    const rows = attempt(() => installationChanges(options));
    for (const agent of ["claude-code", "codex"] as const) {
      view.agents.push((rows && attempt(() => installedAgent(agent, rows))) || { agent, installed: null, events: null });
    }
    view.binary = attempt(() => {
      if (!location) throw new Error("Unknown location");
      const binary = env.MEX_HOOK_BINARY ?? join(location.home, "bin", binaryFileName());
      if (!existsSync(binary)) return { state: "missing" as const };
      const result = selfTestBinary(binary);
      return result.ok ? { state: "native" as const, version: result.version } : { state: "unknown" as const };
    }) ?? { state: "unknown" };
    if (root) {
      view.repository = attempt(() => {
        // A missing record is a known unregistered checkout. An unreadable record is unknown.
        if (!reader && location && existsSync(location.record)) throw new Error("Unknown controls");
        const on = !!root.row && (root.row.state === "on" || (root.row.state === "off until" && Date.parse(root.row.off_until ?? "") <= now));
        const globalOn = env.MEX_OFF !== "1" && reader?.setting("global", "enabled") !== "false";
        const capture = reader?.setting("global", "capture.enabled") !== "false" && (!root.row || reader?.setting(root.row.project_id, "capture.enabled") !== "false");
        return { state: on && globalOn ? "on" : "off", capture: capture ? "on" : "off" };
      }) ?? { state: "unknown", capture: "unknown" };
      view.knowledge = attempt(() => knowledge({ ...options, projectPath: root.root }));
    }
    const hooks = attempt(() => checkedReader(openHooksReadOnly(options)));
    try {
      for (const agent of view.agents) {
        const last = attempt(() => hooks?.get<{ at: string }>("SELECT max(last_seen_at) at FROM sessions WHERE agent=?", agent.agent));
        if (last?.at && Number.isFinite(Date.parse(last.at))) agent.lastCall = last.at;
      }
    } finally { hooks?.close(); }
    if (reader) {
      view.background = attempt(() => {
        const pending = reader.get<{ waiting: number; running: number }>("SELECT count(CASE WHEN state IN ('queued','waiting','paused') THEN 1 END) waiting,count(CASE WHEN state='running' THEN 1 END) running FROM jobs")!;
        const last = reader.get<{ kind: string; at: string }>("SELECT kind,finished_at at FROM jobs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1");
        // listJobs owns user-facing job names; a bounded lookup never runs a job.
        const label = last && listJobs(reader, 500).find(job => job.kind === last.kind)?.label;
        return { ...pending, ...(last ? { lastRun: { name: label?.startsWith("Unknown job") ? last.kind : label ?? last.kind, at: last.at } } : {}) };
      });
      view.modelUse = attempt(() => readModelUse(reader, now));
    } else if (location && !existsSync(location.record)) {
      view.background = { waiting: 0, running: 0 };
      view.modelUse = readModelUse(undefined, now);
    }
    return view;
  } finally { reader?.close(); }
}

export function statusProblems(view: StatusView): string[] {
  const problems: string[] = [];
  for (const agent of view.agents) {
    if (agent.installed === false) problems.push(`${NAMES[agent.agent]} hooks missing or incomplete: run mex install`);
    if (agent.installed === null) problems.push(`${NAMES[agent.agent]} hooks unknown: run mex install --dry-run`);
  }
  if (view.binary.state !== "native") problems.push(`Hook binary ${view.binary.state === "missing" ? "missing" : "unknown"}: run mex install`);
  if (view.repository?.state === "unknown") problems.push("Repo controls unknown: run mex on to turn MEX on here");
  if (view.repository && !view.knowledge) problems.push("Knowledge unknown: run mex check for details");
  if (view.knowledge && !view.knowledge.checks) problems.push("Cached checks unknown: run mex check for details");
  if (!view.background || !view.modelUse) problems.push("Background records unknown: run mex jobs --json for details");
  return problems;
}

function ago(at: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  return minutes < 1 ? "less than 1 min ago" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
}
export function formatStatus(view: StatusView, options: { doctor?: boolean; now?: number; ascii?: boolean } = {}): string {
  const now = options.now ?? Date.now(), lines: string[] = [];
  if (view.repository) lines.push(`MEX ${view.version} · ${view.repository.state} in this repo · capture ${view.repository.capture}`, "");
  lines.push(view.outputLevers === "on" ? "Output levers on" : "Output levers off; turn on: mex config set levers.output on", "");
  lines.push("Agents");
  for (const agent of view.agents) lines.push(`  ${agent.installed ? "✓" : "!"} ${NAMES[agent.agent]}: ${agent.installed === null ? "unknown" : agent.installed ? `hooks installed (${agent.events} events)` : `hooks not installed or incomplete (${agent.events} events)`}${agent.lastCall ? ` · last call ${ago(agent.lastCall, now)}` : ""}${agent.agent === "codex" && agent.installed ? " · trust them once in Codex (/hooks, or Review hooks in the app)" : ""}`);
  lines.push(`  ${view.binary.state === "native" ? "✓" : "!"} Hook binary ${view.binary.state === "native" ? `${view.binary.version || "unknown version"} (native)` : view.binary.state}`);
  if (view.repository) {
    lines.push("", "Knowledge here");
    const k = view.knowledge;
    lines.push(k ? `  ${k.personal} personal notes · ${k.team} team entries · ${k.hints} hints from agent memory` : "  unknown");
    if (k) lines.push(k.checks ? `  Checks (cached): ${k.checks.held} hold · ${k.checks.changed} changed (sent as a pointer) · ${k.checks.broken} broken (held back) · ${k.checks.unknown} not checked yet` : "  Checks: unknown");
  }
  lines.push("", "Background");
  const b = view.background, u = view.modelUse;
  lines.push(b ? `  ${b.waiting ? `${b.waiting} jobs waiting` : "No jobs waiting"}${b.running ? ` · ${b.running} running` : ""} · last run: ${b.lastRun ? `${b.lastRun.name}, ${ago(b.lastRun.at, now)}` : "none recorded"}` : "  Jobs: unknown");
  lines.push(u ? `  Model use for MEX this week: ${u.runs} runs, ${u.percent === null ? "share of your usage unknown" : `${u.percent.toFixed(1)}% of your usage (estimate)`} (cap ${u.capPercent}%)` : "  Model use: unknown");
  if (options.doctor) {
    const problems = statusProblems(view);
    lines.push("", "Problems", ...(problems.length ? problems.map(problem => `  ✗ ${problem}`) : ["  No recorded problems."]));
    if (view.agents.some(agent => agent.agent === "codex" && agent.installed && !agent.lastCall)) lines.push("  Codex hook trust is unknown: open Codex, run /hooks.");
  }
  lines.push("", view.repository ? 'Next: mex note "<fact>" adds a note · mex off turns MEX off here' : "Next: run mex in a repo to turn MEX on there");
  const text = lines.join("\n");
  return options.ascii ? text.replace(/·/gu, "-").replace(/✓/gu, "ok").replace(/✗/gu, "!") : text;
}
export function runStatus(options: { json?: boolean; doctor?: boolean } = {}): void {
  const view = readStatus(), problems = options.doctor ? statusProblems(view) : undefined;
  console.log(options.json ? JSON.stringify({ ...view, ...(problems ? { problems } : {}) }, null, 2) : formatStatus(view, { ...options, ascii: !process.stdout.isTTY || process.env.TERM === "dumb" }));
  if (problems?.length) process.exitCode = 1;
}
