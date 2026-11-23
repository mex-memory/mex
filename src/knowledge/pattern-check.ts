/**
 * The $0 self-check for `when:` patterns learned from a review (plan sheet
 * 31). A pattern is kept only if it matches the code the reviewer objected
 * to, not the fixed code; names something of its own (not only keywords,
 * short names or variables the reviewed code declared); touches the lines
 * the comment was left on; and is rare in the entry's area. Otherwise the
 * entry keeps its path scope alone. The native hook does the matching, so
 * literal and structural patterns behave exactly as they will at delivery.
 */
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { nativeBinary } from "./check.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import type { KnowledgeEntry } from "./entry.js";
import type { GateContext } from "./gate-types.js";

export type WhenPattern = NonNullable<KnowledgeEntry["mex"]["when"]>[number];

export interface PatternCandidate extends WhenPattern {
  /** The code the reviewer objected to. */
  objected: string;
  /** The same code after the fix. */
  fixed: string;
  /**
   * The line or lines the review comment was left on, as they read in
   * `objected`. A pattern must touch them unless they are a code comment.
   */
  anchor?: string;
}

const patternVerdict = z.object({
  keep: z.boolean(),
  reason: z.string(),
  common: z.boolean(),
  files: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  occurrences: z.number().int().nonnegative(),
});
export type PatternVerdict = z.infer<typeof patternVerdict>;
const patternReply = z.object({ ok: z.literal(true), results: z.array(patternVerdict) });

/** At most this many candidates per call; the native side refuses more. */
export const PATTERN_CHECK_MAX = 64;

/**
 * Checks each candidate against its review and the files `scope` covers.
 * Returns null when the check couldn't run (no native binary, a crash):
 * callers then keep no pattern, never an unchecked one.
 */
export function checkPatterns(candidates: readonly PatternCandidate[], scope: readonly string[],
  options: KnowledgeOptions & Pick<GateContext, "checkTree" | "checkIndex">): PatternVerdict[] | null {
  if (!candidates.length) return [];
  if (candidates.length > PATTERN_CHECK_MAX) return null;
  const binary = nativeBinary(options.env);
  if (!binary) return null;
  const target = options.checkTree && options.checkIndex
    ? { checkout: options.checkTree, project_id: options.checkIndex.projectId, record_directory: options.checkIndex.recordDirectory }
    : liveTarget(options);
  const run = spawnSync(binary, ["--pattern-check"], {
    input: JSON.stringify({
      ...target, scope,
      candidates: candidates.map(c => ({ type: c.type, match: c.match, pattern: c.pattern, objected: c.objected, fixed: c.fixed, anchor: c.anchor ?? "" })),
    }),
    encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 1 << 20,
    env: { ...(options.env ?? process.env), MEX_BACKGROUND: "1" },
  });
  try {
    const parsed = patternReply.safeParse(JSON.parse(run.stdout || "{}"));
    if (!parsed.success || parsed.data.results.length !== candidates.length) return null;
    return parsed.data.results;
  } catch {
    return null;
  }
}

function liveTarget(options: KnowledgeOptions) {
  const project = knowledgeProject(options);
  return { checkout: project.root, project_id: project.projectId, record_directory: project.location.directory };
}

/** The patterns an entry may carry: the candidates the self-check kept. */
export function keptPatterns(candidates: readonly PatternCandidate[], verdicts: readonly PatternVerdict[] | null): WhenPattern[] {
  if (!verdicts) return [];
  return candidates.filter((_, i) => verdicts[i]?.keep).map(({ type, match, pattern }) => ({ type, match, pattern }));
}
