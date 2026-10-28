import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runTimed } from "../../compare/lib/process.mjs";
import { classifyCall } from "./classify.mjs";

export const CODEX_FEATURES_OFF = ["memories", "plugins", "apps", "browser_use", "multi_agent", "goals", "skill_search"];
export function listPriceEstimate(usage, rates = null) {
  if (!rates) return null;
  for (const key of ["input", "cachedInput", "cacheWrite", "output"]) if (!Number.isFinite(rates[key]) || rates[key] < 0) throw new Error(`invalid list-price rate: ${key}`);
  return { usd: (Math.max(0, usage.uncachedInput - usage.cacheWrite) * rates.input + usage.cacheRead * rates.cachedInput + usage.cacheWrite * rates.cacheWrite + usage.output * rates.output) / 1e6, rates, basis: "optional list-price estimate, not subscription cost" };
}
/** The source home's `[windows]` sandbox mode; without it a fresh Windows home refuses every shell command. */
export function windowsSandbox(sourceHome, platform = process.platform) {
  if (platform !== "win32") return null;
  let text = "";
  try { text = readFileSync(join(sourceHome, "config.toml"), "utf8"); } catch { return null; }
  const section = /^\[windows\][^\S\r\n]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? "";
  return /^\s*sandbox\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? null;
}
export function codexConfig({ model, effort, windowsSandboxMode = null }) {
  const windows = windowsSandboxMode ? `\n[windows]\nsandbox = ${JSON.stringify(windowsSandboxMode)}\n` : "";
  return `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = ${JSON.stringify(effort)}\nweb_search = "disabled"\n\n[features]\nhooks = true\n${CODEX_FEATURES_OFF.map((f) => `${f} = false`).join("\n")}\n${windows}`;
}
export function codexInvocation({ command = ["codex"], model, effort = "high", sandbox = "workspace-write", workspace, schemaFile, lastMessage, withHooks = false, writableDirs = [] }) {
  return { command: command[0], args: [...command.slice(1), "exec", "--json", "-m", model, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-s", sandbox, "-C", workspace, "--output-schema", schemaFile, "-o", lastMessage, ...[...new Set(writableDirs.filter(Boolean))].flatMap((p) => ["--add-dir", p]), ...(withHooks ? ["--dangerously-bypass-hook-trust"] : [])] };
}
/** Validate the closed JSON schemas used by this harness, including nested constraints. */
export function validateOutput(value, schema) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) return false;
    return Object.entries(value).every(([key, v]) => !schema.properties[key] || validateOutput(v, schema.properties[key]));
  }
  if (schema.type === "array") return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.every((v) => validateOutput(v, schema.items));
  if (schema.type === "string") return typeof value === "string" && Array.from(value).length >= (schema.minLength ?? 0);
  if (schema.type === "integer") return Number.isInteger(value) && value >= (schema.minimum ?? -Infinity);
  return typeof value === schema.type;
}
export function unwrapCommand(command) {
  let value = String(command ?? "");
  for (let i = 0; i < 4; i++) {
    const match = value.match(/^(?:"[^"]*[\\/](?:powershell|pwsh)(?:\.exe)?"|'[^']*(?:powershell|pwsh)(?:\.exe)?'|(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?)\s+(?:-\w+\s+)*-(?:Command|c)\s+([\s\S]+)$/i)
      ?? value.match(/^(?:"[^"]*(?:bash|zsh|sh)"|(?:\S*[\\/])?(?:bash|zsh|sh))\s+-(?:l?c|cl)\s+([\s\S]+)$/i);
    if (!match) break;
    value = match[1].trim();
    if ((value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) value = value.slice(1, -1).replaceAll("'\\''", "'").replaceAll("''", "'");
  }
  return value;
}
export function parseCodex(raw, lastMessage = null, schema = null) {
  const events = [], toolCalls = [], usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  let malformedLines = 0, turns = 0, usageValid = true;
  for (const line of String(raw).split(/\r?\n/).filter(Boolean)) { try { events.push(JSON.parse(line)); } catch { malformedLines++; } }
  const seen = new Set();
  for (const e of events) {
    if (e.type === "turn.completed") {
      turns++;
      for (const [key, field] of Object.entries({ input: "input_tokens", cacheRead: "cached_input_tokens", cacheWrite: "cache_write_input_tokens", output: "output_tokens", reasoning: "reasoning_output_tokens" })) {
        const v = e.usage?.[field] ?? (["cacheWrite", "reasoning"].includes(key) ? 0 : NaN);
        if (!Number.isSafeInteger(v) || v < 0) usageValid = false;
        else usage[key] += v;
      }
      if (e.usage?.cached_input_tokens > e.usage?.input_tokens || e.usage?.reasoning_output_tokens > e.usage?.output_tokens) usageValid = false;
    }
    if (e.type !== "item.completed" || !e.item || seen.has(e.item.id)) continue;
    const item = e.item;
    seen.add(item.id);
    if (item.type === "command_execution") toolCalls.push({ id: item.id, codex: true, name: "Bash", input: { command: unwrapCommand(item.command) }, output: item.aggregated_output ?? "", status: item.exit_code === 0 ? "success" : "error" });
    if (item.type === "file_change") toolCalls.push({ id: item.id, codex: true, name: (item.changes?.length ?? 0) > 1 ? "MultiEdit" : "Edit", input: { file_path: item.changes?.[0]?.path, file_paths: (item.changes ?? []).map((c) => c.path), changes: item.changes ?? [] }, output: "", status: item.status === "failed" ? "error" : "success" });
  }
  usage.uncachedInput = usage.input - usage.cacheRead;
  usage.reportedTotal = usage.input + usage.output;
  usage.newTokens = usage.uncachedInput + usage.output;
  usage.reportedCostUsd = null;
  usage.cacheUseRatio = usage.input ? usage.cacheRead / usage.input : 0;
  usage.accountingValid = turns > 0 && usageValid;
  usage.accountingReason = !turns ? "missing turn.completed" : !usageValid ? "invalid turn usage" : null;
  let value = null;
  try { value = JSON.parse(lastMessage); } catch { /* schema failure below */ }
  const structured = { ok: schema ? validateOutput(value, schema) : value !== null, value, error: "last message does not match the schema" };
  return { events, toolCalls, turns, usage, malformedLines, structured, rawResult: value,
    accounting: { valid: usage.accountingValid, reason: usage.accountingReason, status: usage.accountingValid ? "verified" : "incomplete-usage-invalid", terminalTurns: turns },
    providerFailure: events.some((e) => /usage limit|rate.limit/i.test(e.message ?? e.error?.message ?? (e.item?.type === "error" ? e.item.message : ""))) ? { type: "rate_limit" } : null, permissionDenials: null };
}
export function codexTestTime(events, calls) {
  const ids = new Set(calls.filter((c) => classifyCall(c).category === "test").map((c) => c.id));
  const starts = new Map(), ends = new Map();
  for (const e of events) {
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at)) continue;
    if (e.type === "item.started" && ids.has(e.item?.id)) starts.set(e.item.id, at);
    if (e.type === "item.completed" && ids.has(e.item?.id)) ends.set(e.item.id, at);
  }
  const intervals = [...ids].filter((id) => starts.has(id) && ends.get(id) >= starts.get(id)).map((id) => [starts.get(id), ends.get(id)]).sort((a, b) => a[0] - b[0]);
  let ms = 0, end = -Infinity;
  for (const [a, b] of intervals) { ms += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  return { ms: intervals.length === ids.size ? ms : null, commands: ids.size, timedCommands: intervals.length, status: intervals.length === ids.size ? "complete" : "missing-timestamps" };
}
export async function runCodex({ command, model, effort, sandbox, workspace, env, prompt, schema, outputPrefix, timeoutMs, withHooks, writableDirs = [], sourceHome = env.CODEX_HOME ?? join(homedir(), ".codex") }) {
  const home = `${outputPrefix}.codex-home`, lastMessage = `${outputPrefix}.last-message.json`, schemaFile = `${outputPrefix}.schema.json`;
  if (resolve(home) === resolve(sourceHome)) throw new Error("isolated home must differ from source home");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    if (existsSync(join(sourceHome, "auth.json"))) { copyFileSync(join(sourceHome, "auth.json"), join(home, "auth.json")); chmodSync(join(home, "auth.json"), 0o600); }
    const config = codexConfig({ model, effort, windowsSandboxMode: windowsSandbox(sourceHome) });
    writeFileSync(join(home, "config.toml"), config, { mode: 0o600 });
    writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
    rmSync(lastMessage, { force: true });
    const invocation = codexInvocation({ command, model, effort, sandbox, workspace, schemaFile, lastMessage, withHooks, writableDirs: [...writableDirs, env.TMPDIR] });
    let buffer = "", raw = "";
    const streamFile = `${outputPrefix}.jsonl`;
    writeFileSync(streamFile, "");
    const stamp = (line) => {
      let stamped; try { stamped = `${JSON.stringify({ ...JSON.parse(line), timestamp: new Date().toISOString() })}\n`; } catch { stamped = `${line}\n`; }
      raw += stamped; appendFileSync(streamFile, stamped);
    };
    // Do not inherit alternate config, project injection or provider API credentials.
    const isolatedEnv = { ...env, CODEX_HOME: home };
    for (const key of ["CODEX_CONFIG", "CODEX_CONFIG_FILE", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"]) delete isolatedEnv[key];
    const result = await runTimed(invocation.command, invocation.args, { cwd: workspace, env: isolatedEnv, stdin: prompt, timeoutMs, resolveShims: true, killProcessTree: true,
      onStdout(chunk) { buffer += chunk; let at; while ((at = buffer.indexOf("\n")) >= 0) { stamp(buffer.slice(0, at)); buffer = buffer.slice(at + 1); } } });
    if (buffer.trim()) stamp(buffer);
    writeFileSync(`${outputPrefix}.jsonl`, raw);
    return { ...result, stdout: raw, parsed: parseCodex(raw, existsSync(lastMessage) ? readFileSync(lastMessage, "utf8") : null, schema), isolation: { sourceHome, homeDeleted: true, config } };
  } finally {
    try { if (existsSync(join(home, "sessions"))) cpSync(join(home, "sessions"), `${outputPrefix}.rollout`, { recursive: true }); }
    finally { rmSync(home, { recursive: true, force: true }); }
  }
}
