import { useId } from "react";
import type { MachineProject, MachineRepoSetup, MachineSetup } from "@mex/hub-contracts/machine";
import { ArrowRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { repoPrefix } from "./review-model";
import { SetupQuestions } from "./SetupQuestions";
import { SetupSteps } from "./SetupSteps";
import type { SetupPreview } from "./types";
import { CommandCard, HubPageHeader } from "./ui";
import shared from "./machine.module.css";
import styles from "./setup.module.css";

function setupStatus(repo: MachineRepoSetup | undefined): string {
  if (!repo) return "No setup run";
  if (repo.steps.some(({ state }) => state === "failed")) return "Needs attention";
  const questions = repo.questions.filter(({ outcome }) => !outcome).length;
  if (questions) return questions === 1 ? "1 question waiting" : `${questions} questions waiting`;
  if (repo.steps.some(({ state }) => ["queued", "running", "paused", "waiting"].includes(state))) return "In progress";
  if (repo.learnDeeper?.state === "offered") return "Learn deeper available";
  if (repo.steps.some(({ state }) => state === "cancelled")) return "Stopped";
  if (repo.steps.some(({ state }) => state === "done with gaps")) return "Done with gaps";
  return "Done";
}

function SetupCommand({ project }: { project?: MachineProject }) {
  return (
    <section className={styles.empty}>
      <h2>{project ? "Setup hasn't run for this repo" : "Set up your first repo"}</h2>
      <p>{project ? `Open ${project.name} in a terminal to set it up.` : "Open a repo in a terminal, then run this command."}</p>
      <CommandCard command="mex" compact />
    </section>
  );
}

function SetupRepos({ projects, setup, search }: { projects: MachineProject[]; setup: MachineSetup; search: string }) {
  if (!projects.length) return <SetupCommand />;
  const byRepo = new Map(setup.repos.map((repo) => [repo.repoId, repo]));

  return (
    <>
      <ul aria-label="Repos" className={styles.repoList} role="list">
        {projects.map((project) => {
          const repo = byRepo.get(project.id);
          const checkout = repo?.checkout ?? project.checkouts[0]?.path;
          return (
            <li key={project.id}>
              <div className={styles.repoIdentity}>
                <Link className={shared.textLink} to={repoPrefix(project.id) + "/setup" + search}>
                  {project.name} <ArrowRight aria-hidden="true" />
                </Link>
                {checkout && <code>{checkout}</code>}
              </div>
              <span className={styles.repoStatus}>{setupStatus(repo)}</span>
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
  const seconds = (repo.summary.elapsedMs / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 });
  return (
    <section className={styles.summary}>
      <div>
        <h2>Summary</h2>
        <p>Read {project.name} in {seconds} s, for $0.</p>
        {repo.summary.commandsSaved && <p>Your agents now get its test and build commands.</p>}
        {saved > 0 && <p>Your {saved === 1 ? "answer reaches" : `${saved} answers reach`} your agents as “you said”.</p>}
      </div>
      <div className={styles.rerun}>
        <p>To run setup again, open this repo in a terminal.</p>
        <CommandCard command="mex" compact />
      </div>
    </section>
  );
}

export default function SetupPage({ project, projects, setup }: {
  project?: MachineProject;
  projects: MachineProject[];
  setup: SetupPreview;
}) {
  const { search } = useLocation();
  const repo = setup.data.repos.find(({ repoId }) => repoId === project?.id);

  const learning = repo?.steps.some(({ kind, state }) => kind === "learn-deeper" && state === "running") ?? false;

  return (
    <div className={styles.page}>
      <HubPageHeader
        action={project && <Link className={shared.textLink} to={"/setup" + search}>Show every repo <ArrowRight aria-hidden="true" /></Link>}
        subtitle={project?.name ?? "All repos"}
        title="Setup"
      />
      {!project ? <SetupRepos projects={projects} search={search} setup={setup.data} /> : repo ? (
        <>
          <FreeFindings repo={repo} />
          <SetupSteps key={repo.repoId} repo={repo} search={search} setup={setup} />
          <SetupQuestions key={repo.repoId} learning={learning} questions={repo.questions}
            reply={(id, choice) => setup.replyToQuestion(repo.repoId, id, choice)}
            skipAll={() => setup.skipQuestions(repo.repoId)} />
          <SetupSummary project={project} repo={repo} />
        </>
      ) : <SetupCommand project={project} />}
    </div>
  );
}
