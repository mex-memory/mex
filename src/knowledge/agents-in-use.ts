/**
 * Which agents a repo shows signs of using, and whether one is running in it
 * right now. Native rule files are written only for agents in use, and only
 * between sessions.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { realPath } from "../record/project.js";
import { installationChanges } from "../install/index.js";
import type { Agent } from "./rule-files.js";

/** Native files are written for these two in this release; the rest come with their adapters. */
export const NATIVE_AGENTS = ["claude-code", "codex"] as const;
export type NativeAgent = (typeof NATIVE_AGENTS)[number];

/** A heartbeat newer than this means a session is still running. */
export const LIVE_SESSION_MS = 10 * 60 * 1000;

const SIGNS: Record<NativeAgent, string[]> = {
  "claude-code": ["CLAUDE.md", "CLAUDE.local.md", ".claude"],
  codex: ["AGENTS.md", ".codex"],
};

interface Heartbeat { agent: string; cwd: string; mtimeMs: number; ended?: boolean; }

function heartbeats(mexHome: string): Heartbeat[] {
  const root = join(mexHome, "heartbeats");
  const out: Heartbeat[] = [];
  let agents: string[];
  try { agents = readdirSync(root); } catch { return out; }
  for (const agent of agents) {
    let files: string[];
    try { files = readdirSync(join(root, agent)); } catch { continue; }
    for (const file of files.slice(0, 500)) {
      const path = join(root, agent, file);
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > 64 * 1024) continue;
        const body = JSON.parse(readFileSync(path, "utf8")) as { agent?: unknown; cwd?: unknown; ended?: unknown };
        if (typeof body.cwd === "string") out.push({ agent: typeof body.agent === "string" ? body.agent : agent, cwd: body.cwd, mtimeMs: stat.mtimeMs, ended: typeof body.ended === "string" && body.ended !== "" });
      } catch { /* a half-written heartbeat is skipped */ }
    }
  }
  return out;
}

function inside(root: string, path: string): boolean {
  let real: string;
  try { real = realPath(path); } catch { return false; }
  const rel = relative(root, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Agents with files in the repo, or whose hooks ran in it on this machine. */
export function agentsInUse(root: string, mexHome?: string): NativeAgent[] {
  const seen = new Set<NativeAgent>();
  for (const agent of NATIVE_AGENTS) if (SIGNS[agent].some(name => existsSync(join(root, name)))) seen.add(agent);
  if (mexHome) {
    const realRoot = realPath(root);
    for (const beat of heartbeats(mexHome)) {
      if ((NATIVE_AGENTS as readonly string[]).includes(beat.agent) && inside(realRoot, beat.cwd)) seen.add(beat.agent as NativeAgent);
    }
    // A fresh repo shows no sign yet: the agents MEX installed hooks for on
    // this machine are the ones its sessions will use, so a note written
    // before the first session is already in their rule files.
    if (!seen.size) for (const agent of installedAgents(mexHome)) seen.add(agent);
  }
  return NATIVE_AGENTS.filter(agent => seen.has(agent));
}

/** Agents with MEX hooks installed on this machine, from the install record. Never throws. */
function installedAgents(mexHome: string): NativeAgent[] {
  try {
    const rows = installationChanges({ home: mexHome });
    return NATIVE_AGENTS.filter(agent => rows.some(row => row.agent === agent));
  } catch { return []; }
}

/** Agents with a session running in this checkout now. */
export function liveSessions(root: string, mexHome: string, now = Date.now()): Agent[] {
  const realRoot = realPath(root);
  const live = new Set<Agent>();
  for (const beat of heartbeats(mexHome)) {
    // A session the agent reported ended is not live, so rule files can be rebuilt at once.
    if (!beat.ended && now - beat.mtimeMs < LIVE_SESSION_MS && inside(realRoot, beat.cwd)) live.add(beat.agent as Agent);
  }
  return [...live];
}
