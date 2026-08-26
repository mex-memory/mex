// ============================================================================
// UI JSON API
// ============================================================================
//
// Transport-agnostic on purpose: the router takes a plain request record and
// returns a plain response record, so every endpoint is testable without
// opening a socket. `server.ts` adapts node:http onto it.
//
// Every read here goes through an existing engine API. The only writes happen
// behind an explicit POST the user triggered.

import { runDriftCheck } from "../drift/index.js";
import { findConfig } from "../config.js";
import { checkHeartbeat } from "../heartbeat.js";
import { readEvents, type EventEntry } from "../events.js";
import { AI_TOOLS, type AiTool, type DriftReport } from "../types.js";
import { VERSION } from "../version.js";
import { readGraphStats, type GraphStats } from "./graph-stats.js";
import { readGroundingCoverage, type GroundingCoverage } from "./grounding.js";
import { readSetupPlan, readSnapshot, type ProjectSnapshot, type SetupPlan } from "./snapshot.js";
import {
  GRAPH_JOB_STEPS,
  GROUNDING_JOB_STEPS,
  SETUP_JOB_STEPS,
  runGraphBuildJob,
  runGroundingCaptureJob,
  runHeadlessSetup,
} from "./setup-runner.js";
import type { Job, JobRegistry } from "./jobs.js";
import type { SetupMode } from "../setup/steps.js";
import type { HeartbeatResult } from "../heartbeat.js";

export interface ApiRequest {
  method: string;
  /** Path with no query string, e.g. `/api/snapshot`. */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, or undefined for bodyless requests. */
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string };
}

export interface ApiContext {
  /** Directory the server was pointed at. */
  root: string;
  jobs: JobRegistry;
}

export interface HealthPayload {
  ok: true;
  version: string;
  root: string;
}

export interface DriftPayload {
  report: DriftReport;
  /** Non-fatal notices raised while checking (e.g. graph unavailable). */
  warnings: string[];
}

export interface ActivityPayload {
  events: EventEntry[];
  heartbeat: HeartbeatResult;
}

export type ApiRouter = (request: ApiRequest) => Promise<ApiResponse>;

/**
 * Build the API router for a project root. The returned function is safe to
 * call concurrently; it holds no request state.
 */
export function createApiRouter(ctx: ApiContext): ApiRouter {
  return async function handle(request: ApiRequest): Promise<ApiResponse> {
    const { method, path } = request;

    if (path === "/api/health" && method === "GET") {
      return ok<HealthPayload>({ ok: true, version: VERSION, root: ctx.root });
    }

    if (path === "/api/snapshot" && method === "GET") {
      return ok<ProjectSnapshot>(readSnapshot({ root: ctx.root }));
    }

    if (path === "/api/setup/plan" && method === "GET") {
      return ok<SetupPlan>(readSetupPlan({ root: ctx.root }));
    }

    if (path === "/api/graph" && method === "GET") {
      return ok<GraphStats>(readGraphStats({ root: ctx.root }));
    }

    if (path === "/api/grounding" && method === "GET") {
      return ok<GroundingCoverage>(readGroundingCoverage({ root: ctx.root }));
    }

    if (path === "/api/drift" && method === "GET") {
      return withConfig(ctx, async (config) => {
        const warnings: string[] = [];
        const report = await runDriftCheck(config, {
          // Default routes this to console.warn; surface it in the response
          // instead so the UI can explain a missing graph in context.
          graphWarning: (message) => warnings.push(message),
        });
        return ok<DriftPayload>({ report, warnings });
      });
    }

    if (path === "/api/activity" && method === "GET") {
      return withConfig(ctx, async (config) => {
        const limit = readLimit(request.query.get("limit"), 25);
        const events = readEvents(config)
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
          .slice(0, limit);
        return ok<ActivityPayload>({ events, heartbeat: checkHeartbeat(config) });
      });
    }

    if (path === "/api/setup" && method === "POST") {
      return startSetupJob(ctx, request.body);
    }

    if (path === "/api/graph/build" && method === "POST") {
      const job = ctx.jobs.start("graph-build", GRAPH_JOB_STEPS, (jobCtx) =>
        runGraphBuildJob(ctx.root, jobCtx),
      );
      return { status: 202, body: { job } };
    }

    if (path === "/api/grounding/capture" && method === "POST") {
      return startGroundingCapture(ctx);
    }

    if (path === "/api/jobs" && method === "GET") {
      return ok({ jobs: ctx.jobs.list() });
    }

    const jobId = matchJobId(path);
    if (jobId && method === "GET") {
      const job = ctx.jobs.get(jobId);
      if (!job) return notFound(`No job with id ${jobId}. It may have expired.`);
      return ok<{ job: Job }>({ job });
    }

    if (path.startsWith("/api/")) {
      return {
        status: 404,
        body: error("NOT_FOUND", `No API route for ${method} ${path}.`),
      };
    }

    return { status: 404, body: error("NOT_FOUND", `Unknown path ${path}.`) };
  };
}

// ── Setup ──

interface SetupRequestBody {
  mode: SetupMode;
  tools: AiTool[];
  buildGraph: boolean;
}

async function startSetupJob(ctx: ApiContext, rawBody: unknown): Promise<ApiResponse> {
  let body: SetupRequestBody;
  try {
    body = parseSetupBody(rawBody);
  } catch (err) {
    return { status: 400, body: error("INVALID_REQUEST", messageOf(err)) };
  }

  const plan = readSetupPlan({ root: ctx.root });
  if (plan.isMexRepo) {
    return {
      status: 409,
      body: error(
        "MEX_REPO",
        "You're inside the mex repository itself. Run mex ui from your own project instead.",
      ),
    };
  }

  const job = ctx.jobs.start("setup", SETUP_JOB_STEPS, (jobCtx) =>
    runHeadlessSetup(
      { root: ctx.root, mode: body.mode, tools: body.tools, buildGraph: body.buildGraph },
      jobCtx,
    ),
  );
  return { status: 202, body: { job } };
}

// ── Grounding ──

/**
 * Start a grounding-capture job, refusing the two cases where it would do
 * nothing: no scaffold to read grounding from, and no graph to fingerprint
 * against. Both are more useful as an explanation than as a job that reports
 * zero baselines.
 */
function startGroundingCapture(ctx: ApiContext): ApiResponse {
  const snapshot = readSnapshot({ root: ctx.root });

  if (snapshot.scaffoldRoot === null) {
    return {
      status: 409,
      body: error(
        "SCAFFOLD_UNAVAILABLE",
        "There is no .mex/ scaffold to capture grounding from.",
        "Run setup first.",
      ),
    };
  }

  if (!snapshot.graph.present) {
    return {
      status: 409,
      body: error(
        "GRAPH_UNAVAILABLE",
        "Grounding baselines are fingerprints of real code, so the code graph has to exist first.",
        "Build the code graph, then capture grounding.",
      ),
    };
  }

  const job = ctx.jobs.start("grounding-capture", GROUNDING_JOB_STEPS, (jobCtx) =>
    runGroundingCaptureJob(ctx.root, jobCtx),
  );
  return { status: 202, body: { job } };
}

/** Validate the wizard payload. Unknown tools are rejected, not silently dropped. */
export function parseSetupBody(raw: unknown): SetupRequestBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Expected a JSON object body.");
  }
  const input = raw as Record<string, unknown>;

  const mode = input.mode ?? "code-repo";
  if (mode !== "code-repo" && mode !== "agent-memory") {
    throw new Error(`Unknown setup mode "${String(mode)}". Use code-repo or agent-memory.`);
  }

  const rawTools = input.tools ?? [];
  if (!Array.isArray(rawTools)) {
    throw new Error("`tools` must be an array of AI tool ids.");
  }
  const valid = new Set(Object.keys(AI_TOOLS));
  const tools: AiTool[] = [];
  for (const tool of rawTools) {
    if (typeof tool !== "string" || !valid.has(tool)) {
      throw new Error(
        `Unknown AI tool "${String(tool)}". Expected one of: ${Object.keys(AI_TOOLS).join(", ")}.`,
      );
    }
    tools.push(tool as AiTool);
  }

  const buildGraph = input.buildGraph ?? true;
  if (typeof buildGraph !== "boolean") {
    throw new Error("`buildGraph` must be a boolean.");
  }

  return { mode, tools: [...new Set(tools)], buildGraph };
}

// ── Helpers ──

const JOB_PATH = /^\/api\/jobs\/([A-Za-z0-9-]+)$/;

function matchJobId(path: string): string | null {
  return JOB_PATH.exec(path)?.[1] ?? null;
}

/**
 * Run `body` with a loaded config, or return a structured 409 when there is no
 * usable scaffold. Uses `findConfig` rather than the CLI's identity-backfilling
 * loader: reading the dashboard must never mint an identity.
 */
async function withConfig(
  ctx: ApiContext,
  body: (config: ReturnType<typeof findConfig>) => Promise<ApiResponse>,
): Promise<ApiResponse> {
  let config: ReturnType<typeof findConfig>;
  try {
    config = findConfig(ctx.root);
  } catch (err) {
    return {
      status: 409,
      body: error("SCAFFOLD_UNAVAILABLE", messageOf(err), "Run setup to create a .mex/ scaffold."),
    };
  }
  try {
    return await body(config);
  } catch (err) {
    return { status: 500, body: error("ENGINE_ERROR", messageOf(err)) };
  }
}

function ok<T>(body: T): ApiResponse {
  return { status: 200, body };
}

function notFound(message: string): ApiResponse {
  return { status: 404, body: error("NOT_FOUND", message) };
}

function error(code: string, message: string, hint?: string): ApiErrorBody {
  return { error: hint === undefined ? { code, message } : { code, message, hint } };
}

function readLimit(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
