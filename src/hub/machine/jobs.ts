import type { MachineJob, MachineJobActionRequest } from "@mex/hub-contracts/machine";
import { createHash } from "node:crypto";
import { ensureBackground } from "../../record/background.js";
import { openRecordReadOnly, type RecordReader, type RecordWriter } from "../../record/index.js";
import { jobListItem, listJobs, MAX_SAME_FAILURES, requestJob, type JobListItem, type JobRow } from "../../record/jobs.js";
import type { LocationOptions } from "../../record/location.js";
import "../../record/job-kinds.js";
import { readStore } from "./read.js";

const JOB_LIMIT = 100;
const groupedCount = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)";
const progressPattern = new RegExp(`(?<![\\w.,+-])(${groupedCount})\\s+of\\s+(${groupedCount})(?![\\w]|[.,]\\d)`, "giu");
type WithWriter = <T>(use: (writer: RecordWriter) => T) => T;
type JobProjection = JobListItem & { id: string };
type JobDetails = Pick<JobRow, "id" | "project_id" | "failures" | "params">;

function stateFor(job: JobProjection, failures: number): MachineJob["state"] {
  switch (job.state) {
    case "running": return {
      phase: "running",
      ...(job.pending === "pause" ? { pausing: true } : {}),
      ...(job.pending === "cancel" ? { stopping: true } : {}),
    };
    case "waiting": return { phase: "waiting", reason: job.reason ?? "ready when work can continue" };
    case "failed": return { phase: "failed", cause: job.reason || "The job could not finish", identicalFailures: failures };
    case "done with gaps": return { phase: "doneWithGaps" };
    case "cancelled": return { phase: "stopped" };
    default: return { phase: job.state };
  }
}

function progressFor(activity: string | null): MachineJob["progress"] {
  // Only whole counts, optionally grouped with commas. Avoid matching pieces
  // of a decimal, invalid grouping, or a figure larger than the total.
  if (!activity) return undefined;
  const matches = activity.matchAll(progressPattern);
  const match = matches.next().value;
  if (!match || !matches.next().done) return undefined;
  const completed = Number(match[1].replaceAll(",", ""));
  const total = Number(match[2].replaceAll(",", ""));
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total <= 0 || completed > total) return undefined;
  return { completed, total };
}

function resultFor(kind: string, count: number): MachineJob["result"] {
  if (count <= 0) return undefined;
  switch (kind) {
    case "learn-deeper":
    case "learn-deeper-weekly":
    case "session-learn": return { verb: "Learned", count, unit: "rule" };
    case "file-index": return { verb: "Mapped", count, unit: "file" };
    case "check":
    case "knowledge-check":
    case "judge": return { verb: "Checked", count, unit: "rule" };
    case "graph-verify": return { verb: "Checked", count, unit: "file" };
    default: return undefined;
  }
}

function toHubJob(job: JobProjection, details: JobDetails | undefined): MachineJob {
  const { used, estimate } = job.tokens;
  return {
    id: job.id, repoId: details?.project_id ?? "", label: job.label, kind: job.kind,
    state: stateFor(job, details?.failures ?? 0),
    activity: job.doing ?? undefined,
    progress: progressFor(job.doing),
    result: resultFor(job.kind, job.results),
    cost: used || estimate !== null ? {
      estimatedTokens: estimate ?? 0, ...(used ? { usedTokens: used } : {}),
      ...(job.kind === "learn-deeper-weekly" && (job.state === "queued" || job.state === "waiting") ? { startsWhenIdle: true } : {}),
    } : null,
    started: new Date(job.createdAt).toISOString(),
  };
}

export function readHubJobs(location: LocationOptions): MachineJob[] {
  return readStore(openRecordReadOnly, location, (reader) => {
    if (!reader) return [];
    const jobs = listJobs(reader, JOB_LIMIT);
    if (!jobs.length) return [];
    const details = reader.all<JobDetails>(`SELECT id,project_id,failures,params FROM jobs
      WHERE id IN (SELECT value FROM json_each(?)) LIMIT ?`, JSON.stringify(jobs.map(({ id }) => id)), JOB_LIMIT);
    const byId = new Map(details.map((row) => [row.id, row]));
    return jobs.map((job) => toHubJob(job, byId.get(job.id)));
  });
}

export function jobsFingerprint(location: LocationOptions): string {
  // Includes live progress and token use, which can change without updated_at.
  return createHash("sha256").update(JSON.stringify(readHubJobs(location))).digest("base64url");
}

const byAction = { pause: "pause", stop: "cancel", resume: "resume", reset: "resume" } as const;

function canRequest(job: JobRow, action: MachineJobActionRequest["action"]): boolean {
  const { state, request } = job;
  switch (action) {
    case "pause": return (state === "running" && request === null) || state === "queued" || state === "waiting";
    case "stop": return (state === "running" && request !== "cancel") || ["queued", "waiting", "paused", "failed"].includes(state);
    case "resume": return (state === "running" && request === "pause") || state === "paused" || state === "waiting";
    case "reset": return state === "failed" && job.failures >= MAX_SAME_FAILURES;
  }
}

type ActionResult = { status: 404 } | { status: 200 | 409; job: MachineJob };
type JobWithProject = JobRow & { root_path: string | null };
const jobById = `SELECT jobs.*, projects.root_path FROM jobs
  LEFT JOIN projects ON projects.id=jobs.project_id WHERE jobs.id=? LIMIT 1`;

function projectCurrent(reader: Pick<RecordReader, "all">, row: JobWithProject): MachineJob {
  return toHubJob(jobListItem(reader, row, 1), row);
}

export function changeHubJob(
  location: LocationOptions, withWriter: WithWriter, env: NodeJS.ProcessEnv | undefined,
  id: string, { action, expectedState }: MachineJobActionRequest,
): ActionResult {
  const before = readStore(openRecordReadOnly, location, (reader): { row: JobWithProject } | { conflict: MachineJob } | undefined => {
    const row = reader?.get<JobWithProject>(jobById, id);
    if (!reader || !row) return undefined;
    if (row.state !== expectedState || !canRequest(row, action)) return { conflict: projectCurrent(reader, row) };
    return { row };
  });
  if (!before) return { status: 404 };
  if ("conflict" in before) return { status: 409, job: before.conflict };

  const result = withWriter<ActionResult>((writer) => {
    const read: Pick<RecordReader, "all"> = {
      all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never,
    };
    const current = writer.db.prepare(jobById).get(id) as JobWithProject | undefined;
    if (!current) return { status: 404 };
    // A second request can arrive before the runner applies a pause or stop.
    // Compare those request flags in addition to the client's state.
    const initial = before.row;
    if (current.state !== initial.state || current.params !== initial.params || current.request !== initial.request
      || !canRequest(current, action)) {
      return { status: 409, job: projectCurrent(read, current) };
    }

    const changes = writer.db.prepare("SELECT total_changes() AS count");
    const priorChanges = changes.get()?.count;
    let updated: JobRow;
    try {
      updated = requestJob(writer, id, byAction[action], { state: current.state, params: current.params, reason: current.reason });
    } catch (error) {
      if (!writer.db.prepare("SELECT 1 FROM jobs WHERE id=? LIMIT 1").get(id)) return { status: 404 };
      throw error;
    }
    const job = projectCurrent(read, { ...updated, root_path: current.root_path });
    const changed = changes.get()?.count !== priorChanges && (updated.state !== current.state || updated.request !== current.request);
    return { status: changed ? 200 : 409, job };
  });
  if (result.status === 200 && byAction[action] === "resume") ensureBackground({ ...location, force: true, env });
  return result;
}
