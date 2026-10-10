import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CheckCircle2, CircleDashed, Database, FileWarning, GitCompare, RefreshCw } from "lucide-react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { useHubApi } from "../api/context";
import type { CapabilitiesResponse, GraphHealthDetails, HealthResponse, JobKind, WikiHealthDetails } from "../api/types";
import { RebuildConfirmation } from "../components/RebuildConfirmation";
import { Button, buttonVariants } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemTitle,
} from "../components/primitives/item";
import { ErrorState, formatDate, PageHeader, StatePanel, StatusPill, stateTone, sentenceCase } from "../components/ui";
import { cn } from "../lib/utils";
import { invalidateIndexOperationState } from "../app/JobLifecycleObserver";
import { graphParseComposition, shortRepositoryHead } from "../lib/health-presentation";
import healthStyles from "../styles/health.module.css";

type HealthComponent = HealthResponse["components"][number];

function operationAvailable(capabilities: CapabilitiesResponse | undefined, kind: JobKind): boolean {
  if (!capabilities) return false;
  if (kind === "graph_refresh") return capabilities.graph.refresh.availability === "available";
  if (kind === "graph_rebuild") return capabilities.graph.rebuild.availability === "available";
  if (kind === "wiki_refresh") return capabilities.wiki.refresh.availability === "available";
  if (kind === "wiki_rebuild") return capabilities.wiki.rebuild.availability === "available";
  return false;
}

function HealthIcon({ status }: { status: string }) {
  if (status === "healthy") return <CheckCircle2 aria-hidden="true" />;
  if (status === "degraded") return <CircleDashed aria-hidden="true" />;
  return <Database aria-hidden="true" />;
}

function Diagnostics({ diagnostics }: { diagnostics: HealthComponent["diagnostics"] }) {
  if (!diagnostics.length) return null;
  const groups = new Map<string, HealthComponent["diagnostics"]>();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([diagnostic.severity, diagnostic.message]);
    const group = groups.get(key);
    if (group) group.push(diagnostic);
    else groups.set(key, [diagnostic]);
  }

  return (
    <ul className={healthStyles.diagnosticList}>
      {[...groups].map(([key, group]) => {
        const diagnostic = group[0]!;
        return (
          <li key={key} data-severity={diagnostic.severity}>
            {group.length === 1 ? diagnostic.message : (
              <details>
                <summary>{diagnostic.message} ({group.length} occurrences)</summary>
                <ul className={healthStyles.diagnosticList}>
                  {group.map((item, index) => (
                    <li key={index}><code>{item.code}</code>{item.path ? <> — <code>{item.path}</code></> : null}</li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ActionControls({
  component,
  onAction,
  actionPending,
  actionAvailable,
  indexJobActive,
}: {
  component: HealthComponent;
  onAction: (kind: JobKind) => void;
  actionPending: (kind: JobKind) => boolean;
  actionAvailable: (kind: JobKind) => boolean;
  indexJobActive: boolean;
}) {
  const actions: JobKind[] = component.graph?.allowedJobKinds
    ?? component.wiki?.allowedJobKinds
    ?? (component.repairJobKind ? [component.repairJobKind] : []);
  const activeJobId = component.graph?.activeJobId ?? component.wiki?.activeJobId;
  const recommendedJobKind = component.graph?.recommendedJobKind ?? component.wiki?.recommendedJobKind;

  if (!activeJobId && !actions.length) return null;

  return (
    <div className={healthStyles.actionControls}>
      {activeJobId ? (
        <Link className={cn(buttonVariants({ size: "sm", variant: "outline" }), healthStyles.activeJobLink)} to={`/jobs?job=${activeJobId}`}>
          View active job
        </Link>
      ) : null}
      {actions.length ? (
        <div className={healthStyles.actionButtons}>
          {actions.map((kind) => {
            const recommended = recommendedJobKind === kind;
            const available = actionAvailable(kind);
            const pending = actionPending(kind);
            return (
              <Button
                className={healthStyles.operationButton}
                disabled={!available || pending}
                key={kind}
                onClick={() => onAction(kind)}
                size="sm"
                title={!available ? indexJobActive ? "Another index operation is active" : "This index operation is unavailable in the current build" : undefined}
                type="button"
                variant={recommended && available ? "default" : "outline"}
              >
                <RefreshCw aria-hidden="true" className={pending ? healthStyles.spin : ""} data-icon="inline-start" />
                {pending ? "Starting…" : kind === "graph_refresh" ? "Refresh graph" : kind === "graph_rebuild" ? "Rebuild graph" : sentenceCase(kind)}
                {recommended && available ? <small>Recommended</small> : null}
              </Button>
            );
          })}
        </div>
      ) : null}
      {actions.some((kind) => !actionAvailable(kind)) ? (
        <small className={healthStyles.actionReason}>
          {indexJobActive ? "New operations wait for the active job." : "Operation unavailable in this build."}
        </small>
      ) : null}
    </div>
  );
}

function WikiHealthReadout({ wiki }: { wiki: WikiHealthDetails }) {
  const recoveryCommand = wiki.recoveryCommand ?? null;
  return (
    <div className={healthStyles.wikiReadout}>
      <div className={healthStyles.indexBanner}>
        <span><small>Wiki index status</small><strong>{sentenceCase(wiki.indexStatus)}</strong></span>
        <StatusPill tone={stateTone(wiki.indexStatus)}>
          {wiki.recommendedJobKind
            ? `${sentenceCase(wiki.recommendedJobKind)} recommended`
            : recoveryCommand
              ? "CLI action required"
              : "No repair recommended"}
        </StatusPill>
      </div>
      <dl className={healthStyles.wikiFacts}>
        <div><dt>Indexed</dt><dd>{formatDate(wiki.indexedAt)}</dd></div>
        <div><dt>Schema</dt><dd className={healthStyles.mono}>{wiki.schemaVersion ?? "Not recorded"}</dd></div>
        <div><dt>Revision</dt><dd className={healthStyles.mono}>{wiki.indexedRevision?.slice(0, 12) ?? "Not indexed"}</dd></div>
        <div><dt>Observed</dt><dd>{formatDate(wiki.observedAt)}</dd></div>
      </dl>
      {recoveryCommand && !wiki.recommendedJobKind ? (
        <div className={healthStyles.recoveryCommand}>
          <small>{recoveryCommand.label}</small>
          <code className={healthStyles.mono}>{recoveryCommand.command}</code>
        </div>
      ) : null}
    </div>
  );
}

function GraphHealthReadout({ graph }: { graph: GraphHealthDetails }) {
  const allChanges = [...graph.changes.added, ...graph.changes.modified, ...graph.changes.deleted];
  const visibleChanges = allChanges.slice(0, 5);
  const additionalChangeCount = allChanges.length - visibleChanges.length;
  const changedSignals = [
    graph.changes.branchChanged ? "Branch changed" : null,
    graph.changes.manifestChanged ? "Manifest changed" : null,
    graph.changes.configChanged ? "Config changed" : null,
    graph.changes.grammarChanged ? "Grammar changed" : null,
  ].filter((value): value is string => value !== null);
  const parse = graphParseComposition(graph.parseHealth);
  const parseStyle = {
    "--parse-ok": `${parse.okPercent}%`,
    "--parse-partial": `${parse.partialPercent}%`,
    "--parse-failed": `${parse.failedPercent}%`,
  } as CSSProperties;

  return (
    <div className={healthStyles.graphReadout}>
      <div className={healthStyles.indexBanner}>
        <span>
          <small>Graph index status</small>
          <strong>{sentenceCase(graph.indexStatus)}</strong>
        </span>
        <StatusPill tone={stateTone(graph.indexStatus)}>
          {graph.recommendedJobKind ? `${sentenceCase(graph.recommendedJobKind)} recommended` : "No repair recommended"}
        </StatusPill>
      </div>

      <div className={healthStyles.snapshotPair}>
        <section className={healthStyles.snapshot} aria-labelledby="indexed-snapshot-heading">
          <small id="indexed-snapshot-heading">Indexed snapshot</small>
          <strong>{graph.indexedBranch ?? "Detached / unavailable"}</strong>
          <code>{shortRepositoryHead(graph.indexedHead)}</code>
        </section>
        <span className={healthStyles.compareGlyph} aria-hidden="true"><GitCompare /></span>
        <section className={healthStyles.snapshot} data-current="true" aria-labelledby="current-repository-heading">
          <small id="current-repository-heading">Current repository</small>
          <strong>{graph.currentBranch ?? "Detached / unborn"}</strong>
          <code>{shortRepositoryHead(graph.currentHead)}</code>
        </section>
      </div>

      <div className={healthStyles.evidenceBand}>
        <section className={healthStyles.parseEvidence} aria-labelledby="parse-health-heading">
          <div className={healthStyles.metricTopline}>
            <small id="parse-health-heading">Parse health</small>
            <strong>{graph.parseHealth.ok}/{graph.parseHealth.total}</strong>
          </div>
          <div
            aria-label={parse.accessibleLabel}
            className={healthStyles.parseComposition}
            role="img"
            style={parseStyle}
          >
            <span data-kind="ok" />
            <span data-kind="partial" />
            <span data-kind="failed" />
          </div>
          <div className={healthStyles.parseLegend}>
            <span data-kind="ok">{graph.parseHealth.ok} complete</span>
            <span data-kind="partial">{graph.parseHealth.partial} partial</span>
            <span data-kind="failed">{graph.parseHealth.failed} failed</span>
          </div>
        </section>

        <section className={`${healthStyles.evidenceMetric} ${healthStyles.repositoryDelta}`} aria-labelledby="repository-delta-heading">
          <small id="repository-delta-heading">Repository delta</small>
          <strong>{graph.changes.total}</strong>
          <em>{graph.changes.added.length} added · {graph.changes.modified.length} modified · {graph.changes.deleted.length} deleted</em>
        </section>

        <section className={healthStyles.evidenceMetric} aria-labelledby="last-success-heading">
          <small id="last-success-heading">Last success</small>
          <strong>{formatDate(graph.lastSuccessfulIndexAt)}</strong>
          <em>Indexed {formatDate(graph.indexedAt)}</em>
        </section>
      </div>

      <div className={healthStyles.compatibility} aria-label="Graph compatibility versions">
        <span>Schema <code>{graph.schemaVersion ?? "—"}</code></span>
        <span>Extractor <code>{graph.extractorVersion ?? "—"}</code></span>
        <span>Grammar <code>{graph.grammarVersion ?? "—"}</code></span>
      </div>

      {changedSignals.length || visibleChanges.length ? (
        <div className={healthStyles.changeEvidence}>
          <FileWarning aria-hidden="true" />
          <div>
            {changedSignals.length ? <p>{changedSignals.join(" · ")}</p> : null}
            {visibleChanges.length ? <ul>{visibleChanges.map((path) => <li className={healthStyles.mono} key={path}>{path}</li>)}</ul> : null}
            {additionalChangeCount ? <small>{additionalChangeCount} additional changed path{additionalChangeCount === 1 ? "" : "s"} omitted from this compact readout.</small> : null}
            {graph.changes.truncated ? <small>Changed paths were shortened by the health response bound.</small> : null}
          </div>
        </div>
      ) : null}

      {graph.parseHealth.failedPaths.length ? (
        <div className={healthStyles.failedPaths}>
          <strong>Files with parse failures</strong>
          <ul>{graph.parseHealth.failedPaths.map((path) => <li className={healthStyles.mono} key={path}>{path}</li>)}</ul>
          {graph.parseHealth.failedPathsTruncated ? <small>Additional failed paths were omitted.</small> : null}
        </div>
      ) : null}
    </div>
  );
}

function GraphDossier({
  component,
  onAction,
  actionPending,
  actionAvailable,
  indexJobActive,
  wide,
}: {
  component: HealthComponent;
  onAction: (kind: JobKind) => void;
  actionPending: (kind: JobKind) => boolean;
  actionAvailable: (kind: JobKind) => boolean;
  indexJobActive: boolean;
  wide: boolean;
}) {
  return (
    <Card
      aria-labelledby={`health-${component.id}-heading`}
      className={`${healthStyles.surface} ${healthStyles.graphDossier} ${wide ? healthStyles.graphDossierWide : ""}`}
      role="region"
      size="sm"
    >
      <CardHeader className={healthStyles.graphHeader}>
        <span className={healthStyles.componentIcon} data-tone={stateTone(component.status)}><HealthIcon status={component.status} /></span>
        <div className={healthStyles.graphIdentity}>
          <CardTitle className={healthStyles.componentTitle}>
            <h2 id={`health-${component.id}-heading`}>{component.label}</h2>
            <StatusPill tone={stateTone(component.status)}>{sentenceCase(component.status)}</StatusPill>
          </CardTitle>
          <CardDescription className={healthStyles.componentSummary}>{component.summary}</CardDescription>
          <Diagnostics diagnostics={component.diagnostics} />
        </div>
        <CardAction className={healthStyles.graphActions}>
          <ActionControls
            actionAvailable={actionAvailable}
            actionPending={actionPending}
            component={component}
            indexJobActive={indexJobActive}
            onAction={onAction}
          />
        </CardAction>
      </CardHeader>
      {component.graph ? <CardContent className={healthStyles.graphContent}><GraphHealthReadout graph={component.graph} /></CardContent> : null}
    </Card>
  );
}

function ServiceRow({
  component,
  onAction,
  actionPending,
  actionAvailable,
  indexJobActive,
}: {
  component: HealthComponent;
  onAction: (kind: JobKind) => void;
  actionPending: (kind: JobKind) => boolean;
  actionAvailable: (kind: JobKind) => boolean;
  indexJobActive: boolean;
}) {
  return (
    <Item className={healthStyles.serviceRow} role="listitem" size="sm">
      <ItemMedia className={healthStyles.serviceIcon} data-tone={stateTone(component.status)} variant="icon"><HealthIcon status={component.status} /></ItemMedia>
      <ItemContent className={healthStyles.serviceMain}>
        <ItemHeader className={healthStyles.serviceTitle}>
          <ItemTitle><h3>{component.label}</h3></ItemTitle>
          <StatusPill tone={stateTone(component.status)}>{sentenceCase(component.status)}</StatusPill>
        </ItemHeader>
        <ItemDescription>{component.summary}</ItemDescription>
        <Diagnostics diagnostics={component.diagnostics} />
        {component.wiki ? <WikiHealthReadout wiki={component.wiki} /> : null}
        <ActionControls
          actionAvailable={actionAvailable}
          actionPending={actionPending}
          component={component}
          indexJobActive={indexJobActive}
          onAction={onAction}
        />
      </ItemContent>
    </Item>
  );
}

function PageIntro({ action }: { action?: ReactNode }) {
  return (
    <div className={healthStyles.pageIntro}>
      <PageHeader
        title="Health"
        actions={action}
      />
    </div>
  );
}

export function HealthPage() {
  const api = useHubApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [confirmRebuild, setConfirmRebuild] = useState<"graph_rebuild" | "wiki_rebuild" | null>(null);
  const rebuildReturnFocus = useRef<HTMLElement | null>(null);
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.getHealth(), retry: false });
  const start = useMutation({
    mutationFn: (kind: JobKind) => api.startJob({ kind }),
    onSuccess: (job) => {
      setConfirmRebuild(null);
      navigate(`/jobs?job=${encodeURIComponent(job.id)}`);
      void Promise.all([
        invalidateIndexOperationState(queryClient),
        queryClient.invalidateQueries({ queryKey: ["job-lifecycle"] }),
      ]);
    },
    onError: () => {
      setConfirmRebuild(null);
      rebuildReturnFocus.current?.focus({ preventScroll: true });
    },
  });

  function requestAction(kind: JobKind) {
    if (kind === "graph_rebuild" || kind === "wiki_rebuild") {
      rebuildReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmRebuild(kind);
      return;
    }
    start.mutate(kind);
  }

  function isActionAvailable(component: HealthComponent, kind: JobKind): boolean {
    if (hasActiveIndexJob || start.isPending) return false;
    return operationAvailable(capabilities, kind) && (
      (!component.graph && !component.wiki)
      || (component.graph !== undefined && component.graph.activeJobId === null && component.graph.allowedJobKinds.some((allowed) => allowed === kind))
      || (component.wiki !== undefined && component.wiki.activeJobId === null && component.wiki.allowedJobKinds.some((allowed) => allowed === kind))
    );
  }

  function isActionPending(kind: JobKind): boolean {
    return start.isPending && start.variables === kind;
  }

  const graphComponent = health.data?.components.find((component) => component.id === "graph");
  const serviceComponents = health.data?.components.filter((component) => component.id !== "graph") ?? [];
  const hasActiveIndexJob = health.data?.components.some((component) => Boolean(component.graph?.activeJobId || component.wiki?.activeJobId)) ?? false;

  return (
    <div className={healthStyles.page}>
      <PageIntro action={health.data ? <StatusPill tone={stateTone(health.data.status)}>{sentenceCase(health.data.status)}</StatusPill> : undefined} />
      {start.isError ? <ErrorState error={start.error} /> : null}
      {health.isPending ? (
        <StatePanel state="loading" title="Inspecting system health" detail="This is a read-only inspection of local repository services." />
      ) : health.isError ? (
        <ErrorState error={health.error} retry={() => void health.refetch()} />
      ) : (
        <>
          <Card aria-labelledby="health-overview-heading" className={healthStyles.overviewCard} role="region" size="sm">
            <CardHeader className={healthStyles.overviewBand}>
              <span className={healthStyles.overviewIcon} data-tone={stateTone(health.data.status)}><HealthIcon status={health.data.status} /></span>
              <div className={healthStyles.overviewAssessment}>
                <CardTitle><h2 id="health-overview-heading">{sentenceCase(health.data.status)}</h2></CardTitle>
                <CardDescription>{health.data.components.length} local services</CardDescription>
              </div>
              <CardAction>
                <time>
                  <small>Checked</small>
                  <strong>{formatDate(health.data.observedAt)}</strong>
                </time>
              </CardAction>
            </CardHeader>
          </Card>

          <div className={healthStyles.dossierGrid}>
            {graphComponent ? (
              <GraphDossier
                actionAvailable={(kind) => isActionAvailable(graphComponent, kind)}
                actionPending={isActionPending}
                component={graphComponent}
                indexJobActive={hasActiveIndexJob || start.isPending}
                onAction={requestAction}
                wide={!serviceComponents.length}
              />
            ) : null}

            {serviceComponents.length ? (
              <aside className={`${healthStyles.serviceRail} ${graphComponent ? "" : healthStyles.serviceRailWide}`} aria-labelledby="service-ledger-heading">
                <Card className={`${healthStyles.surface} ${healthStyles.serviceCard}`} size="sm">
                  <CardHeader className={healthStyles.railHeader}>
                    <CardTitle><h2 id="service-ledger-heading">Services</h2></CardTitle>
                    <CardAction><span className={healthStyles.serviceCount}>{serviceComponents.length}</span></CardAction>
                  </CardHeader>
                  <CardContent className={healthStyles.serviceContent}>
                    <ItemGroup className={healthStyles.serviceList}>
                      {serviceComponents.map((component) => (
                        <ServiceRow
                          actionAvailable={(kind) => isActionAvailable(component, kind)}
                          actionPending={isActionPending}
                          component={component}
                indexJobActive={hasActiveIndexJob || start.isPending}
                          key={component.id}
                          onAction={requestAction}
                        />
                      ))}
                    </ItemGroup>
                  </CardContent>
                </Card>
              </aside>
            ) : null}
          </div>
        </>
      )}
      <RebuildConfirmation
        onCancel={() => {
          setConfirmRebuild(null);
          rebuildReturnFocus.current?.focus({ preventScroll: true });
        }}
        onConfirm={() => { if (confirmRebuild) start.mutate(confirmRebuild); }}
        open={confirmRebuild !== null}
        pending={start.isPending && start.variables === confirmRebuild}
        target={confirmRebuild === "wiki_rebuild" ? "wiki" : "graph"}
      />
    </div>
  );
}
