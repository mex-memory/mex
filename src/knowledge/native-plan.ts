/**
 * The who-loads-what matrix: the smallest set of native files that puts each
 * layer-A entry in front of every agent in use, for its area.
 *
 * - Codex reads AGENTS.md in each folder down to the file: one generated
 *   AGENTS.md per area, only where the folder has no AGENTS.md of its own.
 * - Claude Code reads `.claude/rules/*.md` with `paths:`, and AGENTS.md only
 *   while no CLAUDE.md sits in the repo root or on the way to the folder. So an
 *   area already covered by a generated AGENTS.md needs no Claude file there;
 *   otherwise one rules file per area.
 * - Copilot reads AGENTS.md too, and `.github/instructions/*.instructions.md`
 *   with `applyTo`. An area a generated AGENTS.md covers needs nothing more;
 *   otherwise one path-scoped instructions file per area, never both.
 * - MEX never creates CLAUDE.md or CLAUDE.local.md, and never writes over a
 *   file it didn't generate.
 * - Team entries go in shared files; personal notes in local files that git
 *   is told to ignore.
 */
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import type { NativeAgent } from "./agents-in-use.js";
import { renderNative, type NativeFormat } from "./native-render.js";
import { areaOf, isLearned, type Candidate } from "./native-select.js";
import { claudeReadsAgentsIn, GENERATED_MARK } from "./rule-files.js";
import { containedDirectory, readBoundedTextFile } from "./files.js";
import { realPath } from "../record/project.js";

export type Sharing = "shared" | "local";
export interface PlannedFile { path: string; format: NativeFormat; sharing: Sharing; area: string; agents: NativeAgent[]; text: string; ids: string[]; dropped: string[]; }
export interface NativePlan { files: PlannedFile[]; notes: string[]; }

const FORBIDDEN = new Set(["CLAUDE.md", "CLAUDE.local.md"]);

/** A file at this path that MEX didn't generate: never written over. */
export function ownedByPerson(root: string, path: string): boolean {
  try {
    root = realPath(root);
    const parts = path.split("/");
    if (parts.length > 1 && !containedDirectory(root, parts.slice(0, -1))) return false;
    const text = readBoundedTextFile(join(root, path), 8 * 1024);
    return text !== undefined && !text.includes(GENERATED_MARK);
  } catch { return true; }
}

function slug(area: string): string { return area.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "").toLowerCase(); }

function claudePath(area: string, sharing: Sharing): string {
  // Keep team areas separate from the personal root, and retain the exact
  // area identity when punctuation or nested folders share the same slug.
  const areaName = area ? `area-${slug(area).slice(0, 64)}-${createHash("sha256").update(area).digest("hex").slice(0, 12)}` : "";
  const name = ["mex", sharing === "local" ? "local" : "", areaName].filter(Boolean).join("-");
  return `.claude/rules/${name}.md`;
}

function copilotPath(area: string, sharing: Sharing): string {
  return claudePath(area, sharing).replace(/^\.claude\/rules\//u, ".github/instructions/").replace(/\.md$/u, ".instructions.md");
}

function byArea(candidates: Candidate[]): Map<string, Candidate[]> {
  const areas = new Map<string, Candidate[]>();
  for (const c of candidates) for (const scope of c.entry.mex.scope) {
    const area = areaOf(scope);
    areas.set(area, [...areas.get(area) ?? [], c]);
  }
  return new Map([...areas.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function planNative(root: string, agents: readonly NativeAgent[], selected: Candidate[]): NativePlan {
  const files: PlannedFile[] = [], notes: string[] = [];
  const taken = new Set<string>();
  const add = (file: PlannedFile) => {
    if (FORBIDDEN.has(posix.basename(file.path))) throw new Error(`MEX never creates ${file.path}`);
    if (!file.ids.length) return;
    files.push(file); taken.add(file.path);
    if (file.dropped.length) notes.push(`${file.path}: ${file.dropped.length} entries left out to stay under the size cap.`);
  };
  for (const sharing of ["shared", "local"] as const) {
    const mine = selected.filter(c => (c.level === "team") === (sharing === "shared"));
    for (const [area, group] of byArea(mine)) {
      const folder = area ? `${area}/` : "";
      // Nested AGENTS.md follows the session working directory. Only Claude
      // and Copilot load these learned notes according to the file touched.
      const agentsGroup = area ? group.filter(c => !isLearned(c.entry)) : group;
      const learned = area ? group.filter(c => isLearned(c.entry)) : [];
      let codexCovers = false;
      if (agents.includes("codex") && agentsGroup.length) {
        const path = `${folder}AGENTS.md`;
        const takenByTeam = taken.has(path);
        if (takenByTeam || ownedByPerson(root, path)) {
          const reason = takenByTeam ? "is already generated from team entries" : "is yours, so MEX doesn't write into it";
          const fallbacks = [
            agentsGroup.some(c => !isLearned(c.entry)) ? "Your other notes reach Codex at session start instead." : "",
            agentsGroup.some(c => isLearned(c.entry)) ? "Use mex recall to read your learned rules in Codex." : "",
          ];
          notes.push(`${path} ${reason}. ${fallbacks.filter(Boolean).join(" ")}`);
        } else {
          const out = renderNative("codex-agents", area, agentsGroup);
          add({ path, format: "codex-agents", sharing, area, agents: ["codex"], ...out });
          codexCovers = out.ids.length > 0;
        }
      }
      const generatedAgents = codexCovers ? files[files.length - 1] : undefined;
      if (agents.includes("copilot")) {
        if (generatedAgents) generatedAgents.agents.push("copilot");
        if (!generatedAgents || learned.length) {
          const path = copilotPath(area, sharing);
          if (ownedByPerson(root, path)) notes.push(`${path} is yours, so MEX doesn't write into it.`);
          else add({ path, format: "copilot-instructions", sharing, area, agents: ["copilot"], ...renderNative("copilot-instructions", area, generatedAgents ? learned : group) });
        }
      }
      if (agents.includes("claude-code")) {
        const claudeReadsAgents = codexCovers && claudeReadsAgentsIn(root, area);
        if (claudeReadsAgents) {
          generatedAgents!.agents.unshift("claude-code");
          if (!learned.length) continue;
        }
        const path = claudePath(area, sharing);
        if (ownedByPerson(root, path)) { notes.push(`${path} is yours, so MEX doesn't write into it.`); continue; }
        add({ path, format: "claude-rules", sharing, area, agents: ["claude-code"], ...renderNative("claude-rules", area, claudeReadsAgents ? learned : group) });
      }
    }
  }
  return { files, notes };
}
