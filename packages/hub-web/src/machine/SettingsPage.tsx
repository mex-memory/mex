import { useEffect, useRef, useState } from "react";
import { Monitor } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { BrowserSettings } from "./SettingsControls";
import type { SettingsPreview } from "./types";
import { HubPageHeader } from "./ui";
import shared from "./machine.module.css";
import styles from "./settings.module.css";

const sections = [
  { id: "browser", label: "This browser", icon: Monitor },
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
  return (
    <div className={styles.layout}>
      <SectionNavigation />
      <div className={styles.sections}>
        <BrowserSettings settings={preview.settings.browser} write={preview.write} />
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
