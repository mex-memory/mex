import { agentName, type AgentId } from "../model-runner/agents.js";
import { openRecordReadOnly, type RecordReader } from "../record/index.js";
import { learningRunPrefix } from "../record/learning-rows.js";
import type { LocationOptions } from "../record/location.js";
import type { Candidate } from "./harvest/types.js";
import type { PipelineState } from "./pipeline.js";

export const DEEP_STAGES = ["Read sources", "Sort sources", "Write rules", "Check rules", "Save rules"] as const;
export interface Subject { subject: string; title?: string }
export interface DeepActivity {
  agent: string;
  stage: number;
  done?: number;
  total?: number;
  unit?: string;
  finished: string[];
  current?: Subject & { startedAt: string };
  recent: Array<Subject & { result: string }>;
  tokens: number;
  /** The runner may estimate usage when its CLI cannot provide it. */
  tokensEstimated?: boolean;
  startedAt: string;
}

export interface DeepOutcome {
  sources: number;
  learned: number;
  keptAutomatically: number;
  toConfirm: number;
  dropped: number;
  tokens: number;
  minutes: number;
}

export const activityKey = (id: string) => learningRunPrefix(id) + "activity";
export const sourcesRead = (state: PipelineState) => Object.entries(state.counts)
  .filter(([name]) => name.startsWith("harvested.")).reduce((sum, [, value]) => sum + value, 0);

export function sourceSubject(candidate: Candidate | undefined, fallback: string): Subject {
  if (!candidate) return { subject: fallback };
  const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 160);
  const subject = candidate.pull ? `PR #${candidate.pull}`
    : candidate.kind === "revert" ? "Revert" : clean(candidate.path ?? fallback);
  return { subject, ...(candidate.title ? { title: clean(candidate.title) } : {}) };
}

/** The live-view stage of one model call, from its checkpoint name. The early rules run inside sorting. */
export function stageOfCall(name: string): number {
  return name.startsWith("triage.") ? 1 : name.startsWith("gate.") ? 3 : name.startsWith("procedure.") ? 4 : 2;
}

export function activityFor(state: PipelineState, agent: AgentId | "claude", startedAt: string,
  tokens: number, recent: DeepActivity["recent"] = [], call?: number): DeepActivity {
  const stage = call ?? { harvest: 0, triage: 1, write: 2, finish: 4 }[state.phase];
  const count = (name: string) => state.counts[name] ?? 0;
  const sorted = state.harvestDone && state.triaged >= state.batches;
  // A window's counts land when its rules are saved, so the writing stages show numbers only once they're done.
  const saved = state.phase === "finish";
  const finished: string[] = [];
  if (state.harvestDone) finished[0] = `${sourcesRead(state)} sources read`;
  if (sorted && stage > 1) finished[1] = `${count("triage-kept")} team expectations kept`;
  if (stage > 2) finished[2] = saved ? `${count("norms") + count("doc-rules")} rules written` : "done";
  if (stage > 3) finished[3] = saved ? `${count("gate.keep")} passed` : "done";
  return {
    agent: agentName(agent), stage, finished: Array.from(finished, result => result ?? ""), tokens, recent, startedAt,
    ...(agent === "copilot" ? { tokensEstimated: true } : {}),
    ...(stage === 0 ? { done: sourcesRead(state), unit: "sources" } : {}),
    ...(stage === 1 ? { done: state.triaged, total: state.harvestDone ? state.batches : undefined, unit: "batches" } : {}),
  };
}

function readJobValue<T>(location: LocationOptions, read: (reader: RecordReader) => T | undefined): T | null {
  let reader: RecordReader | undefined;
  try {
    reader = openRecordReadOnly(location) ?? undefined;
    return reader ? read(reader) ?? null : null;
  } catch { return null; }
  finally { reader?.close(); }
}

export function readActivity(location: LocationOptions, jobId: string): DeepActivity | null {
  return readJobValue(location, reader => {
    const job = reader.all<{ project_id: string; state: string }>("SELECT project_id,state FROM jobs WHERE id=?", jobId)[0];
    const saved = job?.project_id && reader.setting(job.project_id, activityKey(jobId));
    if (!saved) return;
    const activity = JSON.parse(saved) as DeepActivity;
    return job.state === "running" ? activity : { ...activity, current: undefined };
  });
}

export function readOutcome(location: LocationOptions, jobId: string): DeepOutcome | null {
  return readJobValue(location, reader => {
    const job = reader.all<{ checkpoint: string }>(
      "SELECT checkpoint FROM jobs WHERE id=? AND state IN ('done','done with gaps')", jobId)[0];
    return job?.checkpoint ? (JSON.parse(job.checkpoint) as { outcome?: DeepOutcome }).outcome : undefined;
  });
}
