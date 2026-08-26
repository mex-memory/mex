import { useMemo } from "react";
import { Banner, Button, Icon } from "../components/primitives";
import { GroundingCapture } from "./panels/GroundingCapture";
import { JobProgress } from "./panels/JobProgress";
import { SetupJourney } from "./panels/SetupJourney";
import { SetupWizard } from "./SetupWizard";
import { api } from "../lib/api";
import { useGraphBuild, useResource } from "../lib/hooks";
import { ROUTES } from "../lib/nav";
import type { ProjectSnapshot } from "../lib/types";

/**
 * Scaffold status, plus a way into the wizard. After first run, the same
 * numbered path (graph → populate → ground) stays here so closing the tab
 * mid-setup does not lose the order.
 */
export function SetupView(props: {
  snapshot: ProjectSnapshot;
  showWizard: boolean;
  onFinish: () => void;
  onNavigate: (to: string) => void;
  /** Refresh drift and the snapshot after grounding baselines change. */
  onCaptured?: () => void;
  /** Refresh snapshot after a graph build from this view. */
  onGraphBuilt?: () => void;
}) {
  const { snapshot, showWizard, onFinish, onNavigate, onCaptured, onGraphBuilt } = props;

  if (showWizard) {
    return (
      <SetupWizard
        snapshot={snapshot}
        onFinish={onFinish}
        onCancel={() => onNavigate(ROUTES.setup)}
      />
    );
  }

  const empty = snapshot.status === "empty";
  const broken = snapshot.status === "error";
  const wizardCta = empty ? "Start setup" : broken ? "Repair with setup" : null;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div className="page-head__text">
          <h1>Setup</h1>
          <p className="page-head__sub">
            {empty
              ? "Four ordered steps: scaffold, code graph, agent population, then grounding."
              : broken
                ? "The scaffold is here but mex couldn't load it."
                : "Continue the path in order — graph before agent prompt, capture after the agent finishes."}
          </p>
        </div>
        {wizardCta ? (
          <Button variant="primary" onClick={() => onNavigate(ROUTES.setupWizard)}>
            {wizardCta} {Icon.arrowRight()}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => onNavigate(ROUTES.setupWizard)}>
            Re-run wizard
          </Button>
        )}
      </div>

      {broken && snapshot.error && (
        <Banner tone="bad" title={snapshot.error.message} icon={Icon.warning()}>
          {snapshot.error.hint}
        </Banner>
      )}

      {empty && snapshot.scaffold.total === 0 ? (
        <Banner tone="info" title="Nothing on disk yet" icon={Icon.doc()}>
          Start setup to create the wiki, build the code graph, then paste one prompt into your agent.
          Files that already have real content are left alone if you run it again.
        </Banner>
      ) : (
        !empty && (
          <ContinueJourney snapshot={snapshot} onCaptured={onCaptured} onGraphBuilt={onGraphBuilt} />
        )
      )}
    </div>
  );
}

/**
 * Mid-flight setup: same numbered steps as the wizard finish screen, driven by
 * what is already on disk.
 */
function ContinueJourney(props: {
  snapshot: ProjectSnapshot;
  onCaptured?: () => void;
  onGraphBuilt?: () => void;
}) {
  const { snapshot, onCaptured, onGraphBuilt } = props;
  const plan = useResource(() => api.setupPlan(), []);
  const graphBuild = useGraphBuild(() => onGraphBuilt?.());

  const graphReady = snapshot.graph.present;
  const unfilled = snapshot.scaffold.total - snapshot.scaffold.populated;
  const graphRunning = graphBuild.building || graphBuild.job?.status === "running";
  const graphFailed = graphBuild.job?.status === "failed" || Boolean(graphBuild.buildError);

  const focus = useMemo(() => {
    if (!graphReady) return "graph" as const;
    if (unfilled > 0) return "populate" as const;
    return "ground" as const;
  }, [graphReady, unfilled]);

  return (
    <div className="stack">
      <SetupJourney
        mode="code-repo"
        focus={focus}
        scaffold={{
          status: "done",
          detail: `${snapshot.scaffold.populated}/${snapshot.scaffold.total} scaffold files populated.`,
        }}
        graph={{
          status: graphReady
            ? "done"
            : graphRunning
              ? "running"
              : graphFailed
                ? "failed"
                : "ready",
          detail: graphReady
            ? `graph.db present${snapshot.graph.bytes ? ` · ${(snapshot.graph.bytes / 1024).toFixed(0)} KB` : ""}`
            : graphBuild.buildError ||
              (graphRunning ? "Indexing source…" : "Required before you paste the agent prompt."),
          onBuild: !graphReady ? () => void graphBuild.startBuild() : undefined,
          building: graphBuild.building,
        }}
        populate={{
          status: graphReady ? "ready" : "locked",
          prompt: plan.data?.populationPrompt ?? null,
          promptLoading: plan.loading,
          promptError: plan.error?.message ?? null,
          detail: graphReady
            ? unfilled > 0
              ? `${unfilled} template file${unfilled === 1 ? "" : "s"} still need the agent. Paste the prompt from the project root.`
              : "Scaffold looks populated. If grounding is still empty, re-ask the agent to fill grounds_to from the graph."
            : "Unlocks after the code graph finishes.",
        }}
        ground={{
          status: graphReady ? "ready" : "locked",
          detail: graphReady
            ? undefined
            : "Unlocks after the code graph finishes. Capture only after your agent has authored grounds_to.",
          children: graphReady ? <GroundingCapture onCaptured={onCaptured} /> : undefined,
        }}
        graphExtra={
          graphBuild.job ? (
            <JobProgress
              job={graphBuild.job}
              title={graphBuild.job.status === "succeeded" ? "Graph built" : "Building code graph"}
              pendingLabel="Starting graph build…"
            />
          ) : null
        }
      />
    </div>
  );
}
