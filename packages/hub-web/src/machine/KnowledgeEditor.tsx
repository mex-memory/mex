import { useId, useLayoutEffect, useRef, type Ref } from "react";
import { Button } from "../components/primitives/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "../components/primitives/dialog";
import { Input } from "../components/primitives/input";
import { Textarea } from "../components/primitives/textarea";
import { KindSelect, ScopeInputs } from "./knowledge-fields";
import { kindLabels, scopeLabel } from "./knowledge-labels";
import type { KnowledgeEdit, KnowledgeEditResult } from "./types";
import styles from "./knowledge-forms.module.css";

export type EditDraft = Omit<KnowledgeEdit, "confirmRevision">;
export type EditConflict = Extract<KnowledgeEditResult, { type: "conflict" }>;

export function KnowledgeEditor({ draft, onChange, onSave, onCancel, error, pending, status, saveRef }: {
  draft: EditDraft;
  onChange: (draft: EditDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  error?: string;
  pending?: boolean;
  status?: string;
  saveRef: Ref<HTMLButtonElement>;
}) {
  const summaryId = useId();
  const textId = useId();
  const summary = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { summary.current?.focus(); }, []);

  return (
    <form className={`${styles.form} ${styles.editor}`} onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className={styles.field}>
        <label htmlFor={summaryId}>One-line summary</label>
        <Input id={summaryId} maxLength={1024} onChange={(event) => onChange({ ...draft, oneLine: event.target.value })} ref={summary} required value={draft.oneLine} />
      </div>
      <div className={styles.field}>
        <label htmlFor={textId}>Note text</label>
        <Textarea id={textId} maxLength={8192} onChange={(event) => onChange({ ...draft, text: event.target.value })} required rows={6} value={draft.text} />
      </div>
      <KindSelect kind={draft.kind} onChange={(kind) => onChange({ ...draft, kind })} />
      <ScopeInputs onChange={(scope) => onChange({ ...draft, scope })} patterns={draft.scope} />
      {status && <p role="status">{status}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.formActions}>
        <Button disabled={pending} onClick={onCancel} type="button" variant="outline">Cancel</Button>
        <Button disabled={pending} ref={saveRef} type="submit">Save</Button>
      </div>
    </form>
  );
}

export function KnowledgeConflictDialog({ conflict, finalFocus, pending, status, onCurrent, onKeep, onEditAgain }: {
  conflict: EditConflict | null;
  pending?: boolean;
  status?: string;
  finalFocus: () => HTMLElement | false;
  onCurrent: () => void;
  onKeep: () => void;
  onEditAgain: () => void;
}) {
  const editAgain = useRef<HTMLButtonElement>(null);
  const versions = conflict ? [
    { label: "Current (theirs)", item: conflict.current },
    { label: "Your edit (mine)", item: conflict.attempted },
  ] : [];
  return (
    <Dialog open={conflict !== null} onOpenChange={(open) => { if (!open && !pending) onEditAgain(); }}>
      <DialogContent className={`${styles.dialog} ${styles.wideDialog}`} finalFocus={finalFocus} initialFocus={editAgain} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>This item changed since you opened it</DialogTitle>
          <DialogDescription>Choose which version to keep, or go back and revise your edit.</DialogDescription>
        </DialogHeader>
        <div className={styles.versions}>
          {versions.map(({ label, item }) => (
            <div className={styles.version} key={label}>
              <h3>{label}</h3>
              <strong>{item.oneLine}</strong>
              <p className={styles.versionMeta}>{kindLabels[item.kind]} · {scopeLabel(item.scope)}</p>
              <p className={styles.versionText}>{item.text}</p>
            </div>
          ))}
        </div>
        {status && <p role="status">{status}</p>}
        <DialogFooter className={styles.dialogFooter}>
          <Button disabled={pending} onClick={onCurrent} type="button" variant="outline">Use current</Button>
          <Button disabled={pending} onClick={onEditAgain} ref={editAgain} type="button" variant="outline">Edit again</Button>
          <Button disabled={pending} onClick={onKeep} type="button">Keep my edit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
