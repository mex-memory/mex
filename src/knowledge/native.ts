/**
 * Rebuild the agents' native rule files from the entries: select layer A,
 * plan who loads what, write. Background rebuilds wait between sessions;
 * explicitly requested shared edits can force their matching native change.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentsInUse, liveSessions, type NativeAgent } from "./agents-in-use.js";
import { currentVerdicts } from "./check.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { parseEntry } from "./entry.js";
import { containedDirectory, readEntryFile, personalReadGuard } from "./files.js";
import { gateEntry } from "./gates.js";
import { CODEX_FALLBACK, ownedByPerson, planNative } from "./native-plan.js";
import { selectNative, type Candidate } from "./native-select.js";
import { writeNative, type NativeWrite } from "./native-write.js";
import { references } from "./references.js";
import { teamEntries } from "./team.js";
import { openRecord, openRecordReadOnly } from "../record/index.js";
import { checkoutOn } from "../controls/index.js";
import { DEFAULTS_REPORT, DEFAULTS_SETTING, defaultsScope, parseDefaultsReport, selectAgentDefaults, type DefaultsReport } from "./agent-defaults.js";

export interface NativeRebuild extends Partial<NativeWrite> {
  /** Set when a session is running: nothing was written. */
  deferred?: { agents: string[] };
  agents: NativeAgent[];
  selected: number;
  defaults?: DefaultsReport;
}

export interface RebuildOptions {
  /** Agents found during setup, before their first session in this checkout. */
  agents?: NativeAgent[];
  /** Write even though a session is running (the person asked for it). */
  force?: boolean;
  /** Only the shared files: the same working-tree change as a team entry. */
  sharedOnly?: boolean;
  /** Only the person's hidden local files: their own notes changed. */
  localOnly?: boolean;
  now?: number;
  /** Setup enables the default pack for this checkout. Later rebuilds keep it in sync. */
  setupDefaults?: { agents?: readonly string[]; listed?: readonly string[] };
}

/** Active personal notes for a project, gated, without retired ones. */
export function personalNotes(home: string, projectId: string, retired: Set<string>, root: string): Candidate[] {
  const check = personalReadGuard(join(home, "projects", projectId, "notes"));
  const directory = containedDirectory(home, ["projects", projectId, "notes"]);
  if (!directory) return [];
  const source = references(root);
  const out: Candidate[] = [];
  for (const name of readdirSync(directory).filter(n => /^mx_[a-z0-9]{6,64}\.md$/u.test(n)).sort()) {
    try {
      const text = readEntryFile(join(directory, name));
      if (!text) continue;
      const entry = gateEntry(parseEntry(text), source);
      if (entry.mex.status === "active" && !retired.has(entry.mex.id)) out.push({ level: "personal", entry });
    } catch { /* an unreadable note is never written into a rule file */ }
  }
  check(); return out;
}

export function rebuildNative(options: KnowledgeOptions, rebuild: RebuildOptions = {}): NativeRebuild {
  const project = knowledgeProject(options);
  const home = existsSync(project.location.home) ? project.location.home : undefined;
  const agents = [...new Set([...agentsInUse(project.root, home), ...(rebuild.agents ?? [])])];
  const scope = defaultsScope(project.root);
  const reader = home ? openRecordReadOnly({ ...options, home }) : undefined;
  let settings;
  try {
    const checkout = reader?.checkout(project.root);
    settings = {
      registered: checkout?.path === project.root,
      on: (checkout ? checkoutOn(checkout, rebuild.now) : !reader)
        && reader?.setting("global", "enabled") !== "false" && (options.env ?? process.env).MEX_OFF !== "1",
      prDecisions: reader?.setting(project.projectId, "learning.prDecisions") === "true",
      defaultsOn: reader?.setting(project.projectId, DEFAULTS_SETTING) !== "off",
      previous: parseDefaultsReport(reader?.setting(scope, DEFAULTS_REPORT)),
    };
  } finally { reader?.close(); }
  if (home && !rebuild.force) {
    const live = liveSessions(project.root, home, rebuild.now);
    if (live.length && !rebuild.setupDefaults) return { deferred: { agents: live }, agents, selected: 0, defaults: settings.previous };
    // Keep the setup decision durable so its deferred rebuild knows to install defaults.
    if (live.length) {
      const defaults = selectAgentDefaults(project.root, { ...rebuild.setupDefaults, enabled: settings.defaultsOn }).report;
      const writer = openRecord({ ...options, home, projectPath: undefined });
      try { saveNativeSetting(writer, scope, DEFAULTS_REPORT, defaults); } finally { writer.close(); }
      return { deferred: { agents: live }, agents, selected: 0, defaults };
    }
  }
  const candidates: Candidate[] = teamEntries(options).entries.map(e => ({ level: "team" as const, entry: e.entry }));
  // While MEX is off here, its personal rule files are removed: off means the
  // agent stops hearing from MEX. Shared files live in git and stay.
  if (home && !rebuild.sharedOnly && settings.on) candidates.push(...personalNotes(home, project.projectId, project.retired, project.root));
  const verdicts = candidates.some(c => c.entry.mex.checks.length) ? currentVerdicts(options, project) ?? new Map() : new Map();
  const { selected } = selectNative(candidates, verdicts);
  const defaults = settings.registered && (rebuild.setupDefaults || settings.previous)
    ? selectAgentDefaults(project.root, { ...rebuild.setupDefaults, enabled: settings.defaultsOn && settings.on,
      generated: selected.filter(c => c.entry.mex.scope.includes("**")).map(c => c.entry.text) })
    : undefined;
  const plan = planNative(project.root, agents, selected, settings.prDecisions, defaults?.rules, settings.on && !rebuild.sharedOnly);
  if (defaults?.rules.length && !agents.length && !defaults.report.unavailable.length) defaults.report.unavailable.push("agents without a native rule file");
  if (defaults?.rules.length && agents.includes("claude-code") && !plan.files.some(file => file.agents.includes("claude-code") && file.defaultCount)
    && ownedByPerson(project.root, ".claude/rules/mex-local.md")) defaults.report.unavailable.push("Claude Code");
  if (defaults?.rules.length && agents.includes("copilot") && !plan.files.some(file => file.agents.includes("copilot") && file.defaultCount)
    && ownedByPerson(project.root, ".github/instructions/mex-local.instructions.md")) defaults.report.unavailable.push("Copilot CLI");
  const unchecked = candidates.filter(c => c.entry.mex.checks.length && verdicts.get(`${c.level}/${c.entry.mex.id}`) !== "held").length;
  if (unchecked) plan.notes.push(`${unchecked} checked entries withheld until their current checks hold.`);
  if (rebuild.sharedOnly) plan.files = plan.files.filter(f => f.sharing === "shared");
  if (rebuild.localOnly) plan.files = plan.files.filter(f => f.sharing === "local");
  const projectDirectory = home && !rebuild.sharedOnly ? containedDirectory(home, ["projects", project.projectId], true) : undefined;
  if (!plan.files.length && !projectDirectory && !existsSync(join(project.root, ".mex/native.json"))) {
    return { agents, selected: selected.length, notes: plan.notes, defaults: defaults?.report };
  }
  const writer = openRecord({ ...options, home: project.location.home, projectPath: undefined });
  try {
    const siblings = !projectDirectory ? [] : writer.db.prepare("SELECT path FROM checkouts WHERE project_id=? AND path<>? ORDER BY path LIMIT 256")
      .all(project.projectId, project.root).map(row => String(row.path));
    const result = writeNative(plan, { root: project.root, projectDirectory, writer,
      siblingCheckouts: siblings, ...(rebuild.localOnly ? { only: "local" as const } : {}) });
    if (settings.registered && !rebuild.sharedOnly) {
      saveNativeSetting(writer, scope, CODEX_FALLBACK, plan.fallback);
      if (defaults) saveNativeSetting(writer, scope, DEFAULTS_REPORT, defaults.report);
    }
    return { ...result, agents, selected: selected.length, defaults: defaults?.report };
  } finally { writer.close(); }
}

function saveNativeSetting(writer: ReturnType<typeof openRecord>, scope: string, key: string, value: unknown): void {
  const data = value === undefined ? undefined : JSON.stringify(value);
  if (data === undefined || Buffer.byteLength(data) > 256 * 1024) {
    writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(scope, key);
  } else {
    saveNativeSettingValue(writer, scope, key, data);
  }
}

function saveNativeSettingValue(writer: ReturnType<typeof openRecord>, scope: string, key: string, value: string): void {
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value")
    .run(scope, key, value);
}
export function configureAgentDefaults(directory: string, value: string): void {
  if (value !== "on" && value !== "off") throw new Error("Use on or off for agent.defaults.");
  const writer = openRecord();
  let paths: string[];
  try {
    const checkout = writer.checkout(directory);
    if (!checkout) throw new Error("MEX is not registered here. Run mex first.");
    saveNativeSettingValue(writer, checkout.project_id, DEFAULTS_SETTING, value);
    paths = (writer.db.prepare("SELECT path FROM checkouts WHERE project_id=? ORDER BY path").all(checkout.project_id) as { path: string }[])
      .map(row => row.path).filter(path => existsSync(path));
  } finally { writer.close(); }
  const errors: string[] = [];
  for (const projectPath of paths) {
    try { rebuildNative({ projectPath }, { force: true, setupDefaults: {} }); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (errors.length) throw new Error("The setting was saved. Some rule files could not be updated. " + errors.join(" "));
}

export function formatRebuild(result: NativeRebuild): string {
  if (result.deferred) return `A ${result.deferred.agents.join(" and ")} session is running here; rule files are rebuilt after it ends (or run with --now).`;
  const lines = [`${result.selected} entries go into rule files for ${result.agents.length ? result.agents.join(" and ") : "no agent in use yet"}.`];
  for (const path of result.written ?? []) lines.push(`  wrote    ${path}`);
  for (const path of result.removed ?? []) lines.push(`  removed  ${path}`);
  for (const path of result.kept ?? []) lines.push(`  kept     ${path} (edited by hand; MEX leaves it alone)`);
  for (const note of result.notes ?? []) lines.push(`  note     ${note}`);
  if (!(result.written?.length || result.removed?.length)) lines.push("  Nothing to change.");
  return lines.join("\n");
}
