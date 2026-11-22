import { codexCacheRead, inputOverhead } from "../plan.js";
import type { CandidateCounts, CandidateKind, HarvestOptions } from "./types.js";

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

export function estimateHarvest(counts: CandidateCounts, agent: HarvestOptions["agent"]):
{ triage: number; writer: number; repair: number; total: number } {
  const candidates = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const clusters = Math.ceil(candidates / CANDIDATES_PER_CLUSTER);
  const repairs = Math.ceil(clusters / REPAIR_SHARE);
  const overhead = inputOverhead + (agent === "codex" ? codexCacheRead : 0);
  const triage = Math.ceil(candidates / TRIAGE_BATCH) * overhead + candidates * TRIAGE_PER_CANDIDATE;
  // One early writer call can leave room unused before cross-window clustering.
  const writerCalls = clusters < 2 ? clusters : 1 + Math.ceil((clusters - 1) / WRITER_BATCH);
  const writer = writerCalls * overhead + clusters * WRITER_PER_CLUSTER;
  const repair = Math.ceil(repairs / WRITER_BATCH) * overhead + repairs * REPAIR_PER_ENTRY;
  return { triage, writer, repair, total: triage + writer + repair };
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
