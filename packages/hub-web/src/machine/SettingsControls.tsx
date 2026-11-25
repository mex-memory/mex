import { useId, useRef, useState, type ReactNode } from "react";
import { Monitor, type LucideIcon } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { Button } from "../components/primitives/button";
import type { MachineSettings, SettingsPreview } from "./types";
import forms from "./knowledge-forms.module.css";
import styles from "./settings.module.css";

export function SettingsSection({ id, title, icon: Icon, children }: {
  id: string;
  title: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={"heading-" + id} className={styles.section} id={id}>
      <header className={styles.sectionHeader}>
        <span className={styles.sectionGlyph}><Icon aria-hidden="true" /></span>
        <h2 id={"heading-" + id} tabIndex={-1}>{title}</h2>
      </header>
      {children}
    </section>
  );
}

export function SettingRow({ title, description, descriptionId, children, stack }: {
  title: ReactNode;
  description?: ReactNode;
  descriptionId?: string;
  children: ReactNode;
  stack?: boolean;
}) {
  return (
    <div className={styles.row} data-stack={stack || undefined}>
      <div className={styles.rowCopy}>
        <div className={styles.rowTitle}>{title}</div>
        {description && <div className={styles.rowDescription} id={descriptionId}>{description}</div>}
      </div>
      <div className={styles.rowAction}>{children}</div>
    </div>
  );
}

export function BrowserSettings({ settings, write }: {
  settings: MachineSettings["browser"];
  write: SettingsPreview["write"];
}) {
  const [confirm, setConfirm] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const everywhere = useRef<HTMLButtonElement>(null);
  const currentDescription = useId();
  const everywhereDescription = useId();

  return (
    <SettingsSection icon={Monitor} id="browser" title="This browser">
      <SettingRow
        description={settings.signOut.disabledReason ?? "End the Hub session in this browser."}
        descriptionId={currentDescription}
        stack
        title="Current browser"
      >
        <Button aria-describedby={currentDescription} disabled={Boolean(settings.signOut.disabledReason)}
          onClick={() => write({ type: "signOut", scope: "thisBrowser" })} type="button" variant="outline">
          Sign out of this browser
        </Button>
      </SettingRow>
      <SettingRow
        description={settings.signOutEverywhere.disabledReason ?? "End all sessions for this Hub and expire unused links."}
        descriptionId={everywhereDescription}
        stack
        title="All browsers"
      >
        <Button aria-describedby={everywhereDescription} aria-haspopup="dialog" disabled={Boolean(settings.signOutEverywhere.disabledReason)}
          onClick={() => setConfirm(true)} ref={everywhere} type="button" variant="destructive">
          Sign out everywhere
        </Button>
      </SettingRow>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent className={forms.dialog} finalFocus={everywhere} initialFocus={cancel}>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out everywhere?</AlertDialogTitle>
            <AlertDialogDescription>
              Every browser signed in to this Hub is signed out and unused links stop working. You can sign in again with <code>mex hub</code>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className={forms.dialogFooter}>
            <AlertDialogCancel ref={cancel}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={forms.destructive}
              onClick={() => write({ type: "signOut", scope: "everywhere" })}
              type="button"
              variant="destructive"
            >
              Sign out everywhere
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
