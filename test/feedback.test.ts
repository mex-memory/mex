import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Each test gets a fresh MEX_HOME so the global config (invite state) is
// isolated, and controls process.stdout.isTTY for the gating checks. We use
// MEX_HOME (not $HOME) because Node's homedir() ignores $HOME on Windows.

let originalMexHome: string | undefined;
let tempHome: string;
let originalIsTTY: boolean | undefined;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  originalMexHome = process.env.MEX_HOME;
  originalIsTTY = process.stdout.isTTY;
  tempHome = mkdtempSync(join(tmpdir(), "mex-fb-"));
  process.env.MEX_HOME = tempHome;
});

afterEach(async () => {
  if (originalMexHome !== undefined) process.env.MEX_HOME = originalMexHome;
  else delete process.env.MEX_HOME;
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
  const fb = await import("../src/feedback/index.js");
  fb.__setOpener(null);
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("FEEDBACK_FORM_URL", () => {
  it("points at the maintainer's hosted form", async () => {
    const { FEEDBACK_FORM_URL } = await import("../src/feedback/index.js");
    expect(FEEDBACK_FORM_URL).toBe("https://tally.so/r/KYGGbK");
  });
});

describe("mex feedback", () => {
  it("opens the form URL (and the CLI never reads an email)", async () => {
    const { runFeedback, __setOpener } = await import("../src/feedback/index.js");
    const opened: string[] = [];
    __setOpener((url) => opened.push(url));
    vi.spyOn(console, "log").mockImplementation(() => {});
    runFeedback();
    expect(opened).toEqual(["https://tally.so/r/KYGGbK"]);
  });

  it("swallows opener errors (no browser / no DISPLAY)", async () => {
    const { runFeedback, __setOpener } = await import("../src/feedback/index.js");
    __setOpener(() => {
      throw new Error("no browser");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => runFeedback()).not.toThrow();
  });

  it("dismisses the invite once the user engages", async () => {
    const { runFeedback, isInviteDismissed, __setOpener } = await import("../src/feedback/index.js");
    __setOpener(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(isInviteDismissed()).toBe(false);
    runFeedback();
    expect(isInviteDismissed()).toBe(true);
  });
});

describe("invite gating", () => {
  it("never shows in a non-TTY (pipes / CI)", async () => {
    setTTY(false);
    const { shouldShowInvite } = await import("../src/feedback/index.js");
    expect(shouldShowInvite()).toBe(false);
  });

  it("shows in a fresh TTY, then stays hidden once dismissed", async () => {
    setTTY(true);
    const { shouldShowInvite, dismissInvite } = await import("../src/feedback/index.js");
    expect(shouldShowInvite()).toBe(true);
    dismissInvite();
    expect(shouldShowInvite()).toBe(false);
  });

  it("stops after a few shows so it never nags", async () => {
    setTTY(true);
    const { shouldShowInvite, maybeShowInvite } = await import("../src/feedback/index.js");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let shows = 0;
    for (let i = 0; i < 10; i++) if (maybeShowInvite()) shows++;
    expect(shows).toBe(3); // INVITE_MAX_SHOWS
    expect(shouldShowInvite()).toBe(false);
  });

  it("writes the invite to stderr, never stdout", async () => {
    setTTY(true);
    const { maybeShowInvite } = await import("../src/feedback/index.js");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(maybeShowInvite()).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("re-enables via `config set feedback on`", async () => {
    setTTY(true);
    const { dismissInvite, enableInvite, shouldShowInvite } = await import("../src/feedback/index.js");
    dismissInvite();
    expect(shouldShowInvite()).toBe(false);
    enableInvite();
    expect(shouldShowInvite()).toBe(true);
  });
});
