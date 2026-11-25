import { useRef } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { readableDiff, type DiffLine } from "./knowledge-diff";
import type { KnowledgeWritePreview } from "./types";
import styles from "./knowledge-forms.module.css";

// Matches the existing CSS hooks: header, "-", "+", and plain context.
const lineMark: Record<DiffLine["kind"], string> = { header: "header", removed: "-", added: "+", context: " ", fold: "header" };

export function KnowledgeReviewDialog({ preview, retiring, pending, status, finalFocus, onCancel, onConfirm }: {
  preview: KnowledgeWritePreview | null;
  retiring?: boolean;
  pending?: boolean;
  status?: string;
  finalFocus: () => HTMLElement | false;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={preview !== null} onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <AlertDialogContent
        className={`${styles.dialog} ${styles.wideDialog}`}
        finalFocus={finalFocus}
        initialFocus={cancel}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{retiring ? "Review retirement" : "Review changes to team note"}</AlertDialogTitle>
          <AlertDialogDescription>
            {retiring
              ? <>This marks <code>{preview?.path}</code> as retired in <code>{preview?.checkout}</code>. Commit it to share.</>
              : <>This changes the file in <code>{preview?.checkout}</code>. Commit it to share the change with your team.</>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <pre aria-label="File diff" className={styles.diff} role="region" tabIndex={0}>
          {preview && readableDiff(preview.diff).map((line, index) => (
            <code data-line={lineMark[line.kind]} key={index}>{line.text}{"\n"}</code>
          ))}
        </pre>
        {status && <p role="status">{status}</p>}
        <AlertDialogFooter className={styles.dialogFooter}>
          <AlertDialogCancel disabled={pending} ref={cancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} className={retiring ? styles.destructive : undefined} onClick={onConfirm} type="button" variant={retiring ? "destructive" : "default"}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
