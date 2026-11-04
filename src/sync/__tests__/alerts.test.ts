import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriftStatus } from "@mex/hub-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDriftAlertHook, removeDriftAlertHook } from "../alert-hook.js";
import { runDriftAlertPass, sourceSnapshot } from "../alert-pass.js";
import { startDriftAlertSchedule } from "../alert-process.js";
import { readDriftAlertState, updateDriftAlertState } from "../alert-state.js";
import { notificationCommand } from "../notify.js";

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
    const detect = vi.fn();
    await expect(runDriftAlertPass(root, { detect, now: later })).resolves.toBe("off");
    expect(detect).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".mex", "local", "drift-alerts.json"))).toBe(false);
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
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
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
});

describe("sourceSnapshot", () => {
  it("ignores disposable indexes and local state without Git, and sees source changes", () => {
    const root = project();
    const before = sourceSnapshot(root);
    writeFileSync(join(root, ".mex", "graph.db"), "index");
    mkdirSync(join(root, ".mex", "local"));
    writeFileSync(join(root, ".mex", "local", "drift-alerts.json"), "{}");
    expect(sourceSnapshot(root)?.fingerprint).toBe(before?.fingerprint);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, "a.ts"), past, past);
    expect(sourceSnapshot(root)?.fingerprint).not.toBe(before?.fingerprint);
    rmSync(join(root, "a.ts"));
    expect(sourceSnapshot(root)?.fingerprint).not.toBe(before?.fingerprint);
  });
});

describe("drift alert state", () => {
  it("defaults to off without creating a file, and fails closed on malformed state", () => {
    const root = project();
    expect(readDriftAlertState(root).enabled).toBe(false);
    expect(existsSync(join(root, ".mex", "local"))).toBe(false);
    mkdirSync(join(root, ".mex", "local"));
    writeFileSync(join(root, ".mex", "local", "drift-alerts.json"), '{"schemaVersion":1,"enabled":"yes"}');
    expect(() => readDriftAlertState(root)).toThrow();
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
});

describe("startDriftAlertSchedule", () => {
  it("runs only while alerts are on, and stops", async () => {
    vi.useFakeTimers();
    try {
      const root = project();
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
