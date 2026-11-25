import { useId, useLayoutEffect, useRef, useState } from "react";
import type { MachineProject } from "@mex/hub-contracts/machine";
import { ArrowRight, ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { Button } from "../components/primitives/button";
import { JobProgress, JobStatus, jobIsActive, jobResultAmount } from "./JobStatus";
import { jobHash } from "./job-links";
import { localDateTime } from "./local-time";
import type { HubJob, JobAction } from "./types";
import { HubPageHeader, PageRequestState, type PageLoad } from "./ui";
import styles from "./jobs.module.css";
import shared from "./machine.module.css";

const order = new Intl.PluralRules("en", { type: "ordinal" });
const suffix: Partial<Record<Intl.LDMLPluralRule, string>> = { one: "st", two: "nd", few: "rd" };
const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function tokenCount(count: number) {
  return compactNumber.format(count).toLowerCase();
}

function jobCost({ cost, kind, state }: HubJob): string {
  const idle = (state.phase === "queued" || state.phase === "waiting") && (cost?.startsWhenIdle || kind === "learn-deeper-weekly");
  if (!cost) return idle ? "Starts when you're not coding" : "No AI cost";
  const estimate = tokenCount(cost.estimatedTokens);
  const suffix = idle ? " · starts when you're not coding" : "";
  if (cost.usedTokens !== undefined) {
    const used = tokenCount(cost.usedTokens);
    const amount = cost.estimatedTokens ? `${used} of about ${estimate} tokens (estimated)` : `${used} tokens`;
    return amount + suffix;
  }
  return `About ${estimate} tokens (estimated)${suffix}`;
}

type ActionState = { action: JobAction; pending: boolean };
type ChangeJob = (job: HubJob, action: JobAction) => void | Promise<void>;

interface JobControls {
  changeJob: ChangeJob;
  confirmStop: (job: HubJob, trigger: HTMLButtonElement) => void;
  states: ReadonlyMap<string, ActionState>;
}

function actionProgress(action: JobAction) {
  if (action === "pause") return "Pausing after this batch…";
  if (action === "stop") return "Stopping after this batch…";
  return "Resuming…";
}

function JobNextAction({ job, actionState, changeJob }: { job: HubJob; actionState?: ActionState; changeJob: ChangeJob }) {
  const reasonId = useId();
  let action: JobAction;
  let label: string;
  let reason: string | undefined;

  switch (job.state.phase) {
    case "running":
      action = "pause";
      label = "Pause";
      if (job.state.stopping) reason = actionProgress("stop");
      else if (job.state.pausing) reason = actionProgress("pause");
      break;
    case "paused":
      action = "resume";
      label = "Resume";
      break;
    case "failed":
      action = "reset";
      label = "Reset this job";
      if (job.state.identicalFailures < 3) reason = "Available after 3 identical failures.";
      break;
    default:
      return null;
  }

  if (actionState?.pending) reason = actionProgress(actionState.action);
  const error = actionState && !actionState.pending && actionState.action !== "stop";
  return (
    <div className={styles.nextAction}>
      <Button
        aria-describedby={reason || error ? reasonId : undefined}
        disabled={reason !== undefined}
        onClick={() => void changeJob(job, action)}
        size="sm"
        type="button"
        variant="outline"
      >
        {label}
      </Button>
      {(reason || error) && (
        <p className={styles.disabledReason} id={reasonId} role="status">{reason ?? "Couldn’t update this job. Try again."}</p>
      )}
    </div>
  );
}

function JobRow({ job, repoName, position, controls, linked }: {
  job: HubJob;
  repoName?: string;
  position?: number;
  controls: JobControls;
  linked: boolean;
}) {
  const [expanded, setExpanded] = useState(linked);
  const toggle = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!linked) return;
    setExpanded(true);
    toggle.current?.focus({ preventScroll: true });
    toggle.current?.scrollIntoView?.({ block: "nearest" });
  }, [linked]);
  const detailsId = useId();
  const stopStatusId = useId();
  const actionState = controls.states.get(job.id);
  const stopping = job.state.phase === "running" && job.state.stopping;
  const canStop = jobIsActive(job) || job.state.phase === "queued";
  const stopStatus = stopping ? actionProgress("stop")
    : actionState?.action === "stop" ? (actionState.pending ? actionProgress("stop") : "Couldn’t stop this job. Try again.") : undefined;
  const identity = repoName ? `${job.label} · ${repoName}` : job.label;

  return (
    <li className={styles.job}>
      <div className={styles.jobTop}>
        <button
          aria-controls={detailsId}
          aria-expanded={expanded}
          className={styles.jobToggle}
          onClick={() => setExpanded(!expanded)}
          ref={toggle}
          type="button"
        >
          <ChevronRight aria-hidden="true" className={styles.chevron} />
          <span className={styles.identity} title={identity}>
            <strong>{job.label}</strong>{repoName && <> · {repoName}</>}
          </span>
          <JobStatus job={job} />
          <span className={styles.work}>
            {job.activity && <span className={styles.activity} title={job.activity}>{job.activity}</span>}
            <JobProgress job={job} />
          </span>
        </button>
        <JobNextAction actionState={actionState} changeJob={controls.changeJob} job={job} />
      </div>
      <div className={styles.details} hidden={!expanded} id={detailsId}>
        <ul aria-label="Job details" className={styles.facts} role="list">
          <li>{job.kind}</li>
          {job.result && <li>{job.result.verb} {jobResultAmount(job)}</li>}
          <li>{jobCost(job)}</li>
          {job.started && <li>Added <time dateTime={job.started}>{localDateTime.format(new Date(job.started))}</time></li>}
          {position !== undefined && <li>{position}{suffix[order.select(position)] ?? "th"} in line</li>}
        </ul>
        {canStop && (
          <div className={styles.nextAction}>
            <Button
              aria-describedby={stopStatus ? stopStatusId : undefined}
              aria-haspopup="dialog"
              disabled={Boolean(stopping || actionState?.pending)}
              onClick={(event) => controls.confirmStop(job, event.currentTarget)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            {stopStatus && <p className={styles.disabledReason} id={stopStatusId} role="status">{stopStatus}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

interface JobListProps {
  jobs: readonly HubJob[];
  repoNames?: ReadonlyMap<string, string>;
  positions?: ReadonlyMap<string, number>;
  linkedJob?: string;
  controls: JobControls;
}

function JobList({ jobs, repoNames, positions, controls, linkedJob }: JobListProps) {
  return (
    <ul className={styles.jobs} role="list">
      {jobs.map((job) => (
        <JobRow
          controls={controls}
          job={job}
          key={job.id}
          linked={job.id === linkedJob}
          position={positions?.get(job.id)}
          repoName={repoNames && job.repoId ? repoNames.get(job.repoId) ?? "Unknown repo" : undefined}
        />
      ))}
    </ul>
  );
}

function JobSection({ title, ...list }: { title: string } & JobListProps) {
  const titleId = useId();
  if (list.jobs.length === 0) return null;

  return (
    <section aria-labelledby={titleId} className={styles.section}>
      <h2 id={titleId}>{title}</h2>
      <JobList {...list} />
    </section>
  );
}

function FinishedJobs(list: JobListProps) {
  if (list.jobs.length === 0) return null;

  return (
    <details className={styles.finished} open={list.jobs.some(({ id }) => id === list.linkedJob) || undefined}>
      <summary className={styles.finishedToggle}>
        <h2>
          <ChevronRight aria-hidden="true" className={styles.chevron} />
          Finished in the last 7 days ({list.jobs.length})
        </h2>
      </summary>
      <JobList {...list} />
    </details>
  );
}

interface JobsPageProps {
  project?: MachineProject;
  projects: MachineProject[];
  jobs?: readonly HubJob[];
  load?: PageLoad;
  changeJob: ChangeJob;
  allJobsHref: string;
}

export default function JobsPage({ project, projects, jobs, load, changeJob, allJobsHref }: JobsPageProps) {
  const { hash } = useLocation();
  const [stopTarget, setStopTarget] = useState<HubJob | null>(null);
  const [actionStates, setActionStates] = useState(new Map<string, ActionState>());
  const inFlight = useRef(new Set<string>());
  const pageTitle = useRef<HTMLHeadingElement>(null);
  const keepRunning = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const focusedControl = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (focusedControl.current && !focusedControl.current.isConnected && document.activeElement === document.body) {
      pageTitle.current?.focus();
    }
  }, [jobs]);

  const repoNames = project ? undefined : new Map(projects.map(({ id, name }) => [id, name]));
  const scopedJobs = jobs?.filter(({ repoId }) => !project || repoId === project.id) ?? [];
  const positions = new Map(jobs?.filter(({ state }) => state.phase === "queued").map((job, index) => [job.id, index + 1]));
  const retained = stopTarget && jobResultAmount(stopTarget);
  const listProps = {
    repoNames,
    linkedJob: scopedJobs.find(({ id }) => jobHash(id) === hash)?.id,
    controls: {
      changeJob: submit,
      states: actionStates,
      confirmStop: (job: HubJob, trigger: HTMLButtonElement) => {
        returnFocus.current = trigger;
        setStopTarget(job);
      },
    },
  };

  function setActionState(id: string, state?: ActionState) {
    setActionStates((current) => {
      const next = new Map(current);
      if (state) next.set(id, state);
      else next.delete(id);
      return next;
    });
  }

  async function submit(job: HubJob, action: JobAction) {
    if (inFlight.current.has(job.id)) return;
    inFlight.current.add(job.id);
    setActionState(job.id, { action, pending: true });
    try {
      await changeJob(job, action);
      setActionState(job.id);
    } catch {
      setActionState(job.id, { action, pending: false });
    } finally {
      inFlight.current.delete(job.id);
    }
  }

  function stopJob() {
    if (!stopTarget) return;
    returnFocus.current = null;
    void submit(stopTarget, "stop");
    setStopTarget(null);
  }

  return (
    <div
      className={styles.page}
      onFocusCapture={(event) => { focusedControl.current = event.target; }}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusedControl.current = null;
      }}
    >
      <HubPageHeader
        action={project && <Link className={shared.textLink} to={allJobsHref}>Show every repo <ArrowRight aria-hidden="true" /></Link>}
        subtitle={project ? `Jobs for ${project.name}` : "Every job on this machine"}
        title="Jobs"
        titleRef={pageTitle}
      />
      <PageRequestState name="jobs" {...load} />
      {jobs && (scopedJobs.length === 0 ? (
        <p className={shared.muted}>No jobs to show.</p>
      ) : (
        <>
          <JobSection {...listProps} jobs={scopedJobs.filter(jobIsActive)} title="Running and waiting" />
          <JobSection {...listProps} jobs={scopedJobs.filter(({ state }) => state.phase === "queued")} positions={positions} title="Queued" />
          <FinishedJobs {...listProps} jobs={scopedJobs.filter((job) => !jobIsActive(job) && job.state.phase !== "queued")} />
          <AlertDialog open={stopTarget !== null} onOpenChange={(open) => { if (!open) setStopTarget(null); }}>
            <AlertDialogContent
              className={styles.confirmation}
              finalFocus={() => returnFocus.current?.isConnected ? returnFocus.current : pageTitle.current}
              initialFocus={keepRunning}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>Stop {stopTarget?.label}?</AlertDialogTitle>
                <AlertDialogDescription>Finished work is kept{retained ? ` (${retained} so far)` : ""}.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel ref={keepRunning}>Keep running</AlertDialogCancel>
                <AlertDialogAction onClick={stopJob} type="button">Stop job</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ))}
    </div>
  );
}
