import { useId, useLayoutEffect, useRef } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "../components/primitives/button";
import { Input } from "../components/primitives/input";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { Textarea } from "../components/primitives/textarea";
import { kindLabels } from "./knowledge-labels";
import type { KnowledgeKind } from "./types";
import styles from "./knowledge-forms.module.css";

type EditableNote = { oneLine: string; text: string; kind: KnowledgeKind; scope: string[] };

export function KnowledgeEditFields<T extends EditableNote>({ draft, onChange, summaryLabel = "One-line summary", rows = 6 }: {
  draft: T;
  onChange: (draft: T) => void;
  summaryLabel?: string;
  rows?: number;
}) {
  const summaryId = useId();
  const textId = useId();
  const summary = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { summary.current?.focus(); }, []);

  return (
    <>
      <div className={styles.field}>
        <label htmlFor={summaryId}>{summaryLabel}</label>
        <Input id={summaryId} maxLength={1024} onChange={(event) => onChange({ ...draft, oneLine: event.target.value })} ref={summary} required value={draft.oneLine} />
      </div>
      <div className={styles.field}>
        <label htmlFor={textId}>Note text</label>
        <Textarea id={textId} maxLength={8192} onChange={(event) => onChange({ ...draft, text: event.target.value })} required rows={rows} value={draft.text} />
      </div>
      <KindSelect kind={draft.kind} onChange={(kind) => onChange({ ...draft, kind })} />
      <ScopeInputs onChange={(scope) => onChange({ ...draft, scope })} patterns={draft.scope} />
    </>
  );
}

export function KindSelect({ kind, onChange }: { kind: KnowledgeKind; onChange: (kind: KnowledgeKind) => void }) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>Kind</label>
      <NativeSelect className={styles.select} id={id} onChange={(event) => onChange(event.target.value as KnowledgeKind)} value={kind}>
        {Object.entries(kindLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
      </NativeSelect>
    </div>
  );
}

export function scopePatterns(patterns: string[]) {
  const cleaned = [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))];
  return cleaned.length ? cleaned : ["**"];
}

export function ScopeInputs({ patterns, onChange }: { patterns: string[]; onChange: (patterns: string[]) => void }) {
  const fields = useRef<HTMLFieldSetElement>(null);
  const focusIndex = useRef<number | null>(null);
  const hint = useId();
  const wholeRepo = patterns.length === 1 && patterns[0] === "**";

  useLayoutEffect(() => {
    if (focusIndex.current === null) return;
    fields.current?.querySelectorAll("input")[focusIndex.current]?.focus();
    focusIndex.current = null;
  }, [patterns]);

  return (
    <fieldset className={styles.scopeFields} ref={fields}>
      <legend>Applies to</legend>
      <div className={styles.patterns}>
        {patterns.map((pattern, index) => (
          <div className={styles.pattern} key={index}>
            <Input
              aria-describedby={hint}
              aria-label={`Scope pattern ${index + 1}`}
              maxLength={512}
              onChange={(event) => onChange(patterns.map((value, i) => i === index ? event.target.value : value))}
              placeholder={patterns.length === 1 ? "Whole repo" : "apps/api/**"}
              value={wholeRepo ? "" : pattern}
            />
            {(pattern && !wholeRepo || patterns.length > 1) && (
              <Button
                aria-label={`Remove pattern ${index + 1}`}
                onClick={() => {
                  const rest = patterns.filter((_, i) => i !== index);
                  focusIndex.current = Math.max(0, Math.min(index, rest.length - 1));
                  onChange(rest.length ? rest : [""]);
                }}
                size="icon-xs"
                type="button"
                variant="ghost"
              ><X aria-hidden="true" /></Button>
            )}
          </div>
        ))}
        {patterns.length < 32 && (
          <Button
            onClick={() => {
              const existing = wholeRepo ? [] : patterns.filter(Boolean);
              focusIndex.current = existing.length;
              onChange([...existing, ""]);
            }}
            size="sm"
            type="button"
            variant="ghost"
          ><Plus aria-hidden="true" /> Add pattern</Button>
        )}
      </div>
      <p className={styles.help} id={hint}>Use repo-relative patterns like <code>apps/api/**</code>.</p>
    </fieldset>
  );
}
