import { useId, useRef } from "react";
import type { MachineReviewActionRequest, MachineReviewCard } from "@mex/hub-contracts/machine";
import { AlertCircle, Check, TriangleAlert } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { KnowledgeForgetDialog } from "./KnowledgeItemDialogs";
import { KnowledgeReviewDialog } from "./KnowledgeReviewDialog";
import type { ReviewWritePreview } from "./types";
import forms from "./knowledge-forms.module.css";
import styles from "./review.module.css";

const checkIcon = { passed: Check, warning: TriangleAlert, blocked: AlertCircle };

function ReviewChecks({ checks, id }: { checks: ReviewWritePreview["checks"]; id: string }) {
  return (
    <ul aria-label="Sharing checks" className={styles.checklist} role="list">
      {checks.map(({ id: checkId, status, message }) => {
        const Icon = checkIcon[status];
        return <li data-check={status} id={id + "-" + checkId} key={checkId}><Icon aria-hidden="true" /><span>{message}</span></li>;
      })}
    </ul>
  );
}

function UseProposalDialog({ open, current, pending, status, error, finalFocus, onCancel, onConfirm }: {
  open: boolean;
  current: NonNullable<MachineReviewCard["contradiction"]>["current"];
  pending: boolean;
  status?: string;
  error?: string;
  finalFocus: () => HTMLElement | false;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !pending) onCancel(); }}>
      <AlertDialogContent className={forms.dialog} finalFocus={finalFocus} initialFocus={cancel}>
        <AlertDialogHeader>
          <AlertDialogTitle>Use this proposal?</AlertDialogTitle>
          <AlertDialogDescription>Saves the proposal as your note.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className={styles.effects}>
          <p><strong>Retires:</strong> {current.map(({ claim }) => claim).join(", ")} ({current.length === 1 ? "it moves" : "they move"} to Forgotten).</p>
          <p className={forms.help}>Cost: free</p>
        </div>
        {status && <p className={forms.help} id={statusId} role="status">{status}</p>}
        {error && <p className={forms.error} role="alert">{error}</p>}
        <AlertDialogFooter className={forms.dialogFooter}>
          <AlertDialogCancel aria-describedby={pending ? statusId : undefined} disabled={pending} ref={cancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction aria-describedby={pending ? statusId : undefined} className={forms.destructive} disabled={pending} onClick={onConfirm} type="button" variant="destructive">Use proposal</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type ReviewDialogState = { type: "use" } | { type: "retire" }
  | { type: "preview"; preview: ReviewWritePreview; request: MachineReviewActionRequest };

export default function ReviewDialogs({ card, dialog, error, pending, reason, status, finalFocus, onCancel, onReason, onSubmit }: {
  card: MachineReviewCard;
  dialog: ReviewDialogState | null;
  error: string;
  pending: boolean;
  reason: string;
  status?: string;
  finalFocus: () => HTMLElement | false;
  onCancel: () => void;
  onReason: (reason: string) => void;
  onSubmit: (request: MachineReviewActionRequest) => void;
}) {
  const checksId = useId();
  const preview = dialog?.type === "preview" ? dialog.preview : null;
  const blocked = preview?.checks.find(({ status }) => status === "blocked");
  const retiring = dialog?.type === "preview" && dialog.request.action === "retire";

  return (
    <>
      {card.contradiction && (
        <UseProposalDialog current={card.contradiction.current} error={dialog?.type === "use" ? error : undefined} finalFocus={finalFocus}
          onCancel={onCancel} onConfirm={() => onSubmit({ action: "use", expectedRevision: card.revision })}
          open={dialog?.type === "use"} pending={pending} status={status} />
      )}
      {card.retireTarget && (
        <KnowledgeForgetDialog audience={card.retireTarget.audience} error={dialog?.type === "retire" ? error : undefined} finalFocus={finalFocus}
          onCancel={onCancel} onConfirm={() => onSubmit({ action: "retire", expectedRevision: card.revision, reason: reason.trim() || undefined })}
          onReason={onReason} open={dialog?.type === "retire"} pending={pending} reason={reason} showCost status={status} />
      )}
      <KnowledgeReviewDialog blockedBy={blocked && checksId + "-" + blocked.id} error={preview ? error : undefined} finalFocus={finalFocus}
        onCancel={onCancel} onConfirm={() => {
          if (!blocked && dialog?.type === "preview") onSubmit({ ...dialog.request, previewRevision: dialog.preview.revision });
        }} pending={pending} preview={preview} retiring={retiring} status={status} title={retiring ? undefined : "Share with team"}>
        {preview && !retiring && <ReviewChecks checks={preview.checks} id={checksId} />}
        {preview && retiring && <p className={forms.help}>Cost: free</p>}
      </KnowledgeReviewDialog>
    </>
  );
}
