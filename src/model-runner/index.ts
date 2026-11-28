import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonLines, object } from "../record/usage.js";
import { codexFeatures } from "./codex-features.js";
import { buildModelCommand, MODEL_SYSTEM_PROMPT, readOnlyLimit } from "./command.js";
import { copilotCli } from "./agents.js";
import { ModelRunError, ModelToolLimitError } from "./errors.js";
import { selectModel, type ModelAgent, type ModelSelection } from "./models.js";
import { runModelProcess, MAX_PROCESS_TIMEOUT_MS, type ModelProcessOptions, type ModelProcessResult } from "./process.js";
import type { AutomaticModelBatch } from "./budget-queue.js";
import type { ConsentedModelBatch } from "./consent.js";

export { ModelRunError, ModelToolLimitError } from "./errors.js";
export { ModelWaitError } from "./budget-queue.js";
export { AGENT_MODELS, DEFAULT_MODELS, selectModel } from "./models.js";
export type { AgentModelTable, ModelAgent, ModelRole, ModelSetup, ModelTable } from "./models.js";
export const MAX_MODEL_PROMPT_BYTES = 1024 * 1024;
export const MAX_MODEL_RESULT_BYTES = 1024 * 1024;
export const MAX_MODEL_STREAM_BYTES = 8 * 1024 * 1024;

function geminiSettings(): Record<string, unknown> {
  // Keep machine policy settings when applying a more restrictive per-call overlay.
  const defaultPath = process.platform === "win32"
    ? join(process.env.ProgramData ?? "C:\\ProgramData", "gemini-cli", "settings.json")
    : process.platform === "darwin" ? "/Library/Application Support/GeminiCli/settings.json" : "/etc/gemini-cli/settings.json";
  let base: Record<string, unknown> = {};
  try {
    const existing = object(JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? defaultPath, "utf8")));
    if (!existing) throw new Error("Invalid Gemini CLI system settings.");
    base = existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const admin = object(base.admin);
  return {
    ...base,
    tools: { ...object(base.tools), core: ["read_file"], allowed: [], discoveryCommand: "", callCommand: "" },
    advanced: { ...object(base.advanced), ignoreLocalEnv: true },
    hooksConfig: { ...object(base.hooksConfig), enabled: false },
    admin: { ...admin, secureModeEnabled: true, extensions: { ...object(admin?.extensions), enabled: false },
      mcp: { ...object(admin?.mcp), enabled: false } },
  };
}
function removePrivateDirectory(directory: string): void {
  // Provider state may contain links. Never descend through one.
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (lstatSync(path).isDirectory()) removePrivateDirectory(path);
    else unlinkSync(path);
  }
  rmdirSync(directory);
}

const COPILOT_INSTRUCTION = `${MODEL_SYSTEM_PROMPT} Read the full task from ./task.txt using the view tool and answer it.`;

const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "collab_tool_call",
  "tool_call", "web_search", "dynamic_tool_call", "image_view", "image_generation", "todo_list"]);

export interface ModelRequest extends ModelSelection {
  agent: ModelAgent;
  prompt: string;
  projectRoot: string;
  /** A private empty directory for evidence-only tasks. Accounting still belongs to projectRoot. */
  executionDirectory?: string;
  purpose: string;
  signal?: AbortSignal;
  /** Total wall-clock budget, in addition to the shared inactivity deadline. */
  timeoutMs?: number;
  allowNonGit?: boolean;
  /** Codex evidence judgments run without user instructions or tools. */
  isolatedText?: boolean;
  /**
   * Opt-in: let the agent read the checkout (Claude Code: Read, Grep, Glob only; Codex: its read-only sandbox),
   * with a turn cap. Every other MEX call runs with no tools in a private empty directory.
   */
  readOnlyTools?: { maxTurns?: number };
  /** Automatic work reserves allowance; explicit commands omit this and remain uncapped. */
  automatic?: AutomaticModelBatch;
  /** A background run consented to for this job, within its durable token ceiling. */
  consented?: ConsentedModelBatch;
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
  let privateDir: string | undefined;
  let text = "", hasResult = false, rejected = false, streamBytes = 0;
  let streamFailure: "output" | "protocol" | "tool_limit" | undefined;
  const tools = request.agent === "codex" && request.readOnlyTools ? new Set<string>() : undefined;
  const toolLimit = readOnlyLimit(request.readOnlyTools?.maxTurns);
  const stop = (reason: NonNullable<typeof streamFailure>) => {
    streamFailure ??= reason;
    controller.abort();
  };
  const decoder = jsonLines(event => {
    if (controller.signal.aborted) return;
    const item = object(event.item);
    if (tools && typeof event.type === "string" && event.type.startsWith("item.")
      && item && typeof item.type === "string" && CODEX_TOOL_ITEMS.has(item.type)) {
      // Some calls only emit a completion. A start/update/completion trio is still one call.
      if (typeof item.id !== "string" || !item.id) { stop("protocol"); return; }
      tools.add(item.id);
      if (tools.size >= toolLimit) { stop("tool_limit"); return; }
    }
    if ((request.agent === "gemini" && event.error != null) || (request.agent === "copilot"
      && ["session.error", "error"].includes(String(event.type)))) { rejected = true; return; }
    const next = request.agent === "claude" && event.type === "result" ? event.result
      : request.agent === "codex" && event.type === "item.completed" && item?.type === "agent_message" ? item.text
        : request.agent === "gemini" ? event.response
          : request.agent === "copilot" && event.type === "assistant.message" ? object(event.data)?.content : undefined;
    if (typeof next !== "string") return;
    if (Buffer.byteLength(next) > MAX_MODEL_RESULT_BYTES) { stop("output"); return; }
    // The terminal reply replaces intermediate assistant messages.
    text = next; hasResult = true;
  }, () => stop("protocol"), MAX_MODEL_STREAM_BYTES);
  try {
    const instruction = request.agent === "copilot" ? COPILOT_INSTRUCTION : request.agent === "codex" ? "-" : "";
    let invocation = buildModelCommand(request.agent, instruction, { ...request, access: request.readOnlyTools ? "read" : "text", maxTurns: request.readOnlyTools?.maxTurns,
      codexFeatures: request.agent === "codex" && request.isolatedText && !request.readOnlyTools && !request.__internal ? codexFeatures() : undefined });
    let executionDirectory = request.executionDirectory;
    if (request.agent === "gemini" || request.agent === "copilot") {
      if (request.readOnlyTools) throw new ModelRunError("arguments", request.agent);
      privateDir = mkdtempSync(join(tmpdir(), "mex-model-"));
      executionDirectory = privateDir;
      if (request.agent === "gemini") {
        const settings = join(privateDir, "settings.json");
        writeFileSync(settings, JSON.stringify(geminiSettings()), { mode: 0o600 });
        invocation = { ...invocation, env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings } };
      } else {
        const command = request.__internal?.spawn ? invocation.command : copilotCli();
        if (!command) throw new ModelRunError("launch", request.agent);
        writeFileSync(join(privateDir, "config.json"), JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
        writeFileSync(join(privateDir, "task.txt"), request.prompt, { mode: 0o600 });
        invocation = { ...invocation, command, env: { COPILOT_HOME: privateDir, COPILOT_CACHE_HOME: join(privateDir, "cache") } };
      }
    }
    const timeout = request.timeoutMs ?? 5 * 60_000;
    const result = await runModelProcess(request.agent, invocation, resolve(request.projectRoot), {
      prompt: request.prompt, input: request.agent === "copilot" ? undefined : request.prompt,
      jsonObjectOutput: request.agent === "gemini", purpose: request.purpose,
      maxLineBytes: MAX_MODEL_STREAM_BYTES,
      requestedModel: model, automatic: request.automatic, consented: request.consented, executionDirectory,
      signal: controller.signal, timeoutMs: timeout,
      totalTimeoutMs: Number.isFinite(timeout) ? Math.max(1, Math.min(MAX_PROCESS_TIMEOUT_MS, timeout)) : MAX_PROCESS_TIMEOUT_MS,
      onStdoutChunk: chunk => {
        streamBytes += chunk.length;
        if (streamBytes > MAX_MODEL_STREAM_BYTES) stop("output");
        else decoder.write(chunk);
      }, __internal: request.__internal,
    });
    decoder.end();
    if (streamFailure || rejected || !hasResult) throw new ModelRunError("protocol", request.agent);
    return { ...result, text, selectedModel: model };
  } catch (error) {
    if (streamFailure && !request.signal?.aborted) {
      if (streamFailure === "tool_limit") throw new ModelToolLimitError();
      throw new ModelRunError(streamFailure, request.agent);
    }
    throw error;
  } finally {
    request.signal?.removeEventListener("abort", abort);
    if (privateDir) removePrivateDirectory(privateDir);
  }
}
