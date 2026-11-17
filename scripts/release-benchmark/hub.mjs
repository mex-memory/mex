import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { requestJson } from "./http.mjs";
import { startProcessTreeSampler } from "./process-tree.mjs";
import { validateBenchmarkJob, waitForHubJobTerminal } from "./job-events.mjs";

const MAX_CHILD_OUTPUT_BYTES = 128 * 1024;
const HUB_START_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 180_000;
const IDLE_WINDOW_MS = 2_000;
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "interrupted"]);
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;

export async function startHub({
  projectRoot,
  cliPath,
  environment,
  startupTimeoutMs = HUB_START_TIMEOUT_MS,
}) {
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > HUB_START_TIMEOUT_MS) {
    throw new Error(`Hub startup timeout must be between 1 and ${HUB_START_TIMEOUT_MS} milliseconds.`);
  }
  const startedAt = performance.now();
  const child = spawn(process.execPath, [cliPath, "hub", "--no-open"], {
    cwd: projectRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => {
    const next = current + chunk.toString("utf8");
    return next.length <= MAX_CHILD_OUTPUT_BYTES ? next : next.slice(-MAX_CHILD_OUTPUT_BYTES);
  };

  const ready = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      rejectAfterTermination(new Error(`Timed out waiting for Hub readiness: ${bounded(stderr || stdout)}`));
    }, startupTimeoutMs);
    const onStdout = (chunk) => {
      stdout = append(stdout, chunk);
      const match = stdout.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+/u);
      if (!match || settled) return;
      settled = true;
      cleanup();
      resolve({ bootstrapUrl: match[0], readyMs: performance.now() - startedAt });
    };
    const onStderr = (chunk) => { stderr = append(stderr, chunk); };
    const onExit = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Hub exited before readiness (${String(code ?? signal)}): ${bounded(stderr || stdout)}`));
    };
    const onError = (error) => {
      rejectAfterTermination(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const rejectAfterTermination = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        reject(error);
        return;
      }
      void stopHub(child).catch(() => undefined).finally(() => reject(error));
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  // Readiness parsing no longer needs the streams, but leaving them paused can
  // eventually back-pressure a maintenance-heavy benchmark run.
  child.stdout?.resume();
  child.stderr?.resume();
  return {
    child,
    projectRoot,
    origin: new URL(ready.bootstrapUrl).origin,
    bootstrapUrl: ready.bootstrapUrl,
    readyMs: ready.readyMs,
    close: () => stopHub(child),
  };
}

export async function authenticateHub(server) {
  const url = new URL(server.bootstrapUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("Hub readiness output omitted its bootstrap token.");
  const { response, body } = await requestJson(`${server.origin}/api/v1/session/bootstrap`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", origin: server.origin },
    body: JSON.stringify({ token }),
  });
  if (response.status !== 201 || typeof body.expiresAt !== "string") {
    throw new Error(`Hub bootstrap failed with HTTP ${response.status}.`);
  }
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Hub bootstrap did not set a session cookie.");
  const session = await hubJson(server, "/api/v1/session", { cookie });
  if (typeof session.csrfToken !== "string") throw new Error("Hub session omitted its CSRF token.");
  return { cookie, csrfToken: session.csrfToken };
}

export async function measureIdleProcess(server) {
  const sampler = await startProcessTreeSampler(server.child.pid);
  let measured;
  try {
    await delay(IDLE_WINDOW_MS);
  } finally {
    measured = await sampler.stop();
  }
  return {
    rssBytes: measured.peakRssBytes,
    cpuMs: measured.cpuMs,
    windowMs: IDLE_WINDOW_MS,
  };
}

export async function measureCommonReads(server, auth, samples, teamFixture) {
  const warmSearch = await hubJson(
    server,
    "/api/v1/search?q=releaseBenchmarkNeedle&limit=25",
    auth,
  );
  const symbol = warmSearch.groups?.symbols?.items?.[0];
  if (typeof symbol?.id !== "string") {
    throw new Error("The benchmark Graph fixture did not produce a searchable symbol.");
  }
  const paths = releaseCommonReadPaths(symbol.id);
  await hubJson(server, paths.code, auth);
  await hubJson(server, paths.knowledge, auth);
  await hubJson(server, paths.activity, auth);
  const warmRelayDrafts = await hubJson(server, "/api/v1/relays/drafts?limit=25", auth);
  const warmRelays = await hubJson(
    server,
    "/api/v1/relays?perspective=mine&state=published,acknowledged&limit=25",
    auth,
  );
  assertRelayFixturePage(warmRelayDrafts, {
    kind: "draft",
    id: teamFixture.relayDraftId,
    summary: teamFixture.relayDraftSummary,
  });
  assertRelayFixturePage(warmRelays, {
    kind: "relay",
    id: teamFixture.relayId,
    summary: teamFixture.relaySummary,
  });

  const timings = Object.fromEntries(Object.keys(paths).map((name) => [name, []]));
  for (let sample = 0; sample < samples; sample += 1) {
    for (const [name, path] of Object.entries(paths)) {
      const startedAt = performance.now();
      await hubJson(server, path, auth);
      timings[name].push(performance.now() - startedAt);
    }
  }
  return { timings, codeSymbolId: symbol.id };
}

export function releaseCommonReadPaths(codeSymbolId) {
  return {
    search: "/api/v1/search?q=releaseBenchmarkNeedle&limit=25",
    code: `/api/v1/code/symbols/${encodeURIComponent(codeSymbolId)}?view=overview`,
    knowledge: "/api/v1/wiki/graph",
    activity: "/api/v1/activity?limit=25",
    relayDrafts: "/api/v1/relays/drafts?limit=25",
    relays: "/api/v1/relays?perspective=mine&state=published,acknowledged&limit=25",
  };
}

export function assertRelayFixturePage(page, expected) {
  if (
    !page
    || !Array.isArray(page.items)
    || page.items.length !== 1
    || page.nextCursor !== null
    || page.truncated !== false
    || page.sourceTruncated !== false
    || !REVISION_PATTERN.test(page.deterministicRevision)
    || !Array.isArray(page.diagnostics)
    || page.diagnostics.length !== 0
    || page.diagnosticsTruncated !== false
  ) {
    throw new Error(
      `The benchmark Relay ${expected.kind} list did not return its exact complete diagnostic-free one-item page.`,
    );
  }
  const item = page.items[0];
  const id = expected.kind === "relay" ? item?.ref?.id : item?.id;
  if (id !== expected.id || item?.summary !== expected.summary) {
    throw new Error(`The benchmark Relay ${expected.kind} list returned unexpected fixture content.`);
  }
  if (expected.kind === "relay") {
    if (item?.state !== "published") {
      throw new Error("The benchmark Relay is not published.");
    }
    if (
      item?.schemaVersion !== 3
      || item?.workstream !== null
      || item?.publishedRepoState?.branch !== "benchmark"
      || item?.publishedRepoState?.head !== null
      || item?.publishedRepoState?.dirty !== false
      || item?.publishedRepoState?.observedAt !== "2026-08-01T00:00:00.000Z"
    ) {
      throw new Error(
        "The benchmark Relay is not the expected standalone schema-v3 publication.",
      );
    }
  }
}

export async function measureMaintenance({
  server,
  auth,
  timingSamples,
  memorySamples,
  beforeGraphRefresh,
  beforeWikiRefresh,
}) {
  const output = {};
  for (const kind of ["graph_refresh", "graph_rebuild", "wiki_refresh", "wiki_rebuild"]) {
    const elapsedMs = [];
    const peakRssBytes = [];
    const cpuMs = [];
    for (let sample = 0; sample < timingSamples; sample += 1) {
      if (kind === "graph_refresh") beforeGraphRefresh();
      if (kind === "wiki_refresh") beforeWikiRefresh();
      const measured = await runMaintenanceJob(server, auth, kind);
      elapsedMs.push(measured.elapsedMs);
      cpuMs.push(measured.cpuMs);
      if (sample < memorySamples) peakRssBytes.push(measured.peakRssBytes);
    }
    output[kind] = { elapsedMs, peakRssBytes, cpuMs };
  }
  return output;
}

export async function hubJson(server, path, auth, init = {}, requestOptions) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json, application/problem+json");
  if (auth?.cookie) headers.set("cookie", auth.cookie);
  const { response, body } = await requestJson(`${server.origin}${path}`, {
    ...init,
    headers,
    redirect: "error",
  }, requestOptions);
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${bounded(JSON.stringify(body))}`);
  }
  return body;
}

export async function runMaintenanceJob(server, auth, kind, { timeoutMs = JOB_TIMEOUT_MS } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > JOB_TIMEOUT_MS) {
    throw new Error("Invalid maintenance deadline.");
  }
  const sampler = await startProcessTreeSampler(server.child.pid);
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  const requestOptions = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`${kind} did not settle within ${timeoutMs} ms.`);
    return { timeoutMs: Math.min(5_000, remaining) };
  };
  let measured;
  let completedAt;
  try {
    const job = validateBenchmarkJob(await hubJson(server, "/api/v1/jobs", auth, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.origin,
        "x-mex-csrf": auth.csrfToken,
      },
      body: JSON.stringify({ kind }),
    }, requestOptions()), { kind });
    const terminal = TERMINAL_JOB_STATES.has(job.state)
      ? job
      : await waitForHubJobTerminal(server, auth, { id: job.id, kind, deadline });
    if (terminal.state !== "succeeded") {
      throw new Error(`${kind} settled as ${String(terminal.state)} (${String(terminal.problem?.code ?? "unknown")}).`);
    }
    completedAt = performance.now();
  } finally {
    measured = await sampler.stop();
  }
  return { elapsedMs: completedAt - startedAt, peakRssBytes: measured.peakRssBytes, cpuMs: measured.cpuMs };
}

async function stopHub(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Hub did not stop within eight seconds."));
    }, 8_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function bounded(value) {
  const text = String(value ?? "").trim();
  return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}…`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
