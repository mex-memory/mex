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
import { planNative } from "./native-plan.js";
import { selectNative, type Candidate } from "./native-select.js";
import { writeNative, type NativeWrite } from "./native-write.js";
import { references } from "./references.js";
import { teamEntries } from "./team.js";
import { openRecordReadOnly } from "../record/index.js";
import { automaticWorkEnabled } from "../controls/index.js";

export interface NativeRebuild extends Partial<NativeWrite> {
  /** Set when a session is running: nothing was written. */
  deferred?: { agents: string[] };
  agents: NativeAgent[];
  selected: number;
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

/** MEX is on for this project on this machine: not off globally, and some checkout is on. */
function mexOnHere(home: string, projectId: string): boolean {
  try {
    const reader = openRecordReadOnly({ home });
    if (!reader) return true;
    try { return automaticWorkEnabled(reader as never, projectId); } finally { reader.close(); }
  } catch { return true; }
}

export function rebuildNative(options: KnowledgeOptions, rebuild: RebuildOptions = {}): NativeRebuild {
  const project = knowledgeProject(options);
  const home = existsSync(project.location.home) ? project.location.home : undefined;
  const agents = [...new Set([...agentsInUse(project.root, home), ...(rebuild.agents ?? [])])];
  if (home && !rebuild.force) {
    const live = liveSessions(project.root, home, rebuild.now);
    if (live.length) return { deferred: { agents: live }, agents, selected: 0 };
  }
  const candidates: Candidate[] = teamEntries(options).entries.map(e => ({ level: "team" as const, entry: e.entry }));
  // While MEX is off here, its personal rule files are removed: off means the
  // agent stops hearing from MEX. Shared files live in git and stay.
  if (home && !rebuild.sharedOnly && mexOnHere(home, project.projectId)) candidates.push(...personalNotes(home, project.projectId, project.retired, project.root));
  const verdicts = candidates.some(c => c.entry.mex.checks.length) ? currentVerdicts(options, project) ?? new Map() : new Map();
  const { selected } = selectNative(candidates, verdicts);
  const reader = home ? openRecordReadOnly({ home }) : undefined;
  let prDecisions: boolean;
  try { prDecisions = reader?.setting(project.projectId, "learning.prDecisions") === "true"; } finally { reader?.close(); }
  const plan = planNative(project.root, agents, selected, prDecisions);
  const unchecked = candidates.filter(c => c.entry.mex.checks.length && verdicts.get(`${c.level}/${c.entry.mex.id}`) !== "held").length;
  if (unchecked) plan.notes.push(`${unchecked} checked entries withheld until their current checks hold.`);
  if (rebuild.sharedOnly) plan.files = plan.files.filter(f => f.sharing === "shared");
  if (rebuild.localOnly) plan.files = plan.files.filter(f => f.sharing === "local");
  const projectDirectory = home && !rebuild.sharedOnly ? containedDirectory(home, ["projects", project.projectId], true) : undefined;
  return { ...writeNative(plan, { root: project.root, projectDirectory, ...(rebuild.localOnly ? { only: "local" as const } : {}) }), agents, selected: selected.length };
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
