import { tokenCount } from "../../model-runner/consent.js";
import { MEANING_BATCH_ITEMS, MEANING_PROMPT_BYTES } from "../meaning.js";
import { codexCacheRead, inputOverhead, promptEstimate } from "../plan.js";
import type { Candidate, CandidateCounts, CandidateKind, HarvestEvidenceSize, HarvestOptions } from "./types.js";

// The quote shown before consent. Calibrated on a live Hono run (24 Nov 2026,
// Codex, 104 sources): 551,731 tokens, which the forecast below puts within 5%.
export const DEFAULT_HARVEST_BUDGET = 480_000;

// Triage reads prose only. 240 input tokens represents a few hundred bytes of
// text plus IDs and routes. 64 output tokens cover the short structured result.
const TRIAGE_PER_CANDIDATE = 240 + 64;
// Pack short triage records in roughly a 12k-token prompt.
export const TRIAGE_BATCH = 48;
// The first run is a forecast: roughly a quarter survive triage, with about
// two observations per cluster. Round up so a sparse run can still write one.
const CANDIDATES_PER_CLUSTER = 8;
// The writer packs up to six clusters, but the early call, review clusters and
// doc clusters are packed apart. The live Hono run wrote 15 clusters in 8 calls.
const CLUSTERS_PER_WRITER_CALL = 2;
// A structured entry with quotes, scope, patterns and proof locations. Measured
// at about 1.8K output tokens per entry, reasoning included.
const ENTRY_REPLY = 1_800;
// About 3.3 KiB of excerpts, source metadata and regions at three bytes/token.
const WRITER_PER_CLUSTER = 1100 + ENTRY_REPLY;
// Each writer batch with a failing draft gets its own repair call; 12 of 15
// written drafts needed one. The repair prompt has the failed evidence and reason.
const REPAIR_RATE = 0.8;
const REPAIR_PER_ENTRY = 850 + ENTRY_REPLY;

function callOverhead(agent: HarvestOptions["agent"]): number {
  return inputOverhead + (agent === "codex" ? codexCacheRead : 0);
}

function writerCalls(clusters: number): number {
  // One early writer call can leave room unused before cross-window clustering.
  return clusters < 2 ? clusters : 1 + Math.ceil((clusters - 1) / CLUSTERS_PER_WRITER_CALL);
}

function repairCalls(writes: number, repairs: number): number {
  return Math.min(writes, repairs);
}

function estimateMeaning(candidates: number, clusters: number, repairs: number, writes: number, agent: HarvestOptions["agent"]) {
  // Forecast six nominated comparisons per kept observation. Scope overlap and
  // earlier notes vary by repo, so the call-level budget still decides.
  const kept = Math.ceil(candidates / WRITTEN_SHARE);
  const pairs = kept <= 1 ? 0 : kept * 6;
  const pairCalls = Math.max(Math.ceil(pairs / MEANING_BATCH_ITEMS), Math.ceil(pairs * 105 / (MEANING_PROMPT_BYTES / BYTES_PER_TOKEN)));
  // A lesson's text is included once per call, with each pair referring to two indices.
  const pairTokens = pairs ? kept * 60 + pairs * 18 : 0;
  // Exact evidence is checked locally. Quote checks share one round for the
  // writer batches and one for their repairs.
  const quoteCalls = (writes ? 1 : 0) + (repairs ? 1 : 0);
  const allowance = tokenCount(promptEstimate("", agent, 0));
  const comparisons = pairCalls * (allowance + 240) + pairTokens;
  const grounding = quoteCalls * (allowance + 240) + (clusters + repairs) * 180;
  return { comparisons, grounding };
}

export function estimateHarvest(counts: CandidateCounts, agent: HarvestOptions["agent"]):
{ triage: number; writer: number; repair: number; comparisons: number; grounding: number; total: number } {
  const candidates = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const clusters = Math.ceil(candidates / CANDIDATES_PER_CLUSTER);
  const repairs = Math.ceil(clusters * REPAIR_RATE);
  const overhead = callOverhead(agent);
  const triage = Math.ceil(candidates / TRIAGE_BATCH) * overhead + candidates * TRIAGE_PER_CANDIDATE;
  const writes = writerCalls(clusters);
  const writer = writes * overhead + clusters * WRITER_PER_CLUSTER;
  const repair = repairCalls(writes, repairs) * overhead + repairs * REPAIR_PER_ENTRY;
  const { comparisons, grounding } = estimateMeaning(candidates, clusters, repairs, writes, agent);
  return { triage, writer, repair, comparisons, grounding, total: triage + writer + repair + comparisons + grounding };
}

export const emptyHarvestEvidence: HarvestEvidenceSize = { candidates: 0, triageTokens: 0, writerTokens: 0, largestWriterTokens: 0 };

function evidenceTokens(parts: Array<string | undefined>): number {
  return Math.ceil(parts.reduce((bytes, part) => bytes + Buffer.byteLength(part ?? "", "utf8"), 0) / BYTES_PER_TOKEN);
}

export function addHarvestEvidence(size: HarvestEvidenceSize, candidate: Pick<Candidate, "text" | "prText" | "code" | "related">):
HarvestEvidenceSize {
  const { text, prText, code, related } = candidate;
  const writerTokens = evidenceTokens([text, prText && !text.includes(prText) ? prText : undefined, code?.anchor, code?.before?.text, code?.after?.text, code?.head?.text,
    related?.reland?.before.text, related?.reland?.after.text]);
  return { candidates: size.candidates + 1, triageTokens: size.triageTokens + evidenceTokens([text]),
    writerTokens: size.writerTokens + writerTokens, largestWriterTokens: Math.max(size.largestWriterTokens, writerTokens) };
}

// Triage receives only candidate prose, plus an ID and room for its structured reply.
export const TRIAGE_METADATA = 32;
const TRIAGE_REPLY = 64;
export const TRIAGE_INPUT_LIMIT = 12_000;
export const BYTES_PER_TOKEN = 3;
// The writer also sees PR context and code. Forecast the same quarter surviving
// triage as the consent quote, while reserving at least one full evidence item.
const WRITTEN_SHARE = 4;
const WRITER_METADATA = 120;
const WRITER_INPUT_LIMIT = 20_000;
const REPAIR_METADATA = 200;

export function projectHarvestSpend(size: HarvestEvidenceSize, agent: HarvestOptions["agent"]): number {
  const clusters = Math.ceil(size.candidates / CANDIDATES_PER_CLUSTER);
  const repairs = Math.ceil(clusters * REPAIR_RATE);
  const overhead = callOverhead(agent);
  const triageInput = size.triageTokens + size.candidates * TRIAGE_METADATA;
  const triage = Math.max(Math.ceil(size.candidates / TRIAGE_BATCH), Math.ceil(triageInput / TRIAGE_INPUT_LIMIT)) * overhead
    + triageInput + size.candidates * TRIAGE_REPLY;
  const writtenEvidence = Math.max(size.largestWriterTokens, Math.ceil(size.writerTokens / WRITTEN_SHARE));
  const writerInput = writtenEvidence + clusters * WRITER_METADATA;
  const writes = Math.max(writerCalls(clusters), Math.ceil(writerInput / WRITER_INPUT_LIMIT));
  const writer = writes * overhead + writerInput + clusters * ENTRY_REPLY;
  // A repair resends the failed drafts' evidence.
  const repair = repairCalls(writes, repairs) * overhead + Math.ceil(writtenEvidence * REPAIR_RATE)
    + repairs * (REPAIR_METADATA + ENTRY_REPLY);
  const { comparisons, grounding } = estimateMeaning(size.candidates, clusters, repairs, writes, agent);
  return triage + writer + repair + comparisons + grounding;
}

export function forecastCounts(inventory: { merged: number; closed?: number; revert?: number; cause?: number; adr?: number; doc: number; issue?: number }):
Record<CandidateKind, number> {
  return {
    // The earlier runs harvested on the order of two eligible comments per sampled PR.
    "review-thread": inventory.merged * 2,
    // Most descriptions only list what changed, and those are context for the reviews.
    "pr-text": Math.ceil(inventory.merged * 0.3),
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
