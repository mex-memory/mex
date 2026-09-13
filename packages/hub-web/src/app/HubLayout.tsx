import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2, GitBranch, GitCommitHorizontal, Menu, X } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import type { CapabilitiesResponse, HomeResponse, OverviewResponse, SessionResponse } from "../api/types";
import { useHubApi } from "../api/context";
import { Button } from "../components/primitives/button";
import { formatTime, StatePanel, StatusPill } from "../components/ui";
import styles from "../styles/shell.module.css";
import { HubOnboarding } from "./HubOnboarding";
import { JobLifecycleObserver } from "./JobLifecycleObserver";
import { PageViewObserver } from "./PageViewObserver";
import { HubSidebar } from "./HubSidebar";

/**
 * The project's community invite.
 *
 * A permanent vanity invite, deliberately: a default Discord invite expires,
 * and this URL is compiled into published builds that people keep running for
 * months after they install them.
 */
const DISCORD_INVITE = "https://discord.gg/FEdNsQ4Qt4";

export interface HubOutletContext {
  capabilities?: CapabilitiesResponse;
  clearSearchFocusRequest: () => void;
  home?: HomeResponse;
  searchFocusRequest: number;
}

function contentEditable(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const value = current.getAttribute("contenteditable");
    if (value !== null) return value.toLowerCase() !== "false";
    current = current.parentElement;
  }
  return false;
}

export function shouldHandleSearchShortcut(event: KeyboardEvent): boolean {
  if (
    event.key !== "/"
    || event.defaultPrevented
    || event.ctrlKey
    || event.metaKey
    || event.altKey
  ) return false;

  const target = event.target;
  const eventDocument = target instanceof Element ? target.ownerDocument : document;
  if (eventDocument.querySelector(
    '[role="dialog"]:not([hidden]):not([aria-hidden="true"]), [role="alertdialog"]:not([hidden]):not([aria-hidden="true"])',
  )) return false;
  if (!(target instanceof Element)) return true;
  return !target.closest("input, textarea, select") && !contentEditable(target);
}

/**
 * The Discord mark, inlined.
 *
 * `lucide-react` carries no brand icons, and a brand mark is not something to
 * add a dependency for. Unlike every other icon in this bar it is filled rather
 * than stroked, so it sets `fill` and clears `stroke` explicitly instead of
 * inheriting the stroke-based defaults.
 */
function DiscordMark() {
  return (
    <svg aria-hidden="true" fill="currentColor" stroke="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

function RepositoryBar({ repository, session }: { repository?: HomeResponse["repository"]; session: SessionResponse }) {
  const context = repository;
  return (
    <header className={styles.contextBar} aria-label="Repository context">
      <div className={styles.repoIdentity}>
        <span className={styles.repoGlyph} aria-hidden="true"><FolderGit2 /></span>
        <span><strong>{context?.name ?? "Current project"}</strong></span>
      </div>
      <div className={styles.repoFacts}>
        {/*
          * The accessible name is set explicitly and matches the visible label
          * word for word, because the label is hidden below 1190px and the mark
          * itself is `aria-hidden` — without it the link would go nameless at
          * exactly the width where it is hardest to guess.
          */}
        {/*
          * `role="link"` is set back deliberately. The Hub's `Button` announces
          * as a button even when it renders an anchor, which is fine for the
          * in-app navigations that use it — but this one leaves the Hub for
          * another site, and that is precisely the case where a reader needs to
          * hear "link" before deciding to follow it.
          */}
        <Button
          aria-label="Join MEX Discord"
          className={styles.discordLink}
          nativeButton={false}
          render={(
            <a
              href={DISCORD_INVITE}
              rel="noopener noreferrer"
              target="_blank"
              title="Join MEX Discord"
            />
          )}
          role="link"
          size="sm"
          variant="outline"
        >
          <DiscordMark />
          <span>Join MEX Discord</span>
        </Button>
        {context?.branch ? (
          <span><GitBranch aria-hidden="true" /> <span>{context.branch}</span></span>
        ) : null}
        {context?.head ? (
          <span className={styles.mono}><GitCommitHorizontal aria-hidden="true" /> {context.head.slice(0, 8)}</span>
        ) : null}
        {typeof context?.dirty === "boolean" ? (
          <StatusPill tone={context.dirty ? "warning" : "success"}>
            {context.dirty ? "Local changes" : "Clean tree"}
          </StatusPill>
        ) : null}
      </div>
      <div className={styles.sessionMeta}>
        <span><small>Session</small><strong>{formatTime(session.expiresAt)}</strong></span>
      </div>
    </header>
  );
}

export function HubLayout({
  session,
  capabilities,
}: {
  session: SessionResponse;
  capabilities?: CapabilitiesResponse;
}) {
  const api = useHubApi();
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);
  const skipNextMainFocus = useRef(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const clearSearchFocusRequest = useCallback(() => setSearchFocusRequest(0), []);
  const isOverview = location.pathname === "/";
  const shell = useQuery<HomeResponse | OverviewResponse>({
    queryKey: [isOverview ? "overview" : "home"],
    queryFn: () => isOverview ? api.getOverview() : api.getHome(),
    retry: false,
  });
  const trustedHome = shell.isSuccess
    ? isOverview
      ? (shell.data as OverviewResponse).shell
      : shell.data as HomeResponse
    : undefined;

  useEffect(() => {
    if (previousPath.current !== location.pathname) {
      const focusSearch = skipNextMainFocus.current && location.pathname === "/search";
      skipNextMainFocus.current = false;
      if (!focusSearch) mainRef.current?.focus({ preventScroll: true });
      previousPath.current = location.pathname;
    }
  }, [location.pathname]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!shouldHandleSearchShortcut(event)) return;
      event.preventDefault();
      skipNextMainFocus.current = location.pathname !== "/search";
      setSearchFocusRequest((current) => current + 1);
      if (location.pathname !== "/search") navigate("/search");
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [location.pathname, navigate]);

  return (
    <HubOnboarding
      projectName={trustedHome?.repository.name}
      ready={shell.isSuccess || shell.isError}
    >
      <div className={styles.viewportFrame}>
        <PageViewObserver />
        {isOverview ? null : <JobLifecycleObserver channelScope={session.expiresAt} />}
        <a className={styles.skipLink} href="#main-content">Skip to main content</a>
        <HubSidebar capabilities={capabilities} home={trustedHome} />
        <div className={styles.workspace}>
          <RepositoryBar repository={trustedHome?.repository} session={session} />
          <main id="main-content" className={styles.main} ref={mainRef} tabIndex={-1}>
            <Suspense fallback={<StatePanel state="loading" title="Opening workbench" detail="Loading this local Hub view." />}>
              <Outlet context={{ capabilities, clearSearchFocusRequest, home: trustedHome, searchFocusRequest } satisfies HubOutletContext} />
            </Suspense>
          </main>
        </div>
      </div>
    </HubOnboarding>
  );
}

export function DesktopRequired() {
  return (
    <main className={styles.desktopRequired}>
      <div className={styles.desktopWindow} aria-hidden="true">
        <span /><span /><span />
        <div><X /><Menu /></div>
      </div>
      <p className={styles.eyebrow}>Project Hub</p>
      <h1>A wider workbench is required</h1>
      <p>MEX Hub is designed for desktop workflows at 1024 pixels and above. Widen this window to continue.</p>
    </main>
  );
}
