import { useId, type ReactNode, type Ref } from "react";
import type { MachineReviewCard } from "@mex/hub-contracts/machine";
import { CircleHelp, GitCompareArrows, ScanLine } from "lucide-react";
import { Badge } from "../components/primitives/badge";
import { audienceLabels, kindLabels, scopeLabel } from "./knowledge-labels";
import { remainingAge, waitingAge, type ReviewRow } from "./review-model";
import styles from "./review.module.css";

function Paragraphs({ text }: { text: string }) {
  return <div className={styles.paragraphs}>
    {text.split(/\r?\n[\t ]*\r?\n/u).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
  </div>;
}

function ReviewContent({ card }: { card: MachineReviewCard }) {
  const current = card.contradiction?.current;
  const reason = card.reason.replace(/ \(checked by model\)\.?$/iu, "").replace(/\.$/u, "");
  const Icon = current ? GitCompareArrows : CircleHelp;
  return (
    <>
      {current ? (
        <div className={styles.comparison}>
          <div className={styles.current}>
            <h3>Current</h3>
            <ul role="list">{current.map(({ key, claim, audience }) => (
              <li key={key}><strong>{claim}</strong><span>{audienceLabels[audience]}</span></li>
            ))}</ul>
          </div>
          <div className={styles.proposal}>
            <h3>Proposal</h3>
            <Paragraphs text={card.text} />
          </div>
        </div>
      ) : <Paragraphs text={card.text} />}
      <div className={styles.reason}>
        <Icon aria-hidden="true" />
        <div>
          {current
            ? <p><strong>Contradicts</strong> {current.map(({ claim }) => "“" + claim + "”").join(", ")}.</p>
            : <p><strong>Asking because</strong> {reason}.</p>}
          {card.checkedByModel && <p className={styles.modelMarker}><ScanLine aria-hidden="true" />Checked by model.</p>}
        </div>
      </div>
      <dl className={styles.details}>
        <div>
          <dt>Seen in {card.sources.count} {card.sources.count === 1 ? "source" : "sources"}</dt>
          <dd>{card.sources.producer}</dd>
          {card.sources.checkouts.map((path) => <dd className={styles.path} key={path}><code>{path}</code></dd>)}
        </div>
        <div>
          <dt>Applies to</dt>
          <dd className={styles.scope}>{card.scope.length
            ? card.scope.map((pattern) => <Badge key={pattern} variant="outline">{scopeLabel([pattern])}</Badge>)
            : "Whole repo"}</dd>
        </div>
      </dl>
    </>
  );
}

export function ReviewCard({ row, card, repo, now, titleRef, children, notice, footer, leaving }: {
  row: ReviewRow;
  card?: MachineReviewCard;
  repo: string;
  now: number;
  titleRef: Ref<HTMLHeadingElement>;
  children?: ReactNode;
  notice?: ReactNode;
  footer?: ReactNode;
  leaving?: boolean;
}) {
  const title = useId();
  return (
    <section aria-labelledby={title} className={styles.focused} data-leaving={leaving} data-review-card>
      <div className={styles.reading}>
        <header className={styles.cardHeader}>
          <div className={styles.cardMeta}>
            <span className={styles.cardIdentity}><Badge variant="outline">{kindLabels[row.kind]}</Badge><span>{repo}</span></span>
            <span className={styles.cardTimes}>
              <span>Waiting <time dateTime={row.createdAt}>{waitingAge(row.createdAt, now)}</time></span>
              {card && <span>Leaves Review in <time dateTime={card.expiresAt}>{remainingAge(card.expiresAt, now)}</time></span>}
            </span>
          </div>
          <h2 id={title} ref={titleRef} tabIndex={-1}>{row.claim}</h2>
        </header>
        {notice}
        {children ?? (card
          ? <ReviewContent card={card} />
          : <p className={styles.readOnly}>Run <code>mex review</code> in this repo to handle this rule.</p>)}
      </div>
      {footer}
    </section>
  );
}
