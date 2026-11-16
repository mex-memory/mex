import { resolve } from "node:path";
import { jsonLines, object } from "../record/usage.js";
import { buildModelCommand } from "./command.js";
import { ModelRunError } from "./errors.js";
import { selectModel, type ModelAgent, type ModelSelection } from "./models.js";
import { runModelProcess, MAX_PROCESS_TIMEOUT_MS, type ModelProcessOptions, type ModelProcessResult } from "./process.js";
import type { AutomaticModelBatch } from "./budget-queue.js";

export { ModelRunError } from "./errors.js";
export { ModelWaitError } from "./budget-queue.js";
export { AGENT_MODELS, DEFAULT_MODELS, selectModel } from "./models.js";
export type { AgentModelTable, ModelAgent, ModelRole, ModelSetup, ModelTable } from "./models.js";
export const MAX_MODEL_PROMPT_BYTES = 1024 * 1024;
export const MAX_MODEL_RESULT_BYTES = 1024 * 1024;
export const MAX_MODEL_STREAM_BYTES = 8 * 1024 * 1024;

export interface ModelRequest extends ModelSelection {
  agent: ModelAgent;
  prompt: string;
  projectRoot: string;
  purpose: string;
  signal?: AbortSignal;
  /** Total wall-clock budget, in addition to the shared inactivity deadline. */
  timeoutMs?: number;
  allowNonGit?: boolean;
  /** Automatic work reserves allowance; explicit commands omit this and remain uncapped. */
  automatic?: AutomaticModelBatch;
  /** Tests only; product requests never supply transports. */
  __internal?: ModelProcessOptions["__internal"];
}
export interface ModelResult extends ModelProcessResult { text: string; selectedModel: string; }

/** One-shot text task, no session file and no workspace writes. Setup uses the same process owner. */
export async function runModel(request: ModelRequest): Promise<ModelResult> {
  if (request.signal?.aborted) throw new ModelRunError("cancelled", request.agent);
  if (process.env.MEX_SETUP_BACKGROUND_AGENTS === "0" && !request.__internal?.spawn) throw new ModelRunError("launch", request.agent);
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") throw new ModelRunError("arguments", request.agent);
  if (typeof request.projectRoot !== "string" || request.projectRoot.trim() === "") throw new ModelRunError("arguments", request.agent);
  if (Buffer.byteLength(request.prompt) > MAX_MODEL_PROMPT_BYTES) throw new ModelRunError("prompt", request.agent);
  if (typeof request.purpose !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.purpose)) throw new ModelRunError("arguments", request.agent);
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) throw new ModelRunError("arguments", request.agent);
  let model: string;
  try { model = selectModel(request.agent, request); }
  catch { throw new ModelRunError("arguments", request.agent); }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) controller.abort();
  let text = "", hasResult = false, streamBytes = 0;
  let outputError: "output" | "protocol" | undefined;
  const decoder = jsonLines(event => {
    const item = object(event.item);
    const next = request.agent === "claude" && event.type === "result" ? event.result
      : request.agent === "codex" && event.type === "item.completed" && item?.type === "agent_message" ? item.text : undefined;
    if (typeof next !== "string") return;
    if (Buffer.byteLength(next) > MAX_MODEL_RESULT_BYTES) { outputError = "output"; controller.abort(); return; }
    // The terminal reply replaces intermediate assistant messages.
    text = next; hasResult = true;
  }, () => { outputError = "protocol"; controller.abort(); }, MAX_MODEL_STREAM_BYTES);
  try {
    const invocation = buildModelCommand(request.agent, request.agent === "claude" ? "" : "-", { ...request, access: "text" });
    const timeout = request.timeoutMs ?? 5 * 60_000;
    const result = await runModelProcess(request.agent, invocation, resolve(request.projectRoot), {
      prompt: request.prompt, input: request.prompt, purpose: request.purpose,
      maxLineBytes: MAX_MODEL_STREAM_BYTES,
      requestedModel: model, automatic: request.automatic,
      signal: controller.signal, timeoutMs: timeout,
      totalTimeoutMs: Number.isFinite(timeout) ? Math.max(1, Math.min(MAX_PROCESS_TIMEOUT_MS, timeout)) : MAX_PROCESS_TIMEOUT_MS,
      onStdoutChunk: chunk => {
        streamBytes += chunk.length;
        if (streamBytes > MAX_MODEL_STREAM_BYTES) { outputError = "output"; controller.abort(); }
        else decoder.write(chunk);
      }, __internal: request.__internal,
    });
    decoder.end();
    if (outputError) throw new ModelRunError(outputError, request.agent);
    if (!hasResult) throw new ModelRunError("protocol", request.agent);
    return { ...result, text, selectedModel: model };
  } catch (error) {
    if (outputError && !request.signal?.aborted) throw new ModelRunError(outputError, request.agent);
    throw error;
  } finally { request.signal?.removeEventListener("abort", abort); }
}
