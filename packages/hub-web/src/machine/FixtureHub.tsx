import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useFixtureKnowledge } from "./fixture-knowledge";
import { useFixtureReview } from "./fixture-review";
import { fixtureHomeReview } from "./fixture-review-data";
import {
  fixtureSetupJobs, replyFixtureQuestions, requestFixtureStep, settleFixtureStep, skipFixtureLearning, startFixtureLearning, updateFixtureRepo, updateFixtureStep,
} from "./fixture-setup";
import { updateFixtureSettings } from "./fixture-settings";
import { getFixture, type FixtureVariant } from "./fixtures";
import { HubShell } from "./HubShell";
import { RelinkPage } from "./pages";
import { HubBrand } from "./ui";
import type { SetupStepAction } from "./setup-model";
import type { AgentRepairResult, BrowserAgentRepair, HubJob, JobAction, SettingsWrite } from "./types";
import styles from "./machine.module.css";

function updateJob(job: HubJob, action: JobAction): HubJob {
  switch (action) {
    case "pause":
      return job.state.phase === "running" ? { ...job, state: { phase: "running", pausing: true } } : job;
    case "resume":
      return job.state.phase === "paused" ? { ...job, state: { phase: "running" } } : job;
    case "stop":
      return { ...job, state: { phase: "stopped" }, activity: undefined };
    case "reset":
      return { ...job, state: { phase: "queued" }, activity: undefined, progress: undefined };
  }
}

export default function FixtureHub({ variant }: { variant: FixtureVariant }) {
  const [fixture] = useState(() => getFixture(variant));
  const [jobs, setJobs] = useState(fixture.jobs);
  const [setup, setSetup] = useState(fixture.setup);
  const [agents, setAgents] = useState(fixture.agents.agents);
  const [settings, setSettings] = useState(fixture.settings.settings);
  const [signedOut, setSignedOut] = useState<Extract<SettingsWrite, { type: "signOut" }>["scope"]>();
  const knowledge = useFixtureKnowledge(fixture.knowledge, fixture.projects, variant);
  const review = useFixtureReview(fixture.review, knowledge, variant);
  const overview = { ...fixture.overview, ...fixtureHomeReview(review.queue) };
  const batchTimers = useRef(new Set<number>());
  const signedOutPage = useRef<HTMLElement>(null);

  useEffect(() => {
    if (signedOut) signedOutPage.current?.focus();
  }, [signedOut]);

  useEffect(() => {
    const timers = batchTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  function afterBatch(finish: () => void) {
    const timer = window.setTimeout(() => {
      batchTimers.current.delete(timer);
      finish();
    }, 800);
    batchTimers.current.add(timer);
  }

  function changeSetupStep(id: string, action: SetupStepAction) {
    const at = new Date().toISOString();
    setSetup((current) => current && updateFixtureStep(current, id, (step) => requestFixtureStep(step, action, at)));
    afterBatch(() => {
      const settledAt = new Date().toISOString();
      setSetup((current) => current && updateFixtureStep(current, id, (step) => settleFixtureStep(step, action, settledAt)));
    });
  }

  function changeJob(id: string, action: JobAction) {
    if (setup) {
      changeSetupStep(id, action === "stop" ? "cancel" : action === "reset" ? "resume" : action);
      return;
    }
    setJobs((current) => current.map((job) => job.id === id ? updateJob(job, action) : job));
    if (action === "pause") {
      afterBatch(() => setJobs((current) => current.map((job) => (
        job.id === id && job.state.phase === "running" && job.state.pausing
          ? { ...job, state: { phase: "paused" } }
          : job
      ))));
    }
  }

  async function repair(preview: BrowserAgentRepair): Promise<AgentRepairResult> {
    const recorded = fixture.agents.repairPreviews[preview.agentId];
    const agent = agents.find(({ id }) => id === preview.agentId);
    if (recorded?.type !== "browser" || recorded.revision !== preview.revision || agent?.repair !== "browser") {
      throw new Error("The repair preview changed.");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    const repaired = {
      ...agent, state: "working", repair: "unavailable",
      hooks: { ...agent.hooks, events: agent.hooks.events.map(({ name }) => ({ name, status: "installed" as const })) },
    } as const;
    setAgents((current) => current.map((item) => item.id === repaired.id ? repaired : item));
    return { agent: repaired };
  }

  function write(request: SettingsWrite) {
    if (request.type === "signOut") setSignedOut(request.scope);
    else setSettings((current) => updateFixtureSettings(current, request));
  }

  if (signedOut) {
    return (
      <main className={styles.fullPage} ref={signedOutPage} tabIndex={-1}>
        <div className={styles.signIn}>
          <HubBrand />
          <p aria-live="polite" className={styles.muted} role="status">
            {signedOut === "everywhere" ? "Signed out everywhere." : "Signed out of this browser."}{" "}
            <span className={styles.signOutSaved}><Check aria-hidden="true" /> Saved</span>
          </p>
          <RelinkPage rejectedLink={false} />
        </div>
      </main>
    );
  }

  return (
    <HubShell
      connectionLost={false}
      preview={{
        jobs: setup ? fixtureSetupJobs(setup) : jobs, overview, knowledge, review, changeJob,
        setup: setup && {
          data: setup, changeStep: changeSetupStep,
          startLearning: (repoId, quote) => {
            const at = new Date().toISOString();
            setSetup((current) => current && updateFixtureRepo(current, repoId, (repo) => startFixtureLearning(repo, quote, at)));
          },
          skipLearning: (repoId) => setSetup((current) => current && updateFixtureRepo(current, repoId, skipFixtureLearning)),
          replyToQuestion: (repoId, questionId, choice) => {
            setSetup((current) => current && updateFixtureRepo(current, repoId, (repo) => replyFixtureQuestions(repo, { questionId, choice })));
          },
          skipQuestions: (repoId) => setSetup((current) => current && updateFixtureRepo(current, repoId, replyFixtureQuestions)),
        },
        agents: { agents, getRepairPreview: (id) => fixture.agents.repairPreviews[id], repair },
        settings: { settings, uninstall: fixture.settings.uninstall, write },
      }}
      projects={fixture.projects}
      projectsError={false}
      retryProjects={() => {}}
      session={fixture.session}
    />
  );
}
