import { openRecord, openRecordReadOnly, projectIdentity, type RecordWriter } from "./index.js";
import { backgroundStatus, ensureBackground, queueJob, runPendingInForeground, type EnsureResult } from "./background.js";
import { describeJob, listJobs, requestJob, type JobListItem } from "./jobs.js";
import "./job-kinds.js";

/** `mex jobs`: every job on this machine, newest first. Reads only; never starts anything. */
export function runJobsList(options: { json?: boolean; all?: boolean }): void {
  const reader = openRecordReadOnly();
  const items = reader ? listJobs(reader, options.all ? 500 : 50) : [];
  let status: ReturnType<typeof backgroundStatus> | undefined;
  if (reader) {
    // Status needs the lease row; a short writer open is fine for a command.
    const writer = openRecord();
    try { status = backgroundStatus(writer); } finally { writer.close(); }
  }
  reader?.close();
  const visible = items.map(({ id: _id, ...item }) => item);
  if (options.json) {
    console.log(JSON.stringify({ background: status ?? { running: false, enabled: true }, jobs: visible }, null, 2));
    return;
  }
  console.log(backgroundLine(status));
  if (!visible.length) { console.log("No jobs yet."); return; }
  console.log("");
  for (const item of visible) console.log(describeJob(item));
}

function backgroundLine(status?: ReturnType<typeof backgroundStatus>): string {
  if (!status) return "Background: not started yet.";
  if (!status.enabled) return "Background: off. Run waiting jobs here with `mex jobs run`.";
  if (status.running) return `Background: running (since ${new Date(status.startedAt!).toLocaleTimeString()}).`;
  return "Background: not running. It starts when work is waiting; `mex jobs run` runs it here.";
}

function pick(writer: RecordWriter, position: string): { id: string; item: JobListItem } {
  const n = Number(position.replace(/^#/, ""));
  const items = listJobs({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never }, 500);
  const found = Number.isSafeInteger(n) ? items.find((item) => item.position === n) : undefined;
  if (!found) throw new Error(`There is no job ${position} in \`mex jobs\`.`);
  return { id: found.id, item: found };
}

export function runJobsAction(action: "pause" | "resume" | "cancel", position: string): void {
  const writer = openRecord();
  try {
    const { id, item } = pick(writer, position);
    const job = requestJob(writer, id, action);
    const name = `${item.label}${item.project ? ` in ${item.project.name}` : ""}`;
    if (job.state === "running") {
      console.log(job.request ? `${name} will ${action === "pause" ? "pause" : "stop"} after its current batch.` : `${name} will keep running.`);
    } else console.log(`${name} is ${job.state}.`);
    if (action === "resume") report(ensureBackground({ force: true }));
  } finally { writer.close(); }
}

function report(result: EnsureResult): void {
  if (!result.started && result.reason === "disabled") console.log("The background process is off; run it here with `mex jobs run`.");
}

export async function runJobsHere(options: { minutes?: number }): Promise<void> {
  const writer = openRecord();
  try {
    const minutes = options.minutes && options.minutes > 0 ? options.minutes : 10;
    const batches = await runPendingInForeground(writer, minutes * 60_000);
    console.log(batches ? `Ran ${batches} batch${batches === 1 ? "" : "es"}.` : "Nothing to run.");
  } finally { writer.close(); }
}

/** Only registered when MEX_JOBS_DEMO=1: queue a demo job for the current folder. */
export function runJobsDemo(options: { batches?: number; delay?: number; failAt?: number; waitFile?: string; traceFile?: string }): void {
  const writer = openRecord({ projectPath: process.cwd() });
  try {
    const project = writer.checkout(process.cwd())?.project_id ?? projectIdentity(process.cwd()).id;
    const { existing } = queueJob(writer, { kind: "demo", projectId: project, params: {
      batches: options.batches, delayMs: options.delay, failAt: options.failAt, waitFile: options.waitFile, traceFile: options.traceFile,
    } });
    console.log(existing ? "A demo job is already queued for this folder." : "Queued a demo job.");
  } finally { writer.close(); }
  report(ensureBackground());
}
