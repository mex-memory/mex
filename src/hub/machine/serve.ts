import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEntryPath } from "../../hooks/shim/launcher.js";
import { openRecord } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { VERSION } from "../../version.js";
import { startHubNodeServer, type RunningHubNodeServer } from "../node-server.js";
import { HubAssetManifest } from "../static/assets.js";
import { createMachineHubApp } from "./app.js";
import { HubSessions } from "./security.js";
import { candidatePorts, clearBound, ensureHomeId, preferredPort, writeBound, type HubMode } from "./state.js";

export interface StartMachineHubOptions extends LocationOptions {
  readonly mode: HubMode;
  /** Ask for this port first instead of the stored one (`mex hub --port`). */
  readonly port?: number;
  /** Built pages; defaults to `dist/hub` next to the CLI. `null` means API only (tests). */
  readonly assetRoot?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

export interface RunningMachineHub {
  readonly port: number;
  readonly preferred: number;
  readonly origin: string;
  readonly homeId: string;
  readonly home: string;
  close(): Promise<void>;
}

/**
 * Bind this home's Hub on its port, or the next free one in its range, and publish the
 * address in record.db. Never touches a process that already holds a port.
 */
export async function startMachineHub(options: StartMachineHubOptions): Promise<RunningMachineHub> {
  const location: LocationOptions = { home: options.home, cache: options.cache, isNetwork: options.isNetwork };
  const writer = openRecord(location);
  let home: string, homeId: string, preferred: number;
  try {
    home = writer.location.home;
    homeId = ensureHomeId(writer);
    preferred = options.port ?? preferredPort(writer);
  } finally {
    writer.close();
  }

  const sessions = new HubSessions(home, options.now);
  const assetRoot = options.assetRoot === undefined ? defaultAssetRoot() : options.assetRoot;
  const assets = assetRoot !== null && existsSync(assetRoot) ? new HubAssetManifest(assetRoot) : undefined;
  const agentEntry = cliEntryPath(fileURLToPath(new URL("./cli.js", import.meta.url)));
  const app = createMachineHubApp({ ...location, sessions, homeId, version: VERSION, mode: options.mode, assets, env: options.env, now: options.now, agentEntry });

  let server: RunningHubNodeServer | undefined;
  let lastError: unknown;
  for (const port of candidatePorts(preferred)) {
    try {
      server = await startHubNodeServer({ app, port });
      break;
    } catch (error) {
      lastError = error;
      if (!portTaken(error)) throw error;
    }
  }
  if (!server) {
    throw new Error(`Every Hub port from ${preferred} on is in use by other programs. Run \`mex hub --port <free port>\`.`, { cause: lastError });
  }

  const running = server;
  const bound = { port: running.port, pid: process.pid, version: VERSION, homeId, mode: options.mode, at: new Date((options.now ?? Date.now)()).toISOString() };
  try {
    const publish = openRecord(location);
    try { writeBound(publish, bound); } finally { publish.close(); }
  } catch (error) {
    app.close();
    await running.close();
    throw error;
  }

  let closed = false;
  return {
    port: running.port,
    preferred,
    origin: running.origin,
    homeId,
    home,
    async close() {
      if (closed) return;
      closed = true;
      app.close();
      // Deleting the selected home while the listener is open should leave it absent.
      if (existsSync(home)) {
        try {
          const cleanup = openRecord({ ...location, create: false });
          try { clearBound(cleanup, bound.pid, bound.port); } finally { cleanup.close(); }
        } catch { /* the row is advisory: a reader checks the pid and the handshake */ }
      }
      await running.close();
    },
  };
}

/** The Hub's built pages ship as `dist/hub`, next to the CLI bundle. */
export function defaultAssetRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "hub");
}

function portTaken(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return cause?.code === "EADDRINUSE" || cause?.code === "EACCES";
}
