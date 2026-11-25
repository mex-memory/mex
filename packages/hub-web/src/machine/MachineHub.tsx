import { lazy, Suspense } from "react";
import { Button } from "../components/primitives/button";
import { useMachineConnection } from "./connection";
import { HubShell } from "./HubShell";
import type { FixtureVariant } from "./fixtures";
import { RelinkPage } from "./pages";
import { HubBanners, HubBrand } from "./ui";
import styles from "./machine.module.css";

const FixtureHub = import.meta.env.DEV ? lazy(() => import("./FixtureHub")) : null;

export function MachineHub() {
  if (FixtureHub) {
    const variants: readonly FixtureVariant[] = [
      "home", "populated", "empty", "stale", "updating", "conflict", "calm",
      "review-empty", "review-handled", "review-handled-unknown", "review-busy", "review-loading",
      "agents-broken", "agents-terminal", "settings-forced-off", "setup",
    ];
    const requested = new URLSearchParams(window.location.search).get("fixture");
    const variant = variants.find((variant) => variant === requested);
    if (variant) {
      return (
        <Suspense fallback={null}>
          <FixtureHub key={variant} variant={variant} />
        </Suspense>
      );
    }
  }
  return <ConnectedHub />;
}

function ConnectedHub() {
  const { session, projects, connectionLost, checkSession, reportDataError } = useMachineConnection();
  if (session.data?.current) {
    return (
      <HubShell
        checkSession={checkSession}
        connectionLost={connectionLost}
        reportDataError={reportDataError}
        projects={projects.data?.projects}
        projectsError={projects.isError}
        retryProjects={() => void projects.refetch()}
        session={session.data.current}
      />
    );
  }

  return (
    <main className={styles.fullPage}>
      <div className={styles.signIn}>
        <HubBrand />
        <HubBanners stopped={connectionLost} />
        {session.data ? (
          <RelinkPage rejectedLink={session.data.rejectedLink} />
        ) : !connectionLost && (
          <div className={styles.pageState}>
            <p role="status">{session.isError ? "Couldn’t connect to the Hub." : "Connecting to the Hub…"}</p>
            {session.isError && <Button onClick={() => void session.refetch()} type="button" variant="outline">Retry</Button>}
          </div>
        )}
      </div>
    </main>
  );
}
