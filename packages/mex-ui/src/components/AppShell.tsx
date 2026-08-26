import type { ReactNode } from "react";
import { Badge, Button, Icon } from "./primitives";
import { Sidebar } from "./Sidebar";
import { truncatePath } from "../lib/format";
import { ROUTES, type NavId } from "../lib/nav";
import type { ProjectSnapshot } from "../lib/types";

const STATUS_BADGE = {
  ready: { tone: "good", label: "Ready" },
  empty: { tone: "neutral", label: "Not set up" },
  error: { tone: "bad", label: "Needs attention" },
} as const;

export function AppShell(props: {
  snapshot: ProjectSnapshot | null;
  path: string;
  navigate: (to: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  children: ReactNode;
}) {
  const { snapshot, path, navigate, onRefresh, refreshing, children } = props;
  const status = snapshot ? STATUS_BADGE[snapshot.status] : null;
  const hints = snapshotHints(snapshot);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__inner">
          <button type="button" className="brand" onClick={() => navigate(ROUTES.home)} title="Dashboard">
            <span className="brand__mark" aria-hidden="true">
              m
            </span>
            <span>mex</span>
          </button>

          {snapshot && (
            <div className="topbar__project">
              <span className="dim" aria-hidden="true">
                /
              </span>
              <span className="topbar__project-name" title={snapshot.projectRoot}>
                {snapshot.projectName}
              </span>
              {status && (
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
              )}
            </div>
          )}

          <div className="topbar__spacer" />

          <div className="topbar__actions">
            {snapshot && (
              <span className="topbar__path mono nowrap" title={snapshot.projectRoot}>
                {truncatePath(snapshot.projectRoot, 28)}
              </span>
            )}
            {onRefresh && (
              <Button variant="ghost" size="sm" onClick={onRefresh} busy={refreshing} title="Reload project state">
                {!refreshing && Icon.refresh()}
                Refresh
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="shell__body">
        <Sidebar path={path} navigate={navigate} hints={hints} />
        <main className="shell__main">
          <div className="shell__content">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** Snapshot-only hints — cheap enough to show before drift/graph loads. */
function snapshotHints(snapshot: ProjectSnapshot | null): Partial<Record<NavId, string>> | undefined {
  if (!snapshot) return undefined;
  const hints: Partial<Record<NavId, string>> = {};
  const unfilled = snapshot.scaffold.total - snapshot.scaffold.populated;
  if (snapshot.status === "empty") hints.setup = "start";
  else if (snapshot.status === "error") hints.setup = "repair";
  else if (unfilled > 0) hints.setup = String(unfilled);

  if (snapshot.status === "ready" && !snapshot.graph.present) hints.graph = "off";
  return hints;
}
