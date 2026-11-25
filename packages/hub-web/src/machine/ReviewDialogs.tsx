import { useId, useRef } from "react";
import type { MachineReviewCard } from "@mex/hub-contracts/machine";
import { AlertCircle, Check, TriangleAlert } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import type { ReviewWritePreview } from "./types";
import forms from "./knowledge-forms.module.css";
import styles from "./review.module.css";

const checkIcon = { passed: Check, warning: TriangleAlert, blocked: AlertCircle };

export function ReviewChecks({ checks, id }: { checks: ReviewWritePreview["checks"]; id: string }) {
  return (
    <ul aria-label="Sharing checks" className={styles.checklist} role="list">
      {checks.map(({ id: checkId, status, message }) => {
        const Icon = checkIcon[status];
        return <li data-check={status} id={id + "-" + checkId} key={checkId}><Icon aria-hidden="true" /><span>{message}</span></li>;
      })}
    </ul>
  );
}

export function UseProposalDialog({ open, current, pending, status, error, finalFocus, onCancel, onConfirm }: {
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
