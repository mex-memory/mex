import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphEngine, GraphNeighbor, IndexedFileInfo, SourceChunkMatch } from "./engine.js";
import { identifierComponents, isLowValueGraphPath, planGraphQuery } from "./retrieval/query.js";
import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from "./types.js";

export type DetailLevel = "minimal" | "standard" | "source";

export interface CompactFact {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  callerCount: number;
  calleeCount: number;
  detail: DetailLevel;
  sourceIncluded: boolean;
  bodyHash?: string;
  fingerprint?: string;
  score?: number;
  selectionReasons?: string[];
}

export type SelectionCategory = "direct" | "neighbor" | "test";

export interface ScopedCandidate {
  id: string;
  score: number;
  reasons: string[];
  category: SelectionCategory;
}

export interface RankedScopeFile {
  filePath: string;
  score: number;
  reasons: string[];
  nodeIds: string[];
  textHits: SourceChunkMatch[];
  textOnly: boolean;
  parseStatus: "ok" | "partial" | "failed";
}

export interface ScopeFlow { steps: GraphEdge[]; }

export interface ScopeSelection {
  candidates: ScopedCandidate[];
  files: RankedScopeFile[];
  flows: ScopeFlow[];
  matchedCount: number;
  coveredTerms: string[];
  evidenceStrength: "strong" | "moderate" | "weak" | "none";
}

export interface SourceRange {
  startLine: number;
  endLine: number;
  nodeIds: string[];
  content: string;
  truncated: boolean;
  reason?: "whole-file" | "complete-symbol" | "query-hit" | "callsite" | "signature" | "text-only";
}

const RRF_K = 60;
const SOURCE_FILE_RRF_WEIGHT = 30;
const RELEVANCE_EDGE_KINDS: EdgeKind[] = [
  "calls", "instantiates", "references", "imports", "exports", "extends",
  "implements", "overrides", "type_of", "returns", "contains",
];
const FLOW_EDGE_KINDS: EdgeKind[] = ["calls", "instantiates", "references"];
const FLOW_TRAVERSAL_EDGE_KINDS: EdgeKind[] = [...FLOW_EDGE_KINDS, "contains"];
const STRONG_FLOW_RELEVANCE = 2;
const SOURCE_NEAR_CUTOFF_RATIO = 0.85;
/** Fixed request limits: callers in a high-fan-in graph must not multiply flow work. */
const MAX_FLOW_SEEDS = 32;
const FLOW_TRAVERSAL_WORK_BUDGET = 256;
const FLOW_BRANCH_LIMIT = 8;
/** One proven whole-query call pair may complete through a direct callback. */
const CALL_PAIR_CALLBACKS_LIMIT = 2;
const CALL_PAIR_CALLBACK_EDGES_LIMIT = 4;
const MIN_CALL_PAIR_CALLBACK_TERMINAL_NAME_RELEVANCE = 1;
/** Bounded adjacent-concept searches used only to prove cross-file semantic destinations. */
const MAX_SEMANTIC_PHRASE_SEARCHES = 8;
const MAX_SEMANTIC_PHRASE_CANDIDATES = 8;
const MAX_SEMANTIC_PHRASE_OUTGOING_PER_SOURCE = 16;
const MAX_SEMANTIC_PHRASE_BRIDGES = 2;
const MIN_SEMANTIC_PHRASE_CONCEPT_WEIGHT = 1;
/** Whole-query call-pair seeds stay inside the already fetched, bounded BM25 pool. */
const MAX_FULL_QUERY_CALL_PAIR_RANK = 64;
const MAX_FULL_QUERY_CALL_PAIR_SEEDS = 2;
/** A compound request may reserve at most two independently strong responsibilities. */
const MAX_STRONG_INTENT_FACET_DECLARATIONS = 2;

interface NodeEvidence {
  node: GraphNode;
  rrf: number;
  /** Best zero-based rank in the independent whole-task node BM25 channel. */
  fullQueryRank: number;
  /** Query evidence from an FTS region that overlaps this declaration. */
  region: number;
  /** Direct (non-propagated) portion of source-region evidence. */
  directRegion: number;
  regionHits: SourceChunkMatch[];
  /** Best zero-based rank of a source chunk aligned to this declaration. */
  bestRegionRank: number;
  /** Declaration order supplied by the source-chunk bridge at that rank. */
  bestRegionOverlapRank: number;
  /** Trusted semantic callsites whose source locations fall inside matched regions. */
  regionCallsites: Set<string>;
  /** Trusted structural entries into one anonymous callback within a matched region. */
  regionCallbackCallsites: Set<string>;
  /** Best source-chunk rank of a trusted callsite that reached this node. */
  bestCallsiteRank: number;
  exact: boolean;
  exactIdentifiers: Set<string>;
  graph: number;
  terms: Set<string>;
  nameTerms: Set<string>;
  reasons: Set<string>;
  reliable: boolean;
}

interface FileEvidence {
  filePath: string;
  score: number;
  /** Strongest declaration-aligned source-region signal in this file. */
  region: number;
  /** Strongest trusted callsite expansion entering this file. */
  callsiteRegion: number;
  /** Query-concept weight at the source region proving that callsite. */
  callsiteQueryWeight: number;
  /** Best source-chunk rank backing that callsite expansion. */
  bestCallsiteRank: number;
  terms: Set<string>;
  reasons: Set<string>;
  nodeIds: Set<string>;
  textHits: SourceChunkMatch[];
  /** Best zero-based position in the independent source-chunk channel. */
  bestTextRank: number;
  exact: boolean;
  exactIdentifiers: Set<string>;
  reliableGraph: boolean;
}

interface QueryConcept {
  key: string;
  raw: string;
  weight: number;
  terms: Array<{ term: string; stem: boolean }>;
}

interface ScopeRequestAccess {
  rememberNode(node: GraphNode): void;
  getNode(id: string): GraphNode | null;
  getIncoming(id: string, kinds: EdgeKind[]): GraphNeighbor[];
  getOutgoing(id: string, kinds: EdgeKind[]): GraphNeighbor[];
}

interface DerivedFlowSeed {
  node: GraphNode;
  relevance: number;
  callsiteRank: number;
  confidence: number;
}

interface SemanticPhraseBridge {
  source: NodeEvidence;
  target: NodeEvidence;
  edge: GraphEdge;
  phraseIndex: number;
  sourceRank: number;
}

interface FullQueryCallPair {
  source: NodeEvidence;
  target: NodeEvidence;
  edge: GraphEdge;
}

export function scopeSelect(graph: GraphEngine, task: string): string[] {
  return selectScope(graph, task, 24, 6).candidates.map((candidate) => candidate.id);
}

/** File-first hybrid retrieval with independent RRF channels and gated graph expansion. */
export function selectScope(
  graph: GraphEngine,
  task: string,
  maxNodes: number,
  maxFiles = 6,
): ScopeSelection {
  if (maxNodes <= 0 || maxFiles <= 0) return emptySelection();
  const plan = planGraphQuery(task);
  if (plan.terms.length === 0 && plan.explicitIdentifiers.length === 0) return emptySelection();

  const access = createScopeRequestAccess(graph);
  const nodes = new Map<string, NodeEvidence>();
  const fileEvidence = new Map<string, FileEvidence>();
  const queryTerms = weightedTerms(plan);
  const concepts = queryConcepts(plan);
  const adjacentConceptPairs = concepts.slice(0, -1).map((left, index) => ({
    left,
    right: concepts[index + 1]!,
    query: `${left.raw} ${concepts[index + 1]!.raw}`,
    index,
  })).filter(({ left, right }) => left.weight >= MIN_SEMANTIC_PHRASE_CONCEPT_WEIGHT
    || right.weight >= MIN_SEMANTIC_PHRASE_CONCEPT_WEIGHT)
    .slice(0, MAX_SEMANTIC_PHRASE_SEARCHES);
  const requestedSearches = [
    { query: task, limit: 80 },
    ...plan.explicitIdentifiers.map((query) => ({ query, limit: 60 })),
    ...concepts.slice(0, 16).map((concept) => ({ query: concept.raw, limit: 30 })),
    ...adjacentConceptPairs.map((pair) => ({ query: pair.query, limit: 24 })),
  ];
  const searchRequests = new Map<string, { query: string; limit: number }>();
  for (const request of requestedSearches) {
    const key = normalizeNodeSearch(request.query);
    const prior = searchRequests.get(key);
    if (!prior || request.limit > prior.limit) searchRequests.set(key, { query: prior?.query ?? request.query, limit: request.limit });
  }
  const nodeSearchCache = new Map<string, GraphNode[]>();
  for (const [key, request] of searchRequests) {
    const results = graph.searchNodes(request.query, { limit: request.limit });
    for (const node of results) access.rememberNode(node);
    nodeSearchCache.set(key, results);
  }
  const searchNodes = (query: string, limit: number): GraphNode[] =>
    (nodeSearchCache.get(normalizeNodeSearch(query)) ?? []).slice(0, limit);
  const addNodeChannel = (
    ranked: GraphNode[],
    reason: string | ((node: GraphNode) => string),
    exactIdentifier?: string,
    fullQuery = false,
  ): void => {
    ranked.forEach((node, index) => {
      const evidence = ensureNode(nodes, node);
      evidence.rrf += 1 / (RRF_K + index + 1);
      if (fullQuery) evidence.fullQueryRank = Math.min(evidence.fullQueryRank, index);
      evidence.exact ||= exactIdentifier !== undefined;
      if (exactIdentifier) evidence.exactIdentifiers.add(exactIdentifier);
      evidence.reasons.add(typeof reason === "string" ? reason : reason(node));
      for (const term of queryTerms) if (nodeContains(node, term.term, term.stem)) evidence.terms.add(term.term);
      const nameComponents = new Set(searchComponents(node.name));
      for (const term of queryTerms) {
        if (componentMatches(nameComponents, term.term, term.stem)) evidence.nameTerms.add(term.term);
      }
    });
  };

  addNodeChannel(searchNodes(task, 80), "bm25-node", undefined, true);
  for (const identifier of plan.explicitIdentifiers) {
    const candidates = searchNodes(identifier, 60);
    const strict = candidates.filter((node) => exactIdentifierMatch(node, identifier));
    const exact = strict.length > 0 || !/^[A-Z][a-z]+$/.test(identifier)
      ? strict
      : candidates.filter((node) => caseFoldedIdentifierMatch(node, identifier));
    addNodeChannel(exact, `exact:${identifier}`, identifier);
  }
  for (const concept of concepts.slice(0, 16)) {
    const matchedTerm = new Map<string, string>();
    const candidates = searchNodes(concept.raw, 30).filter((node) => {
      const match = concept.terms.find((term) => nodeContains(node, term.term, term.stem));
      if (match) matchedTerm.set(node.id, match.term);
      return Boolean(match);
    });
    addNodeChannel(candidates, (node) => `term:${matchedTerm.get(node.id) ?? concept.key}`);
  }

  // A broad multi-responsibility query can rank a literal namesake above the
  // actual entry point. Preserve a destination only when an adjacent query
  // phrase independently matches both endpoints of a real, cross-file,
  // compiler-trusted semantic edge. Same-file helpers, one-sided lexical
  // matches, and ambiguous edges cannot consume this two-file reserve.
  const phraseBridgeCandidates = adjacentConceptPairs.flatMap((pair) => searchNodes(pair.query, 24)
    .map((source, sourceRank) => ({ source, sourceRank }))
    .filter(({ source }) => nodeMatchesConcept(source, pair.left)
      && nodeMatchesConcept(source, pair.right)
      && (nodeMatchesConceptInIdentity(source, pair.left)
        || nodeMatchesConceptInIdentity(source, pair.right))
      && (plan.asksForTests || !isLowValueGraphPath(source.filePath)))
    .slice(0, MAX_SEMANTIC_PHRASE_CANDIDATES)
    .flatMap(({ source, sourceRank }) => [...access.getOutgoing(source.id, FLOW_EDGE_KINDS)]
      .sort(compareSemanticPhraseNeighbor)
      .slice(0, MAX_SEMANTIC_PHRASE_OUTGOING_PER_SOURCE)
      .filter(({ node: target, edge }) => (edge.confidence ?? 1) >= 0.8
        && source.filePath !== target.filePath
        && isSourceAnchorKind(target)
        && nodeMatchesConcept(target, pair.left)
        && nodeMatchesConcept(target, pair.right)
        && (nodeMatchesConceptInIdentity(target, pair.left)
          || nodeMatchesConceptInIdentity(target, pair.right))
        && (plan.asksForTests || !isLowValueGraphPath(target.filePath)))
      .map(({ node: target, edge }) => ({
        source, target, edge, sourceRank, phraseIndex: pair.index, left: pair.left, right: pair.right,
      }))));
  const semanticPhraseBridges: SemanticPhraseBridge[] = [];
  const semanticPhraseTargetPaths = new Set<string>();
  for (const bridge of phraseBridgeCandidates.sort((left, right) => left.sourceRank - right.sourceRank
    || left.phraseIndex - right.phraseIndex
    || (right.edge.confidence ?? 1) - (left.edge.confidence ?? 1)
    || compareEdgeCallsite(left.edge, right.edge)
    || left.source.filePath.localeCompare(right.source.filePath)
    || left.source.id.localeCompare(right.source.id)
    || left.target.filePath.localeCompare(right.target.filePath)
    || left.target.id.localeCompare(right.target.id))) {
    if (semanticPhraseTargetPaths.has(bridge.target.filePath)) continue;
    const source = ensureNode(nodes, bridge.source);
    const target = ensureNode(nodes, bridge.target);
    source.rrf += 1 / (RRF_K + bridge.sourceRank + 1);
    source.reasons.add("query-phrase-flow");
    source.reliable = true;
    target.graph = Math.max(target.graph, 0.16 * (bridge.edge.confidence ?? 1));
    target.reasons.add(`graph:${bridge.edge.kind}`);
    target.reasons.add("query-phrase-flow");
    target.reliable = true;
    for (const concept of [bridge.left, bridge.right]) {
      addConceptEvidence(source, concept);
      addConceptEvidence(target, concept);
    }
    const file = ensureFile(fileEvidence, target.node.filePath);
    file.nodeIds.add(target.node.id);
    file.reliableGraph = true;
    file.reasons.add("query-phrase-flow");
    semanticPhraseBridges.push({ source, target, edge: bridge.edge, phraseIndex: bridge.phraseIndex, sourceRank: bridge.sourceRank });
    semanticPhraseTargetPaths.add(target.node.filePath);
    if (semanticPhraseBridges.length >= MAX_SEMANTIC_PHRASE_BRIDGES) break;
  }

  const indexedFiles = safeIndexedFiles(graph);
  const fileInfo = new Map(indexedFiles.map((file) => [file.path, file]));
  const textHits = safeSourceSearch(graph, task, 100);
  const queryRegionCallsiteRanks = new Map<string, number>();
  const queryRegionCallsiteWeights = new Map<string, number>();
  textHits.forEach((hit, index) => {
    const evidence = ensureFile(fileEvidence, hit.filePath);
    evidence.reasons.add("source-fts");
    evidence.textHits.push(hit);
    evidence.bestTextRank = Math.min(evidence.bestTextRank, index);

    // Source FTS is a declaration-retrieval channel, not merely a file vote.
    // The store supplies a bounded list of named declarations overlapping the
    // recovered region. This bridges natural-language body/comment matches to
    // symbols without inventing synonyms or graph relationships.
    const hitTerms = new Set(hit.matchedTerms ?? []);
    const localConceptCount = concepts.filter((concept) => conceptMatchesTerms(concept, hitTerms)).length;
    const localConceptWeight = concepts.filter((concept) => conceptMatchesTerms(concept, hitTerms))
      .reduce((sum, concept) => sum + concept.weight, 0);
    for (const [overlapIndex, id] of (hit.nodeIds ?? []).entries()) {
      const node = access.getNode(id);
      if (!node || node.filePath !== hit.filePath || !isSourceAnchorKind(node)) continue;
      const entry = ensureNode(nodes, node);
      if (index < entry.bestRegionRank) {
        entry.bestRegionRank = index;
        entry.bestRegionOverlapRank = overlapIndex;
      } else if (index === entry.bestRegionRank) {
        entry.bestRegionOverlapRank = Math.min(entry.bestRegionOverlapRank, overlapIndex);
      }
      for (const term of hitTerms) entry.terms.add(term);
      const nameComponents = new Set(searchComponents(node.name));
      for (const term of queryTerms) {
        if (componentMatches(nameComponents, term.term, term.stem)) entry.nameTerms.add(term.term);
      }
      const nameConceptCount = concepts.filter((concept) => conceptMatchesComponents(concept, nameComponents)).length;
      const startsInside = node.startLine >= hit.startLine && node.startLine <= hit.endLine;
      const enclosesRegion = node.startLine <= hit.startLine && node.endLine >= hit.endLine;
      const alignment = Math.min(1.2,
        Math.max(0, localConceptCount - 1) * 0.18
        + nameConceptCount * 0.32
        + (startsInside ? 0.08 : enclosesRegion ? 0.04 : 0)
        + Math.min(0.1, Math.abs(hit.rank) * 2)
        + 20 / (RRF_K + index + overlapIndex + 1));
      entry.region = Math.max(entry.region, alignment);
      entry.directRegion = Math.max(entry.directRegion, alignment);
      if (!entry.regionHits.some((candidate) => candidate.filePath === hit.filePath
        && candidate.startLine === hit.startLine && candidate.endLine === hit.endLine)) {
        entry.regionHits.push(hit);
      }
      // Inspect semantic callsites only for the strongest global source
      // regions. Looking up every declaration in all 100 windows is both noisy
      // and needlessly expensive on compiler-sized repositories.
      if (index < 24 || (index < 64 && overlapIndex === 0 && localConceptCount >= 2)) {
        const outgoing = access.getOutgoing(node.id, FLOW_TRAVERSAL_EDGE_KINDS).filter((neighbor) => (
          (neighbor.edge.confidence ?? 1) >= 0.8
          && (neighbor.edge.kind !== "contains" || isUnnamedFlowNode(neighbor.node))
        ));
        for (const neighbor of outgoing) {
          if (neighbor.edge.line === undefined || neighbor.edge.line < hit.startLine || neighbor.edge.line > hit.endLine) continue;
          const key = edgeKey(neighbor.edge);
          entry.regionCallsites.add(key);
          queryRegionCallsiteRanks.set(key, Math.min(queryRegionCallsiteRanks.get(key) ?? index, index));
          queryRegionCallsiteWeights.set(key, Math.max(queryRegionCallsiteWeights.get(key) ?? 0, localConceptWeight));
          if (neighbor.edge.kind === "contains" && isUnnamedFlowNode(neighbor.node)) {
            entry.regionCallbackCallsites.add(key);
          }
        }
      }
      entry.rrf += 1 / (RRF_K + index + overlapIndex + 1);
      entry.reasons.add("source-region");
      evidence.region = Math.max(evidence.region, alignment);
      evidence.nodeIds.add(node.id);
    }
  });
  for (const entry of nodes.values()) {
    const file = ensureFile(fileEvidence, entry.node.filePath);
    file.region = Math.max(file.region, regionStrength(entry));
  }

  // Per-term channels deliberately stay narrow, so a long natural-language
  // request can place its real public entry point below every individual
  // generic-term cutoff. Recover only a bounded declaration that is already
  // in the whole-query pool, is public/exported, and calls another whole-query
  // declaration that adds an independent intent concept. This compiler-proven
  // pair rejects broad source/evaluation helpers that merely describe the
  // retrieval machinery. Graph traversal, rather than further lexical
  // widening, decides which later implementation helpers belong to the entry.
  const fullQueryCallPairs = bestFullQueryCallPairs(
    [...nodes.values()], concepts, access, MAX_FULL_QUERY_CALL_PAIR_SEEDS,
  );
  const fullQueryCallPairSeeds = fullQueryCallPairs.flatMap((pair) => [pair.source, pair.target]);
  const fullQueryCallPairSeedIds = new Set(fullQueryCallPairSeeds.map((entry) => entry.node.id));
  for (const entry of fullQueryCallPairSeeds) {
    entry.reliable = true;
    entry.reasons.add("bm25-call-pair");
    for (const concept of concepts) {
      if (nodeMatchesConcept(entry.node, concept)) addConceptEvidence(entry, concept);
    }
    const file = ensureFile(fileEvidence, entry.node.filePath);
    file.nodeIds.add(entry.node.id);
    file.reliableGraph = true;
    file.reasons.add("bm25-call-pair");
  }

  const pathTerms = literalTerms(plan).filter((term) => term.length >= 3);
  const adjacentPairs = pathTerms.slice(0, -1).map((term, index) => [term, pathTerms[index + 1]!] as const);
  const pathMatches = indexedFiles.map((file) => {
    const components = new Set(searchComponents(file.path));
    const basename = new Set(searchComponents(file.path.split("/").at(-1) ?? file.path));
    const matched = concepts.filter((concept) => conceptMatchesComponents(concept, components));
    const basenameMatched = matched.filter((concept) => conceptMatchesComponents(concept, basename));
    return { file, components, matched, basenameMatched };
  }).filter((entry) => entry.matched.length > 0)
    .sort((left, right) => right.matched.length - left.matched.length
      || right.basenameMatched.length - left.basenameMatched.length
      || left.file.path.localeCompare(right.file.path));
  pathMatches.forEach(({ file, components, matched }, index) => {
      const evidence = ensureFile(fileEvidence, file.path);
      evidence.score += 1 / (RRF_K + index + 1);
      evidence.reasons.add("path-match");
      for (const concept of matched) {
        for (const term of concept.terms) {
          if (componentMatches(components, term.term, term.stem)) {
            evidence.terms.add(term.term);
          }
        }
      }
    });

  for (const evidence of nodes.values()) {
    const file = ensureFile(fileEvidence, evidence.node.filePath);
    file.nodeIds.add(evidence.node.id);
    file.exact ||= evidence.exact;
    for (const identifier of evidence.exactIdentifiers) file.exactIdentifiers.add(identifier);
    for (const term of evidence.terms) file.terms.add(term);
    for (const reason of evidence.reasons) file.reasons.add(reason);
  }
  for (const evidence of fileEvidence.values()) {
    for (const term of pathTerms) {
      if (searchComponents(evidence.filePath).includes(term)) evidence.terms.add(term);
    }
    for (const hit of evidence.textHits) {
      for (const term of hit.matchedTerms ?? []) evidence.terms.add(term);
      if (hit.rank < 0) evidence.score += Math.min(0.08, Math.abs(hit.rank) / 100);
    }
  }

  const reliablePool = [...nodes.values()]
    .filter((entry) => isReliableLexicalSeed(entry) || isReliableRegionSeed(entry))
    .sort(compareNodeEvidence);
  const reliableSeeds: NodeEvidence[] = [];
  const seededFiles = new Set<string>();
  // Preserve the executable declarations from the best query-bearing source
  // windows before file-diverse/global filling. This is the bounded local
  // second stage that lets `caller in matched region -> semantic callee` beat
  // unrelated helpers from the same large file.
  const callsiteSeedsByRegion = new Map<number, NodeEvidence[]>();
  for (const entry of reliablePool.filter((candidate) => candidate.regionCallsites.size > 0)) {
    const bucket = callsiteSeedsByRegion.get(entry.bestRegionRank) ?? [];
    bucket.push(entry);
    callsiteSeedsByRegion.set(entry.bestRegionRank, bucket);
  }
  const callsiteSeeds = [...callsiteSeedsByRegion.entries()]
    .sort(([left], [right]) => left - right).slice(0, 6)
    .flatMap(([, entries]) => entries.sort((left, right) => left.bestRegionOverlapRank - right.bestRegionOverlapRank
      || compareNodeEvidence(left, right)
      || right.regionCallsites.size - left.regionCallsites.size).slice(0, 2));
  const callbackBridgeSeeds = reliablePool.filter((entry) => entry.regionCallbackCallsites.size > 0)
    .sort((left, right) => left.bestRegionRank - right.bestRegionRank || compareNodeEvidence(left, right))
    .slice(0, 4);
  const semanticPhraseSeeds = semanticPhraseBridges.map((bridge) => bridge.source);
  for (const entry of [...semanticPhraseSeeds, ...fullQueryCallPairSeeds, ...callbackBridgeSeeds, ...callsiteSeeds]) {
    if (reliableSeeds.includes(entry)) continue;
    if (reliableSeeds.length >= 12) break;
    reliableSeeds.push(entry);
    seededFiles.add(entry.node.filePath);
  }
  // A monolithic file can contribute dozens of equally lexical declarations.
  // First reserve one seed per file, then fill a small second pass. This keeps
  // the graph expansion bounded while preventing one central module from
  // hiding a coherent query region in another file.
  for (const entry of reliablePool) {
    if (reliableSeeds.length >= 18) break;
    if (seededFiles.has(entry.node.filePath)) continue;
    seededFiles.add(entry.node.filePath);
    reliableSeeds.push(entry);
  }
  for (const entry of reliablePool) {
    if (reliableSeeds.length >= 24) break;
    if (reliableSeeds.includes(entry)) continue;
    reliableSeeds.push(entry);
  }
  for (const entry of reliableSeeds) {
    entry.reliable = true;
    ensureFile(fileEvidence, entry.node.filePath).reliableGraph = true;
  }
  const queue = reliableSeeds.map((entry) => ({
    entry,
    depth: 0,
    allowTypedExpansion: isReliableLexicalSeed(entry) || fullQueryCallPairSeedIds.has(entry.node.id),
  }));
  const visited = new Set(queue.map(({ entry }) => entry.node.id));
  for (let cursor = 0; cursor < queue.length && cursor < 180; cursor++) {
    const current = queue[cursor]!;
    if (current.depth >= 2) continue;
    const currentHits = fileEvidence.get(current.entry.node.filePath)?.textHits ?? [];
    const neighbors = reliableNeighbors(access, current.entry.node.id)
      .filter((neighbor) => current.allowTypedExpansion
        || queryCallsiteHit(current.entry.node.id, neighbor.edge, current.entry.regionHits));
    for (const neighbor of neighbors
      .sort((left, right) => compareQueryNeighbor(
        current.entry.node.id, left, right, currentHits, queryTerms,
      )).slice(0, 18)) {
      const evidence = ensureNode(nodes, neighbor.node);
      evidence.reliable = true;
      evidence.graph = Math.max(evidence.graph, (2 - current.depth) * 0.08 * (neighbor.edge.confidence ?? 1));
      evidence.reasons.add(`graph:${neighbor.edge.kind}`);
      let propagatedCallsite = 0;
      let propagatedCallsiteWeight = 0;
      if (queryCallsiteHit(current.entry.node.id, neighbor.edge, current.entry.regionHits)) {
        // A compiler-resolved call made inside a query-bearing region is much
        // stronger than a coincidental name/body match. Carry that evidence to
        // the callee so its file can compete with broad utility modules.
        propagatedCallsite = Math.min(2, regionStrength(current.entry) + 1);
        propagatedCallsiteWeight = queryCallsiteWeight(neighbor.edge, current.entry.regionHits, concepts);
        const callsiteKey = edgeKey(neighbor.edge);
        current.entry.regionCallsites.add(callsiteKey);
        queryRegionCallsiteRanks.set(callsiteKey, Math.min(
          queryRegionCallsiteRanks.get(callsiteKey) ?? current.entry.bestRegionRank,
          current.entry.bestRegionRank,
        ));
        queryRegionCallsiteWeights.set(callsiteKey, Math.max(
          queryRegionCallsiteWeights.get(callsiteKey) ?? 0,
          propagatedCallsiteWeight,
        ));
        evidence.region = Math.max(evidence.region, propagatedCallsite);
        evidence.bestCallsiteRank = Math.min(evidence.bestCallsiteRank, current.entry.bestRegionRank);
        evidence.reasons.add("source-region:callsite");
        if (neighbor.edge.kind === "contains" && isUnnamedFlowNode(neighbor.node)) {
          // Preserve the matched source window across the one permitted
          // anonymous callback bridge. The callback's compiler-resolved call
          // can then reach its real callee without pretending the enclosing
          // declaration called it directly.
          for (const hit of current.entry.regionHits) {
            if (!evidence.regionHits.some((candidate) => candidate.filePath === hit.filePath
              && candidate.startLine === hit.startLine && candidate.endLine === hit.endLine)) {
              evidence.regionHits.push(hit);
            }
          }
          evidence.bestRegionRank = Math.min(evidence.bestRegionRank, current.entry.bestRegionRank);
          evidence.bestRegionOverlapRank = Math.min(
            evidence.bestRegionOverlapRank, current.entry.bestRegionOverlapRank,
          );
        }
      }
      for (const term of queryTerms) if (nodeContains(neighbor.node, term.term, term.stem)) evidence.terms.add(term.term);
      const nameComponents = new Set(searchComponents(neighbor.node.name));
      for (const term of queryTerms) {
        if (componentMatches(nameComponents, term.term, term.stem)) evidence.nameTerms.add(term.term);
      }
      const file = ensureFile(fileEvidence, neighbor.node.filePath);
      file.reliableGraph = true;
      file.callsiteRegion = Math.max(file.callsiteRegion, propagatedCallsite);
      file.callsiteQueryWeight = Math.max(file.callsiteQueryWeight, propagatedCallsiteWeight);
      if (propagatedCallsite > 0) {
        file.bestCallsiteRank = Math.min(file.bestCallsiteRank, current.entry.bestRegionRank);
      }
      file.nodeIds.add(neighbor.node.id);
      file.reasons.add(`graph:${neighbor.edge.kind}`);
      if (!visited.has(neighbor.node.id)) {
        visited.add(neighbor.node.id);
        queue.push({
          entry: evidence,
          depth: current.depth + 1,
          allowTypedExpansion: current.allowTypedExpansion
            || propagatedCallsite > 0
            || isReliableLexicalSeed(evidence),
        });
      }
    }
  }

  // Aggregate only the strongest few node/chunk signals per file. Summing every
  // match makes large central files win merely because they declare more nodes.
  const nodeScores = new Map<string, number[]>();
  for (const evidence of nodes.values()) {
    const file = ensureFile(fileEvidence, evidence.node.filePath);
    file.nodeIds.add(evidence.node.id);
    file.exact ||= evidence.exact;
    for (const identifier of evidence.exactIdentifiers) file.exactIdentifiers.add(identifier);
    for (const term of evidence.terms) file.terms.add(term);
    for (const reason of evidence.reasons) file.reasons.add(reason);
    const scores = nodeScores.get(evidence.node.filePath) ?? [];
    scores.push(evidence.rrf + evidence.graph);
    nodeScores.set(evidence.node.filePath, scores);
  }

  const fileCount = Math.max(1, fileEvidence.size);
  const documentFrequency = new Map<string, number>();
  for (const concept of concepts) {
    documentFrequency.set(
      concept.key,
      [...fileEvidence.values()].filter((file) => conceptMatchesTerms(concept, file.terms)).length,
    );
  }
  const totalIdf = concepts.reduce(
    (sum, concept) => sum + concept.weight * idf(fileCount, documentFrequency.get(concept.key) ?? 0), 0,
  ) || 1;
  for (const file of fileEvidence.values()) {
    const strongestNodes = (nodeScores.get(file.filePath) ?? []).sort((left, right) => right - left);
    file.score += (strongestNodes[0] ?? 0) + (strongestNodes[1] ?? 0) * 0.45 + (strongestNodes[2] ?? 0) * 0.2;
    const strongestChunks = file.textHits.map((hit) => Math.abs(hit.rank)).sort((left, right) => right - left);
    file.score += (strongestChunks[0] ?? 0) + (strongestChunks[1] ?? 0) * 0.35;
    if (Number.isFinite(file.bestTextRank)) {
      file.score += SOURCE_FILE_RRF_WEIGHT / (RRF_K + file.bestTextRank + 1);
    }
    const covered = concepts.reduce(
      (sum, concept) => sum + (conceptMatchesTerms(concept, file.terms)
        ? concept.weight * idf(fileCount, documentFrequency.get(concept.key) ?? 0) : 0), 0,
    );
    const coveredCount = concepts.filter((concept) => conceptMatchesTerms(concept, file.terms)).length;
    // Corpus-wide coverage is supporting evidence. A single source region
    // where several independent query concepts co-occur is substantially more
    // useful than the same words scattered through a large central file.
    file.score += (covered / totalIdf) * 0.4 + Math.max(0, coveredCount - 1) * 0.015;
    const pathComponents = new Set(searchComponents(file.filePath));
    const basenameComponents = new Set(searchComponents(file.filePath.split("/").at(-1) ?? file.filePath));
    const adjacentPathMatches = adjacentPairs.filter(([left, right]) => pathComponents.has(left) && pathComponents.has(right)).length;
    const bestLocalConcepts = file.textHits.reduce((best, hit) => {
      const matchedTerms = new Set(hit.matchedTerms ?? []);
      const matched = concepts.filter((concept) => conceptMatchesTerms(concept, matchedTerms));
      const weight = matched.reduce(
        (sum, concept) => sum + concept.weight * idf(fileCount, documentFrequency.get(concept.key) ?? 0), 0,
      );
      return weight > best.weight ? { weight, count: matched.length } : best;
    }, { weight: 0, count: 0 });
    const bestIdentifierCoverage = [...nodes.values()]
      .filter((entry) => entry.node.filePath === file.filePath)
      .reduce((best, entry) => {
        const components = new Set(searchComponents(entry.node.name));
        const matches = queryTerms.filter((term) => componentMatches(components, term.term, term.stem)).length;
        return Math.max(best, matches);
      }, 0);
    const pathSignal = componentIdfSignal(pathComponents, concepts, fileCount, documentFrequency);
    const basenameSignal = componentIdfSignal(basenameComponents, concepts, fileCount, documentFrequency);
    file.score += adjacentPathMatches * 0.45
      + pathSignal * 0.08
      + basenameSignal * 0.18
      + (bestLocalConcepts.weight / totalIdf) * 2
      + Math.max(0, bestLocalConcepts.count - 1) * 0.2
      + Math.max(0, bestIdentifierCoverage - 1) * 0.2;
    // Direct text/declaration alignment and a compiler-proven callsite are
    // independent retrieval channels. Preserve both instead of collapsing
    // them with max(); their corroboration is what promotes a semantic callee
    // over an unrelated broad utility file.
    file.score += file.region * 1.4 + file.callsiteRegion * 0.7;
    if (file.exact) file.score += 0.25;
    if (!plan.asksForTests && isLowValueGraphPath(file.filePath)) file.score *= 0.55;
  }

  const allRankedFiles = [...fileEvidence.values()]
    .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));
  const selectedFiles = new Map<string, FileEvidence>();
  // Pin one best file per explicitly named symbol. Ambiguous symbols should not
  // consume the entire file budget by pinning every same-named declaration.
  for (const identifier of plan.explicitIdentifiers) {
    const best = allRankedFiles.find((file) => file.exactIdentifiers.has(identifier));
    if (best && selectedFiles.size < maxFiles) selectedFiles.set(best.filePath, best);
  }
  // Preserve the bounded cross-file phrase destinations after explicit symbol
  // pins and before aggregate source/file scoring can spend the remaining
  // budget on several variants of the same lexical interpretation.
  for (const filePath of semanticPhraseTargetPaths) {
    if (selectedFiles.size >= maxFiles) break;
    const file = fileEvidence.get(filePath);
    if (file) selectedFiles.set(filePath, file);
  }
  const sourceReserve = Math.min(3, Math.max(0, maxFiles - 1));
  const hasMultiConceptSource = (file: FileEvidence): boolean => file.textHits.some((hit) => {
    const terms = new Set(hit.matchedTerms ?? []);
    return concepts.filter((concept) => conceptMatchesTerms(concept, terms)).length >= 2;
  });
  const stronglyQualifiedSourcePaths = new Set([...fileEvidence.values()]
    .filter((file) => file.region >= 0.55 || hasMultiConceptSource(file))
    .map((file) => file.filePath));
  // A source-channel quota may diversify otherwise node-heavy retrieval, but
  // it must not displace independently strong graph evidence. Rank those
  // protected slots by the best trustworthy declaration in each file rather
  // than the file's aggregate score: a rare compound name is stronger intent
  // evidence than many common words scattered through a central module. Pure
  // propagated callsite targets are deliberately excluded here; flow ranking
  // must still prove and promote those relationships below.
  const strongGraphByFile = new Map<string, {
    entry: NodeEvidence;
    exactPinned: boolean;
    nameConceptScore: number;
    nameConceptCount: number;
  }>();
  for (const entry of nodes.values()) {
    if (!isReliableLexicalSeed(entry) && !isReliableRegionSeed(entry)) continue;
    const nameComponents = new Set(searchComponents(entry.node.name));
    const matchedConcepts = concepts.filter((concept) => conceptMatchesComponents(concept, nameComponents));
    // Exact search can return several same-named declarations, but only the
    // best file was pinned above. Do not let every duplicate exact result
    // bypass the multi-concept requirement and consume the remaining strong
    // graph slots.
    const exactPinned = entry.exact && selectedFiles.has(entry.node.filePath);
    if (!exactPinned && matchedConcepts.length < 2) continue;
    const nameConceptScore = matchedConcepts.reduce((score, concept) =>
      score + concept.weight * idf(fileCount, documentFrequency.get(concept.key) ?? 0), 0);
    const candidate = {
      entry,
      exactPinned,
      nameConceptScore,
      nameConceptCount: matchedConcepts.length,
    };
    const current = strongGraphByFile.get(entry.node.filePath);
    if (!current
      || Number(candidate.exactPinned) > Number(current.exactPinned)
      || (candidate.exactPinned === current.exactPinned
        && candidate.nameConceptScore > current.nameConceptScore)
      || (candidate.exactPinned === current.exactPinned
        && candidate.nameConceptScore === current.nameConceptScore
        && candidate.nameConceptCount > current.nameConceptCount)
      || (candidate.exactPinned === current.exactPinned
        && candidate.nameConceptScore === current.nameConceptScore
        && candidate.nameConceptCount === current.nameConceptCount
        && compareNodeEvidence(candidate.entry, current.entry) < 0)) {
      strongGraphByFile.set(entry.node.filePath, candidate);
    }
  }
  const strongGraphFiles = [...strongGraphByFile.values()].sort((left, right) =>
    Number(right.exactPinned) - Number(left.exactPinned)
    || right.nameConceptScore - left.nameConceptScore
    || right.nameConceptCount - left.nameConceptCount
    || compareNodeEvidence(left.entry, right.entry)
    || (fileEvidence.get(right.entry.node.filePath)?.score ?? 0)
      - (fileEvidence.get(left.entry.node.filePath)?.score ?? 0)
    || left.entry.node.filePath.localeCompare(right.entry.node.filePath));
  // Source chunks are an independent retrieval channel, not just a small
  // additive feature on node-heavy files. Reserve only evidence that is
  // declaration-aligned, co-locates multiple query concepts, or remains close
  // to the ordinary fused cutoff. This keeps the channel independent without
  // allowing arbitrarily weak text hits to evict trustworthy graph files.
  const cutoffIndex = Math.min(maxFiles, allRankedFiles.length) - 1;
  const fusedCutoff = cutoffIndex >= 0 ? allRankedFiles[cutoffIndex]!.score : 0;
  const eligibleSourcePaths = new Set([...fileEvidence.values()]
    .filter((file) => {
      const declarationAligned = file.region >= 0.55;
      const multiConcept = hasMultiConceptSource(file);
      const nearCutoff = fusedCutoff > 0 && file.score >= fusedCutoff * SOURCE_NEAR_CUTOFF_RATIO;
      return declarationAligned || multiConcept || nearCutoff;
    })
    .map((file) => file.filePath));
  // Direct-source candidates are defined only by actual FTS hits, ordered
  // independently of compiler-propagated callsites. Repeated windows from one
  // file count once. A separate bounded semantic slot below preserves the best
  // proven callsite target without letting several such targets consume the
  // whole source floor.
  const directSourceCandidates = [...new Set(textHits.map((hit) => hit.filePath))]
    .filter((filePath) => eligibleSourcePaths.has(filePath) && stronglyQualifiedSourcePaths.has(filePath))
    .sort((left, right) => {
      const leftLow = !plan.asksForTests && isLowValueGraphPath(left);
      const rightLow = !plan.asksForTests && isLowValueGraphPath(right);
      return Number(leftLow) - Number(rightLow)
        || (fileEvidence.get(left)?.bestTextRank ?? Number.POSITIVE_INFINITY)
          - (fileEvidence.get(right)?.bestTextRank ?? Number.POSITIVE_INFINITY)
        || (fileEvidence.get(right)?.region ?? 0) - (fileEvidence.get(left)?.region ?? 0)
        || (fileEvidence.get(right)?.score ?? 0) - (fileEvidence.get(left)?.score ?? 0)
        || left.localeCompare(right);
    });
  const semanticCallsiteCandidates = [...fileEvidence.values()]
    .filter((file) => file.callsiteRegion > 0
      && file.callsiteQueryWeight > 0
      && Number.isFinite(file.bestCallsiteRank))
    .sort((left, right) => {
      const leftLow = !plan.asksForTests && isLowValueGraphPath(left.filePath);
      const rightLow = !plan.asksForTests && isLowValueGraphPath(right.filePath);
      return Number(leftLow) - Number(rightLow)
        || right.callsiteQueryWeight - left.callsiteQueryWeight
        || left.bestCallsiteRank - right.bestCallsiteRank
        || right.callsiteRegion - left.callsiteRegion
        || right.score - left.score
        || left.filePath.localeCompare(right.filePath);
    });
  const semanticWinner = semanticCallsiteCandidates[0];
  let sourceFloor: string[];
  if (sourceReserve === 0) {
    sourceFloor = [];
  } else if (!semanticWinner) {
    sourceFloor = directSourceCandidates.slice(0, sourceReserve);
  } else if (sourceReserve === 1) {
    const directWinner = directSourceCandidates[0];
    sourceFloor = !directWinner || directWinner === semanticWinner.filePath
      ? [semanticWinner.filePath]
      : [directWinner, semanticWinner.filePath].sort((left, right) =>
        (fileEvidence.get(right)?.score ?? 0) - (fileEvidence.get(left)?.score ?? 0)
        || left.localeCompare(right)).slice(0, 1);
  } else {
    sourceFloor = [
      semanticWinner.filePath,
      ...directSourceCandidates.filter((filePath) => filePath !== semanticWinner.filePath)
        .slice(0, Math.max(0, sourceReserve - 1)),
    ];
  }
  const sourceFloorPaths = new Set(sourceFloor);
  const unrepresentedSourceFiles = sourceFloor
    .filter((filePath) => !selectedFiles.has(filePath)).length;
  // Exact pins remain protected. Reserve the slots still needed by the source
  // floor, then spend the bounded graph capacity on the strongest declaration
  // names. Proven flow targets may still replace a weaker file below.
  const strongGraphLimit = Math.max(
    selectedFiles.size,
    maxFiles - Math.min(unrepresentedSourceFiles, Math.max(0, maxFiles - selectedFiles.size)),
  );
  for (const strong of strongGraphFiles) {
    if (selectedFiles.size >= strongGraphLimit) break;
    const file = fileEvidence.get(strong.entry.node.filePath);
    if (file) selectedFiles.set(file.filePath, file);
  }
  let representedSourceFiles = [...selectedFiles.keys()]
    .filter((filePath) => sourceFloorPaths.has(filePath)).length;
  for (const filePath of sourceFloor) {
    if (representedSourceFiles >= sourceFloor.length || selectedFiles.size >= maxFiles) break;
    const file = fileEvidence.get(filePath);
    if (!file) continue;
    if (selectedFiles.has(filePath)) continue;
    selectedFiles.set(filePath, file);
    representedSourceFiles++;
  }
  for (const file of allRankedFiles) {
    if (selectedFiles.size >= maxFiles) break;
    selectedFiles.set(file.filePath, file);
  }
  let rankedFiles = [...selectedFiles.values()]
    .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));
  const selectedPaths = new Set(rankedFiles.map((file) => file.filePath));
  const rankedNodes = [...nodes.values()]
    .filter((entry) => selectedPaths.has(entry.node.filePath) && hasTrustworthyCandidateEvidence(entry))
    .sort(compareNodeEvidence);
  const picked = new Map<string, NodeEvidence>();
  for (const identifier of plan.explicitIdentifiers) {
    const entry = rankedNodes.find((candidate) => candidate.exactIdentifiers.has(identifier));
    if (entry && picked.size < maxNodes) picked.set(entry.node.id, entry);
  }
  for (const entry of fullQueryCallPairSeeds) {
    if (picked.size >= maxNodes) break;
    if (!selectedPaths.has(entry.node.filePath)) continue;
    picked.set(entry.node.id, entry);
  }
  // Whole-task BM25 is an independent declaration channel. Preserve exactly
  // one of its trustworthy production declarations before source-window and
  // callsite evidence fill the bounded candidate set. Without this reserve, a
  // nearby chunk can move ahead after an unrelated source edit and evict the
  // declaration that still ranks first for the complete request.
  const fullQueryDeclaration = bestFullQueryDeclaration(rankedNodes, concepts);
  if (fullQueryDeclaration && (picked.has(fullQueryDeclaration.node.id) || picked.size < maxNodes)) {
    picked.set(fullQueryDeclaration.node.id, fullQueryDeclaration);
  }
  // Preserve declarations for distinct strong responsibilities before a
  // single source window spends the per-file allowance on nearby helpers.
  for (const entry of bestStrongIntentFacetDeclarations(
    rankedNodes, concepts, access, MAX_STRONG_INTENT_FACET_DECLARATIONS,
  )) {
    if (picked.size >= maxNodes) break;
    picked.set(entry.node.id, entry);
  }
  // Source FTS is an independent declaration channel. Reserve the declaration
  // that the store aligned first to each selected file's best chunk before
  // aggregate graph/lexical strength can fill that file's representation.
  for (const file of rankedFiles) {
    if (picked.size >= maxNodes) break;
    const aligned = bestSourceAlignedDeclaration(
      rankedNodes.filter((candidate) => candidate.node.filePath === file.filePath),
    );
    if (aligned) picked.set(aligned.node.id, aligned);
  }
  // Guarantee bounded representation for each cohesive file before filling
  // globally. A reserved source declaration counts toward the existing
  // three-entry per-file allowance rather than expanding it.
  for (const file of rankedFiles) {
    let represented = [...picked.values()].filter((entry) => entry.node.filePath === file.filePath).length;
    for (const entry of rankedNodes.filter((candidate) => candidate.node.filePath === file.filePath)) {
      if (represented >= 3) break;
      if (picked.size >= maxNodes) break;
      if (picked.has(entry.node.id)) continue;
      picked.set(entry.node.id, entry);
      represented++;
    }
  }
  for (const entry of rankedNodes) {
    if (picked.size >= maxNodes) break;
    picked.set(entry.node.id, entry);
  }

  const pickedIds = new Set(picked.keys());
  const reliablePicked = [...picked.values()].filter((entry) => entry.reliable);
  const flowSeedRelevance = new Map([...nodes.values()].map((entry) => [
    entry.node.id,
    (entry.exact ? 6 : 0) + queryTerms.reduce((score, term) => score + (entry.nameTerms.has(term.term)
      ? term.weight * idf(fileCount, documentFrequency.get(term.term) ?? 0) * (term.stem ? 1 : 4) : 0), 0)
      + entry.terms.size * 0.1 + entry.rrf + regionStrength(entry) * 2,
  ]));
  const flowFilePriority = new Map(rankedFiles.map((file, index) => [file.filePath, rankedFiles.length - index]));
  const flowNodeTerms = new Map([...nodes.values()].map((entry) => [entry.node.id, new Set(entry.terms)]));
  const flowTermWeights = new Map(queryTerms.map((term) => [
    term.term, term.weight * idf(fileCount, documentFrequency.get(term.term) ?? 0),
  ]));
  const relevanceForFlowSeed = (node: GraphNode): number => {
    const known = flowSeedRelevance.get(node.id);
    if (known !== undefined) return known;
    const components = new Set(searchComponents(node.name));
    return queryTerms.reduce((score, term) => score + (componentMatches(components, term.term, term.stem)
      ? term.weight * idf(fileCount, documentFrequency.get(term.term) ?? 0) * (term.stem ? 1 : 4)
      : 0), 0);
  };

  // Returned reliable declarations stay protected. Also restore the bounded
  // query-region/callback seeds retained during relevance expansion: candidate
  // quotas are an output concern and must not erase a proven callsite merely
  // because its declaration ranked fourth within a selected file.
  const pickedFlowEntries = [...reliablePicked].sort(compareNodeEvidence).slice(0, MAX_FLOW_SEEDS);
  const pickedFlowIds = new Set(pickedFlowEntries.map((entry) => entry.node.id));
  const semanticPhraseFlowEntries = semanticPhraseBridges.map((bridge) => bridge.source)
    .filter((entry) => !pickedFlowIds.has(entry.node.id))
    .slice(0, MAX_FLOW_SEEDS - pickedFlowEntries.length);
  const semanticPhraseFlowIds = new Set(semanticPhraseFlowEntries.map((entry) => entry.node.id));
  // Whole-query pairs have their exact direct edge (and, when proven, callback
  // completion) reserved separately. Do not spend ordinary traversal slots on
  // pair-only entries; pair endpoints with independent picked evidence remain
  // ordinary seeds through `pickedFlowEntries`.
  const provenanceFlowEntries = [...reliableSeeds]
    .filter((entry) => !pickedFlowIds.has(entry.node.id)
      && !semanticPhraseFlowIds.has(entry.node.id)
      && (entry.regionCallsites.size > 0 || entry.regionCallbackCallsites.size > 0))
    .sort(compareProvenanceFlowSeed)
    .slice(0, MAX_FLOW_SEEDS - pickedFlowEntries.length - semanticPhraseFlowEntries.length);
  const directFlowEntries = [
    ...semanticPhraseFlowEntries, ...provenanceFlowEntries, ...pickedFlowEntries,
  ];
  const flowSeeds = new Map<string, GraphNode>(directFlowEntries.map((entry) => [entry.node.id, entry.node]));
  const flowSeedCallsiteRanks = new Map<string, number>();
  for (const entry of directFlowEntries) {
    if (entry.regionCallsites.size > 0 && Number.isFinite(entry.bestRegionRank)) {
      flowSeedCallsiteRanks.set(entry.node.id, entry.bestRegionRank);
    }
  }
  const derivedSeeds = new Map<string, DerivedFlowSeed>();
  const rememberDerivedSeed = (candidate: DerivedFlowSeed): void => {
    if (flowSeeds.has(candidate.node.id)) return;
    const prior = derivedSeeds.get(candidate.node.id);
    if (!prior || compareDerivedFlowSeed(candidate, prior) < 0) derivedSeeds.set(candidate.node.id, candidate);
  };
  const remainingSeedSlots = MAX_FLOW_SEEDS - flowSeeds.size;
  if (remainingSeedSlots > 0) {
    for (const entry of directFlowEntries) {
      for (const incoming of access.getIncoming(entry.node.id, FLOW_EDGE_KINDS)) {
        if ((incoming.edge.confidence ?? 1) < 0.8) continue;
        rememberDerivedSeed({
          node: incoming.node,
          relevance: relevanceForFlowSeed(incoming.node),
          callsiteRank: queryRegionCallsiteRanks.get(edgeKey(incoming.edge)) ?? Number.POSITIVE_INFINITY,
          confidence: incoming.edge.confidence ?? 1,
        });
      }
    }

    // Calls made inside a returned/nested callback are owned by the enclosing
    // named declaration. Inspect owners only for the bounded best callback
    // callers; fan-in therefore cannot create unbounded adjacency queries.
    const ownerCandidates = [...derivedSeeds.values()].sort(compareDerivedFlowSeed)
      .filter((candidate) => isUnnamedFlowNode(candidate.node)).slice(0, remainingSeedSlots);
    for (const callback of ownerCandidates) {
      for (const owner of access.getIncoming(callback.node.id, ["contains"])) {
        if ((owner.edge.confidence ?? 1) < 0.8) continue;
        rememberDerivedSeed({
          node: owner.node,
          relevance: relevanceForFlowSeed(owner.node),
          callsiteRank: callback.callsiteRank,
          confidence: Math.min(callback.confidence, owner.edge.confidence ?? 1),
        });
      }
    }
    for (const candidate of [...derivedSeeds.values()].sort(compareDerivedFlowSeed).slice(0, remainingSeedSlots)) {
      flowSeeds.set(candidate.node.id, candidate.node);
      flowSeedRelevance.set(candidate.node.id, candidate.relevance);
      flowSeedCallsiteRanks.set(candidate.node.id, candidate.callsiteRank);
      const terms = new Set<string>();
      for (const term of queryTerms) {
        if (nodeContains(candidate.node, term.term, term.stem)) terms.add(term.term);
      }
      flowNodeTerms.set(candidate.node.id, terms);
    }
  }
  const traversedFlows = buildDirectedFlows(
    access, [...flowSeeds.values()], pickedIds, 8, flowSeedRelevance, flowFilePriority,
    flowNodeTerms, flowTermWeights, queryRegionCallsiteRanks, queryRegionCallsiteWeights,
    flowSeedCallsiteRanks, fullQueryCallPairs,
  );
  // These edges already passed stricter evidence than ordinary flow seeds:
  // both endpoints independently match one adjacent query phrase and the
  // compiler proves the cross-file relationship. Emit them first, then spend
  // the remaining global eight-step budget on normal directed traversal.
  const flows: ScopeFlow[] = [];
  const seenFlowKeys = new Set<string>();
  let remainingFlowSteps = 8;
  for (const flow of [
    ...semanticPhraseBridges.map((bridge) => ({ steps: [bridge.edge] })),
    ...traversedFlows,
  ]) {
    const key = flowKey(flow);
    if (seenFlowKeys.has(key) || flow.steps.length > remainingFlowSteps) continue;
    seenFlowKeys.add(key);
    flows.push(flow);
    remainingFlowSteps -= flow.steps.length;
    if (remainingFlowSteps === 0) break;
  }
  // Flow construction is independent of the lexical file budget. Reserve slots
  // for the best returned spine after traversal, evicting only lower-ranked
  // non-pinned/non-spine files. This makes an otherwise invisible bridge file
  // available to source planning without ever exceeding maxFiles.
  const pinnedPaths = new Set([...selectedFiles.values()]
    .filter((file) => file.exactIdentifiers.size > 0).map((file) => file.filePath));
  for (const filePath of sourceFloorPaths) pinnedPaths.add(filePath);
  for (const filePath of semanticPhraseTargetPaths) {
    if (selectedFiles.has(filePath)) pinnedPaths.add(filePath);
  }
  // Preserve independently strong compound declarations through flow-spine
  // promotion: `SmartRouter` should not be evicted by an incidental router
  // call. Only declaration-name/IDF evidence is protected here; ordinary
  // source/callsite files remain replaceable by a proven cross-file subsystem
  // such as module resolution.
  for (const strong of strongGraphFiles) {
    const kind = strong.entry.node.kind;
    const architecturalType = kind === "class" || kind === "struct" || kind === "trait"
      || kind === "component" || kind === "interface" || kind === "protocol";
    if (architecturalType && selectedFiles.has(strong.entry.node.filePath)) {
      pinnedPaths.add(strong.entry.node.filePath);
    }
  }
  const protectedFlowPaths = new Set<string>();
  const flowNodeIds = new Set<string>();
  const primaryFlowNodeIds = new Set((flows[0]?.steps ?? []).flatMap((edge) => [edge.source, edge.target]));
  for (const id of flows.flatMap((flow) => flow.steps).flatMap((edge) => [edge.source, edge.target])) {
    if (flowNodeIds.has(id)) continue;
    flowNodeIds.add(id);
    const node = access.getNode(id);
    if (!node) continue;
    const file = ensureFile(fileEvidence, node.filePath);
    file.nodeIds.add(node.id);
    file.reliableGraph = true;
    file.reasons.add("flow-spine");
    // Every returned flow remains available to candidate/source ordering when
    // its file is already selected. Only the best cohesive flow may displace a
    // lexical file; otherwise several small secondary flows can evict the
    // actual query region under a tight max-files budget.
    if (!primaryFlowNodeIds.has(id)) continue;
    if (selectedFiles.has(file.filePath)) {
      protectedFlowPaths.add(file.filePath);
      continue;
    }
    if (selectedFiles.size >= maxFiles) {
      const eviction = [...selectedFiles.values()]
        .filter((candidate) => !pinnedPaths.has(candidate.filePath)
          && !protectedFlowPaths.has(candidate.filePath))
        .sort((left, right) => left.score - right.score || right.filePath.localeCompare(left.filePath))[0];
      if (!eviction) continue;
      selectedFiles.delete(eviction.filePath);
    }
    selectedFiles.set(file.filePath, file);
    protectedFlowPaths.add(file.filePath);
  }
  rankedFiles = [...selectedFiles.values()]
    .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));
  // Flow-spine promotion can replace an initially selected lexical file. Build
  // the returned candidate set against the FINAL bounded file set so a
  // promoted file exposes its strongest direct/callsite declaration instead
  // of carrying only an unrelated bridge node while stale candidates from the
  // evicted file consume the node budget.
  const finalSelectedPaths = new Set(rankedFiles.map((file) => file.filePath));
  const finalRankedNodes = [...nodes.values()]
    .filter((entry) => finalSelectedPaths.has(entry.node.filePath) && hasTrustworthyCandidateEvidence(entry))
    .sort(compareNodeEvidence);
  const finalPicked = new Map<string, NodeEvidence>();
  for (const identifier of plan.explicitIdentifiers) {
    const entry = finalRankedNodes.find((candidate) => candidate.exactIdentifiers.has(identifier));
    if (entry && finalPicked.size < maxNodes) finalPicked.set(entry.node.id, entry);
  }
  for (const entry of fullQueryCallPairSeeds) {
    if (finalPicked.size >= maxNodes) break;
    if (!finalSelectedPaths.has(entry.node.filePath)) continue;
    finalPicked.set(entry.node.id, entry);
  }
  const finalFullQueryDeclaration = bestFullQueryDeclaration(finalRankedNodes, concepts);
  if (finalFullQueryDeclaration
    && (finalPicked.has(finalFullQueryDeclaration.node.id) || finalPicked.size < maxNodes)) {
    finalPicked.set(finalFullQueryDeclaration.node.id, finalFullQueryDeclaration);
  }
  for (const entry of bestStrongIntentFacetDeclarations(
    finalRankedNodes, concepts, access, MAX_STRONG_INTENT_FACET_DECLARATIONS,
  )) {
    if (finalPicked.size >= maxNodes) break;
    finalPicked.set(entry.node.id, entry);
  }
  const finalEntriesByFile = new Map(rankedFiles.map((file) => [
    file.filePath,
    finalRankedNodes.filter((candidate) => candidate.node.filePath === file.filePath),
  ]));
  for (const file of rankedFiles) {
    if (finalPicked.size >= maxNodes) break;
    const aligned = bestSourceAlignedDeclaration(finalEntriesByFile.get(file.filePath) ?? []);
    if (aligned) finalPicked.set(aligned.node.id, aligned);
  }
  for (const file of rankedFiles) {
    const fileEntries = finalEntriesByFile.get(file.filePath) ?? [];
    const direct = fileEntries.filter((candidate) => candidate.regionHits.length > 0)
      .sort((left, right) => directRegionStrength(right) - directRegionStrength(left)
        || compareNodeEvidence(left, right));
    const callsite = fileEntries.filter((candidate) => Number.isFinite(candidate.bestCallsiteRank))
      .sort((left, right) => left.bestCallsiteRank - right.bestCallsiteRank
        || compareNodeEvidence(left, right));
    const representatives: NodeEvidence[] = [];
    if (direct[0]) representatives.push(direct[0]);
    for (const entry of callsite.slice(0, 2)) {
      if (!representatives.includes(entry)) representatives.push(entry);
    }
    for (const entry of fileEntries) {
      if (representatives.length >= 4) break;
      if (!representatives.includes(entry)) representatives.push(entry);
    }
    let represented = [...finalPicked.values()].filter((entry) => entry.node.filePath === file.filePath).length;
    for (const entry of representatives) {
      if (represented >= 4) break;
      if (finalPicked.size >= maxNodes) break;
      if (finalPicked.has(entry.node.id)) continue;
      finalPicked.set(entry.node.id, entry);
      represented++;
    }
  }
  for (const entry of finalRankedNodes) {
    if (finalPicked.size >= maxNodes) break;
    finalPicked.set(entry.node.id, entry);
  }
  const finalPickedIds = new Set(finalPicked.keys());
  const coveredTerms = literalTerms(plan).filter((term) => rankedFiles.some((file) => file.terms.has(term))).sort();
  const files: RankedScopeFile[] = rankedFiles.map((file) => {
    const info = fileInfo.get(file.filePath);
    const candidateRank = new Map([...finalPicked.keys()].map((id, index) => [id, index]));
    const flowRank = new Map([...flowNodeIds].map((id, index) => [id, index]));
    const nodeIds = [...file.nodeIds].filter((id) => finalPickedIds.has(id) || flowNodeIds.has(id))
      .sort((left, right) => (candidateRank.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (candidateRank.get(right) ?? Number.MAX_SAFE_INTEGER)
        || (flowRank.get(left) ?? Number.MAX_SAFE_INTEGER) - (flowRank.get(right) ?? Number.MAX_SAFE_INTEGER)
        || left.localeCompare(right));
    return {
      filePath: file.filePath,
      score: Number(file.score.toFixed(6)),
      reasons: [...file.reasons].sort(),
      nodeIds,
      textHits: dedupeChunkHits(file.textHits),
      textOnly: nodeIds.length === 0 || !file.reliableGraph || info?.parseStatus !== "ok",
      parseStatus: info?.parseStatus ?? "failed",
    };
  });
  const candidates = [...finalPicked.values()].map((entry) => ({
    id: entry.node.id,
    score: Number((entry.rrf + entry.graph + regionStrength(entry) + (entry.exact ? 2 : 0)).toFixed(6)),
    reasons: [...entry.reasons].sort(),
    category: (isLowValueGraphPath(entry.node.filePath) ? "test" : entry.graph > entry.rrf ? "neighbor" : "direct") as SelectionCategory,
  }));
  const evidenceStrength = files.length === 0 ? "none"
    : files.some((file) => file.reasons.some((reason) => reason.startsWith("exact:")))
      || coveredTerms.length >= Math.min(3, pathTerms.length) ? "strong"
      : coveredTerms.length > 0 ? "moderate" : "weak";
  return { candidates, files, flows, matchedCount: nodes.size, coveredTerms, evidenceStrength };
}

/**
 * Preserve destination-file diversity inside the fixed per-node branch cap.
 * A query-bearing compiler routine can call many helpers; taking the first
 * eight globally ranked edges may omit an entire subsystem. Reserve one real
 * semantic call per query-region/destination pair (the culminating callsite),
 * then fill the remaining slots from the original relevance order.
 */
function diverseFlowBranches(
  entries: GraphNeighbor[],
  limit: number,
  callsiteRanks: Map<string, number>,
): GraphNeighbor[] {
  if (entries.length <= limit) return entries;
  const index = new Map(entries.map((entry, position) => [edgeKey(entry.edge), position]));
  const groups = new Map<string, GraphNeighbor[]>();
  for (const entry of entries) {
    const rank = callsiteRanks.get(edgeKey(entry.edge));
    if (rank === undefined || !Number.isFinite(rank)) continue;
    const key = `${rank}\0${entry.node.filePath}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const representatives = [...groups.entries()].flatMap(([key, group]) => {
    const distinctSemanticTargets = new Set(group.flatMap((entry) => (
      entry.edge.kind === "calls" || entry.edge.kind === "instantiates"
        ? [entry.node.id] : []
    ))).size;
    const representative = group.sort((left, right) => {
      const semanticPriority = (entry: GraphNeighbor): number => (
        entry.edge.kind === "calls" || entry.edge.kind === "instantiates" ? 2
          : entry.edge.kind === "references" ? 1 : 0
      );
      return semanticPriority(right) - semanticPriority(left)
        || (right.edge.line ?? -1) - (left.edge.line ?? -1)
        || (left.edge.column ?? Number.MAX_SAFE_INTEGER)
          - (right.edge.column ?? Number.MAX_SAFE_INTEGER)
        || (index.get(edgeKey(left.edge)) ?? Number.MAX_SAFE_INTEGER)
          - (index.get(edgeKey(right.edge)) ?? Number.MAX_SAFE_INTEGER);
    })[0];
    const rank = Number(key.slice(0, key.indexOf("\0")));
    return representative ? [{ representative, rank, distinctSemanticTargets }] : [];
  }).sort((left, right) => left.rank - right.rank
    || right.distinctSemanticTargets - left.distinctSemanticTargets
    || (index.get(edgeKey(left.representative.edge)) ?? Number.MAX_SAFE_INTEGER)
      - (index.get(edgeKey(right.representative.edge)) ?? Number.MAX_SAFE_INTEGER))
    .map(({ representative }) => representative);
  const selected = representatives.slice(0, limit);
  const selectedKeys = new Set(selected.map((entry) => edgeKey(entry.edge)));
  for (const entry of entries) {
    if (selected.length >= limit) break;
    const key = edgeKey(entry.edge);
    if (selectedKeys.has(key)) continue;
    selected.push(entry);
    selectedKeys.add(key);
  }
  return selected;
}

function buildDirectedFlows(
  access: ScopeRequestAccess,
  seeds: GraphNode[],
  selectedIds: Set<string>,
  maxSteps: number,
  seedRelevance = new Map<string, number>(),
  filePriority = new Map<string, number>(),
  nodeTerms = new Map<string, Set<string>>(),
  termWeights = new Map<string, number>(),
  queryRegionCallsiteRanks = new Map<string, number>(),
  queryRegionCallsiteWeights = new Map<string, number>(),
  seedCallsiteRanks = new Map<string, number>(),
  fullQueryCallPairs: FullQueryCallPair[] = [],
): ScopeFlow[] {
  const flows: Array<{
    flow: ScopeFlow;
    startsSelected: boolean;
    startsInTest: boolean;
    selectedEndpoints: number;
    relevantEndpoints: number;
    executionPriority: number;
    endpointRelevance: number;
    endpointFilePriority: number;
    pathRelevance: number;
    terminalRelevance: number;
    terminalNameRelevance: number;
    seedRelevance: number;
    queryCallsiteSteps: number;
    bestQueryCallsiteRank: number;
    bestQueryCallsiteWeight: number;
    terminalPublic: boolean;
    crossesFile: boolean;
    terminalFile: string;
    terminalFileCallsiteCount: number;
    terms: Set<string>;
  }> = [];
  const hopLimit = Math.min(7, maxSteps);
  let remainingWork = FLOW_TRAVERSAL_WORK_BUDGET;
  const endpointNameRelevance = (node: GraphNode): number => {
    const components = new Set(searchComponents(node.name));
    return [...termWeights].reduce((score, [term, weight]) => {
      const singular = term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : undefined;
      return score + (components.has(term) || (singular !== undefined && components.has(singular))
        ? weight : 0);
    }, 0);
  };
  const orderedSeeds = [...seeds].sort((left, right) => {
    const leftCallsite = seedCallsiteRanks.get(left.id) ?? Number.POSITIVE_INFINITY;
    const rightCallsite = seedCallsiteRanks.get(right.id) ?? Number.POSITIVE_INFINITY;
    return Number(Number.isFinite(rightCallsite)) - Number(Number.isFinite(leftCallsite))
      || leftCallsite - rightCallsite
      || (seedRelevance.get(right.id) ?? 0) - (seedRelevance.get(left.id) ?? 0)
      || Number(selectedIds.has(right.id)) - Number(selectedIds.has(left.id))
      || Number(isLowValueGraphPath(left.filePath)) - Number(isLowValueGraphPath(right.filePath))
      || left.id.localeCompare(right.id);
  });
  const queue: Array<{
    seed: GraphNode; node: GraphNode; steps: GraphEdge[]; visited: Set<string>;
    unnamedBridges: number; root: boolean;
  }> = orderedSeeds.map((seed) => ({
    seed, node: seed, steps: [], visited: new Set([seed.id]), unnamedBridges: 0, root: true,
  }));
  let pendingRootQueries = orderedSeeds.length;
  while (queue.length > 0 && remainingWork > 0) {
      const current = queue.shift()!;
      const seed = current.seed;
      if (current.steps.length >= hopLimit) continue;
      if (current.root) pendingRootQueries--;
      // One request-wide budget covers both adjacency lookups and accepted
      // expansions. A large seed set can no longer receive 128 expansions each.
      remainingWork--;
      const outgoing = access.getOutgoing(current.node.id, FLOW_TRAVERSAL_EDGE_KINDS)
        .filter((entry) => (entry.edge.confidence ?? 1) >= 0.8)
        // `contains` is structural rather than executable. It is useful in a
        // displayed flow only to enter one anonymous callback which then makes
        // a real call/reference; named children and data properties are not
        // execution-flow edges.
        .filter((entry) => entry.edge.kind !== "contains" || isUnnamedFlowNode(entry.node))
        // The expansion is deliberately bounded, so lexical/source order alone
        // would permanently hide a relevant call which appears late in a long
        // function. Spend the eight-way branch budget on query-relevant
        // endpoints first, then use the stable structural ordering.
        .sort((left, right) => {
          const leftKey = edgeKey(left.edge);
          const rightKey = edgeKey(right.edge);
          const leftCallsiteRank = queryRegionCallsiteRanks.get(leftKey) ?? Number.POSITIVE_INFINITY;
          const rightCallsiteRank = queryRegionCallsiteRanks.get(rightKey) ?? Number.POSITIVE_INFINITY;
          return Number(Number.isFinite(rightCallsiteRank)) - Number(Number.isFinite(leftCallsiteRank))
            || (queryRegionCallsiteWeights.get(rightKey) ?? 0) - (queryRegionCallsiteWeights.get(leftKey) ?? 0)
            || leftCallsiteRank - rightCallsiteRank
            || Number(selectedIds.has(right.node.id)) - Number(selectedIds.has(left.node.id))
            || Number(right.node.isExported) - Number(left.node.isExported)
            || (seedRelevance.get(right.node.id) ?? 0) - (seedRelevance.get(left.node.id) ?? 0)
            || compareNeighbor(left, right);
        });
      const callsiteTargets = new Map<string, Set<string>>();
      for (const neighbor of outgoing) {
        if (neighbor.edge.kind !== "calls" && neighbor.edge.kind !== "instantiates") continue;
        const rank = queryRegionCallsiteRanks.get(edgeKey(neighbor.edge));
        if (rank === undefined || !Number.isFinite(rank)) continue;
        const key = `${rank}\0${neighbor.node.filePath}`;
        const targets = callsiteTargets.get(key) ?? new Set<string>();
        targets.add(neighbor.node.id);
        callsiteTargets.set(key, targets);
      }
      for (const neighbor of diverseFlowBranches(
        outgoing, FLOW_BRANCH_LIMIT, queryRegionCallsiteRanks,
      )) {
        // Reserve one work unit for every seed root not yet inspected. This
        // makes the global budget fair: an early broad seed cannot prevent a
        // later query-region seed from contributing its direct callsite.
        if (remainingWork <= pendingRootQueries) break;
        if (current.visited.has(neighbor.node.id)) continue;
        const unnamedBridges = current.unnamedBridges + (isUnnamedFlowNode(neighbor.node) ? 1 : 0);
        if (unnamedBridges > 1) continue;
        const steps = [...current.steps, neighbor.edge];
        const visited = new Set(current.visited);
        visited.add(neighbor.node.id);
        remainingWork--;
        const endpointIds = new Set([seed.id, ...steps.flatMap((step) => [step.source, step.target])]);
        const endpointRelevance = [...endpointIds].map((id) => seedRelevance.get(id) ?? 0);
        const startRelevance = seedRelevance.get(seed.id) ?? 0;
        const terminalRelevance = seedRelevance.get(neighbor.node.id) ?? 0;
        const flowTerms = new Set([...endpointIds].flatMap((id) => [...(nodeTerms.get(id) ?? [])]));
        const executionPriority = steps.some((step) => step.kind === "calls" || step.kind === "instantiates") ? 2
          : steps.some((step) => step.kind === "references") ? 1 : 0;
        const queryCallsiteRanks = steps.flatMap((step) => {
          const rank = queryRegionCallsiteRanks.get(edgeKey(step));
          return rank === undefined || !Number.isFinite(rank) ? [] : [rank];
        });
        const queryCallsiteWeights = steps.map((step) => queryRegionCallsiteWeights.get(edgeKey(step)) ?? 0);
        // A bare lexical-containment prefix is not an execution flow. Keep the
        // real edge only once the anonymous callback performs a semantic step.
        if (executionPriority === 0 || neighbor.edge.kind === "contains") {
          if (steps.length < hopLimit) queue.push({
            seed, node: neighbor.node, steps, visited, unnamedBridges, root: false,
          });
          continue;
        }
        flows.push({
          flow: { steps },
          startsSelected: selectedIds.has(seed.id),
          startsInTest: isLowValueGraphPath(seed.filePath),
          seedRelevance: seedRelevance.get(seed.id) ?? 0,
          selectedEndpoints: [...endpointIds].filter((id) => selectedIds.has(id)).length,
          relevantEndpoints: [startRelevance, terminalRelevance]
            .filter((score) => score >= STRONG_FLOW_RELEVANCE).length,
          executionPriority,
          endpointRelevance: startRelevance + terminalRelevance,
          endpointFilePriority: (filePriority.get(seed.filePath) ?? 0)
            + (filePriority.get(neighbor.node.filePath) ?? 0),
          pathRelevance: endpointRelevance.filter((score) => score >= STRONG_FLOW_RELEVANCE)
            .reduce((sum, score) => sum + score, 0),
          terminalRelevance,
          terminalNameRelevance: endpointNameRelevance(neighbor.node),
          queryCallsiteSteps: queryCallsiteRanks.length,
          bestQueryCallsiteRank: Math.min(...queryCallsiteRanks, Number.POSITIVE_INFINITY),
          bestQueryCallsiteWeight: Math.max(...queryCallsiteWeights, 0),
          terminalPublic: neighbor.node.isExported === true,
          crossesFile: seed.filePath !== neighbor.node.filePath,
          terminalFile: neighbor.node.filePath,
          terminalFileCallsiteCount: queryCallsiteRanks.length === 0 ? 0 : Math.max(
            ...queryCallsiteRanks.map((rank) => (
              callsiteTargets.get(`${rank}\0${neighbor.node.filePath}`)?.size ?? 0
            )),
          ),
          terms: flowTerms,
        });
        if (steps.length < hopLimit) queue.push({
          seed, node: neighbor.node, steps, visited, unnamedBridges, root: false,
        });
      }
  }
  const selected: ScopeFlow[] = [];
  let selectedSteps = 0;
  const sorted = flows.sort((left, right) => Number(left.startsInTest) - Number(right.startsInTest)
    // Prefer a cohesive path joining multiple query-relevant nodes. Ranking by
    // the seed alone over-promotes a highly lexical leaf's unrelated callees
    // and hides the upstream relationship which explains why that leaf runs.
    || right.executionPriority - left.executionPriority
    || Number(right.queryCallsiteSteps > 0) - Number(left.queryCallsiteSteps > 0)
    || right.bestQueryCallsiteWeight - left.bestQueryCallsiteWeight
    || left.bestQueryCallsiteRank - right.bestQueryCallsiteRank
    || Number(right.terminalPublic) - Number(left.terminalPublic)
    || right.queryCallsiteSteps - left.queryCallsiteSteps
    || right.relevantEndpoints - left.relevantEndpoints
    || right.pathRelevance - left.pathRelevance
    || right.endpointRelevance - left.endpointRelevance
    || right.terminalRelevance - left.terminalRelevance
    || right.endpointFilePriority - left.endpointFilePriority
    || Number(right.startsSelected) - Number(left.startsSelected)
    || right.selectedEndpoints - left.selectedEndpoints
    || right.seedRelevance - left.seedRelevance
    || left.flow.steps.length - right.flow.steps.length
    || flowKey(left.flow).localeCompare(flowKey(right.flow)));
  const seenFlowKeys = new Set<string>();
  const unique = sorted.filter(({ flow }) => {
    const key = flowKey(flow);
    if (seenFlowKeys.has(key)) return false;
    seenFlowKeys.add(key);
    return true;
  });
  // Traversal starts from every reliable seed, so one semantic path can be
  // discovered both whole and as prefixes/suffixes from its internal nodes.
  // Retain the maximal contiguous explanation before applying the global step
  // budget; otherwise the same edges consume the budget several times.
  const provenanceRanks = [...new Set(unique.flatMap((entry) => (
    entry.flow.steps.length === 1 && Number.isFinite(entry.bestQueryCallsiteRank)
      ? [entry.bestQueryCallsiteRank] : []
  )))].sort((left, right) => left - right);
  const uniqueOrder = new Map(unique.map((entry, index) => [flowKey(entry.flow), index]));
  const edgeLineWithin = (edge: GraphEdge, node: GraphNode): boolean => edge.line === undefined
    || (edge.line >= node.startLine && edge.line <= node.endLine);
  // The whole-query call-pair channel has already proved one ordered, bounded
  // public-entry relationship using independent lexical evidence at both ends.
  // Reload that exact real edge from cached adjacency before completing its
  // direct planner callback. This remains available even when bounded traversal
  // never materializes the one-edge prefix in `unique`, while arbitrary selected
  // same-file flows cannot activate the reserve.
  const callPairCallbackCompletion = fullQueryCallPairs.flatMap((pair, pairOrder) => {
    const source = pair.source.node;
    const target = pair.target.node;
    if (source.id === target.id || pair.edge.source !== source.id || pair.edge.target !== target.id
      || (pair.edge.kind !== "calls" && pair.edge.kind !== "instantiates")
      || (pair.edge.confidence ?? 1) < 0.8
      || isUnnamedFlowNode(source) || isUnnamedFlowNode(target)
      || !isSourceAnchorKind(source) || !isSourceAnchorKind(target)
      || isLowValueGraphPath(source.filePath) || isLowValueGraphPath(target.filePath)
      || source.filePath !== target.filePath) return [];
    const prefix = access.getOutgoing(source.id, ["calls", "instantiates"])
      .filter(({ node, edge }) => edgeKey(edge) === edgeKey(pair.edge)
        && (edge.kind === "calls" || edge.kind === "instantiates")
        && (edge.confidence ?? 1) >= 0.8
        && edge.source === source.id && edge.target === target.id && node.id === target.id
        && edgeLineWithin(edge, source))
      .sort((left, right) => (right.edge.confidence ?? 1) - (left.edge.confidence ?? 1)
        || compareEdgeCallsite(left.edge, right.edge)
        || edgeKey(left.edge).localeCompare(edgeKey(right.edge)))[0];
    if (!prefix) return [];
    return access.getOutgoing(target.id, ["contains"])
      .filter(({ node: callback, edge }) => edge.kind === "contains"
        && (edge.confidence ?? 1) >= 0.8
        && edge.source === target.id && edge.target === callback.id
        && callback.id !== source.id && callback.id !== target.id
        && callback.containerId === target.id
        && callback.filePath === target.filePath
        && isUnnamedFlowNode(callback) && edgeLineWithin(edge, target))
      .sort((left, right) => (right.edge.confidence ?? 1) - (left.edge.confidence ?? 1)
        || compareEdgeCallsite(left.edge, right.edge)
        || left.node.id.localeCompare(right.node.id))
      .slice(0, CALL_PAIR_CALLBACKS_LIMIT)
      .flatMap(({ node: callback, edge: containment }) => (
        access.getOutgoing(callback.id, ["calls", "instantiates"])
          .filter(({ node: terminal, edge }) => (edge.kind === "calls" || edge.kind === "instantiates")
            && (edge.confidence ?? 1) >= 0.8
            && edge.source === callback.id && edge.target === terminal.id
            && terminal.id !== source.id && terminal.id !== target.id
            && terminal.id !== callback.id
            && !isUnnamedFlowNode(terminal) && isSourceAnchorKind(terminal)
            && !isLowValueGraphPath(terminal.filePath)
            && terminal.filePath !== target.filePath
            && (terminal.isExported === true || terminal.visibility === "public")
            && endpointNameRelevance(terminal) >= MIN_CALL_PAIR_CALLBACK_TERMINAL_NAME_RELEVANCE
            && edgeLineWithin(edge, callback))
          .sort((left, right) => endpointNameRelevance(right.node) - endpointNameRelevance(left.node)
            || (right.edge.confidence ?? 1) - (left.edge.confidence ?? 1)
            || compareEdgeCallsite(left.edge, right.edge)
            || left.node.id.localeCompare(right.node.id))
          .slice(0, CALL_PAIR_CALLBACK_EDGES_LIMIT)
          .map(({ node: terminal, edge }) => ({
            flow: { steps: [prefix.edge, containment, edge] },
            terminalNameRelevance: endpointNameRelevance(terminal),
            pairOrder,
            terms: new Set([
              ...(nodeTerms.get(source.id) ?? []),
              ...(nodeTerms.get(target.id) ?? []),
              ...(nodeTerms.get(callback.id) ?? []),
              ...(nodeTerms.get(terminal.id) ?? []),
            ]),
          }))
      ))
  }).sort((left, right) => right.terminalNameRelevance - left.terminalNameRelevance
    || left.pairOrder - right.pairOrder
    || flowKey(left.flow).localeCompare(flowKey(right.flow)))[0];
  const namedOwnerBridgeCache = new Map<string, GraphNeighbor | null>();
  const namedOwnerBridge = (entry: (typeof unique)[number]): GraphNeighbor | null => {
    if (entry.flow.steps.length !== 1) return null;
    const orphanEdge = entry.flow.steps[0]!;
    if (orphanEdge.kind !== "calls" && orphanEdge.kind !== "instantiates"
      && orphanEdge.kind !== "references") return null;
    const cached = namedOwnerBridgeCache.get(edgeKey(orphanEdge));
    if (cached !== undefined) return cached;
    const callback = access.getNode(orphanEdge.source);
    if (!callback || !isUnnamedFlowNode(callback)) {
      namedOwnerBridgeCache.set(edgeKey(orphanEdge), null);
      return null;
    }
    const bridge = access.getIncoming(callback.id, ["contains"])
      .filter((candidate) => (candidate.edge.confidence ?? 1) >= 0.8
        && candidate.edge.source === candidate.node.id
        && candidate.edge.target === callback.id
        && candidate.node.kind !== "file"
        && !isUnnamedFlowNode(candidate.node)
        // `dispatch -> callback -> dispatch` is a real recursive shape, but it
        // does not explain which named operation owns the requested call.
        && candidate.node.id !== orphanEdge.target
        && candidate.node.filePath === callback.filePath)
      .sort((left, right) => Number(callback.containerId === right.node.id)
        - Number(callback.containerId === left.node.id)
        || Number(right.node.startLine <= callback.startLine && right.node.endLine >= callback.endLine)
          - Number(left.node.startLine <= callback.startLine && left.node.endLine >= callback.endLine)
        || (right.edge.confidence ?? 1) - (left.edge.confidence ?? 1)
        || (left.node.endLine - left.node.startLine) - (right.node.endLine - right.node.startLine)
        || left.node.id.localeCompare(right.node.id))[0] ?? null;
    namedOwnerBridgeCache.set(edgeKey(orphanEdge), bridge);
    return bridge;
  };
  const preferNamedOwnerFlow = (entry: (typeof unique)[number]): (typeof unique)[number] => {
    if (entry.flow.steps.length !== 1) return entry;
    const orphanEdge = entry.flow.steps[0]!;
    const orphanSource = access.getNode(orphanEdge.source);
    if (!orphanSource || !isUnnamedFlowNode(orphanSource)) return entry;

    // A callback can be retained as a provenance seed independently of its
    // enclosing declaration. When both traversals discover the same semantic
    // edge, keep the maximal named-owner path: emitting only the callback
    // suffix loses the relationship users asked for and spends another slot if
    // the complete path is admitted later.
    const containers = unique.filter((candidate) => {
      if (candidate.flow.steps.length <= entry.flow.steps.length
        || !isContiguousFlowSubpath(entry.flow, candidate.flow)) return false;
      const orphanOffset = candidate.flow.steps.findIndex((edge) => edgeKey(edge) === edgeKey(orphanEdge));
      // The orphan edge must remain the terminal relationship. Do not turn a
      // provenance repair into an unrelated downstream extension merely
      // because a longer traversal also happens to contain this edge.
      if (orphanOffset <= 0 || orphanOffset !== candidate.flow.steps.length - 1) return false;
      const bridge = candidate.flow.steps[orphanOffset - 1]!;
      const owner = access.getNode(bridge.source);
      return bridge.kind === "contains" && bridge.target === orphanEdge.source
        && owner !== null && !isUnnamedFlowNode(owner);
    }).sort((left, right) => right.flow.steps.length - left.flow.steps.length
      || (uniqueOrder.get(flowKey(left.flow)) ?? Number.MAX_SAFE_INTEGER)
        - (uniqueOrder.get(flowKey(right.flow)) ?? Number.MAX_SAFE_INTEGER));
    if (containers[0]) return containers[0];

    // The traversal budget may retain the callback while omitting its owner
    // seed. Prepend the actual stored containment edge in that case.
    const bridge = namedOwnerBridge(entry);
    if (bridge) return { ...entry, flow: { steps: [bridge.edge, orphanEdge] } };

    // A later recursive callback can win the bounded traversal while the
    // query's enclosing operation was pruned as a seed. Look only at alternate
    // real edges to the same target from the same matched source region, and
    // recover one whose callback has a non-recursive named owner. This keeps
    // the repair local to competing explanations of one relationship.
    const alternate = access.getIncoming(orphanEdge.target, [orphanEdge.kind])
      .flatMap((candidate) => {
        if ((candidate.edge.confidence ?? 1) < 0.8
          || candidate.edge.target !== orphanEdge.target
          || candidate.edge.kind !== orphanEdge.kind
          || edgeKey(candidate.edge) === edgeKey(orphanEdge)
          || !isUnnamedFlowNode(candidate.node)) return [];
        const candidateEntry = { ...entry, flow: { steps: [candidate.edge] } };
        const candidateBridge = namedOwnerBridge(candidateEntry);
        if (!candidateBridge) return [];
        const candidateRank = queryRegionCallsiteRanks.get(edgeKey(candidate.edge));
        const sameRank = candidateRank === entry.bestQueryCallsiteRank;
        const ownerRelevant = selectedIds.has(candidateBridge.node.id)
          || (seedRelevance.get(candidateBridge.node.id) ?? 0) >= STRONG_FLOW_RELEVANCE;
        // Prefer the exact propagated source region. If bounded relevance
        // expansion omitted that edge, a selected/query-relevant lexical owner
        // is equivalent corroboration; unrelated callers remain ineligible.
        return sameRank || ownerRelevant
          ? [{ candidate, bridge: candidateBridge, rank: candidateRank ?? Number.POSITIVE_INFINITY }]
          : [];
      })
      .sort((left, right) => Number(Number.isFinite(right.rank)) - Number(Number.isFinite(left.rank))
        || left.rank - right.rank
        || (queryRegionCallsiteWeights.get(edgeKey(right.candidate.edge)) ?? 0)
        - (queryRegionCallsiteWeights.get(edgeKey(left.candidate.edge)) ?? 0)
        || (seedRelevance.get(right.bridge.node.id) ?? 0) - (seedRelevance.get(left.bridge.node.id) ?? 0)
        || Number(isLowValueGraphPath(left.bridge.node.filePath))
          - Number(isLowValueGraphPath(right.bridge.node.filePath))
        || (right.candidate.edge.line ?? -1) - (left.candidate.edge.line ?? -1)
        || edgeKey(left.candidate.edge).localeCompare(edgeKey(right.candidate.edge)))[0];
    return alternate
      ? { ...entry, flow: { steps: [alternate.bridge.edge, alternate.candidate.edge] } }
      : entry;
  };
  const recoveredOwnerCandidates = unique.flatMap((entry) => {
    if (entry.flow.steps.length !== 1 || namedOwnerBridge(entry) !== null) return [];
    const preferred = preferNamedOwnerFlow(entry);
    return preferred.flow.steps.length > 1 ? [preferred] : [];
  });
  const recoveredOwnerKeys = new Set(recoveredOwnerCandidates.map((entry) => flowKey(entry.flow)));
  const compareProvenanceCandidate = (left: (typeof unique)[number], right: (typeof unique)[number]): number => {
    const leftEdge = left.flow.steps[0]!;
    const rightEdge = right.flow.steps[0]!;
    const sameRegionAndTarget = left.bestQueryCallsiteRank === right.bestQueryCallsiteRank
      && leftEdge.target === rightEdge.target;
    const namedOwnerPriority = sameRegionAndTarget
      ? Number(namedOwnerBridge(right) !== null) - Number(namedOwnerBridge(left) !== null)
      : 0;
    // Three distinct calls into one destination are strong enough to identify
    // a subsystem even when its symbols are lexically opaque (compiler
    // resolvers are the motivating case). One or two calls are ordinary local
    // evidence and should not leapfrog a better-ranked source region merely
    // because they happen later in a broad adapter/helper routine.
    const leftCohesive = left.terminalFileCallsiteCount >= 3;
    const rightCohesive = right.terminalFileCallsiteCount >= 3;
    const leftCrossFileCohesive = leftCohesive && left.crossesFile;
    const rightCrossFileCohesive = rightCohesive && right.crossesFile;
    return right.executionPriority - left.executionPriority
      // A recursive callback suffix is replaced only when another real caller
      // to the same target has a non-recursive named owner. Reserve that narrow
      // repair ahead of ordinary provenance without promoting every callback.
      || Number(recoveredOwnerKeys.has(flowKey(right.flow)))
        - Number(recoveredOwnerKeys.has(flowKey(left.flow)))
      // When one query region contains multiple callbacks invoking the same
      // target, prefer the callback with a real non-recursive named owner. A
      // later self-owned callback is an implementation suffix, not the fuller
      // operation-to-target explanation.
      || namedOwnerPriority
      // A coherent cross-file fan-out is the strongest evidence that a query
      // region delegates into another subsystem. Keep this ahead of local
      // helper clusters so the selected primary flow can promote that file.
      || Number(rightCrossFileCohesive) - Number(leftCrossFileCohesive)
      || Number(rightCohesive) - Number(leftCohesive)
      || (leftCohesive && rightCohesive
        ? right.terminalFileCallsiteCount - left.terminalFileCallsiteCount
        : left.bestQueryCallsiteRank - right.bestQueryCallsiteRank)
      // Within an equally cohesive cross-file destination, the final callsite
      // is the deterministic culmination (for example resolveModuleName after
      // its prerequisite resolver setup). Same-file clusters continue through
      // the ordinary relevance ordering below.
      || (leftCrossFileCohesive && rightCrossFileCohesive
        ? (rightEdge.line ?? -1) - (leftEdge.line ?? -1) : 0)
      || right.selectedEndpoints - left.selectedEndpoints
      || right.relevantEndpoints - left.relevantEndpoints
      || right.terminalNameRelevance - left.terminalNameRelevance
      || right.terminalRelevance - left.terminalRelevance
      || right.endpointRelevance - left.endpointRelevance
      || right.pathRelevance - left.pathRelevance
      || right.bestQueryCallsiteWeight - left.bestQueryCallsiteWeight
      || right.terminalFileCallsiteCount - left.terminalFileCallsiteCount
      || Number(right.crossesFile) - Number(left.crossesFile)
      || left.bestQueryCallsiteRank - right.bestQueryCallsiteRank
      || (rightEdge.line ?? -1) - (leftEdge.line ?? -1)
      || (leftEdge.column ?? Number.MAX_SAFE_INTEGER)
        - (rightEdge.column ?? Number.MAX_SAFE_INTEGER)
      || (uniqueOrder.get(flowKey(left.flow)) ?? Number.MAX_SAFE_INTEGER)
        - (uniqueOrder.get(flowKey(right.flow)) ?? Number.MAX_SAFE_INTEGER);
  };
  const rawProvenanceCandidates = provenanceRanks.flatMap((rank) => {
    const allCandidates = unique.filter((entry) => entry.flow.steps.length === 1
      && entry.bestQueryCallsiteRank === rank);
    const executableCandidates = allCandidates.filter((entry) => {
      const kind = entry.flow.steps[0]?.kind;
      return kind === "calls" || kind === "instantiates";
    });
    const candidates = executableCandidates.length > 0 ? executableCandidates : allCandidates;
    const rankedAtSource = [...candidates].sort(compareProvenanceCandidate);
    const primary = rankedAtSource[0];
    if (!primary) return [];
    const primaryTarget = primary.flow.steps[0]!.target;
    const secondary = rankedAtSource.find((entry) => {
      if (entry === primary || entry.flow.steps[0]!.target === primaryTarget) return false;
      // A second edge from one source region is warranted only when its target
      // is independently relevant/selected. This preserves paired operations
      // such as digest + cache-key construction without admitting every helper
      // called by a long routine.
      return entry.relevantEndpoints >= 2
        || entry.terminalRelevance >= STRONG_FLOW_RELEVANCE
        || entry.selectedEndpoints >= 2;
    });
    return secondary ? [primary, secondary] : [primary];
  });
  const provenanceCandidates = [...new Map([...rawProvenanceCandidates, ...recoveredOwnerCandidates].map((entry) => {
    const preferred = preferNamedOwnerFlow(entry);
    return [flowKey(preferred.flow), preferred] as const;
  })).values()];
  // Provenance is a priority reserve, not the whole flow budget. Rank all
  // source regions together before applying the cap so a strong later FTS hit
  // cannot be hidden by three incidental earlier windows, and leave at least
  // half of the eight-step allowance for maximal directed explanations.
  const provenanceReserve = Math.max(1, Math.ceil(maxSteps / 2));
  const provenanceRepresentatives = provenanceCandidates
    .sort(compareProvenanceCandidate)
    .slice(0, provenanceReserve);
  const provenanceKeys = new Set(provenanceRepresentatives.map((entry) => flowKey(entry.flow)));
  const recoveredRepresentativeFlows = provenanceRepresentatives
    .filter((entry) => recoveredOwnerKeys.has(flowKey(entry.flow)))
    .map((entry) => entry.flow);
  const explainedCallbackTargets = new Set(provenanceRepresentatives.flatMap((entry) => {
    if (entry.flow.steps.length < 2) return [];
    const terminal = entry.flow.steps.at(-1)!;
    const bridge = entry.flow.steps.at(-2)!;
    const owner = access.getNode(bridge.source);
    return bridge.kind === "contains" && bridge.target === terminal.source
      && owner !== null && owner.kind !== "file" && !isUnnamedFlowNode(owner)
      && owner.id !== terminal.target
      ? [`${entry.bestQueryCallsiteRank}\0${terminal.target}`] : [];
  }));
  const isExplainedCallbackSuffix = (entry: (typeof unique)[number]): boolean => {
    if (entry.flow.steps.length !== 1) return false;
    const edge = entry.flow.steps[0]!;
    const source = access.getNode(edge.source);
    return source !== null && isUnnamedFlowNode(source)
      && explainedCallbackTargets.has(`${entry.bestQueryCallsiteRank}\0${edge.target}`);
  };
  const ranked = unique.filter(({ flow }, index) => !provenanceKeys.has(flowKey(flow))
    && !isExplainedCallbackSuffix(unique[index]!)
    // Once a recovered named-owner explanation is reserved, a longer path
    // which merely prepends upstream callers repeats the same semantic spine.
    && !recoveredRepresentativeFlows.some((recovered) => flow.steps.length > recovered.steps.length
      && isTerminalFlowSubpath(recovered, flow))
    && !unique.some(({ flow: other }, otherIndex) =>
    index !== otherIndex
      && flow.steps.length < other.steps.length
      && isContiguousFlowSubpath(flow, other)));
  const deferredOverlap: ScopeFlow[] = [];
  const admit = (flow: ScopeFlow): boolean => {
    const keys = new Set(flow.steps.map(edgeKey));
    if (selected.some((prior) => [...keys].every((key) => prior.steps.some((step) => edgeKey(step) === key)))) return false;
    const remaining = maxSteps - selectedSteps;
    if (remaining <= 0 || flow.steps.length > remaining) return false;
    const admitted = { steps: flow.steps };
    selected.push(admitted);
    selectedSteps += admitted.steps.length;
    return true;
  };
  const coveredTerms = new Set<string>();
  if (callPairCallbackCompletion && admit(callPairCallbackCompletion.flow)) {
    for (const term of callPairCallbackCompletion.terms) coveredTerms.add(term);
  }
  for (const representative of provenanceRepresentatives) {
    if (!admit(representative.flow)) continue;
    for (const term of representative.terms) coveredTerms.add(term);
  }
  const first = ranked.shift();
  if (first && admit(first.flow)) {
    for (const term of first.terms) coveredTerms.add(term);
  }
  ranked.sort((left, right) => Number(right.startsSelected) - Number(left.startsSelected)
    || marginalTermScore(right.terms, coveredTerms, termWeights)
      - marginalTermScore(left.terms, coveredTerms, termWeights));
  for (const { flow } of ranked) {
    if (selectedSteps >= maxSteps) break;
    if (selected.length > 0 && selected.some((prior) => flow.steps.some((step) =>
      prior.steps.some((priorStep) => edgeKey(priorStep) === edgeKey(step))))) {
      deferredOverlap.push(flow);
      continue;
    }
    admit(flow);
    if (selectedSteps >= maxSteps) break;
  }
  // If every useful branch shares an upstream prefix, retain the best such
  // branch rather than forcing a single-flow result. Disjoint explanations win
  // whenever they exist, which prevents two slots restating the same spine.
  for (const flow of deferredOverlap) {
    if (selectedSteps >= maxSteps) break;
    admit(flow);
  }
  return selected;
}

function marginalTermScore(terms: Set<string>, covered: Set<string>, weights: Map<string, number>): number {
  return [...terms].filter((term) => !covered.has(term))
    .reduce((score, term) => score + (weights.get(term) ?? 0), 0);
}

function isUnnamedFlowNode(node: GraphNode): boolean {
  return node.name.length === 0 || /^<.*>$/.test(node.name) || node.name.startsWith("<callback:");
}

function compareSemanticPhraseNeighbor(left: GraphNeighbor, right: GraphNeighbor): number {
  return (right.edge.confidence ?? 1) - (left.edge.confidence ?? 1)
    || compareEdgeCallsite(left.edge, right.edge)
    || left.node.filePath.localeCompare(right.node.filePath)
    || left.node.id.localeCompare(right.node.id);
}

/** Total callsite order; graph-store row order must never decide a phrase bridge. */
function compareEdgeCallsite(left: GraphEdge, right: GraphEdge): number {
  return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
    || (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
    || left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.kind.localeCompare(right.kind)
    || (left.resolutionMethod ?? "").localeCompare(right.resolutionMethod ?? "")
    || (left.provenance ?? "").localeCompare(right.provenance ?? "");
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.source}\0${edge.target}\0${edge.kind}\0${edge.line ?? -1}\0${edge.column ?? -1}`;
}

function flowKey(flow: ScopeFlow): string {
  return flow.steps.map(edgeKey).join("\n");
}

function isContiguousFlowSubpath(candidate: ScopeFlow, container: ScopeFlow): boolean {
  if (candidate.steps.length > container.steps.length) return false;
  const candidateKeys = candidate.steps.map(edgeKey);
  const containerKeys = container.steps.map(edgeKey);
  for (let offset = 0; offset <= containerKeys.length - candidateKeys.length; offset += 1) {
    if (candidateKeys.every((key, index) => key === containerKeys[offset + index])) return true;
  }
  return false;
}

function isTerminalFlowSubpath(candidate: ScopeFlow, container: ScopeFlow): boolean {
  if (candidate.steps.length > container.steps.length) return false;
  const offset = container.steps.length - candidate.steps.length;
  return candidate.steps.every((edge, index) => edgeKey(edge) === edgeKey(container.steps[offset + index]!));
}

function normalizeNodeSearch(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function createScopeRequestAccess(graph: GraphEngine): ScopeRequestAccess {
  const nodeCache = new Map<string, GraphNode | null>();
  const incomingCache = new Map<string, GraphNeighbor[]>();
  const outgoingCache = new Map<string, GraphNeighbor[]>();
  const adjacencyKey = (id: string, kinds: EdgeKind[]): string =>
    `${id}\0${[...new Set(kinds)].sort().join(",")}`;
  const rememberNeighbors = (neighbors: GraphNeighbor[]): GraphNeighbor[] => {
    for (const neighbor of neighbors) nodeCache.set(neighbor.node.id, neighbor.node);
    return neighbors;
  };
  const cachedNeighbors = (
    cache: Map<string, GraphNeighbor[]>,
    id: string,
    kinds: EdgeKind[],
    load: () => GraphNeighbor[],
  ): GraphNeighbor[] => {
    const key = adjacencyKey(id, kinds);
    const cached = cache.get(key);
    if (cached) return cached;
    const loaded = rememberNeighbors(load());
    cache.set(key, loaded);
    return loaded;
  };
  return {
    rememberNode(node): void { nodeCache.set(node.id, node); },
    getNode(id): GraphNode | null {
      if (nodeCache.has(id)) return nodeCache.get(id) ?? null;
      const node = graph.getNode(id);
      nodeCache.set(id, node);
      return node;
    },
    getIncoming(id, kinds): GraphNeighbor[] {
      return cachedNeighbors(incomingCache, id, kinds, () => graph.getIncoming(id, kinds));
    },
    getOutgoing(id, kinds): GraphNeighbor[] {
      return cachedNeighbors(outgoingCache, id, kinds, () => graph.getOutgoing(id, kinds));
    },
  };
}

function compareDerivedFlowSeed(left: DerivedFlowSeed, right: DerivedFlowSeed): number {
  return Number(Number.isFinite(right.callsiteRank)) - Number(Number.isFinite(left.callsiteRank))
    || left.callsiteRank - right.callsiteRank
    || right.relevance - left.relevance
    || right.confidence - left.confidence
    || Number(isLowValueGraphPath(left.node.filePath)) - Number(isLowValueGraphPath(right.node.filePath))
    || left.node.id.localeCompare(right.node.id);
}

function reliableNeighbors(access: ScopeRequestAccess, id: string): GraphNeighbor[] {
  const current = access.getNode(id);
  return [...access.getIncoming(id, RELEVANCE_EDGE_KINDS), ...access.getOutgoing(id, RELEVANCE_EDGE_KINDS)]
    .filter((entry) => {
      if ((entry.edge.confidence ?? 1) < 0.8) return false;
      if (entry.edge.kind !== "contains") return true;
      // Containment may promote a declaration to its non-file owner, or enter
      // the one anonymous callback bridge needed for compiler-backed calls.
      // It must never fan out from a file/class into named children: that turns
      // one lexical hit into every sibling declaration on the second hop.
      return entry.edge.source === id
        ? current?.kind !== "file" && isUnnamedFlowNode(entry.node)
        : entry.node.kind !== "file" && current?.kind !== "file";
    }).sort(compareNeighbor);
}

function compareNeighbor(left: GraphNeighbor, right: GraphNeighbor): number {
  return (right.edge.confidence ?? 1) - (left.edge.confidence ?? 1)
    || Number(isLowValueGraphPath(left.node.filePath)) - Number(isLowValueGraphPath(right.node.filePath))
    || (left.edge.line ?? Number.MAX_SAFE_INTEGER) - (right.edge.line ?? Number.MAX_SAFE_INTEGER)
    || left.node.id.localeCompare(right.node.id);
}

function compareQueryNeighbor(
  currentId: string,
  left: GraphNeighbor,
  right: GraphNeighbor,
  hits: SourceChunkMatch[],
  terms: Array<{ term: string; weight: number; stem: boolean }>,
): number {
  const callsiteScore = (entry: GraphNeighbor): number => {
    if (entry.edge.source !== currentId || entry.edge.line === undefined) return 0;
    return hits.some((hit) => entry.edge.line! >= hit.startLine && entry.edge.line! <= hit.endLine) ? 1 : 0;
  };
  const nameScore = (entry: GraphNeighbor): number => {
    const components = new Set(searchComponents(entry.node.name));
    return terms.reduce((score, term) => score
      + (componentMatches(components, term.term, term.stem) ? term.weight : 0), 0);
  };
  return callsiteScore(right) - callsiteScore(left)
    || nameScore(right) - nameScore(left)
    || compareNeighbor(left, right);
}

function queryCallsiteHit(currentId: string, edge: GraphEdge, hits: SourceChunkMatch[]): boolean {
  if (edge.source !== currentId || edge.line === undefined) return false;
  return hits.some((hit) => edge.line! >= hit.startLine && edge.line! <= hit.endLine);
}

function queryCallsiteWeight(
  edge: GraphEdge,
  hits: SourceChunkMatch[],
  concepts: QueryConcept[],
): number {
  if (edge.line === undefined) return 0;
  return hits.filter((hit) => edge.line! >= hit.startLine && edge.line! <= hit.endLine)
    .reduce((best, hit) => {
      const terms = new Set(hit.matchedTerms ?? []);
      const weight = concepts.filter((concept) => conceptMatchesTerms(concept, terms))
        .reduce((sum, concept) => sum + concept.weight, 0);
      return Math.max(best, weight);
    }, 0);
}

function isReliableLexicalSeed(entry: NodeEvidence): boolean {
  if (entry.exact) return true;
  const literalTermReasons = [...entry.reasons]
    .filter((reason) => reason.startsWith("term:"))
    .map((reason) => reason.slice("term:".length));
  if (literalTermReasons.length === 0 || entry.nameTerms.size === 0) return false;
  const normalizedName = entry.node.name.replace(/^#/, "").toLowerCase();
  if (literalTermReasons.includes(normalizedName)) return true;
  // BM25 plus a distinctive name component (or two ordinary components) is a
  // corroborated symbol hit. Docstring/signature-only hits never qualify.
  const matchedNameTerms = literalTermReasons.filter((term) => entry.nameTerms.has(term));
  const generic = new Set(["class", "code", "file", "function", "graph", "method", "node", "source", "symbol"]);
  return entry.reasons.has("bm25-node") && (
    matchedNameTerms.length >= 2
    || matchedNameTerms.some((term) => term.length >= 5 && !generic.has(term))
  );
}

function isReliableRegionSeed(entry: NodeEvidence): boolean {
  // A region match is traversable only when the declaration name independently
  // corroborates it. Body-only FTS remains useful source evidence but must not
  // manufacture graph flow from an incidental overlap. The source index orders
  // overlapping declarations by substantive coverage, so a strong body-only
  // chunk may bootstrap its single primary declaration, but never every
  // sibling that happens to share the same 80-line window.
  const primaryBodyMatch = entry.bestRegionOverlapRank === 0 && entry.regionHits.some((hit) => (
    new Set(hit.matchedTerms ?? []).size >= 3
  ));
  if (regionStrength(entry) >= 0.55 && (entry.nameTerms.size > 0 || primaryBodyMatch)) return true;
  // A named declaration that demonstrably owns an anonymous callback inside a
  // two-concept source hit is safe to traverse at a slightly lower lexical
  // threshold: the compiler-backed containment and subsequent call still have
  // to satisfy the normal confidence and one-bridge gates.
  return entry.regionCallbackCallsites.size > 0 && directRegionStrength(entry) >= 0.4
    && entry.regionHits.some((hit) => new Set(hit.matchedTerms ?? []).size >= 2);
}

/**
 * Only declarations with declaration-local lexical evidence or a trusted graph
 * relationship become candidates/facts. Source-chunk terms describe an entire
 * 80-line window, so an overlapping sibling is not a structural claim merely
 * because several query terms occur elsewhere in that window. The file and its
 * raw text hit remain independently selectable through the source channel.
 */
function hasTrustworthyCandidateEvidence(entry: NodeEvidence): boolean {
  return entry.exact
    || entry.reliable
    || isReliableLexicalSeed(entry)
    || isReliableRegionSeed(entry);
}

function isSourceAnchorKind(node: GraphNode): boolean {
  if (node.name.startsWith("<callback:")) return false;
  switch (node.kind) {
    case "function": case "method": case "class": case "struct": case "trait":
    case "component": case "route": case "interface": case "protocol": case "type_alias":
      return true;
    default:
      return false;
  }
}

function compareNodeEvidence(left: NodeEvidence, right: NodeEvidence): number {
  return Number(right.exact) - Number(left.exact)
    || nodeSelectionPriority(right.node) - nodeSelectionPriority(left.node)
    || left.bestCallsiteRank - right.bestCallsiteRank
    || regionStrength(right) - regionStrength(left)
    || right.nameTerms.size - left.nameTerms.size
    || right.terms.size - left.terms.size
    || (right.rrf + right.graph) - (left.rrf + left.graph)
    || left.node.id.localeCompare(right.node.id);
}

function bestFullQueryCallPairs(
  entries: NodeEvidence[],
  concepts: QueryConcept[],
  access: ScopeRequestAccess,
  limit: number,
): FullQueryCallPair[] {
  const byId = new Map(entries.map((entry) => [entry.node.id, entry]));
  const eligibleSources = entries.filter((entry) => entry.fullQueryRank < MAX_FULL_QUERY_CALL_PAIR_RANK
    && !isLowValueGraphPath(entry.node.filePath)
    && isSourceAnchorKind(entry.node)
    && (entry.node.isExported === true || entry.node.visibility === "public"))
    .sort((left, right) => left.fullQueryRank - right.fullQueryRank
      || left.node.id.localeCompare(right.node.id))
    .slice(0, MAX_FULL_QUERY_CALL_PAIR_RANK);
  return eligibleSources.map((entry) => {
    const declarationConcepts = concepts.filter((concept) => nodeMatchesConcept(entry.node, concept));
    const identityConcepts = concepts.filter((concept) => nodeMatchesConceptInIdentity(entry.node, concept));
    const declarationWeight = declarationConcepts.reduce((sum, concept) => sum + concept.weight, 0);
    const strongConcepts = declarationConcepts.filter((concept) => concept.weight >= 1);
    const identityKeys = new Set(identityConcepts.map((concept) => concept.key));
    const corroboratingTarget = access.getOutgoing(entry.node.id, ["calls", "instantiates"])
      .filter(({ edge }) => (edge.confidence ?? 1) >= 0.8)
      .flatMap(({ node, edge }) => {
        const target = byId.get(node.id);
        if (!target || target.fullQueryRank >= MAX_FULL_QUERY_CALL_PAIR_RANK
          || isLowValueGraphPath(target.node.filePath) || !isSourceAnchorKind(target.node)) return [];
        const targetConcepts = concepts.filter((concept) => nodeMatchesConceptInIdentity(target.node, concept));
        if (targetConcepts.length < 2 || !targetConcepts.some((concept) => !identityKeys.has(concept.key))) return [];
        const union = new Map([...identityConcepts, ...targetConcepts].map((concept) => [concept.key, concept]));
        const unionWeight = [...union.values()].reduce((sum, concept) => sum + concept.weight, 0);
        const unionStrong = [...union.values()].filter((concept) => concept.weight >= 1).length;
        if (!((unionStrong > 0 && union.size >= 3 && unionWeight >= 1.7)
          || (union.size >= 4 && unionWeight >= 1.4))) return [];
        return [{ target, edge, unionWeight, unionSize: union.size }];
      }).sort((left, right) => left.target.fullQueryRank - right.target.fullQueryRank
        || right.unionWeight - left.unionWeight
        || right.unionSize - left.unionSize
        || (right.edge.confidence ?? 1) - (left.edge.confidence ?? 1)
        || compareEdgeCallsite(left.edge, right.edge))[0];
    return {
      entry, declarationConcepts, identityConcepts, declarationWeight, strongConcepts, corroboratingTarget,
    };
  }).filter(({ entry, declarationConcepts, identityConcepts, declarationWeight, strongConcepts, corroboratingTarget }) => (
    identityConcepts.length > 0
    && declarationConcepts.length >= 3
    && ((strongConcepts.length > 0 && declarationWeight >= 1.7)
      || (declarationConcepts.length >= 4 && identityConcepts.length >= 2 && declarationWeight >= 1.4))
    && corroboratingTarget !== undefined
  )).sort((left, right) => left.entry.fullQueryRank - right.entry.fullQueryRank
    || left.corroboratingTarget!.target.fullQueryRank - right.corroboratingTarget!.target.fullQueryRank
    || right.strongConcepts.length - left.strongConcepts.length
    || right.declarationWeight - left.declarationWeight
    || right.identityConcepts.length - left.identityConcepts.length
    || compareNodeEvidence(left.entry, right.entry))
    .slice(0, Math.floor(limit / 2))
    .map(({ entry, corroboratingTarget }) => ({
      source: entry,
      target: corroboratingTarget!.target,
      edge: corroboratingTarget!.edge,
    }));
}

function bestStrongIntentFacetDeclarations(
  entries: NodeEvidence[],
  concepts: QueryConcept[],
  access: ScopeRequestAccess,
  limit: number,
): NodeEvidence[] {
  const lexicalCandidates = entries.map((entry) => {
    const matched = concepts.filter((concept) => nodeMatchesConceptInIdentity(entry.node, concept));
    const strong = matched.filter((concept) => concept.weight >= MIN_SEMANTIC_PHRASE_CONCEPT_WEIGHT);
    const weight = matched.reduce((sum, concept) => sum + concept.weight, 0);
    return { entry, matched, strong, weight };
  }).filter(({ entry, matched, strong, weight }) => (
    !isLowValueGraphPath(entry.node.filePath)
    && isSourceAnchorKind(entry.node)
    && (entry.node.isExported === true || entry.node.visibility === "public")
    && matched.length >= 2
    && strong.length > 0
    // A responsibility must stay grounded in at least one code-domain concept;
    // two ordinary English words such as "entry points" are one phrase, not a
    // second independent responsibility.
    && matched.some((concept) => concept.weight < MIN_SEMANTIC_PHRASE_CONCEPT_WEIGHT)
    && weight >= 1
  )).sort((left, right) => right.weight - left.weight
    || right.matched.length - left.matched.length
    || compareNodeEvidence(left.entry, right.entry))
    .slice(0, 16);
  const candidates = lexicalCandidates.filter(({ entry }) => {
    const incoming = access.getIncoming(entry.node.id, FLOW_EDGE_KINDS)
      .filter(({ edge, node }) => (edge.confidence ?? 1) >= 0.8
        && !isLowValueGraphPath(node.filePath));
    // Cross-file invocation proves a boundary entry. An unreferenced exported
    // declaration remains a plausible library entry; a helper used only by
    // siblings in its own file does not consume the facet reserve.
    return incoming.length === 0
      || incoming.some(({ node }) => node.filePath !== entry.node.filePath);
  });
  const selected: NodeEvidence[] = [];
  const covered = new Set<string>();
  while (selected.length < limit) {
    const next = candidates.filter(({ entry, strong }) => !selected.includes(entry)
      && strong.some((concept) => !covered.has(concept.key)))
      .sort((left, right) => {
        const leftMarginal = left.strong.filter((concept) => !covered.has(concept.key));
        const rightMarginal = right.strong.filter((concept) => !covered.has(concept.key));
        return rightMarginal.reduce((sum, concept) => sum + concept.weight, 0)
          - leftMarginal.reduce((sum, concept) => sum + concept.weight, 0)
          || rightMarginal.length - leftMarginal.length
          || right.weight - left.weight
          || right.matched.length - left.matched.length
          || compareNodeEvidence(left.entry, right.entry);
      })[0];
    if (!next) break;
    selected.push(next.entry);
    for (const concept of next.strong) covered.add(concept.key);
  }
  return selected;
}

function bestFullQueryDeclaration(
  entries: NodeEvidence[],
  concepts: QueryConcept[],
): NodeEvidence | undefined {
  return entries.filter((entry) => (
    Number.isFinite(entry.fullQueryRank)
    && !isLowValueGraphPath(entry.node.filePath)
    // Stems and inflections of one user token are one concept, not independent
    // corroboration. Require two raw concepts in the declaration's leaf name
    // whose combined planner weight reaches one ordinary-strength signal. This
    // retains a focused compound such as planFileSource while rejecting both a
    // lone `supported` family and ubiquitous low-signal pairs such as source+file.
    && (hasIndependentNameConcepts(entry.node, concepts) || (isReliableLexicalSeed(entry)
      && [...entry.reasons].some((reason) => (
        reason === `term:${entry.node.name.replace(/^#/, "").toLowerCase()}`
      ))))
  )).sort((left, right) => left.fullQueryRank - right.fullQueryRank
    || compareNodeEvidence(left, right)
    || left.node.id.localeCompare(right.node.id))[0];
}

function hasIndependentNameConcepts(node: GraphNode, concepts: QueryConcept[]): boolean {
  const components = new Set(searchComponents(node.name));
  const matched = concepts.filter((concept) => conceptMatchesComponents(concept, components));
  return matched.length >= 2 && matched.reduce((sum, concept) => sum + concept.weight, 0) >= 1;
}

function bestSourceAlignedDeclaration(entries: NodeEvidence[]): NodeEvidence | undefined {
  return entries.filter((entry) => entry.directRegion > 0 && Number.isFinite(entry.bestRegionRank))
    .sort((left, right) => left.bestRegionRank - right.bestRegionRank
      || right.nameTerms.size - left.nameTerms.size
      || directRegionStrength(right) - directRegionStrength(left)
      || left.bestRegionOverlapRank - right.bestRegionOverlapRank
      || compareNodeEvidence(left, right))[0];
}

function compareProvenanceFlowSeed(left: NodeEvidence, right: NodeEvidence): number {
  return left.bestRegionRank - right.bestRegionRank
    || left.bestRegionOverlapRank - right.bestRegionOverlapRank
    || Number(right.regionCallbackCallsites.size > 0) - Number(left.regionCallbackCallsites.size > 0)
    || right.regionCallsites.size - left.regionCallsites.size
    || compareNodeEvidence(left, right);
}

function nodeSelectionPriority(node: GraphNode): number {
  if (node.name.startsWith("<callback:")) return 0;
  switch (node.kind) {
    case "function": case "method": case "class": case "struct": case "trait": case "component": return 3;
    case "interface": case "protocol": case "type_alias": case "enum": return 2;
    case "constant": case "variable": case "route": return 1.5;
    case "property": case "field": case "parameter": return 1;
    default: return 0.5;
  }
}

function ensureNode(nodes: Map<string, NodeEvidence>, node: GraphNode): NodeEvidence {
  const existing = nodes.get(node.id);
  if (existing) return existing;
  const created: NodeEvidence = {
    node, rrf: 0, fullQueryRank: Number.POSITIVE_INFINITY,
    region: 0, directRegion: 0, regionHits: [], bestRegionRank: Number.POSITIVE_INFINITY,
    bestRegionOverlapRank: Number.POSITIVE_INFINITY,
    regionCallsites: new Set(), regionCallbackCallsites: new Set(), bestCallsiteRank: Number.POSITIVE_INFINITY,
    exact: false, exactIdentifiers: new Set(), graph: 0,
    terms: new Set(), nameTerms: new Set(), reasons: new Set(), reliable: false,
  };
  nodes.set(node.id, created);
  return created;
}

function regionStrength(entry: NodeEvidence): number {
  // Repeated overlapping windows are supporting evidence, not independent
  // votes. A small saturating bonus lets a substantive enclosing declaration
  // beat a two-line wrapper without making very long files dominate.
  return entry.region + Math.min(0.3, Math.max(0, entry.regionHits.length - 1) * 0.06);
}

function directRegionStrength(entry: NodeEvidence): number {
  return entry.directRegion + Math.min(0.3, Math.max(0, entry.regionHits.length - 1) * 0.06);
}

function ensureFile(files: Map<string, FileEvidence>, filePath: string): FileEvidence {
  const existing = files.get(filePath);
  if (existing) return existing;
  const created: FileEvidence = {
    filePath, score: 0, region: 0, callsiteRegion: 0, callsiteQueryWeight: 0,
    bestCallsiteRank: Number.POSITIVE_INFINITY,
    terms: new Set(), reasons: new Set(), nodeIds: new Set(), textHits: [], bestTextRank: Number.POSITIVE_INFINITY, exact: false,
    exactIdentifiers: new Set(), reliableGraph: false,
  };
  files.set(filePath, created);
  return created;
}

function exactIdentifierMatch(node: GraphNode, identifier: string): boolean {
  const wanted = identifier.replaceAll(".", "::");
  const name = node.name;
  const qualified = node.qualifiedName.replaceAll(".", "::");
  return name === wanted || qualified === wanted || qualified.endsWith(`::${wanted}`);
}

function caseFoldedIdentifierMatch(node: GraphNode, identifier: string): boolean {
  const wanted = identifier.toLowerCase().replaceAll(".", "::");
  const name = node.name.toLowerCase();
  const qualified = node.qualifiedName.toLowerCase().replaceAll(".", "::");
  return name === wanted || qualified === wanted || qualified.endsWith(`::${wanted}`);
}

function nodeContains(node: GraphNode, term: string, prefix = false): boolean {
  const indexed = new Set([
    ...searchComponents(node.name),
    ...searchComponents(node.qualifiedName),
    ...searchComponents(node.signature ?? ""),
    ...searchComponents(node.docstring ?? ""),
  ]);
  return componentMatches(indexed, term, prefix);
}

function componentMatches(components: Set<string>, term: string, prefix: boolean): boolean {
  return components.has(term) || (prefix && term.length >= 3 && [...components].some((component) => component.startsWith(term)));
}

function searchComponents(value: string): string[] {
  return [...new Set((value.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).flatMap(identifierComponents))];
}

function literalTerms(plan: ReturnType<typeof planGraphQuery>): string[] {
  return [...new Set(plan.terms.filter((term) => !term.stem).map((term) => term.term))];
}

function weightedTerms(plan: ReturnType<typeof planGraphQuery>): Array<{ term: string; weight: number; stem: boolean }> {
  const weights = new Map<string, { weight: number; stem: boolean }>();
  for (const entry of plan.terms) {
    const current = weights.get(entry.term);
    weights.set(entry.term, {
      weight: Math.max(current?.weight ?? 0, entry.weight),
      stem: (current?.stem ?? true) && entry.stem,
    });
  }
  return [...weights].map(([term, value]) => ({ term, ...value }));
}

/**
 * Group inflections and compound-identifier components by the token the user
 * actually supplied. Coverage should reward independent query concepts, not
 * count `compose`, `composed`, and `compos` as three separate signals.
 */
function queryConcepts(plan: ReturnType<typeof planGraphQuery>): QueryConcept[] {
  const concepts = new Map<string, QueryConcept>();
  for (const entry of plan.terms) {
    const key = entry.raw.toLowerCase();
    const concept = concepts.get(key) ?? { key, raw: entry.raw, weight: 0, terms: [] };
    concept.weight = Math.max(concept.weight, entry.weight);
    if (!concept.terms.some((term) => term.term === entry.term && term.stem === entry.stem)) {
      concept.terms.push({ term: entry.term, stem: entry.stem });
    }
    concepts.set(key, concept);
  }
  return [...concepts.values()];
}

function conceptMatchesTerms(concept: QueryConcept, terms: Set<string>): boolean {
  return concept.terms.some((entry) => terms.has(entry.term));
}

function conceptMatchesComponents(concept: QueryConcept, components: Set<string>): boolean {
  return concept.terms.some((entry) => componentMatches(components, entry.term, entry.stem));
}

function nodeMatchesConcept(node: GraphNode, concept: QueryConcept): boolean {
  return concept.terms.some((entry) => nodeContains(node, entry.term, entry.stem));
}

function nodeMatchesConceptInIdentity(node: GraphNode, concept: QueryConcept): boolean {
  const components = new Set([
    ...searchComponents(node.name),
    ...searchComponents(node.qualifiedName),
    ...searchComponents(node.signature ?? ""),
  ]);
  return conceptMatchesComponents(concept, components);
}

function addConceptEvidence(entry: NodeEvidence, concept: QueryConcept): void {
  const nameComponents = new Set(searchComponents(entry.node.name));
  for (const term of concept.terms) {
    if (nodeContains(entry.node, term.term, term.stem)) entry.terms.add(term.term);
    if (componentMatches(nameComponents, term.term, term.stem)) entry.nameTerms.add(term.term);
  }
}

function componentIdfSignal(
  components: Set<string>,
  concepts: QueryConcept[],
  documents: number,
  documentFrequency: Map<string, number>,
): number {
  let score = 0;
  for (const component of components) {
    const singleton = new Set([component]);
    const strongest = concepts.filter((concept) => conceptMatchesComponents(concept, singleton))
      .reduce((best, concept) => Math.max(
        best,
        concept.weight * idf(documents, documentFrequency.get(concept.key) ?? 0),
      ), 0);
    score += strongest;
  }
  return score;
}

function idf(documents: number, frequency: number): number {
  return Math.log((documents + 1) / (frequency + 1)) + 1;
}

function safeSourceSearch(graph: GraphEngine, query: string, limit: number): SourceChunkMatch[] {
  try { return graph.searchSource?.(query, limit) ?? []; } catch { return []; }
}

function safeIndexedFiles(graph: GraphEngine): IndexedFileInfo[] {
  try { return graph.getIndexedFiles?.() ?? []; } catch { return []; }
}

function dedupeChunkHits(hits: SourceChunkMatch[]): SourceChunkMatch[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.filePath}:${hit.startLine}:${hit.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

function emptySelection(): ScopeSelection {
  return { candidates: [], files: [], flows: [], matchedCount: 0, coveredTerms: [], evidenceStrength: "none" };
}

export function compactFact(graph: GraphEngine, id: string, detail: DetailLevel): CompactFact | null {
  const node = graph.getNode(id);
  if (!node) return null;
  return {
    id: node.id, kind: node.kind, name: node.name, qualifiedName: node.qualifiedName,
    filePath: node.filePath, lineStart: node.startLine, lineEnd: node.endLine,
    signature: node.signature, callerCount: graph.getCallers(id).length,
    calleeCount: graph.getCallees(id).length, detail, sourceIncluded: false, bodyHash: node.bodyHash,
  };
}

export function readNodeSource(node: GraphNode, rootDir: string, maxLines: number): SourceRange | null {
  let lines: string[];
  try { lines = readFileSync(resolve(rootDir, node.filePath), "utf-8").split("\n"); }
  catch { return null; }
  const body = lines.slice(node.startLine - 1, node.endLine);
  const truncated = maxLines > 0 && body.length > maxLines;
  const kept = truncated ? body.slice(0, maxLines) : body;
  return {
    startLine: node.startLine, endLine: node.startLine + Math.max(0, kept.length - 1), nodeIds: [node.id],
    content: numbered(kept, node.startLine), truncated, reason: truncated ? "signature" : "complete-symbol",
  };
}

/** Plan small whole files, complete symbols, or tight query/callsite windows. */
export function planFileSource(
  filePath: string,
  nodes: GraphNode[],
  textHits: SourceChunkMatch[],
  rootDir: string,
  query: string,
  maxLines = 160,
  callsiteLines: number[] = [],
): SourceRange[] {
  let lines: string[];
  try { lines = readFileSync(resolve(rootDir, filePath), "utf-8").split("\n"); }
  catch { return []; }
  // `split` creates a synthetic 201st entry for a 200-line file ending in a
  // newline. Do not let that formatting detail disable the whole-file policy.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  type PlannedRange = {
    start: number;
    end: number;
    nodeIds: string[];
    reason: SourceRange["reason"];
    priority: number;
    rangeKind: "whole" | "symbol" | "signature" | "window";
    intrinsicallyTruncated?: boolean;
  };
  const ranges: PlannedRange[] = [];
  const lineBudget = Math.max(1, maxLines);
  if (lines.length <= 200 && lines.length <= maxLines) {
    ranges.push({
      start: 1, end: lines.length, nodeIds: nodes.map((node) => node.id), reason: "whole-file",
      priority: 0, rangeKind: "whole",
    });
  } else {
    const queryTerms = literalTerms(planGraphQuery(query));
    const queryLines: number[] = [];
    lines.forEach((line, index) => {
      const lower = line.toLowerCase();
      if (queryTerms.some((term) => lower.includes(term))) queryLines.push(index + 1);
    });

    for (const [nodeIndex, node] of nodes.entries()) {
      const start = Math.max(1, Math.min(lines.length, node.startLine));
      const end = Math.max(start, Math.min(lines.length, node.endLine));
      const length = end - start + 1;
      const basePriority = nodeIndex * 10;
      if (length <= 160 && length <= lineBudget) {
        ranges.push({
          start, end, nodeIds: [node.id], reason: "complete-symbol",
          priority: basePriority, rangeKind: "symbol",
        });
        continue;
      }

      // Long declarations retain their real declaration header, followed by at
      // most two bounded windows from inside that declaration. Callsites are
      // more useful for reconstructing a flow, so they win ties over text hits.
      ranges.push({
        start, end: Math.min(end, start + 5), nodeIds: [node.id], reason: "signature",
        priority: basePriority, rangeKind: "signature", intrinsicallyTruncated: end > start + 5,
      });
      const relevantCallsites = callsiteLines.filter((line) => line >= start && line <= end);
      const relevantQueryLines = queryLines.filter((line) => line >= start && line <= end);
      const seenLines = new Set<number>();
      const windowLines: Array<{ line: number; reason: "callsite" | "query-hit" }> = [];
      for (const line of relevantCallsites) {
        if (seenLines.has(line)) continue;
        seenLines.add(line);
        windowLines.push({ line, reason: "callsite" });
      }
      for (const line of relevantQueryLines) {
        if (seenLines.has(line)) continue;
        seenLines.add(line);
        windowLines.push({ line, reason: "query-hit" });
      }
      for (const [windowIndex, hit] of windowLines.slice(0, 2).entries()) {
        ranges.push({
          start: Math.max(start, hit.line - 12), end: Math.min(end, hit.line + 12), nodeIds: [node.id],
          reason: hit.reason, priority: basePriority + windowIndex + 1, rangeKind: "window",
        });
      }
    }

    // Text-only files do not have trustworthy node spans. Return no more than
    // two real 25-line windows, preferring precise query/callsite lines and then
    // falling back to the centers of matching FTS chunks.
    if (nodes.length === 0) {
      const seenLines = new Set<number>();
      const liveWindows: Array<{ line: number; reason: "callsite" | "query-hit" | "text-only" }> = [];
      for (const line of callsiteLines) {
        if (seenLines.has(line)) continue;
        seenLines.add(line);
        liveWindows.push({ line, reason: "callsite" });
      }
      for (const line of queryLines) {
        if (seenLines.has(line)) continue;
        seenLines.add(line);
        liveWindows.push({ line, reason: "query-hit" });
      }
      for (const hit of textHits) {
        const line = Math.floor((hit.startLine + hit.endLine) / 2);
        if (seenLines.has(line)) continue;
        seenLines.add(line);
        liveWindows.push({ line, reason: "text-only" });
      }
      for (const [index, hit] of liveWindows.slice(0, 2).entries()) {
        ranges.push({
          start: Math.max(1, hit.line - 12), end: Math.min(lines.length, hit.line + 12), nodeIds: [],
          reason: hit.reason, priority: index, rangeKind: "window",
        });
      }
    }
  }

  const merged = normalizeSourceRanges(ranges, 10);
  let remaining = lineBudget;
  const out: SourceRange[] = [];
  for (const range of merged) {
    if (remaining <= 0) break;
    const end = Math.min(range.end, range.start + remaining - 1);
    const selected = lines.slice(range.start - 1, end);
    out.push({
      startLine: range.start, endLine: end, nodeIds: range.nodeIds,
      content: numbered(selected, range.start),
      truncated: Boolean(range.intrinsicallyTruncated) || end < range.end,
      reason: range.reason,
    });
    remaining -= selected.length;
  }
  return out;
}

function normalizeSourceRanges<T extends {
  start: number;
  end: number;
  nodeIds: string[];
  reason: SourceRange["reason"];
  priority: number;
  rangeKind: "whole" | "symbol" | "signature" | "window";
  intrinsicallyTruncated?: boolean;
}>(
  ranges: T[],
  gap: number,
): T[] {
  const valid = ranges.filter((range) => range.end >= range.start)
    .map((range) => ({ ...range, nodeIds: [...new Set(range.nodeIds)] }));

  // A complete parent already carries its child's source. Keep the parent once,
  // but retain every covered node id so source-backed fact accounting is exact.
  const symbols: T[] = [];
  for (const range of valid.filter((entry) => entry.rangeKind === "symbol")
    .sort((left, right) => left.start - right.start || right.end - left.end || left.priority - right.priority)) {
    const container = symbols.find((entry) => entry.start <= range.start && entry.end >= range.end);
    if (container) {
      container.nodeIds = [...new Set([...container.nodeIds, ...range.nodeIds])];
      container.priority = Math.min(container.priority, range.priority);
      continue;
    }
    symbols.push({ ...range });
  }

  // Only source windows use the ten-line coalescing rule. This avoids turning
  // adjacent but distinct declarations into one oversized pseudo-symbol.
  const windows: T[] = [];
  for (const range of valid.filter((entry) => entry.rangeKind === "window")
    .sort((left, right) => left.start - right.start || left.end - right.end || left.priority - right.priority)) {
    const prior = windows.at(-1);
    if (prior && range.start <= prior.end + gap + 1) {
      prior.end = Math.max(prior.end, range.end);
      prior.nodeIds = [...new Set([...prior.nodeIds, ...range.nodeIds])];
      if (range.priority < prior.priority) {
        prior.priority = range.priority;
        prior.reason = range.reason;
      }
    } else windows.push({ ...range });
  }

  const base = [
    ...valid.filter((entry) => entry.rangeKind === "whole" || entry.rangeKind === "signature"),
    ...symbols,
  ];
  const keptWindows: T[] = [];
  for (const window of windows) {
    const containing = base.find((range) => range.start <= window.start && range.end >= window.end);
    if (containing) {
      containing.nodeIds = [...new Set([...containing.nodeIds, ...window.nodeIds])];
      containing.priority = Math.min(containing.priority, window.priority);
      continue;
    }
    // Eliminate overlapping lines without widening near-but-disjoint ranges.
    const overlapping = base.find((range) => range.start <= window.end && range.end >= window.start);
    if (overlapping) {
      overlapping.start = Math.min(overlapping.start, window.start);
      overlapping.end = Math.max(overlapping.end, window.end);
      overlapping.nodeIds = [...new Set([...overlapping.nodeIds, ...window.nodeIds])];
      overlapping.priority = Math.min(overlapping.priority, window.priority);
      continue;
    }
    keptWindows.push(window);
  }

  return [...base, ...keptWindows].sort((left, right) =>
    left.priority - right.priority || left.start - right.start || left.end - right.end);
}

function numbered(lines: string[], startLine: number): string {
  const width = String(startLine + Math.max(0, lines.length - 1)).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width)}: ${line}`).join("\n");
}

export function groupByFile(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const bucket = groups.get(node.filePath);
    if (bucket) bucket.push(node); else groups.set(node.filePath, [node]);
  }
  return groups;
}

export function sourceHash(filePath: string, rootDir: string): string | null {
  try { return createHash("sha256").update(readFileSync(resolve(rootDir, filePath))).digest("hex"); }
  catch { return null; }
}
