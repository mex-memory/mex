// Rubric grading. A task's `rubric` is the set of strings the answer must contain
// to count as correct (deterministic; the CI-gateable signal). Model-graded prose
// scoring can layer on top later but stays reporting-only.

export function grade(answer, rubric) {
  const text = String(answer ?? "");
  const matched = rubric.filter((needle) => text.includes(needle));
  return { correct: matched.length === rubric.length, matched: matched.length, total: rubric.length };
}
