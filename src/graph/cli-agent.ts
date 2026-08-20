import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { globSync } from "glob";
import { createGraphEngine, graphManifest } from "./engine-impl.js";
import type { GraphEngine, GraphNeighbor, IndexedFileInfo } from "./engine.js";
import { openGraphDatabase } from "./db/database.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { isSupportedSourceFile, SUPPORTED_SOURCE_GLOB } from "./extraction/index.js";
import type { GraphEdge, GraphNode } from "./types.js";
import {
  compactFact, groupByFile, planFileSource, readNodeSource, selectScope, sourceHash,
  type CompactFact, type DetailLevel, type RankedScopeFile, type ScopedCandidate, type SourceRange,
} from "./scope.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { serializeFingerprint } from "./fingerprint.js";
import {
  BudgetLedger, estimateTokens, resolveOptions, resolveScopeOptions, SCHEMA_VERSION, type AgentOptions,
} from "./agent-protocol.js";
import { identifierComponents, isLowValueGraphPath, planGraphQuery } from "./retrieval/query.js";
import { GraphRebuildRequiredError } from "./errors.js";

type QueryRelation = "who-calls" | "what-calls" | "where-defined";

interface AgentGraphSession {
  graph: GraphEngine;
  db: SqliteDatabase;
  close(): void;
}

export interface AgentCommandDeps {
  open?: (rootDir: string) => AgentGraphSession;
  write?: (line: string) => void;
}

type RawOptions = Partial<Record<keyof AgentOptions, unknown>>;
type Rec = Record<string, unknown>;

/** Agent-facing blast radius. Output is newline-delimited JSON (JSONL). */
export function runImpact(
  target: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const fileNodes = nodesForFile(session, rootDir, target);
    const roots = fileNodes.length > 0 ? fileNodes : resolveSymbol(session.graph, target);
    if (roots.length === 0) {
      writeJson(write, { type: "error", code: "TARGET_NOT_FOUND", target });
      return;
    }
    if (fileNodes.length === 0 && roots.length > 1) {
      writeJson(write, { type: "error", code: "TARGET_AMBIGUOUS", target, candidates: roots.map(nodeRef) });
      return;
    }

    // Definitions (roots) and transitive callers share one `maxNodes` cap on returned nodes.
    const rootsSorted = roots.sort(byId);
    const ctx = beginResponse("impact", opts, undefined,
      rootsSorted.length > 0 ? [`mex graph get ${rootsSorted[0]!.id} --detail source`] : []);
    const ledger = ctx.ledger;
    const meta = ctx.meta;

    const headRecords: Rec[] = [];  // `target` — data, but not a graph fact
    const factRecords: Rec[] = [];  // `defines` + `caller` — real facts, eligible for source
    const emittedNodes: GraphNode[] = [];
    let truncated = false;

    const targetRecord: Rec = { type: "target", targetType: fileNodes.length > 0 ? "file" : "symbol", value: target };
    if (ledger.tryAdd(targetRecord)) headRecords.push(targetRecord); else truncated = true;

    for (const root of rootsSorted) {
      if (emittedNodes.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, root.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const record: Rec = { type: "defines", ...agentFactFields(fact, opts) };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      factRecords.push(record);
      emittedNodes.push(root);
    }

    const impacted = new Map<string, { node: GraphNode; depth: number; root: string }>();
    for (const root of rootsSorted) {
      for (const entry of transitiveCallers(session.graph, root, opts.depth)) {
        const current = impacted.get(entry.node.id);
        if (!current || entry.depth < current.depth) impacted.set(entry.node.id, { ...entry, root: root.id });
      }
    }
    const ordered = [...impacted.values()].sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id));
    for (const entry of ordered) {
      if (emittedNodes.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, entry.node.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const record: Rec = { type: "caller", depth: entry.depth, root: entry.root, ...agentFactFields(fact, opts) };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      factRecords.push(record);
      emittedNodes.push(entry.node);
    }

    const sourceRecords = planSource(ledger, emittedNodes, rootDir, opts);

    const affectedIds = [...new Set([...roots.map((node) => node.id), ...impacted.keys()])];
    const groundingRecords: Rec[] = [];
    for (const grounding of groundedFiles(session.db, affectedIds)) {
      const record: Rec = { type: "grounding", node: grounding.node_id, file: grounding.scaffold_file };
      if (ledger.tryAdd(record)) groundingRecords.push(record); else truncated = true;
    }

    emitAll(write, meta, [...headRecords, ...factRecords, ...sourceRecords, ...groundingRecords]);
    write(JSON.stringify(summaryRecord(ctx, {
      matchedNodes: roots.length + impacted.size,
      returnedNodes: emittedNodes.length,
      returnedEdges: 0,
      truncated,
      suggestedNextCommands: emittedNodes.length > 0 ? [`mex graph get ${emittedNodes[0]!.id} --detail source`] : [],
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Structural graph lookup. Output is newline-delimited JSON (JSONL). */
export function runGraphQuery(
  relation: string,
  target: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  if (!isRelation(relation)) {
    writeJson(write, { type: "error", code: "INVALID_QUERY", relation, expected: ["who-calls", "what-calls", "where-defined"] });
    return;
  }
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const nodes = resolveSymbol(session.graph, target);
    if (nodes.length === 0) {
      writeJson(write, { type: "error", code: "TARGET_NOT_FOUND", target });
      return;
    }

    // Preserve (queried target, result) pairs; dedupe by that pair, not by result id alone.
    const pairs: Array<{ targetId: string; node: GraphNode }> = [];
    const seen = new Set<string>();
    for (const queried of nodes.sort(byId)) {
      const related = relation === "where-defined" ? [queried] : relatedCallNodes(session.graph, queried, relation);
      for (const node of related) {
        const key = `${queried.id} ${node.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ targetId: queried.id, node });
      }
    }

    const anticipated = pairs.length > 0 && opts.detail !== "source"
      ? [`mex graph get ${pairs[0]!.node.id} --detail source`] : [];
    const ctx = beginResponse(`graph query ${relation}`, opts, undefined, anticipated);
    const ledger = ctx.ledger;
    const meta = ctx.meta;

    const entries: Array<{ record: Rec; node: GraphNode }> = [];
    let truncated = false;
    for (const pair of pairs) {
      if (entries.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, pair.node.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const record: Rec = { type: "result", relation, target: pair.targetId, ...agentFactFields(fact, opts) };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      entries.push({ record, node: pair.node });
    }

    const sourceRecords = planSource(ledger, entries.map((e) => e.node), rootDir, opts);

    emitAll(write, meta, [...entries.map((e) => e.record), ...sourceRecords]);
    write(JSON.stringify(summaryRecord(ctx, {
      matchedNodes: pairs.length,
      returnedNodes: entries.length,
      returnedEdges: 0,
      truncated,
      suggestedNextCommands: entries.length > 0 && opts.detail !== "source" ? [`mex graph get ${entries[0]!.node.id} --detail source`] : [],
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Broad graph retrieval. One source-bearing response is the normal success path. */
export function runGraphScope(
  task: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const indexedFiles = session.graph.getIndexedFiles?.() ?? [];
    const opts = resolveScopeOptions(rawOptions, indexedFiles.length);
    const staleFiles = indexedFiles.filter((file) => {
      const liveHash = sourceHash(file.path, rootDir);
      return liveHash !== file.contentHash;
    }).map((file) => file.path);
    const unindexedFiles = liveUnindexedFiles(indexedFiles, rootDir);
    const stale = new Set(staleFiles);
    const unindexed = new Set(unindexedFiles);
    const selection = selectScope(session.graph, task, opts.maxNodes, opts.maxFiles);
    // Indexed node/chunk hits describe the previous atomic snapshot. Once a
    // file's content hash changes, discard those file candidates completely;
    // only a fresh live-text match may admit the file back as text-only.
    selection.files = selection.files.filter((file) => !stale.has(file.filePath));
    for (const fallback of liveStaleFallbacks(
      indexedFiles, [...new Set([...staleFiles, ...unindexedFiles])], task, rootDir,
    )) {
      const existing = selection.files.find((file) => file.filePath === fallback.filePath);
      if (existing) {
        existing.score = Math.max(existing.score, fallback.score);
        existing.reasons = [...new Set([...existing.reasons, ...fallback.reasons])].sort();
        existing.textHits = dedupeTextHits([...fallback.textHits, ...existing.textHits]);
        existing.textOnly = true;
      } else selection.files.push(fallback);
      for (const term of fallback.textHits.flatMap((hit) => hit.matchedTerms ?? [])) {
        if (!selection.coveredTerms.includes(term)) selection.coveredTerms.push(term);
      }
    }
    selection.files.sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));
    selection.files.splice(opts.maxFiles);
    const ctx = beginResponse("graph scope", opts, task, []);
    const ledger = ctx.ledger;
    const meta = ctx.meta;
    const health = {
      type: "health",
      indexedFiles: indexedFiles.length,
      okFiles: indexedFiles.filter((file) => file.parseStatus === "ok").length,
      partialFiles: indexedFiles.filter((file) => file.parseStatus === "partial").length,
      failedFiles: indexedFiles.filter((file) => file.parseStatus === "failed").length,
      staleFiles: [...new Set([...staleFiles, ...unindexedFiles])],
    } satisfies Rec;
    const healthRecords: Rec[] = ledger.tryAdd(health) ? [health] : [];
    let truncated = healthRecords.length === 0;

    const nodeById = new Map<string, GraphNode>();
    for (const candidate of selection.candidates) {
      const node = session.graph.getNode(candidate.id);
      if (node) nodeById.set(node.id, node);
    }
    const allFlowNodeIds = new Set(selection.flows.flatMap((flow) => flow.steps)
      .flatMap((edge) => [edge.source, edge.target]));
    for (const id of allFlowNodeIds) {
      if (nodeById.has(id)) continue;
      const node = session.graph.getNode(id);
      if (node) nodeById.set(id, node);
    }
    for (const file of selection.files) {
      for (const id of file.nodeIds) {
        if (nodeById.has(id)) continue;
        const node = session.graph.getNode(id);
        if (node) nodeById.set(id, node);
      }
    }
    // A changed file invalidates the locations and bindings of every structural
    // claim touching it. Keep those rows in the old atomic snapshot for other
    // queries, but Scope may only expose the live file as text-only evidence.
    const trustworthyFlows = capFlowSteps(selection.flows.filter((flow) => flow.steps.every((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      return source && target && !stale.has(source.filePath) && !stale.has(target.filePath);
    })), opts.maxFlowSteps);
    const exactNodeOrder = new Map(selection.candidates
      .filter((candidate) => candidate.reasons.some((reason) => reason.startsWith("exact:")))
      .map((candidate, index) => [candidate.id, index]));
    const sourceRegionCandidateIds = new Set(selection.candidates
      .filter((candidate) => candidate.reasons.some((reason) => reason === "source-region"
        || reason.startsWith("source-region:")))
      .map((candidate) => candidate.id));
    const authoritativeSourceRegionIds = new Set(selection.candidates
      .filter((candidate) => candidate.reasons.includes("source-region"))
      .map((candidate) => candidate.id));
    // Scope supplies file.nodeIds in region-relevance order. Preserve that
    // order for every declaration-aligned source hit so direct source evidence
    // precedes an inferred flow body. These regions affect source order only;
    // they do not all become mandatory omission checks below.
    const sourceRegionNodeOrder = new Map<string, number>();
    for (const file of selection.files) {
      for (const id of file.nodeIds) {
        if (sourceRegionCandidateIds.has(id) && !sourceRegionNodeOrder.has(id)) {
          sourceRegionNodeOrder.set(id, sourceRegionNodeOrder.size);
        }
      }
    }
    const flowNodeOrder = new Map([...new Set(trustworthyFlows.flatMap((flow) => flow.steps)
      .flatMap((edge) => [edge.source, edge.target]))].map((id, index) => [id, index]));
    const highPriorityFlowNodeIds = [...new Set((trustworthyFlows[0]?.steps ?? [])
      .flatMap((edge) => [edge.source, edge.target]))];
    const namedHighPriorityFlowNodeIds = highPriorityFlowNodeIds
      .filter((id) => isNamedSourceNode(nodeById.get(id)));
    const semanticQuerySourceId = bestSemanticQuerySourceCandidate(
      task, selection.candidates, selection.files, nodeById,
    );
    const authoritativeSourceNodeOrder = new Map([...sourceRegionNodeOrder]
      .filter(([id]) => authoritativeSourceRegionIds.has(id)));
    const primaryAuthoritativeNodeIds = cappedPrimaryNodeIds(
      [authoritativeSourceNodeOrder.keys()], nodeById, RESERVED_PRIMARY_DECLARATIONS_PER_FILE,
    );
    // PascalCase words inside a rich NL question can look exact while being
    // only incidental context. Globally pin one exact winner only when the
    // request contains at most one other repository concept; all exact matches
    // remain reserved within their ordinary file order below.
    const rawQueryConcepts = new Set(planGraphQuery(task).terms.map((term) => term.raw.toLowerCase()));
    const globalExactIds = rawQueryConcepts.size <= 2 ? [...exactNodeOrder.keys()].slice(0, 1) : [];
    const flowAnswerCandidateIds = new Set(trustworthyFlows.flatMap((flow) => flow.steps)
      .flatMap((edge) => [edge.source, edge.target])
      .filter((id) => isNamedSourceNode(nodeById.get(id))));
    // The displayed path's terminal target is the result the flow explains.
    // Reserve at most that one named declaration globally; anonymous callback
    // bridges remain visible without consuming a complete body.
    const firstFlowTarget = [...(trustworthyFlows[0]?.steps ?? [])].reverse()
      .map((edge) => edge.target)
      .find((id) => isHealthySourceNode(id, selection.files, nodeById));
    const namedFirstFlowTargetIds = firstFlowTarget ? [firstFlowTarget] : [];
    const reservedPrimaryNodeIds = new Set([
      ...exactNodeOrder.keys(), ...namedFirstFlowTargetIds,
      ...(semanticQuerySourceId ? [semanticQuerySourceId] : []),
      ...primaryAuthoritativeNodeIds,
    ]);
    const globallyReservedSourceOrder = new Map<string, number>();
    for (const id of globalExactIds) {
      if (!globallyReservedSourceOrder.has(id)) {
        globallyReservedSourceOrder.set(id, globallyReservedSourceOrder.size);
      }
    }
    for (const id of namedFirstFlowTargetIds) {
      if (!globallyReservedSourceOrder.has(id)) {
        globallyReservedSourceOrder.set(id, globallyReservedSourceOrder.size);
      }
    }
    if (semanticQuerySourceId && !globallyReservedSourceOrder.has(semanticQuerySourceId)) {
      globallyReservedSourceOrder.set(semanticQuerySourceId, globallyReservedSourceOrder.size);
    }

    // The source planner uses the same authority order. Additional trusted
    // flow and source-region nodes remain eligible as bounded, non-mandatory
    // answers after the reserved declarations.
    const primaryNodeOrder = new Map<string, number>();
    for (const id of exactNodeOrder.keys()) {
      if (!primaryNodeOrder.has(id)) primaryNodeOrder.set(id, primaryNodeOrder.size);
    }
    for (const id of namedFirstFlowTargetIds) {
      if (!primaryNodeOrder.has(id)) primaryNodeOrder.set(id, primaryNodeOrder.size);
    }
    if (semanticQuerySourceId && !primaryNodeOrder.has(semanticQuerySourceId)) {
      primaryNodeOrder.set(semanticQuerySourceId, primaryNodeOrder.size);
    }
    for (const id of primaryAuthoritativeNodeIds) {
      if (!primaryNodeOrder.has(id)) primaryNodeOrder.set(id, primaryNodeOrder.size);
    }
    // Displayed flows retain their directed order: endpoints on the first flow
    // lead the remaining named semantic nodes.
    for (const id of namedHighPriorityFlowNodeIds) {
      if (!primaryNodeOrder.has(id)) primaryNodeOrder.set(id, primaryNodeOrder.size);
    }
    for (const id of flowNodeOrder.keys()) {
      if (flowAnswerCandidateIds.has(id) && !primaryNodeOrder.has(id)) {
        primaryNodeOrder.set(id, primaryNodeOrder.size);
      }
    }
    for (const id of authoritativeSourceNodeOrder.keys()) {
      if (!primaryNodeOrder.has(id)) primaryNodeOrder.set(id, primaryNodeOrder.size);
    }
    for (const id of sourceRegionNodeOrder.keys()) {
      if (!primaryNodeOrder.has(id)) primaryNodeOrder.set(id, primaryNodeOrder.size);
    }

    const plannedSources: Rec[] = [];
    const highPrioritySourceFiles = new Set<string>();
    // Source coverage is mandatory for the strongest cohesive graph file and
    // the bounded global reservations (dominant exact lookup, one terminal
    // flow target, one corroborated NL candidate). Other bridge/helper bodies
    // may still be omitted while their trustworthy relationship remains in the
    // displayed flow record.
    const highPrioritySourceExpectations = new Map<string, SourceRange[]>();
    if (opts.detail === "source") {
      const sourceFiles = [...selection.files].sort((left, right) => {
        // File cohesion is the primary retrieval decision. Exact-symbol and
        // flow-spine order break ties, but must not let a weak project-name hit
        // consume the source budget ahead of a substantially stronger region.
        const scoreDelta = right.score - left.score;
        if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
        const leftExact = firstNodeOrderInFile(exactNodeOrder, nodeById, left.filePath);
        const rightExact = firstNodeOrderInFile(exactNodeOrder, nodeById, right.filePath);
        if (leftExact !== rightExact) return leftExact - rightExact;
        const leftFlow = firstNodeOrderInFile(flowNodeOrder, nodeById, left.filePath);
        const rightFlow = firstNodeOrderInFile(flowNodeOrder, nodeById, right.filePath);
        return leftFlow - rightFlow || left.filePath.localeCompare(right.filePath);
      });
      // The strongest healthy graph-backed file is the unnamed-query fallback
      // primary. A text-only top hit cannot satisfy graph trust by itself and
      // must instead produce a degraded response when no named graph answer is
      // available.
      const primaryGraphFile = sourceFiles.find((file) => (
        !file.textOnly && file.parseStatus === "ok" && file.nodeIds.length > 0
      ));
      if (primaryGraphFile) highPrioritySourceFiles.add(primaryGraphFile.filePath);
      for (const id of globallyReservedSourceOrder.keys()) {
        const node = nodeById.get(id);
        if (node) highPrioritySourceFiles.add(node.filePath);
      }
      for (const file of sourceFiles) {
        // Admission quotas decide which declarations are serialized first;
        // they must not remove declarations before source planning. In
        // particular, a later authoritative region or displayed-flow endpoint
        // may be the only complete source answer in the file.
        const orderedIds = [...new Set([
          ...[...primaryNodeOrder.keys()]
            .filter((id) => nodeById.get(id)?.filePath === file.filePath),
          ...file.nodeIds,
        ])];
        const fileNodes = file.textOnly || stale.has(file.filePath) || unindexed.has(file.filePath) ? []
          : dedupeById(orderedIds.map((id) => nodeById.get(id))
            .filter((node): node is GraphNode => Boolean(node)));
        const callsites = trustworthyFlows.flatMap((flow) => flow.steps)
          .filter((edge) => nodeById.get(edge.source)?.filePath === file.filePath)
          .map((edge) => edge.line).filter((line): line is number => line !== undefined);
        // `maxSourceLines` is a per-symbol override. A cohesive file can carry
        // more than one complete symbol; the response ledger remains the hard
        // aggregate output bound.
        const fileLineBudget = Math.min(400, opts.maxSourceLines * Math.max(1, Math.min(fileNodes.length, 2)));
        const ranges = planFileSource(
          file.filePath, fileNodes, file.textHits, rootDir, task, fileLineBudget, callsites,
        );
        if (ranges.length === 0) continue;
        if (highPrioritySourceFiles.has(file.filePath)) {
          const expectations: SourceRange[] = [];
          if (file.filePath === primaryGraphFile?.filePath) {
            mergeAdmissionRange(expectations, ranges[0]!);
          }
          for (const id of globallyReservedSourceOrder.keys()) {
            const node = nodeById.get(id);
            if (!node || node.filePath !== file.filePath) continue;
            const rangeIndex = bestDeclarationRangeIndex(ranges, node);
            const expected = rangeIndex >= 0
              ? completeDeclarationRange(ranges[rangeIndex]!, node)
                ?? declarationAnchor(ranges[rangeIndex]!, node, SOURCE_DECLARATION_ANCHOR_LINES)
              : null;
            if (expected) mergeAdmissionRange(expectations, expected);
          }
          if (expectations.length > 0) highPrioritySourceExpectations.set(file.filePath, expectations);
        }
        const textOnly = file.textOnly || file.parseStatus !== "ok" || stale.has(file.filePath)
          || selection.evidenceStrength === "weak";
        plannedSources.push({
          type: "source", filePath: file.filePath, ranges,
          evidence: textOnly ? "text-only" : "graph",
          ...(stale.has(file.filePath) ? { stale: true } : {}),
          ...(unindexed.has(file.filePath) ? { unindexed: true } : {}),
        });
      }
    }

    // Source is the high-value payload. Give it 75% first, then let unused
    // flow/fact capacity spill back into deferred source records.
    const plannedFlowRecords = trustworthyFlows.flatMap((flow) => {
      const record = scopeFlowRecord(flow, nodeById, opts.maxFlowSteps);
      return record ? [record] : [];
    });
    const summaryTokenReserve = estimateTokens(summarySkeleton([])) + RESERVE_PAD;
    const sourceRecords: Rec[] = [];
    const deferredSources: Array<{
      record: Rec; atomic: boolean; phase: SourceAdmissionPhase;
    }> = [];
    let sourceTokens = 0;
    // Percentages apply to the payload after mandatory meta/health/summary
    // framing. Applying 75% to the whole response silently consumed the flow
    // allotment because the summary reserve is deliberately conservative.
    const remainingPayload = Math.max(
      0,
      ctx.effectiveMax - ledger.estimatedTokens - estimateTokens(summarySkeleton([])) - RESERVE_PAD,
    );
    const sourceShare = Math.floor(remainingPayload * 0.75);
    const boundedFlowShare = Math.floor(remainingPayload * 0.15);
    let flowTokenReserve = 0;
    for (const [index, planned] of plannedFlowRecords.entries()) {
      const tokens = estimateTokens(planned.record);
      if (index > 0 && flowTokenReserve + tokens > boundedFlowShare) break;
      flowTokenReserve += tokens;
    }
    // Schedule bounded answer declarations before cross-file fairness. Once an
    // answer reaches the source-share boundary, hold every lower-priority
    // header/body until all other compact answers have had a chance to fit.
    let deferLowerPrioritySources = false;
    const sourceAdmissions = coalesceSourceAdmissions(prioritizeSourceAdmissions(
      plannedSources, primaryNodeOrder, exactNodeOrder, flowAnswerCandidateIds,
      reservedPrimaryNodeIds, globallyReservedSourceOrder, nodeById,
    ), nodeById);
    for (const planned of sourceAdmissions) {
      const { record, phase } = planned;
      // A large atomic answer may fail the source-share fit while a later
      // compact answer still fits. Continue trying answer admissions, but hold
      // every secondary-file fairness/header/body admission until primary
      // answers have had their reserved hard-ledger spill opportunity.
      if (deferLowerPrioritySources && phase !== "answer") {
        deferredSources.push({ record, atomic: planned.atomic, phase });
        continue;
      }
      const admission = admitSourceWithinShare(
        record, sourceShare - sourceTokens, ledger, planned.atomic,
      );
      sourceRecords.push(...admission.admitted);
      sourceTokens += admission.tokens;
      truncated ||= admission.trimmed;
      let unresolved = admission.deferred;
      // A complete answer that only crossed the 75% source-share boundary gets
      // its hard-ledger opportunity immediately. Letting later small answers
      // spend that capacity first starved the earlier, stronger declaration.
      if (phase === "answer" && planned.atomic && unresolved.length > 0) {
        const stillDeferred: Rec[] = [];
        for (const deferred of unresolved) {
          const spill = admitSourceWithinShare(
            deferred,
            Math.max(
              0,
              ctx.effectiveMax - ledger.estimatedTokens - summaryTokenReserve - flowTokenReserve,
            ),
            ledger,
            true,
          );
          sourceRecords.push(...spill.admitted);
          sourceTokens += spill.tokens;
          stillDeferred.push(...spill.deferred);
          truncated ||= spill.trimmed;
        }
        unresolved = stillDeferred;
      }
      deferredSources.push(...unresolved.map((deferred) => ({
        record: deferred, atomic: planned.atomic, phase,
      })));
      // Once a complete answer declaration reaches the source-share boundary,
      // lower-priority signatures/bodies must not consume the hard ledger before
      // that declaration gets its whole-record spill opportunity.
      if (phase === "answer" && unresolved.length > 0) {
        deferLowerPrioritySources = true;
      }
    }

    // Complete answer declarations are more valuable than secondary-file
    // fairness. If one crossed only the 75% source-share boundary, give it one
    // whole-record hard-ledger spill opportunity now while reserving the first
    // directed flow and summary. Ordinary source (including atomic whole-file
    // fairness records) stays deferred until after flows.
    const ordinaryDeferredSources: Array<{
      record: Rec; atomic: boolean;
    }> = [];
    for (const deferred of deferredSources) {
      if (!deferred.atomic || deferred.phase !== "answer") {
        ordinaryDeferredSources.push(deferred);
        continue;
      }
      const spill = admitSourceWithinShare(
        deferred.record,
        Math.max(
          0,
          ctx.effectiveMax - ledger.estimatedTokens - summaryTokenReserve - flowTokenReserve,
        ),
        ledger,
        true,
      );
      sourceRecords.push(...spill.admitted);
      if (spill.trimmed || spill.deferred.length > 0) truncated = true;
    }

    const flowRecords: Rec[] = [];
    let returnedEdges = 0;
    for (const { record, stepCount } of plannedFlowRecords) {
      if (ledger.tryAdd(record)) {
        flowRecords.push(record);
        returnedEdges += stepCount;
      } else truncated = true;
    }

    for (const deferred of ordinaryDeferredSources) {
      const spill = admitSourceWithinShare(
        deferred.record, ctx.effectiveMax, ledger, deferred.atomic,
      );
      sourceRecords.push(...spill.admitted);
      if (spill.trimmed || spill.deferred.length > 0) truncated = true;
    }
    const sourcedIds = new Set(sourceRecords.flatMap((record) =>
      (record.ranges as SourceRange[]).flatMap((range) => range.nodeIds)));
    const flowIds = new Set(flowRecords.flatMap((record) =>
      (record.steps as Array<{ source: string; target: string }>).flatMap((step) => [step.source, step.target])));
    const facts: Array<{ record: Rec; node: GraphNode }> = [];
    for (const candidate of selection.candidates) {
      if (opts.detail === "source" && !sourcedIds.has(candidate.id) && !flowIds.has(candidate.id)) continue;
      const fact = factFor(session, candidate.id, opts.detail, opts.fingerprint);
      const node = nodeById.get(candidate.id);
      if (!fact || !node || stale.has(node.filePath)) continue;
      const record = scopeFactRecord(fact, candidate.score, candidate.reasons, opts);
      if (ledger.tryAdd(record)) facts.push({ record, node }); else truncated = true;
    }

    const finalSourcedIds = new Set(sourceRecords.flatMap((record) =>
      (record.ranges as SourceRange[]).flatMap((range) => range.nodeIds)));
    const returnedFiles = [...new Set(sourceRecords.map((record) => record.filePath as string))];
    const textFallbackFiles = [...new Set(sourceRecords.filter((record) => record.evidence === "text-only")
      .map((record) => record.filePath as string))];
    const omittedHighPrioritySourceFiles = [...highPrioritySourceFiles].filter((filePath) => {
      const expected = highPrioritySourceExpectations.get(filePath);
      if (!expected || expected.length === 0) return true;
      const emitted = sourceRecords.filter((record) => record.filePath === filePath)
        .flatMap((record) => record.ranges as SourceRange[]);
      return expected.some((wanted) => !sourceRangesCover(emitted, wanted));
    });
    const highPriorityFlowKeys = new Set((trustworthyFlows[0]?.steps ?? []).map(scopeEdgeKey));
    const returnedFlowKeys = new Set(flowRecords.flatMap((record) => (
      record.steps as GraphEdge[]
    )).map(scopeEdgeKey));
    const omittedHighPriorityFlowSteps = [...highPriorityFlowKeys]
      .filter((key) => !returnedFlowKeys.has(key)).length;
    const highPriorityEvidenceOmitted = omittedHighPrioritySourceFiles.length > 0
      || omittedHighPriorityFlowSteps > 0;
    const returnedGraphSourceFiles = new Set(sourceRecords
      .filter((record) => record.evidence === "graph")
      .map((record) => record.filePath as string));
    const omittedHighPrioritySourceSet = new Set(omittedHighPrioritySourceFiles);
    const hasTrustworthyGraphPrimary = [...highPrioritySourceFiles].some((filePath) => (
      returnedGraphSourceFiles.has(filePath) && !omittedHighPrioritySourceSet.has(filePath)
    ));
    // Text-only context is useful corroborating metadata, but it is also a
    // lossy fallback channel. Report that truncation without authorizing the
    // caller to abandon a complete graph-backed answer.
    if (textFallbackFiles.length > 0) truncated = true;
    const materiallyReliesOnTextOnly = textFallbackFiles.length > 0
      && !hasTrustworthyGraphPrimary;
    const warnings = [
      ...(health.failedFiles > 0 ? [`${health.failedFiles} indexed file(s) have failed structural parsing.`] : []),
      ...(health.partialFiles > 0 ? [`${health.partialFiles} indexed file(s) have partial structural parsing.`] : []),
      ...(staleFiles.length > 0
        ? [`${staleFiles.length} indexed file(s) differ from live source; matching live files use text-only evidence.`]
        : []),
      ...(unindexedFiles.length > 0
        ? [`${unindexedFiles.length} live source file(s) are not indexed; matching files use text-only evidence.`]
        : []),
      ...(highPriorityEvidenceOmitted
        ? [`High-priority evidence omitted: ${omittedHighPrioritySourceFiles.length} source file(s), ${omittedHighPriorityFlowSteps} flow step(s).`]
        : []),
    ];
    const status = returnedFiles.length === 0 && facts.length === 0 && flowRecords.length === 0
      ? "no-match"
      : highPriorityEvidenceOmitted ? "partial"
        : materiallyReliesOnTextOnly ? "degraded"
          : "ok";
    const suggestions = status === "partial" && facts.length > 0
      ? [`mex graph get ${facts[0]!.node.id} --detail source`] : [];

    emitAll(write, meta, [
      ...healthRecords,
      ...sourceRecords,
      ...flowRecords,
      ...facts.map((fact) => fact.record),
    ]);
    write(JSON.stringify(summaryRecord(ctx, {
      matchedNodes: selection.matchedCount,
      returnedNodes: facts.length,
      returnedEdges,
      truncated,
      suggestedNextCommands: suggestions,
      status,
      evidenceStrength: selection.evidenceStrength,
      coveredTerms: selection.coveredTerms,
      returnedFiles,
      sourceBackedNodes: [...finalSourcedIds],
      textFallbackFiles,
      warnings,
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Targeted source expansion by node id. Output is JSONL source records. */
export function runGraphGet(
  ids: string[],
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions({ ...rawOptions, detail: "source" });
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const ctx = beginResponse("graph get", { ...opts, maxNodes: ids.length, maxFlowSteps: 0 }, undefined, []);
    const { ledger, meta } = ctx;

    const nodes: GraphNode[] = [];
    const errorRecords: Rec[] = [];
    let truncated = false;
    for (const id of ids) {
      const node = session.graph.getNode(id);
      if (!node) {
        const record: Rec = { type: "error", code: "NODE_NOT_FOUND", id };
        if (ledger.tryAdd(record)) errorRecords.push(record); else truncated = true;
        continue;
      }
      nodes.push(node);
    }
    const sourceRecords = planSource(ledger, nodes, rootDir, opts);
    const sourcedIds = new Set(
      sourceRecords.flatMap((record) => (record.ranges as SourceRange[]).flatMap((range) => range.nodeIds)),
    );

    emitAll(write, meta, [...errorRecords, ...sourceRecords]);
    write(JSON.stringify(summaryRecord(ctx, {
      matchedNodes: ids.length,
      returnedNodes: sourcedIds.size,
      returnedEdges: 0,
      truncated,
      suggestedNextCommands: [],
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

// ── shared helpers ──────────────────────────────────────────────────────────

/** Stable worst-case width for numeric summary fields, so the reserve covers them. */
const SIZE_PROBE = 9_999_999;
/** Slack over the anticipated summary size (covers node-id/name length variance). */
const RESERVE_PAD = 16;
const SUMMARY_LIST_KEYS = [
  "sourceBackedNodes", "coveredTerms", "returnedFiles", "textFallbackFiles",
  "suggestedNextCommands", "warnings",
] as const;
type SummaryListKey = typeof SUMMARY_LIST_KEYS[number];
const SUMMARY_LIST_LIMITS: Record<SummaryListKey, number> = {
  sourceBackedNodes: 24,
  coveredTerms: 12,
  returnedFiles: 6,
  textFallbackFiles: 6,
  suggestedNextCommands: 3,
  warnings: 3,
};

interface ResponseCtx {
  ledger: BudgetLedger;
  meta: Rec;
  effectiveMax: number;
}

class OutputBudgetTooSmallError extends Error {
  readonly code = "INVALID_OUTPUT_BUDGET";

  constructor(requested: number, minimum: number) {
    super(`--max-output-tokens ${requested} cannot fit protocol framing; use at least ${minimum}.`);
    this.name = "OutputBudgetTooSmallError";
  }
}

/**
 * Set up a response so the token ceiling is genuinely hard. The summary reserve is
 * sized from the ACTUAL summary shape (its suggested commands can carry long node
 * ids/names). A requested ceiling below mandatory protocol framing is rejected:
 * silently increasing it would make budget-compliance results dishonest.
 * `anticipatedSuggestions` sizes the reserve; the final summary recomputes them
 * from what was actually returned (same fixed-width ids, so the reserve holds).
 */
function beginResponse(command: string, opts: AgentOptions, task: string | undefined, anticipatedSuggestions: string[]): ResponseCtx {
  const requested = opts.maxOutputTokens;
  const reserve = estimateTokens(summarySkeleton(anticipatedSuggestions)) + RESERVE_PAD;
  const framingFloor = estimateTokens(metaRecord(command, { ...opts, maxOutputTokens: SIZE_PROBE }, task)) + reserve;
  if (requested < framingFloor) throw new OutputBudgetTooSmallError(requested, framingFloor);
  const effectiveMax = requested;
  const meta = metaRecord(command, { ...opts, maxOutputTokens: effectiveMax }, task);
  const ledger = new BudgetLedger(effectiveMax, reserve);
  ledger.frame(meta);
  return { ledger, meta, effectiveMax };
}

function summarySkeleton(suggestions: string[]): Rec {
  return {
    type: "summary", matchedNodes: SIZE_PROBE, returnedNodes: SIZE_PROBE, returnedEdges: SIZE_PROBE,
    maxOutputTokens: SIZE_PROBE, truncated: true, suggestedNextCommands: suggestions, estimatedOutputTokens: SIZE_PROBE,
    status: "degraded", evidenceStrength: "moderate",
    coveredTerms: Array(12).fill("identifier-component"),
    returnedFiles: Array(6).fill("path/to/a/representative/source-file.ts"),
    sourceBackedNodes: Array(24).fill("method:0123456789abcdef0123456789abcdef"),
    textFallbackFiles: Array(6).fill("path/to/a/representative/source-file.ts"),
    warnings: Array(3).fill("Representative graph health warning."),
    omittedCounts: Object.fromEntries(SUMMARY_LIST_KEYS.map((key) => [key, SIZE_PROBE])),
  };
}

function metaRecord(command: string, opts: AgentOptions, task?: string): Rec {
  return {
    type: "meta", protocolVersion: SCHEMA_VERSION, schemaVersion: SCHEMA_VERSION, command,
    ...(task !== undefined ? { task } : {}),
    detail: opts.detail, maxNodes: opts.maxNodes, maxFiles: opts.maxFiles,
    maxFlowSteps: opts.maxFlowSteps, maxOutputTokens: opts.maxOutputTokens,
  };
}

function summaryRecord(
  ctx: ResponseCtx,
  fields: {
    matchedNodes: number;
    returnedNodes: number;
    returnedEdges: number;
    truncated: boolean;
    suggestedNextCommands: string[];
    status?: "ok" | "partial" | "degraded" | "no-match";
    evidenceStrength?: "strong" | "moderate" | "weak" | "none";
    coveredTerms?: string[];
    returnedFiles?: string[];
    sourceBackedNodes?: string[];
    textFallbackFiles?: string[];
    warnings?: string[];
  },
): Rec {
  const capped = capSummaryLists({
    sourceBackedNodes: fields.sourceBackedNodes ?? [],
    coveredTerms: fields.coveredTerms ?? [],
    returnedFiles: fields.returnedFiles ?? [],
    textFallbackFiles: fields.textFallbackFiles ?? [],
    suggestedNextCommands: fields.suggestedNextCommands,
    warnings: fields.warnings ?? [],
  });
  const omitted = Object.keys(capped.omittedCounts).length > 0;
  const defaultStatus = fields.status ?? (fields.returnedNodes > 0 ? "ok" : "no-match");
  const base: Rec = {
    type: "summary",
    matchedNodes: fields.matchedNodes,
    returnedNodes: fields.returnedNodes,
    returnedEdges: fields.returnedEdges,
    maxOutputTokens: ctx.effectiveMax,
    truncated: fields.truncated || omitted || ctx.ledger.droppedAny || ctx.ledger.overBudget,
    suggestedNextCommands: capped.values.suggestedNextCommands,
    // Summary-list clipping is metadata truncation, not missing retrieval
    // evidence. The caller owns status based on graph health and whether any
    // high-priority source or flow evidence was actually omitted.
    status: defaultStatus,
    evidenceStrength: fields.evidenceStrength ?? (fields.returnedNodes > 0 ? "strong" : "none"),
    coveredTerms: capped.values.coveredTerms,
    returnedFiles: capped.values.returnedFiles,
    sourceBackedNodes: capped.values.sourceBackedNodes,
    textFallbackFiles: capped.values.textFallbackFiles,
    warnings: capped.values.warnings,
    omittedCounts: capped.omittedCounts,
  };
  const working = Object.fromEntries(Object.entries(base).map(([key, value]) =>
    [key, Array.isArray(value) ? [...value] : value])) as Rec;
  working.omittedCounts = { ...(base.omittedCounts as Record<string, number>) };
  let summary = finalizedSummary(ctx.ledger.estimatedTokens, working);
  let pruned = false;
  while (ctx.ledger.estimatedTokens + estimateTokens(summary) > ctx.effectiveMax) {
    const candidates = SUMMARY_LIST_KEYS
      .map((key) => ({ key, values: working[key] as unknown[] }))
      .filter((entry) => entry.values.length > 0)
      .sort((left, right) => {
        const leftSize = estimateTokens(left.values.at(-1));
        const rightSize = estimateTokens(right.values.at(-1));
        return rightSize - leftSize || SUMMARY_LIST_KEYS.indexOf(left.key) - SUMMARY_LIST_KEYS.indexOf(right.key);
      });
    const candidate = candidates[0];
    if (!candidate) break;
    candidate.values.pop();
    const omittedCounts = working.omittedCounts as Record<string, number>;
    omittedCounts[candidate.key] = (omittedCounts[candidate.key] ?? 0) + 1;
    pruned = true;
    working.truncated = true;
    summary = finalizedSummary(ctx.ledger.estimatedTokens, working);
  }
  if (pruned) summary.truncated = true;
  // The framing floor guarantees the minimal summary fits. Account the actual
  // record so tests and consumers can compare the declared total to the stream.
  ctx.ledger.frame(summary);
  return summary;
}

function capSummaryLists(values: Record<SummaryListKey, string[]>): {
  values: Record<SummaryListKey, string[]>;
  omittedCounts: Partial<Record<SummaryListKey, number>>;
} {
  const capped = {} as Record<SummaryListKey, string[]>;
  const omittedCounts: Partial<Record<SummaryListKey, number>> = {};
  for (const key of SUMMARY_LIST_KEYS) {
    const unique = [...new Set(values[key])];
    const limit = SUMMARY_LIST_LIMITS[key];
    capped[key] = unique.slice(0, limit);
    if (unique.length > limit) omittedCounts[key] = unique.length - limit;
  }
  return { values: capped, omittedCounts };
}

function finalizedSummary(usedTokens: number, base: Rec): Rec {
  let estimatedOutputTokens = usedTokens + estimateTokens({ ...base, estimatedOutputTokens: SIZE_PROBE });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const record = { ...base, estimatedOutputTokens };
    const exact = usedTokens + estimateTokens(record);
    if (exact === estimatedOutputTokens) return record;
    estimatedOutputTokens = exact;
  }
  return { ...base, estimatedOutputTokens };
}

/**
 * Plan grouped-per-file source records for `nodes` (deduped by id) under the
 * ledger, only when detail is "source". Source ranges carry their node ids, so
 * facts do not repeat a mutable `sourceIncluded` flag.
 */
function planSource(ledger: BudgetLedger, nodes: GraphNode[], rootDir: string, opts: AgentOptions): Rec[] {
  if (opts.detail !== "source") return [];
  const sourceRecords: Rec[] = [];
  const emit = (record: Rec): void => {
    if (!ledger.tryAdd(record)) return;
    sourceRecords.push(record);
  };
  for (const [filePath, fileNodes] of groupByFile(dedupeById(nodes))) {
    const ranges = fileNodes
      .map((node) => readNodeSource(node, rootDir, opts.maxSourceLines))
      .filter((range): range is SourceRange => range !== null);
    if (ranges.length === 0) continue;
    const grouped: Rec = { type: "source", filePath, ranges };
    // Prefer one grouped record per file (dedups shared context); if it doesn't
    // fit, degrade to per-range records so partial source still lands.
    if (ledger.fits(grouped)) emit(grouped);
    else for (const range of ranges) emit({ type: "source", filePath, ranges: [range] });
  }
  return sourceRecords;
}

function emitAll(write: (line: string) => void, meta: Rec, records: Rec[]): void {
  write(JSON.stringify(meta));
  for (const record of records) write(JSON.stringify(record));
}

/**
 * Scope is the high-frequency discovery command, so its default manifest avoids
 * repeating response-level state on every fact. Source records already carry
 * node ids; `detail` lives in meta; hashes/reasons remain opt-in diagnostics.
 */
function agentFactFields(fact: CompactFact, opts: AgentOptions): Rec {
  const { detail: _detail, sourceIncluded: _sourceIncluded, bodyHash, qualifiedName, signature, ...core } = fact;
  const compactSignature = signature?.replace(/\s+/g, " ").trim();
  const signatureLimit = opts.detail === "standard" ? 320 : 180;
  return {
    ...core,
    ...(qualifiedName !== fact.name ? { qualifiedName } : {}),
    ...(compactSignature ? {
      signature: compactSignature.length <= signatureLimit
        ? compactSignature
        : `${compactSignature.slice(0, signatureLimit - 1)}…`,
    } : {}),
    ...(opts.fingerprint && bodyHash ? { bodyHash } : {}),
  };
}

function scopeFactRecord(fact: CompactFact, score: number, reasons: string[], opts: AgentOptions): Rec {
  return {
    type: "fact",
    ...agentFactFields(fact, opts),
    score,
    ...(opts.detail === "standard" ? { selectionReasons: reasons } : {}),
  };
}

function factFor(session: AgentGraphSession, id: string, detail: DetailLevel, includeFingerprint: boolean): CompactFact | null {
  const fact = compactFact(session.graph, id, detail);
  if (!fact || !includeFingerprint) return fact;
  const fingerprint = new FingerprintStore(session.db).get(id);
  return fingerprint ? { ...fact, fingerprint: serializeFingerprint(fingerprint) } : fact;
}

function dedupeById(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function cappedPrimaryNodeIds(
  groups: Iterable<string>[],
  nodes: Map<string, GraphNode>,
  perFileLimit: number,
): Set<string> {
  const selected = new Set<string>();
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const id of group) {
      if (selected.has(id)) continue;
      const node = nodes.get(id);
      if (!node) continue;
      const count = counts.get(node.filePath) ?? 0;
      if (count >= perFileLimit) continue;
      selected.add(id);
      counts.set(node.filePath, count + 1);
    }
  }
  return selected;
}

const SOURCE_GRAPH_SEMANTIC_REASONS = new Set([
  "graph:calls", "graph:instantiates", "graph:references",
]);

/**
 * Reserve one globally corroborated declaration for natural-language queries.
 * `term:*` reasons are produced only when Scope matched an indexed identifier
 * component. Requiring both a trusted callsite and its semantic edge prevents
 * lexical-only or merely enclosing helpers from becoming source answers.
 * Query inflections count once by their original raw concept.
 */
export function bestSemanticQuerySourceCandidate(
  task: string,
  candidates: ScopedCandidate[],
  files: RankedScopeFile[],
  nodes: Map<string, GraphNode>,
): string | undefined {
  const plan = planGraphQuery(task);
  const termConcept = new Map<string, {
    key: string; weight: number; literal: boolean; stem: boolean;
  }>();
  for (const term of plan.terms) {
    const key = term.raw.toLowerCase();
    const current = termConcept.get(term.term);
    if (!current || term.weight > current.weight) {
      termConcept.set(term.term, {
        key, weight: term.weight, literal: !term.stem, stem: term.stem,
      });
    }
  }
  const fileOrder = new Map(files.map((file, index) => [file.filePath, index]));
  const nodeOrder = new Map(files.flatMap((file) => file.nodeIds
    .map((id, index) => [id, index] as const)));
  const scored = candidates.flatMap((candidate, candidateIndex) => {
    const node = nodes.get(candidate.id);
    const selectedFile = node ? files[fileOrder.get(node.filePath) ?? -1] : undefined;
    if (!isNamedSourceNode(node) || !selectedFile || selectedFile.textOnly
      || selectedFile.parseStatus !== "ok" || node.endLine - node.startLine + 1 > 160
      || (!plan.asksForTests && isLowValueGraphPath(node.filePath))) return [];
    if (!candidate.reasons.includes("source-region:callsite")
      || !candidate.reasons.some((reason) => SOURCE_GRAPH_SEMANTIC_REASONS.has(reason))) return [];
    const identifierParts = new Set([node.name, node.qualifiedName, node.signature ?? ""]
      .flatMap((value) => (value.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])
        .flatMap(identifierComponents)));
    const leafIdentifierParts = new Set(identifierComponents(node.name));
    const identifierMatches = (term: string, stem: boolean): boolean => (
      identifierParts.has(term)
      || (stem && [...identifierParts].some((part) => part.startsWith(term)))
    );
    // At least one Scope term channel must independently land on the
    // declaration. Once that corroboration exists, score every query concept
    // visible in the declaration identity/signature. A channel records only
    // its first matching variant, so restricting the count to `term:*`
    // reasons can hide equally direct concepts (for example `planFileSource`
    // records `term:plan`, while `source` is still explicit in its name).
    const corroboratedConcepts = new Set<string>();
    for (const reason of candidate.reasons) {
      if (!reason.startsWith("term:")) continue;
      const reasonTerm = reason.slice("term:".length);
      const match = termConcept.get(reasonTerm);
      if (match && identifierMatches(reasonTerm, match.stem)) corroboratedConcepts.add(match.key);
    }
    if (corroboratedConcepts.size === 0) return [];
    const concepts = new Map<string, { weight: number; literal: boolean }>();
    const leafConcepts = new Set<string>();
    for (const term of plan.terms) {
      if (!identifierMatches(term.term, term.stem)) continue;
      const key = term.raw.toLowerCase();
      if (leafIdentifierParts.has(term.term)
        || (term.stem && [...leafIdentifierParts].some((part) => part.startsWith(term.term)))) {
        leafConcepts.add(key);
      }
      const current = concepts.get(key);
      const literal = !term.stem;
      if (!current || term.weight > current.weight || (term.weight === current.weight && literal)) {
        concepts.set(key, { weight: term.weight, literal });
      }
    }
    if (concepts.size < 2) return [];
    const semanticKind = candidate.reasons.includes("graph:calls") ? 3
      : candidate.reasons.includes("graph:instantiates") ? 2 : 1;
    return [{
      id: candidate.id,
      conceptCount: concepts.size,
      corroboratedConceptCount: corroboratedConcepts.size,
      leafConceptCount: leafConcepts.size,
      literalConceptCount: [...concepts.values()].filter((concept) => concept.literal).length,
      conceptWeight: [...concepts.values()].reduce((sum, concept) => sum + concept.weight, 0),
      semanticKind,
      bm25: candidate.reasons.includes("bm25-node"),
      fileOrder: fileOrder.get(node.filePath)!,
      nodeOrder: nodeOrder.get(candidate.id) ?? Number.MAX_SAFE_INTEGER,
      score: candidate.score,
      candidateIndex,
    }];
  });
  scored.sort((left, right) => right.leafConceptCount - left.leafConceptCount
    || right.corroboratedConceptCount - left.corroboratedConceptCount
    || right.conceptCount - left.conceptCount
    || right.literalConceptCount - left.literalConceptCount
    || right.conceptWeight - left.conceptWeight
    || right.semanticKind - left.semanticKind
    || Number(right.bm25) - Number(left.bm25)
    || right.score - left.score
    || left.fileOrder - right.fileOrder
    || left.nodeOrder - right.nodeOrder
    || left.candidateIndex - right.candidateIndex
    || left.id.localeCompare(right.id));
  return scored[0]?.id;
}

function isNamedSourceNode(node: GraphNode | undefined): node is GraphNode {
  return Boolean(node && node.name.length > 0 && !node.name.startsWith("<"));
}

function isHealthySourceNode(
  id: string,
  files: RankedScopeFile[],
  nodes: Map<string, GraphNode>,
): boolean {
  const node = nodes.get(id);
  if (!isNamedSourceNode(node)) return false;
  const file = files.find((entry) => entry.filePath === node.filePath);
  return Boolean(file && !file.textOnly && file.parseStatus === "ok");
}

function scopeFlowRecord(
  flow: { steps: GraphEdge[] },
  nodesById: Map<string, GraphNode>,
  maxSteps: number,
): { record: Rec; stepCount: number } | null {
  const steps = flow.steps.slice(0, maxSteps).map((edge) => ({
    source: edge.source, target: edge.target, kind: edge.kind,
    ...(edge.line !== undefined ? { line: edge.line } : {}),
    ...(edge.column !== undefined ? { column: edge.column } : {}),
    confidence: edge.confidence ?? 1,
    ...(edge.resolutionMethod ? { resolutionMethod: edge.resolutionMethod } : {}),
    ...(edge.provenance ? { provenance: edge.provenance } : {}),
  }));
  if (steps.length === 0) return null;
  const endpointIds = [...new Set(steps.flatMap((step) => [step.source, step.target]))];
  const nodes = endpointIds.flatMap((id) => {
    const node = nodesById.get(id);
    return node ? [{ id: node.id, name: node.name, filePath: node.filePath }] : [];
  });
  return { record: { type: "flow", nodes, steps }, stepCount: steps.length };
}

const RESERVED_PRIMARY_DECLARATIONS_PER_FILE = 3;
const PRIMARY_DECLARATION_ANCHORS_PER_FILE = 3;
const PRIMARY_FLOW_ANCHORS_PER_FILE = 3;
const SOURCE_DECLARATION_ANCHOR_LINES = 6;
type SourceAdmissionPhase = "fairness" | "answer" | "secondary" | "optional";
interface PlannedSourceAdmission {
  record: Rec;
  phase: SourceAdmissionPhase;
  atomic: boolean;
}

/**
 * Turn each selected file into round-robin declaration admissions followed by
 * optional bodies. A source-region hit can rank a nearby caller just ahead of
 * the declaration that actually answers the query; emitting the first complete
 * body in that case used to exhaust the file's only fair admission. Compact
 * declaration headers let the first three direct candidates, plus three
 * displayed-flow targets, compete without spending the budget on a
 * decoy body. Every file receives one compact admission first; then complete
 * source-aligned answers up to 160 lines are admitted round-robin before
 * remaining anchors and ordinary bodies. Explicit exact matches retain their
 * original complete range.
 */
function prioritizeSourceAdmissions(
  records: Rec[],
  primaryOrder: Map<string, number>,
  exactOrder: Map<string, number>,
  flowAnswerIds: Set<string>,
  reservedPrimaryIds: Set<string>,
  globallyReservedOrder: Map<string, number>,
  nodes: Map<string, GraphNode>,
): PlannedSourceAdmission[] {
  const plans = records.flatMap((record, recordIndex) => {
    const ranges = Array.isArray(record.ranges) ? record.ranges as SourceRange[] : [];
    const filePath = typeof record.filePath === "string" ? record.filePath : undefined;
    if (!filePath || ranges.length === 0) return [];

    // A planned whole file is already the smallest truthful source unit. Do
    // not turn a <=200-line answer back into signatures and tails during
    // cross-file fairness; either admit the complete record or omit it.
    const wholeFile = ranges.length === 1 && ranges[0]!.reason === "whole-file"
      && ranges[0]!.endLine - ranges[0]!.startLine + 1 <= 200;
    if (wholeFile) {
      const primary = recordIndex === 0
        || ranges[0]!.nodeIds.some((id) => reservedPrimaryIds.has(id));
      const directAnswer = !primary
        && ranges[0]!.nodeIds.some((id) => flowAnswerIds.has(id));
      const compactNodeId = [...primaryOrder.keys()].find((id) => (
        ranges[0]!.nodeIds.includes(id) && nodes.get(id)?.filePath === filePath
      )) ?? ranges[0]!.nodeIds[0];
      const compactNode = compactNodeId ? nodes.get(compactNodeId) : undefined;
      const compactAnchor = !primary && !directAnswer && compactNode
        ? declarationAnchor(ranges[0]!, compactNode, SOURCE_DECLARATION_ANCHOR_LINES)
        : null;
      const optionalRanges = compactAnchor
        ? subtractSourceIntervals(ranges[0]!, [{
          startLine: compactAnchor.startLine, endLine: compactAnchor.endLine,
        }], nodes)
        : [];
      return [{
        record,
        anchors: primary || directAnswer ? [] as SourceRange[] : [compactAnchor ?? ranges[0]!],
        answerRanges: primary ? [ranges[0]!] : [] as SourceRange[],
        directAnswerRanges: directAnswer ? [ranges[0]!] : [] as SourceRange[],
        optionalRanges,
      }];
    }

    const orderedIds = [...primaryOrder.keys()].filter((id) => nodes.get(id)?.filePath === filePath);
    let directAnchors = 0;
    let flowAnchors = 0;
    const selectedAsFlow = new Set<string>();
    const selectedIds = orderedIds.filter((id) => {
      if (reservedPrimaryIds.has(id)) return true;
      if (flowAnswerIds.has(id)) {
        flowAnchors += 1;
        if (flowAnchors <= PRIMARY_FLOW_ANCHORS_PER_FILE) {
          selectedAsFlow.add(id);
          return true;
        }
        return false;
      }
      directAnchors += 1;
      return directAnchors <= PRIMARY_DECLARATION_ANCHORS_PER_FILE;
    });
    const anchors: SourceRange[] = [];
    const answerRanges: SourceRange[] = [];
    const directAnswerRanges: SourceRange[] = [];
    const cuts = new Map<number, Array<{ startLine: number; endLine: number }>>();
    // Reserve every bounded named/first-flow declaration in this file (up to
    // the existing three-primary cap), plus one source-aligned fallback. The
    // fallback preserves later-file recall when its first overlap is an
    // oversized enclosing decoy.
    const reservedAnswerIds = selectedIds.filter((id) => {
      if (!reservedPrimaryIds.has(id)) return false;
      const node = nodes.get(id);
      if (!node) return false;
      const rangeIndex = bestDeclarationRangeIndex(ranges, node);
      if (rangeIndex < 0) return false;
      return Boolean(completeDeclarationRange(ranges[rangeIndex]!, node));
    });
    const fallbackAnswerId = selectedIds.find((id) => {
      if (reservedPrimaryIds.has(id) || exactOrder.has(id)
        || selectedAsFlow.has(id)) return false;
      const node = nodes.get(id);
      if (!node) return false;
      const rangeIndex = bestDeclarationRangeIndex(ranges, node);
      return rangeIndex >= 0 && Boolean(completeDeclarationRange(ranges[rangeIndex]!, node));
    });
    const directAnswerIds = new Set([
      ...reservedAnswerIds,
      ...(fallbackAnswerId ? [fallbackAnswerId] : []),
    ]);

    for (const id of selectedIds) {
      const node = nodes.get(id);
      if (!node) continue;
      const rangeIndex = bestDeclarationRangeIndex(ranges, node);
      if (rangeIndex < 0) continue;
      const range = ranges[rangeIndex]!;
      const exact = exactOrder.has(id);
      const anchor = exact ? { ...range, nodeIds: [...range.nodeIds] }
        : declarationAnchor(range, node, SOURCE_DECLARATION_ANCHOR_LINES);
      if (!anchor) continue;
      const completeAnswer = !exact && selectedAsFlow.has(id)
        ? completeDeclarationRange(range, node)
        : null;
      const completeDirectAnswer = directAnswerIds.has(id)
        ? completeDeclarationRange(range, node)
        : null;
      const reservedAnchor = reservedPrimaryIds.has(id) && !completeAnswer && !completeDirectAnswer
        ? anchor : null;

      // Complete primary answers are standalone atomic ranges. A tail that
      // depends on a later fairness header can never be a truthful unit: under
      // pressure the tail may fit while the header is dropped. A long reserved
      // declaration promotes its truthful signature range to the same answer
      // phase; only non-reserved nodes participate in compact fairness.
      if (!completeAnswer && !completeDirectAnswer && !reservedAnchor) {
        mergeAdmissionRange(anchors, anchor);
      }
      if (reservedAnchor) mergeAdmissionRange(answerRanges, reservedAnchor);
      if (completeAnswer) mergeAdmissionRange(
        reservedPrimaryIds.has(id) ? answerRanges : directAnswerRanges,
        completeAnswer,
      );
      if (completeDirectAnswer) mergeAdmissionRange(
        reservedPrimaryIds.has(id) || recordIndex === 0 ? answerRanges : directAnswerRanges,
        completeDirectAnswer,
      );

      const intervals = cuts.get(rangeIndex) ?? [];
      const consumed = completeAnswer ?? completeDirectAnswer ?? reservedAnchor ?? anchor;
      intervals.push({ startLine: consumed.startLine, endLine: consumed.endLine });
      cuts.set(rangeIndex, intervals);
    }

    // Text-only and otherwise node-less evidence still participates in the
    // same one-first-range-per-file fairness contract.
    if (anchors.length === 0 && answerRanges.length === 0 && directAnswerRanges.length === 0) {
      const range = ranges[0]!;
      const fallbackNode = range.nodeIds.map((id) => nodes.get(id))
        .find((node): node is GraphNode => Boolean(node));
      const fallback = fallbackNode
        ? declarationAnchor(range, fallbackNode, SOURCE_DECLARATION_ANCHOR_LINES) ?? range
        : range;
      anchors.push(fallback);
      const completeFallback = recordIndex === 0 && fallbackNode
        ? completeDeclarationRange(range, fallbackNode)
        : null;
      if (completeFallback && fallbackNode) {
        anchors.length = 0;
        directAnswerRanges.push(completeFallback);
      }
      const consumed = completeFallback ?? fallback;
      cuts.set(0, [{ startLine: consumed.startLine, endLine: consumed.endLine }]);
    }

    const optionalRanges = ranges.flatMap((range, index) => (
      subtractSourceIntervals(range, cuts.get(index) ?? [], nodes)
    ));
    return [{ record, anchors, answerRanges, directAnswerRanges, optionalRanges }];
  });

  const ordered: PlannedSourceAdmission[] = [];
  // The one terminal-flow target and one corroborated NL-query declaration are
  // the only cross-file source reservations. Admit them before any file can
  // spend the source share on multiple local answers.
  const globallyAdmittedRanges = new Set<SourceRange>();
  const globalAnswers = plans.flatMap((plan, planIndex) => [
    ...plan.answerRanges,
    ...plan.directAnswerRanges,
  ].flatMap((range, rangeIndex) => {
    const priority = Math.min(...range.nodeIds
      .map((id) => globallyReservedOrder.get(id) ?? Number.POSITIVE_INFINITY));
    return Number.isFinite(priority) ? [{ plan, planIndex, range, rangeIndex, priority }] : [];
  })).sort((left, right) => left.priority - right.priority
    || left.planIndex - right.planIndex
    || left.rangeIndex - right.rangeIndex);
  for (const answer of globalAnswers) {
    if (globallyAdmittedRanges.has(answer.range)) continue;
    globallyAdmittedRanges.add(answer.range);
    ordered.push({ record: { ...answer.plan.record, ranges: [answer.range] }, phase: "answer", atomic: true });
  }

  // Keep the strongest cohesive file together, then round-robin the remaining
  // reserved and displayed-flow answers across later files.
  const primaryPlan = plans[0];
  for (const range of primaryPlan?.answerRanges ?? []) {
    if (globallyAdmittedRanges.has(range)) continue;
    ordered.push({ record: { ...primaryPlan!.record, ranges: [range] }, phase: "answer", atomic: true });
  }
  for (const range of primaryPlan?.directAnswerRanges ?? []) {
    if (globallyAdmittedRanges.has(range)) continue;
    ordered.push({ record: { ...primaryPlan!.record, ranges: [range] }, phase: "answer", atomic: true });
  }
  const secondaryPlans = plans.slice(1);
  const answerWaves = Math.max(0, ...secondaryPlans.map((plan) => plan.answerRanges.length));
  for (let wave = 0; wave < answerWaves; wave += 1) {
    for (const plan of secondaryPlans) {
      const range = plan.answerRanges[wave];
      if (range && !globallyAdmittedRanges.has(range)) {
        ordered.push({ record: { ...plan.record, ranges: [range] }, phase: "answer", atomic: true });
      }
    }
  }
  const directAnswerWaves = Math.max(0, ...secondaryPlans.map((plan) => plan.directAnswerRanges.length));
  for (let wave = 0; wave < directAnswerWaves; wave += 1) {
    for (const plan of secondaryPlans) {
      const range = plan.directAnswerRanges[wave];
      if (range && !globallyAdmittedRanges.has(range)) {
        ordered.push({ record: { ...plan.record, ranges: [range] }, phase: "answer", atomic: true });
      }
    }
  }
  for (const plan of plans) {
    const range = plan.anchors[0];
    if (range) ordered.push({
      record: { ...plan.record, ranges: [range] },
      phase: "fairness",
      atomic: range.reason === "whole-file" && range.endLine - range.startLine + 1 <= 200,
    });
  }
  const waves = Math.max(0, ...plans.map((plan) => plan.anchors.length));
  for (let wave = 1; wave < waves; wave += 1) {
    for (const plan of plans) {
      const range = plan.anchors[wave];
      if (range) ordered.push({ record: { ...plan.record, ranges: [range] }, phase: "secondary", atomic: false });
    }
  }
  for (const plan of plans) {
    if (plan.optionalRanges.length > 0) {
      ordered.push({
        record: { ...plan.record, ranges: plan.optionalRanges }, phase: "optional", atomic: false,
      });
    }
  }
  return ordered;
}

/**
 * Normalize source admissions before they touch the ledger. Planning can attach
 * several relevant node ids to one containing declaration, after which the
 * admission scheduler may split that declaration back into one record per id.
 * Coalesce same-phase overlaps and subtract higher-priority coverage from later
 * phases so every source line is serialized at most once while covered node ids
 * remain available for fact and summary accounting.
 */
function coalesceSourceAdmissions(
  admissions: PlannedSourceAdmission[],
  nodes: Map<string, GraphNode>,
): PlannedSourceAdmission[] {
  type Entry = PlannedSourceAdmission & {
    filePath: string;
    range: SourceRange;
    order: number;
  };
  const flattened: Entry[] = [];
  let order = 0;
  for (const admission of admissions) {
    const filePath = typeof admission.record.filePath === "string" ? admission.record.filePath : undefined;
    const ranges = Array.isArray(admission.record.ranges) ? admission.record.ranges as SourceRange[] : [];
    if (!filePath || ranges.length === 0) continue;
    for (const range of ranges) flattened.push({ ...admission, filePath, range, order: order++ });
  }

  // Merge connected overlaps only within one admission phase. This removes
  // duplicate complete parent/child answers without letting a later optional
  // tail enlarge a mandatory answer record.
  const samePhase: Entry[] = [];
  const phaseGroups = new Map<string, Entry[]>();
  for (const entry of flattened) {
    const key = `${entry.filePath}\0${entry.phase}`;
    const group = phaseGroups.get(key);
    if (group) group.push(entry); else phaseGroups.set(key, [entry]);
  }
  for (const group of phaseGroups.values()) {
    const sorted = [...group].sort((left, right) => left.range.startLine - right.range.startLine
      || right.range.endLine - left.range.endLine || left.order - right.order);
    const merged: Entry[] = [];
    for (const entry of sorted) {
      const prior = merged.at(-1);
      if (prior && rangesOverlap(prior.range, entry.range)) {
        prior.range = combineSourceRanges(prior.range, entry.range);
        prior.record = { ...prior.record, ranges: [prior.range] };
        prior.atomic = prior.atomic && entry.atomic;
        prior.order = Math.min(prior.order, entry.order);
      } else merged.push({ ...entry, record: { ...entry.record, ranges: [entry.range] } });
    }
    samePhase.push(...merged);
  }
  samePhase.sort((left, right) => left.order - right.order
    || left.range.startLine - right.range.startLine || left.range.endLine - right.range.endLine);

  const out: Entry[] = [];
  for (const entry of samePhase) {
    let pending = [entry.range];
    for (const prior of out) {
      if (prior.filePath !== entry.filePath) continue;
      const next: SourceRange[] = [];
      for (const range of pending) {
        if (!rangesOverlap(prior.range, range)) {
          next.push(range);
          continue;
        }
        if (prior.range.startLine <= range.startLine && prior.range.endLine >= range.endLine) {
          prior.range.nodeIds = [...new Set([...prior.range.nodeIds, ...range.nodeIds])];
          prior.record = { ...prior.record, ranges: [prior.range] };
          continue;
        }
        // Preserve node ids whose complete declaration is already covered by
        // the earlier range. Remaining ids stay attached to the non-overlapping
        // pieces returned below.
        const coveredNodeIds = range.nodeIds.filter((id) => {
          const node = nodes.get(id);
          return node && prior.range.startLine <= node.startLine && prior.range.endLine >= node.endLine;
        });
        prior.range.nodeIds = [...new Set([...prior.range.nodeIds, ...coveredNodeIds])];
        prior.record = { ...prior.record, ranges: [prior.range] };
        next.push(...subtractSourceIntervals(range, [{
          startLine: prior.range.startLine, endLine: prior.range.endLine,
        }], nodes));
      }
      pending = next;
      if (pending.length === 0) break;
    }
    for (const range of pending) {
      out.push({
        ...entry,
        range,
        record: { ...entry.record, ranges: [range] },
        atomic: entry.atomic && range.startLine === entry.range.startLine
          && range.endLine === entry.range.endLine,
      });
    }
  }
  return out.sort((left, right) => left.order - right.order
    || left.range.startLine - right.range.startLine || left.range.endLine - right.range.endLine)
    .map(({ filePath: _filePath, range: _range, order: _order, ...admission }) => admission);
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function combineSourceRanges(left: SourceRange, right: SourceRange): SourceRange {
  const startLine = Math.min(left.startLine, right.startLine);
  const endLine = Math.max(left.endLine, right.endLine);
  const sourceLines = new Map<number, string>();
  for (const range of [left, right]) {
    for (const [offset, content] of range.content.split("\n").entries()) {
      const line = range.startLine + offset;
      if (!sourceLines.has(line)) sourceLines.set(line, content.replace(/^\s*\d+:\s?/, ""));
    }
  }
  const width = String(endLine).length;
  const content = Array.from({ length: endLine - startLine + 1 }, (_, offset) => {
    const line = startLine + offset;
    return `${String(line).padStart(width)}: ${sourceLines.get(line) ?? ""}`;
  }).join("\n");
  const leftContains = left.startLine <= right.startLine && left.endLine >= right.endLine;
  const rightContains = right.startLine <= left.startLine && right.endLine >= left.endLine;
  const provenance = rightContains && !leftContains ? right : left;
  return {
    startLine,
    endLine,
    nodeIds: [...new Set([...left.nodeIds, ...right.nodeIds])],
    content,
    truncated: leftContains ? left.truncated : rightContains ? right.truncated : left.truncated || right.truncated,
    reason: provenance.reason,
  };
}

function mergeAdmissionRange(ranges: SourceRange[], incoming: SourceRange): void {
  const duplicate = ranges.find((candidate) => (
    candidate.startLine === incoming.startLine && candidate.endLine === incoming.endLine
  ));
  if (duplicate) duplicate.nodeIds = [...new Set([...duplicate.nodeIds, ...incoming.nodeIds])];
  else ranges.push(incoming);
}

function bestDeclarationRangeIndex(ranges: SourceRange[], node: GraphNode): number {
  return ranges.map((range, index) => ({ range, index }))
    .filter(({ range }) => range.nodeIds.includes(node.id)
      && range.startLine <= node.startLine && range.endLine >= node.startLine)
    .sort((left, right) => (
      Number(left.range.startLine !== node.startLine) - Number(right.range.startLine !== node.startLine)
      || (left.range.endLine - left.range.startLine) - (right.range.endLine - right.range.startLine)
      || left.index - right.index
    ))[0]?.index ?? -1;
}

function declarationAnchor(range: SourceRange, node: GraphNode, maxLines: number): SourceRange | null {
  const startLine = Math.max(range.startLine, node.startLine);
  const endLine = Math.min(range.endLine, node.endLine, startLine + Math.max(1, maxLines) - 1);
  if (endLine < startLine) return null;
  const anchor = sliceSourceRange(range, startLine, endLine, [node.id]);
  return {
    ...anchor,
    reason: endLine >= node.endLine ? "complete-symbol" : "signature",
    truncated: range.truncated || endLine < node.endLine,
  };
}

function completeDeclarationRange(range: SourceRange, node: GraphNode): SourceRange | null {
  const length = node.endLine - node.startLine + 1;
  if (length > 160 || range.startLine > node.startLine || range.endLine < node.endLine) return null;
  return {
    ...sliceSourceRange(range, node.startLine, node.endLine, [node.id]),
    reason: "complete-symbol",
    truncated: false,
  };
}

function subtractSourceIntervals(
  range: SourceRange,
  intervals: Array<{ startLine: number; endLine: number }>,
  nodes: Map<string, GraphNode>,
): SourceRange[] {
  const clipped = intervals.map((interval) => ({
    startLine: Math.max(range.startLine, interval.startLine),
    endLine: Math.min(range.endLine, interval.endLine),
  })).filter((interval) => interval.endLine >= interval.startLine)
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  if (clipped.length === 0) return [range];

  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const interval of clipped) {
    const prior = merged.at(-1);
    if (prior && interval.startLine <= prior.endLine + 1) prior.endLine = Math.max(prior.endLine, interval.endLine);
    else merged.push({ ...interval });
  }

  const pieces: SourceRange[] = [];
  let cursor = range.startLine;
  for (const interval of merged) {
    if (cursor < interval.startLine) pieces.push(sourceInterval(range, cursor, interval.startLine - 1, nodes));
    cursor = Math.max(cursor, interval.endLine + 1);
  }
  if (cursor <= range.endLine) pieces.push(sourceInterval(range, cursor, range.endLine, nodes));
  return pieces;
}

function sourceInterval(
  range: SourceRange,
  startLine: number,
  endLine: number,
  nodes: Map<string, GraphNode>,
): SourceRange {
  const nodeIds = range.nodeIds.filter((id) => {
    const node = nodes.get(id);
    return !node || (node.startLine <= endLine && node.endLine >= startLine);
  });
  return { ...sliceSourceRange(range, startLine, endLine, nodeIds), truncated: true };
}

function sliceSourceRange(
  range: SourceRange,
  startLine: number,
  endLine: number,
  nodeIds: string[],
): SourceRange {
  const offset = startLine - range.startLine;
  const lineCount = endLine - startLine + 1;
  return {
    ...range,
    startLine,
    endLine,
    nodeIds,
    content: range.content.split("\n").slice(offset, offset + lineCount).join("\n"),
  };
}

function sourceRangesCover(emitted: SourceRange[], wanted: SourceRange): boolean {
  let cursor = wanted.startLine;
  for (const range of [...emitted].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)) {
    if (range.endLine < cursor) continue;
    if (range.startLine > cursor) return false;
    cursor = Math.max(cursor, range.endLine + 1);
    if (cursor > wanted.endLine) return true;
  }
  return false;
}

function firstNodeOrderInFile(
  order: Map<string, number>,
  nodes: Map<string, GraphNode>,
  filePath: string,
): number {
  let first = Number.POSITIVE_INFINITY;
  for (const [id, index] of order) {
    if (nodes.get(id)?.filePath === filePath) first = Math.min(first, index);
  }
  return first;
}

function admitSourceWithinShare(
  record: Rec,
  availableTokens: number,
  ledger: BudgetLedger,
  atomic = false,
): { admitted: Rec[]; deferred: Rec[]; tokens: number; trimmed: boolean } {
  const admitted: Rec[] = [];
  const deferred: Rec[] = [];
  let remaining = Math.max(0, availableTokens);
  let tokens = 0;
  let trimmed = false;
  const fullTokens = estimateTokens(record);
  if (fullTokens <= remaining && ledger.fits(record)) {
    ledger.tryAdd(record);
    return { admitted: [record], deferred, tokens: fullTokens, trimmed };
  }
  if (atomic) return { admitted, deferred: [record], tokens, trimmed };

  const ranges = Array.isArray(record.ranges) ? record.ranges as SourceRange[] : [];
  for (const range of ranges) {
    const single: Rec = { ...record, ranges: [range] };
    const singleTokens = estimateTokens(single);
    if (singleTokens <= remaining && ledger.fits(single)) {
      ledger.tryAdd(single);
      admitted.push(single);
      remaining -= singleTokens;
      tokens += singleTokens;
      continue;
    }

    // A complete declaration is an atomic evidence unit. Prefix-trimming one
    // at the 75% source-share boundary both loses span recall and falsely labels
    // a fragment as a complete symbol. Keep it whole for the spill pass; if the
    // hard response ledger still cannot fit it there, report it as omitted.
    if (range.reason === "complete-symbol" && !range.truncated
      && range.endLine - range.startLine + 1 <= 160) {
      deferred.push(single);
      continue;
    }

    const fitted = fitSourceRange(single, remaining, ledger);
    if (fitted) {
      const fittedTokens = estimateTokens(fitted);
      ledger.tryAdd(fitted);
      admitted.push(fitted);
      remaining -= fittedTokens;
      tokens += fittedTokens;
      trimmed ||= (fitted.ranges as SourceRange[])[0]!.endLine < range.endLine || range.truncated;
    } else deferred.push(single);
  }
  return { admitted, deferred, tokens, trimmed };
}

/** Find the largest whole-line prefix that fits; never cut a source line. */
function fitSourceRange(record: Rec, availableTokens: number, ledger: BudgetLedger): Rec | null {
  if (availableTokens <= 0) return null;
  const ranges = record.ranges as SourceRange[];
  const range = ranges[0];
  if (!range) return null;
  const contentLines = range.content.split("\n");
  let low = 1;
  let high = contentLines.length;
  let best: Rec | null = null;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const centered = range.reason === "query-hit" || range.reason === "callsite" || range.reason === "text-only";
    const offset = centered ? Math.floor((contentLines.length - count) / 2) : 0;
    const candidateRange: SourceRange = {
      ...range,
      startLine: range.startLine + offset,
      endLine: Math.min(range.endLine, range.startLine + offset + count - 1),
      content: contentLines.slice(offset, offset + count).join("\n"),
      truncated: count < contentLines.length || range.truncated,
    };
    const candidate: Rec = { ...record, ranges: [candidateRange] };
    if (estimateTokens(candidate) <= availableTokens && ledger.fits(candidate)) {
      best = candidate;
      low = count + 1;
    } else high = count - 1;
  }
  return best;
}

function dedupeTextHits(hits: RankedScopeFile["textHits"]): RankedScopeFile["textHits"] {
  const unique = new Map<string, RankedScopeFile["textHits"][number]>();
  for (const hit of hits) {
    const key = `${hit.filePath}\0${hit.startLine}\0${hit.endLine}\0${hit.contentHash}`;
    if (!unique.has(key)) unique.set(key, hit);
  }
  return [...unique.values()].sort((left, right) =>
    left.rank - right.rank || left.startLine - right.startLine || left.endLine - right.endLine);
}

function capFlowSteps<T extends { steps: GraphEdge[] }>(flows: T[], maxSteps: number): T[] {
  const out: T[] = [];
  let remaining = maxSteps;
  for (const flow of flows) {
    if (remaining <= 0) break;
    if (flow.steps.length === 0 || flow.steps.length > 7 || flow.steps.length > remaining) continue;
    out.push(flow);
    remaining -= flow.steps.length;
  }
  return out;
}

function scopeEdgeKey(edge: Pick<GraphEdge, "source" | "target" | "kind" | "line" | "column">): string {
  return `${edge.source}\0${edge.target}\0${edge.kind}\0${edge.line ?? -1}\0${edge.column ?? -1}`;
}

function openSession(rootDir: string, deps: AgentCommandDeps, write: (line: string) => void): AgentGraphSession | null {
  try {
    if (deps.open) return deps.open(rootDir);
    const dbPath = resolve(rootDir, ".mex", "graph.db");
    if (!existsSync(dbPath)) {
      writeJson(write, { type: "error", code: "GRAPH_UNAVAILABLE", message: "Run `mex graph` first." });
      return null;
    }
    const graph = createGraphEngine({ rootDir, dbPath, readOnly: true });
    const db = openGraphDatabase(dbPath, { readOnly: true });
    const storedManifest = db.prepare(
      "SELECT value FROM project_metadata WHERE key = 'manifest_hash'",
    ).get() as { value: string } | undefined;
    if (storedManifest?.value !== graphManifest(resolve(rootDir)).manifestHash) {
      graph.close();
      db.close();
      throw new GraphRebuildRequiredError("The code graph build manifest is stale.");
    }
    return { graph, db, close: () => { graph.close(); db.close(); } };
  } catch (error) {
    unavailable(write, error);
    return null;
  }
}

function resolveSymbol(graph: GraphEngine, target: string): GraphNode[] {
  const exactId = graph.getNode(target);
  if (exactId) return [exactId];
  const matches = graph.searchNodes(target, { limit: 100 });
  // Targeted commands must never reinterpret a missing symbol as a fuzzy one.
  // Broad retrieval belongs to `graph scope`; query/impact either resolve the
  // requested declaration exactly or abstain with TARGET_NOT_FOUND.
  return matches.filter((node) => node.name === target || node.qualifiedName === target);
}

function relatedCallNodes(graph: GraphEngine, queried: GraphNode, relation: Exclude<QueryRelation, "where-defined">): GraphNode[] {
  const typed = relation === "who-calls"
    ? (graph.getIncoming?.(queried.id, ["calls"]) ?? [])
    : (graph.getOutgoing?.(queried.id, ["calls"]) ?? []);
  if (typed.length > 0) {
    return dedupeNeighbors(typed)
      .sort((left, right) => {
        const pathDelta = Number(isLowValueGraphPath(left.node.filePath)) - Number(isLowValueGraphPath(right.node.filePath));
        if (pathDelta !== 0) return pathDelta;
        const lineDelta = (left.edge.line ?? Number.MAX_SAFE_INTEGER) - (right.edge.line ?? Number.MAX_SAFE_INTEGER);
        if (lineDelta !== 0) return lineDelta;
        return left.node.id.localeCompare(right.node.id);
      })
      .map((entry) => entry.node);
  }
  const fallback = relation === "who-calls" ? graph.getCallers(queried.id) : graph.getCallees(queried.id);
  return fallback.sort((left, right) =>
    Number(isLowValueGraphPath(left.filePath)) - Number(isLowValueGraphPath(right.filePath)) || left.id.localeCompare(right.id),
  );
}

function dedupeNeighbors(entries: GraphNeighbor[]): GraphNeighbor[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.node.id)) return false;
    seen.add(entry.node.id);
    return true;
  });
}

function nodesForFile(session: AgentGraphSession, rootDir: string, target: string): GraphNode[] {
  const relativeTarget = (target.startsWith("/") ? relative(rootDir, target) : target)
    .replace(/^\.\//, "").replaceAll("\\", "/");
  const rows = session.db.prepare("SELECT id FROM nodes WHERE file_path = ? ORDER BY id").all(relativeTarget) as Array<{ id: string }>;
  return rows.map((row) => session.graph.getNode(row.id)).filter((node): node is GraphNode => node !== null);
}

function transitiveCallers(graph: GraphEngine, root: GraphNode, maxDepth: number): Array<{ node: GraphNode; depth: number }> {
  const seen = new Set([root.id]);
  const queue: Array<{ node: GraphNode; depth: number }> = [{ node: root, depth: 0 }];
  const results: Array<{ node: GraphNode; depth: number }> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const caller of graph.getCallers(current.node.id).sort(byId)) {
      if (seen.has(caller.id)) continue;
      seen.add(caller.id);
      const entry = { node: caller, depth: current.depth + 1 };
      results.push(entry);
      queue.push(entry);
    }
  }
  return results;
}

function groundedFiles(db: SqliteDatabase, nodeIds: string[]): Array<{ scaffold_file: string; node_id: string }> {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT DISTINCT grounded.scaffold_file,
            COALESCE(aliases.canonical_node_id, grounded.node_id) AS node_id
     FROM _mex_grounded_source grounded
     LEFT JOIN node_aliases aliases ON aliases.alias_id = grounded.node_id
     WHERE grounded.node_id IN (${placeholders})
        OR aliases.canonical_node_id IN (${placeholders})
     ORDER BY grounded.scaffold_file, node_id`,
  ).all(...nodeIds, ...nodeIds) as Array<{ scaffold_file: string; node_id: string }>;
}

function liveUnindexedFiles(indexedFiles: IndexedFileInfo[], rootDir: string): string[] {
  const indexed = new Set(indexedFiles.map((file) => file.path));
  return globSync(SUPPORTED_SOURCE_GLOB, {
    cwd: rootDir,
    ignore: [
      "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.mex/**",
      "**/coverage/**", "**/.next/**", "**/out/**",
    ],
    nodir: true,
    absolute: false,
    dot: false,
  }).map((file) => file.replaceAll("\\", "/"))
    .filter((file) => isSupportedSourceFile(file) && !indexed.has(file))
    .sort();
}

function nodeRef(node: GraphNode): Record<string, string | number> {
  return { id: node.id, kind: node.kind, name: node.name, file: node.filePath, line: node.startLine };
}

function liveStaleFallbacks(
  indexedFiles: IndexedFileInfo[],
  staleFiles: string[],
  task: string,
  rootDir: string,
): RankedScopeFile[] {
  const terms = [...new Set(planGraphQuery(task).terms.filter((term) => !term.stem).map((term) => term.term))];
  const info = new Map(indexedFiles.map((file) => [file.path, file]));
  const out: RankedScopeFile[] = [];
  for (const filePath of staleFiles) {
    let lines: string[];
    try { lines = readFileSync(resolve(rootDir, filePath), "utf-8").split("\n"); }
    catch { continue; }
    const matched = terms.filter((term) => lines.some((line) => line.toLowerCase().includes(term)));
    if (matched.length === 0) continue;
    const first = Math.max(0, lines.findIndex((line) => matched.some((term) => line.toLowerCase().includes(term))));
    const indexed = info.get(filePath);
    out.push({
      filePath,
      score: 1 + matched.length * 0.3,
      reasons: ["live-stale-text"],
      nodeIds: [],
      textOnly: true,
      parseStatus: indexed?.parseStatus ?? "failed",
      textHits: [{
        filePath,
        startLine: Math.max(1, first + 1 - 12),
        endLine: Math.min(lines.length, first + 1 + 12),
        contentHash: sourceHash(filePath, rootDir) ?? "",
        rank: -matched.length,
        matchedTerms: matched,
      }],
    });
  }
  return out.sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));
}

function byId(left: GraphNode, right: GraphNode): number { return left.id.localeCompare(right.id); }
function isRelation(value: string): value is QueryRelation {
  return value === "who-calls" || value === "what-calls" || value === "where-defined";
}
function writeJson(write: (line: string) => void, value: unknown): void { write(JSON.stringify(value)); }
function unavailable(write: (line: string) => void, error: unknown): void {
  const coded = error as { code?: unknown; recoveryCommand?: unknown };
  writeJson(write, {
    type: "error",
    code: typeof coded?.code === "string" ? coded.code : "GRAPH_UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof coded?.recoveryCommand === "string" ? { recoveryCommand: coded.recoveryCommand } : {}),
  });
}
