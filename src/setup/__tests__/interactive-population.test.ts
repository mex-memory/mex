import crossSpawn from "cross-spawn";
import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchInteractiveSetupPopulation, type InteractivePopulationOptions } from "../interactive-population.js";

const roots: string[] = [];
const emergencyCleanup = new Set<number>();
// The sandbox may explicitly disallow ps. Keep unit coverage there, and run this
// real ancestry adapter scenario where the OS permits process enumeration.
const canInspectProcesses = (() => {
  if (process.platform === "win32") return false;
  try { execFileSync("ps", ["-o", "pid=", "-p", String(process.pid)], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

afterEach(() => {
  vi.restoreAllMocks();
  for (const pid of emergencyCleanup) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
  emergencyCleanup.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-native-population-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  return root;
}

function fakeChild(pid = 912_345): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, kill: vi.fn(() => true) }) as unknown as ChildProcess;
}

function exited(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null = null): void {
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

function launchOptions(projectRoot: string, child: ChildProcess, afterSpawn?: (args: readonly string[]) => void): InteractivePopulationOptions {
  return {
    projectRoot, selectedTools: ["codex"], prompt: "Private project context",
    __internal: {
      isAvailable: async () => true,
      snapshot: async () => [],
      spawn: vi.fn((_command, args) => {
        queueMicrotask(() => afterSpawn?.(args as string[]));
        return child;
      }) as unknown as typeof crossSpawn,
    },
  };
}

describe("native interactive setup population", () => {
  it("inherits the foreground terminal and keeps the complete private prompt off argv", async () => {
    const root = fixture();
    const child = fakeChild();
    const prompt = "Private context\n".repeat(4_096);
    const options = launchOptions(root, child, (args) => {
      expect(args).toHaveLength(1);
      expect(args[0]!.length).toBeLessThan(256);
      const pointer = /`([^`]+)`/u.exec(args[0]!)![1]!;
      const file = join(root, pointer);
      expect(readFileSync(file, "utf8")).toBe(prompt);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
      exited(child, 0);
    });
    const result = await launchInteractiveSetupPopulation({ ...options, prompt });
    expect(result).toEqual({ tool: "codex", status: "exited", exitCode: 0, signal: null });
    expect(options.__internal!.spawn).toHaveBeenCalledWith("codex", expect.any(Array), {
      cwd: root, stdio: "inherit", detached: false,
    });
    expect(readdirSync(join(root, ".mex/local"))).toEqual([]);
  });

  it("respects selection order and never launches unselected CLIs", async () => {
    const root = fixture();
    const child = fakeChild();
    const available = vi.fn(async (command: string) => command === "claude");
    const options = launchOptions(root, child, () => exited(child, 0));
    const result = await launchInteractiveSetupPopulation({ ...options, selectedTools: ["cursor", "codex", "claude"],
      __internal: { ...options.__internal, isAvailable: available } });
    expect(available.mock.calls).toEqual([["codex"], ["claude"]]);
    expect(result.tool).toBe("claude");
    expect(options.__internal!.spawn).toHaveBeenCalledWith("claude", expect.any(Array), expect.any(Object));
    expect(await launchInteractiveSetupPopulation({ ...options, selectedTools: ["cursor"] })).toMatchObject({ tool: null, status: "unavailable" });
  });

  it("does not create a prompt when no selected CLI is available", async () => {
    const root = fixture();
    const options = launchOptions(root, fakeChild());
    expect(await launchInteractiveSetupPopulation({ ...options,
      __internal: { ...options.__internal, isAvailable: async () => false } })).toMatchObject({ status: "unavailable", tool: null });
    expect(options.__internal!.spawn).not.toHaveBeenCalled();
    expect(readdirSync(join(root, ".mex"))).toEqual([]);
  });

  it("returns a safe actionable result if CLI discovery throws", async () => {
    const root = fixture();
    const options = launchOptions(root, fakeChild());
    const result = await launchInteractiveSetupPopulation({ ...options, __internal: {
      ...options.__internal, isAvailable: async () => { throw new Error("Private process diagnostics"); },
    } });
    expect(result).toMatchObject({ status: "failed", tool: null, message: expect.stringContaining("PATH") });
    expect(result.message).not.toContain("Private");
    expect(options.__internal!.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { code: 7, signal: null, status: "failed" },
    { code: null, signal: "SIGTERM", status: "failed" },
    { code: null, signal: "SIGINT", status: "cancelled" },
  ] as const)("classifies native exit $code / $signal as $status", async ({ code, signal, status }) => {
    const root = fixture();
    const child = fakeChild();
    expect(await launchInteractiveSetupPopulation(launchOptions(root, child, () => exited(child, code, signal))))
      .toMatchObject({ tool: "codex", status, exitCode: code, signal });
    expect(readdirSync(join(root, ".mex/local"))).toEqual([]);
  });

  it.each(["throw", "event"] as const)("settles a spawn %s and removes the prompt", async (failure) => {
    const root = fixture();
    const child = fakeChild();
    const options = launchOptions(root, child, () => {
      child.emit("error", new Error("Private diagnostic"));
      exited(child, -2);
    });
    const result = await launchInteractiveSetupPopulation(failure === "throw" ? { ...options, __internal: {
      ...options.__internal, spawn: vi.fn(() => { throw new Error("Private diagnostic"); }) as unknown as typeof crossSpawn,
    } } : options);
    expect(result).toMatchObject({ tool: "codex", status: "failed", message: expect.stringContaining("could not start") });
    expect(result.message).not.toContain("Private diagnostic");
    expect(readdirSync(join(root, ".mex/local"))).toEqual([]);
  });

  it.each(["before discovery", "during discovery", "during spawn"] as const)("honors cancellation %s", async (timing) => {
    const root = fixture();
    const abort = new AbortController();
    const child = fakeChild();
    vi.mocked(child.kill).mockImplementation((signal) => { queueMicrotask(() => exited(child, null, signal as NodeJS.Signals)); return true; });
    const options = launchOptions(root, child);
    if (timing === "before discovery") abort.abort();
    const result = await launchInteractiveSetupPopulation({ ...options, signal: abort.signal, __internal: {
      ...options.__internal,
      isAvailable: async () => { if (timing === "during discovery") abort.abort(); return true; },
      spawn: ((_command, _args, _options) => { abort.abort(); return child; }) as typeof crossSpawn,
    } });
    expect(result.status).toBe("cancelled");
    expect(existsSync(join(root, ".mex/local")) ? readdirSync(join(root, ".mex/local")) : []).toEqual([]);
    if (timing !== "during spawn") expect(child.kill).not.toHaveBeenCalled();
  });

  it("returns an actionable failure when the private prompt cannot be prepared", async () => {
    const root = fixture();
    writeFileSync(join(root, ".mex/local"), "User-owned file");
    const options = launchOptions(root, fakeChild());
    expect(await launchInteractiveSetupPopulation(options)).toMatchObject({ status: "failed", message: expect.stringContaining("could not be prepared") });
    expect(options.__internal!.spawn).not.toHaveBeenCalled();
    expect(readFileSync(join(root, ".mex/local"), "utf8")).toBe("User-owned file");
  });
});

describe.skipIf(process.platform === "win32")("interactive process ownership", () => {
  it.each([false, true])("cleans observed helpers after a clean agent exit (signal failure: %s)", async (denied) => {
    const root = fixture();
    const child = fakeChild();
    let processes = [
      { pid: child.pid!, parentPid: process.pid, started: "root" },
      { pid: child.pid! + 1, parentPid: child.pid!, started: "helper" },
    ];
    const snapshot = vi.fn(async () => processes);
    const kill = vi.fn(() => {
      if (denied) throw Object.assign(new Error("Private diagnostic"), { code: "EPERM" });
      processes = [];
    });
    const options = launchOptions(root, child);
    const resultPromise = launchInteractiveSetupPopulation({ ...options, __internal: { ...options.__internal, snapshot, kill } });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
    processes = [{ ...processes[1]!, parentPid: 1 }];
    exited(child, 0);
    const result = await resultPromise;
    expect(result.status).toBe(denied ? "failed" : "exited");
    if (denied) expect(result.message).toContain("could not verify");
    expect(kill).toHaveBeenCalledWith(child.pid! + 1, "SIGTERM");
    expect(readdirSync(join(root, ".mex/local"))).toEqual([]);
  });

  it("escalates only matching observed descendants and keeps the prompt until cleanup finishes", async () => {
    const root = fixture();
    const abort = new AbortController();
    const child = fakeChild();
    const rootProcess = { pid: child.pid!, parentPid: process.pid, started: "root-start" };
    const descendant = { pid: child.pid! + 1, parentPid: child.pid!, started: "child-start" };
    const grandchild = { pid: child.pid! + 2, parentPid: descendant.pid, started: "grandchild-start" };
    const sibling = { pid: child.pid! + 3, parentPid: process.pid, started: "sibling-start" };
    let processes = [rootProcess, descendant, grandchild, sibling];
    const kill = vi.fn();
    vi.mocked(child.kill).mockImplementation((signal) => {
      expect(readdirSync(join(root, ".mex/local"))).toHaveLength(1);
      if (signal === "SIGTERM") {
        processes = [{ ...descendant, parentPid: 1, started: "reused-pid" }, { ...grandchild, parentPid: 1 }, sibling];
        exited(child, null, "SIGTERM");
      }
      return true;
    });
    const options = launchOptions(root, child);
    const resultPromise = launchInteractiveSetupPopulation({ ...options, signal: abort.signal, __internal: {
      ...options.__internal, snapshot: async () => processes, kill,
    } });
    await vi.waitFor(() => expect(options.__internal!.spawn).toHaveBeenCalled());
    abort.abort();
    const result = await resultPromise;
    expect(result.status).toBe("cancelled");
    expect(kill.mock.calls).toEqual([[grandchild.pid, "SIGTERM"], [descendant.pid, "SIGTERM"], [grandchild.pid, "SIGKILL"]]);
    expect(readdirSync(join(root, ".mex/local"))).toEqual([]);
  });

  it("does not signal stale descendant identities if process enumeration fails", async () => {
    const root = fixture();
    const child = fakeChild();
    const abort = new AbortController();
    let enumerationFails = false;
    const snapshot = vi.fn(async () => enumerationFails ? null : [
      { pid: child.pid!, parentPid: process.pid, started: "root" },
      { pid: child.pid! + 1, parentPid: child.pid!, started: "child" },
    ]);
    const kill = vi.fn();
    vi.mocked(child.kill).mockImplementation((signal) => { exited(child, null, signal as NodeJS.Signals); return true; });
    const options = launchOptions(root, child);
    const resultPromise = launchInteractiveSetupPopulation({ ...options, signal: abort.signal,
      __internal: { ...options.__internal, snapshot, kill } });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
    enumerationFails = true;
    abort.abort();
    expect(await resultPromise).toMatchObject({ status: "cancelled", message: expect.stringContaining("could not verify") });
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not report a clean agent exit when descendant cleanup cannot be verified", async () => {
    const root = fixture();
    const child = fakeChild();
    const options = launchOptions(root, child, () => exited(child, 0));
    expect(await launchInteractiveSetupPopulation({ ...options,
      __internal: { ...options.__internal, snapshot: async () => { throw new Error("Private diagnostic"); } },
    })).toMatchObject({ status: "failed", exitCode: 0, message: expect.stringContaining("could not verify") });
    expect(readdirSync(join(root, ".mex/local"))).toEqual([]);
  });

  it.skipIf(!canInspectProcesses)("stops a real resistant agent and its grandchild without signalling an unrelated sibling", async () => {
    const root = fixture();
    const abort = new AbortController();
    const workerFile = join(root, "worker.cjs");
    writeFileSync(workerFile, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const agentFile = join(root, "agent.cjs");
    const marker = join(root, "child-pid");
    writeFileSync(agentFile, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
      process.on('SIGTERM', () => {});
      const worker=spawn(process.execPath, [${JSON.stringify(workerFile)}], {stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(marker)}, String(worker.pid)); setInterval(() => {}, 1000);`);
    const sibling = crossSpawn(process.execPath, [workerFile], { stdio: "ignore" });
    emergencyCleanup.add(sibling.pid!);
    let agent: ChildProcess | undefined;
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });
    const options: InteractivePopulationOptions = {
      projectRoot: root, selectedTools: ["codex"], prompt: "Private setup", signal: abort.signal,
      __internal: { isAvailable: async () => true, kill, spawn: ((_command, _args, spawnOptions) => {
        agent = crossSpawn(process.execPath, [agentFile], spawnOptions);
        emergencyCleanup.add(agent.pid!);
        return agent;
      }) as typeof crossSpawn },
    };
    const resultPromise = launchInteractiveSetupPopulation(options);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    const workerPid = Number(readFileSync(marker, "utf8"));
    emergencyCleanup.add(workerPid);
    // Allow a heartbeat to observe the worker before cancellation reparents it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    abort.abort();
    expect(await resultPromise).toMatchObject({ status: "cancelled", signal: "SIGKILL" });
    expect(agent!.exitCode).toBeNull();
    expect(agent!.signalCode).toBe("SIGKILL");
    expect(kill).toHaveBeenCalledWith(workerPid, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(workerPid, "SIGKILL");
    // Some process supervisors defer reaping an orphaned zombie. It cannot run
    // or write files, so distinguish it from a surviving worker.
    await vi.waitFor(() => {
      let status = "";
      try { status = execFileSync("ps", ["-o", "stat=", "-p", String(workerPid)], { encoding: "utf8" }).trim(); } catch { /* Reaped. */ }
      expect(status === "" || status.startsWith("Z")).toBe(true);
    });
    expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
    expect(readdirSync(join(root, ".mex/local"))).toEqual([]);
  });
});
