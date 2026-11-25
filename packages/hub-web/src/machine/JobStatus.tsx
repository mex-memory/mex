import type { ReactNode } from "react";
import { Check, CirclePause, CirclePlay, CircleStop, CircleX, Clock3, ListOrdered, TriangleAlert } from "lucide-react";
import { Badge } from "../components/primitives/badge";
import type { HubJob } from "./types";
import styles from "./machine.module.css";

const statusIcons = {
  running: CirclePlay,
  paused: CirclePause,
  waiting: Clock3,
  queued: ListOrdered,
  done: Check,
  doneWithGaps: TriangleAlert,
  failed: CircleX,
  stopped: CircleStop,
};

const number = new Intl.NumberFormat("en");

export function jobResultAmount({ result }: HubJob): string | undefined {
  if (!result) return undefined;
  return `${number.format(result.count)} ${result.unit}${result.count === 1 ? "" : "s"}`;
}

export function jobIsActive({ state }: HubJob) {
  return state.phase === "running" || state.phase === "paused" || state.phase === "waiting";
}

export function jobProgressPercent({ progress }: HubJob) {
  if (!progress || progress.total <= 0) return undefined;
  const percent = Math.round(progress.completed / progress.total * 100);
  return Math.min(100, Math.max(0, percent));
}

function statusLabel(job: HubJob): string {
  switch (job.state.phase) {
    case "running": return job.state.stopping ? "Stopping" : "Running";
    case "paused": return "Paused";
    case "waiting": return `Waiting: ${job.state.reason.replace(/^waiting:\s*/iu, "")}`;
    case "queued": return "Queued";
    case "done": return "Done";
    case "doneWithGaps": return "Done with gaps";
    case "failed": return `Failed: ${job.state.cause}`;
    case "stopped": {
      const amount = jobResultAmount(job);
      return amount ? `Stopped — kept ${amount}` : "Stopped";
    }
  }
}

export function JobStateBadge({ phase, children }: { phase: HubJob["state"]["phase"]; children: ReactNode }) {
  const Icon = statusIcons[phase];
  return (
    <Badge className={styles.jobStatus} data-phase={phase} variant="outline">
      <Icon aria-hidden="true" />
      <span>{children}</span>
    </Badge>
  );
}

export function JobStatus({ job }: { job: HubJob }) {
  return <JobStateBadge phase={job.state.phase}>{statusLabel(job)}</JobStateBadge>;
}

export function JobProgress({ job }: { job: HubJob }) {
  const percent = jobProgressPercent(job);
  if (!jobIsActive(job) || percent === undefined) return null;

  return (
    <span aria-hidden="true" className={styles.jobProgress} data-slot="progress-track">
      <span data-slot="progress-indicator" style={{ width: `${percent}%` }} />
    </span>
  );
}
