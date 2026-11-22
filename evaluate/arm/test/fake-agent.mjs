import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";

const [agent, mode, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(agent + " fixture 1");
  process.exit(0);
}
const env = process.env;
const prompt = readFileSync(0, "utf8").trimEnd();
const resumeFlag = agent === "claude" ? "--resume" : "resume";
const resumed = args.includes(resumeFlag);
const session = resumed ? args[args.indexOf(resumeFlag) + 1]
  : agent === "claude" ? args[args.indexOf("--session-id") + 1] : randomUUID();
const cwd = process.cwd();
const settings = agent === "claude" ? join(env.CLAUDE_CONFIG_DIR, "settings.json") : join(env.CODEX_HOME, "hooks.json");
const installed = existsSync(settings);
const model = agent === "claude" ? "claude-sonnet-5-5" : "gpt-6.1-sol";
const transcript = agent === "claude" ? join(env.CLAUDE_CONFIG_DIR, "projects", "fixture", session + ".jsonl")
  : join(env.CODEX_HOME, "sessions", "2026", "11", "22", "rollout-" + session + ".jsonl");
const activeHomes = Object.fromEntries(["HOME", "USERPROFILE", "MEX_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "LOCALAPPDATA"]
  .map(key => [key, env[key]]));
const token = "canary-" + basename(dirname(cwd));
const canaries = {};
for (const home of new Set(Object.values(activeHomes))) {
  if (!existsSync(home)) continue;
  const file = join(home, "fixture-canary");
  canaries[home] = existsSync(file) ? readFileSync(file, "utf8") : null;
  writeFileSync(file, token);
}
const credential = agent === "claude" ? join(env.CLAUDE_CONFIG_DIR, ".credentials.json") : join(env.CODEX_HOME, "auth.json");
const credentialHash = createHash("sha256").update(readFileSync(credential)).digest("hex");
if (existsSync(join(cwd, "check.mjs"))) throw new Error("Hidden tests were available to the agent");
if (mode === "sample") await setTimeout(1500);
if (resumed && !existsSync(transcript)) throw new Error("Cannot resume a missing session");
if (!resumed) {
  const name = /\b(first|second)\b/.exec(prompt)?.[1];
  if (!name || !prompt.endsWith("\n" + name)) throw new Error("Expected the test-name note");
  const src = join(cwd, "subject.mjs");
  if (!(name === "second" && !installed)) {
    writeFileSync(src, readFileSync(src, "utf8").replace(name + "() { return 0", name + "() { return " + (name === "first" ? 1 : 2)));
  }
}
if (resumed && installed) {
  const location = readFileSync(join(env.MEX_HOME, ".mex", "location"), "utf8").trim();
  const db = new DatabaseSync(join(location, "record.db"));
  db.prepare("INSERT INTO model_calls (ts,purpose,agent,model,input,cache_write,cache_read,output,estimated,kind) VALUES (?,?,?,?,?,?,?,?,0,'headless')")
    .run(new Date().toISOString(), "fixture.task", "claude", "claude-sonnet-5-5", 3, 1, 4, 2);
  db.close();
}
const trace = { type: "fixture_observation", prompt, session, resumed, cwd, homes: activeHomes, installed, token, canaries, credentialHash };
const events = [trace];
if (agent === "claude") {
  const usage = resumed
    ? { input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 35, output_tokens: 3 }
    : { input_tokens: 15, cache_creation_input_tokens: 8, cache_read_input_tokens: 25, output_tokens: 7 };
  const row = { type: "assistant", requestId: resumed ? "r2" : "r1", message: { id: resumed ? "m2" : "m1", model, usage } };
  if (!resumed) events.push({ ...row, message: { ...row.message, usage: { ...usage, output_tokens: 1 } } });
  events.push(row);
} else {
  if (!resumed) events.push({ type: "session_meta", payload: { id: session, cwd } });
  events.push({ type: "turn_context", payload: { model } });
  const usage = resumed
    ? { input_tokens: 75, cached_input_tokens: 55, output_tokens: 14, reasoning_output_tokens: 8 }
    : { input_tokens: 30, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 7 };
  const row = { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } };
  events.push(row, row);
}
mkdirSync(dirname(transcript), { recursive: true });
appendFileSync(transcript, events.map(event => JSON.stringify(event)).join("\r\n") + "\r\n");
if (mode === "fail" && resumed) process.exit(37);
const output = agent === "claude"
  ? [{ type: "system", subtype: "init", session_id: session }, { type: "result", subtype: "success", session_id: session }]
  : [{ type: "thread.started", thread_id: session }, { type: "turn.completed" }];
for (const row of output) console.log(JSON.stringify(row));
