import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriftStatus } from "@mex/hub-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDriftAlertHook, removeDriftAlertHook } from "../alert-hook.js";
import { runDriftAlertPass, sourceSnapshot } from "../alert-pass.js";
import { startDriftAlertSchedule } from "../alert-process.js";
import { readDriftAlertState, updateDriftAlertState } from "../alert-state.js";
import { notificationCommand } from "../notify.js";
import { initializeDriftAlerts, setDriftAlertsEnabled } from "../alert-settings.js";
import { driftAlertKey, MAX_ALERT_FILES } from "../alert-summary.js";
import { detectDrift, detectDriftForAlerts } from "../detect.js";
import { findConfig } from "../../config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-drift-alerts-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  return root;
}

function gitProject(): string {
  const root = project();
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function enable(root: string) {
  return updateDriftAlertState(root, (current) => ({ ...current, enabled: true }));
}

function needsSync(files: Array<[string, number]>): DriftStatus {
  return {
    state: "needs_sync",
    checkedAt: "2026-11-04T12:00:00.000Z",
    issueCount: files.length,
    fileCount: files.length,
    files: files.map(([path, errors]) => ({ path, errors, warnings: 0 })),
    commentOnlyCount: 0,
    warningOnlyCount: 0,
    codeLinks: "checked",
  };
}

const inSync: DriftStatus = { ...needsSync([]), state: "in_sync" };
// Far enough ahead that every file in a fresh fixture counts as settled.
const later = () => Date.now() + 60 * 60_000;

describe("runDriftAlertPass", () => {
  it("does nothing and writes nothing while alerts are off", async () => {
    const root = project();
    await setDriftAlertsEnabled(root, false);
    const before = readFileSync(join(root, ".mex/local/drift-alerts.json"), "utf8");
    const detect = vi.fn();
    await expect(runDriftAlertPass(root, { detect, now: later })).resolves.toBe("off");
    expect(detect).not.toHaveBeenCalled();
    expect(readFileSync(join(root, ".mex/local/drift-alerts.json"), "utf8")).toBe(before);
  });

  it("alerts once with fixed text, then stays quiet until drift is new", async () => {
    const root = project();
    await enable(root);
    const notify = vi.fn(async (_title: string, _body: string) => true);
    const detect = vi.fn(async () => needsSync([["a.md", 2]]));
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("sent");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toEqual([expect.stringMatching(/^MEX: /), "1 knowledge file may be out of date. Run mex sync."]);
    expect(readDriftAlertState(root).lastDelivery).toBe("sent");

    // Nothing changed on disk, so there is no new check at all.
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("unchanged");
    expect(detect).toHaveBeenCalledTimes(1);

    // Source changed but the same drift remains.
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("checked");
    expect(notify).toHaveBeenCalledTimes(1);

    // Fewer findings are progress, not new drift.
    writeFileSync(join(root, "a.ts"), "export const a = 3;\n");
    detect.mockResolvedValue(needsSync([["a.md", 1]]));
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("checked");

    // A new file is new drift, and so is more findings than the last alert.
    writeFileSync(join(root, "a.ts"), "export const a = 4;\n");
    detect.mockResolvedValue(needsSync([["a.md", 2], ["b.md", 1]]));
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("sent");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]?.[1]).toBe("2 knowledge files may be out of date. Run mex sync.");
  });

  it("alerts again when drift returns after the checkout was back in sync", async () => {
    const root = project();
    await enable(root);
    const notify = vi.fn(async () => true);
    const detect = vi.fn(async () => needsSync([["a.md", 1]]));
    await runDriftAlertPass(root, { detect, notify, now: later });
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    detect.mockResolvedValue(inSync);
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("checked");
    expect(readDriftAlertState(root).alerted).toEqual({});
    writeFileSync(join(root, "a.ts"), "export const a = 3;\n");
    detect.mockResolvedValue(needsSync([["a.md", 1]]));
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("sent");
  });

  it("does not alert for a comment review or a clean check", async () => {
    const root = project();
    await enable(root);
    const notify = vi.fn(async () => true);
    const detect = vi.fn(async (): Promise<DriftStatus> => ({ ...inSync, state: "comment_review", commentOnlyCount: 1 }));
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("checked");
    expect(notify).not.toHaveBeenCalled();
  });

  it("waits for the source to settle unless a commit started the check", async () => {
    const root = project();
    await enable(root);
    const notify = vi.fn(async () => true);
    const detect = vi.fn(async () => needsSync([["a.md", 1]]));
    await expect(runDriftAlertPass(root, { detect, notify })).resolves.toBe("waiting");
    expect(detect).not.toHaveBeenCalled();
    await expect(runDriftAlertPass(root, { detect, notify, afterCommit: true })).resolves.toBe("sent");
  });

  it("records a failed delivery and can alert for the same drift later", async () => {
    const root = project();
    await enable(root);
    const notify = vi.fn(async () => false);
    const detect = vi.fn(async () => needsSync([["a.md", 1]]));
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("failed");
    expect(readDriftAlertState(root)).toMatchObject({ lastDelivery: "failed", alerted: {} });
    notify.mockResolvedValue(true);
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("sent");
  });

  it("honors alerts being turned off during a check", async () => {
    const root = project();
    await enable(root);
    const notify = vi.fn(async () => true);
    const detect = vi.fn(async () => {
      await updateDriftAlertState(root, (current) => ({ ...current, enabled: false }));
      return needsSync([["a.md", 1]]);
    });
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("checked");
    expect(notify).not.toHaveBeenCalled();
  });

  it("sends one alert when two passes finish the same check", async () => {
    const root = project();
    await enable(root);
    const notify = vi.fn(async () => true);
    const detect = vi.fn(async () => needsSync([["a.md", 1]]));
    const outcomes = await Promise.all([
      runDriftAlertPass(root, { detect, notify, now: later }),
      runDriftAlertPass(root, { detect, notify, now: later }),
    ]);
    expect(outcomes.sort()).toEqual(["checked", "sent"]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("deduplicates the full drift corpus beyond the Hub's 100-file preview", async () => {
    const root = project();
    mkdirSync(join(root, ".mex/context"));
    for (let index = 0; index < 101; index++) {
      writeFileSync(join(root, `.mex/context/file-${index}.md`), `# Test\n\nSee \`src/missing-${index}.ts\`.\n`);
    }
    const config = findConfig(root);
    const preview = await detectDrift(config);
    const full = await detectDriftForAlerts(config);
    expect(preview.fileCount).toBeGreaterThan(100);
    expect(preview.files).toHaveLength(100);
    expect(full.files).toHaveLength(full.fileCount);
    const notify = vi.fn(async () => true);
    await expect(runDriftAlertPass(root, { notify, afterCommit: true })).resolves.toBe("sent");
    expect(Object.keys(readDriftAlertState(root).alerted)).toHaveLength(full.fileCount);
    writeFileSync(join(root, "a.ts"), "export const a = 42;\n");
    await expect(runDriftAlertPass(root, { notify, afterCommit: true })).resolves.toBe("checked");
    expect(notify).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("refuses an incomplete alert baseline rather than repeatedly notifying from a preview", async () => {
    const root = project();
    const status = { ...needsSync([["a.md", 1]]), fileCount: 101 };
    const notify = vi.fn(async () => true);
    await expect(runDriftAlertPass(root, { detect: async () => status, notify, afterCommit: true })).resolves.toBe("incomplete");
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".mex/local/drift-alerts.json"))).toBe(false);
  });

  it("rechecks after graph maintenance without restarting the source quiet period", async () => {
    const root = project();
    const detect = vi.fn(async () => ({ ...inSync, codeLinks: "partial" as const }));
    await runDriftAlertPass(root, { detect, now: later });
    writeFileSync(join(root, ".mex/graph.db"), "new graph identity");
    detect.mockResolvedValue({ ...needsSync([["a.md", 1]]), codeLinks: "checked" as never });
    const notify = vi.fn(async () => true);
    await expect(runDriftAlertPass(root, { detect, notify, now: later })).resolves.toBe("sent");
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("rechecks age-based findings on the next day without a source edit", async () => {
    const root = project();
    const now = Date.now() + 3_600_000;
    const detect = vi.fn(async () => inSync);
    await runDriftAlertPass(root, { detect, now: () => now });
    await runDriftAlertPass(root, { detect, now: () => now + 86_400_000 });
    expect(detect).toHaveBeenCalledTimes(2);
  });
});

describe("sourceSnapshot", () => {
  it("tracks graph identity, ignores Wiki/local state, and sees source changes without Git", () => {
    const root = project();
    const before = sourceSnapshot(root);
    writeFileSync(join(root, ".mex", "wiki.db"), "index");
    mkdirSync(join(root, ".mex", "local"));
    writeFileSync(join(root, ".mex", "local", "drift-alerts.json"), "{}");
    expect(sourceSnapshot(root)?.fingerprint).toBe(before?.fingerprint);
    writeFileSync(join(root, ".mex", "graph.db"), "graph");
    expect(sourceSnapshot(root)?.fingerprint).not.toBe(before?.fingerprint);
    expect(sourceSnapshot(root)?.newestMs).toBe(before?.newestMs);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, "a.ts"), past, past);
    expect(sourceSnapshot(root)?.fingerprint).not.toBe(before?.fingerprint);
    rmSync(join(root, "a.ts"));
    expect(sourceSnapshot(root)?.fingerprint).not.toBe(before?.fingerprint);
  });
});

describe("drift alert state", () => {
  it("defaults to on without creating a file, and fails closed on malformed state", () => {
    const root = project();
    expect(readDriftAlertState(root).enabled).toBe(true);
    expect(existsSync(join(root, ".mex", "local"))).toBe(false);
    mkdirSync(join(root, ".mex", "local"));
    writeFileSync(join(root, ".mex", "local", "drift-alerts.json"), '{"schemaVersion":1,"enabled":"yes"}');
    expect(() => readDriftAlertState(root)).toThrow();
  });

  it("keeps an explicit opt-out across initialization and supports legacy preferences without read-side writes", async () => {
    const root = gitProject();
    mkdirSync(join(root, ".mex/local"));
    const legacy = JSON.stringify({ schemaVersion: 1, enabled: false, commitHook: false, lastDelivery: "none", checkedFingerprint: "a".repeat(64), alerted: { "old.md": 1 } });
    writeFileSync(join(root, ".mex/local/drift-alerts.json"), legacy);
    expect(readDriftAlertState(root)).toMatchObject({ enabled: false, checkedFingerprint: null, alerted: { [driftAlertKey("old.md")]: 1 } });
    await initializeDriftAlerts(root);
    expect(readFileSync(join(root, ".mex/local/drift-alerts.json"), "utf8")).toBe(legacy);
    expect(existsSync(join(root, ".git/hooks/post-commit"))).toBe(false);
  });

  it("installs the default hook only at startup and removes it on opt-out", async () => {
    const root = gitProject();
    expect(readDriftAlertState(root).enabled).toBe(true);
    expect(existsSync(join(root, ".git/hooks/post-commit"))).toBe(false);
    await initializeDriftAlerts(root);
    expect(readDriftAlertState(root)).toMatchObject({ enabled: true, commitHook: true });
    expect(existsSync(join(root, ".git/hooks/post-commit"))).toBe(true);
    await setDriftAlertsEnabled(root, false);
    await initializeDriftAlerts(root);
    expect(readDriftAlertState(root)).toMatchObject({ enabled: false, commitHook: false });
    expect(existsSync(join(root, ".git/hooks/post-commit"))).toBe(false);
  });

  it("bounds complete hashed baselines within the stored byte ceiling", async () => {
    const root = project();
    const alerted = Object.fromEntries(Array.from({ length: MAX_ALERT_FILES }, (_, i) => [driftAlertKey(`file-${i}.md`), Number.MAX_SAFE_INTEGER]));
    await updateDriftAlertState(root, (current) => ({ ...current, alerted }));
    expect(statSync(join(root, ".mex/local/drift-alerts.json")).size).toBeLessThan(512 * 1024);
    await expect(updateDriftAlertState(root, (current) => ({ ...current, alerted: { ...alerted, [driftAlertKey("extra.md")]: 1 } }))).rejects.toThrow();
    expect(Object.keys(readDriftAlertState(root).alerted)).toHaveLength(MAX_ALERT_FILES);
  });
});

describe("drift alert hook", () => {
  const entry = "C:\\Program Files\\it's mex\\drift-alert.js";
  const hookPath = (root: string) => join(root, ".git", "hooks", "post-commit");

  it("creates a hook file when none exists and removes it again", () => {
    const root = gitProject();
    expect(installDriftAlertHook(root, entry)).toBe(true);
    const hook = readFileSync(hookPath(root), "utf8");
    expect(hook.startsWith("#!/bin/sh\n")).toBe(true);
    expect(hook).toContain(`'C:/Program Files/it'\\''s mex/drift-alert.js'`);
    expect(hook).toContain("--after-commit");
    expect(() => execFileSync("sh", ["-n", hookPath(root)])).not.toThrow();
    removeDriftAlertHook(root);
    expect(existsSync(hookPath(root))).toBe(false);
  });

  it("keeps what an existing hook does, and does not repeat its own block", () => {
    const root = gitProject();
    const original = "#!/bin/sh\necho mine\n";
    writeFileSync(hookPath(root), original);
    chmodSync(hookPath(root), 0o755);
    installDriftAlertHook(root, entry);
    installDriftAlertHook(root, "/moved/drift-alert.js");
    const hook = readFileSync(hookPath(root), "utf8");
    expect(hook).toContain("echo mine");
    expect(hook.match(/^# mex-drift-alert$/gm)).toHaveLength(1);
    expect(hook).toContain("/moved/drift-alert.js");
    expect(hook).not.toContain("it'\\''s mex");
    removeDriftAlertHook(root);
    expect(readFileSync(hookPath(root), "utf8")).toBe(original);
  });

  it("leaves a hook without its block alone", () => {
    const root = gitProject();
    writeFileSync(hookPath(root), "#!/bin/sh\necho mine\n");
    removeDriftAlertHook(root);
    expect(readFileSync(hookPath(root), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("adds nothing outside Git or when a hook manager owns the directory", () => {
    const plain = project();
    expect(installDriftAlertHook(plain, entry)).toBe(false);
    expect(() => removeDriftAlertHook(plain)).not.toThrow();
    const managed = gitProject();
    execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: managed });
    expect(installDriftAlertHook(managed, entry)).toBe(false);
    expect(existsSync(hookPath(managed))).toBe(false);
  });

  it.each(["#!/usr/bin/env python3\nprint('original')\n", "#!/usr/bin/env node\nconsole.log('original');\n"])("preserves an existing non-shell hook: %s", (original) => {
    const root = gitProject();
    writeFileSync(hookPath(root), original);
    chmodSync(hookPath(root), 0o750);
    const mode = statSync(hookPath(root)).mode;
    expect(installDriftAlertHook(root, entry)).toBe(false);
    expect(readFileSync(hookPath(root), "utf8")).toBe(original);
    expect(statSync(hookPath(root)).mode).toBe(mode);
  });

  it("does not activate an existing inactive hook", () => {
    if (process.platform === "win32") return;
    const root = gitProject();
    const original = "#!/bin/sh\necho inactive\n";
    writeFileSync(hookPath(root), original, { mode: 0o644 });
    expect(installDriftAlertHook(root, entry)).toBe(false);
    expect(readFileSync(hookPath(root), "utf8")).toBe(original);
    expect(statSync(hookPath(root)).mode & 0o111).toBe(0);
  });
});

describe("startDriftAlertSchedule", () => {
  it("runs only while alerts are on, and stops", async () => {
    vi.useFakeTimers();
    try {
      const root = project();
      vi.useRealTimers();
      await setDriftAlertsEnabled(root, false);
      vi.useFakeTimers();
      const run = vi.fn();
      const stop = startDriftAlertSchedule(root, { run }, 1_000);
      expect(run).not.toHaveBeenCalled();
      vi.useRealTimers();
      await enable(root);
      vi.useFakeTimers();
      const running = startDriftAlertSchedule(root, { run }, 1_000);
      expect(run).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      expect(run).toHaveBeenCalledTimes(3);
      running();
      stop();
      vi.advanceTimersByTime(5_000);
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("notificationCommand", () => {
  const hostile = `x"; rm -rf / $(whoami) '`;

  it("never puts text inside a script or a shell string", () => {
    const windows = notificationCommand("win32", hostile, "body")!;
    expect(windows.args.join(" ")).not.toContain(hostile);
    expect(windows.env).toEqual({ MEX_NOTIFY_TITLE: hostile, MEX_NOTIFY_BODY: "body" });
    const mac = notificationCommand("darwin", hostile, "body")!;
    expect(mac.command).toBe("osascript");
    expect(mac.args.slice(-2)).toEqual([hostile, "body"]);
    const linux = notificationCommand("linux", hostile, "body")!;
    expect(linux.command).toBe("notify-send");
    expect(linux.args.slice(-2)).toEqual([hostile, "body"]);
  });

  it("has no notifier on other platforms", () => {
    expect(notificationCommand("freebsd", "title", "body")).toBeNull();
  });
});
