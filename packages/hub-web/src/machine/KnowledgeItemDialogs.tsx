import { useId, useRef } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/primitives/dialog";
import { Input } from "../components/primitives/input";
import type { KnowledgeAudience } from "./types";
import { CopyButton } from "./ui";
import styles from "./knowledge-forms.module.css";

const forgetCopy = {
  personal: {
    title: "Forget this note?",
    text: "MEX stops using it. The file stays on disk, and it moves to Forgotten.",
  },
  team: {
    title: "Forget this team note?",
    text: "Review the change that marks this note as retired in your checkout.",
  },
  hint: {
    title: "Forget this hint?",
    text: "MEX deletes its copy; your agent’s own memory is untouched.",
  },
};

export function KnowledgeForgetDialog({ open, audience, reason, error, finalFocus, onReason, onCancel, onConfirm }: {
  open: boolean;
  audience: KnowledgeAudience;
  reason: string;
  error?: string;
  finalFocus: () => HTMLElement | false;
  onReason: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const { title, text } = forgetCopy[audience];
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent className={styles.dialog} finalFocus={finalFocus} initialFocus={cancel}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{text}</AlertDialogDescription>
        </AlertDialogHeader>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
          <div className={styles.field}>
            <label htmlFor={reasonId}>Reason <span>(optional)</span></label>
            <Input id={reasonId} maxLength={512} onChange={(event) => onReason(event.target.value)} value={reason} />
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <AlertDialogFooter className={styles.dialogFooter}>
            <AlertDialogCancel ref={cancel}>Cancel</AlertDialogCancel>
            <AlertDialogAction type="submit" variant={audience === "team" ? "default" : "destructive"}>
              {audience === "team" ? "Review changes" : "Forget"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function KnowledgeShareDialog({ open, finalFocus, onClose }: {
  open: boolean;
  finalFocus: () => HTMLElement | false;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className={styles.dialog} finalFocus={finalFocus}>
        <DialogHeader className={styles.shareHeader}>
          <DialogTitle>Share with your team</DialogTitle>
          <DialogDescription>Share your notes with your team: run this in the repo, review the preview, then confirm.</DialogDescription>
        </DialogHeader>
        <div className={styles.command}><code>mex share</code><CopyButton text="mex share" /></div>
        <p className={styles.help}>Sharing from the Hub comes with the Share page.</p>
      </DialogContent>
    </Dialog>
  );
}
