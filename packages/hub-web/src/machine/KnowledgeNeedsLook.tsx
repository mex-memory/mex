import { useId } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../components/primitives/button";
import type { KnowledgeItemAction } from "./KnowledgeDetail";
import { KnowledgeStatusLabel } from "./KnowledgeStatus";
import { audienceLabels, kindLabels } from "./knowledge-labels";
import type { KnowledgeItem, KnowledgeLandingData } from "./types";
import styles from "./knowledge-landing.module.css";
import pageStyles from "./knowledge.module.css";
import shared from "./machine.module.css";

const number = new Intl.NumberFormat();

export function KnowledgeNeedsLook({ summary, listHref, itemHref, repoNames, onAction }: {
  summary: KnowledgeLandingData["needsLook"];
  listHref: string;
  itemHref: (item: KnowledgeItem) => string;
  repoNames?: ReadonlyMap<string, string>;
  onAction: (item: KnowledgeItem, action: KnowledgeItemAction) => void;
}) {
  const heading = useId();
  if (!summary.total) {
    return (
      <section aria-label="Needs a look" className={`${styles.card} ${styles.calm}`}>
        <Check aria-hidden="true" />
        <p><strong>Nothing needs a look.</strong> Every checked item still holds.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={heading} className={`${styles.card} ${styles.review}`}>
      <div className={styles.cardHeading}>
        <h2 id={heading}>Needs a look <span>({number.format(summary.total)})</span></h2>
      </div>
      <ul className={styles.reviewItems} role="list">
        {summary.items.map((item) => {
          const repo = repoNames ? repoNames.get(item.repoId) ?? "Unknown repo" : undefined;
          const identity = [kindLabels[item.kind], repo, audienceLabels[item.audience]].filter(Boolean).join(" · ");
          return (
            <li className={styles.reviewRow} key={item.key}>
              <Link className={styles.reviewLink} data-item-key={item.key} to={itemHref(item)}>
                <KnowledgeStatusLabel className={`${pageStyles.status} ${styles.reviewIcon}`} iconOnly status={item.status} />
                <span className={styles.reviewIdentity}>
                  <strong title={item.oneLine}>{item.oneLine}</strong>
                  <span title={identity}>{identity}</span>
                </span>
                <span className={styles.reviewWhy} title={item.why}>{item.why}</span>
              </Link>
              <div className={styles.reviewActions}>
                <Button aria-label={`Edit ${item.oneLine}`} disabled={item.audience === "hint"} onClick={() => onAction(item, "edit")} size="xs" type="button" variant="ghost">Edit</Button>
                <Button aria-haspopup="dialog" aria-label={`Forget ${item.oneLine}`} onClick={() => onAction(item, "forget")} size="xs" type="button" variant="ghost">Forget</Button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className={styles.reviewFooter}>
        <Link className={shared.textLink} to={listHref}>Show all {number.format(summary.total)} <ArrowRight aria-hidden="true" /></Link>
      </div>
    </section>
  );
}
