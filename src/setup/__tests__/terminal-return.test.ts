import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { waitForTerminalReturn } from "../terminal-return.js";

function reader() {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  const spawn = vi.fn(() => child);
  return { child, spawn };
}

describe("waiting for Enter while the HUD is suspended", () => {
  it("reads the line in a child with the terminal inherited, never in this process", async () => {
    const { child, spawn } = reader();
    const waiting = waitForTerminalReturn(new AbortController().signal, { spawn });
    expect(spawn).toHaveBeenCalledWith(process.execPath, ["-e", expect.any(String)],
      { stdio: ["inherit", "ignore", "inherit"], windowsHide: true });
    child.emit("exit", 0, null);
    await expect(waiting).resolves.toBe("return");
  });

  it.each([["end of input", 3, null], ["an interrupt", null, "SIGINT"]])("cancels on %s", async (_name, code, signal) => {
    const { child, spawn } = reader();
    const waiting = waitForTerminalReturn(new AbortController().signal, { spawn });
    child.emit("exit", code, signal);
    await expect(waiting).resolves.toBe("cancel");
  });

  it("stops the reader when setup is cancelled or the wait is released", async () => {
    const { child, spawn } = reader();
    const controller = new AbortController();
    const waiting = waitForTerminalReturn(controller.signal, { spawn });
    controller.abort();
    await expect(waiting).resolves.toBe("cancel");
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", null, "SIGTERM");
    await expect(waiting).resolves.toBe("cancel");
  });

  it("does not start a reader after cancellation and never strands the HUD on a launch failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const { spawn } = reader();
    await expect(waitForTerminalReturn(controller.signal, { spawn })).resolves.toBe("cancel");
    expect(spawn).not.toHaveBeenCalled();

    await expect(waitForTerminalReturn(new AbortController().signal, { spawn: () => { throw new Error("EMFILE"); } }))
      .resolves.toBe("return");
    const failed = reader();
    const waiting = waitForTerminalReturn(new AbortController().signal, { spawn: failed.spawn });
    failed.child.emit("error", new Error("ENOENT"));
    await expect(waiting).resolves.toBe("return");
  });

  it("returns on Enter and cancels at end of input with the real reader", async () => {
    const { spawn } = await import("node:child_process");
    const run = (input: string) => waitForTerminalReturn(new AbortController().signal, {
      spawn: (command, args) => {
        const child = spawn(command, args, { stdio: ["pipe", "ignore", "inherit"], windowsHide: true });
        child.stdin!.end(input);
        return child;
      },
    });
    await expect(run("\n")).resolves.toBe("return");
    await expect(run("")).resolves.toBe("cancel");
  }, 20_000);
});
