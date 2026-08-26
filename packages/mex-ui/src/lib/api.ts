/**
 * Typed client for the local `mex ui` API.
 *
 * Errors from the server arrive as `{ error: { code, message, hint? } }`. They
 * are rethrown as {@link ApiError} so views can branch on `code` — the
 * difference between "no scaffold yet" and "the engine blew up" is the
 * difference between showing the wizard and showing a failure.
 */

import type {
  ActivityPayload,
  DriftPayload,
  GraphStats,
  GroundingCaptureResult,
  GroundingCoverage,
  HealthPayload,
  Job,
  ProjectSnapshot,
  SetupPlan,
  SetupRequest,
  SetupResult,
  BuildResult,
} from "./types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string | null;

  constructor(message: string, options: { code: string; status: number; hint?: string | null }) {
    super(message);
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status;
    this.hint = options.hint ?? null;
  }
}

interface ServerErrorBody {
  error?: { code?: string; message?: string; hint?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    // The server is the local CLI process — if fetch itself fails, it stopped.
    throw new ApiError("Can't reach the mex server. Is `mex ui` still running?", {
      code: "OFFLINE",
      status: 0,
      hint: cause instanceof Error ? cause.message : undefined,
    });
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(`The server returned a malformed response for ${path}.`, {
        code: "MALFORMED_RESPONSE",
        status: response.status,
      });
    }
  }

  if (!response.ok) {
    const error = (body as ServerErrorBody | null)?.error;
    throw new ApiError(error?.message ?? `Request to ${path} failed (${response.status}).`, {
      code: error?.code ?? "UNKNOWN",
      status: response.status,
      hint: error?.hint,
    });
  }

  return body as T;
}

export const api = {
  health: () => request<HealthPayload>("/api/health"),
  snapshot: () => request<ProjectSnapshot>("/api/snapshot"),
  setupPlan: () => request<SetupPlan>("/api/setup/plan"),
  drift: () => request<DriftPayload>("/api/drift"),
  activity: (limit = 25) => request<ActivityPayload>(`/api/activity?limit=${limit}`),
  graph: () => request<GraphStats>("/api/graph"),
  grounding: () => request<GroundingCoverage>("/api/grounding"),

  startSetup: (body: SetupRequest) =>
    request<{ job: Job<SetupResult> }>("/api/setup", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((payload) => payload.job),

  startGraphBuild: () =>
    request<{ job: Job<BuildResult> }>("/api/graph/build", { method: "POST" }).then(
      (payload) => payload.job,
    ),

  startGroundingCapture: () =>
    request<{ job: Job<GroundingCaptureResult> }>("/api/grounding/capture", {
      method: "POST",
    }).then((payload) => payload.job),

  job: <T>(id: string) => request<{ job: Job<T> }>(`/api/jobs/${id}`).then((p) => p.job),
};

export function jobStreamUrl(id: string): string {
  return `/api/jobs/${id}/stream`;
}
