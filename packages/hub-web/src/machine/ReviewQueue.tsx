import { ChevronRight, FolderGit2, ScanLine } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/primitives/button";
import { Badge } from "../components/primitives/badge";
import { kindLabels } from "./knowledge-labels";
import { waitingAge, type ReviewRow } from "./review-model";
import styles from "./review.module.css";

export function ReviewQueue({ counts, repos, repoNames, selected, scoped, now, visible, total, href, showMore, loadingMore }: {
  counts?: Readonly<Record<string, number>>;
  repos: ReadonlyMap<string, readonly ReviewRow[]>;
  repoNames: ReadonlyMap<string, string>;
  selected?: string;
  scoped: boolean;
  now: number;
  visible: number;
  total: number;
  href: (key: string) => string;
  showMore?: () => void;
  loadingMore?: boolean;
}) {
  const list = useRef<HTMLElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const requested = useRef<{ prior: Set<string>; trigger: HTMLButtonElement; fetching: boolean } | null>(null);
  useLayoutEffect(() => {
    const pending = requested.current;
    if (!pending) return;
    if (loadingMore) {
      pending.fetching = true;
      return;
    }
    const added = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-review-key]") ?? [])
      .find((row) => !pending.prior.has(row.dataset.reviewKey!));
    if (!pending.fetching && !added) return;
    requested.current = null;
    if (document.activeElement === pending.trigger || document.activeElement === document.body) added?.focus();
  }, [repos, loadingMore]);

  function loadMore() {
    if (!more.current || !showMore) return;
    const prior = new Set([...repos.values()].flatMap((rows) => rows.map(({ key }) => key)));
    requested.current = { prior, trigger: more.current, fetching: false };
    showMore();
  }

  return (
    <section aria-keyshortcuts="ArrowUp ArrowDown" aria-label="Review queue" className={styles.queue} ref={list}>
      {[...repos].map(([repoId, cards]) => {
        const name = repoNames.get(repoId) ?? "Unknown repo";
        return (
          <div className={styles.repoQueue} key={repoId}>
            {!scoped && (
              <h2 className={styles.repoHeading}>
                <FolderGit2 aria-hidden="true" /><span>{name}</span>
                <span className={styles.repoCount}>{counts?.[repoId] ?? cards.length}</span>
              </h2>
            )}
            <ul aria-label={scoped ? "Waiting cards" : name} className={styles.rows} role="list">
              {cards.map((card) => (
                <li key={card.key}>
                  <Link aria-current={selected === card.key ? "page" : undefined} className={styles.row} data-review-key={card.key} to={href(card.key)}>
                    <span className={styles.rowClaim} title={card.claim}>{card.claim}</span>
                    <ChevronRight aria-hidden="true" className={styles.rowArrow} />
                    <span className={styles.rowMeta}>
                      <span>{kindLabels[card.kind]} · <time dateTime={card.createdAt}>{waitingAge(card.createdAt, now)}</time></span>
                      {card.contradiction && <Badge className={styles.conflictBadge} variant="outline">Contradiction</Badge>}
                      {card.checkedByModel && <span className={styles.modelMarker}><ScanLine aria-hidden="true" />Checked by model</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {visible < total && <p className={styles.queueLimit}>Showing {visible} of {total} waiting</p>}
      {showMore && <Button className={styles.more} disabled={loadingMore} onClick={loadMore} ref={more} size="sm" type="button" variant="outline">
        {loadingMore ? "Loading…" : "Show more"}
      </Button>}
    </section>
  );
}
