import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { HubApiError, isSetupCapabilityUnavailable, type HubApi } from "../api/client";
import { HubApiProvider, useCapabilities, useHubApi, useSession } from "../api/context";
import { StatePanel } from "../components/ui";
import { Button } from "../components/primitives/button";
import styles from "../styles/app.module.css";
import { DesktopRequired, HubLayout } from "./HubLayout";

const HomePage = lazy(async () => ({ default: (await import("../pages/HomePage")).HomePage }));
const SearchPage = lazy(async () => ({ default: (await import("../pages/SearchPage")).SearchPage }));
const CodePage = lazy(async () => ({ default: (await import("../pages/SearchPage")).CodePage }));
const KnowledgePage = lazy(async () => ({ default: (await import("../pages/ContextPage")).ContextPage }));
const KnowledgeDetailPage = lazy(async () => ({ default: (await import("../pages/KnowledgePage")).KnowledgeDetailPage }));
const SymbolPage = lazy(async () => ({ default: (await import("../pages/SymbolPage")).SymbolPage }));
const RoadmapPage = lazy(async () => ({ default: (await import("../pages/CapabilityPage")).RoadmapPage }));
const NotFoundPage = lazy(async () => ({ default: (await import("../pages/CapabilityPage")).NotFoundPage }));
const ActivityPage = lazy(async () => ({ default: (await import("../pages/ActivityPage")).ActivityPage }));
const MembersPage = lazy(async () => ({ default: (await import("../pages/MembersPage")).MembersPage }));
const WorkstreamsPage = lazy(async () => ({ default: (await import("../pages/WorkstreamsPage")).WorkstreamsPage }));
const DiagramsPage = lazy(async () => ({ default: (await import("../pages/DiagramsPage")).DiagramsPage }));
const SpecsPage = lazy(async () => ({ default: (await import("../pages/SpecsPage")).SpecsPage }));
const InboxPage = lazy(async () => ({ default: (await import("../pages/InboxPage")).InboxPage }));
const RelayPage = lazy(async () => ({ default: (await import("../pages/RelayPage")).RelayPage }));
const JobsPage = lazy(async () => ({ default: (await import("../pages/JobsPage")).JobsPage }));
const HealthPage = lazy(async () => ({ default: (await import("../pages/HealthPage")).HealthPage }));
const SettingsPage = lazy(async () => ({ default: (await import("../pages/SettingsPage")).SettingsPage }));
const SetupLayout = lazy(async () => ({ default: (await import("../pages/SetupPage")).SetupLayout }));

/** How to get back in once a one-use link or its session is no longer valid (#276). */
export const HUB_RELAUNCH_DETAIL = "Each Hub link works once, within 5 minutes. Close this tab, then run `mex hub` again"
  + " (or rerun the setup command you used, such as `mex setup --browser`) and open the new link it prints.";

function SessionBoundary() {
  const session = useSession();
  const capabilities = useCapabilities();
  const api = useHubApi();
  const setupStatus = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => api.getSetupStatus!(),
    retry: false,
    enabled: session.isSuccess && typeof api.getSetupStatus === "function",
  });
  if (session.isPending) {
    return <div className={styles.fullPageState}><StatePanel state="loading" title="Opening Project Hub" detail="Verifying this process-local session." /></div>;
  }

  if (session.isError) {
    const expired = session.error instanceof HubApiError && session.error.problem.code === "UNAUTHORIZED";
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="unavailable"
          title={expired ? "This Hub session has expired" : "A Hub session is required"}
          detail={HUB_RELAUNCH_DETAIL}
        />
      </div>
    );
  }

  if (
    typeof api.getSetupStatus === "function"
    && setupStatus.isPending
    && setupStatus.fetchStatus === "fetching"
  ) {
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="loading"
          title="Checking MEX setup"
          detail="Inspecting whether this checkout still needs the setup wizard."
        />
      </div>
    );
  }

  // A successful setup response means this process still owns the wizard.
  // Readiness can change after an external commit; only an explicit setup run
  // promotes the listener, after which this endpoint becomes unavailable.
  if (setupStatus.isSuccess) {
    return (
      <Suspense fallback={<div className={styles.fullPageState}><StatePanel state="loading" title="Opening setup" detail="Loading the MEX setup wizard." /></div>}>
        <SetupLayout session={session.data} />
      </Suspense>
    );
  }

  if (capabilities.isPending) {
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="loading"
          title="Loading project capabilities"
          detail="Checking which local workbenches are available for this repository."
        />
      </div>
    );
  }

  if (capabilities.isError) {
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="error"
          title="Project capabilities could not be loaded"
          detail="The Hub could not safely verify which local workbenches are available. Try the check again before continuing."
          action={(
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => void capabilities.refetch()}
            >
              Try again
            </Button>
          )}
        />
      </div>
    );
  }

  if (setupStatus.isError && !isSetupCapabilityUnavailable(setupStatus.error)) {
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="error"
          title="Setup status could not be loaded"
          detail="The Hub could not inspect this checkout. Try the check again before continuing."
          action={(
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => void setupStatus.refetch()}
            >
              Try again
            </Button>
          )}
        />
      </div>
    );
  }

  return <HubLayout capabilities={capabilities.data} session={session.data} />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<SessionBoundary />}>
        <Route index element={<HomePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="knowledge/:id" element={<KnowledgeDetailPage />} />
        <Route path="code" element={<CodePage />} />
        <Route path="code/symbols/:id" element={<SymbolPage />} />
        <Route path="workstreams" element={<WorkstreamsPage />} />
        <Route path="diagrams" element={<DiagramsPage />} />
        <Route path="diagrams/:kind/:id" element={<DiagramsPage />} />
        <Route path="specs" element={<SpecsPage />} />
        <Route path="specs/:id" element={<SpecsPage />} />
        <Route path="playbooks" element={<RoadmapPage page="playbooks" />} />
        <Route path="catch-up" element={<RoadmapPage page="catch-up" />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="relays" element={<RelayPage />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="setup" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function HubApplication({ api, startupError }: { api: HubApi; startupError?: Error | null }) {
  return (
    <HubApiProvider api={api}>
      <div className={styles.desktopOnly}>
        {startupError ? (
          <div className={styles.fullPageState}>
            {startupError instanceof HubApiError && startupError.problem.code === "UNAUTHORIZED"
              ? <StatePanel state="unavailable" title="This Hub link has expired or was already used" detail={HUB_RELAUNCH_DETAIL} />
              : <StatePanel state="error" title="The one-use Hub link was not accepted" detail={startupError.message} />}
          </div>
        ) : <AppRoutes />}
      </div>
      <div className={styles.compactOnly}><DesktopRequired /></div>
    </HubApiProvider>
  );
}

export function BrowserHubApplication(props: { api: HubApi; startupError?: Error | null }) {
  return <BrowserRouter><HubApplication {...props} /></BrowserRouter>;
}
