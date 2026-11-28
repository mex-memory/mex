import { useState, type ReactNode } from "react";
import { Check, Copy, Monitor, Moon, RefreshCw, Sun, Terminal, WifiOff, X } from "lucide-react";
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

export function CopyButton({ text, path = false }: { text: string; path?: boolean }) {
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
        aria-label={path ? `Copy path ${text}` : undefined}
        onClick={copy}
        size={path ? "icon-sm" : "default"}
        title={path ? result || "Copy path" : undefined}
        type="button"
        variant={path ? "ghost" : "outline"}
      >
        <Icon aria-hidden="true" />
        {path ? null : result || "Copy command"}
      </Button>
      <span className={styles.srOnly} role="status">{result}</span>
    </>
  );
}

export function CommandCard({ title, children, command }: { title: string; children: ReactNode; command: string }) {
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

export function HubBanners({ stopped, updated = false, terminal = false }: {
  stopped: boolean;
  updated?: boolean;
  terminal?: boolean;
}) {
  return (
    <div aria-live="polite" className={styles.banners} role="status">
      {stopped && (
        <Alert className={styles.banner} data-tone="warning" role={undefined}>
          <WifiOff aria-hidden="true" />
          <AlertTitle>The Hub stopped. Run <code>mex hub</code> to start it again.</AlertTitle>
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
