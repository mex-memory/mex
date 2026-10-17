/**
 * The prompt composer: question in, packet (or a reasoned silence) out.
 *
 * Read-only and free of host concerns. It takes a context index, the prompt
 * text and what is available (an embedder, the session's already-shown ids),
 * picks the frozen recipe by availability, ranks, gates and formats. It never
 * rebuilds an index, loads a model on its own, or writes state; the CLI layer
 * (and later the hook entry points) own those.
 */

import { ensureEntityVectors, type Embedder } from "./dense.js";
import { RECIPES, WIKI_CANDIDATE_TYPES, type Recipe } from "./frozen.js";
import { formatPacket, resolveLiveState, type LiveStateResolver } from "./packet.js";
import {
  buildRankIndex,
  fuseDense,
  gateCandidates,
  rankQuery,
  type GateResult,
  type RankableEntity,
} from "./rank.js";
import type {
  AbstentionReason,
  CandidateExplain,
  ContextDiagnostic,
  ContextEntity,
  ContextIndex,
  PromptResult,
} from "./types.js";

export interface ComposeOptions {
  /** `.mex` directory, for live health. */
  scaffoldRoot: string;
  /** Ids this session has already seen. */
  shown?: ReadonlySet<string>;
  /** The semantic extra, when it is installed and loads; absent selects the lexical fallback. */
  embedder?: Embedder | null;
  /** Replace live-state resolution (tests; hooks that already hold a graph handle). */
  liveState?: (entities: readonly ContextEntity[]) => LiveStateResolver;
}

export interface ComposeOutcome {
  result: PromptResult;
  /** Vectors computed this call and written into `index.vectors`; persist the index when above zero. */
  vectorsComputed: number;
  diagnostics: ContextDiagnostic[];
}

/** A section with prose of its own: at least 20 characters once headings are removed. */
export function hasBody(entity: Pick<ContextEntity, "body">): boolean {
  return entity.body.replace(/^\s*#+.*$/gm, "").replace(/\s+/g, " ").trim().length >= 20;
}

export function isWikiCandidate(entity: ContextEntity): boolean {
  return entity.level > 0 && WIKI_CANDIDATE_TYPES.has(entity.type) && hasBody(entity);
}

/** Everything the dense recipe may rank: the typed sections with a body, and every fact. */
export const isDenseCandidate = (entity: ContextEntity): boolean => entity.type === "fact" || isWikiCandidate(entity);

/** The entities a recipe ranks. */
export function candidatePool(index: ContextIndex, recipe: Recipe): ContextEntity[] {
  if (recipe.candidates === "facts") return index.entities.filter((e) => e.type === "fact");
  return index.entities.filter(recipe.dense ? isDenseCandidate : isWikiCandidate);
}

const toRankable = (entity: ContextEntity): RankableEntity => ({
  id: entity.id,
  title: entity.title,
  body: entity.body,
  aliases: entity.aliases,
  code: entity.code,
  symbolNames: entity.symbols.map((s) => s.name),
  symbolFiles: entity.symbols.map((s) => s.file),
});

function emptyResult(abstention: AbstentionReason, recipe: PromptResult["recipe"] = null): PromptResult {
  return {
    recipe,
    channel: recipe === "R3" ? "hybrid" : recipe === "R2w" ? "lexical" : null,
    injected: [],
    abstention,
    packet: "",
    candidates: [],
    alreadyShown: [],
  };
}

export async function composePrompt(index: ContextIndex, prompt: string, options: ComposeOptions): Promise<ComposeOutcome> {
  const diagnostics: ContextDiagnostic[] = [];
  const done = (result: PromptResult, vectorsComputed = 0): ComposeOutcome => ({ result, vectorsComputed, diagnostics });

  const text = prompt.trim();
  if (text === "") return done(emptyResult("empty-prompt"));
  // A background-task completion arrives as a prompt; it is not a new task.
  if (/^<task-notification>/.test(text)) return done(emptyResult("task-notification"));
  if (index.entities.length === 0) return done(emptyResult("no-index"));

  let recipe: Recipe = options.embedder && candidatePool(index, RECIPES.R3).length > 0 ? RECIPES.R3 : RECIPES.R2w;
  let pool = candidatePool(index, recipe);
  if (pool.length === 0) return done(emptyResult("no-candidates", recipe.name));

  const projectWords = new Set(index.projectWords);
  const rankIndex = buildRankIndex(pool.map(toRankable), projectWords);
  let output = rankQuery(rankIndex, text);
  let vectorsComputed = 0;
  if (recipe.dense) {
    try {
      const embedder = options.embedder!;
      const { vectors, computed } = await ensureEntityVectors(index, pool, embedder);
      vectorsComputed = computed;
      const queryVectors: Float32Array[] = [];
      for (const window of output.windows) queryVectors.push(await embedder.embed(window));
      output = fuseDense(rankIndex, output, queryVectors, vectors);
    } catch (error) {
      diagnostics.push({
        code: "CONTEXT_SEMANTIC_FAILED",
        severity: "warning",
        message: `The semantic channel failed (${error instanceof Error ? error.message : String(error)}); using the lexical recipe.`,
        remediation: "Run `mex context semantic status` to check the install.",
      });
      recipe = RECIPES.R2w;
      pool = candidatePool(index, recipe);
      if (pool.length === 0) return done(emptyResult("no-candidates", recipe.name));
      output = rankQuery(buildRankIndex(pool.map(toRankable), projectWords), text);
    }
  }

  const gate: GateResult = gateCandidates(output.list, recipe, output.windows.length > 1);
  const byId = new Map(index.entities.map((e) => [e.id, e]));
  const shown = options.shown ?? new Set<string>();
  const alreadyShown: string[] = [];
  const kept = gate.selected.filter((candidate) => {
    if (!shown.has(candidate.doc.entity.id)) return true;
    alreadyShown.push(candidate.doc.entity.id);
    return false;
  });

  const candidates: CandidateExplain[] = gate.window.map(({ rank, candidate, decision }) => {
    const entity = byId.get(candidate.doc.entity.id)!;
    const dropped = decision === "selected" && shown.has(entity.id);
    return {
      rank,
      id: entity.id,
      title: entity.title,
      type: entity.type,
      score: candidate.score,
      norm: candidate.norm,
      groups: candidate.groups,
      exact: candidate.exact,
      ...(candidate.cos === undefined ? {} : { cos: candidate.cos }),
      ...(candidate.fn === undefined ? {} : { fused: candidate.fn }),
      decision: dropped ? "already-shown" : decision,
    };
  });

  const base: PromptResult = {
    recipe: recipe.name,
    channel: recipe.dense ? "hybrid" : "lexical",
    injected: [],
    abstention: null,
    packet: "",
    candidates,
    alreadyShown,
  };

  if (kept.length === 0) {
    const top = gate.window[0]?.decision;
    const reason: AbstentionReason = gate.selected.length > 0
      ? "already-shown"
      : top === undefined ? "no-match" : (top as AbstentionReason);
    return done({ ...base, abstention: reason }, vectorsComputed);
  }

  const entities = kept.map((candidate) => byId.get(candidate.doc.entity.id)!);
  const resolve = (options.liveState ?? ((list) => resolveLiveState(options.scaffoldRoot, list)))(entities);
  const formatted = formatPacket(
    entities.map((entity) => ({ entity, live: resolve(entity) })),
    recipe.dense ? "semantic" : "lexical",
  );
  return done(
    {
      ...base,
      injected: formatted.shown.map(({ entity, live }) => ({
        id: entity.id,
        title: entity.title,
        type: entity.type,
        health: live.health,
      })),
      packet: formatted.text,
    },
    vectorsComputed,
  );
}
