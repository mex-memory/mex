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
      <p>{quote.recentUse ?? "Recent usage is unavailable, so a share of your plan can't be estimated yet."}</p>
    </div>
  );
}

/** What learn deeper adds, in the words of its entry kinds: rules, decisions (including approaches ruled out) and pitfalls. */
const gains = [
  { icon: MessagesSquare, text: "The conventions reviewers keep asking for" },
  { icon: Scale, text: "Decisions, and approaches your team ruled out" },
  { icon: ShieldCheck, text: "Pitfalls that past reviews already caught" },
] as const;

function minutesText(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  return "About " + number.format(minutes) + " " + (minutes === 1 ? "minute" : "minutes");
}

export function SetupLearningOffer({ offer, trigger, onQuote, onSkip }: {
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
          <div className={styles.offer}>
            <p className={styles.offerLead}>Give your agents what your team already knows.</p>
            <p>
              MEX reads this repo’s past pull request reviews and docs, and turns what keeps coming up into notes your agents
              get in every session. Richer context means they follow your team’s way of working without being told.
            </p>
            <ul className={styles.gains} role="list">
              {gains.map(({ icon: Icon, text }) => <li key={text}><Icon aria-hidden="true" />{text}</li>)}
            </ul>
            <p className={styles.offerNote}>
              Every lesson links to the review or doc it came from. Lessons go to your personal notes, and nothing reaches your
              team until you share it.
            </p>
            <p className={styles.offerCost}>
              {minutesText(offer.quote.seconds)} · about {number.format(offer.quote.tokens)} tokens of your {offer.quote.agent} plan
              {offer.quote.recentUse && <><br />{offer.quote.recentUse}</>}
            </p>
          </div>
        ) : (
          <p role="status">
            {offer.state === "skipped" ? <>Not started · $0 · whenever you’re ready, run <code>mex learn</code> to add your team’s conventions from past reviews</>
              : offer.state === "no-review-remote" ? "No reviews to learn from (no GitHub or GitLab remote) · $0, nothing started"
              : <SetupText text={offer.reason} />}
          </p>
        )}
      </div>
      {offered && (
        <div className={styles.stepAside}>
          <div className={styles.actions}>
            <Button aria-haspopup="dialog" onClick={() => onQuote(offer.quote)} ref={trigger} size="sm" type="button">
              Learn deeper
            </Button>
            <Button onClick={() => { title.current?.focus({ preventScroll: true }); onSkip(); }} size="sm" type="button" variant="ghost">Not now</Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function SetupLearningDialog({ quote, waitsForSetup, finalFocus, onClose, onStart }: {
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
            MEX reads past reviews and docs in the background using your {quote?.agent} plan, so your agents start with your
            team’s conventions. You can keep working.{waitsForSetup && " It starts after the code map finishes."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {quote && (
          <div className={styles.confirmationBody}>
            <Estimate quote={quote} />
            {quote.privateRepo && <p>Review and doc excerpts from this private repo will be sent to your selected agent account. Start only if your organization allows it.</p>}
            {quote.weekly && (
              <p>Afterwards, MEX keeps these lessons fresh: every 7–14 days it checks for new reviews and docs, only when idle, signed in, and within the 3% automatic allowance. For a one-time run, use <code>mex learn --no-weekly</code> in a terminal.</p>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel ref={back}>Back</AlertDialogCancel>
          <AlertDialogAction onClick={() => { if (quote) onStart(quote); }} type="button">Start learning</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
