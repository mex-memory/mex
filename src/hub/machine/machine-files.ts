import type { MachineAgentSchema, MachineUninstallPreviewSchema } from "@mex/hub-contracts/machine";
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import type { z } from "zod";
import { installationTracking } from "../../install/files.js";
import { containedDirectory, readBoundedTextFile } from "../../knowledge/files.js";
import { LOCAL_MANIFEST, SHARED_MANIFEST, localRuleExcludePaths, readNativeManifest } from "../../knowledge/native-write.js";
import { claudeReadsAgentsIn, GENERATED_MARK } from "../../knowledge/rule-files.js";
import { machinePath, type MachineProject } from "./machine-projects.js";

type Agent = z.infer<typeof MachineAgentSchema>;
type AgentFile = Agent["files"][number];
type RetainedFile = z.infer<typeof MachineUninstallPreviewSchema>["notRemoved"][number];
export interface ManagedFile {
  agents: Agent["id"][];
  path: string;
  repo?: string;
  kind: AgentFile["kind"];
  retained?: RetainedFile["kind"];
}

const git = promisify(execFile);
const WORKTREE_LIMIT = 128;
const RULE_FILE_LIMIT = 512;
const GIT_PROBE_LIMIT = 64;

export async function gitPath(root: string, path: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const result = await git("git", ["-C", root, "rev-parse", "--git-path", path], {
      signal, timeout: 1500, maxBuffer: 16 << 10, windowsHide: true,
    });
    const name = result.stdout.replace(/\r?\n$/u, "");
    const absolute = isAbsolute(name) ? name : join(root, name);
    if (name && machinePath(absolute)) return absolute;
  } catch { signal.throwIfAborted(); }
}

async function gitVisibility(file: string, signal: AbortSignal): Promise<{ tracked: boolean | null; hidden: boolean | null }> {
  try {
    const tracking = await installationTracking(file, signal);
    if (tracking !== "untracked") return { tracked: tracking === "tracked", hidden: false };
    try {
      await git("git", ["-C", dirname(file), "check-ignore", "-q", "--", file], {
        signal, timeout: 1500, maxBuffer: 16 << 10, windowsHide: true,
      });
      return { tracked: false, hidden: true };
    } catch (error) {
      if ((error as { code?: number }).code === 1) return { tracked: false, hidden: false };
      throw error;
    }
  } catch {
    signal.throwIfAborted();
    return { tracked: null, hidden: null };
  }
}

function ruleAgents(root: string, relative: string): Agent["id"][] {
  if (relative.startsWith(".claude/")) return ["claude-code"];
  if (relative.startsWith(".github/")) return ["copilot"];
  const area = relative.split("/").slice(0, -1).join("/");
  return ["codex", "copilot", ...(claudeReadsAgentsIn(root, area) ? ["claude-code" as const] : [])];
}

/** Native rules have manifests and a separate exclude block, outside the install journal. */
export async function nativeFiles(home: string, projects: MachineProject[], signal: AbortSignal, journalExcludes = new Set<string>()) {
  const files: ManagedFile[] = [];
  let partial = false;
  let worktrees = 0;
  let paths = 0;
  const excludeWork: { root: string; repo: string; agents: Agent["id"][] }[] = [];
  for (const { id, name, kind, checkouts } of projects) {
    if (kind !== "git") continue;
    if (worktrees >= WORKTREE_LIMIT) { partial = true; break; }
    let local: string[] = [];
    try {
      const project = containedDirectory(home, ["projects", id]);
      if (project) local = Object.keys(readNativeManifest(join(project, LOCAL_MANIFEST)).files);
    } catch { partial = true; }
    for (const { path: root } of checkouts) {
      if (++worktrees > WORKTREE_LIMIT || paths > RULE_FILE_LIMIT) { partial = true; break; }
      await setImmediate(undefined, { signal });
      try {
        if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
        const folder = containedDirectory(root, [".mex"]);
        const shared = folder ? Object.keys(readNativeManifest(join(root, SHARED_MANIFEST)).files) : [];
        if (folder && containedDirectory(folder, ["learned"])) {
          files.push({ agents: [], path: join(folder, "learned"), repo: name, kind: "rule", retained: "teamKnowledge" });
        }
        const localAgents = new Set<Agent["id"]>();
        for (const [relative, retained] of [
          ...local.map(path => [path, "personalRule"] as const),
          ...shared.map(path => [path, "teamRule"] as const),
        ]) {
          if (++paths > RULE_FILE_LIMIT) { partial = true; break; }
          const parts = relative.split("/");
          if (!containedDirectory(root, parts.slice(0, -1))) continue;
          const path = join(root, ...parts);
          // The local manifest is per project. Prove this worktree has the generated file.
          if (!machinePath(path) || !readBoundedTextFile(path, 256 << 10)?.includes(GENERATED_MARK)) continue;
          const agents = ruleAgents(root, relative);
          if (retained === "personalRule") for (const agent of agents) localAgents.add(agent);
          files.push({ path, agents, repo: name, kind: "rule", retained });
        }
        if (local.length || journalExcludes.size || !folder) excludeWork.push({ root, repo: name, agents: [...localAgents] });
      } catch { signal.throwIfAborted(); partial = true; }
    }
  }
  if (excludeWork.length > GIT_PROBE_LIMIT) partial = true;
  for (let i = 0; i < Math.min(excludeWork.length, GIT_PROBE_LIMIT); i += 8) {
    const results = await Promise.all(excludeWork.slice(i, i + 8).map(async ({ root, repo, agents }): Promise<ManagedFile | undefined> => {
      try {
        const path = await gitPath(root, "info/exclude", signal);
        if (!path) return;
        const retained = localRuleExcludePaths(readBoundedTextFile(path, 1 << 20) ?? "").size > 0;
        if (retained || journalExcludes.has(path)) return {
          agents, path, repo, kind: "gitExclude", retained: retained ? "gitExclude" : undefined,
        };
      } catch { signal.throwIfAborted(); partial = true; }
    }));
    for (const file of results) if (file) files.push(file);
  }
  return { files, partial };
}

export async function filesWithVisibility(files: ManagedFile[], signal: AbortSignal, configs: string[] = []) {
  const unique = [...new Set([...configs, ...files.filter(({ agents, kind }) => agents.length && kind !== "gitExclude").map(({ path }) => path)])];
  const visibility = new Map<string, Awaited<ReturnType<typeof gitVisibility>>>();
  // A blocked Git process doesn't stall HTTP or serialize a machine full of checkouts.
  for (let i = 0; i < Math.min(unique.length, GIT_PROBE_LIMIT); i += 8) {
    await Promise.all(unique.slice(i, Math.min(i + 8, GIT_PROBE_LIMIT)).map(async path => visibility.set(path, await gitVisibility(path, signal))));
  }
  const byAgent = new Map<Agent["id"], AgentFile[]>();
  for (const { path, kind, repo, agents } of files) {
    for (const agent of agents) {
      const list = byAgent.get(agent) ?? [];
      if (list.length < 128 && !list.some(item => item.path === path && item.kind === kind)) {
        list.push({ path, kind, repo, hiddenFromGit: kind === "gitExclude" ? false : visibility.get(path)?.hidden ?? null });
      }
      byAgent.set(agent, list);
    }
  }
  return { byAgent, visibility, partial: unique.length > GIT_PROBE_LIMIT || [...byAgent.values()].some(list => list.length >= 128) };
}
