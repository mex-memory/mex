import { useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowLeft, Check, ChevronDown, Pencil, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import { KnowledgeConflictDialog, KnowledgeEditor, type EditConflict, type EditDraft } from "./KnowledgeEditor";
import { KnowledgeReviewDialog } from "./KnowledgeReviewDialog";
import { scopePatterns } from "./knowledge-fields";
import { audienceLabels, kindLabels, scopeLabel } from "./knowledge-labels";
import { KnowledgeStatusLabel } from "./KnowledgeStatus";
import { fullDateTime, relativeTime } from "./local-time";
import type { KnowledgeDetail as Detail, KnowledgeEdit, KnowledgePreview, KnowledgeWritePreview } from "./types";
import styles from "./knowledge.module.css";
import shared from "./machine.module.css";

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const number = new Intl.NumberFormat();

export function KnowledgeDate({ at, relativeTo }: { at: string; relativeTo?: Date }) {
  const date = new Date(at);
  return (
    <time dateTime={at} title={fullDateTime.format(date)}>
      {relativeTo ? relativeTime(date, relativeTo) : dayMonth.format(date)}
    </time>
  );
}

function SourceDescription({ source }: { source: Detail["source"] }) {
  switch (source.type) {
    case "note":
      return <>You {source.edited ? "edited" : "wrote"} this {source.via === "cli" ? <>with <code>mex note</code></> : "in the Hub"} on <KnowledgeDate at={source.at} /></>;
    case "session":
      return <>Learned from your session on <KnowledgeDate at={source.at} />{source.checkedByModel && " (checked by model)"}</>;
    case "team":
      return <>From the team file <code>{source.path}</code></>;
    case "agent-memory":
      return <>Your agent’s memory ({source.agent}), seen {number.format(source.observations)} {source.observations === 1 ? "time" : "times"}</>;
  }
}

const checkKindLabels = {
  key: "Config key", command: "Command", section: "Section", source: "Source file",
  value: "Value", symbol: "Symbol", "legacy-grounding": "Code reference", pattern: "Pattern", relation: "Code relationship",
};
const checkStatuses = { held: "upToDate", changed: "codeChanged", broken: "outOfDate" } as const;

function Checks({ checks, now }: { checks: Detail["checks"]; now: Date }) {
  if (!checks.length) return <p>No checks. MEX can’t tell automatically if this goes out of date.</p>;
  return (
    <ul className={styles.checks} role="list">
      {checks.map(({ kind, target, result, checkedAt }, index) => (
        <li key={index}>
          <p className={styles.checkTarget}><span>{checkKindLabels[kind]}</span> <span aria-hidden="true">·</span> <code>{target}</code></p>
          <div className={styles.checkMeta}>
            <KnowledgeStatusLabel className={styles.status} status={result ? checkStatuses[result] : "notChecked"} />
            {checkedAt && <span>Last checked <KnowledgeDate at={checkedAt} relativeTo={now} /></span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function UseSummary({ item, now }: { item: Detail; now: Date }) {
  if (!item.lastUsedAt && item.useCount30Days === 0) return <p>Not used yet</p>;
  return (
    <p>Given to agents {number.format(item.useCount30Days)} {item.useCount30Days === 1 ? "time" : "times"} in the last 30 days
      {item.lastUsedAt && <> · last <KnowledgeDate at={item.lastUsedAt} relativeTo={now} /></>}
    </p>
  );
}

function HistoryEvent({ event }: { event: Detail["history"][number] }) {
  switch (event.type) {
    case "added": return <>Added <KnowledgeDate at={event.at} /></>;
    case "edited": return <>Edited <KnowledgeDate at={event.at} /></>;
    case "model-check": return <>Checked by model: {event.outcome}, <KnowledgeDate at={event.at} /></>;
    case "git": return <>{event.action === "added" ? "Added" : "Edited"} by {event.actor} in <code>{event.sha}</code>, <KnowledgeDate at={event.at} /></>;
  }
}

function History({ events }: { events: Detail["history"] }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const sorted = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!sorted.length) return <p>No history yet</p>;

  return (
    <>
      <ol className={styles.history} id={listId} role="list">
        {sorted.slice(0, expanded ? sorted.length : 5).map((event, index) => <li key={index}><HistoryEvent event={event} /></li>)}
      </ol>
      {sorted.length > 5 && (
        <Button aria-controls={listId} aria-expanded={expanded} className={styles.showHistory} onClick={() => setExpanded(!expanded)} size="sm" variant="link">
          {expanded ? "Show less" : "Show all"} <ChevronDown aria-hidden="true" />
        </Button>
      )}
    </>
  );
}

function DetailSection({ title, narrow, children }: { title: string; narrow: boolean; children: ReactNode }) {
  const Heading = narrow ? "h2" : "h3";
  return <div className={styles.detailSection}><Heading>{title}</Heading>{children}</div>;
}

function EditAction({ hint, onEdit, buttonRef }: { hint: boolean; onEdit: () => void; buttonRef: Ref<HTMLButtonElement> }) {
  const reason = useId();
  return (
    <div className={styles.editAction}>
      <Button aria-describedby={hint ? reason : undefined} disabled={hint} onClick={onEdit} ref={buttonRef} size="sm" type="button" variant="outline">
        <Pencil aria-hidden="true" /> Edit
      </Button>
      {hint && <p id={reason}>Edit this hint in your agent’s memory.</p>}
    </div>
  );
}

type EditReview = { type: "preview"; preview: KnowledgeWritePreview; request: KnowledgeEdit } | EditConflict;

export function KnowledgeDetailPanel({ item, backHref, titleRef, knowledge, narrow, now }: {
  item?: Detail;
  backHref: string;
  titleRef: Ref<HTMLHeadingElement>;
  knowledge: KnowledgePreview;
  narrow: boolean;
  now: Date;
}) {
  const Heading = narrow ? "h1" : "h2";
  const titleId = useId();
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [review, setReview] = useState<EditReview | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const editAtTop = useRef(false);
  const restoreEdit = useRef(false);
  const topEdit = useRef<HTMLButtonElement>(null);
  const bottomEdit = useRef<HTMLButtonElement>(null);
  const save = useRef<HTMLButtonElement>(null);
  const hint = item?.audience === "hint";

  useLayoutEffect(() => {
    if (draft || !restoreEdit.current) return;
    restoreEdit.current = false;
    (editAtTop.current && topEdit.current ? topEdit.current : bottomEdit.current)?.focus();
  }, [draft]);

  function beginEdit(atTop: boolean) {
    if (!item) return;
    editAtTop.current = atTop;
    const { key, revision, oneLine, text, kind, scope } = item;
    setDraft({ key, expectedRevision: revision, oneLine, text, kind, scope });
    setError("");
    setNotice("");
  }

  function closeEditor(message = "") {
    restoreEdit.current = true;
    setReview(null);
    setDraft(null);
    setNotice(message);
  }

  function submitEdit(request: KnowledgeEdit) {
    setError("");
    try {
      const result = knowledge.editNote(request);
      if (result.type === "ok") {
        closeEditor("Saved");
      } else {
        setReview(result.type === "preview" ? { type: "preview", preview: result, request } : result);
      }
    } catch {
      setReview(null);
      setError("Couldn’t save this note. Try again.");
    }
  }

  function saveDraft() {
    if (!draft) return;
    const oneLine = draft.oneLine.trim();
    const text = draft.text.trim();
    if (!oneLine || !text) {
      setError("Enter a summary and note text.");
      return;
    }
    submitEdit({ ...draft, oneLine, text, scope: scopePatterns(draft.scope) });
  }

  function editAgain() {
    if (review?.type !== "conflict" || !draft) return;
    setDraft({ ...draft, expectedRevision: review.current.revision });
    setReview(null);
  }

  return (
    <div className={styles.detailColumn}>
      <Link className={`${shared.textLink} ${styles.back}`} to={backHref}><ArrowLeft aria-hidden="true" /> Knowledge</Link>
      <section aria-labelledby={titleId} className={styles.detailCard}>
        <div className={styles.detailScroll} tabIndex={narrow ? undefined : 0}>
          <header>
            <div className={styles.detailHeader}>
              <Heading id={titleId} ref={titleRef} tabIndex={-1}>{item?.oneLine ?? "Item unavailable"}</Heading>
              <Button aria-label="Close item" className={styles.closeItem} render={<Link to={backHref} />} nativeButton={false} size="icon-sm" variant="ghost">
                <X aria-hidden="true" />
              </Button>
            </div>
            {item && (
              <ul aria-label="Item details" className={styles.chips} role="list">
                <li><Badge variant="outline">{kindLabels[item.kind]}</Badge></li>
                <li><Badge variant="outline">{audienceLabels[item.audience]}</Badge></li>
                <li><Badge variant="outline"><KnowledgeStatusLabel className={styles.status} status={item.status} /></Badge></li>
                <li><Badge variant="outline"><span>Applies to</span> {scopeLabel(item.scope)}</Badge></li>
              </ul>
            )}
          </header>
          {narrow && item && !draft && (
            <div className={styles.mobileActions}>
              <EditAction buttonRef={topEdit} hint={hint} onEdit={() => beginEdit(true)} />
            </div>
          )}
          {draft ? (
            <KnowledgeEditor draft={draft} error={error} onCancel={() => closeEditor()} onChange={setDraft} onSave={saveDraft} saveRef={save} />
          ) : item ? (
            <>
              <div className={styles.detailText}>
                {item.text.split(/\r?\n[\t ]*\r?\n/u).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
              </div>
              <div className={styles.detailSections}>
                <DetailSection narrow={narrow} title="Why MEX knows this">
                  <p><SourceDescription source={item.source} /></p>
                  {item.evidence && <blockquote>{item.evidence}</blockquote>}
                </DetailSection>
                <DetailSection narrow={narrow} title="Checks"><Checks checks={item.checks} now={now} /></DetailSection>
                <DetailSection narrow={narrow} title="Use"><UseSummary item={item} now={now} /></DetailSection>
                <DetailSection narrow={narrow} title="History"><History events={item.history} /></DetailSection>
              </div>
            </>
          ) : (
            <p className={styles.detailText}>This item may have been forgotten or moved to another repo.</p>
          )}
        </div>
        {item && !draft && (
          <footer className={styles.detailFooter}>
            <EditAction buttonRef={bottomEdit} hint={hint} onEdit={() => beginEdit(false)} />
            <span className={styles.saved} role="status">{notice && <><Check aria-hidden="true" />{notice}</>}</span>
          </footer>
        )}
      </section>
      <KnowledgeReviewDialog
        finalFocus={() => save.current ?? false}
        onCancel={() => setReview(null)}
        onConfirm={() => {
          if (review?.type === "preview") submitEdit({ ...review.request, confirmRevision: review.preview.revision });
        }}
        preview={review?.type === "preview" ? review.preview : null}
      />
      <KnowledgeConflictDialog
        conflict={review?.type === "conflict" ? review : null}
        finalFocus={() => save.current ?? false}
        onCurrent={() => closeEditor("Using current note")}
        onEditAgain={editAgain}
        onKeep={() => {
          if (review?.type !== "conflict") return;
          const { confirmRevision: _previewRevision, ...attempted } = review.attempted;
          submitEdit({ ...attempted, expectedRevision: review.current.revision });
        }}
      />
    </div>
  );
}
