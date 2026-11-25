import { assertNoSecrets } from "../knowledge/gates.js";
import { object, recordModelCall } from "../record/usage.js";
import { acquireModelAdmission, ModelWaitError } from "./budget-queue.js";
import { ModelRunError } from "./errors.js";
import type { ModelRequest, ModelResult } from "./index.js";
import { SESSION_API_AGENT, SESSION_API_AUTH_WAIT, SESSION_API_KEY_WAIT, SESSION_API_LIMIT_WAIT, SESSION_API_MODEL,
  sessionApiKey } from "./session-api-policy.js";

const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_BYTES = 1 << 20;
const MAX_OUTPUT_TOKENS = 8192;
const TIMEOUT_MS = 5 * 60_000;

async function responseBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return object(JSON.parse(Buffer.concat(parts, bytes).toString("utf8")));
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new ModelRunError("output", SESSION_API_AGENT);
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000;

/** Only the explicit API choice enters this private, tool-free transport. */
export async function runSessionApi(request: ModelRequest, transport?: typeof fetch): Promise<ModelResult> {
  if (process.env.MEX_SETUP_BACKGROUND_AGENTS === "0" && !transport) throw new ModelRunError("launch", SESSION_API_AGENT);
  const consent = request.automatic?.sessionRunner;
  if (consent?.mode !== "api") throw new ModelWaitError("off");
  const key = sessionApiKey();
  if (!key) throw new ModelWaitError("storage", SESSION_API_KEY_WAIT);
  assertNoSecrets(request.prompt);
  const bytes = Buffer.byteLength(request.prompt);
  if (bytes < 1 || bytes > MAX_BYTES) throw new ModelRunError("prompt", SESSION_API_AGENT);
  const estimate = { input: bytes + 256, cache_write: 0, cache_read: 0, output: MAX_OUTPUT_TOKENS };
  const admission = await acquireModelAdmission({ agent: SESSION_API_AGENT, model: SESSION_API_MODEL,
    projectPath: request.projectRoot, automatic: { estimate, sessionRunner: consent, sessionImport: request.automatic?.sessionImport } }, request.signal);
  if (!admission) throw new ModelWaitError("storage");
  const deadline = AbortSignal.timeout(TIMEOUT_MS), signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
  try {
    const response = await (transport ?? fetch)(ENDPOINT, {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: SESSION_API_MODEL, input: request.prompt, store: false, service_tier: "default",
        reasoning: { effort: "none" }, max_output_tokens: MAX_OUTPUT_TOKENS, text: { format: { type: "json_object" } } }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new ModelWaitError("storage", SESSION_API_AUTH_WAIT);
      if (response.status === 429) throw new ModelWaitError("usage-window", SESSION_API_LIMIT_WAIT);
      throw new ModelRunError("failed", SESSION_API_AGENT);
    }
    const body = await responseBody(response);
    const tokens = object(body?.usage), details = object(tokens?.input_tokens_details);
    const input = tokens?.input_tokens, output = tokens?.output_tokens, cached = details?.cached_tokens ?? 0;
    const cacheWrite = details?.cache_write_tokens ?? 0;
    const usage = count(input) && count(output) && count(cached) && count(cacheWrite) && cached + cacheWrite <= input
      ? { input: input - cached - cacheWrite, output, cache_read: cached, cache_write: cacheWrite, estimated: false, model: SESSION_API_MODEL }
      : { ...estimate, estimated: true, model: SESSION_API_MODEL };
    const recorded = recordModelCall({ ...usage, agent: SESSION_API_AGENT, purpose: request.purpose,
      projectPath: request.projectRoot, batchId: admission.id }, { home: admission.home });
    admission.finish(usage, recorded);
    const text = (Array.isArray(body?.output) ? body.output : []).flatMap(value => {
      const message = object(value);
      return message?.type === "message" && message.role === "assistant" && Array.isArray(message.content)
        ? message.content.flatMap(part => object(part)?.type === "output_text" && typeof part.text === "string" ? [part.text] : []) : [];
    }).join("");
    if (body?.status !== "completed" || !text || Buffer.byteLength(text) > MAX_BYTES) throw new ModelRunError("protocol", SESSION_API_AGENT);
    return { text, selectedModel: SESSION_API_MODEL, usage };
  } catch (error) {
    if (error instanceof ModelRunError || error instanceof ModelWaitError) throw error;
    throw new ModelRunError(request.signal?.aborted ? "cancelled" : deadline.aborted ? "timeout" : "failed", SESSION_API_AGENT);
  } finally { admission.close(); }
}
