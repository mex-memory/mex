import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { MachineProject, MachineSession } from "@mex/hub-contracts/machine";
import { FolderGit2, House, Menu, Terminal, X } from "lucide-react";
import { Navigate, NavLink, Route, Routes, useLocation, useMatch, useNavigate } from "react-router-dom";
import { Button } from "../components/primitives/button";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { Separator } from "../components/primitives/separator";
import { cn } from "../lib/utils";
import shell from "../styles/shell.module.css";
import { AllReposPage, RepoPage, UnknownRepoPage, repoPath } from "./pages";
import { HubBanners, HubBrand, ThemeToggle } from "./ui";
import styles from "./machine.module.css";

interface HubShellProps {
  session: MachineSession;
  projects: MachineProject[] | undefined;
  projectsError: boolean;
  retryProjects: () => void;
  connectionLost: boolean;
}

export function HubShell({ session, projects, projectsError, retryProjects, connectionLost }: HubShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  const projectId = useMatch("/repos/:projectId")?.params.projectId;
  const project = projects?.find(({ id }) => id === projectId);
  const navigate = useNavigate();
  const terminal = session.mode === "terminal";

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    setMenuOpen(false);
    main.current?.focus();
  }, [pathname]);

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
              <li>
                <NavLink
                  className={({ isActive }) => cn(shell.navLink, isActive && shell.navLinkActive)}
                  end
                  onClick={closeMenu}
                  to={projectId ? `/repos/${encodeURIComponent(projectId)}` : "/"}
                >
                  <House aria-hidden="true" />
                  <span>Home</span>
                </NavLink>
              </li>
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
          onChange={(event) => navigate(event.target.value === "" ? "/" : repoPath(event.target.value))}
          value={project?.id ?? ""}
        >
          <NativeSelectOption value="">All repos</NativeSelectOption>
          {projects?.map(({ id, name }) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
        </NativeSelect>
        <ThemeToggle />
      </header>
      <main className={cn(shell.main, styles.main)} id="main-content" ref={main} tabIndex={-1}>
        <div className={styles.content}>
          <HubBanners stopped={connectionLost} terminal={terminal} updated={session.version !== __MEX_HUB_VERSION__} />
          {projectsError && !connectionLost && (
            <div className={styles.pageState}>
              <p role="status">Couldn’t load repos.</p>
              <Button onClick={retryProjects} size="sm" type="button" variant="outline">Retry</Button>
            </div>
          )}
          {projects ? (
            <Routes>
              <Route element={<AllReposPage projects={projects} />} path="/" />
              <Route element={project ? <RepoPage project={project} /> : <UnknownRepoPage />} path="/repos/:projectId" />
              <Route element={<Navigate replace to="/" />} path="*" />
            </Routes>
          ) : !projectsError && !connectionLost && (
            <p className={styles.pageState} role="status">Loading repos…</p>
          )}
        </div>
      </main>
    </div>
  );
}
