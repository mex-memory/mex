import { openRecord } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { backgroundEnabled, ensureBackground, type EnsureOptions } from "../../record/background.js";
import { VERSION } from "../../version.js";
import { openHubBrowser } from "../browser.js";
import { startMachineHub, type RunningMachineHub } from "./serve.js";
import { ensureHomeId, keepHubOpen, LAUNCH_KEEPALIVE_MS, mintBootstrap, preferredPort, readBound, type HubMode } from "./state.js";

/**
 * `mex hub`: find this home's Hub (or ask the background process to start it), mint a
 * one-time sign-in link, print it, and open the browser when that makes sense. Falls back
 * to serving from this terminal when the background process is off or doesn't answer.
 */

export const BACKGROUND_WAIT_MS = 10_000;
const POLL_MS = 200;

export interface MachineHubCommandOptions extends LocationOptions {
  readonly port?: number;
  readonly openBrowser: boolean;
  /** Serve from this terminal without asking the background process. */
  readonly foreground?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  /** Test seams. */
  readonly ensure?: (options: EnsureOptions) => unknown;
  readonly open?: (url: string) => void;
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
}

export interface FoundHub {
  readonly port: number;
  readonly mode: HubMode;
}

export async function runMachineHub(options: MachineHubCommandOptions): Promise<void> {
  const env = options.env ?? process.env;
  const out = options.out ?? ((line: string) => console.log(line));
  const location: LocationOptions = { home: options.home, cache: options.cache, isNetwork: options.isNetwork };

  const writer = openRecord(location);
  let home: string, homeId: string, preferred: number, token: string, enabled: boolean;
  try {
    home = writer.location.home;
    homeId = ensureHomeId(writer);
    preferred = options.port ?? preferredPort(writer);
    keepHubOpen(writer, Date.now() + LAUNCH_KEEPALIVE_MS);
    token = mintBootstrap(writer);
    enabled = backgroundEnabled(writer);
  } finally {
    writer.close();
  }

  let found = await findLiveHub(location, homeId);
  let terminal: RunningMachineHub | undefined;
  if (found === undefined && !options.foreground && enabled && options.port === undefined) {
    (options.ensure ?? ensureBackground)({ ...location, force: true });
    found = await waitForHub(location, homeId, options.waitMs ?? BACKGROUND_WAIT_MS);
  }
  if (found === undefined) {
    terminal = await startMachineHub({ ...location, mode: "terminal", port: preferred, env });
    found = { port: terminal.port, mode: "terminal" };
  }

  const origin = `http://127.0.0.1:${found.port}`;
  const link = `${origin}/#token=${encodeURIComponent(token)}`;
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
  if (found.port !== preferred) out(`The Hub moved to :${found.port} because :${preferred} is in use by another program.`);
  out(`MEX Hub: ${origin}/`);
  out("Sign in on this browser with this link (it works once, for 5 minutes):");
  out(link);
  if (ssh) out(`Over SSH, forward the port first, from your own machine: ssh -L ${found.port}:127.0.0.1:${found.port} <this host>`);
  if (env.MEX_HOME?.trim()) out(`MEX home: ${home}`);
  if (options.openBrowser && !ssh) (options.open ?? openHubBrowser)(link);
  if (!terminal) return;

  out("Running from this terminal; closing it stops the Hub. Press Ctrl+C to stop.");
  await untilStopped(options.signal);
  await terminal.close();
}

/** A Hub this home published that answers the handshake with the same home and version. */
export async function findLiveHub(location: LocationOptions, homeId: string): Promise<FoundHub | undefined> {
  const reader = openRecord(location);
  let bound;
  try { bound = readBound(reader); } finally { reader.close(); }
  if (!bound || bound.homeId !== homeId || bound.version !== VERSION) return undefined;
  const hello = await probeHello(bound.port);
  if (!hello || hello.homeId !== homeId || hello.version !== VERSION) return undefined;
  return { port: bound.port, mode: hello.mode };
}

async function waitForHub(location: LocationOptions, homeId: string, waitMs: number): Promise<FoundHub | undefined> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const found = await findLiveHub(location, homeId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return undefined;
}

export async function probeHello(port: number): Promise<{ homeId: string; version: string; mode: HubMode } | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/hello`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return undefined;
    const body = await response.json() as { app?: unknown; homeId?: unknown; version?: unknown; mode?: unknown };
    if (body.app !== "mex-hub" || typeof body.homeId !== "string" || typeof body.version !== "string") return undefined;
    return { homeId: body.homeId, version: body.version, mode: body.mode === "terminal" ? "terminal" : "background" };
  } catch {
    return undefined;
  }
}

function untilStopped(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    signal?.addEventListener("abort", done, { once: true });
  });
}
