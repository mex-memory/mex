import { Badge, Card, Icon, Meter } from "../../components/primitives";
import { formatClockTime } from "../../lib/format";
import type { Job, JobStepStatus } from "../../lib/types";

const STEP_ICON: Record<JobStepStatus, () => React.ReactNode> = {
  pending: () => Icon.dot({ size: 10 }),
  running: () => <span className="btn__spinner" />,
  succeeded: () => Icon.check({ size: 11 }),
  failed: () => Icon.cross({ size: 11 }),
  skipped: () => Icon.dash({ size: 11 }),
};

const JOB_BADGE = {
  running: { tone: "info", label: "Running" },
  succeeded: { tone: "good", label: "Done" },
  failed: { tone: "bad", label: "Failed" },
} as const;

/**
 * Live checklist for a running job. Steps are declared by the server before any
 * work starts, so the full list is visible from the first frame and nothing
 * appears to "pop in" as it runs.
 */
export function JobProgress(props: {
  job: Job | null;
  title: string;
  pendingLabel?: string;
  /** Hide the log pane for short jobs where the checklist says enough. */
  showLog?: boolean;
}) {
  const { job, title, pendingLabel = "Starting…", showLog = true } = props;

  if (!job) {
    return (
      <Card title={title}>
        <div className="cluster">
          <span className="btn__spinner" />
          <span className="muted">{pendingLabel}</span>
        </div>
      </Card>
    );
  }

  const badge = JOB_BADGE[job.status];
  const done = job.steps.filter((step) => step.status !== "pending" && step.status !== "running").length;

  return (
    <Card
      title={title}
      flush
      actions={
        <>
          <span className="dim tabular" style={{ fontSize: "0.8rem" }}>
            {done}/{job.steps.length}
          </span>
          <Badge tone={badge.tone} dot={job.status === "running"}>
            {badge.label}
          </Badge>
        </>
      }
    >
      <div className="steps">
        {job.steps.map((step) => {
          const fraction =
            step.progress && step.progress.total > 0
              ? Math.max(0, Math.min(100, (step.progress.done / step.progress.total) * 100))
              : null;
          return (
            <div className="step" data-status={step.status} key={step.id}>
              <span className="step__icon">{STEP_ICON[step.status]()}</span>
              <div className="step__body">
                <div className="step__label">{step.label}</div>
                {step.detail && <div className="step__detail">{step.detail}</div>}
                {fraction !== null && step.status === "running" && (
                  <div className="step__meter">
                    <Meter value={fraction} tone="info" label={step.detail ?? step.label} />
                    <span className="step__meter-label tabular">
                      {step.progress!.done.toLocaleString()}/{step.progress!.total.toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
              {step.status === "skipped" && (
                <span className="row__aside">
                  <Badge tone="neutral">skipped</Badge>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {showLog && job.log.length > 0 && (
        <div className="log" role="log" aria-live="polite">
          {job.log.map((entry, index) => (
            <div className="log__line" data-level={entry.level} key={`${entry.at}-${index}`}>
              <span className="log__time">{formatClockTime(entry.at)}</span>
              <span>{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
