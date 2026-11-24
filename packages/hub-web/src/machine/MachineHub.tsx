import { Button } from "../components/primitives/button";
import { useMachineConnection } from "./connection";
import { HubShell } from "./HubShell";
import { RelinkPage } from "./pages";
import { HubBanners, HubBrand } from "./ui";
import styles from "./machine.module.css";

export function MachineHub() {
  const { session, projects, connectionLost } = useMachineConnection();
  if (session.data?.current) {
    return (
      <HubShell
        connectionLost={connectionLost}
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
