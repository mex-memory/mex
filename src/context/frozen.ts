/**
 * The frozen prompt-ranking recipes.
 *
 * Everything in this file is the output of a sealed held-out evaluation: 70
 * questions over two large repositories, split into a development and a test
 * half. Thresholds were frozen on the development half and the test half was
 * run once. **Do not tune any number, weight, word list or stage order here
 * without re-running that evaluation**; the parity script
 * (`scripts/context-parity.mjs`) exists to prove this port still reproduces the
 * reference injections one for one.
 */

/**
 * Words that never carry a query concept (the frozen tokenizer's stop list).
 * The project's own name is added per project at index time (`projectWords`).
 */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  ("the a an and or of to in on for with from by is are was were be been how what why when which who does do did "
    + "this that these those it its into via as at than then there their they you your not no can will would "
    + "should could about after before over under between only also just more most some any each every one two "
    + "all get got make made use used using").split(" "),
);

/**
 * Conversational filler dropped from a prompt before scoring.
 *
 * The reference also carries a second "code noise" list ("error", "issue",
 * "update", "test", "function", ...). It is consumed only by the segment
 * vocabulary channel, which the frozen recipes disable (`seg: 0`), so it never
 * affected a frozen result and is deliberately not ported.
 */
export const QUERY_FILLER: ReadonlySet<string> = new Set(
  ("please explain describe tell show find want need look let see give say way thing things happen happens "
    + "happening works work working really actually exactly whether might must may").split(" "),
);

export type RecipeName = "R3" | "R2w";

export interface RecipeThresholds {
  floor: number;
  /** Query-term groups a candidate must match when it has no exact identifier hit. */
  G: number;
  /** A second entry must reach this fraction of the first one's score. */
  ratio: number;
  /** Most entries one prompt may inject. */
  max: number;
  /** Dense channel only: the smallest cosine a candidate may have. */
  tauD?: number;
  /** First candidate must beat the fourth-ranked by this fraction of itself. */
  margin: number;
  /** Dense channel only: the smallest normalised fused score. */
  fnMin?: number;
}

/**
 * The gate for a prompt that was cut into several windows. A window holds at
 * most `WINDOWING.capWords` words, so it carries fewer matching words than a
 * whole question, and the best of many windows is a maximum, so the runner-up
 * is flattered too: the floor and corroboration are lower and the lead over the
 * fourth candidate carries the weight, with a second entry only when it is
 * nearly as good as the first. The dense recipe uses this same lexical gate and
 * adds the cosine as a veto (a candidate under `cosineMin` is dropped first).
 */
export interface WindowedGate {
  thresholds: RecipeThresholds;
  cosineMin?: number;
}

export interface Recipe {
  name: RecipeName;
  /** `facts`: type fact only. `wiki`: typed sections that carry body text. */
  candidates: "facts" | "wiki";
  dense: boolean;
  thresholds: RecipeThresholds;
  windowed: WindowedGate;
}

export const RECIPES: Readonly<Record<RecipeName, Recipe>> = {
  R3: {
    name: "R3",
    candidates: "wiki",
    dense: true,
    thresholds: { floor: 0.2591, G: 5, ratio: 0.2, max: 2, tauD: 0.6, margin: 0, fnMin: 0 },
    windowed: { thresholds: { floor: 0.293, G: 3, ratio: 0.9, max: 2, margin: 0.6 }, cosineMin: 0.5 },
  },
  R2w: {
    name: "R2w",
    candidates: "wiki",
    dense: false,
    thresholds: { floor: 0.41859999999999997, G: 5, ratio: 0.5, max: 2, margin: 0.45 },
    windowed: { thresholds: { floor: 0.293, G: 3, ratio: 0.9, max: 2, margin: 0.45 } },
  },
};

/**
 * How a long prompt is cut into windows before scoring. A prompt of at most
 * `singleMaxWords` words is one window and ranks exactly as it always did (the window size and the one-text limit are the same, so "fits in one window" means "is not cut");
 * longer prompts are scored window by window, each normalised by its own
 * query-term weight, so a task description does not dilute the one sentence
 * that names the problem.
 */
export interface WindowParams {
  /** A prompt of at most this many words is a single window. */
  singleMaxWords: number;
  /** The most words one window may hold (a longer sentence is cut). */
  capWords: number;
  /** A sentence shorter than this is merged into its neighbour. */
  minWords: number;
  /** Windows scored per prompt; the rest are ignored. */
  maxWindows: number;
  /** `window`: identifiers are read from the window; `prompt`: from the whole prompt. */
  identScope: "window" | "prompt";
  /** `window`: corroboration counts query words of the window; `prompt`: of the whole prompt. */
  groupScope: "window" | "prompt";
}

export const WINDOWING: WindowParams = {
  singleMaxWords: 40,
  capWords: 40,
  minWords: 10,
  maxWindows: 12,
  identScope: "window",
  groupScope: "window",
};

/** How many ranked candidates reach the gate. */
export const GATE_WINDOW = 12;

/** Reciprocal-rank fusion constant and the dense channel's depth. */
export const RRF_K = 60;
export const DENSE_TOP_N = 20;

/** Types a wiki-wide (R2w) candidate may have. */
export const WIKI_CANDIDATE_TYPES: ReadonlySet<string> = new Set([
  "fact",
  "convention",
  "decision",
  "guide",
  "pattern",
  "component",
]);

/** The dense channel's model, as frozen. */
export const DENSE_MODEL = {
  library: "@huggingface/transformers",
  model: "Xenova/all-MiniLM-L6-v2",
  dtype: "q8",
  pooling: "mean",
  normalize: true,
  /** Characters of body that enter the document text. */
  bodyChars: 900,
} as const;

/** Stable key for cached vectors: model, quantisation and pooling together. */
export const DENSE_MODEL_ID = `${DENSE_MODEL.model}:${DENSE_MODEL.dtype}:${DENSE_MODEL.pooling}`;
