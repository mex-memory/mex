import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { MachineProject, MachineSession } from "@mex/hub-contracts/machine";
import { BookOpen, ClipboardCheck, FolderGit2, House, ListTodo, Menu, Terminal, X } from "lucide-react";
import { Navigate, NavLink, Route, Routes, useLocation, useMatch, useNavigate } from "react-router-dom";
import { Button } from "../components/primitives/button";
import { Badge } from "../components/primitives/badge";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { Separator } from "../components/primitives/separator";
import { cn } from "../lib/utils";
import shell from "../styles/shell.module.css";
import { useHome, useHubEvents, useJobActions, useJobs, useReviewCount, type HubEventState } from "./data";
import type { ReviewConnection } from "./ReviewPage";
import type { KnowledgeConnection } from "./KnowledgePage";
import { UnknownRepoPage } from "./pages";
import { reviewCount } from "./review-model";
import type { HomeOverview, HubJob, HubPreview, JobAction, KnowledgePreview, ReviewPreview } from "./types";
import { HubBanners, HubBrand, ThemeToggle, type PageLoad } from "./ui";
import styles from "./machine.module.css";

const HomePage = lazy(() => import("./HomePage"));
const JobsPage = lazy(() => import("./JobsPage"));
const KnowledgePage = lazy(() => import("./KnowledgePage"));
const ReviewPage = lazy(() => import("./ReviewPage"));
const navPages = [
  { page: "home", label: "Home", icon: House },
  { page: "review", label: "Review", icon: ClipboardCheck },
  { page: "knowledge", label: "Knowledge", icon: BookOpen },
  { page: "jobs", label: "Jobs", icon: ListTodo },
] as const;
type NavPage = typeof navPages[number]["page"];

interface ShellProps {
  session: MachineSession;
  projects: MachineProject[] | undefined;
  projectsError: boolean;
  retryProjects: () => void;
  connectionLost: boolean;
}

type HubShellProps = ShellProps & (
  | { preview: HubPreview }
  | { preview?: undefined; checkSession: () => void; reportDataError: (error: unknown) => void }
);

interface HubData {
  overview?: HomeOverview;
  jobs?: readonly HubJob[];
  knowledge?: KnowledgePreview;
  review?: ReviewPreview;
  reviewCount?: ReturnType<typeof useReviewCount>["data"];
  reviewLive?: ReviewConnection;
  knowledgeLive?: KnowledgeConnection;
  homeLoad?: PageLoad;
  jobsLoad?: PageLoad;
  changeJob: (job: HubJob, action: JobAction) => void | Promise<void>;
}

export function HubShell(props: HubShellProps) {
  if (props.preview) {
    const { jobs, overview, knowledge, review, changeJob } = props.preview;
    return <HubLayout {...props} data={{ jobs, overview, knowledge, review, changeJob: (job, action) => changeJob(job.id, action) }} fixture />;
  }
  return <LiveHubShell {...props} />;
}

function LiveHubShell({ checkSession, reportDataError, ...props }: ShellProps & {
  checkSession: () => void;
  reportDataError: (error: unknown) => void;
}) {
  const events = useHubEvents(checkSession);
  const home = useHome(events);
  const jobs = useJobs(events);
  const waiting = useReviewCount(events);
  const changeJob = useJobActions(props.session.csrfToken, reportDataError);

  useEffect(() => {
    if (home.error) reportDataError(home.error);
    if (jobs.error) reportDataError(jobs.error);
  }, [home.error, jobs.error, reportDataError]);

  return <HubLayout {...props} events={events} data={{
    overview: home.data, jobs: jobs.data, changeJob, reviewCount: waiting.data,
    reviewLive: { events, csrfToken: props.session.csrfToken, reportDataError },
    knowledgeLive: { events, csrfToken: props.session.csrfToken, reportDataError },
    homeLoad: { loading: home.isPending, error: home.isError, retry: () => void home.refetch() },
    jobsLoad: { loading: jobs.isPending, error: jobs.isError, retry: () => void jobs.refetch() },
  }} />;
}

function HubLayout({ session, projects, projectsError, retryProjects, connectionLost, fixture, events, data }: ShellProps & {
  fixture?: boolean;
  events?: HubEventState;
  data: HubData;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const { pathname, search } = useLocation();
  const previousPath = useRef(pathname);
  const projectId = useMatch("/repos/:projectId/*")?.params.projectId;
  const machineJobs = useMatch("/jobs");
  const repoJobs = useMatch("/repos/:projectId/jobs");
  const machineKnowledge = useMatch("/knowledge/*");
  const repoKnowledge = useMatch("/repos/:projectId/knowledge/*");
  const knowledgeRoute = Boolean(machineKnowledge || repoKnowledge);
  const machineReview = useMatch("/review/*");
  const repoReview = useMatch("/repos/:projectId/review/*");
  const reviewRoute = Boolean(machineReview || repoReview);
  const project = projects?.find(({ id }) => id === projectId);
  const navigate = useNavigate();
  const terminal = session.mode === "terminal";
  const knowledgeProps = data.knowledge ? { knowledge: data.knowledge } : { live: data.knowledgeLive! };
  const reviewProps = data.review ? { review: data.review } : { live: data.reviewLive! };
  const waiting = fixture ? reviewCount(data.overview, projectId)
    : (projectId ? data.reviewCount?.byRepo[projectId] : data.reviewCount?.total) ?? 0;
  const activePage = reviewRoute ? "review" : knowledgeRoute ? "knowledge" : machineJobs || repoJobs ? "jobs" : "home";
  const loadingPage = { home: "Home", knowledge: "Knowledge", review: "Review", jobs: "jobs" }[activePage];

  function pagePath(page: NavPage, id?: string) {
    const repo = id ? `/repos/${encodeURIComponent(id)}` : "";
    const path = page === "home" ? repo || "/" : `${repo}/${page}`;
    const currentSearch = new URLSearchParams(search);
    const params = new URLSearchParams();
    const variant = fixture && currentSearch.get("fixture");
    if (variant) params.set("fixture", variant);
    if (page === "knowledge" && knowledgeRoute) {
      for (const name of ["q", "kind", "audience", "status", "repo", "area", "view"]) {
        const value = currentSearch.get(name);
        if (value && (name !== "repo" || !id)) params.set(name, value);
      }
    }
    return params.size ? `${path}?${params}` : path;
  }

  const homeHref = pagePath("home");
  const allJobsHref = pagePath("jobs");
  const unknownRepo = <UnknownRepoPage homeHref={homeHref} />;

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    setMenuOpen(false);
    if (!knowledgeRoute && (!reviewRoute || projectId && !project)) main.current?.focus();
  }, [knowledgeRoute, reviewRoute, projectId, project, pathname]);

  function closeMenu() {
    if (!menuOpen) return;
    setMenuOpen(false);
    menuButton.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!event.defaultPrevented && event.key === "Escape") closeMenu();
  }

  return (
    <div className={cn(shell.viewportFrame, styles.frame)} onKeyDown={onKeyDown}>
      <a className={shell.skipLink} href="#main-content">Skip to main content</a>
      <Button
        aria-controls="hub-sidebar"
        aria-expanded={menuOpen}
        aria-label={menuOpen ? "Close menu" : "Open menu"}
        className={styles.menuButton}
        onClick={() => setMenuOpen(!menuOpen)}
        ref={menuButton}
        size="icon"
        type="button"
        variant="ghost"
      >
        {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
      </Button>
      <aside aria-label="Hub" className={cn(shell.sidebar, styles.sidebar)} data-open={menuOpen} id="hub-sidebar">
        <div className={shell.sidebarHeader}><HubBrand /></div>
        <Separator className={shell.sidebarSeparator} />
        <div className={shell.navScroller}>
          <nav aria-label="Primary" className={shell.nav}>
            <ul className={shell.navList}>
              {navPages.map(({ page, label, icon: Icon }) => (
                <li key={page}>
                  <NavLink
                    aria-description={page === "review" && waiting > 0 ? `${waiting} waiting` : undefined}
                    className={({ isActive }) => cn(shell.navLink, isActive && shell.navLinkActive)}
                    end={page === "home" || page === "jobs"}
                    onClick={closeMenu}
                    to={pagePath(page, projectId)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                    {page === "review" && waiting > 0 && <Badge aria-hidden="true" variant="secondary">{waiting}</Badge>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        {terminal && (
          <footer className={shell.sidebarFooter}>
            <Separator className={shell.sidebarSeparator} />
            <div className={shell.locality}><Terminal aria-hidden="true" /><strong>Running from this terminal</strong></div>
          </footer>
        )}
      </aside>
      <header aria-label="Repository context" className={cn(shell.contextBar, styles.topBar)}>
        <span className={shell.repoGlyph}><FolderGit2 aria-hidden="true" /></span>
        <NativeSelect
          aria-label="Repo switcher"
          className={styles.switcher}
          disabled={projects === undefined}
          onChange={(event) => navigate(pagePath(activePage, event.target.value))}
          value={project?.id ?? ""}
        >
          <NativeSelectOption value="">All repos</NativeSelectOption>
          {projects?.map(({ id, name }) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
        </NativeSelect>
        <ThemeToggle />
      </header>
      <main className={cn(shell.main, styles.main)} id="main-content" ref={main} tabIndex={-1}>
        <div className={styles.content}>
          <HubBanners events={events} stopped={connectionLost} terminal={terminal} updated={session.version !== __MEX_HUB_VERSION__} />
          {projectsError && !connectionLost && (
            <div className={styles.pageState}>
              <p role="status">Couldn’t load repos.</p>
              <Button onClick={retryProjects} size="sm" type="button" variant="outline">Retry</Button>
            </div>
          )}
          {projects ? (
            <Suspense fallback={<p className={styles.pageState} role="status">Loading {loadingPage}…</p>}>
              <Routes>
                <Route
                  element={(
                    <HomePage
                      jobs={data.jobs}
                      jobsLoad={data.jobsLoad}
                      jobsHref={allJobsHref}
                      load={data.homeLoad}
                      overview={data.overview}
                      projects={projects}
                    />
                  )}
                  path="/"
                />
                <Route element={<ReviewPage key="all" {...reviewProps} projects={projects} />} path="/review/:cardKey?" />
                <Route
                  element={project ? <ReviewPage key={project.id} {...reviewProps} project={project} projects={projects} /> : unknownRepo}
                  path="/repos/:projectId/review/:cardKey?"
                />
                <Route
                  element={<KnowledgePage key="all" {...knowledgeProps} projects={projects} />}
                  path="/knowledge/:entryKey?"
                />
                <Route
                  element={project ? (
                    <KnowledgePage key={project.id} {...knowledgeProps} project={project} projects={projects} />
                  ) : unknownRepo}
                  path="/repos/:projectId/knowledge/:entryKey?"
                />
                <Route
                  element={project ? (
                    <HomePage
                      jobs={data.jobs}
                      jobsLoad={data.jobsLoad}
                      jobsHref={pagePath("jobs", project.id)}
                      load={data.homeLoad}
                      overview={data.overview}
                      project={project}
                      projects={projects}
                    />
                  ) : unknownRepo}
                  path="/repos/:projectId"
                />
                <Route element={<JobsPage allJobsHref={allJobsHref} changeJob={data.changeJob} jobs={data.jobs} load={data.jobsLoad} projects={projects} />} path="/jobs" />
                <Route
                  element={project ? (
                    <JobsPage allJobsHref={allJobsHref} changeJob={data.changeJob} jobs={data.jobs} key={project.id} load={data.jobsLoad} project={project} projects={projects} />
                  ) : unknownRepo}
                  path="/repos/:projectId/jobs"
                />
                <Route element={<Navigate replace to={homeHref} />} path="*" />
              </Routes>
            </Suspense>
          ) : !projectsError && !connectionLost && (
            <p className={styles.pageState} role="status">Loading repos…</p>
          )}
        </div>
      </main>
    </div>
  );
}
