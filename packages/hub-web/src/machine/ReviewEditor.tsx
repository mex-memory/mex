import { KnowledgeEditFields } from "./knowledge-fields";
import type { ReviewDraft } from "./types";
import forms from "./knowledge-forms.module.css";
import styles from "./review.module.css";

export default function ReviewEditor({ draft, disabled, onChange }: {
  draft: ReviewDraft;
  disabled: boolean;
  onChange: (draft: ReviewDraft) => void;
}) {
  return (
    <fieldset aria-label="Edit rule" className={forms.form + " " + styles.editor} disabled={disabled}>
      <KnowledgeEditFields draft={{ oneLine: draft.claim, text: draft.text, kind: draft.kind, scope: draft.scope }}
        onChange={({ oneLine, text, kind, scope }) => onChange({ claim: oneLine, text, kind, scope })} rows={5} summaryLabel="Claim" />
    </fieldset>
  );
}
