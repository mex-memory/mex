import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetupNext } from "../next.js";
import { runHeadlessSetup } from "../headless.js";
import { SETUP_LOCK_FILE, acquireSetupLock, assertSetupAvailable, withSetupLock } from "../setup-lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setup lock (#310)", () => {
  it("refuses a second setup while one holds the checkout, and frees it on release", () => {
    const mexDir = join(fixture(), ".mex");
    const first = acquireSetupLock(mexDir);

    expect(() => acquireSetupLock(mexDir)).toThrow(
      new RegExp(`Another MEX setup is already running in this checkout \\(process ${process.pid}, started `, "u"),
    );

    first.release();
    expect(existsSync(join(mexDir, SETUP_LOCK_FILE))).toBe(false);
    acquireSetupLock(mexDir).release();
  });

  it("reclaims a lock whose process on this host is gone", () => {
    const mexDir = join(fixture(), ".mex");
    writeLock(mexDir, { pid: exitedPid(), host: hostname() });

    const lock = acquireSetupLock(mexDir);

    lock.release();
    // Nothing is left beside it: the abandoned lock was moved aside and removed.
    expect(readdirSync(join(mexDir, "local"))).toEqual([]);
  });

  it("never reclaims a lock from another host, and says how to clear it", () => {
    const mexDir = join(fixture(), ".mex");
    writeLock(mexDir, { pid: exitedPid(), host: `${hostname()}-elsewhere` });

    expect(() => acquireSetupLock(mexDir)).toThrow(/on .+-elsewhere .*delete \.mex\/local\/setup\.lock/u);
  });

  it("treats an unreadable lock as being written until it is clearly old", () => {
    const mexDir = join(fixture(), ".mex");
    mkdirSync(join(mexDir, "local"), { recursive: true });
    const path = join(mexDir, SETUP_LOCK_FILE);
    writeFileSync(path, "");

    expect(() => acquireSetupLock(mexDir)).toThrow(/already running/u);

    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    acquireSetupLock(mexDir).release();
  });

  it("does not remove a lock another run took after its own was reclaimed", () => {
    const mexDir = join(fixture(), ".mex");
    const stale = acquireSetupLock(mexDir);
    // Simulate this run's lock being reclaimed and taken by a later run.
    writeLock(mexDir, { pid: process.pid, host: hostname(), token: "later-run" }, true);

    stale.release();

    expect(existsSync(join(mexDir, SETUP_LOCK_FILE))).toBe(true);
  });

  it("refuses a .mex/local that is a symlink", () => {
    const root = fixture();
    const mexDir = join(root, ".mex");
    mkdirSync(mexDir);
    mkdirSync(join(root, "elsewhere"));
    try {
      symlinkSync(join(root, "elsewhere"), join(mexDir, "local"), "dir");
    } catch {
      return; // Creating symlinks needs a privilege this Windows account lacks.
    }

    expect(() => acquireSetupLock(mexDir)).toThrow(".mex/local must be a regular directory");
    expect(readdirSync(join(root, "elsewhere"))).toEqual([]);
  });

  it("one running flow blocks both the headless engine and setup next", async () => {
    const root = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    let release!: () => void;
    const waiting = new Promise<void>(done => { release = done; });
    const running = withSetupLock(join(root, ".mex"), () => waiting);
    try {
      await expect(runHeadlessSetup({ projectRoot: root, tools: [] })).rejects.toThrow(/Another MEX setup is already running/u);
      expect(await runSetupNext({ projectRoot: root })).toMatchObject({ status: "blocked", exitCode: 1, output: expect.stringContaining("Another MEX setup is already running") });
      expect(readdirSync(join(root, ".mex", "local"))).toEqual(["setup.lock"]);
    } finally { release(); await running; }
    expect(existsSync(join(root, ".mex", SETUP_LOCK_FILE))).toBe(false);
  });

  it("lets a queue call enter its own preparation engine without releasing the lease", async () => {
    const mexDir = join(fixture(), ".mex");
    await withSetupLock(mexDir, async () => {
      await withSetupLock(mexDir, async () => {
        expect(() => acquireSetupLock(mexDir)).toThrow(/already running/u);
      });
      expect(existsSync(join(mexDir, SETUP_LOCK_FILE))).toBe(true);
    });
    expect(existsSync(join(mexDir, SETUP_LOCK_FILE))).toBe(false);
  });

  it("stops a second runHeadlessSetup before it changes anything", async () => {
    const root = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, "index.ts"), "export const answer = 42;\n");
    const held = acquireSetupLock(join(root, ".mex"));
    try {
      await expect(runHeadlessSetup({ projectRoot: root, mode: "code-repo", tools: [] }))
        .rejects.toThrow(/Another MEX setup is already running/u);
      expect(readdirSync(join(root, ".mex"))).toEqual(["local"]);
      expect(readdirSync(join(root, ".mex", "local"))).toEqual(["setup.lock"]);
    } finally {
      held.release();
    }
  });
  it("reports a live setup before anything changes, and ignores an abandoned one", () => {
    const mexDir = join(fixture(), ".mex");
    expect(() => assertSetupAvailable(mexDir)).not.toThrow();
    const lock = acquireSetupLock(mexDir);
    expect(() => assertSetupAvailable(mexDir)).toThrow(/already running/u);
    lock.release();
    writeLock(mexDir, { pid: exitedPid(), host: hostname() });
    expect(() => assertSetupAvailable(mexDir)).not.toThrow();
  });

  it("reclaims a lock whose pid now belongs to a process started after the lock, or copied from another clone", () => {
    const mexDir = join(fixture(), ".mex");
    writeLock(mexDir, { pid: process.pid, host: hostname() }, false);
    writeFileSync(join(mexDir, SETUP_LOCK_FILE), JSON.stringify({ pid: process.pid, host: hostname(), token: "old", startedAt: "2020-01-01T00:00:00.000Z" }));
    acquireSetupLock(mexDir).release();
    writeFileSync(join(mexDir, SETUP_LOCK_FILE), JSON.stringify({ pid: process.pid, host: hostname(), token: "copied", startedAt: new Date().toISOString(), root: join(mexDir, "other") }));
    acquireSetupLock(mexDir).release();
  });

  it("does not delete a live lock that replaced the abandoned one this run had judged", () => {
    const mexDir = join(fixture(), ".mex");
    writeLock(mexDir, { pid: exitedPid(), host: hostname() });
    const path = join(mexDir, SETUP_LOCK_FILE);
    const live = JSON.stringify({ pid: process.pid, host: hostname(), token: "live", startedAt: new Date().toISOString() });
    // This run reads the abandoned lock and judges it; before it removes it,
    // another run has reclaimed it and a live owner holds the path.
    let calls = 0;
    const now = () => { calls += 1; if (calls === 2) writeFileSync(path, live); return new Date(); };
    expect(() => acquireSetupLock(mexDir, now)).toThrow(/already running/u);
    expect(readFileSync(path, "utf8")).toBe(live);
  });

  it("clears a crash-leftover reclaim gate and then reclaims", () => {
    const mexDir = join(fixture(), ".mex");
    writeLock(mexDir, { pid: exitedPid(), host: hostname() });
    const gate = join(mexDir, "local", "setup.lock.reclaim");
    writeFileSync(gate, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(gate, old, old);
    expect(() => acquireSetupLock(mexDir)).toThrow(/already running/u);
    acquireSetupLock(mexDir).release();
    expect(existsSync(gate)).toBe(false);
  });

  it("releases the lock when the run fails", async () => {
    const mexDir = join(fixture(), ".mex");
    await expect(withSetupLock(mexDir, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(existsSync(join(mexDir, SETUP_LOCK_FILE))).toBe(false);
  });

  it("does not let a continuation inherited from a finished run reuse its lock", async () => {
    const mexDir = join(fixture(), ".mex");
    let later!: () => Promise<void>;
    await withSetupLock(mexDir, async () => {
      const { AsyncResource } = await import("node:async_hooks");
      const resource = new AsyncResource("late setup");
      later = () => resource.runInAsyncScope(() => withSetupLock(mexDir, async () => {}));
    });
    const next = acquireSetupLock(mexDir);
    try { await expect(later()).rejects.toThrow(/already running/u); }
    finally { next.release(); }
  });
});

function writeLock(mexDir: string, owner: { pid: number; host: string; token?: string }, replace = false): void {
  mkdirSync(join(mexDir, "local"), { recursive: true });
  const path = join(mexDir, SETUP_LOCK_FILE);
  if (replace) rmSync(path, { force: true });
  writeFileSync(path, `${JSON.stringify({ token: "abandoned", startedAt: new Date().toISOString(), ...owner })}\n`);
}

/** The pid of a process that has already exited. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-lock-"));
  roots.push(root);
  return root;
}
