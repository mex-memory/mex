import { useRef } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "../components/primitives/dialog";
import { Button } from "../components/primitives/button";
import { readableDiff, type DiffLine } from "./knowledge-diff";
import type { AgentRepairPreview } from "./types";
import { CommandCard } from "./ui";
import forms from "./knowledge-forms.module.css";
import styles from "./agents.module.css";

const lineMark: Record<DiffLine["kind"], string> = {
  header: "header", removed: "-", added: "+", context: " ", fold: "header",
};

export function AgentRepairDialog({ preview, name, pending, error, finalFocus, onClose, onConfirm }: {
  preview: AgentRepairPreview | null;
  name?: string;
  pending: boolean;
  error: string;
  finalFocus: () => HTMLElement | false;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <>
      <AlertDialog open={preview?.type === "browser"} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
        <AlertDialogContent className={forms.dialog + " " + forms.wideDialog} finalFocus={finalFocus} initialFocus={cancel}>
          <AlertDialogHeader>
            <AlertDialogTitle>Repair {name}</AlertDialogTitle>
            <AlertDialogDescription>MEX only changes its own hook entries. Cost: free.</AlertDialogDescription>
          </AlertDialogHeader>
          {preview?.type === "browser" && (
            <ul aria-label="Proposed changes" className={styles.repairFiles} role="list">
              {preview.changes.map((change) => (
                <li key={change.path}>
                  <code>{change.path}</code>
                  {"diff" in change ? (
                    <pre aria-label={"Diff for " + change.path} className={forms.diff} role="region" tabIndex={0}>
                      {readableDiff(change.diff).filter(({ kind }) => kind !== "header").map((line, index) => (
                        <code data-line={lineMark[line.kind]} key={index}>{line.text}{"\n"}</code>
                      ))}
                    </pre>
                  ) : <p className={forms.help}>{change.description}</p>}
                </li>
              ))}
            </ul>
          )}
          {error && <p className={forms.error} role="alert">{error}</p>}
          <AlertDialogFooter className={forms.dialogFooter}>
            <span className={styles.repairStatus} role="status">{pending ? "Repairing…" : ""}</span>
            <AlertDialogCancel disabled={pending} ref={cancel}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={onConfirm} type="button">Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={preview?.type === "terminal"} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className={forms.dialog} finalFocus={finalFocus} showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Repair {name} from your terminal</DialogTitle>
            <DialogDescription>{preview?.type === "terminal" && preview.reason}</DialogDescription>
          </DialogHeader>
          {preview?.type === "terminal" && <CommandCard compact command={preview.command} />}
          <DialogFooter className={forms.dialogFooter}>
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
