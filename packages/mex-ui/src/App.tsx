import { useCallback } from "react";
import { AppShell } from "./components/AppShell";
import { Card, ErrorState, Skeleton, SkeletonRows } from "./components/primitives";
import { ActivityView } from "./views/ActivityView";
import { Dashboard } from "./views/Dashboard";
import { GraphView } from "./views/GraphView";
import { HealthView } from "./views/HealthView";
import { NeedsScaffold } from "./views/NeedsScaffold";
import { ProblemView } from "./views/ProblemView";
import { SettingsView } from "./views/SettingsView";
import { SetupView } from "./views/SetupView";
import { Welcome } from "./views/Welcome";
import { api } from "./lib/api";
import { useGraphBuild, useResource, useRoute } from "./lib/hooks";
import { ROUTES, isSetupWizard } from "./lib/nav";
import type { ProjectSnapshot } from "./lib/types";

export function App() {
  const { path, navigate } = useRoute();
  const snapshot = useResource(() => api.snapshot(), []);

  const reloadSnapshot = snapshot.reload;
  const goHome = useCallback(() => {
    reloadSnapshot();
    navigate(ROUTES.home);
  }, [navigate, reloadSnapshot]);

  if (snapshot.loading) {
    return (
      <AppShell snapshot={null} path={path} navigate={navigate}>
        <div className="stack">
          <Skeleton height={30} width="16rem" />
          <div className="grid grid--stats">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} height={86} />
            ))}
          </div>
          <Card title="Loading project">
            <SkeletonRows rows={4} />
          </Card>
        </div>
      </AppShell>
    );
  }

  if (snapshot.error || !snapshot.data) {
    return (
      <AppShell snapshot={null} path={path} navigate={navigate}>
        <Card>
          <ErrorState
            title="Couldn't read this project"
            message={snapshot.error?.message ?? "The server returned no project snapshot."}
            hint={snapshot.error?.hint}
            onRetry={snapshot.reload}
          />
        </Card>
      </AppShell>
    );
  }

  const data = snapshot.data;

  return (
    <AppShell
      snapshot={data}
      path={path}
      navigate={navigate}
      onRefresh={snapshot.reload}
      refreshing={snapshot.refreshing}
    >
      {data.status === "ready" ? (
        <ReadyMain
          snapshot={data}
          path={path}
          navigate={navigate}
          onSnapshotChange={reloadSnapshot}
          onSetupFinish={goHome}
        />
      ) : (
        <UnreadyMain
          snapshot={data}
          path={path}
          navigate={navigate}
          onFinish={goHome}
          onRetry={snapshot.reload}
        />
      )}
    </AppShell>
  );
}

/**
 * A project with a loadable scaffold. Drift, graph, and activity are fetched
 * here so switching views does not restart them, and a graph build started on
 * Dashboard is still visible on Graph.
 */
function ReadyMain(props: {
  snapshot: ProjectSnapshot;
  path: string;
  navigate: (to: string) => void;
  onSnapshotChange: () => void;
  onSetupFinish: () => void;
}) {
  const { snapshot, path, navigate, onSnapshotChange, onSetupFinish } = props;
  const drift = useResource(() => api.drift(), []);
  const graph = useResource(() => api.graph(), []);
  const activity = useResource(() => api.activity(40), []);
  const grounding = useResource(() => api.grounding(), []);

  const build = useGraphBuild(() => {
    graph.reload();
    drift.reload();
    grounding.reload();
    onSnapshotChange();
  });

  const onCaptured = useCallback(() => {
    drift.reload();
    grounding.reload();
  }, [drift.reload, grounding.reload]);

  if (path === ROUTES.setup || isSetupWizard(path)) {
    return (
      <SetupView
        snapshot={snapshot}
        showWizard={isSetupWizard(path)}
        onFinish={onSetupFinish}
        onNavigate={navigate}
        onCaptured={onCaptured}
        onGraphBuilt={onSnapshotChange}
      />
    );
  }

  if (path === ROUTES.health) {
    return <HealthView drift={drift} activity={activity} />;
  }

  if (path === ROUTES.graph) {
    return (
      <GraphView
        graph={graph}
        file={snapshot.graph}
        buildJob={build.job}
        building={build.building}
        buildError={build.buildError}
        onBuild={build.startBuild}
      />
    );
  }

  if (path === ROUTES.activity) {
    return <ActivityView activity={activity} />;
  }

  if (path === ROUTES.settings) {
    return <SettingsView snapshot={snapshot} />;
  }

  return (
    <Dashboard
      snapshot={snapshot}
      drift={drift}
      graph={graph}
      grounding={grounding}
      buildJob={build.job}
      building={build.building}
      buildError={build.buildError}
      onBuild={build.startBuild}
      onNavigate={navigate}
    />
  );
}

function UnreadyMain(props: {
  snapshot: ProjectSnapshot;
  path: string;
  navigate: (to: string) => void;
  onFinish: () => void;
  onRetry: () => void;
}) {
  const { snapshot, path, navigate, onFinish, onRetry } = props;

  if (path === ROUTES.setup || isSetupWizard(path)) {
    return (
      <SetupView
        snapshot={snapshot}
        showWizard={isSetupWizard(path)}
        onFinish={onFinish}
        onNavigate={navigate}
      />
    );
  }

  if (path === ROUTES.settings) {
    return <SettingsView snapshot={snapshot} />;
  }

  if (path === ROUTES.health || path === ROUTES.graph || path === ROUTES.activity) {
    return (
      <NeedsScaffold
        status={snapshot.status === "error" ? "error" : "empty"}
        onSetup={() => navigate(ROUTES.setupWizard)}
      />
    );
  }

  if (snapshot.status === "empty") {
    return <Welcome snapshot={snapshot} onStartSetup={() => navigate(ROUTES.setupWizard)} />;
  }

  return (
    <ProblemView
      snapshot={snapshot}
      onStartSetup={() => navigate(ROUTES.setupWizard)}
      onRetry={onRetry}
    />
  );
}
