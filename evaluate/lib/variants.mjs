// The two buildable end-to-end variants (EVAL_HARNESS_BUILD_PLAN.md §5, reduced
// from the original A-D: variant A — old all-source scope — was removed in the M2
// redesign, and C/D — flow-spine source, skeletonization — were deferred).
//
// This is the decision M5 exists to settle: what should the shipped default
// `--detail` be?
//
//   minimal — source-off, two-stage: scope returns a compact manifest, the agent
//             expands specific ids with `graph get` (fewer initial tokens, an
//             extra round-trip).
//   source  — one-shot: scope returns grouped source inline (more initial tokens,
//             no expansion round-trip; the CodeGraph-style answer-ready mode).

export const VARIANTS = {
  minimal: { id: "minimal", detail: "minimal" },
  source: { id: "source", detail: "source" },
};
