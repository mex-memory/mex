import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from "react";
import type { MachineKnowledgeBrief, MachineKnowledgeBriefRequest, MachineProject } from "@mex/hub-contracts/machine";
import { Button } from "../components/primitives/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/primitives/dialog";
import { Input } from "../components/primitives/input";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { KnowledgeRuleFiles } from "./KnowledgeRules";
import { CheckoutField } from "./knowledge-fields";
import { audienceLabels, ruleAgentLabels } from "./knowledge-labels";
import type { KnowledgeToolsPreview } from "./types";
import styles from "./knowledge-brief.module.css";
import fields from "./knowledge-forms.module.css";
import page from "./knowledge.module.css";
import shared from "./machine.module.css";

const number = new Intl.NumberFormat();
const agents = ["claude-code", "codex"] as const;
const levelLabels = { personal: audienceLabels.onlyYou, team: audienceLabels.team, "rule-file": "Rule file", hint: audienceLabels.hint };
const verdictLabels = { held: "Up to date", changed: "Code changed", broken: "Out of date", unknown: "Not checked" };

function BriefResult({ preview, titleRef }: { preview: MachineKnowledgeBrief; titleRef: Ref<HTMLHeadingElement> }) {
  const titleId = useId();
  const itemsId = useId();
  const { text, tokenBound, tokenLimit, items, coverage } = preview;
  return (
    <div className={styles.result}>
      <section aria-labelledby={titleId}>
        <div className={styles.resultHeader}>
          <h3 id={titleId} ref={titleRef} tabIndex={-1}>What the agent gets</h3>
          <p className={styles.tokens}>Estimated tokens <strong>{number.format(tokenBound)} / {number.format(tokenLimit)}</strong></p>
        </div>
        <div aria-hidden="true" className={styles.tokenTrack}>
          <span style={{ width: `${Math.min(100, tokenBound / tokenLimit * 100)}%` }} />
        </div>
        <pre className={styles.text}><code>{text}</code></pre>
      </section>
      <section aria-labelledby={itemsId}>
        <h3 id={itemsId}>Included items ({number.format(items.length)})</h3>
        {items.length === 0 ? <p className={shared.muted}>No entries in this brief.</p> : (
          <ul aria-labelledby={itemsId} className={styles.items} role="list">
            {items.map(({ id, line, level, verdict, tokens }) => (
              <li key={`${level}:${id}`}>
                <div>
                  <p>{line.replace(/^\[[^\]\n]+\] /u, "")}</p>
                  <p className={styles.itemMeta}>{levelLabels[level]} · {verdictLabels[verdict]} · <code>{id}</code></p>
                </div>
                <span className={styles.itemMeta}>{number.format(tokens)} tokens</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {coverage.files.length > 0 && (
        <details className={styles.coverage}>
          <summary>Rule file coverage ({number.format(coverage.files.length)})</summary>
          <KnowledgeRuleFiles files={coverage.files} />
        </details>
      )}
    </div>
  );
}

interface BriefProps {
  project?: MachineProject;
  projects: readonly MachineProject[];
  preferredRepo?: string;
  previewBrief: KnowledgeToolsPreview["previewBrief"];
}

type PreviewState = { type: "pending" } | { type: "ready"; preview: MachineKnowledgeBrief } | { type: "error"; message: string };

function BriefForm({ project, projects, preferredRepo, previewBrief, initialFocus }: BriefProps & { initialFocus: Ref<HTMLSelectElement> }) {
  const [repoId, setRepoId] = useState(project?.id ?? preferredRepo ?? "");
  const [selectedCheckout, setCheckout] = useState("");
  const [agent, setAgent] = useState<MachineKnowledgeBriefRequest["agent"]>("claude-code");
  const [path, setPath] = useState("");
  const [state, setState] = useState<PreviewState>();
  const pending = useRef<AbortController | null>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const resultTitle = useRef<HTMLHeadingElement>(null);
  const repoIdField = useId();
  const agentId = useId();
  const pathId = useId();
  const statusId = useId();

  const repo = project ?? projects.find(({ id }) => id === repoId);
  const checkouts = repo?.checkouts.filter(({ exists }) => exists).map(({ path }) => path) ?? [];
  const checkout = checkouts.includes(selectedCheckout) ? selectedCheckout : checkouts[0];
  const showRepo = !project && projects.length > 0;
  let disabledReason: string | undefined;
  if (state?.type === "pending") disabledReason = "Generating preview…";
  else if (!checkout) {
    if (repo) disabledReason = "The checkout folder is missing.";
    else disabledReason = showRepo ? "Choose a repo to preview a brief." : "Register a repo to preview a brief.";
  }

  useEffect(() => () => pending.current?.abort(), []);
  useLayoutEffect(() => {
    if (state?.type === "ready" && document.activeElement === submit.current) resultTitle.current?.focus();
  }, [state]);

  function clearPreview() {
    pending.current?.abort();
    pending.current = null;
    setState(undefined);
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repo || !checkout || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState({ type: "pending" });
    try {
      const preview = await previewBrief({ repoId: repo.id, checkout, agent, path: path.trim() || undefined }, controller.signal);
      if (!controller.signal.aborted) setState({ type: "ready", preview });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Couldn’t preview the brief. Try again.";
      setState({ type: "error", message });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  return (
    <>
      <form className={fields.form} onSubmit={preview}>
        {(showRepo || checkout) && (
          <div className={styles.scope}>
            {showRepo && (
              <div className={fields.field}>
                <label htmlFor={repoIdField}>Repo</label>
                <NativeSelect className={fields.select} id={repoIdField} onChange={(event) => {
                  setRepoId(event.target.value);
                  setCheckout("");
                  clearPreview();
                }} ref={initialFocus} value={repoId}>
                  <NativeSelectOption value="">Choose a repo</NativeSelectOption>
                  {projects.map(({ id, name }) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
                </NativeSelect>
              </div>
            )}
            {checkouts.length > 1 && <CheckoutField onChange={(path) => { setCheckout(path); clearPreview(); }} path={checkout} paths={checkouts} />}
            {checkouts.length === 1 && <p className={shared.muted}><span className={shared.srOnly}>Checkout </span><code>{checkout}</code></p>}
          </div>
        )}
        <div className={styles.controls}>
          <div className={fields.field}>
            <label htmlFor={agentId}>Agent</label>
            <NativeSelect className={fields.select} id={agentId} onChange={(event) => {
              setAgent(event.target.value as MachineKnowledgeBriefRequest["agent"]);
              clearPreview();
            }} ref={showRepo ? undefined : initialFocus} value={agent}>
              {agents.map((agent) => <NativeSelectOption key={agent} value={agent}>{ruleAgentLabels[agent]}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <div className={fields.field}>
            <label htmlFor={pathId}>Path <span>(optional)</span></label>
            <Input id={pathId} maxLength={4096} onChange={(event) => { setPath(event.target.value); clearPreview(); }} placeholder="Whole repo" value={path} />
          </div>
          <Button aria-describedby={disabledReason ? statusId : undefined} disabled={Boolean(disabledReason)} focusableWhenDisabled ref={submit} type="submit">Preview</Button>
        </div>
        <p className={fields.help} hidden={!disabledReason} id={statusId} role="status">{disabledReason}</p>
        {state?.type === "error" && <p className={`${fields.error} ${styles.error}`} role="alert">{state.message}</p>}
      </form>
      {state?.type === "ready" && <BriefResult preview={state.preview} titleRef={resultTitle} />}
    </>
  );
}

export function KnowledgeBrief(props: BriefProps) {
  const initialFocus = useRef<HTMLSelectElement>(null);
  return (
    <Dialog>
      <DialogTrigger render={<Button className={page.addButton} type="button" variant="outline" />}>Preview brief</DialogTrigger>
      <DialogContent className={`${fields.dialog} ${fields.wideDialog} ${styles.dialog}`} initialFocus={initialFocus}>
        <DialogHeader><DialogTitle>Preview brief</DialogTitle></DialogHeader>
        <BriefForm {...props} initialFocus={initialFocus} />
      </DialogContent>
    </Dialog>
  );
}
