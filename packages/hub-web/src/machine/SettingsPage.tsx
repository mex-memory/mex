import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { BrowserSettings, PowerSettings, SharingSettings, type SettingsEdits } from "./SettingsControls";
import { AboutSettings, AISettings, HintsSettings, PrivacySettings, StorageSettings } from "./SettingsReadouts";
import type { SettingsPreview } from "./types";
import { HubPageHeader } from "./ui";
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
  { id: "about", label: "About" },
] as const;
type SectionId = typeof sections[number]["id"];

function sectionElement(id: SectionId) {
  return document.getElementById(id);
}

function useActiveSection(hash: string, locationKey: string) {
  const [active, setActive] = useState<SectionId>(sections[0].id);
  const landingPosition = useRef<number | undefined>(undefined);

  useEffect(() => {
    landingPosition.current = undefined;
    const match = sections.find(({ id }) => "#" + id === hash);
    if (!match) return;
    const section = sectionElement(match.id);
    if (!section) return;
    section.scrollIntoView?.({ block: "start" });
    section.querySelector("h2")?.focus({ preventScroll: true });
    landingPosition.current = window.scrollY;
    setActive(match.id);
  }, [hash, locationKey]);

  useEffect(() => {
    let frame: number | undefined;
    function update() {
      frame = undefined;
      if (landingPosition.current === window.scrollY) return;
      landingPosition.current = undefined;

      const root = document.documentElement;
      const atEnd = window.scrollY > 0 && window.scrollY + root.clientHeight >= root.scrollHeight - 2;
      if (atEnd) {
        setActive(sections[sections.length - 1].id);
        return;
      }
      const first = sectionElement(sections[0].id);
      const marker = first ? Number.parseFloat(getComputedStyle(first).scrollMarginTop) || 0 : 0;
      const current = sections.filter(({ id }) => (sectionElement(id)?.getBoundingClientRect().top ?? Infinity) <= marker + 2).at(-1);
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
  }, []);
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

function SettingsWorkspace({ preview }: { preview: SettingsPreview }) {
  const { settings } = preview;
  const [feedback, setFeedback] = useState<{ target: string; count: number } | null>(null);
  const edits: SettingsEdits = {
    save: (target, request) => {
      preview.write(request);
      setFeedback((current) => ({ target, count: (current?.count ?? 0) + 1 }));
    },
    savedFor: (target) => feedback?.target === target ? feedback.count : undefined,
  };
  return (
    <div className={styles.layout}>
      <SectionNavigation />
      <div className={styles.sections}>
        <BrowserSettings settings={settings.browser} write={preview.write} />
        <PowerSettings edits={edits} settings={settings} />
        <SharingSettings edits={edits} repos={settings.repos} />
        <AISettings ai={settings.ai} repos={settings.repos} />
        <PrivacySettings edits={edits} outbound={settings.outbound} telemetry={settings.telemetry} />
        <HintsSettings hints={settings.hints} />
        <StorageSettings storage={settings.storage} />
        <AboutSettings about={settings.about} />
      </div>
    </div>
  );
}

export default function SettingsPage({ preview }: { preview?: SettingsPreview }) {
  return (
    <div className={styles.page}>
      <HubPageHeader title="Settings" subtitle="Manage how MEX runs on this machine." />
      {preview ? <SettingsWorkspace preview={preview} />
        : <p className={shared.muted} role="status">Machine settings aren’t available in this Hub yet.</p>}
    </div>
  );
}
