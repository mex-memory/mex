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
import { MessagesSquare, Scale, ShieldCheck, Sparkles } from "lucide-react";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import { SetupText } from "./SetupText";
import styles from "./setup.module.css";

const number = new Intl.NumberFormat("en-US");

function Estimate({ quote }: { quote: MachineSetupQuote }) {
  return (
    <div className={styles.estimate}>
      <dl>
        <div><dt>Estimated time</dt><dd>{minutesText(quote.seconds)}</dd></div>
        <div><dt>Estimated use</dt><dd>{number.format(quote.tokens)} tokens</dd></div>
        <div><dt>Token ceiling</dt><dd>{number.format(quote.ceilingTokens)} tokens</dd></div>
      </dl>
      {quote.recentUse && <p>{quote.recentUse}</p>}
    </div>
  );
}

/** What learn deeper adds, in the words of its entry kinds: rules, decisions and pitfalls. */
const gains = [
  { icon: MessagesSquare, text: "Review conventions" },
  { icon: Scale, text: "Past decisions" },
  { icon: ShieldCheck, text: "Known pitfalls" },
] as const;

function minutesText(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  return "About " + number.format(minutes) + " " + (minutes === 1 ? "minute" : "minutes");
}

export function SetupLearningOffer({ offer, trigger, onQuote, onSkip, disabled }: {
  disabled?: boolean;
  offer: NonNullable<MachineRepoSetup["learnDeeper"]>;
  trigger: Ref<HTMLButtonElement>;
  onQuote: (quote: MachineSetupQuote) => void;
  onSkip: () => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const offered = offer.state === "offered";
  return (
    <li className={styles.step} data-offer={offered || undefined}>
      <div className={styles.stepMain}>
        <div className={styles.stepTitle}>
          <h3 ref={title} tabIndex={-1}>Learn deeper</h3>
          {offered && <Badge className={styles.recommended} variant="outline"><Sparkles aria-hidden="true" />Recommended</Badge>}
        </div>
        {offered ? (
          <>
            <p className={styles.offerLead}>Give your agents what your team already knows.</p>
            <ul aria-label="What it learns" className={styles.gains} role="list">
              {gains.map(({ icon: Icon, text }) => <li key={text}><Icon aria-hidden="true" />{text}</li>)}
            </ul>
            <p className={styles.offerCost}>
              {minutesText(offer.quote.seconds)} · about {number.format(offer.quote.tokens)} tokens
            </p>
          </>
        ) : (
          <p role="status">
            {offer.state === "skipped" ? <>Not started · run <code>mex learn</code> whenever you’re ready</>
              : offer.state === "no-review-remote" ? "No reviews to learn from (no GitHub or GitLab remote) · $0, nothing started"
              : <SetupText text={offer.reason} />}
          </p>
        )}
      </div>
      {offered && (
        <div className={styles.stepAside}>
          <div className={styles.actions}>
            <Button disabled={disabled} focusableWhenDisabled aria-haspopup="dialog" onClick={() => onQuote(offer.quote)} ref={trigger} size="sm" type="button">
              Learn deeper
            </Button>
            <Button disabled={disabled} focusableWhenDisabled onClick={() => { title.current?.focus({ preventScroll: true }); onSkip(); }} size="sm" type="button" variant="ghost">Not now</Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function SetupLearningDialog({ quote, waitsForSetup, finalFocus, onClose, onStart, disabled }: {
  disabled?: boolean;
  quote: MachineSetupQuote | null;
  /** Earlier setup jobs are still running, so learn deeper queues behind them. */
  waitsForSetup?: boolean;
  finalFocus: () => HTMLElement | null;
  onClose: () => void;
  onStart: (quote: MachineSetupQuote) => void;
}) {
  const back = useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog open={quote !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent className={styles.confirmation} finalFocus={finalFocus} initialFocus={back}>
        <AlertDialogHeader className={styles.confirmationHeader}>
          <AlertDialogTitle>Learn from your team’s reviews?</AlertDialogTitle>
          <AlertDialogDescription>
            MEX reads past reviews and docs in the background with your {quote?.agent} plan.
            Lessons stay personal until you share them.{waitsForSetup && " Starts after the code map."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {quote && (
          <div className={styles.confirmationBody}>
            <Estimate quote={quote} />
            {quote.privateRepo && <p>Excerpts from this private repo go to your agent account. Start only if your organization allows it.</p>}
            {quote.weekly && (
              <p>Then it checks for new reviews every 7–14 days, within the 3% automatic allowance. One-time run: <code>mex learn --no-weekly</code>.</p>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel ref={back}>Back</AlertDialogCancel>
          <AlertDialogAction disabled={disabled} onClick={() => { if (quote) onStart(quote); }} type="button">Start learning</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
