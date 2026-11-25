import { useId, useRef, useState } from "react";
import type { MachineRepoSetup, MachineSetupQuote, MachineSetupStep } from "@mex/hub-contracts/machine";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
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
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import { jobHash } from "./job-links";
import { JobStateBadge } from "./JobStatus";
import { repoPrefix, reviewHref } from "./review-model";
import { setupJobTokens } from "./setup-model";
import { SetupLearningDialog, SetupLearningOffer } from "./SetupLearning";
import type { HubJob, SetupPreview } from "./types";
import shared from "./machine.module.css";
import styles from "./setup.module.css";

const kinds = ["file-index", "code-facts", "graph-build", "learn-deeper"] as const;
const labels = {
  "file-index": "File index",
  "code-facts": "Code facts",
  "graph-build": "Code map",
  "learn-deeper": "Learn deeper",
} as const;

const status: Record<MachineSetupStep["state"], [HubJob["state"]["phase"], string]> = {
  queued: ["queued", "Queued"],
  running: ["running", "Running"],
  paused: ["paused", "Paused"],
  waiting: ["waiting", "Waiting"],
  done: ["done", "Done"],
  "done with gaps": ["doneWithGaps", "Done with gaps"],
  failed: ["failed", "Failed"],
  cancelled: ["stopped", "Cancelled"],
};

const count = new Intl.NumberFormat("en-US");

function StepRow({ step, repo, search, changeStep }: {
  step: MachineSetupStep;
  repo: MachineRepoSetup;
  search: string;
  changeStep: SetupPreview["changeStep"];
}) {
  const [confirm, setConfirm] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const statusId = useId();
  const { kind, jobId, state, pending, progress, estimate, summary, error, scope, finishedAt } = step;
  const label = labels[kind];
  const [phase, text] = status[state];
  const paid = kind === "learn-deeper";
  const active = phase === "running" || phase === "queued" || phase === "paused" || phase === "waiting";
  const resume = phase === "paused";
  const requestText = pending === "pause" ? "Pausing after this batch. You can resume or cancel when it pauses."
    : pending === "cancel" ? "Cancelling after this batch. Wait for the job to finish stopping." : undefined;
  const progressText = progress?.message ?? (paid && phase === "queued" ? "Starts after the code map and other setup work." : undefined);
  const jobHref = repoPrefix(repo.repoId) + "/jobs" + search + jobHash(jobId);

  return (
    <li className={styles.step}>
      <div className={styles.stepMain}>
        <div className={styles.stepTitle}>
          <h3 ref={heading} tabIndex={-1}>{label}</h3>
          <JobStateBadge phase={phase}>{text}</JobStateBadge>
        </div>
        {scope && scope !== repo.checkout && <p><code>{scope}</code></p>}
        {summary && <p>{summary}</p>}
        {error && <p>{error}</p>}
        <div aria-live="polite" className={styles.progressText} role="status">
          {progressText && <p>{progressText}</p>}
          {requestText && <p id={statusId}>{requestText}</p>}
        </div>
        {progress?.done !== undefined && progress.total ? (
          <progress aria-label={`${label} progress`} aria-valuetext={progress.message} max={progress.total} value={Math.min(progress.done, progress.total)} />
        ) : null}
        {paid && (
          <p>
            {(finishedAt || setupJobTokens(step) > 0) && <>{count.format(setupJobTokens(step))} tokens used{estimate?.tokens !== undefined && " · "}</>}
            {estimate?.tokens !== undefined && <>{count.format(estimate.tokens)} tokens estimated</>}
          </p>
        )}
      </div>
      <div className={styles.stepAside}>
        {active && (
          <div aria-label={`${label} controls`} className={styles.actions} role="group">
            <Button aria-describedby={requestText ? statusId : undefined} disabled={Boolean(pending)} focusableWhenDisabled
              onClick={() => changeStep(jobId, resume ? "resume" : "pause")} size="sm" type="button" variant="outline">
              {resume ? "Resume" : "Pause"}
            </Button>
            <Button aria-describedby={requestText ? statusId : undefined} aria-haspopup="dialog" disabled={Boolean(pending)} focusableWhenDisabled
              onClick={() => { cancelled.current = false; setConfirm(true); }} ref={cancel} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
          </div>
        )}
        {paid && (state === "done" || state === "done with gaps") && (
          <Link className={shared.textLink} to={reviewHref(repo.repoId, undefined, search)}>Open Review <ArrowRight aria-hidden="true" /></Link>
        )}
        <Link aria-label={`View job for ${label}`} className={shared.textLink} to={jobHref}>View job <ArrowRight aria-hidden="true" /></Link>
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent className={styles.confirmation} finalFocus={() => cancelled.current ? heading.current : cancel.current} initialFocus={keep}>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {label.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>Finished work is kept.{state === "running" && " The job stops after the current batch."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={keep}>Keep job</AlertDialogCancel>
            <AlertDialogAction onClick={() => { cancelled.current = true; changeStep(jobId, "cancel"); setConfirm(false); }} type="button">
              Cancel job
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

export function SetupSteps({ repo, search, setup }: {
  repo: MachineRepoSetup;
  search: string;
  setup: SetupPreview;
}) {
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  const [quote, setQuote] = useState<MachineSetupQuote | null>(null);
  return (
    <section aria-labelledby={titleId} className={styles.section}>
      <h2 id={titleId} ref={title} tabIndex={-1}>Setup steps</h2>
      <ol className={styles.steps} role="list">
        {kinds.map((kind) => {
          const step = repo.steps.find((step) => step.kind === kind);
          if (step) return <StepRow changeStep={setup.changeStep} key={step.jobId} repo={repo} search={search} step={step} />;
          if (kind === "learn-deeper") return repo.learnDeeper && (
            <SetupLearningOffer key={kind} offer={repo.learnDeeper} onQuote={setQuote}
              onSkip={() => setup.skipLearning(repo.repoId)} trigger={start} />
          );
          const unavailable = repo.unavailableSteps?.find((step) => step.kind === kind);
          return unavailable && (
            <li className={styles.step} key={kind}>
              <div className={styles.stepMain}>
                <div className={styles.stepTitle}>
                  <h3>{labels[kind]}</h3>
                  <Badge variant="outline">Skipped</Badge>
                </div>
                <p>{unavailable.reason}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <SetupLearningDialog
        finalFocus={() => start.current ?? title.current}
        onClose={() => setQuote(null)}
        onStart={(accepted) => { setup.startLearning(repo.repoId, accepted); setQuote(null); }}
        quote={quote}
      />
    </section>
  );
}
