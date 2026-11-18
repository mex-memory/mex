/** Fixed PostHog ingestion only; no SDK timers, retries, console output or redirects. */
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Resolver } from "node:dns";
import type { LookupFunction } from "node:net";
import { validateReport, type UsageReport } from "./report-schema.js";
import { isCI, reportingAllowed, telemetryEnabled } from "./policy.js";

const PROJECT_TOKEN = "phc_wdwbBPQMrM6vKWMzz5yqWT357i2hSjMhnAvCuofJdMpg";
export const TELEMETRY_ENDPOINT = "https://us.i.posthog.com/batch/";
export const REQUEST_TIMEOUT_MS = 2000;
let testEndpoint: URL | undefined;

/** Programmatic test seam only; never controlled by command arguments or config. */
export function setEndpointForTest(value: string | null): void {
  if (value === null) { testEndpoint = undefined; return; }
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== "/batch/" || url.search || url.hash) {
    throw new Error("Telemetry tests require an explicit loopback batch endpoint");
  }
  testEndpoint = url;
}

export interface BatchRequest { done: Promise<boolean>; abort(): void; }
export function sendBatch(events: readonly UsageReport[]): BatchRequest {
  let payload: string;
  try {
    if (!telemetryEnabled().enabled || !events.length || events.length > 8 || !events.every(validateReport)
      || events.some((event) => event.event === "ci.run" ? !isCI() : !reportingAllowed())) return { done: Promise.resolve(false), abort() {} };
    payload = JSON.stringify({ api_key: PROJECT_TOKEN, batch: events });
    if (Buffer.byteLength(payload) > 8 * 16384 + 4096) return { done: Promise.resolve(false), abort() {} };
  } catch { return { done: Promise.resolve(false), abort() {} }; }
  let request: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolver: Resolver | undefined;
  let settle!: (delivered: boolean) => void;
  let settled = false;
  const done = new Promise<boolean>((resolve) => { settle = resolve; });
  const finish = (delivered: boolean): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolver?.cancel();
    response?.destroy();
    request?.destroy();
    settle(delivered);
  };
  try {
    const endpoint = testEndpoint ?? new URL(TELEMETRY_ENDPOINT);
    // A dedicated cancellable resolver avoids an outstanding OS getaddrinfo job
    // keeping a short-lived CLI alive after its HTTP request has been destroyed.
    // Failure to resolve IPv4 simply retains the batch for a later invocation.
    let lookup: LookupFunction | undefined;
    if (endpoint.protocol === "https:") {
      resolver = new Resolver({ timeout: REQUEST_TIMEOUT_MS, tries: 1 });
      lookup = (hostname, _options, callback) => {
        resolver!.resolve4(hostname, (error, addresses) => {
          if (error || !addresses?.length) callback(error ?? new Error("No telemetry address"), "", 4);
          else callback(null, addresses[0], 4);
        });
      };
    }
    const send = endpoint.protocol === "http:" ? httpRequest : httpsRequest;
    request = send(endpoint, {
      method: "POST", agent: false, family: 4, lookup,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (incoming) => {
      response = incoming;
      let size = 0;
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (part: string) => {
        size += Buffer.byteLength(part);
        if (size > 4096) { finish(false); return; }
        body += part;
      });
      incoming.on("end", () => {
        // 2xx acknowledges the batch. PostHog currently returns {status:1};
        // a body explicitly reporting failure must never discard queued events.
        let rejected = false;
        try {
          const result: unknown = body ? JSON.parse(body) : undefined;
          rejected = typeof result === "object" && result !== null && "status" in result
            && ![1, "1"].includes((result as { status: number | string }).status);
        } catch { /* HTTP status remains the delivery acknowledgement. */ }
        finish((incoming.statusCode ?? 0) >= 200 && (incoming.statusCode ?? 0) < 300 && !rejected);
      });
      incoming.on("error", () => finish(false));
      incoming.on("aborted", () => finish(false));
    });
    request.on("error", () => finish(false));
    // Requests may progress while the command works, but are never a reason to
    // keep an otherwise finished process alive. flush() supplies its own grace.
    request.on("socket", (socket) => socket.unref());
    timer = setTimeout(() => finish(false), REQUEST_TIMEOUT_MS);
    timer.unref();
    request.end(payload);
  } catch { finish(false); }
  return { done, abort: () => finish(false) };
}
