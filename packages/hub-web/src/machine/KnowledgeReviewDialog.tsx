import { useRef } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import type { KnowledgeWritePreview } from "./types";
import styles from "./knowledge-forms.module.css";

export function KnowledgeReviewDialog({ preview, retiring, finalFocus, onCancel, onConfirm }: {
  preview: KnowledgeWritePreview | null;
  retiring?: boolean;
  finalFocus: () => HTMLElement | false;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={preview !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
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
          {preview?.diff.split("\n").map((line, index) => (
            <code data-line={line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@") ? "header" : line[0]} key={index}>{line}{"\n"}</code>
          ))}
        </pre>
        <AlertDialogFooter className={styles.dialogFooter}>
          <AlertDialogCancel ref={cancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} type="button" variant={retiring ? "destructive" : "default"}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
