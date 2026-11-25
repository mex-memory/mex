import { useRef, useState } from "react";
import { EyeOff, FileText, Trash2, X } from "lucide-react";
import { Button } from "../components/primitives/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/primitives/dialog";
import { SettingRow, SettingsSection } from "./SettingsControls";
import { storageSize } from "./SettingsReadouts";
import type { MachineUninstallPreview } from "./types";
import { CommandCard, PageRequestState, type PageLoad } from "./ui";
import styles from "./settings.module.css";
import uninstall from "./uninstall-preview.module.css";

type Change = MachineUninstallPreview["changes"][number];

function ChangeCard({ change }: { change: Change }) {
  return (
    <li className={uninstall.change}>
      <header>
        <h4>{change.entry}</h4>
        <code>{change.path}</code>
      </header>
      <dl className={uninstall.values}>
        <div><dt>Before MEX</dt><dd>{change.before ?? "Not present"}</dd></div>
        <div><dt>MEX’s value</dt><dd>{change.mexValue}</dd></div>
        <div><dt>Uninstall restores</dt><dd>{change.restores ?? "Not present"}</dd></div>
      </dl>
      {change.note && <p className={styles.sectionNote}>{change.note}</p>}
    </li>
  );
}

const retainedLabels = {
  personalRule: "Personal rule file", gitExclude: "Git exclude block for personal rules",
  teamRule: "Shared rule file", teamKnowledge: "Shared knowledge",
};

function RetainedFiles({ notRemoved, dataPath, dataSize, additionalDataPath, partial }: MachineUninstallPreview) {
  return (
    <aside className={uninstall.retained}>
      <h3>Not removed by uninstall</h3>
      {notRemoved.length > 0 ? (
        <ul role="list">
          {notRemoved.map(({ path, kind }) => (
            <li key={path}>
              {kind === "gitExclude" ? <EyeOff aria-hidden="true" /> : <FileText aria-hidden="true" />}
              <div>
                <span>{retainedLabels[kind]}</span>
                <code>{path}</code>
              </div>
            </li>
          ))}
        </ul>
      ) : <p>No personal rule files recorded.</p>}
      <div className={uninstall.data}>
        <p>Your data stays in <code>{dataPath}</code>{additionalDataPath && <> and <code>{additionalDataPath}</code></>} ({partial ? "at least " : ""}{storageSize(dataSize)}).</p>
        <p><code>mex uninstall --purge</code> deletes it.</p>
      </div>
    </aside>
  );
}

export function UninstallSettings({ preview, load, issue }: { preview?: MachineUninstallPreview; load?: PageLoad; issue?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const groups = new Map<string, Change[]>();
  for (const change of preview?.changes ?? []) {
    const group = groups.get(change.group);
    if (group) group.push(change);
    else groups.set(change.group, [change]);
  }

  return (
    <SettingsSection icon={Trash2} id="uninstall" title="Uninstall">
      <SettingRow description="Review the files MEX will restore and what stays on disk." stack title="Remove MEX from this machine">
        <Button aria-haspopup="dialog" onClick={() => setOpen(true)} ref={trigger} type="button" variant="outline">Preview uninstall</Button>
      </SettingRow>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={uninstall.dialog} finalFocus={trigger} initialFocus={close} showCloseButton={false}>
          <DialogHeader className={uninstall.header}>
            <div>
              <DialogTitle>Uninstall preview</DialogTitle>
              <DialogDescription>
                {preview ? `${preview.changes.length} ${preview.changes.length === 1 ? "recorded change" : "recorded changes"} across this machine.`
                  : "Review what uninstall restores and what stays."}
              </DialogDescription>
            </div>
            <DialogClose aria-label="Close uninstall preview" ref={close} render={<Button size="icon" variant="ghost" />}>
              <X aria-hidden="true" />
            </DialogClose>
          </DialogHeader>
          <div aria-label="Recorded changes and files that stay" className={uninstall.body} role="region" tabIndex={0}>
            <div className={uninstall.groups}>
              {issue && <p className={styles.sectionNote} role="status">{issue}</p>}
              <PageRequestState name="the uninstall preview" {...load} />
              {preview?.partial && <p className={styles.sectionNote}>Some files or values couldn’t be listed within the reading limit.</p>}
              {preview && groups.size === 0 && <p className={styles.sectionNote}>No recorded installation changes.</p>}
              {[...groups].map(([label, changes]) => (
                <section aria-label={label} className={uninstall.group} key={label}>
                  <h3>{label}</h3>
                  <ul role="list">
                    {changes.map((change) => <ChangeCard change={change} key={change.id} />)}
                  </ul>
                </section>
              ))}
            </div>
            {preview && <RetainedFiles {...preview} />}
          </div>
          <footer className={uninstall.footer}>
            <p>Uninstall runs from your terminal, because it stops the Hub.</p>
            <CommandCard command="mex uninstall" compact />
          </footer>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
