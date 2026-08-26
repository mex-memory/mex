import {
  Badge,
  BarList,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  SkeletonRows,
} from "../../components/primitives";
import { JobProgress } from "./JobProgress";
import { formatBytes, formatCount, formatRelativeTime, languageLabel, pluralize } from "../../lib/format";
import type { Resource } from "../../lib/hooks";
import type { GraphFileStatus, GraphStats, Job } from "../../lib/types";

/**
 * Code-graph statistics, read from `.mex/graph.db` in read-only mode. An absent
 * or incompatible index is a first-class state with its own call to action
 * rather than an error.
 */
export function GraphPanel(props: {
  graph: Resource<GraphStats>;
  file: GraphFileStatus;
  buildJob: Job | null;
  building: boolean;
  onBuild: () => void;
}) {
  const { graph, file, buildJob, building, onBuild } = props;
  const { data, error, loading, reload } = graph;

  const buildButton = (
    <Button size="sm" onClick={onBuild} busy={building} title="Run the graph build">
      {!building && Icon.graph()} {data?.available ? "Rebuild" : "Build graph"}
    </Button>
  );

  if (buildJob && buildJob.status === "running") {
    return <JobProgress job={buildJob} title="Building the code graph" showLog={false} />;
  }

  if (loading) {
    return (
      <Card title="Code graph" icon={Icon.graph()}>
        <SkeletonRows rows={4} />
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card title="Code graph" icon={Icon.graph()}>
        <ErrorState
          title="Couldn't read the code graph"
          message={error?.message ?? "No graph statistics were returned."}
          onRetry={reload}
        />
      </Card>
    );
  }

  if (!data.available) {
    const needsRebuild = data.unavailable?.reason === "needs-rebuild";
    return (
      <Card title="Code graph" icon={Icon.graph()} actions={buildButton}>
        <EmptyState
          icon={Icon.graph({ size: 18 })}
          title={needsRebuild ? "The graph needs rebuilding" : "No code graph yet"}
          body={
            needsRebuild
              ? data.unavailable?.message
              : "The graph lets your agent resolve symbols and lets mex verify that documented claims still point at real code. Building it is safe and repeatable."
          }
        />
        {buildJob?.status === "failed" && (
          <p className="dim" style={{ textAlign: "center", fontSize: "0.84rem", color: "var(--bad)" }}>
            {buildJob.error}
          </p>
        )}
      </Card>
    );
  }

  const languages = data.languages.filter((entry) => entry.nodes > 0).slice(0, 6);
  const kinds = data.nodesByKind.slice(0, 6);

  return (
    <Card
      title="Code graph"
      icon={Icon.graph()}
      hint={file.modifiedAt ? `built ${formatRelativeTime(file.modifiedAt)}` : undefined}
      actions={buildButton}
    >
      <div className="stack">
        <div className="cluster" style={{ gap: 18 }}>
          <Figure label="nodes" value={formatCount(data.totals.nodes)} />
          <Figure label="edges" value={formatCount(data.totals.edges)} />
          <Figure label="files" value={formatCount(data.totals.files)} />
          <div style={{ flex: 1 }} />
          <ParseHealth health={data.health} />
        </div>

        {languages.length > 0 && (
          <Section title="Languages">
            <BarList
              items={languages.map((entry) => ({
                label: languageLabel(entry.language),
                value: entry.nodes,
              }))}
            />
          </Section>
        )}

        {kinds.length > 0 && (
          <Section title="Symbol kinds">
            <BarList
              items={kinds.map((entry) => ({ label: entry.kind.replace(/_/g, " "), value: entry.count }))}
            />
          </Section>
        )}

        <p className="dim" style={{ fontSize: "0.8rem" }}>
          {formatBytes(file.bytes)} in <code className="mono">{file.path}</code>
          {data.recentFiles[0] && ` · last indexed ${formatRelativeTime(data.recentFiles[0].indexedAt)}`}
        </p>
      </div>
    </Card>
  );
}

function Figure(props: { label: string; value: string }) {
  return (
    <div>
      <div className="stat__value" style={{ fontSize: "1.35rem" }}>
        {props.value}
      </div>
      <div className="dim" style={{ fontSize: "0.78rem" }}>
        {props.label}
      </div>
    </div>
  );
}

function ParseHealth(props: { health: GraphStats["health"] }) {
  const { okFiles, partialFiles, failedFiles, indexedFiles } = props.health;
  if (indexedFiles === 0) return null;
  if (failedFiles === 0 && partialFiles === 0) {
    return (
      <Badge tone="good" dot>
        All files parsed
      </Badge>
    );
  }
  return (
    <span className="cluster">
      {failedFiles > 0 && <Badge tone="bad">{pluralize(failedFiles, "file")} failed</Badge>}
      {partialFiles > 0 && <Badge tone="warn">{pluralize(partialFiles, "file")} partial</Badge>}
      <span className="dim" style={{ fontSize: "0.8rem" }}>
        {formatCount(okFiles)} clean
      </span>
    </span>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="stat__label" style={{ marginBottom: 9 }}>
        {props.title}
      </h3>
      {props.children}
    </div>
  );
}
