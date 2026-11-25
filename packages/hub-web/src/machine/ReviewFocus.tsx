import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { MachineReviewActionRequest, MachineReviewCard } from "@mex/hub-contracts/machine";
import { ArrowRight, Info } from "lucide-react";
import { Button } from "../components/primitives/button";
import { Kbd } from "../components/primitives/kbd";
import { KnowledgeForgetDialog } from "./KnowledgeItemDialogs";
import { KnowledgeReviewDialog } from "./KnowledgeReviewDialog";
import { KnowledgeEditFields, scopePatterns } from "./knowledge-fields";
import { knowledgeSaveError, useKnowledgeWrite } from "./knowledge-write-state";
import { ReviewCard } from "./ReviewCard";
import { ReviewChecks, UseProposalDialog } from "./ReviewDialogs";
import type { ReviewAction, ReviewApplied, ReviewDraft, ReviewHandled, ReviewPreview, ReviewWritePreview } from "./types";
import forms from "./knowledge-forms.module.css";
import shared from "./machine.module.css";
import styles from "./review.module.css";

const actions = {
  share: { label: "Share with team", key: "S", variant: "default", dialog: true },
  keep: { label: "Keep for me", key: "K", variant: "outline" },
  edit: { label: "Edit", key: "E", variant: "ghost" },
  use: { label: "Use proposal", variant: "default", dialog: true },
  keepCurrent: { label: "Keep current", variant: "outline" },
  retire: { label: "Retire", variant: "ghost", dialog: true },
} as const;
const actionOrder: ReviewAction[] = ["share", "use", "keep", "keepCurrent", "edit", "retire"];
const editedActions: readonly ReviewAction[] = ["share", "keep"];

type Dialog = { type: "use" } | { type: "retire" } | { type: "preview"; preview: ReviewWritePreview; request: MachineReviewActionRequest };

export function ReviewFocus({ card, now, repo, review, titleRef, leaving, onApplied, onHandled }: {
  card: MachineReviewCard;
  now: number;
  repo: string;
  review: ReviewPreview;
  titleRef: RefObject<HTMLHeadingElement | null>;
  leaving: boolean;
  onApplied: (result: ReviewApplied) => void;
  onHandled: () => void;
}) {
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [handled, setHandled] = useState<ReviewHandled | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const restoreEdit = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const moving = useRef(false);
  const active = useRef(false);
  const id = useId();
  const statusId = id + "-status";
  const checksId = id + "-checks";
  const invalidId = id + "-invalid";
  const write = useKnowledgeWrite();

  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useLayoutEffect(() => {
    if (handled) nextButton.current?.focus();
  }, [handled]);
  useLayoutEffect(() => {
    if (!draft && restoreEdit.current) {
      restoreEdit.current = false;
      editButton.current?.focus();
    }
  }, [draft]);

  const status = write.status ?? (write.pending ? "Saving…" : leaving ? "Moving to the next card…" : undefined);
  const invalid = draft && (!draft.claim.trim() || !draft.text.trim()) ? "Enter a claim and note text to save." : undefined;
  const available = actionOrder.filter((action) => card.actions.includes(action) && (!draft || editedActions.includes(action)));
  const preview = dialog?.type === "preview" ? dialog.preview : null;
  const blocked = preview?.checks.find(({ status }) => status === "blocked");
  const retiring = dialog?.type === "preview" && dialog.request.action === "retire";

  function closeDialog() {
    setDialog(null);
    setError("");
  }

  function finalFocus() {
    if (moving.current) return false;
    return nextButton.current ?? (trigger.current?.isConnected ? trigger.current : titleRef.current ?? false);
  }

  function submit(request: MachineReviewActionRequest) {
    if (write.pending || moving.current || handled) return;
    setError("");
    void write.run((onRetry) => review.act(card.key, request, onRetry), (result) => {
      if (result.type === "applied") {
        if (active.current) {
          moving.current = true;
          setDialog(null);
          onApplied(result);
        }
        review.removeCompleted(card.key);
      } else if (!active.current) {
        return;
      } else if (result.type === "preview") {
        setDialog({ type: "preview", preview: result, request });
      } else {
        setDialog(null);
        setHandled(result);
      }
    }, (error) => {
      if (active.current) setError(knowledgeSaveError(error, "Couldn't save. Try again."));
    });
  }

  function begin(action: ReviewAction) {
    if (card.disabled?.[action] || write.pending || moving.current || leaving || handled || invalid) return;
    const focused = document.activeElement;
    trigger.current = focused instanceof HTMLElement ? focused : null;
    setError("");
    if (action === "edit") {
      const { claim, text, kind, scope } = card;
      setDraft({ claim, text, kind, scope });
    } else if (action === "use" || action === "retire") {
      setReason("");
      setDialog({ type: action });
    } else {
      const edited = draft ? { ...draft, claim: draft.claim.trim(), text: draft.text.trim(), scope: scopePatterns(draft.scope) } : undefined;
      submit({ action, expectedRevision: card.revision, edited });
    }
  }

  function confirm(action: "use" | "retire") {
    submit({ action, expectedRevision: card.revision, reason: action === "retire" ? reason.trim() || undefined : undefined });
  }

  function cancelEdit() {
    restoreEdit.current = true;
    setDraft(null);
    setError("");
  }

  const footer = (
    <div aria-label="Review actions" className={styles.actions} role="group">
      <div className={styles.actionRow}>
        <div className={styles.buttons}>
          {handled ? (
            <Button disabled={leaving} aria-describedby={leaving ? statusId : undefined} onClick={onHandled} ref={nextButton} type="button">
              Next <ArrowRight aria-hidden="true" />
            </Button>
          ) : (
            <>
              {available.map((action) => {
                const control = actions[action];
                const key = !draft && "key" in control ? control.key : undefined;
                const why = status ? statusId : invalid ? invalidId : card.disabled?.[action] ? id + "-" + action : undefined;
                return (
                  <Button aria-describedby={why} aria-haspopup={"dialog" in control ? "dialog" : undefined} aria-keyshortcuts={key}
                    disabled={Boolean(why)} key={action} onClick={() => begin(action)} ref={action === "edit" ? editButton : undefined}
                    type="button" variant={control.variant}>
                    {control.label}{key && !why && <Kbd aria-hidden="true" className={styles.actionKey}>{key}</Kbd>}
                  </Button>
                );
              })}
              {draft && <Button aria-describedby={status ? statusId : undefined} disabled={Boolean(status)} onClick={cancelEdit} type="button" variant="ghost">Cancel</Button>}
            </>
          )}
        </div>
        {!draft && !handled && (
          <span aria-hidden="true" className={styles.queueKeys}>
            <Kbd className={styles.key}>↑</Kbd><Kbd className={styles.key}>↓</Kbd><span>Move</span>
          </span>
        )}
      </div>
      {status && !dialog && <p className={styles.actionNote} id={statusId} role="status">{status}</p>}
      {status && dialog && <span className={shared.srOnly} id={statusId}>{status}</span>}
      {invalid && <p className={styles.actionNote} id={invalidId}>{invalid}</p>}
      {available.map((action) => card.disabled?.[action] && (
        <p className={styles.actionNote} id={id + "-" + action} key={action}>{card.disabled[action]}</p>
      ))}
      {error && !dialog && <p className={styles.actionError} role="alert">{error}</p>}
    </div>
  );

  return (
    <>
      <ReviewCard card={card} footer={footer} leaving={leaving} now={now} repo={repo} row={card} titleRef={titleRef}
        notice={handled && (
          <div className={styles.handled} role="status">
            <Info aria-hidden="true" /> Already handled elsewhere{handled.outcome ? " (" + handled.outcome + ")" : ""}
          </div>
        )}
      >
        {draft && !handled && (
          <fieldset aria-label="Edit rule" className={forms.form + " " + styles.editor} disabled={write.pending || leaving}>
            <KnowledgeEditFields draft={{ ...draft, oneLine: draft.claim }} onChange={({ oneLine, text, kind, scope }) => setDraft({ claim: oneLine, text, kind, scope })}
              rows={4} summaryLabel="Claim" />
          </fieldset>
        )}
      </ReviewCard>
      {card.contradiction && (
        <UseProposalDialog current={card.contradiction.current} error={dialog?.type === "use" ? error : undefined} finalFocus={finalFocus}
          onCancel={closeDialog} onConfirm={() => confirm("use")} open={dialog?.type === "use"} pending={write.pending} status={status} />
      )}
      {card.retireTarget && (
        <KnowledgeForgetDialog audience={card.retireTarget.audience} error={dialog?.type === "retire" ? error : undefined} finalFocus={finalFocus}
          onCancel={closeDialog} onConfirm={() => confirm("retire")} onReason={setReason} open={dialog?.type === "retire"}
          pending={write.pending} reason={reason} showCost status={status} />
      )}
      <KnowledgeReviewDialog blockedBy={blocked && checksId + "-" + blocked.id} error={preview ? error : undefined} finalFocus={finalFocus}
        onCancel={closeDialog} onConfirm={() => {
          if (!blocked && dialog?.type === "preview") submit({ ...dialog.request, previewRevision: dialog.preview.revision });
        }} pending={write.pending} preview={preview} retiring={retiring} status={status} title={retiring ? undefined : "Share with team"}>
        {preview && !retiring && <ReviewChecks checks={preview.checks} id={checksId} />}
        {preview && retiring && <p className={forms.help}>Cost: free</p>}
      </KnowledgeReviewDialog>
    </>
  );
}
