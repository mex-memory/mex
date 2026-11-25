import {
  MachineBootstrapSchema,
  MachineHelloSchema,
  MachineHomeSchema,
  MachineJobActionRequestSchema,
  MachineJobActionResponseSchema,
  MachineJobConflictSchema,
  MachineJobsSchema,
  type MachineJobActionRequest,
  MachineProblemSchema,
  MachineProjectsSchema,
  MachineReviewCountsSchema,
  MachineSessionSchema,
  type MachineProblem,
} from "@mex/hub-contracts/machine";

export class HubNetworkError extends Error {
  constructor(cause: unknown) {
    super("The Hub connection failed.", { cause });
    this.name = "HubNetworkError";
  }
}

export class HubProblemError extends Error {
  constructor(readonly status: number, readonly problem?: MachineProblem, readonly body?: unknown) {
    super(problem?.title ?? `The Hub returned HTTP ${status}.`);
    this.name = "HubProblemError";
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof HubProblemError && error.status === 401;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw new HubNetworkError(error);
  }
}

type HubRequestInit = RequestInit & { timeoutMs?: number };

async function request(path: string, { timeoutMs = 8_000, ...init }: HubRequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json, application/problem+json");
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
      redirect: "error",
      signal: init.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  } catch (error) {
    throw new HubNetworkError(error);
  }
  if (!response.ok) {
    const schema = response.status === 409 && path.startsWith("/jobs/") ? MachineJobConflictSchema : MachineProblemSchema;
    const body = await readJson(response);
    const problem = schema.safeParse(body);
    throw new HubProblemError(response.status, problem.success ? problem.data : undefined, body);
  }
  return response;
}

export async function requestJson<T>(path: string, schema: { parse(value: unknown): T }, init?: HubRequestInit): Promise<T> {
  return schema.parse(await readJson(await request(path, init)));
}

export function getHello() {
  return requestJson("/hello", MachineHelloSchema);
}

export function bootstrapSession(token: string) {
  return requestJson("/session/bootstrap", MachineBootstrapSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export function getSession() {
  return requestJson("/session", MachineSessionSchema);
}

export async function signOut(scope: "thisBrowser" | "everywhere", csrfToken: string): Promise<void> {
  const response = await request(scope === "everywhere" ? "/session/sign-out-everywhere" : "/session/sign-out", {
    method: "POST",
    headers: { "x-mex-csrf": csrfToken },
  });
  if (response.status !== 204) throw new HubProblemError(response.status);
}

export function getProjects() {
  return requestJson("/projects", MachineProjectsSchema);
}

export async function heartbeat(csrfToken: string): Promise<void> {
  const response = await request("/session/heartbeat", {
    method: "POST",
    headers: { "x-mex-csrf": csrfToken },
  });
  if (response.status !== 204) throw new HubProblemError(response.status);
}

export function getHome(tz: string) {
  return requestJson(`/home?${new URLSearchParams({ tz })}`, MachineHomeSchema);
}

export function getReviewCounts() {
  return requestJson("/review?limit=1", MachineReviewCountsSchema);
}

export function getJobs(job?: string) {
  return requestJson(job ? `/jobs?${new URLSearchParams({ job })}` : "/jobs", MachineJobsSchema);
}

export function postJobAction(
  id: string, action: MachineJobActionRequest["action"], expectedState: MachineJobActionRequest["expectedState"], csrfToken: string,
) {
  const body = MachineJobActionRequestSchema.parse({ action, expectedState });
  return requestJson(`/jobs/${encodeURIComponent(id)}/actions`, MachineJobActionResponseSchema, {
    method: "POST",
    headers: { "x-mex-csrf": csrfToken, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
