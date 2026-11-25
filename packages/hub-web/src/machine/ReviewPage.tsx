import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { MachineProject, MachineReviewCard } from "@mex/hub-contracts/machine";
import { ArrowLeft, ArrowRight, CircleCheck, X } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/primitives/button";
import type { HomeOverview, ReviewApplied, ReviewPreview } from "./types";
import { orderReviewRows, repoPrefix, reviewCount, reviewHref, waitingAge, type ReviewRow } from "./review-model";
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

type Props = {
  project?: MachineProject;
  projects: readonly MachineProject[];
  review?: ReviewPreview;
  overview?: HomeOverview;
  load?: PageLoad;
};

type LeavingCard = { card: MachineReviewCard; locationKey: string; nextHref: string };

function summaryRows(overview?: HomeOverview): ReviewRow[] {
  return (overview?.needs ?? []).filter(({ kind }) => kind !== "missingFolder").map(({ repoId, id, rule, waitingSince }) => ({
    key: repoId + ":" + id, repoId, claim: rule, createdAt: waitingSince, kind: "rule", checkedByModel: false,
  }));
}

function canUseShortcut(event: KeyboardEvent) {
  const target = event.target;
  return !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && !event.nativeEvent.isComposing && target instanceof HTMLElement
    && !target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='dialog'], [role='alertdialog']");
}

export default function ReviewPage({ project, projects, review, overview, load }: Props) {
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
  const queue = review?.queue;
  const rows = orderReviewRows((review ? queue?.cards ?? [] : summaryRows(overview)).filter((row) => !repoId || row.repoId === repoId));
  const repos = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    const group = repos.get(row.repoId);
    if (group) group.push(row);
    else repos.set(row.repoId, [row]);
  }

  const ordered = [...repos.values()].flat();
  const leaving = exit?.locationKey === location.key ? exit : null;
  const selected = leaving?.card ?? (cardKey ? ordered.find(({ key }) => key === cardKey) : ordered[0]);
  const card = leaving?.card ?? queue?.cards.find(({ key }) => key === selected?.key);
  const total = review ? (repoId ? queue?.byRepo[repoId] : queue?.total) ?? 0 : reviewCount(overview, repoId);
  const oldest = review
    ? repoId ? rows.reduce<string | null>((at, row) => !at || Date.parse(row.createdAt) < Date.parse(at) ? row.createdAt : at, null) : queue?.oldest
    : Object.entries(overview?.needsCount ?? {}).filter(([id]) => !repoId || repoId === id).map(([, { oldest }]) => oldest).sort()[0];
  const loading = review ? !queue : !rows.length && Boolean(load?.loading || overview?.pending);
  const updating = Boolean(queue?.updatingSince || !review && overview?.pending && rows.length);
  const href = (key?: string) => reviewHref(repoId, key, location.search);
  const knowledgeHref = repoPrefix(repoId) + "/knowledge" + location.search;
  const back = <Link className={shared.textLink + " " + styles.back} to={href()}><ArrowLeft aria-hidden="true" /> Review</Link>;
  const selectedRoute = Boolean(cardKey && selected);

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
  }, [cardKey, location.key, narrow, selectedRoute]);

  function advance(card: MachineReviewCard) {
    const index = ordered.findIndex(({ key }) => key === card.key);
    const next = ordered[index + 1] ?? ordered[index - 1];
    setExit({ card, locationKey: location.key, nextHref: href(next?.key) });
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!canUseShortcut(event) || leaving) return;
    const shortcut = event.key.toUpperCase();
    if (!event.repeat && (shortcut === "S" || shortcut === "K" || shortcut === "E") && (!narrow || cardKey)) {
      const action = page.current?.querySelector<HTMLButtonElement>(`[data-review-card] button[aria-keyshortcuts="${shortcut}"]`);
      if (action && !action.disabled) {
        event.preventDefault();
        action.click();
      }
      return;
    }
    const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!direction) return;
    const focusedKey = (event.target as HTMLElement).closest<HTMLElement>("[data-review-key]")?.dataset.reviewKey;
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
          {!loading && <span>{total} waiting{oldest && <> · oldest <time dateTime={oldest}>{waitingAge(oldest, now)}</time></>}</span>}
        </div>
      </header>
      {cardKey && <div className={styles.mobileBack}>{back}</div>}
      {loading || load?.error ? <PageRequestState name="Review" {...load} loading={loading} /> : null}
      {(ordered.length > 0 || leaving) && (
        <div className={styles.workspace}>
          <ReviewQueue href={href} now={now} repoNames={repoNames} repos={repos} scoped={Boolean(project)} selected={cardKey || !narrow ? selected?.key : undefined} total={total} visible={ordered.length} />
          {card && review ? (
            <ReviewFocus card={card} key={card.key} leaving={Boolean(leaving)} now={now} repo={repoNames.get(card.repoId) ?? "Unknown repo"} review={review} titleRef={cardTitle}
              onApplied={(result) => { setToast(result); advance(card); }}
              onHandled={() => { advance(card); review.removeCompleted(card.key); }} />
          ) : selected ? (
            <ReviewCard now={now} repo={repoNames.get(selected.repoId) ?? "Unknown repo"} row={selected} titleRef={cardTitle} />
          ) : (
            <section className={styles.missing}>
              <h2 ref={cardTitle} tabIndex={-1}>This card is no longer waiting.</h2>
              {back}
            </section>
          )}
        </div>
      )}
      {!loading && !load?.error && !ordered.length && !leaving && (
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
