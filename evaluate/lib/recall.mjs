// Expected-symbol recall, reproduced from the prior benchmark
// (EVAL_HARNESS_BUILD_PLAN.md §3): count only `type === "fact"` rows; an
// expected symbol is found when some fact matches its `name` exactly OR its
// `qualifiedName` contains the symbol (case-sensitive).

/** Fraction of `expected` symbols present in the returned facts. */
export function expectedRecall(rows, expected) {
  if (expected.length === 0) return 1;
  const facts = rows.filter((row) => row && row.type === "fact");
  const found = expected.filter((name) =>
    facts.some((row) => row.name === name || String(row.qualifiedName ?? "").includes(name)),
  );
  return found.length / expected.length;
}
