import { useRef, type Ref } from "react";
import type { MachineRepoSetup, MachineSetupQuote } from "@mex/hub-contracts/machine";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { Button } from "../components/primitives/button";
import { SetupText } from "./SetupText";
import styles from "./setup.module.css";

const number = new Intl.NumberFormat("en-US");

function Estimate({ quote }: { quote: MachineSetupQuote }) {
  const minutes = Math.ceil(quote.seconds / 60);
  return (
    <div className={styles.estimate}>
      <dl>
        <div><dt>Estimated time</dt><dd>About {number.format(minutes)} {minutes === 1 ? "minute" : "minutes"}</dd></div>
        <div><dt>Estimated use</dt><dd>{number.format(quote.tokens)} tokens</dd></div>
        <div><dt>Token ceiling</dt><dd>{number.format(quote.ceilingTokens)} tokens</dd></div>
      </dl>
      <p>{quote.recentUse ?? "Recent usage is unavailable, so a share of your plan can't be estimated yet."}</p>
    </div>
  );
}

export function SetupLearningOffer({ offer, trigger, onQuote, onSkip }: {
  offer: NonNullable<MachineRepoSetup["learnDeeper"]>;
  trigger: Ref<HTMLButtonElement>;
  onQuote: (quote: MachineSetupQuote) => void;
  onSkip: () => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <li className={styles.step}>
      <div className={styles.stepMain}>
        <div className={styles.stepTitle}><h3 ref={title} tabIndex={-1}>Learn deeper</h3></div>
        {offer.state === "offered" ? (
          <>
            <p>Learn from past reviews and docs using your {offer.quote.agent} plan?</p>
            <Estimate quote={offer.quote} />
          </>
        ) : (
          <p role="status">
            {offer.state === "skipped" ? <>Skipped · $0 · start it any time with <code>mex learn</code></>
              : offer.state === "no-review-remote" ? "No reviews to learn from (no GitHub or GitLab remote) · $0, nothing started"
              : <SetupText text={offer.reason} />}
          </p>
        )}
      </div>
      {offer.state === "offered" && (
        <div className={styles.stepAside}>
          <div className={styles.actions}>
            <Button aria-haspopup="dialog" onClick={() => onQuote(offer.quote)} ref={trigger} size="sm" type="button">
              Start learn deeper
            </Button>
            <Button onClick={() => { title.current?.focus({ preventScroll: true }); onSkip(); }} size="sm" type="button" variant="ghost">Skip</Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function SetupLearningDialog({ quote, finalFocus, onClose, onStart }: {
  quote: MachineSetupQuote | null;
  finalFocus: () => HTMLElement | null;
  onClose: () => void;
  onStart: (quote: MachineSetupQuote) => void;
}) {
  const back = useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog open={quote !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent className={styles.confirmation} finalFocus={finalFocus} initialFocus={back}>
        <AlertDialogHeader className={styles.confirmationHeader}>
          <AlertDialogTitle>Start learn deeper?</AlertDialogTitle>
          <AlertDialogDescription>
            MEX will read past reviews and docs in the background using your {quote?.agent} plan.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {quote && (
          <div className={styles.confirmationBody}>
            <Estimate quote={quote} />
            {quote.privateRepo && <p>Review and doc excerpts from this private repo will be sent to your selected agent account. Start only if your organization allows it.</p>}
            {quote.weekly && (
              <p>After this run, MEX checks for new reviews and docs every 7–14 days when idle, signed in, and within the 3% automatic allowance. Use <code>mex learn --no-weekly</code> in a terminal for a one-time run.</p>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel ref={back}>Back</AlertDialogCancel>
          <AlertDialogAction onClick={() => { if (quote) onStart(quote); }} type="button">Confirm and start</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
