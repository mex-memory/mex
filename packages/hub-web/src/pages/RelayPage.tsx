import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  FilePenLine,
  GitBranch,
  GitCommitHorizontal,
  Handshake,
  Inbox,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  TriangleAlert,
  UserCheck,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { RelayDraftIdSchema, RelayIdSchema } from "@mex/hub-contracts/relay";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import { strictRelayPreviewEnvelope } from "../api/relay-client";
import type { RelayReviewSource } from "./RelayMutationDialog";
import type {
  CapabilitiesResponse,
  CapabilityStatus,
  RelayDetail,
  RelayDraftDetail,
  RelayDraftSummary,
  RelayListRequest,
  RelayOperationApplyResponse,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
  RelayState,
  RelaySummary,
  TeamActorRef,
  TeamMember,
  Tone,
} from "../api/types";
import type { InboxOverflowAction } from "./InboxOverflowMenu";
import { Badge } from "../components/primitives/badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/primitives/alert";
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
import { Skeleton } from "../components/primitives/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/primitives/tabs";
import {
  ErrorState,
  formatDate,
  PageHeader,
  StatePanel,
  StatusPill,
} from "../components/ui";
import { boundedNextCursor, MAX_WORKBENCH_PAGES } from "../lib/bounds";
import styles from "../styles/relay.module.css";

const PAGE_SIZE = 25;
const OPEN_STATES: readonly RelayState[] = ["published", "acknowledged"];
const RelayOverflowMenu = lazy(() => import("./InboxOverflowMenu"));
const RelayDraftComposer = lazy(() => import("./RelayDraftComposer"));
const RelayDetailSections = lazy(() => import("./RelayDetailSections"));
const RelayMutationDialog = lazy(() => import("./RelayMutationDialog"));

type RelayView = "mine" | "sent" | "all" | "drafts";
type RelayLifecycleView = "open" | "closed";
type RelayGitNotice = "publish" | "acknowledge" | "close";
type PreviewAcceptance = "accepted" | "stale" | "mismatched";

function canonicalRequestJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalRequestJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalRequestJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalRelaySet<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => {
    const leftKey = canonicalRequestJson(left);
    const rightKey = canonicalRequestJson(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function canonicalRelayRequest(request: RelayOperationPreviewRequest): RelayOperationPreviewRequest {
  if (request.action.kind !== "relay.draft.save") return request;
  return {
    ...request,
    action: {
      ...request.action,
      draft: {
        ...request.action.draft,
        recipients: canonicalRelaySet(request.action.draft.recipients),
        decisions: canonicalRelaySet(request.action.draft.decisions),
        changedFiles: canonicalRelaySet(request.action.draft.changedFiles),
        code: canonicalRelaySet(request.action.draft.code),
      },
    },
  };
}

function previewAcceptance(
  currentAttempt: number,
  expectedAttempt: number,
  expectedRequest: RelayOperationPreviewRequest,
  envelope: RelayOperationPreviewResponse,
): PreviewAcceptance {
  if (currentAttempt !== expectedAttempt) return "stale";
  const strictEnvelope = strictRelayPreviewEnvelope(envelope);
  if (!strictEnvelope) return "mismatched";
  if (strictEnvelope.request.operationId !== expectedRequest.operationId
    || canonicalRequestJson(canonicalRelayRequest(strictEnvelope.request))
      !== canonicalRequestJson(canonicalRelayRequest(expectedRequest))) {
    return "mismatched";
  }
  return "accepted";
}

function operationId(label: string): string {
  return `hub_relay_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function actorLabel(actor: TeamActorRef | null | undefined): string {
  if (actor?.kind === "member") return actor.displayName ?? "Team member";
  if (actor?.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown identity";
}

function relayTone(state: RelayState): Tone {
  if (state === "published") return "info";
  if (state === "acknowledged") return "warning";
  return "success";
}

function viewRequest(
  view: Exclude<RelayView, "drafts">,
  lifecycle: RelayLifecycleView,
): Omit<RelayListRequest, "cursor" | "limit"> {
  return {
    perspective: view,
    states: lifecycle === "open" ? [...OPEN_STATES] : ["closed"],
  };
}

function relayViewParam(value: string | null): RelayView | null {
  return value === "mine" || value === "sent" || value === "all" || value === "drafts"
    ? value
    : null;
}

function relayLifecycleParam(value: string | null): RelayLifecycleView {
  return value === "closed" ? "closed" : "open";
}

function relayMatchesView(
  relay: RelayDetail,
  view: Exclude<RelayView, "drafts">,
  lifecycle: RelayLifecycleView,
  currentMemberId: string | null,
): boolean {
  const lifecycleMatches = lifecycle === "open"
    ? relay.state === "published" || relay.state === "acknowledged"
    : relay.state === "closed";
  if (!lifecycleMatches) return false;
  if (view === "all") return true;
  if (currentMemberId === null) return false;
  if (view === "sent") {
    return relay.sender.kind === "member" && relay.sender.memberId === currentMemberId;
  }
  return relay.state === "published"
    ? relay.audience === "team" || relay.recipients.some((recipient) => (
        recipient.kind === "member" && recipient.memberId === currentMemberId
      ))
    : relay.acknowledgedBy?.kind === "member"
      && relay.acknowledgedBy.memberId === currentMemberId;
}

function relayStateLabel(
  relay: RelaySummary | RelayDetail,
  view: Exclude<RelayView, "drafts">,
  currentMemberId: string | null,
): string {
  if (relay.state === "closed") return "Closed";
  if (relay.state === "published") return view === "mine" ? "Ready to take" : "Waiting for pickup";
  if (view === "mine" && relay.acknowledgedBy?.kind === "member"
    && relay.acknowledgedBy.memberId === currentMemberId) {
    return "In your hands";
  }
  return `Taken by ${actorLabel(relay.acknowledgedBy)}`;
}

function relayRelevantTime(relay: RelaySummary | RelayDetail): string | null {
  const value = relay.state === "closed"
    ? relay.closedAt
    : relay.state === "acknowledged"
      ? relay.acknowledgedAt
      : relay.publishedAt;
  return value === null ? null : formatDate(value);
}

function relayRepositoryLabel(relay: RelaySummary | RelayDetail): string | null {
  const state = relay.publishedRepoState;
  if (state === null) return null;
  const branch = state.branch ?? "Detached HEAD";
  const head = state.head === null ? "No committed HEAD" : state.head.slice(0, 8);
  return `${branch} · ${head}`;
}

function artifactExpectation(path: string, revision: string) {
  return { target: { kind: "artifact" as const, path }, revision };
}

function draftExpectation(draft: RelayDraftDetail) {
  return {
    target: { kind: "local" as const, namespace: "relay-draft" as const, id: draft.id },
    revision: draft.revision,
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof HubApiError
    && (error.problem.status === 404 || error.problem.code === "NOT_FOUND");
}

function RelayWarnings({
  diagnostics,
  truncated = false,
  sourceTruncated = false,
}: {
  diagnostics: readonly { code: string; message: string }[];
  truncated?: boolean;
  sourceTruncated?: boolean;
}) {
  const uniqueDiagnostics = [...new Map(
    diagnostics.map((diagnostic) => [`${diagnostic.code}\0${diagnostic.message}`, diagnostic]),
  ).values()];
  if (uniqueDiagnostics.length === 0 && !truncated && !sourceTruncated) return null;
  return (
    <div className={styles.warning} role="status">
      <TriangleAlert aria-hidden="true" />
      <div>
        <strong>Relay compatibility warning</strong>
        {uniqueDiagnostics.map((diagnostic) => (
          <p key={`${diagnostic.code}:${diagnostic.message}`}>{diagnostic.message}</p>
        ))}
        {truncated ? <p>Additional bounded Relay diagnostics were omitted.</p> : null}
        {sourceTruncated ? <p>Relay results were bounded because the canonical source exceeded its safe read limit.</p> : null}
      </div>
    </div>
  );
}

function RelayQueueSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className={styles.queueSkeleton} aria-label="Loading handoffs">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index}>
          <Skeleton className={styles.skeletonIcon} />
          <span>
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonMeta} />
            <Skeleton className={styles.skeletonMetaShort} />
          </span>
        </div>
      ))}
    </div>
  );
}

interface RelayQueueGroup {
  key: string;
  title: string;
  rows: RelaySummary[];
}

function relayQueueGroups(
  rows: RelaySummary[],
  view: Exclude<RelayView, "drafts">,
  lifecycle: RelayLifecycleView,
): RelayQueueGroup[] {
  if (view === "mine" && lifecycle === "open") {
    return [
      { key: "ready", title: "Ready to take", rows: rows.filter((relay) => relay.state === "published") },
      { key: "claimed", title: "In your hands", rows: rows.filter((relay) => relay.state === "acknowledged") },
    ].filter((group) => group.rows.length > 0);
  }
  return [{
    key: `${view}-${lifecycle}`,
    title: view === "sent" ? "Sent handoffs" : view === "all" ? "Team handoffs" : "Your handoffs",
    rows,
  }];
}

function relayQueueDescription(
  relay: RelaySummary,
  view: Exclude<RelayView, "drafts">,
): string {
  if (view === "mine") return `From ${actorLabel(relay.sender)}`;
  if (view === "sent") {
    return relay.state === "published"
      ? relay.audience === "team" ? "Open to team" : `For ${relay.recipients.map(actorLabel).join(", ")}`
      : `Claimed by ${actorLabel(relay.acknowledgedBy)}`;
  }
  return relay.state === "published"
    ? `From ${actorLabel(relay.sender)}`
    : `Claimed by ${actorLabel(relay.acknowledgedBy)}`;
}

function RelayQueue({
  currentMemberId,
  error,
  hasNextPage,
  isFetchingNextPage,
  isPending,
  lifecycle,
  onLoadMore,
  onSelect,
  rows,
  selectedId,
  sourceBounded,
  view,
}: {
  currentMemberId: string | null;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  lifecycle: RelayLifecycleView;
  onLoadMore(): void;
  onSelect(id: string): void;
  rows: RelaySummary[];
  selectedId: string | null;
  sourceBounded: boolean;
  view: Exclude<RelayView, "drafts">;
}) {
  const groups = relayQueueGroups(rows, view, lifecycle);
  const emptyTitle = view === "mine"
    ? lifecycle === "open" ? "No handoffs need your attention" : "No closed handoffs for you"
    : view === "sent"
      ? lifecycle === "open" ? "No sent handoffs are open" : "No sent handoffs are closed"
      : lifecycle === "open" ? "No open team handoffs" : "No closed team handoffs";
  return (
    <Card className={styles.queuePane} role="region" aria-labelledby="relay-queue-heading">
      <CardHeader className={styles.queuePaneHeader}>
        <div>
          <CardTitle><h2 id="relay-queue-heading">Handoffs</h2></CardTitle>
          <CardDescription>Select a handoff to continue with its context and next steps.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className={styles.queuePaneContent}>
        {isPending ? (
          <RelayQueueSkeleton />
        ) : error && rows.length === 0 ? (
          <ErrorState error={error} />
        ) : rows.length === 0 ? (
          <Empty className={styles.emptyQueue}>
            <EmptyHeader>
              <EmptyMedia variant="icon"><Inbox aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
              <EmptyDescription>{lifecycle === "open" ? "There is nothing in this handoff queue right now." : "Closed handoffs will appear here when available."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {groups.map((group) => (
              <section className={styles.queueGroup} aria-labelledby={`relay-group-${group.key}`} key={group.key}>
                <h3 id={`relay-group-${group.key}`}>{group.title}</h3>
                <ItemGroup className={styles.queueItems}>
                  {group.rows.map((relay) => {
                    const time = relayRelevantTime(relay);
                    return (
                      <div key={relay.ref.id} role="listitem">
                        <Item
                          aria-current={selectedId === relay.ref.id ? "true" : undefined}
                          className={styles.queueItem}
                          data-relay-id={relay.ref.id}
                          data-selected={selectedId === relay.ref.id ? "true" : undefined}
                          onClick={() => onSelect(relay.ref.id)}
                          render={<button type="button" />}
                          size="sm"
                          variant="default"
                        >
                          <ItemMedia className={styles.queueItemIcon} variant="icon"><Handshake aria-hidden="true" /></ItemMedia>
                          <ItemContent>
                            <ItemTitle>{relay.summary}</ItemTitle>
                            <ItemDescription>
                              {relayQueueDescription(relay, view)}{time ? ` · ${time}` : ""}
                              {relayRepositoryLabel(relay) ? ` · ${relayRepositoryLabel(relay)}` : ""}
                            </ItemDescription>
                          </ItemContent>
                          <ItemActions>
                            <Badge className={styles.queueStateBadge} variant={relay.state === "closed" ? "outline" : "secondary"}>
                              {relayStateLabel(relay, view, currentMemberId)}
                            </Badge>
                            <ChevronRight aria-hidden="true" />
                          </ItemActions>
                        </Item>
                      </div>
                    );
                  })}
                </ItemGroup>
              </section>
            ))}
            {error ? <div className={styles.paginationError}><ErrorState error={error} /></div> : null}
            {hasNextPage ? (
              <Button disabled={isFetchingNextPage} onClick={onLoadMore} size="sm" type="button" variant="outline">
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : sourceBounded ? <p className={styles.boundNote}>The bounded handoff list limit was reached.</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DraftOverflowActions({
  capability,
  onDelete,
}: {
  capability: CapabilityStatus;
  onDelete(trigger: HTMLButtonElement): void;
}) {
  const [activated, setActivated] = useState(false);
  const [focusFirstItem, setFocusFirstItem] = useState(false);
  const triggerContent: ReactNode = <><MoreHorizontal data-icon="inline-start" /> More</>;
  const actions: InboxOverflowAction[] = [{
    capability,
    label: "Delete draft",
    onSelect: onDelete,
    variant: "destructive",
  }];
  if (!activated) {
    return (
      <Button
        aria-haspopup="menu"
        aria-label="More draft actions"
        onClick={(event) => {
          setFocusFirstItem(event.detail === 0);
          setActivated(true);
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        {triggerContent}
      </Button>
    );
  }
  return (
    <Suspense fallback={<Button aria-label="More draft actions" disabled size="sm" type="button" variant="outline">{triggerContent}</Button>}>
      <RelayOverflowMenu
        actions={actions}
        ariaLabel="More draft actions"
        focusFirstItem={focusFirstItem}
        groupLabel="Draft actions"
        triggerContent={triggerContent}
      />
    </Suspense>
  );
}

function RelayDraftQueue({
  canCreate,
  createUnavailableReason,
  error,
  hasNextPage,
  isFetchingNextPage,
  isPending,
  onCreate,
  onLoadMore,
  onSelect,
  rows,
  selectedId,
  sourceBounded,
}: {
  canCreate: boolean;
  createUnavailableReason?: string;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  onCreate(event: MouseEvent<HTMLButtonElement>): void;
  onLoadMore(): void;
  onSelect(id: string): void;
  rows: RelayDraftSummary[];
  selectedId: string | null;
  sourceBounded: boolean;
}) {
  return (
    <Card className={styles.queuePane} role="region" aria-labelledby="relay-draft-queue-heading">
      <CardHeader className={styles.queuePaneHeader}>
        <div>
          <CardTitle><h2 id="relay-draft-queue-heading">On this device</h2></CardTitle>
          <CardDescription>Private handoff drafts in this checkout.</CardDescription>
        </div>
        {rows.length > 0 || isPending || error !== null ? (
          <CardAction>
            <Button disabled={!canCreate} onClick={onCreate} size="sm" type="button" variant="ghost">
              <Plus data-icon="inline-start" /> Create manually
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className={styles.queuePaneContent}>
        {!canCreate && createUnavailableReason ? <p className={styles.recovery} role="status">{createUnavailableReason}</p> : null}
        {isPending ? (
          <RelayQueueSkeleton rows={3} />
        ) : error && rows.length === 0 ? (
          <ErrorState error={error} />
        ) : rows.length === 0 ? (
          <Empty className={styles.emptyQueue}>
            <EmptyHeader>
              <EmptyMedia variant="icon"><FilePenLine aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>No handoff drafts on this device</EmptyTitle>
              <EmptyDescription>Your coding agent can prepare a structured Relay when you pause or hand work to a teammate.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button disabled={!canCreate} onClick={onCreate} size="sm" type="button" variant="ghost">
                <Plus data-icon="inline-start" /> Create manually
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <ItemGroup className={styles.queueItems}>
              {rows.map((draft) => (
                <div key={draft.id} role="listitem">
                  <Item
                    aria-current={selectedId === draft.id ? "true" : undefined}
                    className={styles.queueItem}
                    data-relay-draft-id={draft.id}
                    data-selected={selectedId === draft.id ? "true" : undefined}
                    onClick={() => onSelect(draft.id)}
                    render={<button type="button" />}
                    size="sm"
                    variant="default"
                  >
                    <ItemMedia className={styles.queueItemIcon} variant="icon"><FilePenLine aria-hidden="true" /></ItemMedia>
                    <ItemContent>
                      <ItemTitle>{draft.summary}</ItemTitle>
                      <ItemDescription>Private draft · {formatDate(draft.updatedAt)}</ItemDescription>
                    </ItemContent>
                    <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
                  </Item>
                </div>
              ))}
            </ItemGroup>
            {error ? <div className={styles.paginationError}><ErrorState error={error} /></div> : null}
            {hasNextPage ? (
              <Button disabled={isFetchingNextPage} onClick={onLoadMore} size="sm" type="button" variant="outline">
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : sourceBounded ? <p className={styles.boundNote}>The bounded draft list limit was reached.</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function RelayPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{
    capabilities?: CapabilitiesResponse;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [membersRequested, setMembersRequested] = useState(false);
  const [composer, setComposer] = useState<RelayDraftDetail | null | undefined>(undefined);
  const [review, setReview] = useState<RelayReviewSource | null>(null);
  const [preparingPublish, setPreparingPublish] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [gitNotice, setGitNotice] = useState<RelayGitNotice | null>(null);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [selectNextAfterClose, setSelectNextAfterClose] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const gitNoticeRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const readAvailable = capabilities?.relays.read.availability === "available";
  const canDraft = capabilities?.relays.draftMutation.availability === "available";
  const lifecycleAvailable = capabilities?.relays.lifecycleMutation.availability === "available";

  const actor = useQuery({ queryKey: ["actor", "current"], queryFn: () => api.getCurrentActor(), enabled: readAvailable, retry: false });
  const trustedActor = actor.isError ? undefined : actor.data;
  const currentMemberId = trustedActor?.actor.kind === "member" ? trustedActor.actor.memberId : null;
  const currentMemberActive = currentMemberId !== null;
  const viewParam = searchParams.get("view");
  const explicitView = relayViewParam(viewParam);
  const viewReady = explicitView !== null || !actor.isPending;
  const view: RelayView = explicitView ?? (currentMemberActive ? "mine" : "all");
  const visibleView: RelayView = viewReady ? view : "mine";
  const lifecycle = relayLifecycleParam(searchParams.get("state"));
  const canonicalView = view === "drafts" ? null : view;
  const relayParam = canonicalView === null ? null : searchParams.get("relay");
  const draftParam = view === "drafts" ? searchParams.get("draft") : null;
  const parsedRelay = relayParam === null ? null : RelayIdSchema.safeParse(relayParam);
  const parsedDraft = draftParam === null ? null : RelayDraftIdSchema.safeParse(draftParam);
  const relayId = parsedRelay?.success ? parsedRelay.data : null;
  const draftId = parsedDraft?.success ? parsedDraft.data : null;
  const invalidRelaySelection = relayParam !== null && parsedRelay?.success === false;
  const invalidDraftSelection = draftParam !== null && parsedDraft?.success === false;
  const searchKey = searchParams.toString();

  useEffect(() => {
    if (!readAvailable || actor.isPending) return;
    const invalidView = viewParam !== null && explicitView === null;
    const missingView = viewParam === null;
    const invalidState = canonicalView !== null
      && searchParams.get("state") !== null
      && searchParams.get("state") !== "open"
      && searchParams.get("state") !== "closed";
    const missingState = canonicalView !== null && searchParams.get("state") === null;
    const crossModeParams = view === "drafts"
      ? searchParams.has("state") || searchParams.has("relay")
      : searchParams.has("draft");
    if (!invalidView && !missingView && !invalidState && !missingState && !crossModeParams) return;
    const next = new URLSearchParams(searchKey);
    next.set("view", view);
    if (view === "drafts") {
      next.delete("state");
      next.delete("relay");
    } else {
      next.set("state", lifecycle);
      next.delete("draft");
    }
    setSearchParams(next, { replace: true });
  }, [
    actor.isPending,
    canonicalView,
    explicitView,
    lifecycle,
    readAvailable,
    searchKey,
    searchParams,
    setSearchParams,
    view,
    viewParam,
  ]);

  const members = useInfiniteQuery({
    queryKey: ["members", "relay", "active"],
    queryFn: ({ pageParam }) => api.getMembers({ active: true, limit: 100, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: Boolean(readAvailable && composer !== undefined && membersRequested),
    retry: false,
  });
  const memberPageCount = members.data?.pages.length ?? 0;
  useEffect(() => {
    if (composer !== undefined && membersRequested && members.hasNextPage && !members.isFetchingNextPage && memberPageCount < MAX_WORKBENCH_PAGES) {
      void members.fetchNextPage();
    }
  }, [composer, membersRequested, memberPageCount, members.fetchNextPage, members.hasNextPage, members.isFetchingNextPage]);
  const activeMembers = useMemo(() => {
    const items = new Map<string, TeamMember>();
    for (const page of members.data?.pages ?? []) for (const member of page.items) items.set(member.id, member);
    return [...items.values()];
  }, [members.data?.pages]);
  const drafts = useInfiniteQuery({
    queryKey: ["relays", "drafts"],
    queryFn: ({ pageParam }) => api.getRelayDrafts({ limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: Boolean(readAvailable && viewReady && view === "drafts"),
    retry: false,
  });
  const request = viewRequest(canonicalView ?? "all", lifecycle);
  const relays = useInfiniteQuery({
    queryKey: ["relays", "canonical", request.perspective, lifecycle, currentMemberId],
    queryFn: ({ pageParam }) => api.getRelays({ ...request, limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: Boolean(
      readAvailable
      && viewReady
      && canonicalView !== null
      && (canonicalView === "all" || currentMemberActive),
    ),
    retry: false,
  });
  const draftRows = useMemo(() => {
    const rows = new Map<string, RelayDraftSummary>();
    for (const page of drafts.data?.pages ?? []) for (const item of page.items) rows.set(item.id, item);
    return [...rows.values()];
  }, [drafts.data?.pages]);
  const relayRows = useMemo(() => {
    const rows = new Map<string, RelaySummary>();
    for (const page of relays.data?.pages ?? []) for (const item of page.items) rows.set(item.ref.id, item);
    return [...rows.values()];
  }, [relays.data?.pages]);
  useEffect(() => {
    if (!selectNextAfterClose || canonicalView === null || lifecycle !== "open" || relays.isPending || relays.isFetching) return;
    const next = new URLSearchParams(searchKey);
    next.set("view", canonicalView);
    next.set("state", lifecycle);
    if (relays.isError) {
      next.delete("relay");
      setSelectionNotice("The open handoff queue could not be refreshed. Try again before choosing what to open next.");
    } else if (relayRows[0]) next.set("relay", relayRows[0].ref.id);
    else next.delete("relay");
    next.delete("draft");
    setSelectNextAfterClose(false);
    setSearchParams(next, { replace: true });
  }, [canonicalView, lifecycle, relayRows, relays.isError, relays.isFetching, relays.isPending, searchKey, selectNextAfterClose, setSearchParams]);

  const draftDetail = useQuery({
    queryKey: ["relays", "draft", draftId],
    queryFn: () => api.getRelayDraft(draftId!),
    enabled: Boolean(readAvailable && view === "drafts" && draftId),
    retry: false,
  });
  const relayDetail = useQuery({
    queryKey: ["relays", "relay", relayId],
    queryFn: () => api.getRelay(relayId!),
    enabled: Boolean(readAvailable && canonicalView !== null && relayId),
    retry: false,
  });
  const selectedRelay = relayDetail.data;
  const senderMemberId = selectedRelay?.sender.kind === "member" ? selectedRelay.sender.memberId : null;
  const ownerMemberId = selectedRelay?.acknowledgedBy?.kind === "member" ? selectedRelay.acknowledgedBy.memberId : null;
  const currentIsSender = currentMemberId !== null && senderMemberId === currentMemberId;
  const currentIsClaimant = currentMemberId !== null && ownerMemberId === currentMemberId;
  const currentCanCloseByRole = currentIsSender || currentIsClaimant;
  const lifecycleDependencies = useQuery({
    queryKey: ["relays", "lifecycle-principals", selectedRelay?.ref.id, selectedRelay?.revision, senderMemberId, ownerMemberId],
    queryFn: async () => {
      const ids = [...new Set([senderMemberId, ownerMemberId].filter((id): id is string => id !== null))];
      return Promise.all(ids.map((id) => api.getMember(id)));
    },
    enabled: Boolean(
      readAvailable
      && lifecycleAvailable
      && selectedRelay?.state === "acknowledged"
      && senderMemberId
      && ownerMemberId
      && currentCanCloseByRole,
    ),
    retry: false,
  });

  const relaySelectionMismatch = Boolean(
    relayDetail.data
    && canonicalView !== null
    && (canonicalView === "all" || !actor.isPending)
    && !relayMatchesView(relayDetail.data, canonicalView, lifecycle, currentMemberId),
  );

  const clearSelection = (replace = true) => {
    const next = new URLSearchParams(searchParams);
    if (view === "drafts") next.delete("draft");
    else next.delete("relay");
    setSearchParams(next, { replace });
  };
  const selectView = (nextValue: string) => {
    const nextView = relayViewParam(nextValue);
    if (nextView === null) return;
    const next = new URLSearchParams(searchParams);
    next.set("view", nextView);
    next.delete("relay");
    next.delete("draft");
    if (nextView === "drafts") next.delete("state");
    else next.set("state", lifecycle);
    setSelectionNotice("");
    setSearchParams(next);
  };
  const selectLifecycle = (nextLifecycle: RelayLifecycleView) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", canonicalView ?? "all");
    next.set("state", nextLifecycle);
    next.delete("relay");
    next.delete("draft");
    setSelectionNotice("");
    setSearchParams(next);
  };
  const selectRelay = (id: string) => {
    if (canonicalView === null) return;
    const next = new URLSearchParams(searchParams);
    next.set("view", canonicalView);
    next.set("state", lifecycle);
    next.set("relay", id);
    next.delete("draft");
    setSelectionNotice("");
    setSearchParams(next);
  };
  const selectDraft = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", "drafts");
    next.set("draft", id);
    next.delete("relay");
    next.delete("state");
    setSelectionNotice("");
    setSearchParams(next);
  };
  const refreshRelays = async () => {
    setRefreshing(true);
    setSelectionNotice("");
    try {
      await Promise.all([
        queryClient.resetQueries({ queryKey: ["relays"] }),
        queryClient.invalidateQueries({ queryKey: ["actor", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["member"] }),
        queryClient.invalidateQueries({ queryKey: ["members"] }),
        queryClient.invalidateQueries({ queryKey: ["relays", "lifecycle-principals"] }),
        queryClient.invalidateQueries({ queryKey: ["home"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      setRefreshGeneration((generation) => generation + 1);
      setStatus("Relays refreshed.");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (refreshGeneration === 0) return;
    const disappeared = view === "drafts"
      ? draftId !== null && isNotFound(draftDetail.error)
      : relayId !== null && (isNotFound(relayDetail.error) || relaySelectionMismatch);
    if (!disappeared) return;
    const next = new URLSearchParams(searchKey);
    next.delete(view === "drafts" ? "draft" : "relay");
    setSearchParams(next, { replace: true });
    setSelectionNotice(view === "drafts"
      ? "That handoff draft is no longer on this device. Choose another draft."
      : "That handoff is no longer in this queue. Choose another handoff.");
  }, [
    draftDetail.error,
    draftId,
    refreshGeneration,
    relayDetail.error,
    relayId,
    relaySelectionMismatch,
    searchKey,
    setSearchParams,
    view,
  ]);

  const rememberTrigger = (element: HTMLButtonElement) => { trigger.current = element; };
  const openComposer = (draft: RelayDraftDetail | null, event: MouseEvent<HTMLButtonElement>) => { rememberTrigger(event.currentTarget); setMembersRequested(draft !== null && draft.input.audience !== "team"); setComposer(draft); };
  const startReview = (source: RelayReviewSource, element: HTMLButtonElement) => { rememberTrigger(element); setReview(source); };
  const onApplied = async (result: RelayOperationApplyResponse) => {
    const appliedKind = review?.kind ?? "save";
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["relays"] }),
      queryClient.invalidateQueries({ queryKey: ["home"] }),
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["activity"] }),
    ]);
    const next = new URLSearchParams(searchParams);
    if (appliedKind === "publish") {
      const publishedId = result.relays[0]?.ref.id;
      next.set("view", "sent");
      next.set("state", "open");
      next.delete("draft");
      if (publishedId) next.set("relay", publishedId);
      else next.delete("relay");
    } else if (appliedKind === "acknowledge") {
      const claimedId = result.relays[0]?.ref.id ?? relayId;
      next.set("view", "mine");
      next.set("state", "open");
      next.delete("draft");
      if (claimedId) next.set("relay", claimedId);
    } else if (appliedKind === "close") {
      next.set("view", canonicalView ?? "mine");
      next.set("state", "open");
      next.delete("relay");
      next.delete("draft");
      setSelectNextAfterClose(true);
    } else if (appliedKind === "delete") {
      next.delete("draft");
    } else {
      const savedId = result.localChanges.find((change) => change.namespace === "relay-draft" && change.afterRevision !== null)?.id;
      if (savedId) { next.set("view", "drafts"); next.set("draft", savedId); next.delete("relay"); }
    }
    setSearchParams(next, { replace: true });
    const canonicalNotice = appliedKind === "publish" || appliedKind === "acknowledge" || appliedKind === "close"
      ? appliedKind
      : null;
    flushSync(() => {
      setGitNotice(canonicalNotice);
      setStatus(canonicalNotice ? "" : appliedKind === "delete" ? "Local handoff draft deleted." : "Local handoff draft updated.");
    });
    queueMicrotask(() => (canonicalNotice ? gitNoticeRef.current : statusRef.current)?.focus({ preventScroll: true }));
  };
  const publish = async (draft: RelayDraftDetail, event: MouseEvent<HTMLButtonElement>) => {
    const element = event.currentTarget;
    rememberTrigger(element);
    setPreparingPublish(draft.id);
    setStatus("");
    setGitNotice(null);
    try {
      const recipientIds = [...new Set(draft.input.recipients.map((recipient) => recipient.memberId))];
      const recipients = await Promise.all(recipientIds.map((memberId) => queryClient.fetchQuery({
          queryKey: ["member", memberId],
          queryFn: () => api.getMember(memberId),
        })));
      const inactiveRecipient = recipients.find((member) => !member.active);
      if (inactiveRecipient) {
        throw new Error(`${inactiveRecipient.displayName ?? "A recorded recipient"} is not an active team Member. Edit the draft before publishing.`);
      }
      startReview({
        kind: "publish",
        snapshot: { kind: "draft", input: draft.input },
        request: {
          operationId: operationId("publish"),
          action: { kind: "relay.publish", draftId: draft.id },
          expectedRevisions: [
            draftExpectation(draft),
            ...recipients.map((member) => artifactExpectation(member.sourcePath, member.revision)),
          ],
        },
      }, element);
    } catch (error) {
      const message = error instanceof Error && error.message.includes("is not an active team Member")
        ? error.message
        : "A recipient could not be verified. Refresh or edit the draft before publishing.";
      flushSync(() => setStatus(message));
      queueMicrotask(() => statusRef.current?.focus({ preventScroll: true }));
    } finally {
      setPreparingPublish(null);
    }
  };
  const deleteDraft = (draft: RelayDraftDetail, element: HTMLButtonElement) => {
    startReview({ kind: "delete", snapshot: { kind: "draft", input: draft.input }, request: { operationId: operationId("draft_delete"), action: { kind: "relay.draft.delete", draftId: draft.id }, expectedRevisions: [draftExpectation(draft)] } }, element);
  };
  const relayAction = (relay: RelayDetail, kind: "acknowledge" | "close", event: MouseEvent<HTMLButtonElement>) => {
    startReview({ kind, snapshot: { kind: "relay", relay }, request: { operationId: operationId(kind), action: { kind: kind === "acknowledge" ? "relay.acknowledge" : "relay.close", relayId: relay.ref.id }, expectedRevisions: [artifactExpectation(relay.sourcePath, relay.revision)] } }, event.currentTarget);
  };

  const senderActive = senderMemberId !== null && lifecycleDependencies.data?.some((member) => member.id === senderMemberId && member.active) === true;
  const ownerActive = ownerMemberId !== null && lifecycleDependencies.data?.some((member) => member.id === ownerMemberId && member.active) === true;
  const eligibleToTake = Boolean(
    selectedRelay?.state === "published"
    && currentMemberActive
    && (selectedRelay.audience === "team" || selectedRelay.recipients.some((recipient) => recipient.kind === "member" && recipient.memberId === currentMemberId)),
  );
  const canAcknowledge = lifecycleAvailable && eligibleToTake;
  const canClose = Boolean(
    lifecycleAvailable
    && selectedRelay?.state === "acknowledged"
    && currentMemberActive
    && currentCanCloseByRole
    && senderActive
    && ownerActive,
  );
  const lifecycleUnavailableReason = capabilities?.relays.lifecycleMutation.availability === "unavailable"
    ? capabilities.relays.lifecycleMutation.reason
    : null;
  const closeUnavailableReason = selectedRelay?.state !== "acknowledged"
    ? null
    : !lifecycleAvailable
      ? lifecycleUnavailableReason ?? "Closing handoffs is unavailable in this Hub process."
      : !currentMemberActive
      ? "Select an active team identity to close this handoff."
      : !currentCanCloseByRole
        ? "Only the sender or claimant can close this handoff."
        : senderMemberId === null || ownerMemberId === null
          ? "This legacy handoff does not record both roles as team Members, so it remains read-only."
          : lifecycleDependencies.isPending
            ? "Checking that the sender and claimant are still active team Members."
            : lifecycleDependencies.isError
              ? "The sender or claimant could not be checked. Refresh before trying to close this handoff."
              : !senderActive
                ? `${actorLabel(selectedRelay.sender)} is no longer an active team Member. Reactivate the existing Member in Team to recover this handoff.`
                : !ownerActive
                  ? `${actorLabel(selectedRelay.acknowledgedBy)} is no longer an active team Member. Reactivate the existing Member in Team to recover this handoff.`
                  : lifecycleUnavailableReason;

  const publishAvailable = capabilities?.relays.publish.availability === "available";
  const namedDraftMissingRecipients = draftDetail.data !== undefined && draftDetail.data.input.audience !== "team" && draftDetail.data.input.recipients.length === 0;
  const draftPublishReady = Boolean(currentMemberActive && publishAvailable && !namedDraftMissingRecipients);
  const draftPublishRecovery = !currentMemberActive
    ? "Select an active current Member before publishing."
    : !publishAvailable
      ? capabilities?.relays.publish.reason ?? "Relay publication is unavailable in this Hub process."
      : namedDraftMissingRecipients
        ? "Choose named Members or open this handoff to the team before publishing."
        : null;
  const draftMutationCapability: CapabilityStatus = capabilities?.relays.draftMutation ?? {
    availability: "unavailable",
    reason: "Local Relay draft changes are unavailable in this Hub process.",
  };

  const draftDetailState = invalidDraftSelection ? (
    <div className={styles.recoverableState}>
      <StatePanel compact state="empty" title="This draft link is invalid" detail="Return to the list and choose a handoff draft on this device." />
      <Button onClick={() => clearSelection()} size="sm" type="button" variant="outline">Return to drafts</Button>
    </div>
  ) : draftId === null ? (
    <StatePanel compact state="empty" title="Choose a handoff draft" detail="Select a private draft to review its content." />
  ) : draftDetail.isPending ? (
    <StatePanel compact state="loading" title="Opening handoff draft" detail="Loading its content only after selection." />
  ) : draftDetail.isError ? (
    <div className={styles.recoverableState}>
      <ErrorState error={draftDetail.error} retry={() => void draftDetail.refetch()} />
      <Button onClick={() => clearSelection()} size="sm" type="button" variant="outline">Return to drafts</Button>
    </div>
  ) : (
    <>
      <CardHeader className={styles.detailHeader}>
        <div>
          <CardDescription>Private handoff draft</CardDescription>
          <CardTitle><h2>{draftDetail.data.summary}</h2></CardTitle>
        </div>
        <CardAction><Badge variant="secondary">Checkout-local draft</Badge></CardAction>
      </CardHeader>
      <CardContent className={styles.detailContent}>
        <dl className={styles.humanMeta}>
          <div><dt>Audience</dt><dd>{draftDetail.data.audience === "team" ? "Open to team" : draftDetail.data.recipients.map(actorLabel).join(", ") || "Named Members · choose before publishing"}</dd></div>
          <div><dt>Updated</dt><dd>{formatDate(draftDetail.data.updatedAt)}</dd></div>
        </dl>
        <p className={styles.sharingState}>Saved only in this checkout. Nothing is shared until you publish and share through Git.</p>
        <div className={styles.actions} role="group" aria-label="Draft actions">
          <Button disabled={!draftPublishReady || preparingPublish === draftDetail.data.id} onClick={(event) => void publish(draftDetail.data, event)} size="sm">
            <Send data-icon="inline-start" /> {preparingPublish === draftDetail.data.id ? "Checking…" : "Publish handoff"}
          </Button>
          <Button disabled={!canDraft} onClick={(event) => openComposer(draftDetail.data, event)} size="sm" variant="outline"><FilePenLine data-icon="inline-start" /> Edit wording</Button>
          <DraftOverflowActions capability={draftMutationCapability} onDelete={(element) => deleteDraft(draftDetail.data, element)} />
        </div>
        {draftPublishRecovery ? <p className={styles.recovery} role="status">{draftPublishRecovery}</p> : null}
        {!canDraft ? <p className={styles.recovery} role="status">{draftMutationCapability.availability === "unavailable" ? draftMutationCapability.reason : "Local draft changes are unavailable."}</p> : null}
        <Suspense fallback={<StatePanel compact state="loading" title="Opening handoff details" detail="Preparing the selected local draft." />}>
          <RelayDetailSections detail={{ kind: "draft", draft: draftDetail.data }} />
        </Suspense>
      </CardContent>
    </>
  );

  const canonicalDetailState = invalidRelaySelection ? (
    <div className={styles.recoverableState}>
      <StatePanel compact state="empty" title="This handoff link is invalid" detail="Return to the queue and choose an available handoff." />
      <Button onClick={() => clearSelection()} size="sm" type="button" variant="outline">Return to queue</Button>
    </div>
  ) : relayId === null ? (
    <StatePanel compact state="empty" title="Choose a handoff" detail="Select an item from the queue to see its progress and next steps." />
  ) : relayDetail.isPending ? (
    <StatePanel compact state="loading" title="Opening handoff" detail="Loading its full context only after selection." />
  ) : relayDetail.isError ? (
    <div className={styles.recoverableState}>
      <ErrorState error={relayDetail.error} retry={() => void relayDetail.refetch()} />
      <Button onClick={() => clearSelection()} size="sm" type="button" variant="outline">Return to queue</Button>
    </div>
  ) : relaySelectionMismatch ? (
    <div className={styles.recoverableState}>
      <StatePanel compact state="empty" title="This handoff is not available in this view" detail="Its perspective or lifecycle state does not match the current queue." />
      <Button onClick={() => clearSelection()} size="sm" type="button" variant="outline">Return to handoffs</Button>
    </div>
  ) : (
    <>
      <CardHeader className={styles.detailHeader}>
        <div>
          <CardDescription>Team handoff</CardDescription>
          <CardTitle><h2>{relayDetail.data.summary}</h2></CardTitle>
        </div>
        <CardAction><Badge variant={relayDetail.data.state === "closed" ? "outline" : "secondary"}>{relayStateLabel(relayDetail.data, canonicalView ?? "all", currentMemberId)}</Badge></CardAction>
      </CardHeader>
      <CardContent className={styles.detailContent}>
        <dl className={styles.humanMeta}>
          <div><dt>Sender</dt><dd>{actorLabel(relayDetail.data.sender)}</dd></div>
          <div><dt>Audience</dt><dd>{relayDetail.data.audience === "team" ? "Open to team" : relayDetail.data.recipients.map(actorLabel).join(", ")}</dd></div>
          {relayDetail.data.acknowledgedBy ? <div><dt>Claimant</dt><dd>{actorLabel(relayDetail.data.acknowledgedBy)}</dd></div> : null}
          {relayRelevantTime(relayDetail.data) ? <div><dt>{relayDetail.data.state === "closed" ? "Closed" : relayDetail.data.state === "acknowledged" ? "Taken" : "Published"}</dt><dd>{relayRelevantTime(relayDetail.data)}</dd></div> : null}
        </dl>
        <p className={styles.sharingState}><strong>Published working-tree artifact.</strong> Git distributes this handoff. MEX has not verified commit, push, or receipt by another teammate.</p>
        {relayDetail.data.state === "published" ? <p className={styles.eligibility}>{relayDetail.data.audience === "team"
          ? "Any active Member can take this handoff, including teammates who join later."
          : "Only the named recipients can take this handoff, while their Member records are active."}</p> : null}
        {relayDetail.data.state === "published" ? (
          eligibleToTake ? (
            <div className={styles.actionPanel}>
              <div className={styles.actions} role="group" aria-label="Handoff actions">
                <Button disabled={!canAcknowledge} onClick={(event) => relayAction(relayDetail.data, "acknowledge", event)} size="sm"><UserCheck data-icon="inline-start" /> Take handoff</Button>
              </div>
              {!lifecycleAvailable ? <p className={styles.recovery} role="status">{lifecycleUnavailableReason ?? "Taking handoffs is unavailable in this Hub process."}</p> : null}
            </div>
          ) : (
            <div className={styles.actionExplanation}>
              <UserCheck aria-hidden="true" />
              <div>
                <strong>{relayDetail.data.audience === "team" ? "This handoff is open to the team." : `This handoff is addressed to ${relayDetail.data.recipients.map(actorLabel).join(", ")}.`}</strong>
                <p>MEX must resolve an eligible, active team identity before taking it. The first synchronized claim records one sole claimant.</p>
                {!currentMemberActive ? <Link to="/members">Open Members to choose your identity</Link> : null}
              </div>
            </div>
          )
        ) : relayDetail.data.state === "acknowledged" ? (
          <div className={styles.actionPanel}>
            <div className={styles.claimedState}>
              <UserCheck aria-hidden="true" />
              <p><strong>{currentIsClaimant ? "In your hands" : `Taken by ${actorLabel(relayDetail.data.acknowledgedBy)}`}</strong><span>This handoff has one claimant and cannot be unclaimed or reassigned.</span></p>
            </div>
            {currentCanCloseByRole ? (
              <div className={styles.actions} role="group" aria-label="Handoff actions">
                <Button disabled={!canClose} onClick={(event) => relayAction(relayDetail.data, "close", event)} size="sm"><CheckCircle2 data-icon="inline-start" /> Close handoff</Button>
              </div>
            ) : null}
            {closeUnavailableReason ? <p className={styles.recovery} role="status">{closeUnavailableReason}</p> : null}
          </div>
        ) : (
          <p className={styles.terminal}><ShieldCheck aria-hidden="true" /><span><strong>Immutable closed handoff.</strong> No further Relay actions are available.</span></p>
        )}
        <Suspense fallback={<StatePanel compact state="loading" title="Opening handoff details" detail="Preparing the selected handoff." />}>
          <RelayDetailSections
            detail={{ kind: "relay", relay: relayDetail.data }}
            warnings={<RelayWarnings diagnostics={relayDetail.data.diagnostics} truncated={relayDetail.data.diagnosticsTruncated} />}
          />
        </Suspense>
      </CardContent>
    </>
  );
  const gitNoticeCopy = gitNotice === "publish"
    ? { title: "Handoff created", description: "Handoff created in your working tree. Commit and push it so teammates can receive it." }
    : gitNotice === "acknowledge"
      ? { title: "Handoff claimed", description: "Handoff claimed in your working tree. Commit and push so the team can see that you took it." }
      : gitNotice === "close"
        ? { title: "Handoff closed", description: "Handoff closed in your working tree. Commit and push to share the final state." }
        : null;

  return (
    <div className={styles.page} data-relay-workbench={readAvailable ? "ready" : "unavailable"}>
      <PageHeader
        title="Relays"
        description="Continue work with the progress, decisions, and next steps your teammate left."
        actions={(
          <Button disabled={!readAvailable || refreshing} onClick={() => void refreshRelays()} ref={refreshRef} size="sm" type="button" variant="outline">
            <RefreshCw className={refreshing ? styles.refreshingIcon : undefined} data-icon="inline-start" />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        )}
      />
      {status ? <div className={styles.statusBanner} aria-live="polite" ref={statusRef} role="status" tabIndex={-1}><CheckCircle2 aria-hidden="true" /> {status}</div> : <div className={styles.liveStatus} aria-live="polite" role="status" />}
      {gitNoticeCopy ? (
        <Alert className={styles.gitTruthAlert} ref={gitNoticeRef} tabIndex={-1}>
          <GitCommitHorizontal aria-hidden="true" />
          <AlertTitle>{gitNoticeCopy.title}</AlertTitle>
          <AlertDescription>{gitNoticeCopy.description}</AlertDescription>
          <AlertAction>
            {gitNotice === "close" ? (
              <>
                <Button onClick={() => selectLifecycle("closed")} size="sm" type="button" variant="outline">View closed</Button>
                <Link className={buttonVariants({ size: "sm", variant: "ghost" })} to="/activity"><Activity data-icon="inline-start" /> Activity</Link>
              </>
            ) : null}
            <Button
              aria-label="Dismiss Git notice"
              onClick={() => {
                setGitNotice(null);
                queueMicrotask(() => refreshRef.current?.focus({ preventScroll: true }));
              }}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {selectionNotice ? <div className={styles.selectionNotice} role="status">{selectionNotice}</div> : null}
      {capabilities === undefined ? (
        <StatePanel state="loading" title="Checking Relay capability" detail="Confirming which handoff reads and actions are available." />
      ) : !readAvailable ? (
        <StatePanel state="unavailable" title="Relays are unavailable" detail={capabilities.relays.read.reason ?? "Relay reads are not connected in this Hub process."} />
      ) : (
        <>
          {trustedActor?.diagnostics.length || trustedActor?.diagnosticsTruncated || actor.isError || (!actor.isPending && !currentMemberActive) ? (
            <div className={styles.identityNotice} role="status">
              <TriangleAlert aria-hidden="true" />
              <div>
                <strong>Check your team identity</strong>
                {trustedActor?.diagnostics.map((diagnostic) => <p key={`${diagnostic.code}:${diagnostic.message}`}>{diagnostic.message}</p>)}
                {trustedActor?.diagnosticsTruncated ? <p>Additional identity diagnostics were omitted because the safe response limit was reached.</p> : null}
                {actor.isError ? <p>Your current team identity could not be read. Team handoffs and local drafts remain available.</p> : null}
                {!actor.isError && !currentMemberActive ? <p>Select an active team identity to enable personal handoffs and actions. Team handoffs and local drafts remain available.</p> : null}
                <Link className={buttonVariants({ size: "sm", variant: "outline" })} to="/members">Open Members</Link>
              </div>
            </div>
          ) : null}
          <Tabs className={styles.modeTabs} onValueChange={selectView} value={visibleView}>
            <div className={styles.viewControls}>
              <TabsList aria-label="Relay views" className={styles.modeTabList} variant="line">
                <TabsTrigger value="mine">For you</TabsTrigger>
                <TabsTrigger value="sent">Sent</TabsTrigger>
                <TabsTrigger value="all">Team</TabsTrigger>
                <TabsTrigger value="drafts">Drafts on this device</TabsTrigger>
              </TabsList>
              {canonicalView !== null ? (
                <div aria-label="Relay state" className={styles.stateControl} role="group">
                  <Button aria-pressed={lifecycle === "open"} onClick={() => selectLifecycle("open")} size="sm" type="button" variant={lifecycle === "open" ? "secondary" : "outline"}>Open</Button>
                  <Button aria-pressed={lifecycle === "closed"} onClick={() => selectLifecycle("closed")} size="sm" type="button" variant={lifecycle === "closed" ? "secondary" : "outline"}>Closed</Button>
                </div>
              ) : null}
            </div>
            {(["mine", "sent", "all"] as const).map((perspective) => (
              <TabsContent className={styles.modePanel} key={perspective} value={perspective}>
                {!viewReady || ((perspective === "mine" || perspective === "sent") && actor.isPending) ? (
                  <StatePanel state="loading" title="Finding your handoffs" detail="Resolving the current team identity before opening the default queue." />
                ) : (perspective === "mine" || perspective === "sent") && !currentMemberActive ? (
                  <div className={styles.identityRequired}>
                    <StatePanel compact state="unavailable" title="Select an active team identity" detail="Personal handoffs and actions become available when MEX can resolve you to an active Member. Team handoffs and local drafts remain readable." />
                    <Link className={buttonVariants({ size: "sm", variant: "outline" })} to="/members">Open Members</Link>
                  </div>
                ) : (
                  <>
                    <RelayWarnings
                      diagnostics={(relays.data?.pages ?? []).flatMap((page) => page.diagnostics)}
                      sourceTruncated={(relays.data?.pages ?? []).some((page) => page.sourceTruncated)}
                      truncated={(relays.data?.pages ?? []).some((page) => page.diagnosticsTruncated)}
                    />
                    <div className={styles.workbench}>
                      <RelayQueue
                        currentMemberId={currentMemberId}
                        error={relays.isError ? relays.error : null}
                        hasNextPage={Boolean(relays.hasNextPage)}
                        isFetchingNextPage={relays.isFetchingNextPage}
                        isPending={relays.isPending}
                        lifecycle={lifecycle}
                        onLoadMore={() => void relays.fetchNextPage()}
                        onSelect={selectRelay}
                        rows={relayRows}
                        selectedId={relayId}
                        sourceBounded={Boolean(relays.data && (relays.data.pages.length >= MAX_WORKBENCH_PAGES || relays.data.pages.some((page) => page.sourceTruncated)))}
                        view={perspective}
                      />
                      <Card className={styles.detailCard} role="region" aria-label="Selected handoff detail">{canonicalDetailState}</Card>
                    </div>
                  </>
                )}
              </TabsContent>
            ))}
            <TabsContent className={styles.modePanel} value="drafts">
              <RelayWarnings
                diagnostics={(drafts.data?.pages ?? []).flatMap((page) => page.diagnostics)}
                sourceTruncated={(drafts.data?.pages ?? []).some((page) => page.sourceTruncated)}
                truncated={(drafts.data?.pages ?? []).some((page) => page.diagnosticsTruncated)}
              />
              <div className={styles.workbench}>
                <RelayDraftQueue
                  canCreate={canDraft}
                  createUnavailableReason={draftMutationCapability.availability === "unavailable" ? draftMutationCapability.reason : undefined}
                  error={drafts.isError ? drafts.error : null}
                  hasNextPage={Boolean(drafts.hasNextPage)}
                  isFetchingNextPage={drafts.isFetchingNextPage}
                  isPending={drafts.isPending}
                  onCreate={(event) => openComposer(null, event)}
                  onLoadMore={() => void drafts.fetchNextPage()}
                  onSelect={selectDraft}
                  rows={draftRows}
                  selectedId={draftId}
                  sourceBounded={Boolean(drafts.data && (drafts.data.pages.length >= MAX_WORKBENCH_PAGES || drafts.data.pages.some((page) => page.sourceTruncated)))}
                />
                <Card className={styles.detailCard} role="region" aria-label="Selected handoff draft detail">{draftDetailState}</Card>
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
      {composer !== undefined ? (
        <Suspense fallback={null}>
          <RelayDraftComposer
            draft={composer}
            finalFocus={() => trigger.current}
            members={activeMembers}
            membersError={members.isError ? members.error : undefined}
            onApplied={onApplied}
            onClose={() => setComposer(undefined)}
            onRetryMembers={() => void members.refetch()}
            onAudienceChange={(audience) => setMembersRequested(audience === "members")}
          />
        </Suspense>
      ) : null}
      {review ? (
        <Suspense fallback={null}>
          <RelayMutationDialog
            acceptPreview={previewAcceptance}
            finalFocus={() => trigger.current}
            onApplied={onApplied}
            onClose={() => setReview(null)}
            source={review}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
