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
  const deadline = startedAt + startupTimeoutMs;
  const child = spawn(process.execPath, [cliPath, "hub", "--foreground", "--no-open"], {
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

  const bootstrapUrl = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      rejectAfterTermination(new Error(`Timed out waiting for Hub readiness: ${bounded(stderr || stdout)}`));
    }, startupTimeoutMs);
    const onStdout = (chunk) => {
      stdout = append(stdout, chunk);
      const match = stdout.match(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+(?=\r?\n)/mu);
      if (!match || settled) return;
      settled = true;
      cleanup();
      resolve(match[0]);
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
  child.stdout?.resume();
  child.stderr?.resume();
  const origin = new URL(bootstrapUrl).origin;
  try {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Timed out before the Hub handshake.");
    const hello = await hubJson({ origin }, "/api/v1/hello", undefined, {}, {
      timeoutMs: Math.min(5_000, remaining),
    });
    if (hello.app !== "mex-hub" || hello.mode !== "terminal"
      || typeof hello.version !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(hello.homeId ?? "")) {
      throw new Error("The foreground process did not answer as a machine Hub.");
    }
    return {
      child,
      origin,
      bootstrapUrl,
      readyMs: performance.now() - startedAt,
      close: () => stopHub(child),
    };
  } catch (error) {
    await stopHub(child);
    throw error;
  }
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

export const RELEASE_COMMON_READ_PATHS = Object.freeze({
  session: "/api/v1/session",
  projects: "/api/v1/projects",
  home: "/api/v1/home",
  jobs: "/api/v1/jobs",
  knowledge: "/api/v1/knowledge",
  knowledgeLanding: "/api/v1/knowledge/landing",
  review: "/api/v1/review",
  reviewDetail: "/api/v1/review/cards/:key",
  agents: "/api/v1/agents",
  agentDetail: "/api/v1/agents/claude-code",
  settings: "/api/v1/settings",
  uninstallPreview: "/api/v1/settings/uninstall",
});

export async function measureCommonReads(server, auth, samples) {
  const session = await hubJson(server, RELEASE_COMMON_READ_PATHS.session, auth);
  if (session.mode !== "terminal" || session.csrfToken !== auth.csrfToken) {
    throw new Error("The benchmark did not receive its authenticated foreground session.");
  }
  const result = await hubJson(server, RELEASE_COMMON_READ_PATHS.projects, auth);
  if (!Array.isArray(result.projects) || result.projects.length !== 1
    || result.projects[0].kind !== "git" || result.projects[0].checkouts?.length !== 1
    || result.projects[0].checkouts[0].exists !== true) {
    throw new Error("The benchmark Hub did not return its single registered Git checkout.");
  }

  // The first read starts the in-memory snapshot. Time warm reads once it is ready.
  const warmDeadline = performance.now() + 5_000;
  while ((await hubJson(server, RELEASE_COMMON_READ_PATHS.knowledge, auth)).updatingSince) {
    if (performance.now() >= warmDeadline) throw new Error("The Knowledge snapshot did not become ready.");
    await delay(25);
  }

  let review = await hubJson(server, RELEASE_COMMON_READ_PATHS.review, auth);
  while (review.updatingSince) {
    if (performance.now() >= warmDeadline) throw new Error("The Review snapshot did not become ready.");
    await delay(25);
    review = await hubJson(server, RELEASE_COMMON_READ_PATHS.review, auth);
  }
  const key = review.cards?.[0]?.key;
  if (!key || review.partial) throw new Error("The benchmark Hub did not return its staged Review cards.");
  const paths = { ...RELEASE_COMMON_READ_PATHS, reviewDetail: RELEASE_COMMON_READ_PATHS.reviewDetail.replace(":key", encodeURIComponent(key)) };

  const controls = {
    agents: (data) => data.agents?.length === 4,
    agentDetail: (data) => data.agent?.id === "claude-code",
    settings: (data) => data.settings?.repos?.some((repo) => repo.id === result.projects[0].id),
    uninstallPreview: (data) => Array.isArray(data.preview?.changes),
  };
  await Promise.all(Object.entries(controls).map(async ([name, ready]) => {
    const deadline = performance.now() + 5_000;
    while (true) {
      const data = await hubJson(server, paths[name], auth);
      if (ready(data) && !data.updatingSince) break;
      if (performance.now() >= deadline || data.issue && !data.updatingSince) {
        throw new Error(`The ${name} snapshot did not become ready.`);
      }
      await delay(25);
    }
  }));

  const timings = Object.fromEntries(Object.keys(paths).map((name) => [name, []]));
  for (let sample = 0; sample < samples; sample += 1) {
    for (const [name, path] of Object.entries(paths)) {
      const startedAt = performance.now();
      const data = await hubJson(server, path, auth);
      timings[name].push(performance.now() - startedAt);
      if (name === "home" && (data.activity?.length !== 7 || !data.byRepo?.[result.projects[0].id])) {
        throw new Error("The benchmark Hub did not return seven days of Home overview data.");
      }
      if (name === "knowledge" && (!data.items?.length || data.updatingSince)) {
        throw new Error("The benchmark Hub did not return its Knowledge entries.");
      }
      if (name === "knowledgeLanding" && (!data.groups?.byKind?.length || !data.groups?.byArea?.length)) {
        throw new Error("The benchmark Hub did not group its Knowledge entries.");
      }
      if (name === "review" && (!data.cards?.length || data.updatingSince || data.partial)) {
        throw new Error("The benchmark Hub did not return its Review queue.");
      }
      if (name === "reviewDetail" && (data.key !== key || !data.text)) {
        throw new Error("The benchmark Hub did not return its full Review card.");
      }
      if (Object.hasOwn(controls, name) && !controls[name](data)) {
        throw new Error(`The benchmark Hub did not return its ${name} snapshot.`);
      }
      if (name === "jobs" && !Array.isArray(data)) {
        throw new Error("The benchmark Hub did not return its jobs list.");
      }
    }
  }
  return { timings, project: result.projects[0] };
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

// The legacy job-observation tests exercise the deadline and SSE bounds
// independently. The machine Hub has no endpoint for enqueuing maintenance.
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
  const text = String(value ?? "").replace(/#token=[^\s"]+/gu, "#token=[redacted]").trim();
  return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}…`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
