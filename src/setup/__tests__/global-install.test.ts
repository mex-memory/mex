import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupGlobalInstaller } from "../global-install.js";
import { VERSION } from "../../version.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mex-install-test-")); vi.stubEnv("MEX_HOME", root); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const verified = JSON.stringify({ dependencies: { "mex-agent": { version: VERSION } } });

describe("optional global installation", () => {
  it("is read-only until requested, pins the running version, verifies it, and avoids duplicate installs", async () => {
    const run = vi.fn(async (args: readonly string[], _cwd: string, _signal: AbortSignal) => args[0] === "list" ? verified : "");
    const installer = new SetupGlobalInstaller(run);
    expect(installer.snapshot()).toMatchObject({ state: "idle", version: VERSION, command: `npm install -g mex-agent@${VERSION}` });
    expect(readdirSync(root)).toEqual([]);
    installer.start(); installer.start();
    expect(await installer.wait()).toMatchObject({ state: "succeeded" });
    expect(run).toHaveBeenCalledTimes(2);
    const [args, cwd] = run.mock.calls[0]!;
    expect(args).toEqual(["install", "-g", `mex-agent@${VERSION}`, "--no-audit", "--no-fund"]);
    expect(cwd).not.toBe(process.cwd());
    expect(existsSync(cwd)).toBe(false);
    installer.start(); await installer.wait();
    expect(run).toHaveBeenCalledTimes(2);
    await installer.shutdown();
  });

  it("keeps failed installation optional, hides private output, and permits a retry", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("private npm token/path")).mockResolvedValueOnce("").mockResolvedValueOnce(verified);
    const installer = new SetupGlobalInstaller(run);
    installer.start();
    expect(await installer.wait()).toMatchObject({ state: "failed", message: expect.stringContaining("Setup is still complete") });
    expect(JSON.stringify(installer.snapshot())).not.toContain("private");
    installer.start();
    expect(await installer.wait()).toMatchObject({ state: "succeeded" });
  });

  it("does not report success for another installed version", async () => {
    const installer = new SetupGlobalInstaller(async () => '{"dependencies":{"mex-agent":{"version":"0.0.0"}}}');
    installer.start();
    expect(await installer.wait()).toMatchObject({ state: "failed" });
  });

  it("owns cancellation and waits for the installer to stop on shutdown", async () => {
    let signal!: AbortSignal;
    const run = vi.fn(async (_args: readonly string[], _cwd: string, operation: AbortSignal) => {
      signal = operation;
      return new Promise<string>((_resolve, reject) => operation.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const installer = new SetupGlobalInstaller(run);
    installer.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await installer.shutdown();
    expect(signal.aborted).toBe(true);
    expect(installer.snapshot()).toMatchObject({ state: "failed", message: expect.stringContaining("stopped") });
  });
});
