import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { BrowserSettings, PowerSettings, SharingSettings, type SettingsEdits } from "./SettingsControls";
import { AboutSettings, AISettings, HintsSettings, PrivacySettings, StorageSettings } from "./SettingsReadouts";
import { useSettings, useSettingChange, useSignOut, useUninstallPreview, type ControlConnection } from "./data";
import { knowledgeSaveError, useKnowledgeWrite } from "./knowledge-write-state";
import type { MachineSettings, SettingsPreview, SettingsWrite } from "./types";
import { UninstallSettings } from "./UninstallPreviewDialog";
import { ControlToast, HubPageHeader, PageRequestState, type PageLoad } from "./ui";
import shared from "./machine.module.css";
import styles from "./settings.module.css";

const sections = [
  { id: "browser", label: "This browser" },
  { id: "power", label: "MEX on or off" },
  { id: "sharing", label: "Sharing" },
  { id: "ai-use", label: "AI use" },
  { id: "privacy", label: "Privacy" },
  { id: "hints", label: "Hints from your agent" },
  { id: "storage", label: "Storage" },
  { id: "uninstall", label: "Uninstall" },
  { id: "about", label: "About" },
] as const;
type SectionId = typeof sections[number]["id"];

function sectionElement(id: SectionId) {
  return document.getElementById(id);
}

function useActiveSection(hash: string, locationKey: string) {
  const [active, setActive] = useState<SectionId>(sections[0].id);
  const target = sections.find(({ id }) => "#" + id === hash);

  useEffect(() => {
    if (!target) {
      if (!hash) {
        document.getElementById("main-content")?.scrollIntoView?.({ block: "start" });
        setActive(sections[0].id);
      }
      return;
    }
    const section = sectionElement(target.id);
    section?.scrollIntoView?.({ block: "start" });
    section?.querySelector("h2")?.focus({ preventScroll: true });
    setActive(target.id);
  }, [hash, locationKey, target]);

  useEffect(() => {
    let frame: number | undefined;
    function update() {
      frame = undefined;

      const root = document.documentElement;
      const atEnd = window.scrollY > 0 && window.scrollY + root.clientHeight >= root.scrollHeight - 2;
      const first = sectionElement(sections[0].id);
      const marker = first ? Number.parseFloat(getComputedStyle(first).scrollMarginTop) || 0 : 0;
      const top = (id: SectionId) => sectionElement(id)?.getBoundingClientRect().top ?? Infinity;

      // The last few cards can share the same bottom scroll position.
      if (target && (Math.abs(top(target.id) - marker) <= 3 || atEnd && top(target.id) >= marker - 3)) {
        setActive(target.id);
        return;
      }
      const readingLine = marker + (atEnd ? 32 : 2);
      const current = sections.filter(({ id }) => top(id) <= readingLine).at(-1);
      setActive(current?.id ?? sections[0].id);
    }
    function schedule() {
      if (frame === undefined) frame = window.requestAnimationFrame(update);
    }
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [target]);
  return active;
}

function SectionNavigation() {
  const { hash, key, search } = useLocation();
  const navigate = useNavigate();
  const active = useActiveSection(hash, key);
  return (
    <>
      <nav aria-label="Settings sections" className={styles.sectionNav}>
        <ul role="list">
          {sections.map(({ id, label }) => (
            <li key={id}>
              <Link aria-current={active === id ? "location" : undefined} to={{ hash: "#" + id, search }}>{label}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className={styles.mobileNav}>
        <label htmlFor="settings-section-select">Jump to section</label>
        <NativeSelect
          className={shared.switcher}
          id="settings-section-select"
          onChange={(event) => navigate({ hash: "#" + event.target.value, search })}
          value={active}
        >
          {sections.map(({ id, label }) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
    </>
  );
}

function SettingsWorkspace({ preview, live, readOnly, uninstallLoad, uninstallIssue }: {
  preview: SettingsPreview; live?: boolean; readOnly?: boolean; uninstallLoad?: PageLoad; uninstallIssue?: string;
}) {
  const { settings } = preview;
  const [feedback, setFeedback] = useState<{ target: string; count: number } | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const saving = useKnowledgeWrite();
  const edits: SettingsEdits = {
    disabled: readOnly || saving.pending,
    save: (target, request) => {
      if (readOnly) return;
      setError("");
      void saving.run<void | { notice?: string }>(retry => preview.write(request, retry), (result) => {
        setFeedback((current) => ({ target, count: (current?.count ?? 0) + 1 }));
        if (live) setToast(result?.notice ?? "Setting saved");
      }, (error) => setError(knowledgeSaveError(error, "Couldn’t save the setting. Try again.")));
    },
    savedFor: (target) => feedback?.target === target ? feedback.count : undefined,
  };
  return (
    <>
      <div className={styles.layout}>
        <SectionNavigation />
        <div className={styles.sections}>
          <BrowserSettings settings={settings.browser} write={preview.write} />
          <PowerSettings edits={edits} settings={settings} />
          <SharingSettings edits={edits} repos={settings.repos} />
          <AISettings ai={settings.ai} repos={settings.repos} />
          <PrivacySettings edits={edits} live={live} outbound={settings.outbound} telemetry={settings.telemetry} />
          <HintsSettings hints={settings.hints} />
          <StorageSettings storage={settings.storage} />
          <UninstallSettings issue={uninstallIssue} load={uninstallLoad} preview={preview.uninstall} />
          <AboutSettings about={settings.about} />
        </div>
      </div>
      {saving.pending && <p className={shared.muted} role="status">{saving.status ?? "Saving setting…"}</p>}
      {error && <p role="alert">{error}</p>}
      {live && <ControlToast dismissLabel="Dismiss settings message" message={toast} onDismiss={() => setToast("")} />}
    </>
  );
}

function expectedRevision(settings: MachineSettings, write: Exclude<SettingsWrite, { type: "signOut" }>): string | undefined {
  switch (write.type) {
    case "globalPower": return settings.everywhere.revision;
    case "capture": return write.repoId ? settings.repos.find(repo => repo.id === write.repoId)?.capture.revision : settings.capture.revision;
    case "checkoutPower": return settings.repos.flatMap(repo => repo.checkouts).find(checkout => checkout.path === write.path)?.revision;
    case "sharing": return settings.repos.find(repo => repo.id === write.repoId)?.sharing.revision;
    case "telemetry": return settings.telemetry.revision;
  }
}

function ConnectedSettings({ live }: { live: ControlConnection }) {
  const query = useSettings(live.events);
  const uninstall = useUninstallPreview(live.events);
  const change = useSettingChange(live);
  const signOut = useSignOut(live);
  const settings = query.data?.settings;
  const issue = query.data?.issue;
  useEffect(() => {
    if (query.error) live.reportDataError(query.error);
    if (uninstall.error) live.reportDataError(uninstall.error);
  }, [query.error, uninstall.error, live.reportDataError]);

  return (
    <>
      {issue && <p className={shared.muted} role="status">{issue}</p>}
      {settings ? (
        <>
          {query.data?.updatingSince && <p className={shared.muted} role="status">Updating machine settings…</p>}
          <SettingsWorkspace
            live readOnly={issue?.startsWith("record.db schema version ")}
            uninstallIssue={uninstall.data?.issue}
            uninstallLoad={{ loading: !uninstall.data?.preview && !uninstall.isError && !uninstall.data?.issue,
              error: uninstall.isError, retry: () => void uninstall.refetch() }}
            preview={{ settings, uninstall: uninstall.data?.preview, write: (request, onRetry = () => {}) => {
              if (request.type === "signOut") return signOut(request.scope).then(() => ({}), () => ({}));
              const revision = expectedRevision(settings, request);
              if (!revision) throw new Error("Setting revision unavailable.");
              return change({ change: request, revision, onRetry });
            } }}
          />
        </>
      ) : <PageRequestState error={query.isError} loading={!query.isError && !issue} name="Settings" retry={() => void query.refetch()} />}
    </>
  );
}

export default function SettingsPage({ preview, live }: { preview?: SettingsPreview; live?: ControlConnection }) {
  return (
    <div className={styles.page}>
      <HubPageHeader title="Settings" subtitle="Manage how MEX runs on this machine." />
      {live ? <ConnectedSettings live={live} /> : preview && <SettingsWorkspace preview={preview} />}
    </div>
  );
}
