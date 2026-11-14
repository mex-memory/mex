/**
 * Rebuild the agents' native rule files from the entries: select layer A,
 * plan who loads what, write. Background rebuilds wait between sessions;
 * explicitly requested shared edits can force their matching native change.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentsInUse, liveSessions, type NativeAgent } from "./agents-in-use.js";
import { cachedVerdicts } from "./check.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { parseEntry } from "./entry.js";
import { containedDirectory, readEntryFile } from "./files.js";
import { gateEntry } from "./gates.js";
import { planNative } from "./native-plan.js";
import { selectNative, type Candidate } from "./native-select.js";
import { writeNative, type NativeWrite } from "./native-write.js";
import { references } from "./references.js";
import { teamEntries } from "./team.js";

export interface NativeRebuild extends Partial<NativeWrite> {
  /** Set when a session is running: nothing was written. */
  deferred?: { agents: string[] };
  agents: NativeAgent[];
  selected: number;
}

export interface RebuildOptions {
  /** Write even though a session is running (the person asked for it). */
  force?: boolean;
  /** Only the shared files: the same working-tree change as a team entry. */
  sharedOnly?: boolean;
  now?: number;
}

/** Active personal notes for a project, gated, without retired ones. */
export function personalNotes(home: string, projectId: string, retired: Set<string>, root: string): Candidate[] {
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
  return out;
}

export function rebuildNative(options: KnowledgeOptions, rebuild: RebuildOptions = {}): NativeRebuild {
  const project = knowledgeProject(options);
  const home = existsSync(project.location.home) ? project.location.home : undefined;
  const agents = agentsInUse(project.root, home);
  if (home && !rebuild.force) {
    const live = liveSessions(project.root, home, rebuild.now);
    if (live.length) return { deferred: { agents: live }, agents, selected: 0 };
  }
  const candidates: Candidate[] = teamEntries(options).entries.map(e => ({ level: "team" as const, entry: e.entry }));
  if (home && !rebuild.sharedOnly) candidates.push(...personalNotes(home, project.projectId, project.retired, project.root));
  const verdicts = cachedVerdicts(options, project.projectId, project.root) ?? new Map();
  const { selected } = selectNative(candidates, verdicts);
  const plan = planNative(project.root, agents, selected);
  if (rebuild.sharedOnly) plan.files = plan.files.filter(f => f.sharing === "shared");
  const projectDirectory = home && !rebuild.sharedOnly ? containedDirectory(home, ["projects", project.projectId], true) : undefined;
  return { ...writeNative(plan, { root: project.root, projectDirectory }), agents, selected: selected.length };
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
