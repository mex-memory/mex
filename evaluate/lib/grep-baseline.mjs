// Grep top-3 baseline, reproduced bit-for-bit from the prior benchmark
// (EVAL_HARNESS_BUILD_PLAN.md §3). This is the realistic "what an agent would
// read instead" denominator, so the exact logic is load-bearing:
//
//   - terms   = task split on /[^A-Za-z0-9_$]+/, lowercased (camelCase stays whole)
//   - score   = sum over terms of substring-occurrence count in the lowercased file
//   - rank    = score > 0, sort by score desc, tiebreak by relative path asc, take 3
//   - tokens  = ceil(len/4) over the ENTIRE contents of the top-3 files

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { approxTokens, enumerateSource } from "./corpus.mjs";

/** Split a task into lowercased search terms (camelCase identifiers stay whole). */
export function terms(query) {
  return query.split(/[^A-Za-z0-9_$]+/).filter(Boolean).map((s) => s.toLowerCase());
}

/** Count non-overlapping substring occurrences of `term` in `lower` (split-length trick). */
function occurrences(lower, term) {
  return lower.split(term).length - 1;
}

/** The grep top-3 baseline for one task: the 3 files and their total token count. */
export function grepTop3(root, query) {
  const queryTerms = terms(query);
  const scored = [];
  for (const file of enumerateSource(root)) {
    const lower = readFileSync(file, "utf-8").toLowerCase();
    let score = 0;
    for (const term of queryTerms) score += occurrences(lower, term);
    if (score > 0) scored.push({ file, rel: relative(root, file), score });
  }
  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  const top3 = scored.slice(0, 3);
  const baselineTokens = top3.reduce((sum, { file }) => sum + approxTokens(readFileSync(file, "utf-8")), 0);
  return { files: top3.map((f) => f.rel), baselineTokens };
}
