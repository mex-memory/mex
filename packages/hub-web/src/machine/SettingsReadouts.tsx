import { useState } from "react";
import { Archive, CalendarClock, CircleCheck, CircleMinus, Lightbulb, Shield, Sparkles, Info } from "lucide-react";
import { Button } from "../components/primitives/button";
import { formatLocalClock, localDateTime, localShortDate } from "./local-time";
import { SettingRow, SettingsSection, ToggleSetting, type SettingsEdits } from "./SettingsControls";
import type { MachineOutbound, MachineSettings, MachineStorage } from "./types";
import { CommandCard, CopyButton } from "./ui";
import { UsageMeter } from "./UsageMeter";
import shared from "./machine.module.css";
import styles from "./settings.module.css";

const number = new Intl.NumberFormat();
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function storageSize(bytes: number) {
  if (bytes >= 1_000_000_000) return decimal.format(bytes / 1_000_000_000) + " GB";
  if (bytes >= 1_000_000) return decimal.format(bytes / 1_000_000) + " MB";
  if (bytes >= 1_000) return decimal.format(bytes / 1_000) + " KB";
  return number.format(bytes) + " B";
}

function ShortDate({ at }: { at: string }) {
  const date = new Date(at);
  return <time dateTime={at} title={localDateTime.format(date)}>{localShortDate.format(date)}</time>;
}

export function AISettings({ ai, repos }: Pick<MachineSettings, "ai" | "repos">) {
  return (
    <SettingsSection icon={Sparkles} id="ai-use" title="AI use">
      <div className={styles.usage}>
        <div className={styles.usageValue}>
          <div>
            <h3 title="The last seven UTC calendar days">This week’s share</h3>
            <p>{ai.percent === null ? "Share of your usage unknown" : "Estimated from your agent’s usage"}</p>
          </div>
          <strong>{ai.percent === null ? "—" : decimal.format(ai.percent) + "%"}</strong>
        </div>
        <UsageMeter week={ai} />
        <p>Automatic AI work stays under {decimal.format(ai.capPercent)}% of your usage. The cap isn’t editable in this version.</p>
      </div>
      <h3 className={styles.rowGroup}>Learn deeper weekly schedule</h3>
      {repos.length === 0 && <p className={styles.sectionNote}>No registered repos.</p>}
      {repos.map(({ id, name, weekly, weeklyUnavailable }) => (
        <SettingRow description={weekly ? "Runs when this machine is idle." : weeklyUnavailable ? "The saved schedule couldn’t be read." : "No weekly run is scheduled."} key={id} title={name}>
          {weekly ? (
            <span className={styles.inlineValue}>
              <CalendarClock aria-hidden="true" /><span>Next run around <ShortDate at={weekly.nextRunAt} /></span>
            </span>
          ) : <span className={styles.inlineValue}><CircleMinus aria-hidden="true" />{weeklyUnavailable ? "Unavailable" : "Off"}</span>}
        </SettingRow>
      ))}
      <div className={styles.commandFoot}>
        <p>Use this command for a one-time run. Existing weekly schedules stay in place.</p>
        <CommandCard command="mex learn --no-weekly" compact />
      </div>
    </SettingsSection>
  );
}

const sentEventLabels: Record<string, string> = {
  daily: "Daily usage",
  "setup.finished": "Setup finished",
  "install.first_run": "First run",
};

function OutboundHistory({ outbound, live }: { outbound: MachineOutbound; live?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const initialRows = 3;
  const canExpand = outbound.telemetry.length > initialRows || outbound.modelCalls.length > initialRows;
  const telemetry = expanded ? outbound.telemetry : outbound.telemetry.slice(0, initialRows);
  const modelCalls = expanded ? outbound.modelCalls : outbound.modelCalls.slice(0, initialRows);
  return (
    <div className={styles.outbound}>
      <header>
        <h3>What MEX sent</h3>
        <p>The Hub itself sends nothing.</p>
        {live && <p>GitHub fetch history is unavailable. Run <code>mex telemetry inspect</code> to see the values sent in telemetry reports.</p>}
      </header>
      <div className={styles.historyTables} id="outbound-history">
        <table className={styles.reportTable}>
          <caption>Recent telemetry reports</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Report and fields sent</th></tr></thead>
          <tbody>
            {telemetry.map(({ id, at, event, fields }) => (
              <tr key={id}>
                <td><ShortDate at={at} /></td>
                <td><strong>{sentEventLabels[event] ?? event}</strong><code>{fields.join(", ")}</code></td>
              </tr>
            ))}
            {telemetry.length === 0 && <tr><td colSpan={2}>No telemetry reports recorded.</td></tr>}
          </tbody>
        </table>
        <table className={styles.modelTable}>
          <caption>Recent model calls</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Purpose</th><th scope="col">Tokens</th><th scope="col">Agent</th></tr></thead>
          <tbody>
            {modelCalls.map(({ id, at, purpose, tokens, agent, estimated }) => (
              <tr key={id}>
                <td><ShortDate at={at} /></td>
                <td>{purpose}</td>
                <td>{estimated && <><span aria-hidden="true">≈</span><span className={shared.srOnly}>Estimated </span></>}{number.format(tokens)}</td>
                <td>{agent}</td>
              </tr>
            ))}
            {modelCalls.length === 0 && <tr><td colSpan={4}>No model calls recorded.</td></tr>}
          </tbody>
        </table>
      </div>
      {canExpand && (
        <Button aria-controls="outbound-history" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} size="sm" type="button" variant="outline">
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

export function PrivacySettings({ telemetry, outbound, edits, live }: Pick<MachineSettings, "telemetry" | "outbound"> & { edits: SettingsEdits; live?: boolean }) {
  return (
    <SettingsSection icon={Shield} id="privacy" title="Privacy">
      <ToggleSetting disabled={edits.disabled} description="Send anonymous usage counts to help improve MEX." onChange={(enabled) => edits.save("telemetry", { type: "telemetry", enabled })}
        saved={edits.savedFor("telemetry")} setting={telemetry} title="Telemetry" />
      <OutboundHistory live={live} outbound={outbound} />
    </SettingsSection>
  );
}

export function HintsSettings({ hints }: Pick<MachineSettings, "hints">) {
  return (
    <SettingsSection icon={Lightbulb} id="hints" title="Hints from your agent">
      <dl className={styles.hintCounts}>
        <div><dt>Active hints</dt><dd>{hints.active === null ? "Unavailable" : number.format(hints.active)}</dd></div>
        <div><dt>Confirmed</dt><dd>{hints.confirmed === null ? "Unavailable" : number.format(hints.confirmed)}</dd></div>
      </dl>
      <SettingRow description="Unconfirmed hints expire after this long." title="Hint expiry">
        <strong className={styles.readOnlyValue}>{hints.expiryMonths === null ? (hints.repos?.length ? "Per repo" : "Unavailable") : hints.expiryMonths + (hints.expiryMonths === 1 ? " month" : " months")}</strong>
      </SettingRow>
      {hints.expiryMonths === null && hints.repos?.map(({ id, name, expiryMonths }) => (
        <SettingRow key={id} title={name}><strong className={styles.readOnlyValue}>{expiryMonths} {expiryMonths === 1 ? "month" : "months"}</strong></SettingRow>
      ))}
      <div className={styles.commandFoot}>
        <p>Set the expiry when refreshing hints from a repo’s terminal.</p>
        <CommandCard command={"mex hints refresh --expiry-months " + (hints.expiryMonths ?? 6)} compact />
      </div>
    </SettingsSection>
  );
}

export function StorageSettings({ storage }: { storage: MachineStorage }) {
  const { recordBytes, hooksBytes, indexes, notesBytes, telemetryBytes, totalBytes, retention, paths, partial } = storage;
  const stores = [
    { label: "Record", bytes: recordBytes, key: "record", paths: paths && [paths.record] },
    { label: "Hooks", bytes: hooksBytes, key: "hooks", paths: paths && [paths.hooks] },
    { label: "Indexes", bytes: indexes.reduce((sum, repo) => sum + repo.bytes, 0), key: "indexes", paths: paths && [paths.indexes] },
    { label: paths ? "Personal notes and hints" : "Notes", bytes: notesBytes, key: "notes", paths: paths && [paths.notes] },
    { label: paths ? "Telemetry ID and local queue" : "Telemetry", bytes: telemetryBytes, key: "telemetry", paths: paths?.telemetry },
  ];
  return (
    <SettingsSection icon={Archive} id="storage" title="Storage">
      <div className={styles.storageSummary}>
        <div>
          <strong>{storageSize(totalBytes)}</strong>
          <span>{partial ? "At least this much on disk" : paths ? "Measured stores on disk" : "Total on disk"}</span>
        </div>
        <div aria-hidden="true" className={styles.storageBar}>
          {stores.map(({ key, bytes }) => <span data-store={key} key={key} style={{ flexGrow: bytes }} />)}
        </div>
      </div>
      <div className={styles.storageBreakdown}>
        <div>
          <h3>Stores</h3>
          <dl>
            {stores.map(({ label, key, bytes, paths }) => (
              <div key={key}>
                <dt><span aria-hidden="true" className={styles.storeSwatch} data-store={key} />
                  <span>{label}{paths?.map(path => <code className={styles.storePath} key={path}>{path}</code>)}</span>
                </dt>
                <dd>{storageSize(bytes)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3>Indexes by repo</h3>
          {indexes.length > 0 ? (
            <dl>
              {indexes.map(({ repoId, repo, bytes, path }) => <div key={repoId}><dt><span>{repo}{path && <code className={styles.storePath}>{path}</code>}</span></dt><dd>{storageSize(bytes)}</dd></div>)}
            </dl>
          ) : <p>No indexes on disk.</p>}
        </div>
      </div>
      <p className={styles.retention}>Delivery history is kept for {retention.deliveryDays} days. Capture keeps {retention.captureDays} days or {retention.captureMegabytes} {paths ? "MiB" : "MB"}.</p>
    </SettingsSection>
  );
}

export function AboutSettings({ about }: Pick<MachineSettings, "about">) {
  const { version, background, backgroundUnavailable, homePath, hubMode } = about;
  return (
    <SettingsSection icon={Info} id="about" title="About">
      <SettingRow description="Installed on this machine." title="MEX version"><code className={styles.path}>{version}</code></SettingRow>
      <SettingRow description={hubMode === "background" ? "Hub running from the background process" : "Hub running from your terminal"} stack title="Background process">
        {background ? (
          <span className={styles.inlineValue} data-running="true">
            <CircleCheck aria-hidden="true" />
            <span>Running since <time dateTime={background.startedAt}>{formatLocalClock(new Date(background.startedAt))}</time>, version {background.version}</span>
          </span>
        ) : <span className={styles.inlineValue}><CircleMinus aria-hidden="true" />{backgroundUnavailable ? "Unavailable" : "Stopped"}</span>}
      </SettingRow>
      {background && background.version !== version && <p className={styles.sectionNote}>Restart MEX with <code>mex hub</code> to use the same version in the terminal and background.</p>}
      <SettingRow description="Local files, notes and indexes." stack title="MEX home">
        <code className={styles.path}>{homePath}</code><CopyButton path text={homePath} />
      </SettingRow>
    </SettingsSection>
  );
}
