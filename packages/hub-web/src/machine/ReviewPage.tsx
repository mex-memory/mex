import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { MachineProject, MachineReviewCard, MachineReviewQueue } from "@mex/hub-contracts/machine";
import { ArrowLeft, ArrowRight, CircleCheck, X } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/primitives/button";
import { HubProblemError } from "./api";
import type { HubEventState } from "./data";
import { reviewProblem } from "./review-api";
import { useReviewActions, useReviewCard, useReviewQueue, useReviewRefresh } from "./review-data";
import type { ReviewActions, ReviewApplied, ReviewPreview } from "./types";
import { orderReviewRows, repoPrefix, reviewHref, waitingAge, type ReviewRow } from "./review-model";
import { ReviewCard } from "./ReviewCard";
import { ReviewFocus } from "./ReviewFocus";
import { ReviewQueue } from "./ReviewQueue";
import { PageRequestState, type PageLoad } from "./ui";
import shared from "./machine.module.css";
import styles from "./review.module.css";

const narrowLayout = "(max-width: 1023px)";
function subscribeToLayout(listener: () => void) {
  const media = window.matchMedia(narrowLayout);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const isNarrow = () => window.matchMedia(narrowLayout).matches;

export interface ReviewConnection {
  events: HubEventState;
  csrfToken: string;
  reportDataError: (error: unknown) => void;
}

type Scope = { project?: MachineProject; projects: readonly MachineProject[] };
type ViewProps = Scope & {
  queue?: MachineReviewQueue;
  review: ReviewActions;
  fixtureCards?: readonly MachineReviewCard[];
  card?: MachineReviewCard;
  load?: PageLoad;
  detailLoad?: PageLoad;
  showMore?: () => void;
  loadingMore?: boolean;
};
type LeavingCard = { card: MachineReviewCard; locationKey: string; nextHref: string };

export default function ReviewPage(props: Scope & ({ review: ReviewPreview; live?: undefined } | { live: ReviewConnection; review?: undefined })) {
  if (props.live) return <LiveReviewPage {...props} live={props.live} />;
  return <ReviewView {...props} queue={props.review.queue} fixtureCards={props.review.queue?.cards} review={props.review} />;
}

function LiveReviewPage({ live, project, projects }: Scope & { live: ReviewConnection }) {
  const { cardKey } = useParams();
  const queue = useReviewQueue(project?.id, live.events);
  const first = queue.data?.pages[0];
  const rows = queue.data?.pages.flatMap((page) => page.cards);
  const key = cardKey ?? rows?.[0]?.key;
  const scopedKey = key && (!project || key.startsWith(project.id + ":")) ? key : undefined;
  const item = useReviewCard(scopedKey, live.events);
  const act = useReviewActions(live.csrfToken, live.reportDataError);
  const refresh = useReviewRefresh();
  const queueError = queue.isError && !reviewProblem(queue.error, "REVIEW_CHANGED");
  const detailError = item.isError && !(item.error instanceof HubProblemError && item.error.status === 404);
  const error = queueError ? queue.error : detailError ? item.error : undefined;
  useEffect(() => { if (error) live.reportDataError(error); }, [error, live.reportDataError]);

  return <ReviewView project={project} projects={projects} review={{ act, removeCompleted: refresh }}
    queue={first && { ...first, cards: rows!, nextCursor: queue.data!.pages.at(-1)!.nextCursor }}
    card={item.data} load={{ loading: queue.isPending || !rows?.length && Boolean(first?.updatingSince), error: queueError, retry: () => void queue.refetch() }}
    detailLoad={{ loading: Boolean(scopedKey && item.isPending), error: detailError, retry: () => void item.refetch() }}
    loadingMore={queue.isFetchingNextPage}
    showMore={queue.hasNextPage ? () => void queue.fetchNextPage({ cancelRefetch: false }) : undefined} />;
}

function canUseShortcut(event: KeyboardEvent) {
  const target = event.target;
  return !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && !event.nativeEvent.isComposing && target instanceof HTMLElement
    && !target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='dialog'], [role='alertdialog']");
}

function ReviewView({ project, projects, review, queue, fixtureCards, card: liveCard, load, detailLoad, showMore, loadingMore }: ViewProps) {
  const { cardKey } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useSyncExternalStore(subscribeToLayout, isNarrow);
  const title = useRef<HTMLHeadingElement>(null);
  const cardTitle = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const previousKey = useRef<string | undefined>(undefined);
  const [exit, setExit] = useState<LeavingCard | null>(null);
  const [toast, setToast] = useState<ReviewApplied | null>(null);
  const now = Date.now();
  const repoId = project?.id;
  const scope = project?.name ?? "All repos";
  const repoNames = new Map(projects.map(({ id, name }) => [id, name]));
  const listed = (queue?.cards ?? []).filter((row) => !repoId || row.repoId === repoId);
  const deepLink = liveCard && liveCard.key === cardKey && !listed.some(({ key }) => key === cardKey) ? liveCard : undefined;
  const rows = detailLoad ? deepLink ? [...listed, deepLink] : listed : orderReviewRows(listed);
  const repos = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    const group = repos.get(row.repoId);
    if (group) group.push(row);
    else repos.set(row.repoId, [row]);
  }

  const ordered = [...repos.values()].flat();
  const leaving = exit?.locationKey === location.key ? exit : null;
  const selected = leaving?.card ?? (cardKey ? ordered.find(({ key }) => key === cardKey) : ordered[0]);
  const card = leaving?.card ?? (liveCard?.key === selected?.key ? liveCard : undefined) ?? fixtureCards?.find(({ key }) => key === selected?.key);
  const total = (repoId ? queue?.byRepo[repoId] : queue?.total) ?? 0;
  // The live endpoint has the oldest card across all pages of this scope.
  const oldest = repoId && fixtureCards ? rows.map(({ createdAt }) => createdAt).sort()[0] : queue?.oldest;
  const loading = load?.loading ?? !queue;
  const updating = Boolean(queue?.updatingSince);
  const partial = queue?.partial;
  const href = (key?: string) => reviewHref(repoId, key, location.search);
  const knowledgeHref = repoPrefix(repoId) + "/knowledge" + location.search;
  const back = <Link className={shared.textLink + " " + styles.back} to={href()}><ArrowLeft aria-hidden="true" /> Review</Link>;
  const selectedRoute = Boolean(cardKey && selected);
  const loadedRoute = cardKey && card?.key;

  useEffect(() => {
    if (!leaving) return;
    const advance = () => {
      setExit(null);
      navigate(leaving.nextHref, { replace: true });
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      advance();
      return;
    }
    const timer = window.setTimeout(advance, 160);
    return () => window.clearTimeout(timer);
  }, [leaving, navigate]);

  useLayoutEffect(() => {
    const findRow = (key: string | undefined) => Array.from(page.current?.querySelectorAll<HTMLElement>("[data-review-key]") ?? [])
      .find((element) => element.dataset.reviewKey === key);
    if (cardKey && cardTitle.current) {
      if (narrow && window.scrollY > 0) window.scrollTo({ top: 0 });
      cardTitle.current.focus({ preventScroll: true });
      if (!narrow) findRow(cardKey)?.scrollIntoView?.({ block: "nearest" });
    } else {
      const previous = narrow ? findRow(previousKey.current) : undefined;
      (previous ?? title.current)?.focus();
    }
    previousKey.current = cardKey;
  }, [cardKey, location.key, narrow, selectedRoute, loadedRoute]);

  function advance(card: MachineReviewCard) {
    const index = ordered.findIndex(({ key }) => key === card.key);
    const next = ordered[index + 1] ?? ordered[index - 1];
    setExit({ card, locationKey: location.key, nextHref: href(next?.key) });
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!canUseShortcut(event) || leaving) return;
    const focusedKey = (event.target as HTMLElement).closest<HTMLElement>("[data-review-key]")?.dataset.reviewKey;
    const shortcut = event.key.toUpperCase();
    if (!event.repeat && (shortcut === "S" || shortcut === "K" || shortcut === "E") && (!narrow || cardKey) && (!focusedKey || focusedKey === selected?.key)) {
      const action = page.current?.querySelector<HTMLButtonElement>(`[data-review-card] button[aria-keyshortcuts="${shortcut}"]`);
      if (action && !action.disabled) {
        event.preventDefault();
        action.click();
      }
      return;
    }
    const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!direction) return;
    const currentKey = focusedKey ?? (!narrow || cardKey ? selected?.key : undefined);
    const index = ordered.findIndex(({ key }) => key === currentKey);
    const next = ordered[index < 0 ? direction > 0 ? 0 : ordered.length - 1 : index + direction];
    if (next) {
      event.preventDefault();
      navigate(href(next.key));
    }
  }

  const toastLink = toast && (toast.outcome === "retired"
    ? repoPrefix(repoId) + "/knowledge/forgotten" + location.search + "#" + encodeURIComponent(toast.knowledgeKey)
    : repoPrefix(repoId) + "/knowledge/" + encodeURIComponent(toast.knowledgeKey) + location.search);

  return (
    <div className={styles.page} data-detail={Boolean(cardKey)} onKeyDown={keyDown} ref={page}>
      <header className={styles.header}>
        <div className={styles.title}>
          <h1 className={shared.pageTitle} ref={title} tabIndex={-1}>Review</h1>
          <span title={scope}>· {scope}</span>
        </div>
        <div className={styles.headerMeta}>
          {updating && <span role="status">Updating…</span>}
          {!loading && <span>{total} {partial ? "shown" : "waiting"}{oldest && <> · oldest <time dateTime={oldest}>{waitingAge(oldest, now)}</time></>}</span>}
        </div>
      </header>
      {cardKey && <div className={styles.mobileBack}>{back}</div>}
      {loading || load?.error ? <PageRequestState name="Review" {...load} loading={loading} /> : null}
      {partial && <ul className={styles.partial} aria-label="Review reading limits">
        {partial.map(({ note, repoId: id }) => <li key={id ?? "all"}>{id && repoNames.has(id) ? repoNames.get(id) + " · " : ""}{note}</li>)}
      </ul>}
      {(ordered.length > 0 || leaving || cardKey && !loading && !load?.error) && (
        <div className={styles.workspace}>
          <ReviewQueue counts={queue?.byRepo} href={href} now={now} repoNames={repoNames} repos={repos} scoped={Boolean(project)}
            selected={cardKey || !narrow ? selected?.key : undefined} total={total} visible={listed.length} showMore={showMore} loadingMore={loadingMore} />
          {card ? (
            <ReviewFocus card={card} key={card.key} leaving={Boolean(leaving)} now={now} repo={repoNames.get(card.repoId) ?? "Unknown repo"} review={review} titleRef={cardTitle} live={Boolean(detailLoad)}
              onApplied={(result) => { setToast(result); advance(card); }}
              onHandled={() => { advance(card); review.removeCompleted(card.key); }} />
          ) : detailLoad && (detailLoad.loading || detailLoad.error) ? (
            <section className={styles.missing}><PageRequestState name="Review" {...detailLoad} /></section>
          ) : selected && !detailLoad ? (
            <ReviewCard now={now} repo={repoNames.get(selected.repoId) ?? "Unknown repo"} row={selected} titleRef={cardTitle} />
          ) : (
            <section className={styles.missing}>
              <h2 ref={cardTitle} tabIndex={-1}>This card is no longer waiting.</h2>
              {back}
            </section>
          )}
        </div>
      )}
      {!loading && !load?.error && !ordered.length && !leaving && !cardKey && !partial && (
        <section aria-labelledby="review-empty-title" className={styles.empty}>
          <h2 id="review-empty-title">Nothing to review.</h2>
          <p>MEX will ask when it learns something worth sharing.</p>
          <Link className={shared.textLink} to={knowledgeHref}>Open Knowledge <ArrowRight aria-hidden="true" /></Link>
        </section>
      )}
      <div aria-live="polite" className={styles.toastRegion} role="status">
        {toast && toastLink && (
          <div className={styles.toast}>
            <CircleCheck aria-hidden="true" />
            <div>
              <p><strong>{toast.toast}</strong></p>
              {toast.outcome === "shared" && <p>Commit it to share with your team</p>}
              <Link className={shared.textLink} to={toastLink}>{toast.outcome === "retired" ? "View in Forgotten" : "Open in Knowledge"} <ArrowRight aria-hidden="true" /></Link>
            </div>
            <Button aria-label="Dismiss notification" onClick={() => { setToast(null); (cardTitle.current ?? title.current)?.focus({ preventScroll: true }); }} size="icon-sm" type="button" variant="ghost"><X aria-hidden="true" /></Button>
          </div>
        )}
      </div>
    </div>
  );
}
