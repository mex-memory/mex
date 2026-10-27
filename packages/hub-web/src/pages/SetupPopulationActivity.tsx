import { useEffect, useState, type ReactNode } from "react";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { SetupRun } from "../api/types";
import styles from "../styles/setup.module.css";

type PopulationActivity = NonNullable<SetupRun["populationActivity"]>;
type PopulationCoverage = NonNullable<SetupRun["populationCoverage"]>;

const COVERAGE_STATE_LABELS: Record<PopulationCoverage["subsystems"][number]["state"], string> = {
  pending: "waiting",
  running: "in progress",
  done: "done",
  skipped: "skipped — rerun setup to retry",
};
type PopulationEvent = PopulationActivity["events"][number];

const TARGET_LABELS: Record<NonNullable<PopulationEvent["target"]>, string> = {
  architecture: "architecture notes",
  stack: "technology notes",
  conventions: "development conventions",
  decisions: "project decisions",
  setup: "setup notes",
  router: "project guide",
  agents: "agent instructions",
  patterns: "project patterns",
};

const PROVIDER_NAMES: Record<NonNullable<SetupRun["populationTool"]>, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  opencode: "OpenCode",
};

/** Activity timestamps remain independent of the read-only session transcript. */
export function SetupPopulationActivity({ run, children }: { run: SetupRun; children?: ReactNode }) {
  const activity = run.populationActivity;
  const tool = activity?.tool ?? run.populationTool;
  const provider = tool ? PROVIDER_NAMES[tool] : "Your agent";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const startedAt = activity ? Date.parse(activity.startedAt) : null;
  const lastActivityAt = activity?.lastActivityAt ? Date.parse(activity.lastActivityAt) : null;
  const quietSince = lastActivityAt ?? startedAt;
  const quiet = quietSince !== null && now - quietSince >= 90_000;
  const events = activity?.events ?? [];
  const recent = events.slice(-3).reverse();
  const older = events.slice(0, -3).reverse();
  const latest = events.at(-1);

  return (
    <section className={styles.populationActivity} aria-labelledby="population-activity-title">
      <div className={styles.activityHeading}>
        <span className={styles.activityPulse} aria-hidden="true"><LoaderCircle className={styles.spin} /></span>
        <div>
          <p className={styles.activityEyebrow}>Background session</p>
          <h3 id="population-activity-title">{provider} is building your project memory</h3>
        </div>
      </div>
      <p className={styles.activityTiming} aria-live="off">
        {startedAt !== null ? `Running for ${formatDuration(now - startedAt)}` : "Starting background population"}
        <span aria-hidden="true"> · </span>
        {lastActivityAt !== null
          ? `Last activity ${formatDuration(now - lastActivityAt)} ago`
          : "Waiting for the first activity report"}
      </p>
      {run.populationCoverage ? <SubsystemCoverage coverage={run.populationCoverage} /> : null}
      {quiet ? (
        <p className={styles.activityQuiet}>
          No new activity reported for {formatDuration(now - quietSince!)}. {provider} may still be working.
        </p>
      ) : null}
      <div className={styles.activityAnnouncement} role="status" aria-live="polite" aria-atomic="true">
        {quiet ? "No new activity has been reported for at least 90 seconds." : latest ? eventLabel(latest) : "Waiting for the agent to report activity."}
      </div>
      {children ?? (recent.length > 0 ? (
        <ol className={styles.activityList} aria-label="Recent agent activity">
          {recent.map((event, index) => <ActivityRow key={event.id} event={event} current={index === 0} startedAt={startedAt!} />)}
        </ol>
      ) : (
        <p className={styles.activityWaiting}>Activity will appear here as your agent reads the project and updates its memory.</p>
      ))}
      {!children && older.length > 0 ? (
        <details className={styles.activityHistory}>
          <summary>View earlier activity ({older.length})</summary>
          <ol className={styles.activityList} aria-label="Earlier agent activity">
            {older.map((event) => <ActivityRow key={event.id} event={event} current={false} startedAt={startedAt!} />)}
          </ol>
          {activity && activity.totalEvents > events.length ? <p>Showing the latest {events.length} activity reports.</p> : null}
        </details>
      ) : null}
    </section>
  );
}

/** One session per subsystem on larger repositories: how far the plan is. */
function SubsystemCoverage({ coverage }: { coverage: PopulationCoverage }) {
  const phase = coverage.phase === "shared"
    ? "Filling the shared files first"
    : coverage.phase === "final" ? "Writing patterns, routing rows and edges" : null;
  return (
    <div className={styles.activityCoverage}>
      <p>
        <strong>{coverage.done}/{coverage.total} subsystems done</strong>
        {coverage.skipped > 0 ? ` · ${coverage.skipped} skipped` : ""}
        {phase ? ` · ${phase}` : ""}
      </p>
      <ul aria-label="Subsystem progress">
        {coverage.subsystems.map((entry) => (
          <li key={entry.path} data-state={entry.state}>
            <span>{entry.path}/</span> <span>{COVERAGE_STATE_LABELS[entry.state]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActivityRow({ event, current, startedAt }: { event: PopulationEvent; current: boolean; startedAt: number }) {
  return (
    <li data-state={event.state} data-current={current}>
      <span className={styles.activityMark} aria-hidden="true">
        {event.state === "completed" ? <Check /> : event.state === "failed" ? <CircleAlert /> : current ? <LoaderCircle className={styles.spin} /> : <span>·</span>}
      </span>
      <span>{eventLabel(event)}</span>
      <time dateTime={event.at} title={new Date(event.at).toLocaleTimeString()}>{formatDuration(Date.parse(event.at) - startedAt)}</time>
    </li>
  );
}

function eventLabel(event: PopulationEvent): string {
  const target = event.target ? TARGET_LABELS[event.target] : undefined;
  const labels: Record<PopulationEvent["kind"], [string, string, string]> = {
    starting: ["Starting the background session", "Background session started", "Could not start the background session"],
    started: ["Background session started", "Background session started", "Background session failed"],
    reading: [`Reading ${target ?? "repository files"}`, `Read ${target ?? "repository files"}`, `Could not read ${target ?? "repository files"}`],
    searching: ["Searching for project information", "Searched for project information", "Project information search failed"],
    writing: [`Updating ${target ?? "project memory"}`, `Updated ${target ?? "project memory"}`, `Could not update ${target ?? "project memory"}`],
    running_command: ["Running a project command", "Finished a project command", "Project command failed"],
    delegating: ["Delegating a task", "Delegated a task", "Could not delegate a task"],
    working: ["Working on project memory", "Worked on project memory", "Project memory task failed"],
    completed: ["Agent session finished", "Agent session finished", "Agent session failed"],
    failed: ["Agent session failed", "Agent session failed", "Agent session failed"],
  };
  return labels[event.kind][event.state === "completed" ? 1 : event.state === "failed" ? 2 : 0];
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
