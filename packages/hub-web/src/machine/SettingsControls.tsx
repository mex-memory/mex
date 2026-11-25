import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Switch } from "@base-ui/react/switch";
import { Check, Clock3, Monitor, Power, Share2, type LucideIcon } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { Button } from "../components/primitives/button";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "../components/primitives/dialog";
import { Input } from "../components/primitives/input";
import { Label } from "../components/primitives/label";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { localDateTime, localShortDate } from "./local-time";
import type { MachineSettings, SettingsPreview, SettingsWrite } from "./types";
import forms from "./knowledge-forms.module.css";
import shared from "./machine.module.css";
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

export function SettingRow({ title, description, descriptionId, children, saved, stack }: {
  title: ReactNode;
  description?: ReactNode;
  descriptionId?: string;
  children: ReactNode;
  saved?: number;
  stack?: boolean;
}) {
  return (
    <div className={styles.row} data-stack={stack || undefined}>
      <div className={styles.rowCopy}>
        <div className={styles.rowTitle}>
          {title}
          <span aria-atomic="true" aria-live="polite" className={styles.saved}>
            {saved !== undefined && <span key={saved}><Check aria-hidden="true" />Saved</span>}
          </span>
        </div>
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

type SettingChange = Exclude<SettingsWrite, { type: "signOut" }>;
export interface SettingsEdits {
  save: (target: string, request: SettingChange) => void;
  savedFor: (target: string) => number | undefined;
}

export function ToggleSetting({ title, label, description, setting, saved, onChange }: {
  title: string;
  label?: string;
  description: string;
  setting: MachineSettings["capture"];
  saved?: number;
  onChange: (enabled: boolean) => void;
}) {
  const helpId = useId();
  return (
    <SettingRow description={setting.disabledReason ?? description} descriptionId={helpId} saved={saved} title={title}>
      <div className={styles.switchField}>
        <span aria-hidden="true">{setting.enabled ? "On" : "Off"}</span>
        <Switch.Root aria-describedby={helpId} aria-label={label ?? title} checked={setting.enabled} className={styles.switch}
          disabled={Boolean(setting.disabledReason)} onCheckedChange={onChange}>
          <Switch.Thumb className={styles.switchThumb} />
        </Switch.Root>
      </div>
    </SettingRow>
  );
}

type RepoSettings = MachineSettings["repos"][number];
type Checkout = RepoSettings["checkouts"][number];
type CheckoutPower = Checkout["power"];
const hourMs = 60 * 60 * 1000;
const deadlineFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });

function Deadline({ until }: { until: string }) {
  const date = new Date(until);
  const today = date.toDateString() === new Date().toDateString();
  return (
    <span className={styles.deadline}>
      <Clock3 aria-hidden="true" /> <span>Off until{" "}
        <time dateTime={until} title={localDateTime.format(date)}>
          {today ? deadlineFormat.format(date) : localShortDate.format(date) + ", " + deadlineFormat.format(date)}
        </time>
      </span>
    </span>
  );
}

function CheckoutSetting({ checkout, repoName, saved, onPower, onCustom }: {
  checkout: Checkout;
  repoName: string;
  saved?: number;
  onPower: (power: CheckoutPower) => void;
  onCustom: (trigger: HTMLSelectElement) => void;
}) {
  const helpId = useId();
  const { power, disabledReason, path } = checkout;
  const activePower = power.state === "offUntil" && Date.parse(power.until) <= Date.now() ? { state: "on" } as const : power;

  function change(select: HTMLSelectElement) {
    switch (select.value) {
      case "on": onPower({ state: "on" }); break;
      case "off": onPower({ state: "off" }); break;
      case "hour": onPower({ state: "offUntil", until: new Date(Date.now() + hourMs).toISOString() }); break;
      case "day": onPower({ state: "offUntil", until: new Date(Date.now() + 24 * hourMs).toISOString() }); break;
      case "custom": onCustom(select); break;
    }
  }

  return (
    <SettingRow description={(
      <>
        <code className={styles.path}>{path}</code>
        {disabledReason && <span className={styles.settingNote}>{disabledReason}</span>}
        {activePower.state === "offUntil" && <Deadline until={activePower.until} />}
      </>
    )} descriptionId={helpId} saved={saved} title={repoName}>
      <NativeSelect aria-describedby={helpId} aria-label={"MEX for " + path} className={shared.switcher + " " + styles.checkoutSelect}
        disabled={Boolean(disabledReason)} onChange={(event) => change(event.currentTarget)} value={activePower.state}>
        <NativeSelectOption value="on">On</NativeSelectOption>
        <NativeSelectOption value="off">Off</NativeSelectOption>
        <NativeSelectOption value="hour">Off for 1 hour</NativeSelectOption>
        <NativeSelectOption value="day">Off for 1 day</NativeSelectOption>
        <NativeSelectOption value="custom">Off until…</NativeSelectOption>
        {activePower.state === "offUntil" && <NativeSelectOption hidden value="offUntil">Timed off</NativeSelectOption>}
      </NativeSelect>
    </SettingRow>
  );
}

function CheckoutDeadlineDialog({ path, finalFocus, onClose, onSave }: {
  path: string | null;
  finalFocus: () => HTMLSelectElement | false;
  onClose: () => void;
  onSave: (until: string) => void;
}) {
  const fieldId = useId();
  const dateInput = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState("");
  const [error, setError] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const until = new Date(date);
    if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) {
      setError(true);
      return;
    }
    onSave(until.toISOString());
  }

  return (
    <Dialog open={path !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={forms.dialog} finalFocus={finalFocus} initialFocus={dateInput} showCloseButton={false}>
        <form className={styles.dateForm} onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Turn MEX off until…</DialogTitle>
            <DialogDescription>Choose when MEX should turn back on for <code>{path}</code>.</DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor={fieldId}>Date and time (local)</Label>
            <Input aria-describedby={error ? fieldId + "-error" : undefined} aria-invalid={error || undefined}
              id={fieldId} onChange={(event) => { setDate(event.target.value); setError(false); }}
              ref={dateInput} required type="datetime-local" value={date} />
            {error && <p className={forms.error} id={fieldId + "-error"} role="alert">Choose a date and time in the future.</p>}
          </div>
          <DialogFooter className={forms.dialogFooter}>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit">Set time</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PowerSettings({ settings, edits }: { settings: MachineSettings; edits: SettingsEdits }) {
  const [deadline, setDeadline] = useState<{ path: string | null; cycle: number }>({ path: null, cycle: 0 });
  const select = useRef<HTMLSelectElement>(null);
  const setPower = (path: string, power: CheckoutPower) => edits.save(path, { type: "checkoutPower", path, power });
  const close = () => setDeadline((current) => ({ ...current, path: null }));

  return (
    <SettingsSection icon={Power} id="power" title="MEX on or off">
      <ToggleSetting
        description={settings.everywhere.enabled ? "Let MEX run on this machine." : "Shared rule files may still be loaded by your agent."}
        label="MEX everywhere" onChange={(enabled) => edits.save("globalPower", { type: "globalPower", enabled })}
        saved={edits.savedFor("globalPower")} setting={settings.everywhere} title="Everywhere"
      />
      <h3 className={styles.rowGroup}>Checkouts</h3>
      {settings.repos.length === 0 && <p className={styles.sectionNote}>No registered checkouts.</p>}
      {settings.repos.flatMap(({ name, checkouts }) => checkouts.map((checkout) => (
        <CheckoutSetting checkout={checkout} key={checkout.path} onCustom={(element) => {
          select.current = element;
          setDeadline((current) => ({ path: checkout.path, cycle: current.cycle + 1 }));
        }} onPower={(power) => setPower(checkout.path, power)} repoName={name} saved={edits.savedFor(checkout.path)} />
      )))}
      <h3 className={styles.rowGroup}>Capture</h3>
      <ToggleSetting description="Delivery has its own off switches." onChange={(enabled) => edits.save("capture", { type: "capture", enabled })}
        saved={edits.savedFor("capture")} setting={settings.capture} title="Capture everywhere" />
      {settings.repos.map(({ id, name, capture }) => (
        <ToggleSetting description="Applies across this repo’s checkouts." key={id} label={"Capture for " + name}
          onChange={(enabled) => edits.save("capture-" + id, { type: "capture", repoId: id, enabled })}
          saved={edits.savedFor("capture-" + id)} setting={capture} title={name} />
      ))}
      <CheckoutDeadlineDialog finalFocus={() => select.current ?? false} key={deadline.cycle}
        onClose={close} onSave={(until) => {
          if (deadline.path) setPower(deadline.path, { state: "offUntil", until });
          close();
        }} path={deadline.path} />
    </SettingsSection>
  );
}

export function SharingSettings({ repos, edits }: { repos: MachineSettings["repos"]; edits: SettingsEdits }) {
  return (
    <SettingsSection icon={Share2} id="sharing" title="Sharing">
      {repos.length === 0 && <p className={styles.sectionNote}>No registered repos.</p>}
      {repos.map((repo) => <RepoSharing edits={edits} key={repo.id} repo={repo} />)}
    </SettingsSection>
  );
}

function RepoSharing({ repo: { id, name, sharing }, edits }: { repo: RepoSettings; edits: SettingsEdits }) {
  const helpId = useId();
  const description = sharing.mode === "manual"
    ? <>Learned notes stay personal until <code>mex share</code>.</>
    : "Eligible learned notes can reach this shared repository after their diff is shown.";
  return (
    <SettingRow description={<>{description}{sharing.disabledReason && <span className={styles.settingNote}>{sharing.disabledReason}</span>}</>}
      descriptionId={helpId} saved={edits.savedFor("sharing-" + id)} stack title={name}>
      <RadioGroup aria-describedby={helpId} aria-label={"Sharing for " + name} className={styles.segmented}
        disabled={Boolean(sharing.disabledReason)}
        onValueChange={(mode: typeof sharing.mode) => edits.save("sharing-" + id, { type: "sharing", repoId: id, mode })}
        value={sharing.mode}>
        <Radio.Root className={styles.segment} value="automatic">Automatic</Radio.Root>
        <Radio.Root className={styles.segment} value="manual">Manual</Radio.Root>
      </RadioGroup>
    </SettingRow>
  );
}
