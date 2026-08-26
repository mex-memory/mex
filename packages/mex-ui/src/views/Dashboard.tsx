import { Badge, Banner, Button, Card, Icon, Stat } from "../components/primitives";
import { JobProgress } from "./panels/JobProgress";
import { formatCount, formatRelativeTime } from "../lib/format";
import { TONE_CLASS, buildRecommendations, describeScore } from "../lib/health";
import { ROUTES } from "../lib/nav";
import type { Resource } from "../lib/hooks";
import type {
  DriftPayload,
  GraphStats,
  GroundingCoverage,
  Job,
  ProjectSnapshot,
} from "../lib/types";

/**
 * Glanceable overview. Detail lives on Health, Graph, Activity, and Setup —
 * this page is stats plus what to do next so it can stay open while coding.
 */
export function Dashboard(props: {
  snapshot: ProjectSnapshot;
  drift: Resource<DriftPayload>;
  graph: Resource<GraphStats>;
  grounding: Resource<GroundingCoverage>;
  buildJob: Job | null;
  building: boolean;
  buildError: string | null;
  onBuild: () => void;
  onNavigate: (to: string) => void;
}) {
  const { snapshot, drift, graph, grounding, buildJob, building, buildError, onBuild, onNavigate } =
    props;

  const verdict = drift.data
    ? describeScore(drift.data.report.score, drift.data.report.issues)
    : null;

  const recommendations = buildRecommendations({
    snapshot,
    graph: graph.data,
    issues: drift.data?.report.issues ?? null,
    grounding: grounding.data,
    graphBuilding: building || buildJob?.status === "running",
  });

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div className="page-head__text">
          <h1>Overview</h1>
          <p className="page-head__sub">
            {snapshot.identity?.scaffold_name ? (
              <>
                Scaffold <span className="mono">{snapshot.identity.scaffold_name}</span> ·{" "}
              </>
            ) : null}
            snapshot {formatRelativeTime(snapshot.capturedAt)}
          </p>
        </div>
      </div>

      {buildError && (
        <Banner tone="bad" title="The graph build failed" icon={Icon.warning()}>
          {buildError}
        </Banner>
      )}

      {buildJob?.status === "running" && (
        <JobProgress job={buildJob} title="Building the code graph" showLog={false} />
      )}

      <div className="grid grid--stats">
        <Stat
          label="Drift score"
          value={drift.data ? drift.data.report.score : "—"}
          title="Open Health"
          onClick={() => onNavigate(ROUTES.health)}
          meta={
            verdict ? (
              <Badge tone={verdict.tone} dot>
                {verdict.label}
              </Badge>
            ) : (
              <span className="dim">checking…</span>
            )
          }
        />
        <Stat
          label="Scaffold"
          value={`${snapshot.scaffold.populated}/${snapshot.scaffold.total}`}
          title="Open Setup"
          onClick={() => onNavigate(ROUTES.setup)}
          meta="files populated"
        />
        <Stat
          label="Graph nodes"
          value={graph.data?.available ? formatCount(graph.data.totals.nodes) : "—"}
          title="Open Graph"
          onClick={() => onNavigate(ROUTES.graph)}
          meta={
            graph.data?.available
              ? `${formatCount(graph.data.totals.files)} files indexed`
              : snapshot.graph.present
                ? "needs rebuild"
                : "not built"
          }
        />
        <Stat
          label="Open issues"
          value={drift.data ? formatCount(drift.data.report.issues.length) : "—"}
          title="Open Health"
          onClick={() => onNavigate(ROUTES.health)}
          meta={
            drift.data
              ? `${drift.data.report.issues.filter((i) => i.severity === "error").length} errors`
              : "checking…"
          }
        />
      </div>

      {recommendations.length > 0 ? (
        <Card title="What to do next" icon={Icon.spark()} flush>
          <div className="rows">
            {recommendations.map((recommendation) => (
              <div className="row" key={recommendation.id}>
                <span className={`sev ${TONE_CLASS[recommendation.tone]}`} aria-hidden="true" />
                <div className="row__main">
                  <div className="row__title">
                    <span className="row__text">{recommendation.title}</span>
                  </div>
                  <div className="row__sub" style={{ whiteSpace: "normal" }}>
                    {recommendation.body}
                  </div>
                </div>
                {recommendation.command && (
                  <code className="row__aside mono">{recommendation.command}</code>
                )}
                {recommendation.action === "build-graph" && (
                  <Button size="sm" onClick={onBuild} busy={building}>
                    Build now
                  </Button>
                )}
                {recommendation.action === "run-setup" && (
                  <Button size="sm" onClick={() => onNavigate(ROUTES.setupWizard)}>
                    Repair
                  </Button>
                )}
                {recommendation.action === "open-setup" && (
                  <Button size="sm" onClick={() => onNavigate(ROUTES.setup)}>
                    Get prompt
                  </Button>
                )}
                {/* Capture lives on Setup, where the coverage detail and the job
                    log are — a bare button here would fire it blind. */}
                {recommendation.action === "capture-grounding" && (
                  <Button size="sm" onClick={() => onNavigate(ROUTES.setup)}>
                    Capture
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      ) : (
        !drift.loading &&
        graph.data && (
          <Card>
            <div className="cluster">
              <Badge tone="good" dot>
                Clear
              </Badge>
              <span className="muted" style={{ fontSize: "0.87rem" }}>
                Nothing needs you right now. Leave this open — it will say when something does.
              </span>
            </div>
          </Card>
        )
      )}
    </div>
  );
}
