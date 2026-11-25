import type { ReactNode, Ref } from "react";
import { ArrowLeft, CircleCheck, CircleHelp, EyeOff, FolderGit2, Monitor, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { localDateTime } from "./local-time";
import type { MachineAgent } from "./types";
import { CopyButton } from "./ui";
import shared from "./machine.module.css";
import styles from "./agents.module.css";

type AgentFile = MachineAgent["files"][number];

const fileKinds: Record<AgentFile["kind"], string> = {
  hookConfig: "Hook config",
  rule: "Rule file",
  gitExclude: "Git exclude entry",
  agentSettings: "Agent settings",
};
const hookStates = {
  installed: { label: "Installed", icon: CircleCheck },
  missing: { label: "Missing", icon: TriangleAlert },
  unverified: { label: "Unverified", icon: CircleHelp },
};

function Hooks({ hooks }: Pick<MachineAgent, "hooks">) {
  const { canVerify, events } = hooks;
  const installed = events.filter(({ status }) => status === "installed").length;
  return (
    <section aria-labelledby="agent-hooks" className={styles.panel}>
      <header className={styles.panelHeader}>
        <h2 id="agent-hooks">Hooks</h2>
        {canVerify && events.some(({ status }) => status !== "unverified") && (
          <span>{installed} of {events.length} installed</span>
        )}
      </header>
      {!canVerify && <p className={styles.panelNote}>Can’t verify for this agent yet.</p>}
      {canVerify && events.length === 0 && <p className={styles.panelNote}>No hook events found.</p>}
      {events.length > 0 && (
        <ul className={styles.hookRows} role="list">
          {events.map(({ name, status }) => {
            const { icon: Icon, label } = hookStates[status];
            return (
              <li key={name}>
                <code>{name}</code>
                <span className={styles.hookState} data-state={status}><Icon aria-hidden="true" />{label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AgentFiles({ files }: Pick<MachineAgent, "files">) {
  const groups = new Map<string | undefined, AgentFile[]>();
  for (const file of files) {
    const group = groups.get(file.repo);
    if (group) group.push(file);
    else groups.set(file.repo, [file]);
  }
  return (
    <section aria-labelledby="agent-files" className={styles.panel}>
      <header className={styles.panelHeader}><h2 id="agent-files">Files MEX wrote</h2></header>
      {files.length === 0 && <p className={styles.panelNote}>No files recorded for this agent.</p>}
      {[...groups].map(([repo, items]) => (
        <div className={styles.fileGroup} key={repo ?? "machine"}>
          <h3>{repo ? <FolderGit2 aria-hidden="true" /> : <Monitor aria-hidden="true" />}{repo ? "In " + repo : "On this machine"}</h3>
          <ul className={styles.fileRows} role="list">
            {items.map(({ path, kind, hiddenFromGit }) => (
              <li key={path}>
                <div>
                  <code>{path}</code>
                  <div className={styles.fileMeta}>
                    <span>{fileKinds[kind]}</span>
                    {hiddenFromGit && <span><EyeOff aria-hidden="true" />Hidden from git</span>}
                  </div>
                </div>
                <CopyButton path text={path} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function AgentErrors({ errors }: Pick<MachineAgent, "errors">) {
  return (
    <section aria-labelledby="agent-errors" className={styles.panel}>
      <header className={styles.panelHeader}><h2 id="agent-errors">Recent errors</h2></header>
      {errors.length > 0 ? (
        <ul className={styles.errorRows} role="list">
          {errors.slice(0, 5).map(({ at, message }) => (
            <li key={at + message}><span>{message}</span><time dateTime={at}>{localDateTime.format(new Date(at))}</time></li>
          ))}
        </ul>
      ) : <p className={styles.panelNote}>No recent errors.</p>}
    </section>
  );
}

export function AgentDetail({ agent, overviewHref, status, action, titleRef }: {
  agent: MachineAgent;
  overviewHref: string;
  status: ReactNode;
  action?: ReactNode;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <>
      <header className={styles.detailHeader}>
        <Link className={styles.detailsLink} to={overviewHref}><ArrowLeft aria-hidden="true" />Agents</Link>
        <div className={styles.detailHeading}>
          <div className={styles.detailTitle}>
            <h1 className={shared.pageTitle} ref={titleRef} tabIndex={-1}>{agent.name}</h1>
            {status}
          </div>
          {action}
        </div>
      </header>
      {agent.trust === "needsApproval" && (
        <aside aria-label="Codex approval" className={styles.approval}>
          <TriangleAlert aria-hidden="true" />
          <div>
            <h2>Needs your approval in Codex</h2>
            <p>In Codex, run <code>/hooks</code> in the CLI or choose <strong>Review hooks</strong> beside the message box in the app. Review and trust MEX’s hooks once. Until then Codex skips them.</p>
          </div>
        </aside>
      )}
      <div className={styles.detailGrid}>
        <Hooks hooks={agent.hooks} />
        <div className={styles.detailSide}>
          <AgentFiles files={agent.files} />
          <AgentErrors errors={agent.errors} />
        </div>
      </div>
    </>
  );
}
