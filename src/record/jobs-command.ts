import { openRecord, openRecordReadOnly, projectIdentity, type RecordWriter } from "./index.js";
import { backgroundStatus, ensureBackground, markPending, queueJob, runPendingInForeground, type EnsureResult } from "./background.js";
import { describeJob, jobKind, jobTokenDetails, listJobs, requestJob, TERMINAL_STATES, type JobListItem, type JobRow } from "./jobs.js";
import { detectCaller } from "../repo-start/caller.js";
import { classifyPlace } from "../repo-start/place.js";
import { MARGIN, pad, Rich, visible } from "../repo-start/rich.js";
import { screenMode, wrap } from "../repo-start/screen.js";
import { select } from "../repo-start/select.js";
import { activityCount } from "../repo-start/analysis-screen.js";
import { DEEP_STAGES, readActivity } from "../learn-deeper/activity.js";
import { recordLocation } from "./location.js";
import { relativeTime } from "../shared/relative-time.js";
import "./job-kinds.js";

const STAGE_PROGRESS: Record<(typeof DEEP_STAGES)[number], string> = {
  "Read sources": "reading sources",
  "Sort sources": "sorting sources",
  "Write rules": "writing rules",
  "Check rules": "checking rules against the code",
  "Save rules": "saving rules",
};

/** `mex jobs`: every job on this machine, newest first. Reads only; never starts anything. */
export async function runJobsList(options: { json?: boolean; all?: boolean; details?: boolean }): Promise<void> {
  const reader = openRecordReadOnly();
  let items: ReturnType<typeof listJobs>;
  let status: BackgroundStatus;
  try {
    items = !reader ? [] : options.json ? listJobs(reader, options.all ? 500 : 50)
      : listJobs(reader, -1, { latest: !options.all, details: options.details, terminal: true });
    if (reader) status = backgroundStatus(reader);
  } finally {
    reader?.close();
  }
  if (options.json) {
    const visible = items.map(({ id: _id, ...item }) => item);
    console.log(JSON.stringify({ background: status ?? { running: false, enabled: true }, jobs: visible }, null, 2));
    return;
  }
  if (items.some(item => item.kind === "learn-deeper" && item.state === "running")) {
    const location = recordLocation({ create: false });
    for (const item of items) {
      if (item.kind !== "learn-deeper" || item.state !== "running" || item.doing?.startsWith("interrupted")) continue;
      const activity = readActivity(location, item.id);
      if (!activity) continue;
      const stage = DEEP_STAGES[activity.stage];
      if (stage) item.doing = [STAGE_PROGRESS[stage], activityCount(activity)].filter(Boolean).join(" ");
    }
  }
  for (const line of renderJobs(items, status, { rich: richTerminal(), details: options.details, width: screenMode().width })) console.log(line);
}

type BackgroundStatus = ReturnType<typeof backgroundStatus> | undefined;
const JOBS_FOOTER = [
  "`mex cancel` stops running jobs in this repo · `mex jobs cancel <n>` stops one",
  "`--all` shows history · `--details` shows notes",
];
const plainCommands = (text: string) => text.replace(/`/gu, "");

function displayOrder(a: JobListItem, b: JobListItem): number {
  const rank = (item: JobListItem) => item.state === "running" ? 0 : item.state === "queued" ? 1 : TERMINAL_STATES.includes(item.state) ? 3 : 2;
  const order = rank(a) - rank(b);
  const recent = !order && TERMINAL_STATES.includes(a.state)
    ? Date.parse(b.finishedAt ?? b.updatedAt) - Date.parse(a.finishedAt ?? a.updatedAt) : 0;
  return order || recent || a.position - b.position;
}

function richTerminal(): Rich | undefined {
  const mode = screenMode();
  return detectCaller() === "person" && !mode.plain && !mode.ascii && (mode.width ?? 100) >= 72
    ? new Rich(process.env, Math.min(mode.width ?? 100, 100)) : undefined;
}

function duration(from: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

function mark(item: JobListItem, rich: Rich): string {
  if (item.state === "running") return rich.paint("orange", "◐");
  if (item.state === "done" || item.state === "done with gaps") return rich.paint("ok", "✓");
  if (item.state === "failed") return rich.paint("bad", "✗");
  return rich.dim("◌");
}

function jobLabel(item: JobListItem): string {
  return item.kind === "code-facts" ? "Code facts" : item.label;
}

const labelColumn = (label: string): string => pad(label, Math.max(16, visible(label) + 1));

function jobStatus(item: JobListItem, now: number): string {
  const when = TERMINAL_STATES.includes(item.state) ? relativeTime(item.finishedAt ?? item.updatedAt, now)
    : item.state === "running" ? duration(item.createdAt, now) : undefined;
  const state = item.state === "done" || item.state === "done with gaps" ? undefined : item.state;
  const pending = item.pending === "cancel" ? "stopping after this batch" : item.pending === "pause" ? "pausing after this batch" : undefined;
  const summary = item.summary ?? (item.results ? `${item.results.toLocaleString("en-US")} ${item.results === 1 ? "result" : "results"}${TERMINAL_STATES.includes(item.state) ? "" : " so far"}` : undefined);
  return [state, when, item.reason, item.doing, pending, summary].filter(Boolean).join(" · ");
}

export function renderJobs(items: readonly JobListItem[], status: BackgroundStatus, options: {
  rich?: Rich; details?: boolean; now?: number; width?: number;
} = {}): string[] {
  const { rich } = options;
  const now = options.now ?? Date.now();
  const plainWidth = options.width ? Math.min(100, options.width - 1) : undefined;
  const subtitle = status?.running && status.startedAt
    ? `background process running since ${new Date(status.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : backgroundLine(status);
  const out = rich ? [`${rich.pill("MEX JOBS", "orange")}  ${rich.commands(subtitle)}`] : wrap(plainCommands(backgroundLine(status)), plainWidth, 4);
  if (!items.length) return [...out, ...(rich ? ["", ...rich.text(["No jobs yet."], true)] : ["No jobs yet."])];
  out.push("");
  const groups = new Map<string, JobListItem[]>();
  for (const item of items) {
    const key = item.project?.path ?? "";
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    const project = group[0]!.project;
    const name = project?.name ?? "This machine";
    const path = project?.path ?? "";
    out.push(...(rich ? rich.text([`${rich.bold(name)}${path ? `  ${rich.dim(path)}` : ""}`])
      : wrap(`${name}${path ? `  ${path}` : ""}`, plainWidth, 4)));
    for (const item of group.sort(displayOrder)) {
      const display = jobStatus(item, now);
      const watch = item.kind === "learn-deeper" && item.state === "running" ? project?.name : undefined;
      const number = String(item.position).padStart(2);
      const label = jobLabel(item);
      const details = options.details ? jobTokenDetails(item) : [];
      if (rich) {
        const running = item.state === "running";
        const status = running ? rich.paint("orange", "running") + rich.dim(display.slice("running".length)) : rich.dim(display);
        const hint = watch ? `${rich.dim(" · watch: run ")}${rich.cmd("mex")}${rich.dim(` in ${watch}`)}` : "";
        out.push(...rich.text([`${rich.dim(number)} ${mark(item, rich)} ${labelColumn(running ? rich.bold(label) : label)}${status}${hint}`]));
        out.push(...rich.text(details.map(line => `     ${line}`), true));
      } else {
        const state = item.state === "done" || item.state === "done with gaps" ? "ok" : item.state === "failed" ? "!!" : "..";
        const hint = watch ? ` · watch: run mex in ${watch}` : "";
        out.push(...wrap(`  ${number} ${state} ${labelColumn(label)}${display}${hint}`, plainWidth, 6));
        for (const detail of details) out.push(...wrap(`     ${detail}`, plainWidth, 6));
      }
    }
    out.push("");
  }
  return [...out, ...(rich ? rich.text(JOBS_FOOTER.map(line => rich.commands(line)))
    : JOBS_FOOTER.flatMap(line => wrap(plainCommands(line), plainWidth, 4))), ""];
}

function backgroundLine(status?: BackgroundStatus): string {
  if (!status) return "Background: not started yet.";
  if (!status.enabled) return "Background: off · run waiting jobs here with `mex jobs run`";
  if (status.running) return `Background: running (since ${new Date(status.startedAt!).toLocaleTimeString()}).`;
  return "Background: not running. It starts when work is waiting; `mex jobs run` runs it here.";
}

function pick(writer: RecordWriter, position: string): { id: string; item: JobListItem } {
  const n = Number(position.replace(/^#/, ""));
  const found = Number.isSafeInteger(n) && n > 0
    ? listJobs({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never }, 1, { position: n })[0] : undefined;
  if (!found) throw new Error(`There is no job ${position} in \`mex jobs\`.`);
  return { id: found.id, item: found };
}

function stopSummary(item: JobListItem, job: JobRow, rich?: Rich): string {
  const name = `${item.label.toLowerCase()}${item.project ? ` in ${item.project.name}` : ""}`;
  if (job.request === "cancel") return job.state === "running"
    ? `Stopping ${name} after its current batch.`
    : `Stopping ${name} when the background process can finish it.`;
  if (job.state !== "cancelled") return `${item.label} is already ${job.state}.`;
  if (item.kind !== "learn-deeper") return `Stopped ${name}.`;
  const when = duration(job.created_at, Date.parse(job.finished_at ?? job.updated_at));
  const tokens = job.tokens_used >= 1000 ? `${(job.tokens_used / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k` : String(job.tokens_used);
  const kind = jobKind(item.kind);
  const detail = `after ${when} · ${tokens} tokens used${kind && "cancel" in kind ? " · nothing from this run was saved" : ""}`;
  return `Stopped ${name} ${rich?.dim(detail) ?? detail}`;
}

export async function runCancel(options: { all?: boolean; yes?: boolean }): Promise<number> {
  const place = options.all ? undefined : classifyPlace(process.cwd());
  const reader = openRecordReadOnly();
  let project: { project_id: string } | undefined;
  let items: ReturnType<typeof listJobs>;
  try {
    project = place?.kind === "git" ? reader?.get("SELECT project_id FROM checkouts WHERE path=?", place.root) : undefined;
    items = reader ? listJobs(reader, -1, { live: true, projectId: project?.project_id }).sort(displayOrder) : [];
  } finally { reader?.close(); }
  if (!options.all && place?.kind !== "git") {
    for (const item of items) console.log(describeJob(item));
    if (!items.length) console.log("No live jobs.");
    console.log("Run `mex cancel --all` to stop live jobs on this computer.");
    return 1;
  }
  if ((!options.all && !project) || !items.length) {
    console.log(`No live jobs ${options.all ? "on this computer" : "in this repo"}.`);
    return 0;
  }
  const rich = richTerminal();
  if (!options.yes) {
    if (detectCaller() !== "person") {
      for (const item of items) console.log(describeJob(item));
      console.log(`Pass --yes to confirm: mex cancel${options.all ? " --all" : ""} --yes`);
      return 1;
    }
    const question = `Stop these jobs ${options.all ? "on this computer" : `in ${items[0]!.project?.name ?? "this repo"}`}?`;
    const title = [rich ? `${MARGIN}${rich.bold(question)}` : question, ...items.map(item => {
      const label = options.all && item.project ? `${jobLabel(item)} in ${item.project.name}` : jobLabel(item);
      const usage = item.tokens.used ? ` · ${item.tokens.used.toLocaleString("en-US")} tokens so far` : "";
      const summary = jobStatus(item, Date.now()) + usage;
      return rich ? `${MARGIN}${mark(item, rich)} ${labelColumn(label)}${rich.dim(summary)}` : `  ${label} · ${summary}`;
    }), ""];
    const stop = await select([{ label: "Stop them", value: true }, { label: "Keep them running", value: false }], { rich: rich ?? null, title });
    if (!stop) { console.log("Nothing stopped."); return 0; }
  }
  const writer = openRecord();
  let pending = false;
  try {
    for (const item of items) {
      const current = writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(item.id) as unknown as JobRow | undefined;
      if (!current) continue;
      let stopped = current;
      for (let attempt = 0; attempt < 3 && stopped.request !== "cancel"
        && (stopped.state === "running" || stopped.state === "queued" || stopped.state === "waiting"); attempt++) {
        stopped = requestJob(writer, item.id, "cancel", stopped);
      }
      const message = stopSummary(item, stopped, rich);
      pending ||= stopped.request === "cancel";
      const mark = rich && stopped.state === "cancelled" ? `${rich.paint("ok", "✓")} ` : "";
      for (const line of rich?.text([mark + message]) ?? wrap(message, screenMode().width, 4)) console.log(line);
    }
    if (pending) markPending(writer);
  } finally { writer.close(); }
  if (pending) {
    const background = ensureBackground();
    const retry = "Run `mex jobs run` to finish stopping these jobs.";
    if (!background.started && background.reason === "disabled") console.log(rich ? `${MARGIN}${rich.commands(retry)}` : retry);
  }
  if (items.some(item => item.kind === "learn-deeper")) {
    const next = "Start deep analysis again with `mex learn`. Outside a repo, `mex cancel --all` stops every live job on this computer.";
    for (const line of rich?.text([rich.commands(next)]) ?? [next]) console.log(line);
  }
  return 0;
}

export function runJobsAction(action: "pause" | "resume" | "cancel", position: string): void {
  const writer = openRecord();
  try {
    const { id, item } = pick(writer, position);
    const job = requestJob(writer, id, action);
    const name = `${item.label}${item.project ? ` in ${item.project.name}` : ""}`;
    if (job.state === "queued" && job.request === "cancel") {
      console.log(`${name} will stop when the background process can finish it.`);
    } else if (job.state === "running") {
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
