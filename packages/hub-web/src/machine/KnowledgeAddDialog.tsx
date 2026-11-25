import { useId, useRef, useState } from "react";
import type { MachineProject } from "@mex/hub-contracts/machine";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/primitives/dialog";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { Textarea } from "../components/primitives/textarea";
import { knowledgeSaveError, useKnowledgeWrite } from "./knowledge-write-state";
import { KindSelect, ScopeInputs } from "./knowledge-fields";
import { scopePatterns } from "./knowledge-labels";
import type { KnowledgeCreate, KnowledgeKind } from "./types";
import styles from "./knowledge-forms.module.css";

export function KnowledgeAddDialog({ open, project, projects, preferredRepo, finalFocus, onClose, onSave }: {
  open: boolean;
  project?: MachineProject;
  projects: readonly MachineProject[];
  preferredRepo?: string;
  finalFocus: () => HTMLElement | false;
  onClose: () => void;
  onSave: (request: KnowledgeCreate, onRetry: () => void) => void | Promise<void>;
}) {
  const textLabel = useId();
  const repoLabel = useId();
  const disabledReason = useId();
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<KnowledgeKind>("rule");
  const [patterns, setPatterns] = useState(["**"]);
  const [repo, setRepo] = useState(preferredRepo ?? "");
  const [error, setError] = useState("");
  const write = useKnowledgeWrite();
  const noRepo = !project && projects.length === 0;

  function save() {
    const repoId = project?.id ?? repo;
    if (!text.trim() || !repoId) {
      setError("Enter note text and choose a repo.");
      return;
    }
    setError("");
    void write.run((retry) => onSave({ repoId, text: text.trim(), kind, scope: scopePatterns(patterns) }, retry),
      () => {}, (error) => setError(knowledgeSaveError(error, "Couldn’t add this note. Try again.")));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !write.pending) onClose(); }}>
      <DialogContent className={styles.dialog} finalFocus={finalFocus} initialFocus={bodyInput} showCloseButton={false}>
        <DialogHeader><DialogTitle>Add a note</DialogTitle></DialogHeader>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); save(); }}>
          <div className={styles.field}>
            <label htmlFor={textLabel}>What should MEX remember?</label>
            <Textarea id={textLabel} maxLength={8192} onChange={(event) => setText(event.target.value)} ref={bodyInput} required rows={4} value={text} />
          </div>
          <div className={styles.fieldRow}>
            <KindSelect kind={kind} onChange={setKind} />
            {!project && (
              <div className={styles.field}>
                <label htmlFor={repoLabel}>Repo</label>
                <NativeSelect
                  aria-describedby={noRepo ? disabledReason : undefined}
                  className={styles.select}
                  disabled={noRepo}
                  id={repoLabel}
                  onChange={(event) => setRepo(event.target.value)}
                  required
                  value={repo}
                >
                  <NativeSelectOption value="">Choose a repo</NativeSelectOption>
                  {projects.map(({ id, name }) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
                </NativeSelect>
              </div>
            )}
          </div>
          <div className={styles.visibility}>
            <p>Who sees it <Badge variant="secondary">Only you</Badge></p>
            <p className={styles.help}>Share it later with <code>mex share</code>.</p>
          </div>
          <ScopeInputs onChange={setPatterns} patterns={patterns} />
          {noRepo && <p className={styles.help} id={disabledReason}>Register a repo before saving a note.</p>}
          {write.status && <p role="status">{write.status}</p>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          <DialogFooter className={styles.dialogFooter}>
            <DialogClose disabled={write.pending} render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button aria-describedby={noRepo ? disabledReason : undefined} disabled={noRepo || write.pending} type="submit">Save note</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
