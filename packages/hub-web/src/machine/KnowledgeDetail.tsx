import { useCallback, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { ArrowLeft, Check, ChevronDown, Pencil, Share2, Trash2, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "../components/primitives/badge";
import { Button, buttonVariants } from "../components/primitives/button";
import { KnowledgeConflictDialog, KnowledgeEditor, type EditConflict, type EditDraft } from "./KnowledgeEditor";
import { KnowledgeForgetDialog, KnowledgeShareDialog } from "./KnowledgeItemDialogs";
import { KnowledgeReviewDialog } from "./KnowledgeReviewDialog";
import { knowledgeSaveError, useKnowledgeWrite } from "./knowledge-write-state";
import { scopePatterns } from "./knowledge-fields";
import { audienceLabels, kindLabels, scopeLabel } from "./knowledge-labels";
import { KnowledgeStatusLabel } from "./KnowledgeStatus";
import { fullDateTime, relativeTime } from "./local-time";
import type { KnowledgeDetail as Detail, KnowledgeEdit, KnowledgeForget, KnowledgeActions, KnowledgeWritePreview } from "./types";
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
      return <>You {source.edited ? "edited" : "wrote"} this{source.via === "cli" ? <> with <code>mex note</code></> : source.via === "hub" ? " in the Hub" : null} on <KnowledgeDate at={source.at} /></>;
    case "session":
      return <>Learned from your session on <KnowledgeDate at={source.at} />{source.checkedByModel && " (checked by model)"}</>;
    case "recorded":
      return <>{source.description} · <KnowledgeDate at={source.at} /></>;
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

function Checks({ checks, summary, now }: { checks: Detail["checks"]; summary: Detail["checkSummary"]; now: Date }) {
  if (!checks.length && !summary?.checkedAt) return <p>No checks. MEX can’t tell automatically if this goes out of date.</p>;
  return (
    <>
      {summary && <div className={styles.checkMeta}>
        <KnowledgeStatusLabel className={styles.status} status={summary.status} />
        {summary.checkedAt && <span>Last checked <KnowledgeDate at={summary.checkedAt} relativeTo={now} /></span>}
      </div>}
      {checks.length > 0 && <ul className={styles.checks} role="list">
        {checks.map(({ kind, target, result, checkedAt }, index) => (
          <li key={index}>
            <p className={styles.checkTarget}><span>{checkKindLabels[kind]}</span> <span aria-hidden="true">·</span> <code>{target}</code></p>
            {!summary && <div className={styles.checkMeta}>
              <KnowledgeStatusLabel className={styles.status} status={result ? checkStatuses[result] : "notChecked"} />
              {checkedAt && <span>Last checked <KnowledgeDate at={checkedAt} relativeTo={now} /></span>}
            </div>}
          </li>
        ))}
      </ul>}
    </>
  );
}

function UseSummary({ item, now }: { item: Detail; now: Date }) {
  if (!item.lastUsedAt && item.useCount30Days === 0) return <p>{item.useNote ?? "No recorded use in the last 30 days"}</p>;
  return (
    <p>Given to agents {number.format(item.useCount30Days)} {item.useCount30Days === 1 ? "time" : "times"} in the last 30 days
      {item.lastUsedAt && <> · last <KnowledgeDate at={item.lastUsedAt} relativeTo={now} /></>}
      {item.useNote && <> · {item.useNote}</>}
    </p>
  );
}

function HistoryEvent({ event }: { event: Detail["history"][number] }) {
  switch (event.type) {
    case "added": return <>Added <KnowledgeDate at={event.at} /></>;
    case "edited": return <>Edited <KnowledgeDate at={event.at} /></>;
    case "learned": return <>Learned <KnowledgeDate at={event.at} /></>;
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

function DetailSection({ title, narrow, inline, children }: { title: string; narrow: boolean; inline?: boolean; children: ReactNode }) {
  const Heading = narrow ? "h2" : "h3";
  return <div className={styles.detailSection} data-inline={inline}><Heading>{title}</Heading>{children}</div>;
}

function DetailActions({ audience, canEditHint, onEdit, onForget, onShare, editRef, forgetRef, children }: {
  audience: Detail["audience"];
  canEditHint?: boolean;
  onEdit: () => void;
  onForget: (event: MouseEvent<HTMLButtonElement>) => void;
  onShare: (event: MouseEvent<HTMLButtonElement>) => void;
  editRef: Ref<HTMLButtonElement>;
  forgetRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  const reason = useId();
  const hint = audience === "hint";
  const editDisabled = hint && !canEditHint;
  return (
    <>
      <div className={styles.actionLine}>
        <Button aria-describedby={hint ? reason : undefined} disabled={editDisabled} onClick={onEdit} ref={editRef} size="sm" type="button" variant="outline">
          <Pencil aria-hidden="true" /> Edit
        </Button>
        {audience === "onlyYou" && (
          <Button aria-haspopup="dialog" onClick={onShare} size="sm" type="button" variant="ghost"><Share2 aria-hidden="true" /> Share…</Button>
        )}
        {children}
        <Button aria-haspopup="dialog" className={styles.forgetAction} onClick={onForget} ref={forgetRef} size="sm" type="button" variant="ghost"><Trash2 aria-hidden="true" /> Forget</Button>
      </div>
      {hint && <p className={styles.actionReason} id={reason}>{canEditHint ? "Saving an edit turns this hint into a personal note." : "Edit this hint in your agent’s memory."}</p>}
    </>
  );
}

type EditReview = { type: "preview"; preview: KnowledgeWritePreview; request: KnowledgeEdit } | EditConflict;
type ForgetDraft = { request: KnowledgeForget; reason: string; preview?: KnowledgeWritePreview; error?: string };
export type KnowledgeItemAction = "edit" | "forget";

function editDraft({ key, revision, oneLine, text, kind, scope, checkout, audience }: Detail): EditDraft {
  return { key, expectedRevision: revision, oneLine, text, kind: audience === "hint" ? "rule" : kind, scope, checkout };
}

function forgetDraft({ key, revision, checkout }: Detail): ForgetDraft {
  return { request: { key, expectedRevision: revision, checkout }, reason: "" };
}

export function KnowledgeDetailPanel({ item, backHref, titleRef, knowledge, narrow, now, onForgotten, onUpdated, initialAction, canEditHint }: {
  item?: Detail;
  backHref: string;
  titleRef: Ref<HTMLHeadingElement>;
  knowledge: KnowledgeActions;
  canEditHint?: boolean;
  onUpdated: (item: Detail) => void;
  narrow: boolean;
  now: Date;
  onForgotten: () => void;
  initialAction?: KnowledgeItemAction;
}) {
  const Heading = narrow ? "h1" : "h2";
  const titleId = useId();
  const [draft, setDraft] = useState(() => item && initialAction === "edit" && (item.audience !== "hint" || canEditHint) ? editDraft(item) : null);
  const [review, setReview] = useState<EditReview | null>(null);
  const [forget, setForget] = useState(() => item && initialAction === "forget" ? forgetDraft(item) : null);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [error, setError] = useState("");
  const write = useKnowledgeWrite();
  const editAtTop = useRef(narrow);
  const restoreEdit = useRef(false);
  const topEdit = useRef<HTMLButtonElement>(null);
  const bottomEdit = useRef<HTMLButtonElement>(null);
  const save = useRef<HTMLButtonElement>(null);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const forgetTrigger = useRef<HTMLButtonElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const measureScroll = useCallback(() => {
    const panel = column.current;
    const element = scroller.current;
    if (!narrow && panel) {
      const offset = Math.ceil(panel.getBoundingClientRect().top) + "px";
      if (panel.style.getPropertyValue("--detail-offset") !== offset) panel.style.setProperty("--detail-offset", offset);
    }
    setMoreBelow(!narrow && !!element && element.scrollHeight - element.clientHeight - element.scrollTop > 1);
  }, [narrow]);

  useLayoutEffect(measureScroll);
  useLayoutEffect(() => {
    if (narrow) return;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measureScroll);
    if (scroller.current) observer?.observe(scroller.current);
    if (content.current) observer?.observe(content.current);
    window.addEventListener("scroll", measureScroll, { passive: true });
    window.addEventListener("resize", measureScroll);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", measureScroll);
      window.removeEventListener("resize", measureScroll);
    };
  }, [measureScroll, narrow]);

  const returnToTrigger = () => {
    const trigger = dialogTrigger.current ?? forgetTrigger.current;
    return trigger?.isConnected ? trigger : false;
  };

  useLayoutEffect(() => {
    if (draft || !restoreEdit.current) return;
    restoreEdit.current = false;
    (editAtTop.current && topEdit.current ? topEdit.current : bottomEdit.current)?.focus();
  }, [draft]);

  function beginEdit(atTop: boolean) {
    if (!item) return;
    editAtTop.current = atTop;
    setDraft(editDraft(item));
    setError("");
    setNotice("");
    setActionError("");
  }

  function closeEditor(message = "") {
    restoreEdit.current = true;
    setReview(null);
    setDraft(null);
    setNotice(message);
  }

  function submitEdit(request: KnowledgeEdit) {
    setError("");
    void write.run((retry) => knowledge.editNote(request, retry), (result) => {
      if (result.type === "ok") {
        closeEditor("Saved");
        onUpdated(result.item);
      } else {
        setReview(result.type === "preview" ? { type: "preview", preview: result, request } : result);
      }
    }, (error) => {
      setReview(null);
      setError(knowledgeSaveError(error, "Couldn’t save this note. Try again."));
    });
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

  function beginForget(event: MouseEvent<HTMLButtonElement>) {
    if (!item) return;
    dialogTrigger.current = event.currentTarget;
    setActionError("");
    setForget(forgetDraft(item));
  }

  function submitForget(confirmRevision?: string) {
    if (!forget) return;
    const request = { ...forget.request, reason: forget.reason.trim() || undefined, confirmRevision };
    void write.run((retry) => knowledge.forgetItem(request, retry), (result) => {
      if (result.type === "preview") setForget({ ...forget, preview: result });
      else if (result.type === "conflict") {
        setForget(null);
        setActionError("This item changed. Review it before forgetting.");
      } else {
        dialogTrigger.current = null;
        setForget(null);
        onForgotten();
      }
    }, (error) => {
      setForget({ ...forget, preview: undefined, error: knowledgeSaveError(error, "Couldn’t forget this item. Try again.") });
    });
  }

  const startShare = (event: MouseEvent<HTMLButtonElement>) => {
    dialogTrigger.current = event.currentTarget;
    setSharing(true);
  };
  const editPreview = review?.type === "preview" ? review : null;
  const retirement = forget?.preview;

  return (
    <div className={styles.detailColumn} ref={column}>
      {narrow && <Link className={`${shared.textLink} ${styles.back}`} to={backHref}><ArrowLeft aria-hidden="true" /> Knowledge</Link>}
      <section aria-labelledby={titleId} className={styles.detailCard}>
        <div className={styles.detailBody} data-more-below={moreBelow}>
          <div aria-label="Read item" className={styles.detailScroll} onScroll={measureScroll} ref={scroller} role="group" tabIndex={narrow ? undefined : 0}>
            <div ref={content}>
              <header>
                <div className={styles.detailHeader}>
                  <Heading id={titleId} ref={titleRef} tabIndex={-1}>{item?.oneLine ?? "Item unavailable"}</Heading>
                  {!narrow && (
                    <Link aria-label="Close item" className={`${buttonVariants({ size: "icon-sm", variant: "ghost" })} ${styles.closeItem}`} to={backHref}>
                      <X aria-hidden="true" />
                    </Link>
                  )}
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
                  <DetailActions audience={item.audience} canEditHint={canEditHint} editRef={topEdit} forgetRef={forgetTrigger} onEdit={() => beginEdit(true)} onForget={beginForget} onShare={startShare} />
                </div>
              )}
              {draft ? (
                <KnowledgeEditor draft={draft} error={error} pending={write.pending} status={review ? undefined : write.status} onCancel={() => closeEditor()} onChange={setDraft} onSave={saveDraft} saveRef={save} />
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
                    <DetailSection narrow={narrow} title="Checks"><Checks checks={item.checks} now={now} summary={item.checkSummary} /></DetailSection>
                    <DetailSection inline narrow={narrow} title="Use"><UseSummary item={item} now={now} /></DetailSection>
                    <DetailSection narrow={narrow} title="History"><History events={item.history} /></DetailSection>
                  </div>
                </>
              ) : (
                <p className={styles.detailText}>This item may have been forgotten or moved to another repo.</p>
              )}
            </div>
          </div>
        </div>
        {item && !draft && (
          <div className={styles.detailFooter}>
            <DetailActions audience={item.audience} canEditHint={canEditHint} editRef={bottomEdit} forgetRef={narrow ? undefined : forgetTrigger} onEdit={() => beginEdit(false)} onForget={beginForget} onShare={startShare}>
              <span className={styles.saved} role="status">{notice && <><Check aria-hidden="true" />{notice}</>}</span>
            </DetailActions>
            {actionError && <p className={styles.actionError} role="alert">{actionError}</p>}
          </div>
        )}
      </section>
      <KnowledgeReviewDialog
        finalFocus={retirement ? returnToTrigger : () => save.current ?? false}
        onCancel={() => { if (retirement) setForget(null); else setReview(null); }}
        onConfirm={() => {
          if (retirement) submitForget(retirement.revision);
          else if (editPreview) submitEdit({ ...editPreview.request, confirmRevision: editPreview.preview.revision });
        }}
        pending={write.pending}
        status={write.status}
        preview={retirement ?? editPreview?.preview ?? null}
        retiring={Boolean(retirement)}
      />
      <KnowledgeConflictDialog
        conflict={review?.type === "conflict" ? review : null}
        pending={write.pending}
        status={write.status}
        finalFocus={() => save.current ?? false}
        onCurrent={() => closeEditor("Using current note")}
        onEditAgain={editAgain}
        onKeep={() => {
          if (review?.type !== "conflict") return;
          const { confirmRevision: _previewRevision, ...attempted } = review.attempted;
          submitEdit({ ...attempted, expectedRevision: review.current.revision });
        }}
      />
      {item && (
        <KnowledgeForgetDialog
          audience={item.audience}
          error={forget?.error}
          pending={write.pending}
          status={write.status}
          finalFocus={() => retirement ? false : returnToTrigger()}
          onCancel={() => setForget(null)}
          onConfirm={() => submitForget()}
          onReason={(reason) => { if (forget) setForget({ ...forget, reason }); }}
          open={forget !== null && !retirement}
          reason={forget?.reason ?? ""}
        />
      )}
      <KnowledgeShareDialog finalFocus={returnToTrigger} onClose={() => setSharing(false)} open={sharing} />
    </div>
  );
}
