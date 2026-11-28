import { useEffect, useState } from "react";

/**
 * Light or dark follows the system unless this browser chose one. The choice is a per-browser
 * convenience, so it lives in localStorage and the Hub works the same without it.
 */

export type ThemePreference = "system" | "light" | "dark";
const STORAGE_KEY = "mex-hub-theme";
const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Set `data-theme` on <html>, so tokens and the `dark:` variant agree. */
export function applyTheme(preference: ThemePreference = readThemePreference()): "light" | "dark" {
  const resolved = preference === "system" ? systemTheme() : preference;
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]!;
}

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system") return;
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    const follow = () => applyTheme("system");
    query?.addEventListener("change", follow);
    return () => query?.removeEventListener("change", follow);
  }, [preference]);

  const choose = (next: ThemePreference) => {
    try {
      if (next === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch { /* the choice still applies to this tab */ }
    setPreference(next);
  };
  return [preference, choose];
}
