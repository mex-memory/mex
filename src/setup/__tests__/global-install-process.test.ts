import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("cross-spawn", () => ({ default: mocks.spawn }));
import { SetupGlobalInstaller } from "../global-install.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-install-process-test-"));
  vi.stubEnv("MEX_HOME", root); vi.clearAllMocks(); vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("bounded npm process", () => {
  it.each(["deadline", "output", "cancel"] as const)("stops the owned process tree after %s", async (reason) => {
    const stdout = new EventEmitter(); const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 987654321, stdout, stderr, kill: vi.fn() });
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") child.emit("close", null);
      return true;
    });
    mocks.spawn.mockImplementation((command) => {
      if (command === "taskkill") { queueMicrotask(() => child.emit("close", null)); return new EventEmitter(); }
      return child;
    });
    const installer = new SetupGlobalInstaller();
    installer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledWith("npm", expect.any(Array), expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    if (reason === "deadline") await vi.advanceTimersByTimeAsync(120_000);
    if (reason === "output") stderr.emit("data", Buffer.alloc(64 * 1024 + 1));
    const stopping = reason === "cancel" ? installer.shutdown() : undefined;
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(await installer.wait()).toMatchObject({ state: "failed" });
    if (process.platform === "win32") expect(mocks.spawn).toHaveBeenCalledWith("taskkill", ["/pid", "987654321", "/t", "/f"], expect.any(Object));
    else expect(kill).toHaveBeenCalledWith(-987654321, "SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  });
});
