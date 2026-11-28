import { getEventListeners, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRecord } from "../../../record/index.js";
import { runMachineHub, type MachineHubCommandOptions } from "../command.js";
import { startMachineHub, type RunningMachineHub } from "../serve.js";

const TERMINAL_MESSAGE = "Running from this terminal";

describe("runMachineHub", () => {
  let home: string;
  let controller: AbortController;
  let command: ReturnType<typeof launch> | undefined;
  let existingHub: RunningMachineHub | undefined;
  let occupant: Server | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mex-hub-command-"));
    controller = new AbortController();
    command = undefined;
    existingHub = undefined;
    occupant = undefined;
    vi.stubEnv("MEX_OFF", undefined);
    vi.stubEnv("MEX_BACKGROUND", undefined);
    storePreferredPort(41940);
  });

  afterEach(async () => {
    try {
      if (command) {
        await command.ready;
        if (controller.signal.aborted && getEventListeners(controller.signal, "abort").length > 0) {
          // Release a listener that was registered after the pre-aborted signal fired.
          controller.signal.dispatchEvent(new Event("abort"));
        } else {
          controller.abort();
        }
        await command.finished;
      }
    } finally {
      try {
        const server = occupant;
        const closing = [existingHub?.close()];
        if (server?.listening) {
          closing.push(new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          }));
        }
        await Promise.all(closing);
      } finally {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  function storePreferredPort(port: number): void {
    const writer = openRecord({ home, cache: home, isNetwork: () => false });
    try {
      writer.db.prepare("INSERT OR REPLACE INTO settings(scope,key,value) VALUES('hub','port',?)").run(String(port));
    } finally {
      writer.close();
    }
  }

  function launch(overrides: Pick<MachineHubCommandOptions, "env" | "foreground"> = {}) {
    let announceTerminal!: (stage: "terminal") => void;
    const terminalReady = new Promise<"terminal">((resolve) => { announceTerminal = resolve; });
    const out = vi.fn((line: string) => {
      if (line.startsWith(TERMINAL_MESSAGE)) announceTerminal("terminal");
    });
    const open = vi.fn<(url: string) => void>();
    const ensure = vi.fn(() => {});
    const finished = runMachineHub({
      home, cache: home, openBrowser: true, ensure, waitMs: 300, signal: controller.signal,
      env: {}, out, open, ...overrides,
    });
    const ready = Promise.race([terminalReady, finished.then(() => "returned" as const)]);
    const run = { ready, finished, open, ensure, lines: () => out.mock.calls.map(([line]) => line) };
    command = run;
    return run;
  }

  function printedLink(lines: readonly string[]): URL {
    const link = lines.find((line) => line.startsWith("http://127.0.0.1:") && line.includes("/#token="));
    if (!link) throw new Error("The command did not print a loopback sign-in link.");
    return new URL(link);
  }

  it("falls back to the terminal if the background does not start, then stops on abort", async () => {
    const run = launch();
    expect(await run.ready).toBe("terminal");

    expect(run.ensure.mock.calls).toEqual([[expect.objectContaining({ home, force: true })]]);
    const lines = run.lines();
    expect(lines.join("\n")).toContain(TERMINAL_MESSAGE);
    const link = printedLink(lines);
    expect(link.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);
    expect(run.open.mock.calls).toEqual([[link.href]]);

    controller.abort();
    await run.finished;
  });

  it("prints an SSH forwarding command and does not open a browser over SSH", async () => {
    const run = launch({ foreground: true, env: { SSH_CONNECTION: "1 2 3 4" } });
    expect(await run.ready).toBe("terminal");

    const lines = run.lines();
    const { port } = printedLink(lines);
    expect(lines.join("\n")).toContain("ssh -L " + port + ":127.0.0.1:" + port + " <this host>");
    expect(run.open).not.toHaveBeenCalled();
  });

  it("reuses a live Hub for this home and returns without a stop signal", async () => {
    existingHub = await startMachineHub({ home, cache: home, port: 0, assetRoot: null, mode: "background", env: {} });
    storePreferredPort(existingHub.port);

    const run = launch();
    expect(await run.ready).toBe("returned");
    await run.finished;

    const lines = run.lines();
    expect(lines).toContain("MEX Hub: " + existingHub.origin + "/");
    expect(lines.join("\n")).not.toContain(TERMINAL_MESSAGE);
    expect(run.ensure).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });

  it("reports the new port when the stored preferred port is occupied", async () => {
    occupant = createServer((socket) => socket.destroy());
    occupant.listen(0, "127.0.0.1");
    await once(occupant, "listening");
    const address = occupant.address();
    if (!address || typeof address === "string") throw new Error("Expected an occupied TCP port.");
    storePreferredPort(address.port);

    const run = launch({ foreground: true });
    expect(await run.ready).toBe("terminal");

    const lines = run.lines();
    const { port } = printedLink(lines);
    expect(Number(port)).not.toBe(address.port);
    expect(lines.join("\n")).toContain("The Hub moved to :" + port + " because :" + address.port + " is in use");
    expect(occupant.listening).toBe(true);
    expect(occupant.address()).toEqual(address);
  });

  it("prints a sign-in link that can be exchanged exactly once at the running Hub", async () => {
    const run = launch({ foreground: true });
    expect(await run.ready).toBe("terminal");
    const link = printedLink(run.lines());
    const token = new URLSearchParams(link.hash.slice(1)).get("token");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const exchange = () => fetch(new URL("/api/v1/session/bootstrap", link), {
      method: "POST",
      headers: { origin: link.origin, "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ token }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const first = await exchange();
    expect(first.status).toBe(201);
    expect(first.headers.get("set-cookie")).toBeTruthy();
    expect(await first.json()).toMatchObject({ csrfToken: expect.any(String) });

    const replay = await exchange();
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  // Regression: A stop signal that aborts before terminal startup leaves the command waiting for another event.
  it("honors a stop signal that has already aborted", async () => {
    controller.abort();
    const run = launch({ foreground: true });
    await run.ready;

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await run.finished;
  });
});
