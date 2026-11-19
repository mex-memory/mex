/**
 * The $0 self-check for `when:` patterns learned from a review (plan sheet
 * 31). A pattern is kept only if it matches the code the reviewer objected
 * to, not the fixed code, and is rare in the entry's area; otherwise the
 * entry keeps its path scope alone. The native hook does the matching, so
 * literal and structural patterns behave exactly as they will at delivery.
 */
import { spawnSync } from "node:child_process";
import { nativeBinary } from "./check.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import type { KnowledgeEntry } from "./entry.js";

export type WhenPattern = NonNullable<KnowledgeEntry["mex"]["when"]>[number];

export interface PatternCandidate extends WhenPattern {
  /** The code the reviewer objected to. */
  objected: string;
  /** The same code after the fix. */
  fixed: string;
}

export interface PatternVerdict { keep: boolean; reason: string; files: number; matched: number }

/** At most this many candidates per call; the native side refuses more. */
export const PATTERN_CHECK_MAX = 64;

/**
 * Checks each candidate against its review and the files `scope` covers.
 * Returns null when the check couldn't run (no native binary, a crash):
 * callers then keep no pattern, never an unchecked one.
 */
export function checkPatterns(candidates: readonly PatternCandidate[], scope: readonly string[], options: KnowledgeOptions): PatternVerdict[] | null {
  if (!candidates.length) return [];
  if (candidates.length > PATTERN_CHECK_MAX) return null;
  const binary = nativeBinary(options.env);
  if (!binary) return null;
  const project = knowledgeProject(options);
  const run = spawnSync(binary, ["--pattern-check"], {
    input: JSON.stringify({
      checkout: project.root, project_id: project.projectId, record_directory: project.location.directory, scope,
      candidates: candidates.map(c => ({ type: c.type, match: c.match, pattern: c.pattern, objected: c.objected, fixed: c.fixed })),
    }),
    encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 1 << 20,
    env: { ...(options.env ?? process.env), MEX_BACKGROUND: "1" },
  });
  try {
    const parsed = JSON.parse(run.stdout || "{}") as { ok?: boolean; results?: PatternVerdict[] };
    if (!parsed.ok || !Array.isArray(parsed.results) || parsed.results.length !== candidates.length) return null;
    return parsed.results.map(r => ({ keep: r.keep === true, reason: String(r.reason ?? ""), files: Number(r.files) || 0, matched: Number(r.matched) || 0 }));
  } catch {
    return null;
  }
}

/** The patterns an entry may carry: the candidates the self-check kept. */
export function keptPatterns(candidates: readonly PatternCandidate[], verdicts: readonly PatternVerdict[] | null): WhenPattern[] {
  if (!verdicts) return [];
  return candidates.filter((_, i) => verdicts[i]?.keep).map(({ type, match, pattern }) => ({ type, match, pattern }));
}
