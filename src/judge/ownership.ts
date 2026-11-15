import { join } from "node:path";
import { z } from "zod";
import { containedDirectory, readBoundedTextFile } from "../knowledge/files.js";
import { shortHash } from "../record/project.js";
import { samePosition, type Candidate, type Position } from "./evidence.js";

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable();
const edit = z.object({ path: z.string().min(1).max(512), before: sha, after: sha }).strict();
const Edits = z.object({
  version: z.literal(1), project_id: z.string(), checkout: z.string(), agent: z.enum(["claude-code", "codex"]), session_id: z.string().min(1).max(512),
  position: z.object({ branch: z.string(), head: z.string() }).strict(), edits: z.array(edit).max(128),
  pending: z.object({ tool: z.string(), files: z.array(edit).max(128) }).strict().optional(),
}).strict();

/** Prove the whole change from the note's baseline, not merely a recent touch. */
export function ownsChanges(directory: string, projectId: string, checkout: string, agent: "claude" | "codex", sessionId: string | undefined,
  at: Position, candidate: Pick<Candidate, "entry" | "files">, files: Array<{ path: string; hash: string | null }>): boolean {
  if (!sessionId || !at.branch || !at.head) return false;
  try {
    const root = containedDirectory(directory, ["judge-edits"]);
    if (!root) return false;
    const raw = readBoundedTextFile(join(root, `${shortHash(checkout)}.json`), 64 << 10);
    if (!raw) return false;
    const proof = Edits.parse(JSON.parse(raw));
    if (proof.project_id !== projectId || proof.checkout !== checkout || proof.agent !== (agent === "claude" ? "claude-code" : "codex")
      || proof.session_id !== sessionId || !samePosition(proof.position, at) || proof.pending) return false;
    const changed = candidate.files.flatMap(path => {
      const current = files.find(file => file.path === path);
      const baselines = [...new Set(candidate.entry.mex.checks.flatMap(check => check.kind !== "legacy-grounding" && check.files[path] ? [check.files[path]] : []))];
      // Missing or conflicting baselines cannot establish who changed a rule.
      if (!current || baselines.length !== 1) throw new Error("No unique baseline");
      return baselines[0] === current.hash ? [] : [{ path, before: baselines[0]!, after: current.hash }];
    });
    return changed.length > 0 && changed.every(file => proof.edits.some(edit => edit.path === file.path && edit.before === file.before && edit.after === file.after));
  } catch { return false; }
}

export const judgeActor = (checkout: string, agent: "claude" | "codex", sessionId: string) =>
  shortHash(`${checkout}\0${agent === "claude" ? "claude-code" : agent}\0${sessionId}`);
