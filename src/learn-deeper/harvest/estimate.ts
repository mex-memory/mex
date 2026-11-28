import { tokenCount } from "../../model-runner/consent.js";
import { ruleFormat } from "../../knowledge/rule-files.js";
import type { PinnedTree } from "../git.js";
import { promptEstimate, quoteCeiling } from "../plan.js";
import { maintainerLine, packUnits, prUnits, renderUnits } from "../pr-units.js";
import type { Candidate, CandidateCounts, HarvestEvidenceSize, HarvestOptions } from "./types.js";

// The request budget bounds forge work independently. This is a total projected
// token bound, with no share reserved for or charged against a source kind.
export const DEFAULT_HARVEST_BUDGET = 960_000;
export const BYTES_PER_TOKEN = 3.6;
export const WRITER_CHAR_LIMIT = 90_000;
export const DOC_CHAR_LIMIT = 90_000;
export const PATTERNS_PER_BATCH = 8;
export const ESTIMATED_GATE_BATCH = 48;

export interface Census {
  candidates: CandidateCounts;
  documentBytes: number;
  ruleWords: number;
  ruleWordsPerKiB: number;
  decisions: number;
  agentFiles: number;
  prUnits: number;
  units: number;
  triageBatches: number;
  triageCharacters: number;
  docBatches: number;
}

export function censusFor(candidates: readonly Candidate[], tree: Pick<PinnedTree, "paths">): Census {
  const counts: CandidateCounts = {};
  let documentBytes = 0, ruleWords = 0, decisions = 0;
  for (const candidate of candidates) {
    counts[candidate.kind] = (counts[candidate.kind] ?? 0) + 1;
    if (candidate.kind === "doc") {
      documentBytes += Buffer.byteLength(candidate.text);
      ruleWords += [...candidate.text.matchAll(/\b(?:must|should|don['’]t|always|never|please)\b/giu)].length;
    } else {
      const text = candidate.lines?.filter(maintainerLine).map(line => line.text) ?? [candidate.text];
      decisions += text.filter(line => /\b(?:next major|next minor|next release|next branch|out of scope|not in core|belong in (?:the )?core|bundle size|breaking change)\b|\x60next\x60/iu.test(line)).length;
    }
  }
  const units = prUnits(candidates), batches = packUnits(units);
  const docs = candidates.filter(candidate => candidate.kind === "doc");
  return { candidates: counts, documentBytes, ruleWords, ruleWordsPerKiB: documentBytes ? ruleWords * 1024 / documentBytes : 0, decisions, agentFiles: [...tree.paths()].filter(path =>
    !!ruleFormat(path) || /(?:^|\/)(?:AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI)\.md$|^\.(?:cursor|claude)\/rules\//iu.test(path)).length,
    prUnits: units.filter(unit => unit.header.startsWith("=== PR #")).length, units: units.length,
    triageBatches: batches.length, triageCharacters: batches.reduce((sum, batch) => sum + renderUnits(batch).text.length, 0),
    docBatches: packDocumentSources(docs).length };
}

export function censusLine(census: Census): string {
  const reviews = (census.candidates.conversation ?? 0) + (census.candidates["review-summary"] ?? 0) + (census.candidates["review-thread"] ?? 0);
  if (census.ruleWords && census.ruleWords >= Math.max(census.decisions * 3, reviews)) return "Most of the rule language we counted was in contributor docs.";
  if (census.decisions) return "We found team decisions in pull request discussions.";
  if (reviews) return "We found maintainer expectations in pull request discussions.";
  if (census.agentFiles) return "We found agent instruction files already in this repository.";
  return "We found little written guidance in this window.";
}

export function packDocumentSources(docs: readonly Candidate[]): Candidate[][] {
  const byFile = new Map<string, Candidate[]>();
  for (const doc of docs) if (doc.path) {
    const group = byFile.get(doc.path) ?? [];
    group.push(doc);
    byFile.set(doc.path, group);
  }
  const batches: Candidate[][] = [];
  let batch: Candidate[] = [], size = 0;
  const flush = () => {
    if (batch.length) batches.push(batch);
    batch = [];
    size = 0;
  };
  for (const file of byFile.values()) {
    const length = file.reduce((sum, doc) => sum + doc.text.length + (doc.path?.length ?? 0) + 16, 0);
    if (batch.length && size + length > DOC_CHAR_LIMIT) flush();
    for (const doc of file) {
      const current = doc.text.length + (doc.path?.length ?? 0) + 16;
      if (batch.length && size + current > DOC_CHAR_LIMIT) flush();
      batch.push(doc);
      size += current;
    }
  }
  flush();
  return batches;
}

function ceilingStages(census: Census, agent: HarvestOptions["agent"]) {
  // Keep the original allowances so a calibrated quote cannot change which calls fit.
  const overhead = agent === "codex" ? 16_000 : tokenCount(promptEstimate("", agent, 0));
  const counts = census.candidates;
  const inputs = Object.values(counts).reduce((total, count) => total + (count ?? 0), 0) - (counts.doc ?? 0);
  const observations = Math.ceil(inputs / 5);
  const norms = Math.ceil(observations / 3);
  const docs = census.docBatches ? Math.max(1, Math.ceil(census.ruleWords / 5)) : 0;
  const withPairs = Math.min(norms, Math.ceil(((counts["review-thread"] ?? 0) + (counts.revert ?? 0)) / 12));
  const input = (chars: number) => Math.ceil(chars / BYTES_PER_TOKEN);
  const triage = census.triageBatches * (overhead + input(3_000)) + input(census.triageCharacters) + observations * 90;
  const writer = inputs ? (Math.max(1, Math.ceil(observations * 550 / WRITER_CHAR_LIMIT)) + Number(census.prUnits >= 30 || census.triageBatches > 1))
    * overhead + observations * 155 + norms * 175 : 0;
  const documents = census.docBatches * overhead + input(census.documentBytes) + docs * 200;
  const patternBatches = Math.ceil(withPairs / PATTERNS_PER_BATCH);
  const pattern = patternBatches * overhead + withPairs * 1_100;
  const patternRepair = Math.ceil(patternBatches / 2) * overhead;
  const gate = Math.ceil((norms + docs) / ESTIMATED_GATE_BATCH) * overhead + (norms + docs) * 380;
  return { triage, writer, documents, pattern, patternRepair, gate };
}

function stageTotal(stages: ReturnType<typeof ceilingStages>): number {
  return stages.triage + stages.writer + stages.documents + stages.pattern + stages.patternRepair + stages.gate;
}

export function estimateCensus(census: Census, agent: HarvestOptions["agent"]) {
  const allowances = ceilingStages(census, agent);
  const ceiling = quoteCeiling(stageTotal(allowances));
  // Two sets of Codex runs calibrate these stages. Other agents retain their original forecast.
  // Triage follows the size of the packed text plus about 5K per batch. For the
  // following stages use rounded medians of measured usage / the original allowances.
  const stages = agent === "codex" ? {
    triage: census.triageBatches * 5_000 + Math.ceil(census.triageCharacters / BYTES_PER_TOKEN),
    writer: Math.round(allowances.writer * 0.56),
    documents: Math.round(allowances.documents * 0.50),
    pattern: Math.round(allowances.pattern * 0.08),
    patternRepair: Math.round(allowances.patternRepair * 0.12),
    gate: Math.round(allowances.gate * 0.60),
  } : allowances;
  return { ...stages, total: stageTotal(stages), ceiling };
}

export function estimateHarvest(counts: CandidateCounts, agent: HarvestOptions["agent"]) {
  const all = Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
  const docs = counts.doc ?? 0, triageCharacters = (all - docs) * 700;
  const countsForCensus: Census = { candidates: counts, documentBytes: docs * 2_000, ruleWords: docs * 5, ruleWordsPerKiB: docs ? 2.56 : 0,
    decisions: 0, agentFiles: 0, prUnits: 0, units: 0, triageBatches: Math.ceil(triageCharacters / 55_000), triageCharacters,
    docBatches: Math.ceil(docs * 2_000 / DOC_CHAR_LIMIT) };
  return estimateCensus(countsForCensus, agent);
}

export const emptyHarvestEvidence: HarvestEvidenceSize = { candidates: 0, triageTokens: 0, writerTokens: 0, largestWriterTokens: 0 };

export function addHarvestEvidence(size: HarvestEvidenceSize,
  candidate: Pick<Candidate, "text" | "prText" | "code" | "related"> & Partial<Pick<Candidate, "kind" | "context" | "lines">>): HarvestEvidenceSize {
  const chars = candidate.text.length + (candidate.prText?.length ?? 0)
    + (candidate.context?.reduce((sum, line) => sum + Math.min(line.text.length, 400), 0) ?? 0)
    + (candidate.lines?.reduce((sum, line) => sum + (line.hunk?.length ?? 0) + 80, 0) ?? 80);
  if (candidate.kind === "doc") return { ...size, candidates: size.candidates + 1,
    writerTokens: size.writerTokens + Math.ceil(candidate.text.length / BYTES_PER_TOKEN) };
  return { ...size, candidates: size.candidates + 1, triageTokens: size.triageTokens + Math.ceil(chars / BYTES_PER_TOKEN),
    largestWriterTokens: size.largestWriterTokens + Number(!!candidate.code?.before && !!candidate.code.after || !!candidate.related?.reland) };
}

export function projectHarvestSpend(size: HarvestEvidenceSize, agent: HarvestOptions["agent"]): number {
  const overhead = tokenCount(promptEstimate("", agent, 0));
  const triage = Math.ceil(size.triageTokens * BYTES_PER_TOKEN / 55_000);
  const documents = Math.ceil(size.writerTokens * BYTES_PER_TOKEN / DOC_CHAR_LIMIT);
  const patterns = Math.ceil(size.largestWriterTokens / (12 * PATTERNS_PER_BATCH));
  const gate = Math.ceil(size.candidates / (10 * ESTIMATED_GATE_BATCH));
  return (triage + documents + patterns + gate + Number(triage > 0) + Number(triage > 1)) * overhead
    + size.triageTokens + size.writerTokens + size.candidates * 175;
}

export function forecastCounts(inventory: { merged: number; closed?: number; revert?: number; cause?: number; adr?: number; doc: number; issue?: number }): CandidateCounts {
  return { "review-thread": Math.ceil(inventory.merged / 4), conversation: Math.ceil(inventory.merged / 2),
    "review-summary": Math.ceil(inventory.merged / 10), "pr-text": Math.ceil(inventory.merged / 12),
    "closed-pr": Math.ceil((inventory.closed ?? 0) / 2), revert: inventory.revert, "cause-commit": inventory.cause,
    adr: inventory.adr, doc: inventory.doc, issue: inventory.issue };
}
