import { codexCacheRead, inputOverhead } from "../plan.js";
import type { Candidate, CandidateCounts, CandidateKind, HarvestEvidenceSize, HarvestOptions } from "./types.js";

// This starting allowance covers a full review sample on the two calibration
// shapes, including the Codex cache reads, with room for new evidence sources.
export const DEFAULT_HARVEST_BUDGET = 320_000;

// Triage reads prose only. 240 input tokens represents a few hundred bytes of
// text plus IDs and routes. 64 output tokens cover the short structured result.
const TRIAGE_PER_CANDIDATE = 240 + 64;
// Pack short triage records in roughly a 12k-token prompt.
const TRIAGE_BATCH = 48;
// The first run is a forecast: roughly a quarter survive triage, with about
// two observations per cluster. Round up so a sparse run can still write one.
const CANDIDATES_PER_CLUSTER = 8;
// Design R1 packs up to six clusters in each writer call.
const WRITER_BATCH = 6;
// About 3.3 KiB of excerpts, source metadata and regions at three bytes/token,
// plus a structured entry with quotes, scope, patterns and proof locations.
const WRITER_PER_CLUSTER = 1100 + 550;
// Forecast one repair for one in five drafts, packed under the writer limit.
// The repair prompt includes the failed evidence and failure reason.
const REPAIR_SHARE = 5;
const REPAIR_PER_ENTRY = 850 + 550;

function callOverhead(agent: HarvestOptions["agent"]): number {
  return inputOverhead + (agent === "codex" ? codexCacheRead : 0);
}

function writerCalls(clusters: number): number {
  // One early writer call can leave room unused before cross-window clustering.
  return clusters < 2 ? clusters : 1 + Math.ceil((clusters - 1) / WRITER_BATCH);
}

export function estimateHarvest(counts: CandidateCounts, agent: HarvestOptions["agent"]):
{ triage: number; writer: number; repair: number; total: number } {
  const candidates = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const clusters = Math.ceil(candidates / CANDIDATES_PER_CLUSTER);
  const repairs = Math.ceil(clusters / REPAIR_SHARE);
  const overhead = callOverhead(agent);
  const triage = Math.ceil(candidates / TRIAGE_BATCH) * overhead + candidates * TRIAGE_PER_CANDIDATE;
  const writer = writerCalls(clusters) * overhead + clusters * WRITER_PER_CLUSTER;
  const repair = Math.ceil(repairs / WRITER_BATCH) * overhead + repairs * REPAIR_PER_ENTRY;
  return { triage, writer, repair, total: triage + writer + repair };
}

export const emptyHarvestEvidence: HarvestEvidenceSize = { candidates: 0, triageTokens: 0, writerTokens: 0, largestWriterTokens: 0 };

function evidenceTokens(parts: Array<string | undefined>): number {
  return Math.ceil(parts.reduce((bytes, part) => bytes + Buffer.byteLength(part ?? "", "utf8"), 0) / 3);
}

export function addHarvestEvidence(size: HarvestEvidenceSize, candidate: Pick<Candidate, "text" | "prText" | "code" | "related">):
HarvestEvidenceSize {
  const { text, prText, code, related } = candidate;
  const writerTokens = evidenceTokens([text, prText, code?.anchor, code?.before?.text, code?.after?.text, code?.head?.text,
    related?.reland?.before.text, related?.reland?.after.text]);
  return { candidates: size.candidates + 1, triageTokens: size.triageTokens + evidenceTokens([text]),
    writerTokens: size.writerTokens + writerTokens, largestWriterTokens: Math.max(size.largestWriterTokens, writerTokens) };
}

// Triage receives only candidate prose, plus an ID and room for its structured reply.
const TRIAGE_METADATA = 32;
const TRIAGE_REPLY = 64;
const TRIAGE_INPUT_LIMIT = 12_000;
// The writer also sees PR context and code. Forecast the same quarter surviving
// triage as the consent quote, while reserving at least one full evidence item.
const WRITTEN_SHARE = 4;
const WRITER_METADATA = 120;
const WRITER_INPUT_LIMIT = 20_000;
const ENTRY_REPLY = 550;
const REPAIR_METADATA = 200;

export function projectHarvestSpend(size: HarvestEvidenceSize, agent: HarvestOptions["agent"]): number {
  const clusters = Math.ceil(size.candidates / CANDIDATES_PER_CLUSTER);
  const repairs = Math.ceil(clusters / REPAIR_SHARE);
  const overhead = callOverhead(agent);
  const triageInput = size.triageTokens + size.candidates * TRIAGE_METADATA;
  const triage = Math.max(Math.ceil(size.candidates / TRIAGE_BATCH), Math.ceil(triageInput / TRIAGE_INPUT_LIMIT)) * overhead
    + triageInput + size.candidates * TRIAGE_REPLY;
  const writtenEvidence = Math.max(size.largestWriterTokens, Math.ceil(size.writerTokens / WRITTEN_SHARE));
  const writerInput = writtenEvidence + clusters * WRITER_METADATA;
  const writer = Math.max(writerCalls(clusters), Math.ceil(writerInput / WRITER_INPUT_LIMIT)) * overhead
    + writerInput + clusters * ENTRY_REPLY;
  const repair = Math.ceil(repairs / WRITER_BATCH) * overhead + Math.ceil(writtenEvidence / REPAIR_SHARE)
    + repairs * (REPAIR_METADATA + ENTRY_REPLY);
  return triage + writer + repair;
}

export function forecastCounts(inventory: { merged: number; closed?: number; revert?: number; cause?: number; adr?: number; doc: number; issue?: number }):
Record<CandidateKind, number> {
  return {
    // The earlier runs harvested on the order of two eligible comments per sampled PR.
    "review-thread": inventory.merged * 2,
    // Some descriptions are blank or repeat the title.
    "pr-text": Math.ceil(inventory.merged * 0.6),
    // Closed searches include stalled, empty and bot-closed work. Start with one in four.
    "closed-pr": Math.ceil((inventory.closed ?? 0) / 4),
    revert: inventory.revert ?? 0,
    "cause-commit": inventory.cause ?? 0,
    // A typical decision has a decision section and one section on alternatives or consequences.
    adr: (inventory.adr ?? 0) * 2,
    // Contributor files often have several headings. Consumer-only READMEs yield none.
    doc: Math.ceil(inventory.doc * 1.5),
    // The opt-in issue search includes all closed issues. Most carry no qualifying rationale.
    issue: Math.ceil((inventory.issue ?? 0) / 10),
  };
}
