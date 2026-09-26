import { z } from "zod";
import type { BuildResult } from "./engine.js";

/** Private process boundary. Never serialize graph rows, source, or raw errors. */
export const GRAPH_CANDIDATE_MESSAGE_BYTES = 1024 * 1024;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(8192);
const identity = z.object({ realPath: text, dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) }).strict();

export const graphCandidateRequest = z.object({
  version: z.literal(1),
  operation: z.enum(["refresh", "rebuild"]),
  projectRoot: text,
  candidatePath: text,
  workspace: text,
  workspaceIdentity: identity,
  mexIdentity: identity,
}).strict();
export type GraphCandidateRequest = z.infer<typeof graphCandidateRequest>;

export const graphCandidateProgress = z.object({
  phase: z.enum(["parse", "resolve"]),
  completed: count.optional(),
  total: count.positive().optional(),
}).strict().refine((value) => value.total === undefined
  || (value.completed !== undefined && value.completed <= value.total));
export type GraphCandidateProgress = z.infer<typeof graphCandidateProgress>;

const buildResult = z.object({
  filesIndexed: count,
  nodesCreated: count,
  edgesCreated: count,
  durationMs: z.number().finite().nonnegative(),
  health: z.object({ ok: count, partial: count, failed: count }).strict().optional(),
  skipped: z.array(z.object({
    filePath: text,
    reason: z.literal("corpus-limit"),
    limit: text,
    limitBytes: count,
    observedBytes: count.optional(),
    message: text,
  }).strict()).max(20_000).optional(),
  declinedInputs: z.array(z.object({
    filePath: text,
    reason: z.literal("outside-project-corpus"),
    message: text,
  }).strict()).max(20_000).optional(),
  // Fixed-vocabulary reasons and counts only; no path crosses this boundary.
  refresh: z.object({
    mode: z.enum(["incremental", "full"]),
    fallbackReason: z.string().max(200).optional(),
    filesChanged: count,
    filesReextracted: count,
    publication: z.enum(["delta", "full"]),
    publicationFallbackReason: z.string().max(200).optional(),
    filesRewritten: count,
  }).strict().optional(),
}).strict() satisfies z.ZodType<BuildResult>;

export const graphCandidateMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("progress"), progress: graphCandidateProgress }).strict(),
  z.object({ type: z.literal("complete"), result: buildResult }).strict(),
  z.object({ type: z.literal("failed"), category: z.enum(["compatibility", "staging", "failed"]) }).strict(),
]);
export type GraphCandidateMessage = z.infer<typeof graphCandidateMessage>;

export function boundedCandidateMessage(value: unknown): GraphCandidateMessage | null {
  try {
    // JSON is also the fork serialization mode; this bounds the complete payload,
    // rather than merely capping an individual diagnostics array.
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > GRAPH_CANDIDATE_MESSAGE_BYTES) return null;
    const parsed = graphCandidateMessage.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
