import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { MachineProject } from "@mex/hub-contracts/machine";
import { ArrowRight, ArrowUpRight, Check, FolderX, Info } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "../components/primitives/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/primitives/tooltip";
import { ActivityChart, ActivityLegend, KnowledgeChart, KnowledgeLegend, SessionsSparkline, UsageMeter } from "./HomeCharts";
import { JobProgress, jobProgressPercent, JobStatus } from "./JobStatus";
import { fullDateTime, relativeTime } from "./local-time";
import { RepoCheckouts } from "./pages";
import type { HomeOverview, HubJob, KnowledgeKind, KnowledgeSummary } from "./types";
import { CopyButton, PageRequestState, type PageLoad } from "./ui";
import styles from "./home.module.css";
import shared from "./machine.module.css";

const ruleLimit = 4;
const sessionLimit = 3;
const kinds = ["rule", "recipe", "decision", "pitfall", "procedure", "fact", "hint"] as const satisfies readonly KnowledgeKind[];
const emptyKnowledge: KnowledgeSummary = {
  total: 0, upToDate: 0, codeChanged: 0, outOfDate: 0, notChecked: 0, onlyYou: 0, team: 0, byKind: {},
};
const number = new Intl.NumberFormat();

type RepoNames = ReadonlyMap<string, string>;
type Rule = HomeOverview["needs"][number];
type NeedsCount = HomeOverview["needsCount"][string];
type FolderIssue = { key: string; repoId: string; text: string; path?: string };

function HomeCard({ id, title, layout, meta, extra, children }: {
  id?: string;
  title: string;
  layout: string;
  meta?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={`${styles.card} ${layout}`} id={id} tabIndex={id ? -1 : undefined}>
      <div className={styles.cardHeading}>
        <div>
          <h2 id={titleId}>{title}</h2>
          {meta && <span> · {meta}</span>}
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

function StatTile({ label, value, note, href, action, children }: {
  label: string;
  value: string | number;
  note: ReactNode;
  href?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.tile}>
      <div className={styles.tileHeading}>
        {href?.startsWith("#") ? (
          <a className={styles.tileAction} href={href}>{label}<ArrowUpRight aria-hidden="true" /></a>
        ) : href ? (
          <Link className={styles.tileAction} to={href}>{label}<ArrowUpRight aria-hidden="true" /></Link>
        ) : <span>{label}</span>}
        {action}
      </div>
      <div className={styles.tileValue}>{typeof value === "number" ? number.format(value) : value}</div>
      <div className={styles.tileNote}>{note}</div>
      <div className={styles.tileVisual}>{children}</div>
    </div>
  );
}

function waitingAge(at: string, now: Date) {
  const days = Math.floor((now.getTime() - Date.parse(at)) / 86_400_000);
  if (days < 1) return "less than a day";
  return `${number.format(days)} ${days === 1 ? "day" : "days"}`;
}

function RuleRows({ rules, repoNames, now }: { rules: readonly Rule[]; repoNames: RepoNames; now: Date }) {
  return (
    <ul className={styles.rows} role="list">
      {rules.map(({ id, rule, repoId, waitingSince }) => (
        <li className={styles.needRow} key={`${repoId}:${id}`}>
          <span title={rule}>{rule}</span>
          <div className={styles.ruleMeta}>
            {repoNames.has(repoId) && <span className={styles.repoChip}>{repoNames.get(repoId)}</span>}
            <time dateTime={waitingSince}>{waitingAge(waitingSince, now)}</time>
          </div>
        </li>
      ))}
    </ul>
  );
}

function NeedsYou({ rules, count, pending, folders, repoNames, now, search }: {
  rules: readonly Rule[];
  count: number;
  pending: boolean;
  folders: readonly FolderIssue[];
  repoNames: RepoNames;
  now: Date;
  search: string;
}) {
  const review = useRef<HTMLDialogElement>(null);
  const reviewTitle = useId();
  const more = count - Math.min(rules.length, ruleLimit);

  return (
    <>
      <HomeCard title="Needs you" id="needs-you" layout={styles.reviewCard}>
        {rules.length > 0 && <RuleRows rules={rules.slice(0, ruleLimit)} repoNames={repoNames} now={now} />}
        {folders.map(({ key, repoId, text, path }) => (
          <div className={styles.folderIssue} key={key}>
            <FolderX aria-hidden="true" />
            <span title={path}>{text}</span>
            <Link className={shared.textLink} to={`/repos/${encodeURIComponent(repoId)}${search}#checkouts`}>Fix</Link>
          </div>
        ))}
        {pending && <p className={styles.quietState}>—</p>}
        {!pending && !count && !folders.length && (
          <p className={styles.quietState}><Check aria-hidden="true" />Nothing needs you right now.</p>
        )}
        {(rules.length > 0 || more > 0) && (
          <div className={styles.cardActions}>
            {rules.length > 0 && (
              <Button size="sm" onClick={() => review.current?.showModal()}>Open Review <ArrowRight aria-hidden="true" /></Button>
            )}
            {more > 0 && <span>+{number.format(more)} more</span>}
          </div>
        )}
      </HomeCard>
      {rules.length > 0 && (
        <dialog aria-labelledby={reviewTitle} className={styles.reviewDialog} ref={review}>
          <div className={styles.cardHeading}>
            <h2 id={reviewTitle}>Review waiting rules</h2>
            <form method="dialog"><Button size="sm" type="submit" variant="outline">Close</Button></form>
          </div>
          <RuleRows rules={rules} repoNames={repoNames} now={now} />
        </dialog>
      )}
    </>
  );
}

/** Where the waiting rules are: by repo across all repos, by age inside one repo. */
function WaitingBreakdown({ counts, repoNames, scoped, now }: {
  counts: readonly [string, NeedsCount][];
  repoNames: RepoNames;
  scoped: boolean;
  now: Date;
}) {
  if (!counts.length) return null;
  const { count, oldest } = counts[0][1];
  let parts: string[];
  if (scoped && Date.parse(oldest) >= now.getTime() - 7 * 86_400_000) {
    parts = [`${number.format(count)} this week`, "0 older"];
  } else {
    const sorted = [...counts].sort((a, b) => b[1].count - a[1].count);
    parts = sorted.slice(0, 2).map(([id, repo]) => `${repoNames.get(id) ?? id} ${number.format(repo.count)}`);
    if (sorted.length > 2) parts.push(`+${number.format(sorted.length - 2)}`);
  }
  const text = parts.join(" · ");
  return <p className={styles.tileBreakdown} title={text}>{text}</p>;
}

function Activity({ days, sessions, repoNames, now, showSetup }: {
  days: HomeOverview["activity"];
  sessions: HomeOverview["sessions"];
  repoNames: RepoNames;
  now: Date;
  showSetup: boolean;
}) {
  return (
    <HomeCard
      extra={days.some(({ sessions, gave, heldBack, replaced }) => sessions || gave || heldBack || replaced) && <ActivityLegend />}
      id="activity"
      layout={styles.activityCard}
      meta="last 7 days"
      title="What MEX did"
    >
      <ActivityChart days={days} />
      {showSetup && (
        <div className={styles.setup}>
          <p className={shared.muted}>Run <code>mex</code> inside a repo to set it up.</p>
          <CopyButton text="mex" />
        </div>
      )}
      {sessions.length > 0 && (
        <div className={styles.latest} id="latest-sessions">
          <div className={styles.cardHeading}>
            <h3>Latest sessions</h3>
            <a className={shared.textLink} href="#latest-sessions">See all <ArrowRight aria-hidden="true" /></a>
          </div>
          <ul className={styles.rows} role="list">
            {sessions.slice(0, sessionLimit).map((session) => {
              const repo = repoNames.get(session.repoId);
              const at = new Date(session.at);
              const age = relativeTime(at, now);
              return (
                <li className={styles.sessionRow} key={session.id}>
                  <span><strong>{session.agent}</strong>{repo && ` · ${repo}`} · <time dateTime={session.at} title={fullDateTime.format(at)}>{age}</time></span>
                  <span className={styles.sessionResult}>gave {number.format(session.gave)} · held back {number.format(session.heldBack)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </HomeCard>
  );
}

function sumKnowledge(repos: readonly KnowledgeSummary[]) {
  return repos.reduce((summary, repo) => ({
    ...emptyKnowledge,
    total: summary.total + repo.total,
    upToDate: summary.upToDate + repo.upToDate,
    codeChanged: summary.codeChanged + repo.codeChanged,
    outOfDate: summary.outOfDate + repo.outOfDate,
    notChecked: summary.notChecked + repo.notChecked,
    onlyYou: summary.onlyYou + repo.onlyYou,
    team: summary.team + repo.team,
    updatingSince: summary.updatingSince ?? repo.updatingSince,
  }), emptyKnowledge);
}

function Knowledge({ summary, repos, scoped, legendId, href, pending }: {
  summary: KnowledgeSummary;
  repos: readonly { label: string; counts: KnowledgeSummary; total: number }[];
  scoped: boolean;
  legendId: string;
  href: string;
  pending: boolean;
}) {
  const rows = scoped ? kinds.flatMap((kind) => {
    const counts = summary.byKind[kind];
    if (!counts) return [];
    const total = counts.upToDate + counts.codeChanged + counts.outOfDate + counts.notChecked;
    return [{ label: kind[0].toUpperCase() + kind.slice(1), counts, total }];
  }) : repos;

  return (
    <HomeCard
      extra={<Link className={shared.textLink} to={href}>Open Knowledge <ArrowRight aria-hidden="true" /></Link>}
      id="knowledge"
      layout={styles.knowledgeCard}
      title="What MEX knows"
    >
      {pending ? <p className={styles.quietState}>—</p> : (
        <>
          {summary.total > 0 && <KnowledgeLegend counts={summary} id={legendId} />}
          <KnowledgeChart caption={scoped ? "Knowledge by kind" : "Knowledge by repo"} href={href} legendId={legendId} rows={rows} summary={summary} />
          {summary.total > 0 && (
            <p className={styles.ownership}>{number.format(summary.onlyYou)} only you · {number.format(summary.team)} your team</p>
          )}
        </>
      )}
    </HomeCard>
  );
}

function WeekUsage({ week, scoped }: { week: HomeOverview["week"]; scoped: boolean }) {
  const [showInfo, setShowInfo] = useState(false);
  const description = `The last 7 days, counted in whole UTC days. MEX's own AI work stays under ${number.format(week.capPercent)}% of your usage. Estimated from your agent's usage logs.`;

  return (
    <StatTile
      action={(
        <TooltipProvider>
          <Tooltip open={showInfo} onOpenChange={setShowInfo}>
            <TooltipTrigger
              aria-description={description}
              aria-label="About this week’s AI use"
              className={`${styles.tileAction} ${styles.weekInfo}`}
              closeOnClick={false}
              onClick={() => setShowInfo(true)}
              render={<Button size="icon-xs" type="button" variant="ghost" />}
            >
              <Info aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent role="tooltip">{description}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      label="MEX's AI use"
      note={week.percent === null ? "share of your usage unknown"
        : scoped ? "of your usage this week, all repos (estimate)" : "of your usage this week (estimate)"}
      value={week.percent === null ? "—" : `${number.format(week.percent)}%`}
    >
      <UsageMeter week={week} />
    </StatTile>
  );
}

function Jobs({ jobs, repoNames, href, load }: { jobs?: readonly HubJob[]; repoNames: RepoNames; href: string; load?: PageLoad }) {
  const ready = jobs !== undefined;
  jobs ??= [];
  const running = jobs.filter(({ state }) => state.phase === "running");
  const waiting = jobs.filter(({ state }) => state.phase === "waiting");
  const active = [...running, ...waiting].slice(0, 3);
  const queued = jobs.filter(({ state }) => state.phase === "queued").length;
  const gaps = jobs.filter(({ state }) => state.phase === "doneWithGaps").length;

  return (
    <HomeCard layout={styles.jobsCard} title="Jobs">
      <PageRequestState name="jobs" {...load} />
      {active.length ? (
        <ul className={styles.rows} role="list">
          {active.map((job) => {
            const percent = jobProgressPercent(job);
            const repo = repoNames.get(job.repoId);
            return (
              <li className={styles.homeJob} key={job.id}>
                <div className={styles.jobTitle}>{job.label}{repo && <span> · {repo}</span>}</div>
                <div className={styles.jobDetails}>
                  <div className={styles.jobActivity}>
                    <JobProgress job={job} />
                    {percent === undefined ? job.activity : `${number.format(percent)}%`}
                  </div>
                  <JobStatus job={job} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : ready && <p className={styles.quietState}>No jobs running</p>}
      <div className={styles.cardActions}>
        {(queued > 0 || gaps > 0) && <span>{number.format(queued)} queued · {number.format(gaps)} finished with gaps this week</span>}
        <Link className={shared.textLink} to={href}>Open Jobs <ArrowRight aria-hidden="true" /></Link>
      </div>
    </HomeCard>
  );
}

interface HomePageProps {
  projects: MachineProject[];
  project?: MachineProject;
  overview?: HomeOverview;
  jobs?: readonly HubJob[];
  jobsHref: string;
  load?: PageLoad;
  jobsLoad?: PageLoad;
}

export function HomePage({ projects, project, overview, jobs, jobsHref, load, jobsLoad }: HomePageProps) {
  const legendId = useId();
  const location = useLocation();
  const knowledgeHref = `${project ? `/repos/${encodeURIComponent(project.id)}` : ""}/knowledge${location.search}`;
  const checkouts = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (location.hash === "#checkouts") {
      const disclosure = checkouts.current?.querySelector("details");
      if (disclosure) {
        disclosure.open = true;
        disclosure.scrollIntoView?.({ block: "nearest" });
      }
    }
  }, [location]);

  const now = new Date();
  const repoNames = new Map(projects.map(({ id, name }) => [id, name]));
  const inScope = ({ repoId }: { repoId: string }) => !project || repoId === project.id;
  const scopedProjects = project ? [project] : projects;
  const scopedJobs = jobs?.filter(inScope);
  const running = (scopedJobs ?? []).filter(({ state }) => state.phase === "running").length;
  const scope = project?.name ?? "All repos";
  const metrics = project ? overview?.byRepo[project.id] : overview;
  const days = metrics?.activity ?? [];
  const sessionCount = days.reduce((total, day) => total + day.sessions, 0);
  const scopedNeeds = overview?.needs.filter(inScope) ?? [];
  const rules = scopedNeeds.filter(({ kind }) => kind !== "missingFolder");
  const counts = Object.entries(overview?.needsCount ?? {}).filter(([id]) => !project || project.id === id);
  const waiting = counts.reduce((total, [, entry]) => total + entry.count, 0);
  const oldest = counts.reduce<string | undefined>((earliest, [, entry]) => (
    !earliest || entry.oldest < earliest ? entry.oldest : earliest
  ), undefined);
  const pending = overview?.pending === true;
  const folders: FolderIssue[] = scopedProjects.flatMap(({ id, name, checkouts }) => (
    checkouts.filter(({ exists }) => !exists).map(({ path }) => ({
      key: `folder:${id}:${path}`, repoId: id, text: `Folder not found: ${name}`, path,
    }))
  ));
  for (const item of scopedNeeds) {
    if (item.kind === "missingFolder" && !folders.some(({ repoId }) => repoId === item.repoId)) {
      folders.push({ key: item.id, repoId: item.repoId, text: item.rule });
    }
  }
  const repos = scopedProjects.map(({ id, name }) => {
    const counts = overview?.knowledge[id] ?? emptyKnowledge;
    return { label: name, counts, total: counts.total };
  });
  const knowledge = project ? repos[0].counts : sumKnowledge(repos.map(({ counts }) => counts));
  const needsLook = knowledge.codeChanged + knowledge.outOfDate + knowledge.notChecked;
  const unavailable = Boolean(overview && scopedProjects.length && scopedProjects.every(({ id }) => !Object.hasOwn(overview.knowledge, id)));
  const waitingForSnapshot = pending || unavailable;
  const updated = overview && !pending && new Date(overview.generatedAt);
  const showSetup = projects.length === 0;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.title}>
            <h1 className={shared.pageTitle}>Home</h1>
            <span title={scope}>· {scope}</span>
          </div>
          <div className={styles.headerMeta}>
            {updated && <span>Updated <time dateTime={overview.generatedAt} title={fullDateTime.format(updated)}>{relativeTime(updated, now)}</time></span>}
            {(pending || knowledge.updatingSince) && <span className={styles.updating} role="status">Updating…</span>}
            {running > 0 && (
              <Link className={styles.jobsPill} to={jobsHref}>
                <span aria-hidden="true" />
                {number.format(running)} {running === 1 ? "job" : "jobs"} running
              </Link>
            )}
          </div>
        </div>
        {project && (
          <div id="checkouts" ref={checkouts}><RepoCheckouts key={project.id} checkouts={project.checkouts} /></div>
        )}
      </header>
      <PageRequestState name="Home" {...load} />
      <div className={styles.grid}>
        {overview && (
          <>
            <StatTile
              href="#needs-you"
              label="Needs you"
              note={waitingForSnapshot ? undefined : oldest ? `oldest waiting ${waitingAge(oldest, now)}` : "Nothing waiting"}
              value={waitingForSnapshot ? "—" : waiting}
            >
              <WaitingBreakdown counts={counts} repoNames={repoNames} scoped={Boolean(project)} now={now} />
            </StatTile>
            <StatTile href="#activity" label="Agent sessions" note={metrics?.agents.join(", ")} value={sessionCount}>
              <SessionsSparkline days={days} total={sessionCount} />
            </StatTile>
            <StatTile
              href={knowledgeHref}
              label="What MEX knows"
              note={waitingForSnapshot ? undefined : `${number.format(knowledge.upToDate)} up to date · ${number.format(needsLook)} need a look`}
              value={waitingForSnapshot ? "—" : knowledge.total}
            >
              {!waitingForSnapshot && <KnowledgeChart caption="Knowledge status totals" compact href={knowledgeHref} legendId={legendId} rows={[{ label: scope, counts: knowledge, total: knowledge.total }]} summary={knowledge} />}
            </StatTile>
            <WeekUsage scoped={Boolean(project)} week={overview.week} />
          </>
        )}
        {(overview || showSetup) && (
          <Activity days={days} sessions={overview?.sessions.filter(inScope) ?? []} repoNames={repoNames} now={now} showSetup={showSetup} />
        )}
        {(overview || folders.length > 0 || showSetup) && (
          <NeedsYou count={waiting} pending={waitingForSnapshot || !overview} rules={rules} folders={folders} repoNames={repoNames} now={now} search={location.search} />
        )}
        {overview && (
          <>
            <Knowledge summary={knowledge} repos={repos} scoped={Boolean(project)} legendId={legendId} href={knowledgeHref} pending={waitingForSnapshot} />
            <Jobs jobs={scopedJobs} load={jobsLoad} repoNames={repoNames} href={jobsHref} />
          </>
        )}
      </div>
    </div>
  );
}

export default HomePage;
