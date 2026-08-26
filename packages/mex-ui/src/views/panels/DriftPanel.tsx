import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  ScoreRing,
  Skeleton,
  SkeletonRows,
} from "../../components/primitives";
import { formatRelativeTime, humanizeCode, pluralize } from "../../lib/format";
import { SEVERITY_CLASS, describeScore, summarizeIssues } from "../../lib/health";
import type { Resource } from "../../lib/hooks";
import type { DriftPayload } from "../../lib/types";

/**
 * Drift score plus what is behind it. Issues are grouped by code because a
 * single stale file can produce a dozen rows, and a list of a dozen identical
 * messages reads as noise rather than a problem.
 */
export function DriftPanel(props: { drift: Resource<DriftPayload> }) {
  const { data, error, loading, refreshing, reload } = props.drift;

  if (loading) {
    return (
      <Card title="Health" icon={Icon.pulse()}>
        <div className="score">
          <Skeleton height={92} width={92} />
          <div style={{ flex: 1 }}>
            <SkeletonRows rows={3} />
          </div>
        </div>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card title="Health" icon={Icon.pulse()}>
        <ErrorState
          title="Drift check failed"
          message={error?.message ?? "No drift report was returned."}
          hint={error?.hint}
          onRetry={reload}
        />
      </Card>
    );
  }

  const { report, warnings } = data;
  const verdict = describeScore(report.score, report.issues);
  const summary = summarizeIssues(report.issues);

  return (
    <Card
      title="Health"
      icon={Icon.pulse()}
      hint={`checked ${formatRelativeTime(report.timestamp)}`}
      actions={
        <Button size="sm" variant="ghost" onClick={reload} busy={refreshing} title="Re-run the drift check">
          {!refreshing && Icon.refresh()} Re-check
        </Button>
      }
    >
      <div className="stack">
        <div className="score">
          <ScoreRing score={report.score} tone={verdict.tone} />
          <div className="score__body">
            <div className="cluster">
              <Badge tone={verdict.tone} dot>
                {verdict.label}
              </Badge>
              <span className="dim" style={{ fontSize: "0.82rem" }}>
                {pluralize(report.filesChecked, "file")} checked
              </span>
            </div>
            <p className="score__headline">{verdict.headline}</p>
            <div className="cluster">
              <SeverityCount count={summary.errors} label="error" tone="bad" />
              <SeverityCount count={summary.warnings} label="warning" tone="warn" />
              <SeverityCount count={summary.infos} label="info" tone="info" />
            </div>
          </div>
        </div>

        {warnings.length > 0 && (
          <div className="dim" style={{ fontSize: "0.82rem" }}>
            {warnings.map((warning, index) => (
              <div key={index}>{warning}</div>
            ))}
          </div>
        )}
      </div>

      {summary.total === 0 ? (
        <div style={{ marginTop: 4 }}>
          <EmptyState
            icon={Icon.check({ size: 18 })}
            title="No drift detected"
            body="Every documented claim still matches the code. mex re-checks this whenever you ask."
          />
        </div>
      ) : (
        <div className="rows" style={{ margin: "14px -18px -18px" }}>
          {summary.groups.map((group) => (
            <div className="row" key={group.code}>
              <span className={`sev ${SEVERITY_CLASS[group.severity]}`} aria-hidden="true" />
              <div className="row__main">
                <div className="row__title">
                  <span className="row__text">{humanizeCode(group.code)}</span>
                  {group.count > 1 && <Badge tone="neutral">{group.count}</Badge>}
                </div>
                <div className="row__sub" title={group.samples.map((s) => s.message).join("\n")}>
                  {group.samples[0].message}
                </div>
              </div>
              <span className="row__aside mono nowrap">
                {group.samples[0].file}
                {group.samples[0].line !== null && `:${group.samples[0].line}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SeverityCount(props: { count: number; label: string; tone: "bad" | "warn" | "info" }) {
  if (props.count === 0) return null;
  return (
    <span className="dim" style={{ fontSize: "0.82rem" }}>
      <span style={{ color: `var(--${props.tone})` }}>{props.count}</span>{" "}
      {props.count === 1 ? props.label : `${props.label}s`}
    </span>
  );
}
