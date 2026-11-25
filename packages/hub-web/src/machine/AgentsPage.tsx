import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ArrowRight, Bot, CircleCheck, CircleMinus, Code2, Plug, ShieldAlert, Sparkle, Terminal, TriangleAlert } from "lucide-react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/primitives/tooltip";
import { HubProblemError } from "./api";
import { useAgents, useAgent, useAgentRepair, type ControlConnection } from "./data";
import { knowledgeSaveError, useKnowledgeWrite } from "./knowledge-write-state";
import { AgentDetail } from "./AgentDetail";
import { AgentRepairDialog } from "./AgentRepairDialog";
import { localDateTime, relativeTime } from "./local-time";
import type { AgentRepairPreview, AgentsPreview, MachineAgent } from "./types";
import { ControlToast, HubPageHeader, PageRequestState, type PageLoad } from "./ui";
import shared from "./machine.module.css";
import styles from "./agents.module.css";

const subtitle = "The coding agents MEX works with on this machine.";

const agentIcons: Record<MachineAgent["id"], ComponentType<{ "aria-hidden": true }>> = {
  "claude-code": Sparkle, codex: Terminal, copilot: Bot, opencode: Code2,
};
const agentStates = {
  working: { label: "Working", icon: CircleCheck },
  needsRepair: { label: "Needs repair", icon: TriangleAlert },
  needsApproval: { label: "Needs approval", icon: ShieldAlert },
  notSetUp: { label: "Not set up", icon: Plug },
  notFound: { label: "Not found", icon: CircleMinus },
};

function AgentBadge({ state }: { state: MachineAgent["state"] }) {
  const { icon: Icon, label } = agentStates[state];
  return <Badge className={styles.state} data-state={state} variant="outline"><Icon aria-hidden="true" />{label}</Badge>;
}

function AgentTime({ at }: { at: string }) {
  const date = new Date(at);
  const local = localDateTime.format(date);
  return (
    <Tooltip>
      <TooltipTrigger aria-description={local} className={styles.timeTrigger} type="button">
        <time dateTime={at}>{relativeTime(date, new Date(), true)}</time>
      </TooltipTrigger>
      <TooltipContent role="tooltip">{local}</TooltipContent>
    </Tooltip>
  );
}

function AgentFacts({ agent }: { agent: MachineAgent }) {
  const { canVerify, events } = agent.hooks;
  const missing = events.filter(({ status }) => status === "missing").length;
  const error = agent.errors[0];
  const hooks = agent.state === "notFound" || events.length === 0 ? "—"
    : !canVerify ? "Can’t verify for this agent yet"
    : events.some(({ status }) => status === "unverified") ? "Couldn’t verify"
    : missing > 0 ? "Missing " + missing + " of " + events.length : "Installed";
  const trust = agent.trust === "approved" ? "Yes" : agent.trust === "needsApproval"
    ? <>Needs your approval in Codex <span className={styles.hookHint}>(run <code>/hooks</code>)</span></> : "—";
  const facts: [string, ReactNode][] = [
    ["Hooks", hooks],
    ["Trusted", trust],
    ["Last fired", agent.lastFiredAt ? <AgentTime at={agent.lastFiredAt} /> : "—"],
    ["Last error", error ? <>{error.message} <span className={styles.errorTime}>· <AgentTime at={error.at} /></span></> : agent.detected === undefined ? "None" : "None recorded"],
  ];
  return (
    <dl className={styles.facts}>
      {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

type OpenRepair = (agent: MachineAgent, trigger: HTMLElement, fallback: () => HTMLElement | null) => void;

function RepairButton({ agent, onRepair, fallback }: {
  agent: MachineAgent;
  onRepair: OpenRepair;
  fallback: () => HTMLElement | null;
}) {
  if (agent.state !== "needsRepair" || agent.repair === "unavailable") return null;
  return (
    <Button aria-haspopup="dialog" onClick={(event) => onRepair(agent, event.currentTarget, fallback)} size="sm" type="button">Repair</Button>
  );
}

function AgentCard({ agent, search, onRepair }: { agent: MachineAgent; search: string; onRepair: OpenRepair }) {
  const details = useRef<HTMLAnchorElement>(null);
  const Icon = agentIcons[agent.id];
  return (
    <article aria-labelledby={"agent-" + agent.id} className={styles.card} data-agent-state={agent.state}>
      <header className={styles.cardHeader}>
        <div className={styles.identity}>
          <span className={styles.glyph}><Icon aria-hidden={true} /></span>
          <h2 id={"agent-" + agent.id}>{agent.name}</h2>
        </div>
        <AgentBadge state={agent.state} />
      </header>
      <AgentFacts agent={agent} />
      {agent.statusNote && <p className={styles.panelNote}>{agent.statusNote}</p>}
      <footer className={styles.cardFooter}>
        <Link aria-label={"Details for " + agent.name} className={styles.detailsLink} ref={details} to={"/agents/" + agent.id + search}>
          Details <ArrowRight aria-hidden="true" />
        </Link>
        <RepairButton agent={agent} fallback={() => details.current} onRepair={onRepair} />
      </footer>
    </article>
  );
}

export default function AgentsPage({ preview, live }: { preview?: AgentsPreview; live?: ControlConnection }) {
  return live ? <ConnectedAgents live={live} /> : <AgentsView preview={preview} />;
}

function ConnectedAgents({ live }: { live: ControlConnection }) {
  const { agent: id } = useParams();
  const overview = useAgents(live.events, !id);
  const detail = useAgent(live.events, id);
  const { prepare, repair } = useAgentRepair(live);
  const query = id ? detail : overview;
  const missing = detail.error instanceof HubProblemError && detail.error.status === 404;
  const agents = id ? detail.data?.agent ? [detail.data.agent] : missing ? [] : undefined : overview.data?.agents;

  useEffect(() => {
    if (query.error) live.reportDataError(query.error);
  }, [query.error, live.reportDataError]);

  return <AgentsView
    preview={agents ? { agents, getRepairPreview: (id, onRetry) => prepare({ id, onRetry }), repair: (preview, onRetry) => repair({ preview, onRetry }) } : undefined}
    load={{ loading: !agents && !query.error && !query.data?.issue, error: !agents && query.isError, retry: () => void query.refetch() }}
    issue={query.data?.issue} pathWarning={query.data?.pathWarning} updating={!!agents && !!query.data?.updatingSince}
  />;
}

function AgentsView({ preview, load, issue, pathWarning, updating }: {
  preview?: AgentsPreview; load?: PageLoad; issue?: string; pathWarning?: { paths: string[]; hubEntry: string }; updating?: boolean;
}) {
  const { search } = useLocation();
  const { agent: agentId } = useParams();
  const agent = preview?.agents.find(({ id }) => id === agentId);
  const [review, setReview] = useState<{ preview: AgentRepairPreview; name: string } | null>(null);
  const preparing = useKnowledgeWrite();
  const applying = useKnowledgeWrite();
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const focusAfterDialog = useRef<() => HTMLElement | false>(() => false);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const overviewHref = "/agents" + search;

  const openRepair: OpenRepair = (target, trigger, fallback) => {
    if (!preview || applying.pending) return;
    focusAfterDialog.current = () => trigger.isConnected ? trigger : fallback() ?? false;
    setError("");
    setPreviewError("");
    setToast("");
    void preparing.run(retry => preview.getRepairPreview(target.id, retry), (next) => {
      if (next) setReview({ preview: next, name: target.name });
    }, error => setPreviewError(knowledgeSaveError(error, "Couldn’t prepare the repair. Try again.")));
  };

  function confirmRepair() {
    if (!preview || review?.preview.type !== "browser") return;
    setError("");
    const approved = review.preview;
    void applying.run(retry => preview.repair(approved, retry), ({ agent }) => {
      setReview(null);
      setToast(agent.state === "working" ? agent.name + " is working again" : agent.name + " hooks updated");
    }, error => setError(knowledgeSaveError(error, "Couldn’t repair the hooks. Open the preview again to retry.")));
  }

  if (agentId && !agent && preview) {
    return (
      <div className={styles.page}>
        <HubPageHeader title="Agent not found" subtitle="Choose a supported agent to see its details." />
        <Link className={shared.textLink} to={overviewHref}>Back to Agents</Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {agent ? (
        <AgentDetail
          action={<RepairButton agent={agent} fallback={() => detailTitle.current} onRepair={openRepair} />}
          agent={agent}
          overviewHref={overviewHref}
          status={<AgentBadge state={agent.state} />}
          titleRef={detailTitle}
        />
      ) : (
        <>
          <HubPageHeader title="Agents" subtitle={subtitle} />
          {preview ? (
            <TooltipProvider delay={250}>
              <div className={styles.grid}>
                {preview.agents.map((item) => <AgentCard agent={item} key={item.id} onRepair={openRepair} search={search} />)}
              </div>
            </TooltipProvider>
          ) : <PageRequestState name="Agents" {...load} />}
        </>
      )}
      {preparing.pending && <p className={shared.muted} role="status">{preparing.status ?? "Preparing repair…"}</p>}
      {previewError && <p role="alert">{previewError}</p>}
      {updating && <p className={shared.muted} role="status">Updating agent status…</p>}
      {issue && <p className={shared.muted} role="status">{issue}</p>}
      {pathWarning && (
        <aside aria-label="MEX on PATH" className={styles.approval}>
          <TriangleAlert aria-hidden="true" />
          <div>
            <h2>Another mex is first on PATH</h2>
            <p>This Hub runs from <code>{pathWarning.hubEntry}</code>. These are the matches on PATH, in order.</p>
            <ol>{pathWarning.paths.map(path => <li key={path}><code>{path}</code></li>)}</ol>
          </div>
        </aside>
      )}
      <AgentRepairDialog
        error={error}
        finalFocus={() => focusAfterDialog.current()}
        name={review?.name}
        onClose={() => setReview(null)}
        onConfirm={() => void confirmRepair()}
        pending={applying.pending}
        progress={applying.status}
        preview={review?.preview ?? null}
      />
      <ControlToast dismissLabel="Dismiss repair message" message={toast} onDismiss={() => setToast("")} />
    </div>
  );
}
