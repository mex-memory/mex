import { useState, type ReactNode, type Ref } from "react";
import { Check, CircleCheck, Copy, Monitor, Moon, RefreshCw, Sun, Terminal, WifiOff, X } from "lucide-react";
import type { HubEventState } from "./data";
import { nextThemePreference, useThemePreference } from "./theme";
import { Alert, AlertTitle } from "../components/primitives/alert";
import { Button } from "../components/primitives/button";
import { Card, CardContent, CardHeader } from "../components/primitives/card";
import shell from "../styles/shell.module.css";
import mexMascot from "../../../../mascot/mex-mascot.svg?no-inline";
import styles from "./machine.module.css";

export function HubBrand() {
  return (
    <div className={shell.brand}>
      <span className={shell.brandMark} aria-hidden="true">
        <img alt="" height="32" src={mexMascot} width="32" />
      </span>
      <span className={shell.brandWordmark}>
        <strong>MEX</strong>
        <small>Hub</small>
      </span>
    </div>
  );
}

export function CopyButton({ text, path = false, iconOnly = path }: {
  text: string;
  path?: boolean;
  iconOnly?: boolean;
}) {
  const [result, setResult] = useState<"Copied" | "Copy failed" | "">("");
  const Icon = result === "Copied" ? Check : result === "Copy failed" ? X : Copy;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setResult("Copied");
    } catch {
      setResult("Copy failed");
    }
  }

  return (
    <>
      <Button
        aria-label={path ? `Copy path ${text}` : iconOnly ? "Copy command" : undefined}
        onClick={copy}
        size={iconOnly ? "icon-sm" : "default"}
        title={iconOnly ? result || (path ? "Copy path" : "Copy command") : undefined}
        type="button"
        variant={iconOnly ? "ghost" : "outline"}
      >
        <Icon aria-hidden="true" />
        {iconOnly ? null : result || "Copy command"}
      </Button>
      <span className={styles.srOnly} role="status">{result}</span>
    </>
  );
}

export function HubPageHeader({ title, subtitle, action, titleRef }: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header className={styles.pageHeader}>
      <div>
        <h1 className={styles.pageTitle} ref={titleRef} tabIndex={titleRef ? -1 : undefined}>{title}</h1>
        <p className={styles.muted}>{subtitle}</p>
      </div>
      {action}
    </header>
  );
}

export function CommandCard({ title, children, command, compact }: {
  children?: ReactNode;
  command: string;
} & ({ compact: true; title?: never } | { compact?: false; title: string })) {
  if (compact) {
    return (
      <div className={styles.commandInline}>
        <Terminal aria-hidden="true" />
        <code>{command}</code>
        <CopyButton text={command} iconOnly />
      </div>
    );
  }
  return (
    <Card className={styles.commandCard}>
      <CardHeader className={styles.commandHeader}>
        <span className={styles.commandGlyph}><Terminal aria-hidden="true" /></span>
        <h1 className={styles.pageTitle}>{title}</h1>
        {children}
      </CardHeader>
      <CardContent>
        <CopyButton text={command} />
      </CardContent>
    </Card>
  );
}

export function HubBanners({ stopped, updated = false, terminal = false, events }: {
  stopped: boolean;
  updated?: boolean;
  terminal?: boolean;
  events?: HubEventState;
}) {
  return (
    <div aria-live="polite" className={styles.banners} role="status">
      {stopped && (
        <Alert className={styles.banner} data-tone="warning" role={undefined}>
          <WifiOff aria-hidden="true" />
          <AlertTitle>The Hub stopped. Run <code>mex hub</code> to start it again.</AlertTitle>
        </Alert>
      )}
      {!stopped && (events === "reconnecting" || events === "polling") && (
        <Alert className={styles.banner} role={undefined}>
          <WifiOff aria-hidden="true" />
          <AlertTitle>{events === "reconnecting" ? "Reconnecting…" : "Live updates are off. Refreshing every 10 s."}</AlertTitle>
        </Alert>
      )}
      {updated && (
        <Alert className={styles.banner} role={undefined}>
          <RefreshCw aria-hidden="true" />
          <AlertTitle>MEX was updated. Reload to get the new Hub.</AlertTitle>
          <Button onClick={() => window.location.reload()} size="sm" type="button" variant="outline">Reload</Button>
        </Alert>
      )}
      {terminal && (
        <Alert className={styles.banner} role={undefined}>
          <Terminal aria-hidden="true" />
          <AlertTitle>Running from this terminal; closing it stops the Hub.</AlertTitle>
        </Alert>
      )}
    </div>
  );
}

export function ControlToast({ message, dismissLabel, onDismiss }: { message: string; dismissLabel: string; onDismiss: () => void }) {
  return (
    <div aria-live="polite" className={styles.toastRegion}>
      {message && (
        <div className={styles.toast}>
          <CircleCheck aria-hidden="true" />
          <span>{message}</span>
          <Button aria-label={dismissLabel} onClick={onDismiss} size="icon-sm" type="button" variant="ghost"><X aria-hidden="true" /></Button>
        </div>
      )}
    </div>
  );
}

export interface PageLoad {
  loading?: boolean;
  error?: boolean;
  retry?: () => void;
}

export function PageRequestState({ name, loading, error, retry }: PageLoad & { name: "Home" | "Review" | "jobs" | "Agents" | "Settings" | "the uninstall preview" }) {
  if (!loading && !error) return null;
  return (
    <div className={styles.pageState}>
      <p role="status">{error ? `Couldn’t load ${name}.` : `Loading ${name}…`}</p>
      {error && <Button onClick={retry} size="sm" type="button" variant="outline">Retry</Button>}
    </div>
  );
}

const THEME_LABEL = { system: "System", light: "Light", dark: "Dark" } as const;
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;

/** One button that cycles System, Light and Dark; the label always says which is active. */
export function ThemeToggle() {
  const [preference, choose] = useThemePreference();
  const Icon = THEME_ICON[preference];
  const next = nextThemePreference(preference);
  return (
    <Button
      aria-label={`Theme: ${THEME_LABEL[preference]}. Switch to ${THEME_LABEL[next]}.`}
      className={styles.themeToggle}
      onClick={() => choose(next)}
      size="sm"
      type="button"
      variant="ghost"
    >
      <Icon aria-hidden="true" />
      <span>{THEME_LABEL[preference]}</span>
    </Button>
  );
}
