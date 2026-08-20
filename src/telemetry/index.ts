/**
 * Anonymous, opt-out telemetry — PostHog counting layer.
 *
 * Trust constraint: a developer who reads this file must trust it.
 * - Only 6 whitelisted fields are ever sent (see `buildPayload`).
 * - No PII, no args, no paths, no file contents, no repo names.
 * - Failures are swallowed — telemetry never affects command behaviour.
 * - The PostHog client is the only network-touching code in this module.
 *
 * All PostHog-specific code lives behind this interface so the backend can
 * be swapped to a self-hosted endpoint in one file.
 */

import { PostHog } from "posthog-node";
import { getMachineId, readGlobalConfig, setGlobalConfigKey, isDevRepo } from "../global-config.js";
import { VERSION } from "../version.js";
import { platform } from "node:os";

// ── Constants ──

const TELEMETRY_KEY = "phc_wdwbBPQMrM6vKWMzz5yqWT357i2hSjMhnAvCuofJdMpg";
const HOST = "https://us.i.posthog.com";
const EVENT = "command_run";
const FLUSH_TIMEOUT_MS = 800;
// A short-lived CLI must never inherit the SDK's 10 second request timeout.
// Keep the network attempt inside the command-level flush deadline so an
// offline endpoint cannot dominate graph/eval latency.
const REQUEST_TIMEOUT_MS = 650;

// ── Opt-out check ──

export interface EnabledResult {
  enabled: boolean;
  reason?: string;
}

/**
 * Determine whether telemetry is enabled.
 *
 * Precedence (first match wins):
 * 1. `DO_NOT_TRACK=1` → off
 * 2. `MEX_TELEMETRY=0` → off
 * 3. Dev repo / `MEX_DEV` → off
 * 4. `~/.mex/config.json` `telemetry === "off"` → off
 * 5. else → on
 *
 * Env + dev checks run before any disk read.
 */
export function isEnabled(): EnabledResult {
  // 1. Industry-standard opt-out
  if (process.env.DO_NOT_TRACK === "1") {
    return { enabled: false, reason: "DO_NOT_TRACK" };
  }

  // 2. mex-specific env opt-out
  if (process.env.MEX_TELEMETRY === "0") {
    return { enabled: false, reason: "MEX_TELEMETRY" };
  }

  // 3. Dev-repo guard (no disk read for global config yet)
  if (isDevRepo()) {
    return { enabled: false, reason: "dev" };
  }

  // 4. Global config opt-out
  try {
    const globalConfig = readGlobalConfig();
    if (globalConfig.telemetry === "off") {
      return { enabled: false, reason: "config" };
    }
  } catch { /* tolerate read failure — default to enabled */ }

  // 5. Default: enabled
  return { enabled: true };
}

// ── Payload construction ──

/**
 * The single place the payload shape is defined. Exactly 6 keys — nothing else.
 *
 * PII firewall: `scaffold_id` is a **string** (random UUID). Never pass the
 * full `ScaffoldIdentity` object — it contains `scaffold_name` (directory
 * basename), `origin`, and `upstream` which must never reach PostHog.
 */
export function buildPayload(
  command: string,
  scaffold_id?: string,
): Record<string, string> {
  const payload: Record<string, string> = {
    machine_id: "", // placeholder — filled by capture() when actually sending
    command,
    mex_version: VERSION,
    os: platform(),
    node_version: process.version,
  };
  if (scaffold_id) {
    payload.scaffold_id = scaffold_id;
  }
  return payload;
}

/**
 * Build the payload that *would* be sent, for `mex telemetry inspect`.
 *
 * Uses a read-only identity lookup — never mints a scaffold_id on disk.
 * Does NOT send anything or touch the network.
 *
 * `scaffoldId` is passed in by the CLI after a read-only config lookup.
 */
export function getPayloadPreview(
  command: string,
  scaffoldId?: string,
  machineId?: string,
): Record<string, string> {
  const payload = buildPayload(command, scaffoldId);
  payload.machine_id = machineId ?? "(not generated — telemetry disabled or inspect-only)";
  return payload;
}

// ── PostHog client (lazy, with test seam) ──

type TransportFn = (event: string, properties: Record<string, unknown>) => void;
type TelemetryClient = Pick<PostHog, "captureImmediate" | "flush" | "shutdown">;

let client: TelemetryClient | null = null;
let customTransport: TransportFn | null = null;
const pendingCaptures = new Set<Promise<void>>();

function getClient(): TelemetryClient {
  if (!client) {
    client = new PostHog(TELEMETRY_KEY, {
      host: HOST,
      flushAt: 1,       // flush after every event (short-lived CLI)
      flushInterval: 0, // don't auto-flush on interval — we call flush() explicitly
      requestTimeout: REQUEST_TIMEOUT_MS,
      // Retries are appropriate for a daemon, but their default three-second
      // backoff keeps a one-shot CLI alive after our flush deadline. A future
      // invocation is the retry for anonymous command-count telemetry.
      fetchRetryCount: 0,
      fetchRetryDelay: 0,
    });
  }
  return client;
}

/**
 * Test seam: inject a fake transport so tests never hit the network.
 * Pass `null` to restore the real PostHog client.
 */
export function __setTransport(fn: TransportFn | null): void {
  customTransport = fn;
}

/** Test seam for proving a non-responsive SDK client cannot hold the CLI open. */
export function __setClientForTest(next: TelemetryClient | null): void {
  client = next;
  pendingCaptures.clear();
}

// ── Capture + flush ──

/**
 * Capture a telemetry event. Enqueues synchronously — no await needed.
 *
 * If telemetry is disabled, returns immediately.
 * All errors are swallowed — telemetry must never affect command behaviour.
 */
export function capture(event: string, command: string, scaffoldId?: string): void {
  try {
    const { enabled } = isEnabled();
    if (!enabled) return;

    const machineId = getMachineId();
    const payload = buildPayload(command, scaffoldId);
    payload.machine_id = machineId;

    if (customTransport) {
      customTransport(event, payload);
      return;
    }

    const ph = getClient();
    // captureImmediate returns the delivery promise to us, so we can swallow
    // failures ourselves. The SDK's queued/background flush path logs rejected
    // requests to console.error before callers can catch them, corrupting JSONL.
    const pending = ph.captureImmediate({
      distinctId: machineId,
      event,
      properties: payload,
      // Anonymous: tell PostHog not to derive geolocation from the request IP.
      // Without this, the server attaches IP-based geo — PII that would NOT
      // show up in `mex telemetry inspect`, breaking the whitelist promise.
      // (posthog-node still adds $lib / $lib_version library metadata — not
      // user data; disclosed in TELEMETRY.md.)
      disableGeoip: true,
    }).catch(() => undefined);
    pendingCaptures.add(pending);
    void pending.finally(() => pendingCaptures.delete(pending));
  } catch {
    // Swallow everything — telemetry must never throw.
  }
}

/**
 * Capture a `command_run` event. This is the main entry point from CLI hooks.
 *
 * `scaffoldId` is the **string** scaffold_id only — never the full
 * ScaffoldIdentity object. This is the PII firewall.
 */
export function captureCommand(command: string, scaffoldId?: string): void {
  capture(EVENT, command, scaffoldId);
}

/**
 * Best-effort, time-bounded flush + unconditional shutdown.
 *
 * After the flush (or timeout), `posthog.shutdown()` clears the internal
 * interval timer so the Node.js process can exit promptly.
 */
export async function flush(): Promise<void> {
  const activeClient = client;
  const deadline = Date.now() + FLUSH_TIMEOUT_MS;
  try {
    if (customTransport || !activeClient) {
      // No real client to flush — nothing to do.
      return;
    }

    await settleByDeadline(
      Promise.allSettled([...pendingCaptures]).then(() => activeClient.flush()),
      deadline,
    );
  } catch {
    // Swallow — delivery is best-effort.
  } finally {
    try {
      if (activeClient) {
        // PostHog otherwise defaults shutdown to 30 seconds. Pass the remaining
        // command deadline to the SDK *and* guard it ourselves so alternate or
        // future clients cannot make telemetry command-blocking.
        const remaining = Math.max(1, deadline - Date.now());
        await settleByDeadline(Promise.resolve(activeClient.shutdown(remaining)), deadline);
      }
    } catch {
      // Swallow shutdown errors too.
    } finally {
      if (client === activeClient) client = null;
      pendingCaptures.clear();
    }
  }
}

async function settleByDeadline(work: Promise<unknown>, deadline: number): Promise<void> {
  // Attach the rejection handler even when the deadline has already elapsed.
  // The SDK's own bounded shutdown rejects on timeout; leaving that late
  // rejection detached would corrupt JSONL commands with an unhandled error.
  const settled = work.then(() => undefined, () => undefined);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void settled;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── First-run notice ──

/**
 * Show a one-time first-run notice to stderr if telemetry is enabled.
 * Returns true if the notice was shown.
 */
export function showFirstRunNotice(): boolean {
  try {
    const { enabled } = isEnabled();
    if (!enabled) return false;

    const config = readGlobalConfig();
    if (config.firstRunNoticeShown) return false;

    // Skip in non-TTY to avoid noise in pipes
    if (!process.stderr.isTTY) return false;

    process.stderr.write(
      "\n" +
      "  mex collects anonymous usage data (command name, version, OS) to\n" +
      "  understand how the tool is used. No file contents, paths, or personal\n" +
      "  data are ever collected. Run `mex telemetry inspect` to see the exact\n" +
      "  payload sent.\n" +
      "\n" +
      "  To opt out: mex config set telemetry off\n" +
      "  Or set DO_NOT_TRACK=1 or MEX_TELEMETRY=0\n" +
      "\n",
    );

    setGlobalConfigKey("firstRunNoticeShown", true);
    return true;
  } catch {
    // Never let the notice break a command.
    return false;
  }
}
