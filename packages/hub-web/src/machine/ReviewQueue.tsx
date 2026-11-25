import { ChevronRight, FolderGit2, ScanLine } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "../components/primitives/badge";
import { kindLabels } from "./knowledge-labels";
import { waitingAge, type ReviewRow } from "./review-model";
import styles from "./review.module.css";

export function ReviewQueue({ repos, repoNames, selected, scoped, now, visible, total, href }: {
  repos: ReadonlyMap<string, readonly ReviewRow[]>;
  repoNames: ReadonlyMap<string, string>;
  selected?: string;
  scoped: boolean;
  now: number;
  visible: number;
  total: number;
  href: (key: string) => string;
}) {
  return (
    <section aria-label="Review queue" className={styles.queue}>
      {[...repos].map(([repoId, cards]) => {
        const name = repoNames.get(repoId) ?? "Unknown repo";
        return (
          <div className={styles.repoQueue} key={repoId}>
            {!scoped && (
              <h2 className={styles.repoHeading}>
                <FolderGit2 aria-hidden="true" /><span>{name}</span>
                <span className={styles.repoCount}>{cards.length}</span>
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
    </section>
  );
}
