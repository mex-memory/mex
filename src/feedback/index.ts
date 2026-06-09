/**
 * Opt-in feedback — a path to humans, kept fully separate from telemetry.
 *
 * Trust constraint: this module NEVER reads, prompts for, or transmits an
 * email or any user-identifying data. Its only outbound action is opening a
 * hosted form URL in the browser; the email is entered by the user on that web
 * page, never by the CLI. Nothing here touches or joins the telemetry path —
 * this module does not import the telemetry module, and vice versa.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { readGlobalConfig, setGlobalConfigKey } from "../global-config.js";

/** Hosted form the maintainer uses for user-research sign-ups. */
export const FEEDBACK_FORM_URL = "https://tally.so/r/KYGGbK";

/** One-line nudge surfaced at warm moments. Points at the command, never asks for data. */
export const INVITE_TEXT =
  "mex is building team features — the maintainer is doing user calls. Interested? Run `mex feedback`.";

/** Max times the invite is surfaced before we stop on our own (don't nag). */
const INVITE_MAX_SHOWS = 3;

// ── Browser opener (with test seam) ──

type OpenerFn = (url: string) => void;
let customOpener: OpenerFn | null = null;

/** Test seam: inject a fake opener so tests never spawn a real browser. */
export function __setOpener(fn: OpenerFn | null): void {
  customOpener = fn;
}

function defaultOpen(url: string): void {
  const os = platform();
  const [cmd, args] =
    os === "darwin" ? ["open", [url]] as const :
    os === "win32" ? ["cmd", ["/c", "start", "", url]] as const :
    ["xdg-open", [url]] as const;
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  // No browser / no DISPLAY — swallow; opening is best-effort.
  child.on("error", () => {});
  child.unref();
}

function openUrl(url: string): void {
  try {
    (customOpener ?? defaultOpen)(url);
  } catch {
    // Opening a browser must never throw.
  }
}

// ── `mex feedback` ──

/**
 * Open the feedback form in the browser. Engaging dismisses the invite so the
 * nudge stops. The CLI never collects or transmits an email — the form does.
 */
export function runFeedback(): void {
  console.log("Opening the mex feedback form in your browser...");
  console.log(`If it doesn't open, visit: ${FEEDBACK_FORM_URL}`);
  openUrl(FEEDBACK_FORM_URL);
  dismissInvite();
}

// ── Invite state ──

export function isInviteDismissed(): boolean {
  try {
    return readGlobalConfig().feedbackDismissed === true;
  } catch {
    return false;
  }
}

export function dismissInvite(): void {
  try {
    setGlobalConfigKey("feedbackDismissed", true);
  } catch {
    // Best-effort; never break a command over the invite.
  }
}

/** Re-enable the invite (e.g. `mex config set feedback on`). */
export function enableInvite(): void {
  try {
    setGlobalConfigKey("feedbackDismissed", false);
    setGlobalConfigKey("feedbackInviteCount", 0);
  } catch {
    // Best-effort.
  }
}

/**
 * Whether to surface the one-line invite right now. TTY-only (never in pipes or
 * CI), suppressed once dismissed or after INVITE_MAX_SHOWS shows.
 */
export function shouldShowInvite(): boolean {
  try {
    if (!process.stdout.isTTY) return false;
    const cfg = readGlobalConfig();
    if (cfg.feedbackDismissed === true) return false;
    const count = typeof cfg.feedbackInviteCount === "number" ? cfg.feedbackInviteCount : 0;
    return count < INVITE_MAX_SHOWS;
  } catch {
    return false;
  }
}

/**
 * Record that the invite was surfaced (bumps the counter toward
 * INVITE_MAX_SHOWS). Best-effort, no output — safe to call from any surface
 * (CLI or TUI) so the show-cap applies consistently.
 */
export function recordInviteShown(): void {
  try {
    const count = readGlobalConfig().feedbackInviteCount;
    setGlobalConfigKey("feedbackInviteCount", (typeof count === "number" ? count : 0) + 1);
  } catch {
    // Best-effort.
  }
}

/**
 * Print the invite to **stderr** (so it never corrupts machine-readable stdout
 * like `check --json`) and record that it was shown. No-op when the invite
 * should not show. Returns true if it was printed.
 */
export function maybeShowInvite(): boolean {
  if (!shouldShowInvite()) return false;
  try {
    process.stderr.write(`\n  ${INVITE_TEXT}\n  (hide: mex config set feedback off)\n\n`);
    recordInviteShown();
    return true;
  } catch {
    return false;
  }
}
