import { useId, useRef, type ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { readableDiff, type DiffLine } from "./knowledge-diff";
import type { KnowledgeWritePreview } from "./types";
import styles from "./knowledge-forms.module.css";

// Matches the existing CSS hooks: header, "-", "+", and plain context.
const lineMark: Record<DiffLine["kind"], string> = { header: "header", removed: "-", added: "+", context: " ", fold: "header" };

export function KnowledgeReviewDialog({ preview, retiring, pending, status, error, title, children, blockedBy, finalFocus, onCancel, onConfirm }: {
  preview: KnowledgeWritePreview | null;
  retiring?: boolean;
  pending?: boolean;
  status?: string;
  error?: string;
  title?: string;
  children?: ReactNode;
  blockedBy?: string;
  finalFocus: () => HTMLElement | false;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  return (
    <AlertDialog open={preview !== null} onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <AlertDialogContent
        className={`${styles.dialog} ${styles.wideDialog}`}
        finalFocus={finalFocus}
        initialFocus={cancel}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title ?? (retiring ? "Review retirement" : "Review changes to team note")}</AlertDialogTitle>
          <AlertDialogDescription>
            {retiring
              ? <>This marks <code>{preview?.path}</code> as retired in <code>{preview?.checkout}</code>. Commit it to share.</>
              : <>This changes the file in <code>{preview?.checkout}</code>. Commit it to share the change with your team.</>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <pre aria-label="File diff" className={styles.diff} role="region" tabIndex={0}>
          {preview && readableDiff(preview.diff).map((line, index) => (
            <code data-line={lineMark[line.kind]} key={index}>{line.text}{"\n"}</code>
          ))}
        </pre>
        {(pending || status) && <p className={styles.help} id={statusId} role="status">{status ?? "Saving…"}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <AlertDialogFooter className={styles.dialogFooter}>
          <AlertDialogCancel aria-describedby={pending ? statusId : undefined} disabled={pending} ref={cancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction aria-describedby={blockedBy ?? (pending ? statusId : undefined)} disabled={pending || Boolean(blockedBy)} className={retiring ? styles.destructive : undefined} onClick={onConfirm} type="button" variant={retiring ? "destructive" : "default"}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
