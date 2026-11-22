import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { propose, type Proposal } from "../../src/knowledge/gate.js";
import { openHooksReadOnly, openRecordReadOnly } from "../../src/record/index.js";

// TODO: Enable both required graph read checks when graph reads merge.
const GRAPH_READS_MERGED = false;
const repo = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(repo, "dist", "cli.js");
const binary = resolve(process.env.MEX_HOOK_BINARY ?? join(repo, "native", ".scratch", process.platform === "win32" ? "mex-hook.exe" : "mex-hook"));
const file = "src/widget.ts";
const caller = "src/caller.ts";
const symbol = "makeWidget";
const claim = "Keep one widget for each request.";
const oldBody = "return 31;";
const newBody = "return 470;";
const signature = `export function ${symbol}() {`;
const source = (body: string) => `${signature}\n  ${body}\n}\n`;
const agents = ["claude-code", "codex"] as const;
type Agent = typeof agents[number];

const started = performance.now();
const temp = realpathSync(mkdtempSync(join(tmpdir(), "mex-joined-")));
const checkout = join(temp, "repo");
const captures = join(temp, "events");
const mexBase = join(temp, "mex");
const home = join(mexBase, ".mex");
const environment = {
  MEX_HOME: mexBase, HOME: join(temp, "home"), USERPROFILE: join(temp, "home"),
  LOCALAPPDATA: join(temp, "local"), APPDATA: join(temp, "roaming"),
  XDG_CACHE_HOME: join(temp, "cache"), XDG_CONFIG_HOME: join(temp, "config"),
  CLAUDE_CONFIG_DIR: join(temp, "claude"), CODEX_HOME: join(temp, "codex"),
  GIT_CONFIG_GLOBAL: join(temp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  MEX_HOOK_BINARY: binary, MEX_INSTALL_AUTO: "0", MEX_SETUP_BACKGROUND_AGENTS: "0",
  MEX_BACKGROUND: "0", MEX_TELEMETRY: "0", MEX_OFFLINE: "1", CI: "1",
};
// The producer gate starts the native evaluator with the process environment.
for (const key of Object.keys(process.env)) {
  if (/^(MEX_|GIT_|CLAUDE|CODEX_|GITHUB_TOKEN$|GH_TOKEN$)/iu.test(key)) delete process.env[key];
}
Object.assign(process.env, environment);

function run(command: string, args: string[], options: { payload?: object; capture?: boolean; statuses?: number[] } = {}) {
  const { payload, capture, statuses = [0] } = options;
  const result = spawnSync(command, args, {
    cwd: checkout, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", windowsHide: true,
    env: capture ? { ...process.env, MEX_HOOK_RECORD: captures } : process.env,
    input: payload === undefined ? "" : JSON.stringify(payload), timeout: 30_000, maxBuffer: 2 << 20,
  });
  if (result.error || !statuses.includes(result.status ?? -1)) {
    throw new Error(`${args.join(" ") || "bare mex"} exited ${result.status}: ${result.error?.message ?? `${result.stdout}\n${result.stderr}`}`);
  }
  return result.stdout;
}

const mex = (...args: string[]) => run(process.execPath, [cli, ...args]);
const json = (...args: string[]) => JSON.parse(mex(...args));

function requireJoin(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function step<T>(name: string, action: () => T | Promise<T>): Promise<T> {
  try {
    const result = await action();
    console.log(`PASS ${name}`);
    return result;
  } catch (error) {
    throw new Error(`${name} broke: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

// Setup v2 will replace this read with readSetupSteps.
function readSetupJobs(): Array<{ kind: string; state: string; reason: string | null }> {
  return json("jobs", "--json").jobs;
}

function readProject(): string {
  const record = openRecordReadOnly({ home });
  try {
    const project = record?.checkout(checkout);
    requireJoin(project?.state === "on", "setup did not leave the checkout registered and on");
    return project.project_id;
  } finally { record?.close(); }
}

function searchPayload(agent: Agent, session: string) {
  const common = { session_id: session, cwd: checkout, hook_event_name: "PostToolUse" };
  // Keep the checked-in recordings' tool shapes and use fixture paths and results.
  // Codex 0.165 records plain command output, so the payload has no exit header.
  const result = `${file}:1:${signature}`;
  return agent === "claude-code"
    ? { ...common, tool_name: "Grep", tool_input: { pattern: symbol, path: checkout, output_mode: "content", "-n": true },
      tool_response: { mode: "content", numFiles: 0, filenames: [], content: result, numLines: 1, totalLines: 1 } }
    : { ...common, turn_id: `turn-${session}`, tool_use_id: `exec-${session}`, tool_name: "Bash",
      tool_input: { command: `rg -n "function ${symbol}" src` }, tool_response: result };
}

function hook(agent: Agent, event: string, payload: object, capture = false) {
  const reply = JSON.parse(run(binary, [agent, event], { payload, capture }));
  requireJoin(reply !== null && typeof reply === "object" && !Array.isArray(reply), `${agent} returned an invalid hook reply`);
  return reply.hookSpecificOutput?.additionalContext ?? "";
}

function replay(agent: Agent, session: string, capture = false): string {
  return hook(agent, "PostToolUse", searchPayload(agent, session), capture);
}

interface Receipt { entry_id: string; surface: string; action: string; block_id: string; form: string; }

// The Sessions API can read this ledger through the same read-only record port.
function readReceipts(project: string, session: string): Receipt[] {
  const record = openHooksReadOnly({ home });
  try {
    if (!record) return [];
    requireJoin(!record.diagnostic, record.diagnostic ?? "the hook record is unreadable");
    return record.all<Receipt>("SELECT entry_id, surface, action, block_id, form FROM deliveries WHERE project_id=? AND session_id=?", project, session);
  } finally { record?.close(); }
}

function checkCard(context: string, agent: Agent, surface: string, body: string) {
  requireJoin(context.includes(`${file}:`) && context.includes(symbol) && context.includes(body),
    `${agent} sent no ${surface} card for ${symbol}`);
}

function checkReceipt(context: string, receipts: Receipt[], agent: Agent, surface: string) {
  requireJoin(receipts.some(row => row.action === "given" && row.surface === surface && row.block_id && context.includes(`[mex ${row.block_id}]`)),
    `${agent} has no ${surface} receipt for the delivered block`);
}

function submit(key: string, checks: NonNullable<Proposal["checks"]>, text = claim) {
  return propose([{
    producer: "code-facts", key, kind: "pitfall", text, model: "none",
    source: { type: "mined", ref: file, quote: signature }, evidence: [file], anchors: { scope: [file] }, checks,
  }], { projectPath: checkout, home });
}

async function main() {
  const project = await step("join 1 setup", () => {
    mkdirSync(join(checkout, "src"), { recursive: true });
    for (const path of [environment.HOME, environment.LOCALAPPDATA, environment.CLAUDE_CONFIG_DIR, environment.CODEX_HOME]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(checkout, file), source(oldBody));
    writeFileSync(join(checkout, caller), `import { ${symbol} } from "./widget.js";\nexport const widget = ${symbol}();\n`);
    run("git", ["init", "--quiet", "--template="]);
    run("git", ["add", "--", file, caller]);
    run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Create fixture"]);
    mex();
    const jobs = readSetupJobs();
    for (const kind of ["file-index", "code-facts"]) {
      const row = jobs.find(job => job.kind === kind);
      requireJoin(row?.state === "done", `bare mex did not finish its ${kind} job (${row?.state ?? "missing"}${row?.reason ? `: ${row.reason}` : ""})`);
    }
    return readProject();
  });

  await step("join 1→2 file index", () => {
    const outline = mex("index", "outline", file);
    requireJoin(outline.startsWith(`${file} (index as of `) && outline.split(/\r?\n/u).some(line => line.trim() === `function ${symbol}  1-3`),
      `setup did not build a current index for ${symbol}: ${outline.trim()}`);
  });

  await step("join 2→3 semantic graph", () => {
    const graph = json("graph", "--json");
    const status = json("graph", "status", "--json");
    requireJoin(graph.nodesCreated > 0 && graph.edgesCreated > 0 && status.status === "fresh", `the semantic graph has no fresh nodes and edges (${status.status})`);
  });

  const entry = await step("join 3→4 producer gate and store", async () => {
    const [result] = await submit("joined-symbol", [{ kind: "symbol", role: "complete", target: { file, symbol } }]);
    requireJoin(result?.status === "accepted", `the gate did not accept the symbol proposal: ${JSON.stringify(result)}`);
    const check = json("check", "--json");
    requireJoin(check.entries?.some((row: { id: string; one_line: string; verdict: string }) => row.id === result.entryId && row.one_line === claim && row.verdict === "held"),
      `entry ${result.entryId} did not land with a held verdict`);
    return result.entryId;
  });

  if (GRAPH_READS_MERGED) {
    await step("join 3→4 relation-check", async () => {
      const [result] = await submit("joined-relation", [{ kind: "relation", role: "complete", target: { query: "imports", from: caller, to: file }, saw: { count: 1 } }], "The caller depends on the widget module.");
      requireJoin(result?.status === "accepted", `the gate did not accept the relation proposal: ${JSON.stringify(result)}`);
    });
  } else console.log("SKIP relation-check (pending: graph reads not merged)");

  const fresh = await step("join 4→5 replayed search", () => {
    mex("config", "set", "delivery.surface.search-span", "on", "--project");
    return agents.map(agent => {
      const session = `joined-${agent}-fresh`;
      const context = replay(agent, session, true);
      const folder = join(captures, agent);
      const saved = readdirSync(folder).find(name => name.startsWith("PostToolUse-"));
      requireJoin(saved && JSON.parse(readFileSync(join(folder, saved), "utf8")).session_id === session, `${agent} did not accept the recorded search payload`);
      return { agent, session, context };
    });
  });

  await step("join 4→6 search-span card", () => {
    for (const { agent, context } of fresh) {
      requireJoin(context, `${agent} returned no context for ${symbol} with search-span enabled`);
      checkCard(context, agent, "search-span", oldBody);
    }
  });

  await step("join 6→7 delivery receipt", () => {
    for (const { agent, session, context } of fresh) checkReceipt(context, readReceipts(project, session), agent, "search-span");
  });

  if (GRAPH_READS_MERGED) {
    await step("join 5→6 graph-card", () => {
      mex("config", "set", "delivery.surface.graph-card", "on", "--project");
      for (const agent of agents) {
        const session = `joined-${agent}-graph`;
        const context = replay(agent, session);
        checkCard(context, agent, "graph-card", caller);
        checkReceipt(context, readReceipts(project, session), agent, "graph-card");
      }
    });
  } else console.log("SKIP graph-card (pending: graph reads not merged)");
  console.log("DEFER Hub Sessions API (Hub v1 is deferred)");

  // The span carries source. A first read is the moment that can carry this pitfall's prose.
  const start = (session: string) => hook("codex", "SessionStart", { session_id: session, cwd: checkout, hook_event_name: "SessionStart", source: "startup" });
  const read = (session: string, body: string) => hook("codex", "PostToolUse", {
    session_id: session, cwd: checkout, hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_input: { command: `cat ${file}` }, tool_response: `Exit code: 0\nOutput:\n${source(body)}`,
  });
  const kept = (session: string, context: string) => {
    const receipts = readReceipts(project, session).filter(row => row.entry_id === entry);
    return !context.includes(claim) && receipts.some(row => row.action === "withheld" || (row.action === "given" && row.form === "pointer"));
  };
  const change = (body: string) => {
    writeFileSync(join(checkout, file), source(body));
    json("index", "--json");
  };

  // A session that is open while the code changes under it, by a shell
  // command the agent runs (not an edit tool): the hook sees the command.
  const open = "joined-open-session";
  await step("join 6→7 fresh entry delivered", () => {
    start(open);
    requireJoin(read("joined-fresh-entry", oldBody).includes(claim), `entry ${entry} was never delivered on a fresh read`);
  });

  await step("join stale: a new session after the code changed", () => {
    change(newBody);
    for (const agent of agents) {
      const context = replay(agent, `joined-${agent}-stale`);
      checkCard(context, agent, "search-span", newBody);
      requireJoin(!context.includes(claim) && !context.includes(oldBody), `${agent} replay delivered stale text for ${entry}`);
    }
    const session = "joined-stale-entry";
    start(session);
    requireJoin(kept(session, read(session, newBody)), `entry ${entry} was not withheld or reduced to a pointer in a new session after its symbol changed`);
  });

  await step("join stale: a shell command changed the code mid-session", () => {
    change(oldBody);
    const session = "joined-shell-write";
    start(session);
    // The shell command rewrites the file; nothing refreshes the index.
    writeFileSync(join(checkout, file), source(newBody));
    hook("codex", "PostToolUse", {
      session_id: session, cwd: checkout, hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: `sed -i "s/31/470/" ${file}` }, tool_response: "Exit code: 0\nOutput:\n",
    });
    requireJoin(kept(session, read(session, newBody)), `entry ${entry} was delivered in full after a shell command changed its symbol in the same session`);
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Fixture files: ${temp}`);
  process.exitCode = 1;
} finally {
  console.log(`Measured joined fixture time: ${((performance.now() - started) / 1000).toFixed(2)} s`);
}
