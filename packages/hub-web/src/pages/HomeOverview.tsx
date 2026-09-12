import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpenText,
  Braces,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  GitBranch,
  LoaderCircle,
  Network,
  RadioTower,
  RefreshCw,
  ScrollText,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { RelayIdSchema } from "@mex/hub-contracts/ids";
import { useHubApi } from "../api/context";
import type { ActivityItem, OverviewResponse } from "../api/types";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/primitives/alert";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/primitives/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/primitives/item";
import { Progress, ProgressLabel, ProgressValue } from "../components/primitives/progress";
import { Separator } from "../components/primitives/separator";
import { Skeleton } from "../components/primitives/skeleton";
import {
  ErrorState,
  formatDate,
  PageHeader,
  sentenceCase,
  stateTone,
  StatusPill,
} from "../components/ui";
import {
  activityActorLabel,
  activityHeadline,
  activityPrimaryContext,
  activityProjectNoteKind,
  activitySubjectRoute,
} from "../lib/activity-presentation";
import { graphParseComposition, shortRepositoryHead } from "../lib/health-presentation";
import { TeamAccessCard } from "./TeamAccessCard";
import homeStyles from "../styles/home.module.css";

type FocusPanel = Extract<OverviewResponse["focus"], { availability: "available" }>;
type ReadinessState = "ready" | "preparing" | "attention";

interface FocusItemView {
  id: string;
  title: string;
  description?: string;
  action: string;
  route: string;
  icon: LucideIcon;
}

interface ReadinessView {
  state: ReadinessState;
  label: string;
}

const REFRESH_QUERY_KEYS = [
  ["home"],
  ["overview"],
  ["actor", "current"],
  ["inbox"],
  ["relays"],
  ["activity"],
  ["health"],
  ["jobs"],
] as const;

function HomeHeader({
  data,
  onRefresh,
  refreshing,
}: {
  data?: OverviewResponse;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <PageHeader
      title="Overview"
      description={data ? `Last checked ${formatDate(data.observedAt)}` : undefined}
      actions={(
        <div className={homeStyles.headerActions}>
          <Button disabled={refreshing} onClick={onRefresh} size="sm" type="button" variant="outline">
            <RefreshCw
              aria-hidden="true"
              className={refreshing ? homeStyles.refreshingIcon : undefined}
              data-icon="inline-start"
            />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      )}
    />
  );
}

function PanelUnavailable({
  label,
  reason,
  onRetry,
}: {
  label: string;
  reason: string;
  onRetry: () => void;
}) {
  return (
    <Alert className={homeStyles.panelAlert}>
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>{label} unavailable</AlertTitle>
      <AlertDescription>{reason}</AlertDescription>
      <AlertAction>
        <Button aria-label={`Try loading ${label} again`} onClick={onRetry} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" data-icon="inline-start" />
          Try again
        </Button>
      </AlertAction>
    </Alert>
  );
}

function TechnicalDisclosure({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Collapsible className={homeStyles.technicalDisclosure}>
      <CollapsibleTrigger
        aria-label={`View technical details for ${label}`}
        render={<Button size="sm" type="button" variant="ghost" />}
      >
        <ChevronDown aria-hidden="true" data-icon="inline-start" />
        Technical details
      </CollapsibleTrigger>
      <CollapsibleContent className={homeStyles.technicalContent}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function actorAttentionDescription(data: OverviewResponse): string {
  if (data.identity.availability === "unavailable") return data.identity.reason;
  const diagnostic = data.identity.current.diagnostics[0];
  if (diagnostic) return diagnostic.message;
  if (data.identity.current.actor.kind === "unknown") {
    return "Select or repair an active team identity before MEX attributes shared actions.";
  }
  if (
    data.identity.current.selection !== null
    && data.identity.current.source !== "configured-member"
  ) {
    return "Your saved identity choice no longer resolves cleanly in this checkout.";
  }
  return "Review the team identity MEX uses for shared actions in this checkout.";
}

function relayRoute(source: FocusPanel["relays"], kind: "ready" | "claimed"): string {
  if (source.availability !== "available") return "/relays?view=mine&state=open";
  const relay = kind === "ready" ? source.readyToTake[0] : source.inYourHands[0];
  const parsed = relay ? RelayIdSchema.safeParse(relay.ref.id) : null;
  return parsed?.success
    ? `/relays?view=mine&state=open&relay=${encodeURIComponent(parsed.data)}`
    : "/relays?view=mine&state=open";
}

function contextReadiness(context: OverviewResponse["context"]): ReadinessView {
  if (context.availability === "unavailable") {
    return {
      state: "attention",
      label: "Needs attention",
    };
  }
  if (context.graph.availability === "unavailable" || context.wiki.availability === "unavailable") {
    return {
      state: "attention",
      label: "Needs attention",
    };
  }
  const graphStatus = context.graph.details.indexStatus;
  const wikiStatus = context.wiki.details.indexStatus;
  if (graphStatus === "missing" || wikiStatus === "missing") {
    return {
      state: "preparing",
      label: "Preparing",
    };
  }
  if (
    graphStatus === "fresh"
    && wikiStatus === "fresh"
    && context.graph.details.parseHealth.failed === 0
  ) {
    return {
      state: "ready",
      label: "Ready",
    };
  }
  return {
    state: "attention",
    label: "Needs attention",
  };
}

// Context reads refuse every Wiki index that is not fresh, so only offer the
// doorway when the page behind it can load.
function knowledgeBrowsable(context: OverviewResponse["context"]): boolean {
  return context.availability === "available"
    && context.wiki.availability === "available"
    && context.wiki.details.indexStatus === "fresh";
}

function memoryHero(context: OverviewResponse["context"]): {
  description: string;
  action: string;
  route: string;
} {
  if (knowledgeBrowsable(context)) {
    return {
      description: "Notes for this repo, linked to the code.",
      action: "Open Context",
      route: "/knowledge",
    };
  }
  return {
    description: "The local index isn’t ready to browse yet.",
    action: "Open Health",
    route: "/health",
  };
}

function MemoryHero({ context }: { context: OverviewResponse["context"] }) {
  const hero = memoryHero(context);
  return (
    <section className={homeStyles.memoryHero} role="region" aria-labelledby="overview-memory-hero-heading">
      <span className={homeStyles.memoryHeroIcon}><Network aria-hidden="true" /></span>
      <div className={homeStyles.memoryHeroCopy}>
        <h2 id="overview-memory-hero-heading">Context</h2>
        <p>{hero.description}</p>
      </div>
      <Button nativeButton={false} render={<Link to={hero.route} />} size="sm">
        {hero.action}
        <ArrowRight aria-hidden="true" data-icon="inline-end" />
      </Button>
    </section>
  );
}

function buildFocusItems(data: OverviewResponse): FocusItemView[] {
  const items: FocusItemView[] = [];
  const focus = data.focus.availability === "available" ? data.focus : null;

  if (
    data.identity.availability === "unavailable"
    || focus?.identity.availability === "unavailable"
    || (focus?.identity.availability === "available" && focus.identity.requiresAttention)
  ) {
    items.push({
      id: "identity",
      title: "Resolve who you’re working as",
      description: actorAttentionDescription(data),
      action: "Review identity",
      route: "/members",
      icon: UserRound,
    });
  }
  if (focus?.relays.availability === "available" && focus.relays.readyToTakeCount > 0) {
    const count = focus.relays.readyToTakeCount;
    items.push({
      id: "relay-ready",
      title: count === 1 ? "Take the handoff waiting for you" : `Choose from ${count} handoffs ready for you`,
      action: "Open handoff",
      route: relayRoute(focus.relays, "ready"),
      icon: RadioTower,
    });
  }
  if (focus?.relays.availability === "available" && focus.relays.inYourHandsCount > 0) {
    const count = focus.relays.inYourHandsCount;
    items.push({
      id: "relay-claimed",
      title: count === 1 ? "Continue the handoff you took" : `Continue ${count} handoffs in your hands`,
      action: "Continue handoff",
      route: relayRoute(focus.relays, "claimed"),
      icon: RadioTower,
    });
  }

  const readiness = contextReadiness(data.context);
  if (readiness.state !== "ready") {
    items.push({
      id: "context",
      title: readiness.state === "preparing" ? "Prepare local project context" : "Review local context health",
      action: "Open Health",
      route: "/health",
      icon: Wrench,
    });
  }

  if (data.operation.availability === "available" && data.operation.latestRelevantFailure !== null) {
    const failure = data.operation.latestRelevantFailure;
    items.push({
      id: `failure-${failure.id}`,
      title: `Review the failed ${sentenceCase(failure.kind)}`,
      description: failure.problem?.detail ?? failure.summary ?? "The latest local context operation needs review.",
      action: "View operation",
      route: `/jobs?job=${encodeURIComponent(failure.id)}`,
      icon: AlertTriangle,
    });
  }
  return items.slice(0, 5);
}

function focusWarnings(data: OverviewResponse): Array<{ label: string; reason: string }> {
  const warnings: Array<{ label: string; reason: string }> = [];
  if (data.focus.availability === "unavailable") {
    warnings.push({ label: "Attention", reason: data.focus.reason });
    if (data.operation.availability === "unavailable") {
      warnings.push({ label: "Local operations", reason: data.operation.reason });
    }
    return warnings;
  }
  if (data.focus.identity.availability === "unavailable") {
    warnings.push({ label: "Identity focus", reason: data.focus.identity.reason });
  }
  if (data.focus.relays.availability === "unavailable") {
    warnings.push({ label: "Relay focus", reason: data.focus.relays.reason });
  }
  if (data.operation.availability === "unavailable") {
    warnings.push({ label: "Local operations", reason: data.operation.reason });
  }
  return warnings;
}

function FocusTechnicalDetails({ data }: { data: OverviewResponse }) {
  const focus = data.focus.availability === "available" ? data.focus : null;
  return (
    <TechnicalDisclosure label="Attention">
      <dl className={homeStyles.technicalFacts}>
        <div><dt>Focus observed</dt><dd>{data.focus.observedAt}</dd></div>
        {data.identity.availability === "available" ? (
          <>
            <div><dt>Identity source</dt><dd>{data.identity.current.source}</dd></div>
            <div>
              <dt>Effective actor</dt>
              <dd><code>{data.identity.current.actor.kind === "member"
                ? data.identity.current.actor.memberId
                : data.identity.current.actor.kind}</code></dd>
            </div>
            <div><dt>Identity diagnostics truncated</dt><dd>{data.identity.current.diagnosticsTruncated ? "Yes" : "No"}</dd></div>
            {data.identity.current.diagnostics.map((diagnostic, index) => (
              <div key={`identity:${diagnostic.code}:${diagnostic.path ?? "none"}:${index}`}>
                <dt>{diagnostic.code}</dt>
                <dd>{diagnostic.path ? <code>{diagnostic.path}</code> : diagnostic.message}</dd>
              </div>
            ))}
          </>
        ) : <div><dt>Identity source</dt><dd>{data.identity.reason}</dd></div>}
        {focus?.relays.availability === "available" ? (
          <>
            <div><dt>Relay revision</dt><dd><code>{focus.relays.deterministicRevision}</code></dd></div>
            <div><dt>Relay source truncated</dt><dd>{focus.relays.sourceTruncated ? "Yes" : "No"}</dd></div>
            <div><dt>Relay diagnostics truncated</dt><dd>{focus.relays.diagnosticsTruncated ? "Yes" : "No"}</dd></div>
            {focus.relays.diagnostics.map((diagnostic, index) => (
              <div key={`relay:${diagnostic.code}:${diagnostic.path ?? "none"}:${index}`}>
                <dt>{diagnostic.code}</dt>
                <dd>{diagnostic.path ? <code>{diagnostic.path}</code> : diagnostic.message}</dd>
              </div>
            ))}
          </>
        ) : null}
        {focus?.relays.availability === "unavailable" ? (
          <>
            <div><dt>Relay source</dt><dd>{focus.relays.reason}</dd></div>
            {focus.relays.deterministicRevision ? (
              <div><dt>Relay revision</dt><dd><code>{focus.relays.deterministicRevision}</code></dd></div>
            ) : null}
            {focus.relays.truncated !== undefined ? (
              <div><dt>Relay corpus truncated</dt><dd>{focus.relays.truncated ? "Yes" : "No"}</dd></div>
            ) : null}
            {focus.relays.sourceTruncated !== undefined ? (
              <div><dt>Relay source truncated</dt><dd>{focus.relays.sourceTruncated ? "Yes" : "No"}</dd></div>
            ) : null}
            {focus.relays.diagnosticsTruncated !== undefined ? (
              <div><dt>Relay diagnostics truncated</dt><dd>{focus.relays.diagnosticsTruncated ? "Yes" : "No"}</dd></div>
            ) : null}
            {focus.relays.diagnostics?.map((diagnostic, index) => (
              <div key={`relay:${diagnostic.code}:${diagnostic.path ?? "none"}:${index}`}>
                <dt>{diagnostic.code}</dt>
                <dd>{diagnostic.path ? <code>{diagnostic.path}</code> : diagnostic.message}</dd>
              </div>
            ))}
          </>
        ) : null}
      </dl>
    </TechnicalDisclosure>
  );
}

function FocusCard({ data, onRetry }: { data: OverviewResponse; onRetry: () => void }) {
  const items = buildFocusItems(data);
  const warnings = focusWarnings(data);
  const primary = items[0];
  const remaining = items.slice(1);
  const PrimaryIcon = primary?.icon;
  return (
    <Card className={homeStyles.focusCard} role="region" aria-labelledby="overview-focus-heading">
      <CardHeader className={homeStyles.panelHeader}>
        <CardTitle><h2 id="overview-focus-heading">Attention</h2></CardTitle>
        <CardAction>
          <Button nativeButton={false} render={<Link to="/relays" />} size="sm" variant="ghost">
            View Relays
            <ArrowRight aria-hidden="true" data-icon="inline-end" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className={homeStyles.focusContent}>
        {primary && PrimaryIcon ? (
          <div className={homeStyles.focalAction}>
            <span className={homeStyles.focalIcon}><PrimaryIcon aria-hidden="true" /></span>
            <div className={homeStyles.focalCopy}>
              <h3>{primary.title}</h3>
              {primary.description ? <span>{primary.description}</span> : null}
            </div>
            <Button nativeButton={false} render={<Link to={primary.route} />} size="sm">
              {primary.action}
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Button>
          </div>
        ) : (
          <Empty className={homeStyles.focusEmpty}>
            <EmptyMedia variant="icon"><CheckCircle2 aria-hidden="true" /></EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>You’re caught up</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to="/knowledge" />} size="sm" variant="outline">
                <Network aria-hidden="true" data-icon="inline-start" />
                Browse shared knowledge
              </Button>
            </EmptyContent>
          </Empty>
        )}

        {remaining.length > 0 ? (
          <>
            <Separator />
            <ItemGroup className={homeStyles.focusQueue}>
              {remaining.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.id} role="listitem">
                    <Item render={<Link to={item.route} />} size="sm">
                      <ItemMedia variant="icon"><Icon aria-hidden="true" /></ItemMedia>
                      <ItemContent>
                        <ItemTitle>{item.title}</ItemTitle>
                        {item.description ? <ItemDescription>{item.description}</ItemDescription> : null}
                      </ItemContent>
                      <ItemActions><ArrowRight aria-hidden="true" /></ItemActions>
                    </Item>
                  </div>
                );
              })}
            </ItemGroup>
          </>
        ) : null}

        {warnings.length > 0 ? (
          <div className={homeStyles.panelWarnings}>
            {warnings.map((warning) => (
              <PanelUnavailable key={warning.label} label={warning.label} onRetry={onRetry} reason={warning.reason} />
            ))}
          </div>
        ) : null}
        <FocusTechnicalDetails data={data} />
      </CardContent>
    </Card>
  );
}

function activityActor(item: ActivityItem): string {
  return item.source === "activity" ? activityActorLabel(item.recordedActor) : "Actor not recorded";
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const context = activityPrimaryContext(item);
  const route = context?.subject ? activitySubjectRoute(context.subject, item) : null;
  const Icon = item.source === "activity" ? Activity : ScrollText;
  return (
    <Item className={homeStyles.activityRow} role="listitem" size="sm">
      <ItemMedia variant="icon"><Icon aria-hidden="true" /></ItemMedia>
      <ItemContent>
        <ItemTitle>
          <span>{activityHeadline(item)}</span>
          {item.source === "legacy" ? (
            <Badge variant={item.action === "risk" ? "destructive" : "outline"}>
              {activityProjectNoteKind(item.action)}
            </Badge>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          <span>{activityActor(item)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={item.timestamp}>{formatDate(item.timestamp)}</time>
        </ItemDescription>
        {context ? route ? (
          <Link className={homeStyles.activityContextLink} to={route}>
            {context.label}
            <ArrowRight aria-hidden="true" data-icon="inline-end" />
          </Link>
        ) : <span className={homeStyles.activityContextPlain}>{context.label}</span> : null}
      </ItemContent>
    </Item>
  );
}

function LatestActivityCard({ activity, onRetry }: { activity: OverviewResponse["activity"]; onRetry: () => void }) {
  return (
    <Card className={homeStyles.activityCard} role="region" aria-labelledby="overview-activity-heading">
      <CardHeader className={homeStyles.panelHeader}>
        <div>
          <CardTitle><h2 id="overview-activity-heading">Latest team memory</h2></CardTitle>
        </div>
        <CardAction>
          <Button nativeButton={false} render={<Link to="/activity" />} size="sm" variant="ghost">
            View Activity
            <ArrowRight aria-hidden="true" data-icon="inline-end" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className={homeStyles.activityContent}>
        {activity.availability === "unavailable" ? (
          <PanelUnavailable label="Latest team memory" onRetry={onRetry} reason={activity.reason} />
        ) : (
          <>
            {activity.items.length === 0 ? (
              <Empty className={homeStyles.activityEmpty}>
                <EmptyMedia variant="icon"><ScrollText aria-hidden="true" /></EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>No team memory yet</EmptyTitle>
                  <EmptyDescription>Recorded team changes, handoffs, and project notes will appear here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup className={homeStyles.activityList}>
                {activity.items.map((item) => <ActivityRow item={item} key={`${item.source}-${item.id}`} />)}
              </ItemGroup>
            )}
            {activity.sourceTruncated || activity.diagnostics.length > 0 || activity.diagnosticsTruncated ? (
              <Alert className={homeStyles.activityWarning}>
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>Some recent history needs attention</AlertTitle>
                <AlertDescription>
                  {activity.diagnostics[0]?.message
                    ?? "The bounded Activity preview could not include every trusted record or diagnostic."}
                </AlertDescription>
              </Alert>
            ) : null}
            <TechnicalDisclosure label="Latest team memory">
              <dl className={homeStyles.technicalFacts}>
                <div><dt>Deterministic revision</dt><dd><code>{activity.deterministicRevision}</code></dd></div>
                <div><dt>Older results available</dt><dd>{activity.hasMore ? "Yes" : "No"}</dd></div>
                <div><dt>Source truncated</dt><dd>{activity.sourceTruncated ? "Yes" : "No"}</dd></div>
                <div><dt>Diagnostics truncated</dt><dd>{activity.diagnosticsTruncated ? "Yes" : "No"}</dd></div>
                {activity.diagnostics.map((diagnostic, index) => (
                  <div key={`${diagnostic.code}:${diagnostic.path ?? "none"}:${index}`}>
                    <dt>{diagnostic.code}</dt>
                    <dd>{diagnostic.path ? <code>{diagnostic.path}</code> : diagnostic.message}</dd>
                  </div>
                ))}
              </dl>
            </TechnicalDisclosure>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ReadinessNode({
  icon: Icon,
  label,
  state,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  state: string;
  detail: string;
}) {
  return (
    <div className={homeStyles.readinessNode} data-state={state}>
      <span><Icon aria-hidden="true" /></span>
      <div>
        <small>{label}</small>
        <strong>{sentenceCase(state)}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function repositoryPoint(
  branch: string | null,
  head: string | null,
  emptyLabel: string,
): string {
  if (head === null) return branch === null ? emptyLabel : `${branch} · ${emptyLabel}`;
  return `${branch ?? "Detached HEAD"} · ${shortRepositoryHead(head)}`;
}

function ContextReadinessCard({
  context,
  repository,
  onRetry,
}: {
  context: OverviewResponse["context"];
  repository: OverviewResponse["shell"]["repository"];
  onRetry: () => void;
}) {
  const readiness = contextReadiness(context);
  const graph = context.availability === "available" && context.graph.availability === "available"
    ? context.graph
    : null;
  const wiki = context.availability === "available" && context.wiki.availability === "available"
    ? context.wiki
    : null;
  const parse = graph ? graphParseComposition(graph.details.parseHealth) : null;
  const parseStyle = parse ? {
    "--parse-ok": `${parse.okPercent}%`,
    "--parse-partial": `${parse.partialPercent}%`,
    "--parse-failed": `${parse.failedPercent}%`,
  } as CSSProperties : undefined;
  const indexedBranch = graph?.details.indexedBranch ?? null;
  const indexedHead = graph?.details.indexedHead ?? null;
  const currentBranch = graph ? graph.details.currentBranch : repository.branch;
  const currentHead = graph ? graph.details.currentHead : repository.head;
  const graphIsStale = graph?.details.indexStatus === "stale";
  const nestedWarnings = context.availability === "available" ? [
    context.graph.availability === "unavailable"
      ? { label: "Code graph context", reason: context.graph.reason, unavailable: true }
      : null,
    context.wiki.availability === "unavailable"
      ? { label: "Knowledge context", reason: context.wiki.reason, unavailable: true }
      : null,
    context.graph.availability === "available"
      && (context.graph.diagnostics.length > 0 || context.graph.diagnosticsTruncated)
      ? {
          label: "Code graph diagnostics",
          reason: context.graph.diagnostics[0]?.message
            ?? "Additional Code graph diagnostics were omitted by the bounded response.",
          unavailable: false,
        }
      : null,
    context.wiki.availability === "available"
      && (context.wiki.diagnostics.length > 0 || context.wiki.diagnosticsTruncated)
      ? {
          label: "Knowledge diagnostics",
          reason: context.wiki.diagnostics[0]?.message
            ?? "Additional Knowledge diagnostics were omitted by the bounded response.",
          unavailable: false,
        }
      : null,
  ].filter((warning): warning is { label: string; reason: string; unavailable: boolean } => warning !== null) : [];

  return (
    <Card className={homeStyles.readinessCard} role="region" aria-labelledby="overview-readiness-heading">
      <CardHeader className={homeStyles.panelHeader}>
        <div>
          <CardTitle><h2 id="overview-readiness-heading">Context readiness</h2></CardTitle>
        </div>
        <CardAction>
          <Badge data-readiness={readiness.state} variant="outline">
            {readiness.state === "ready"
              ? <CheckCircle2 aria-hidden="true" data-icon="inline-start" />
              : <CircleDashed aria-hidden="true" data-icon="inline-start" />}
            {readiness.label}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className={homeStyles.readinessContent}>
        {context.availability === "unavailable" ? (
          <PanelUnavailable label="Context readiness" onRetry={onRetry} reason={context.reason} />
        ) : (
          <>
            <div
              aria-label={`Repository now ${repositoryPoint(currentBranch, currentHead, "has no committed HEAD")}; indexed snapshot ${repositoryPoint(indexedBranch, indexedHead, "not available")}; Knowledge index ${wiki?.details.indexStatus ?? "unavailable"}; Code graph ${graph?.details.indexStatus ?? "unavailable"}${parse ? `; ${parse.accessibleLabel}` : ""}.`}
              className={homeStyles.readinessMap}
              role="img"
            >
              <ReadinessNode
                detail={repositoryPoint(currentBranch, currentHead, "Unborn repository · no committed HEAD")}
                icon={GitBranch}
                label="Repository"
                state={currentHead === null ? "unborn" : currentBranch === null ? "detached" : "observed"}
              />
              <span className={homeStyles.mapConnector} aria-hidden="true" />
              <div className={homeStyles.indexNodes}>
                <ReadinessNode
                  detail={wiki?.summary ?? "Knowledge status could not be read."}
                  icon={BookOpenText}
                  label="Knowledge"
                  state={wiki?.details.indexStatus ?? "unavailable"}
                />
                <ReadinessNode
                  detail={graph?.summary ?? "Code graph status could not be read."}
                  icon={Braces}
                  label="Code graph"
                  state={graph?.details.indexStatus ?? "unavailable"}
                />
              </div>
            </div>

            <dl className={homeStyles.readinessFacts}>
              <div>
                <dt>Repository now</dt>
                <dd>{repositoryPoint(currentBranch, currentHead, "No committed HEAD recorded")}</dd>
              </div>
              <div>
                <dt>Indexed snapshot</dt>
                <dd>{graph ? repositoryPoint(indexedBranch, indexedHead, "No indexed snapshot") : "Unavailable"}</dd>
              </div>
              <div><dt>Knowledge index</dt><dd>{wiki ? sentenceCase(wiki.details.indexStatus) : "Unavailable"}</dd></div>
              <div><dt>Code graph</dt><dd>{graph ? sentenceCase(graph.details.indexStatus) : "Unavailable"}</dd></div>
              <div><dt>Working tree</dt><dd>{repository.dirty ? "Local changes present" : "Clean"}</dd></div>
              <div><dt>Graph observed</dt><dd>{graph ? formatDate(graph.details.observedAt) : "Unavailable"}</dd></div>
              <div>
                <dt>Changes since index</dt>
                <dd>{graph ? graph.details.changes.total : "Unavailable"}</dd>
              </div>
              <div>
                <dt>Parse composition</dt>
                <dd>{graph
                  ? `${graph.details.parseHealth.ok} complete · ${graph.details.parseHealth.partial} partial · ${graph.details.parseHealth.failed} failed`
                  : "Unavailable"}</dd>
              </div>
            </dl>

            {graph && parse ? (
              <div className={homeStyles.parseReadiness}>
                <div>
                  <span>Parse coverage</span>
                  <strong>{graph.details.parseHealth.ok}/{graph.details.parseHealth.total}</strong>
                </div>
                <div aria-label={parse.accessibleLabel} className={homeStyles.parseComposition} role="img" style={parseStyle}>
                  <span data-kind="ok" />
                  <span data-kind="partial" />
                  <span data-kind="failed" />
                </div>
              </div>
            ) : null}

            {graphIsStale ? (
              <Alert className={homeStyles.snapshotNote}>
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>The repository moved beyond this index</AlertTitle>
                <AlertDescription>
                  Parse composition describes the indexed snapshot, not the current working tree. MEX recorded the changed-file count, not their contents.
                </AlertDescription>
              </Alert>
            ) : null}

            {nestedWarnings.length > 0 ? (
              <div className={homeStyles.panelWarnings}>
                {nestedWarnings.map((warning) => (
                  warning.unavailable ? (
                    <PanelUnavailable key={warning.label} label={warning.label} onRetry={onRetry} reason={warning.reason} />
                  ) : (
                    <Alert className={homeStyles.panelAlert} key={warning.label}>
                      <AlertTriangle aria-hidden="true" />
                      <AlertTitle>{warning.label}</AlertTitle>
                      <AlertDescription>{warning.reason}</AlertDescription>
                    </Alert>
                  )
                ))}
              </div>
            ) : null}

            <TechnicalDisclosure label="Context readiness">
              <dl className={homeStyles.technicalFacts}>
                <div><dt>Overview observed</dt><dd>{context.observedAt}</dd></div>
                {graph ? (
                  <>
                    <div><dt>Graph indexed HEAD</dt><dd><code>{graph.details.indexedHead ?? "None"}</code></dd></div>
                    <div><dt>Graph current HEAD</dt><dd><code>{graph.details.currentHead ?? "None"}</code></dd></div>
                    <div><dt>Graph schema</dt><dd>{graph.details.schemaVersion ?? "Unknown"}</dd></div>
                    <div><dt>Graph extractor</dt><dd>{graph.details.extractorVersion ?? "Unknown"}</dd></div>
                    <div><dt>Graph grammar</dt><dd>{graph.details.grammarVersion ?? "Unknown"}</dd></div>
                    <div><dt>Graph diagnostics truncated</dt><dd>{graph.diagnosticsTruncated ? "Yes" : "No"}</dd></div>
                    {graph.diagnostics.map((diagnostic, index) => (
                      <div key={`graph:${diagnostic.code}:${diagnostic.path ?? "none"}:${index}`}>
                        <dt>{diagnostic.code}</dt>
                        <dd>{diagnostic.path ? <code>{diagnostic.path}</code> : diagnostic.message}</dd>
                      </div>
                    ))}
                  </>
                ) : null}
                {wiki ? (
                  <>
                    <div><dt>Knowledge revision</dt><dd><code>{wiki.details.indexedRevision ?? "None"}</code></dd></div>
                    <div><dt>Knowledge schema</dt><dd>{wiki.details.schemaVersion ?? "Unknown"}</dd></div>
                    <div><dt>Knowledge diagnostics truncated</dt><dd>{wiki.diagnosticsTruncated ? "Yes" : "No"}</dd></div>
                    {wiki.diagnostics.map((diagnostic, index) => (
                      <div key={`wiki:${diagnostic.code}:${diagnostic.path ?? "none"}:${index}`}>
                        <dt>{diagnostic.code}</dt>
                        <dd>{diagnostic.path ? <code>{diagnostic.path}</code> : diagnostic.message}</dd>
                      </div>
                    ))}
                  </>
                ) : null}
              </dl>
            </TechnicalDisclosure>

            <Button className={homeStyles.healthLink} nativeButton={false} render={<Link to="/health" />} size="sm" variant="ghost">
              Open full Health details
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function OperationCard({ operation }: { operation: OverviewResponse["operation"] }) {
  if (operation.availability === "unavailable") return null;
  const job = operation.active ?? operation.latestRelevantFailure;
  if (job === null) return null;
  const isActive = operation.active !== null;
  const graph = job.kind === "graph_refresh" || job.kind === "graph_rebuild";
  const percent = job.progress?.total === undefined || (graph && job.phase !== "parse")
    ? null
    : Math.round((job.progress.completed / job.progress.total) * 100);
  return (
    <Card className={homeStyles.operationCard} role="region" aria-labelledby="overview-operation-heading">
      <CardHeader className={homeStyles.panelHeader}>
        <div>
          <CardTitle><h2 id="overview-operation-heading">{isActive ? "Active operation" : "Operation needs attention"}</h2></CardTitle>
        </div>
        {job ? <CardAction><StatusPill tone={stateTone(job.state)}>{sentenceCase(job.state)}</StatusPill></CardAction> : null}
      </CardHeader>
      <CardContent className={homeStyles.operationContent}>
        {job ? (
          <>
            <div className={homeStyles.operationIdentity}>
              <span>{isActive
                ? <LoaderCircle aria-hidden="true" className={homeStyles.activeOperationIcon} />
                : <AlertTriangle aria-hidden="true" />}</span>
              <div>
                <h3>{sentenceCase(job.kind)}</h3>
                {job.summary || !isActive ? (
                  <p>{job.summary ?? `The latest ${sentenceCase(job.kind).toLowerCase()} did not finish successfully.`}</p>
                ) : null}
              </div>
            </div>
            <Progress value={percent}>
              <ProgressLabel>{sentenceCase(job.kind)} · {sentenceCase(job.phase)}</ProgressLabel>
              <ProgressValue>
                {() => graph && job.progress
                  ? `${job.progress.completed}${job.progress.total === undefined ? "" : ` / ${job.progress.total}`} files parsed`
                  : percent !== null
                  ? `${job.progress!.completed} / ${job.progress!.total}`
                  : job.progress ? `${job.progress.completed} completed` : "In progress"}
              </ProgressValue>
            </Progress>
            <div className={homeStyles.operationMeta}>
              <time dateTime={job.startedAt ?? job.createdAt}>Started {formatDate(job.startedAt ?? job.createdAt)}</time>
              <Button nativeButton={false} render={<Link to={`/jobs?job=${encodeURIComponent(job.id)}`} />} size="sm" variant="ghost">
                View operation
                <ArrowRight aria-hidden="true" data-icon="inline-end" />
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PanelSkeleton({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <Card aria-label={`Loading ${label}`} className={compact ? homeStyles.skeletonCompact : undefined} role="status">
      <CardHeader>
        <Skeleton className={homeStyles.skeletonEyebrow} />
        <Skeleton className={homeStyles.skeletonTitle} />
      </CardHeader>
      <CardContent className={homeStyles.skeletonContent}>
        <Skeleton className={homeStyles.skeletonLineWide} />
        <Skeleton className={homeStyles.skeletonLine} />
        <Skeleton className={homeStyles.skeletonBlock} />
      </CardContent>
    </Card>
  );
}

function OverviewLoading({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className={homeStyles.page}>
      <HomeHeader onRefresh={onRefresh} refreshing={false} />
      <p className="sr-only" role="status">Loading project overview</p>
      <PanelSkeleton label="Context" />
      <div className={homeStyles.atlasGrid}>
        <div className={homeStyles.primaryColumn}>
          <PanelSkeleton label="Attention" />
          <PanelSkeleton label="Context readiness" />
          <PanelSkeleton compact label="Active operation" />
        </div>
        <PanelSkeleton label="Latest team memory" />
      </div>
    </div>
  );
}

export function HomeOverview() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState("");
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.getOverview(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshStatus("");
    try {
      await Promise.all([
        queryClient.resetQueries({ queryKey: ["overview"] }, { throwOnError: true }),
        ...REFRESH_QUERY_KEYS
          .filter((queryKey) => queryKey[0] !== "overview")
          .map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ]);
      setRefreshStatus("Overview refreshed.");
    } catch {
      setRefreshStatus("Overview could not be refreshed. Try again.");
    } finally {
      setRefreshing(false);
    }
  };

  if (overview.isPending) return <OverviewLoading onRefresh={() => void refresh()} />;

  if (overview.isError) {
    return (
      <div className={homeStyles.page}>
        <HomeHeader onRefresh={() => void refresh()} refreshing={refreshing} />
        <ErrorState error={overview.error} retry={() => void refresh()} />
      </div>
    );
  }

  const data = overview.data;
  return (
    <div className={homeStyles.page} data-overview-workbench="ready">
      <HomeHeader data={data} onRefresh={() => void refresh()} refreshing={refreshing} />
      <div className={homeStyles.liveStatus} aria-live="polite" role="status">{refreshStatus}</div>
      <MemoryHero context={data.context} />
      <div className={homeStyles.atlasGrid}>
        <div className={homeStyles.primaryColumn}>
          <FocusCard data={data} onRetry={() => void refresh()} />
          <ContextReadinessCard context={data.context} onRetry={() => void refresh()} repository={data.shell.repository} />
        </div>
        <div className={homeStyles.asideColumn}>
          <LatestActivityCard activity={data.activity} onRetry={() => void refresh()} />
          <TeamAccessCard />
        </div>
        <OperationCard operation={data.operation} />
      </div>
    </div>
  );
}
