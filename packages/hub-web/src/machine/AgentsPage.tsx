import type { ComponentType, ReactNode } from "react";
import { ArrowRight, Bot, CircleCheck, CircleMinus, Code2, Plug, Sparkle, Terminal, TriangleAlert } from "lucide-react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Badge } from "../components/primitives/badge";
import { AgentDetail } from "./AgentDetail";
import { localDateTime, relativeTime } from "./local-time";
import type { AgentsPreview, MachineAgent } from "./types";
import { HubPageHeader } from "./ui";
import shared from "./machine.module.css";
import styles from "./agents.module.css";

const subtitle = "The coding agents MEX works with on this machine.";

const agentIcons: Record<MachineAgent["id"], ComponentType<{ "aria-hidden": true }>> = {
  "claude-code": Sparkle, codex: Terminal, copilot: Bot, opencode: Code2,
};
const agentStates = {
  working: { label: "Working", icon: CircleCheck },
  needsRepair: { label: "Needs repair", icon: TriangleAlert },
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
  return <time aria-label={local} dateTime={at} title={local}>{relativeTime(date, new Date(), true)}</time>;
}

function AgentFacts({ agent }: { agent: MachineAgent }) {
  const { canVerify, events } = agent.hooks;
  const missing = events.filter(({ status }) => status === "missing").length;
  const error = agent.errors[0];
  const hooks = !canVerify ? "Can’t verify for this agent yet"
    : events.length === 0 ? "—"
    : events.some(({ status }) => status === "unverified") ? "Couldn’t verify"
    : missing > 0 ? "Missing " + missing + " of " + events.length : "Installed";
  const trust = agent.trust === "approved" ? "Yes" : agent.trust === "needsApproval"
    ? <>Needs your approval in Codex (run <code>/hooks</code>)</> : "—";
  const facts: [string, ReactNode][] = [
    ["Hooks", hooks],
    ["Trusted", trust],
    ["Last fired", agent.lastFiredAt ? <AgentTime at={agent.lastFiredAt} /> : "—"],
    ["Last error", error ? <>{error.message} <span className={styles.errorTime}>· <AgentTime at={error.at} /></span></> : "None"],
  ];
  return (
    <dl className={styles.facts}>
      {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

function AgentCard({ agent, search }: { agent: MachineAgent; search: string }) {
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
      <footer className={styles.cardFooter}>
        <Link aria-label={"Details for " + agent.name} className={styles.detailsLink} to={"/agents/" + agent.id + search}>
          Details <ArrowRight aria-hidden="true" />
        </Link>
      </footer>
    </article>
  );
}

export default function AgentsPage({ preview }: { preview?: AgentsPreview }) {
  const { search } = useLocation();
  const { agent: agentId } = useParams();
  const agent = preview?.agents.find(({ id }) => id === agentId);
  if (agent) {
    return (
      <div className={styles.page}>
        <AgentDetail agent={agent} overviewHref={"/agents" + search} status={<AgentBadge state={agent.state} />} />
      </div>
    );
  }
  if (agentId && preview) {
    return (
      <div className={styles.page}>
        <HubPageHeader title="Agent not found" subtitle="Choose a supported agent to see its details." />
        <Link className={shared.textLink} to={"/agents" + search}>Back to Agents</Link>
      </div>
    );
  }
  return (
    <div className={styles.page}>
      <HubPageHeader title="Agents" subtitle={subtitle} />
      {preview ? (
        <div className={styles.grid}>
          {preview.agents.map((agent) => <AgentCard agent={agent} key={agent.id} search={search} />)}
        </div>
      ) : <p className={shared.muted} role="status">Agent details aren’t available in this Hub yet.</p>}
    </div>
  );
}
