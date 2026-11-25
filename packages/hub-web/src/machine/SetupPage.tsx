import { Fragment, useId } from "react";
import type { MachineProject, MachineRepoSetup, MachineSetup, MachineSetupRepoStatus } from "@mex/hub-contracts/machine";
import { ArrowRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import type { ControlConnection } from "./data";
import { JobStateBadge } from "./JobStatus";
import { repoPrefix } from "./review-model";
import { SetupQuestions } from "./SetupQuestions";
import { useLiveSetup } from "./setup-data";
import { SetupSteps } from "./SetupSteps";
import type { SetupControls, SetupPreview } from "./types";
import { CommandCard, HubPageHeader, PageRequestState } from "./ui";
import shared from "./machine.module.css";
import styles from "./setup.module.css";

type SetupPhase = Parameters<typeof JobStateBadge>[0]["phase"];

/** The repo list uses the same badges as the step rows. */
function setupStatus(repo: MachineRepoSetup | undefined): [SetupPhase, string] {
  if (!repo) return ["stopped", "No setup run"];
  if (repo.steps.some(({ state }) => state === "failed")) return ["failed", "Needs attention"];
  const questions = repo.questions.filter(({ outcome }) => !outcome).length;
  if (questions) return ["waiting", questions === 1 ? "1 question waiting" : `${questions} questions waiting`];
  if (repo.steps.some(({ state }) => ["queued", "running", "paused", "waiting"].includes(state))) return ["running", "In progress"];
  if (repo.learnDeeper?.state === "offered") return ["queued", "Learn deeper available"];
  if (repo.steps.some(({ state }) => state === "cancelled")) return ["stopped", "Stopped"];
  if (repo.steps.some(({ state }) => state === "done with gaps")) return ["doneWithGaps", "Done with gaps"];
  return ["done", "Done"];
}

const repoStatuses: Record<MachineSetupRepoStatus["status"], [SetupPhase, string]> = {
  missing: ["failed", "Folder missing"],
  notStarted: ["stopped", "No setup run"],
  failed: ["failed", "Needs attention"],
  running: ["running", "In progress"],
  stopped: ["stopped", "Stopped"],
  doneWithGaps: ["doneWithGaps", "Done with gaps"],
  done: ["done", "Done"],
};

function SetupCommand({ project, missing }: { project?: MachineProject; missing?: boolean }) {
  return (
    <section className={styles.empty}>
      {missing ? <p>The repo folder is missing. Restore it and run <code>mex</code> in the repo to try again.</p> : (
        <>
          <h2>{project ? "Setup hasn't run for this repo" : "Set up your first repo"}</h2>
          <p>{project ? `Open ${project.name} in a terminal to set it up.` : "Open a repo in a terminal, then run this command."}</p>
        </>
      )}
      <CommandCard command="mex" compact />
    </section>
  );
}

function SetupRepos({ projects, setup, repos, search }: {
  projects: MachineProject[]; setup?: MachineSetup; repos?: readonly MachineSetupRepoStatus[]; search: string;
}) {
  if (!projects.length) return <SetupCommand />;
  const fixture = new Map(setup?.repos.map(repo => [repo.repoId, repo]));
  const live = new Map(repos?.map(repo => [repo.repoId, repo]));

  return (
    <>
      <ul aria-label="Repos" className={styles.repoList} role="list">
        {projects.map((project) => {
          const row = live.get(project.id);
          const repo = fixture.get(project.id);
          const checkout = row?.checkout ?? repo?.checkout ?? project.checkouts[0]?.path;
          const [phase, text] = row ? repoStatuses[row.status] : setupStatus(repo);
          return (
            <li key={project.id}>
              <div className={styles.repoIdentity}>
                <Link className={shared.textLink} to={repoPrefix(project.id) + "/setup" + search}>
                  {project.name} <ArrowRight aria-hidden="true" />
                </Link>
                {checkout && <code>{checkout}</code>}
              </div>
              <span className={styles.repoStatus}><JobStateBadge phase={phase}>{text}</JobStateBadge></span>
            </li>
          );
        })}
      </ul>
      <section className={styles.summary}>
        <div>
          <h2>Set up another repo</h2>
          <p>Run this command in that repo's terminal.</p>
        </div>
        <CommandCard command="mex" compact />
      </section>
    </>
  );
}

function FreeFindings({ repo }: { repo: MachineRepoSetup }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={styles.freeFindings}>
      <header className={styles.sectionHeader}>
        <h2 id={titleId}>Free setup</h2>
        <code>{repo.checkout}</code>
      </header>
      {repo.summary.findings.length > 0 && (
        <dl className={styles.findings}>
          {repo.summary.findings.map(({ label, text }, index) => (
            <div key={index}><dt>{label}</dt><dd>{text}</dd></div>
          ))}
        </dl>
      )}
    </section>
  );
}

function SetupSummary({ project, repo }: { project: MachineProject; repo: MachineRepoSetup }) {
  const saved = repo.questions.filter(({ outcome }) => outcome?.status === "saved").length;
  const { elapsedMs } = repo.summary;
  return (
    <section className={styles.summary}>
      <div>
        <h2>Summary</h2>
        {elapsedMs !== undefined && <p>Read {project.name} in {(elapsedMs / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} s, for $0.</p>}
        {repo.summary.commandsSaved && <p>Your agents now get its commands.</p>}
        {saved > 0 && <p>Your {saved === 1 ? "answer reaches" : `${saved} answers reach`} your agents as “you said”.</p>}
      </div>
      <div className={styles.rerun}>
        <p>To run setup again, open this repo in a terminal.</p>
        <CommandCard command="mex" compact />
      </div>
    </section>
  );
}

function RepoSetup({ project, repo, search, controls, disabled }: {
  project: MachineProject; repo: MachineRepoSetup; search: string; controls: SetupControls; disabled?: boolean;
}) {
  if (repo.missingCheckout) return <SetupCommand missing project={project} />;
  const learning = repo.steps.some(({ kind, state }) => kind === "learn-deeper" && state === "running");
  return (
    <Fragment key={repo.checkout}>
      <FreeFindings repo={repo} />
      <SetupSteps disabled={disabled} repo={repo} search={search} setup={controls} />
      <SetupQuestions disabled={disabled} learning={learning} questions={repo.questions}
        reply={(id, choice) => controls.replyToQuestion(repo.repoId, id, choice)}
        skipAll={() => controls.skipQuestions(repo.repoId)} />
      <SetupSummary project={project} repo={repo} />
    </Fragment>
  );
}

type Scope = { project?: MachineProject; projects: MachineProject[]; search: string };

function ConnectedSetup({ project, projects, search, live }: Scope & { live: ControlConnection }) {
  const { query, repo, controls, pending, feedback } = useLiveSetup(live, project?.id);
  const { repos, issue, updatingSince } = query.data ?? {};
  const loaded = (project ? repo : repos) !== undefined;
  return (
    <>
      {(feedback || issue || loaded && updatingSince) && (
        <p className={shared.muted} role="status">{feedback || issue || "Updating setup…"}</p>
      )}
      {!loaded ? <PageRequestState name="Setup" error={query.isError} loading={!query.isError && !issue} retry={() => void query.refetch()} />
        : !project ? <SetupRepos projects={projects} repos={repos} search={search} />
        : repo ? <RepoSetup controls={controls} disabled={pending || !!issue} project={project} repo={repo} search={search} />
        : <SetupCommand project={project} />}
    </>
  );
}

export default function SetupPage({ project, projects, setup, live }: {
  project?: MachineProject; projects: MachineProject[]; setup?: SetupPreview; live?: ControlConnection;
}) {
  const { search } = useLocation();
  const repo = setup?.data.repos.find(({ repoId }) => repoId === project?.id);
  return (
    <div className={styles.page}>
      <HubPageHeader
        action={project && <Link className={shared.textLink} to={"/setup" + search}>Show every repo <ArrowRight aria-hidden="true" /></Link>}
        subtitle={project?.name ?? "All repos"}
        title="Setup"
      />
      {live ? <ConnectedSetup key={project?.id ?? "all"} live={live} project={project} projects={projects} search={search} />
        : !project ? <SetupRepos projects={projects} search={search} setup={setup?.data} />
        : repo && setup ? <RepoSetup controls={setup} project={project} repo={repo} search={search} />
        : <SetupCommand project={project} />}
    </div>
  );
}
