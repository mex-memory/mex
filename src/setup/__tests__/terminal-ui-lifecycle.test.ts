import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalSetupUI, type TerminalSetupView } from "../terminal-ui.js";
import { stdin } from "node:process";

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("ink", async importOriginal => ({ ...await importOriginal<typeof import("ink")>(), render }));

const view: TerminalSetupView = {
  projectName: "example", mode: "code-repo", screen: "progress", tools: [],
  completedSteps: [], detail: "Preparing", startedAt: 0,
};

function renderer() {
  let flush!: () => void;
  let fail!: (error: Error) => void;
  const exited = new Promise<void>((resolve, reject) => { flush = resolve; fail = reject; });
  const instance = { rerender: vi.fn(), unmount: vi.fn(), waitUntilExit: vi.fn(() => exited), cleanup: vi.fn() };
  return { instance, flush, fail };
}

beforeEach(() => { vi.restoreAllMocks(); render.mockReset(); });

describe("terminal setup renderer ownership", () => {
  it("waits for terminal restoration before handing control back and creates a fresh renderer on resume", async () => {
    const first = renderer();
    const second = renderer();
    render.mockReturnValueOnce(first.instance).mockReturnValueOnce(second.instance);
    const ui = createTerminalSetupUI(view, vi.fn());
    expect(render.mock.calls[0][1]).toEqual({ alternateScreen: true, patchConsole: false, exitOnCtrlC: false });
    let suspended = false;
    const handoff = ui.suspend().then(() => { suspended = true; });
    expect(first.instance.unmount).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(suspended).toBe(false);
    expect(first.instance.cleanup).not.toHaveBeenCalled();
    ui.update({ ...view, detail: "Native agent owns the terminal" });
    expect(first.instance.rerender).not.toHaveBeenCalled();
    first.flush();
    await handoff;
    expect(first.instance.cleanup).toHaveBeenCalledOnce();
    ui.resume({ ...view, screen: "population", detail: "Welcome back" });
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1][0].props.view.detail).toBe("Welcome back");
    const closing = ui.close();
    second.flush();
    await closing;
    expect(second.instance.cleanup).toHaveBeenCalledOnce();
    ui.resume(view);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated teardown and never mounts a queued resume after close", async () => {
    const current = renderer();
    const pause = vi.spyOn(stdin, "pause");
    render.mockReturnValue(current.instance);
    const ui = createTerminalSetupUI(view, vi.fn());
    const first = ui.suspend();
    const second = ui.suspend();
    ui.resume(view);
    const closing = ui.close();
    current.flush();
    await Promise.all([first, second, closing]);
    expect(render).toHaveBeenCalledOnce();
    expect(current.instance.cleanup).toHaveBeenCalledOnce();
    await ui.close();
    expect(current.instance.unmount).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalled();
  });

  it("still cleans up the Ink instance when its output flush fails", async () => {
    const current = renderer();
    const pause = vi.spyOn(stdin, "pause");
    render.mockReturnValue(current.instance);
    const ui = createTerminalSetupUI(view, vi.fn());
    const closing = ui.close();
    const error = new Error("Terminal output closed");
    current.fail(error);
    await expect(closing).rejects.toBe(error);
    expect(current.instance.cleanup).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
  });
});
