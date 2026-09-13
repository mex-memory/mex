import crossSpawn from "cross-spawn";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SetupInstallation } from "@mex/hub-contracts/setup";
import { ensureMexHomeDir, mexHomeDir } from "../global-config.js";
import { withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import { VERSION } from "../version.js";

export const globalInstallCommand = () => `npm install -g mex-agent@${VERSION}`;
type RunNpm = (args: readonly string[], cwd: string, signal: AbortSignal) => Promise<string>;

/** One owned, bounded npm operation. Shell output never reaches Hub or telemetry. */
export class SetupGlobalInstaller {
  private state: SetupInstallation = {
    state: "idle", version: VERSION, command: globalInstallCommand(),
    message: "Optional: install the mex command for this computer.",
  };
  private operation: Promise<void> | null = null;
  private controller: AbortController | null = null;
  constructor(private readonly runNpm: RunNpm = runNpmCommand) {}

  snapshot(): SetupInstallation { return { ...this.state }; }

  start(): SetupInstallation {
    if (this.operation || this.state.state === "succeeded") return this.snapshot();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.state = { ...this.state, state: "running", message: `Installing mex-agent@${VERSION}…` };
    this.operation = this.install(signal).finally(() => { this.operation = null; this.controller = null; });
    return this.snapshot();
  }

  async wait(): Promise<SetupInstallation> { await this.operation; return this.snapshot(); }
  async shutdown(): Promise<void> { this.controller?.abort(); await this.operation; }

  private async install(signal: AbortSignal): Promise<void> {
    let cwd: string | undefined;
    try {
      ensureMexHomeDir();
      await withContainedArtifactLock(mexHomeDir(), "setup", ".global-install.lock", async () => {
        cwd = mkdtempSync(join(tmpdir(), "mex-global-install-"));
        // A repository's .npmrc must not influence a machine-wide install.
        await this.runNpm(["install", "-g", `mex-agent@${VERSION}`, "--no-audit", "--no-fund"], cwd, signal);
        const installed = JSON.parse(await this.runNpm(["list", "-g", "mex-agent", "--depth=0", "--json"], cwd, signal));
        if (installed?.dependencies?.["mex-agent"]?.version !== VERSION) throw new Error("Installation could not be verified.");
      });
      this.state = { ...this.state, state: "succeeded", message: `Installed mex-agent@${VERSION}. Open a new terminal and run mex --version.` };
    } catch {
      this.state = { ...this.state, state: "failed", message: signal.aborted
        ? "Installation stopped. You can run the command below in your terminal."
        : "Global installation could not be completed or verified. Retry, or run the command below in your terminal. Setup is still complete." };
    } finally {
      if (cwd) { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* Temporary npm work can be cleaned by the OS. */ } }
    }
  }
}

function runNpmCommand(args: readonly string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Installation stopped.")); return; }
    const child = crossSpawn("npm", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    let bytes = 0;
    let stopped = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const kill = (force: boolean) => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          crossSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).once("error", () => { child.kill(); });
        } else {
          try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* Already exited. */ }
        }
      };
      kill(false);
      escalation = setTimeout(() => kill(true), 1000);
    };
    const timer = setTimeout(stop, 120_000);
    signal.addEventListener("abort", stop, { once: true });
    const clean = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); signal.removeEventListener("abort", stop); };
    const read = (chunk: Buffer, keep: boolean) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) stop();
      else if (keep) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => read(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => read(chunk, false));
    child.once("error", () => { clean(); reject(new Error("npm could not start.")); });
    child.once("close", (code) => { clean(); if (code === 0 && !stopped) resolve(output); else reject(new Error("npm did not finish.")); });
  });
}
