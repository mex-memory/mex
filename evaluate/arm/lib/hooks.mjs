// The product hooks (`mex hooks`, `mex-hook`, `mex context`) as the agent-arm test uses them.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { git, runMex } from "./workspace.mjs";

export const CONTEXT_LOG = "context-log.jsonl";
export const SETTLE_LOCK = "context-settle.lock";
export const SETTLE_AGAIN = "context-settle.again";
const SETTLE_CAP_MS = 10 * 60 * 1000;

const localDir = (workspace) => join(workspace, ".mex", "local");

/** The hook entries MEX wrote into a checkout's `.claude/settings.json` (commands ending in `--mex-managed`). */
export function managedHookCommands(workspace, tool = "claude") {
  const path = tool === "codex" ? join(workspace, ".codex", "hooks.json") : join(workspace, ".claude", "settings.json");
  if (!existsSync(path)) return [];
  try {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    const commands = [];
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      for (const group of groups ?? []) for (const hook of group.hooks ?? []) if (typeof hook.command === "string") commands.push({ event, matcher: group.matcher ?? null, command: hook.command });
    }
    return commands.filter((entry) => /(?:^|\s)--mex-managed(?:\s|$)/.test(entry.command));
  } catch {
    return [];
  }
}

/** Any hook at all in the checkout's project settings, however it got there. */
export function anyHookEntries(workspace, tool = "claude") {
  const path = tool === "codex" ? join(workspace, ".codex", "hooks.json") : join(workspace, ".claude", "settings.json");
  if (!existsSync(path)) return 0;
  try {
    return Object.values(JSON.parse(readFileSync(path, "utf8")).hooks ?? {}).reduce((sum, groups) => sum + (groups ?? []).reduce((n, group) => n + (group.hooks ?? []).length, 0), 0);
  } catch {
    return 1;
  }
}

/**
 * Install the product hooks in a session checkout and commit them as setup
 * state, so the session diff is only the agent's work. The scaffold ref is not
 * touched: this happens per checkout, after the scaffold is in place.
 */
export function installProductHooks({ workspace, cliBin, env, tool = "claude" }) {
  const result = runMex(cliBin, ["hooks", "install", "--tool", tool, "--json"], workspace, env);
  if (result.code !== 0) throw new Error(`mex hooks install failed in ${workspace}: ${result.stderr || result.stdout}`);
  const commands = managedHookCommands(workspace, tool);
  if (!commands.length) throw new Error(`mex hooks install wrote no MEX hook entries in ${workspace}`);
  // The entries must run the frozen CLI, never some other install: its `mex-hook` shim, or its own
  // built bundle (`<node_modules>/mex-agent/dist/hook.js`, which install prefers).
  const status = runMex(cliBin, ["hooks", "status", "--tool", tool, "--json"], workspace, env);
  let installed = null;
  try { installed = JSON.parse(status.stdout).data?.installed ?? null; } catch { installed = null; }
  const within = (dir) => {
    const rel = installed?.target ? relative(resolve(dir), resolve(installed.target)) : "..";
    return Boolean(rel) && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
  };
  const inside = installed?.kind === "bin" ? within(cliBin) : installed?.kind === "node" && within(join(cliBin, "..", "mex-agent"));
  if (installed?.exists !== true || !inside) {
    throw new Error(`the installed hook command does not resolve to the frozen CLI (${JSON.stringify(installed)}), cliBin ${cliBin}`);
  }
  git(workspace, ["add", "-A"]);
  git(workspace, ["commit", "-q", "--allow-empty", "-m", "eval: MEX hooks installed"]);
  return { commands: commands.map(({ event, matcher, command }) => ({ event, matcher, command })), resolvesTo: installed.target };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Wait for the product's detached settle worker (graph refresh and re-recording)
 * so the diff, check and hidden tests see its writes. The Stop hook creates the
 * lock before it starts the worker, so a missing lock means no worker. A lock
 * whose pid is gone is stale. Its time is not session time.
 */
export async function waitForSettle(workspace, timeoutMs = SETTLE_CAP_MS) {
  const lock = join(localDir(workspace), SETTLE_LOCK);
  const started = Date.now();
  let sawWorker = false;
  const holder = () => {
    if (!existsSync(lock)) return false;
    let pid = NaN;
    try { pid = Number(readFileSync(lock, "utf8").trim()); } catch { return false; }
    return Number.isFinite(pid) && pid > 0 && alive(pid);
  };
  while (holder() && Date.now() - started < timeoutMs) {
    sawWorker = true;
    await new Promise((done) => setTimeout(done, 500));
  }
  return { waitMs: Date.now() - started, sawWorker, timedOut: holder() && Date.now() - started >= timeoutMs };
}

/** Parse the hook log; unreadable lines are counted, never fatal. */
export function readContextLog(path) {
  if (!existsSync(path)) return { entries: [], malformed: 0 };
  const entries = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try { entries.push(JSON.parse(line)); } catch { malformed += 1; }
  }
  return { entries, malformed };
}

const TOOL_EVENTS = ["prompt", "read", "edit", "grep", "bash"];
const BUDGET_NOTES = new Set(["budget-pointers", "budget-exhausted"]);
const uniq = (values) => [...new Set(values)];

/**
 * What the hooks did in one session, from the log they append to.
 * In-session hook time excludes the detached settle worker; `injectedChars` is the sum of
 * what the events sent to the agent (prompt, read, edit, grep, bash and the Stop block).
 */
export function summarizeContextLog(path) {
  const { entries, malformed } = readContextLog(path);
  if (!entries.length && !existsSync(path)) return null;
  const events = [];
  const perEvent = Object.fromEntries([...TOOL_EVENTS, "stop"].map((name) => [name, { count: 0, injected: 0, ms: 0, chars: 0, ids: [] }]));
  const stopBlocks = [];
  const settles = [];
  const failures = [];
  const promptNotes = {};
  let injectedChars = 0, hookMs = 0, errors = 0, budgetHit = false;
  for (const entry of entries) {
    const name = entry.event;
    if (name === "settle") {
      settles.push({
        loop: entry.loop ?? 0, ms: entry.ms ?? null, touched: entry.touched ?? 0, eligible: entry.eligible ?? 0, flagged: entry.flagged ?? 0,
        refresh: entry.refresh ? { code: entry.refresh.code ?? null, ms: entry.refresh.ms ?? null, mode: entry.refresh.mode ?? null, reason: entry.refresh.reason ?? null, changed: entry.refresh.changed ?? null, reextracted: entry.refresh.reextracted ?? null } : null,
        reground: entry.reground ?? null, skipped: entry.skipped ?? null,
      });
      if (entry.skipped === "refresh-failed" || (entry.refresh?.code ?? 0) !== 0 || (entry.reground?.failed ?? 0) > 0) failures.push({ event: "settle", loop: entry.loop ?? 0, skipped: entry.skipped ?? null, regroundFailed: entry.reground?.failed ?? 0, refused: entry.reground?.refused ?? [] });
      continue;
    }
    if (name === "settle-error" || name === "settle-refresh-failed") { failures.push({ event: name, error: entry.error ?? entry.stderr ?? null, code: entry.code ?? null }); continue; }
    if (name === "error" || entry.error) { errors += 1; failures.push({ event: "error", during: entry.during ?? name, error: String(entry.error ?? "").slice(0, 300) }); continue; }
    // The hook logs a multi-segment shell search as `search-compound`; it is a Bash event.
    const kind = name === "stop-block" ? "stop" : name === "search-compound" ? "bash" : name;
    if (!perEvent[kind]) continue;
    const ids = Array.isArray(entry.ids) ? entry.ids : [];
    const chars = entry.chars ?? 0;
    events.push({ event: name, ms: entry.ms ?? 0, ids, chars, note: entry.note ?? null, at: entry.at ?? null });
    hookMs += entry.ms ?? 0;
    injectedChars += chars;
    const bucket = perEvent[kind];
    bucket.count += 1; bucket.ms += entry.ms ?? 0; bucket.chars += chars;
    if (ids.length || (name === "stop-block")) bucket.injected += 1;
    bucket.ids.push(...ids);
    if (BUDGET_NOTES.has(entry.note)) budgetHit = true;
    if (kind === "prompt" && entry.note) promptNotes[entry.note] = (promptNotes[entry.note] ?? 0) + 1;
    if (name === "stop-block") stopBlocks.push({ flagged: entry.flagged ?? [], eligible: entry.eligible ?? [], listed: uniq(String(entry.text ?? "").match(/\bmx_[A-Za-z0-9]+/g) ?? []), chars });
  }
  for (const bucket of Object.values(perEvent)) bucket.ids = uniq(bucket.ids);
  const stopEntries = entries.filter((entry) => entry.event === "stop" || entry.event === "stop-block");
  // A block the agent answered is followed by another Stop. One that is the session's last Stop never
  // reached the agent: a headless session ends when the agent gives its structured answer. A Stop that
  // only records flagged facts (`blocked: false`, the default since the review became opt-in) blocks nothing.
  const last = stopEntries.at(-1);
  const undelivered = last !== undefined && last.event === "stop-block" && last.blocked !== false ? 1 : 0;
  return {
    hookEvents: events.length, events, perEvent, hookMs, injectedChars, budgetHit, promptNotes,
    stopBlocks: { count: stopBlocks.length, undelivered, items: stopBlocks, ids: uniq(stopBlocks.flatMap((block) => block.listed)) },
    stopEligible: uniq(stopEntries.flatMap((entry) => (Array.isArray(entry.eligible) ? entry.eligible : []))),
    stopFlagged: uniq(stopEntries.flatMap((entry) => (Array.isArray(entry.flagged) ? entry.flagged : []))),
    settleLaunched: entries.some((entry) => entry.settleLaunched === true || entry.settle === "started" || entry.event === "settle-launched") || settles.length > 0 || failures.some((entry) => entry.event.startsWith("settle")),
    // Touched now and vouched for by nobody: what an in-session review would have listed.
    stopUnvouched: uniq(stopEntries.flatMap((entry) => (Array.isArray(entry.unvouched) ? entry.unvouched : entry.event === "stop-block" && Array.isArray(entry.flagged) ? entry.flagged : []))),
    settle: { count: settles.length, passes: settles, regrounded: settles.reduce((sum, pass) => sum + (pass.reground?.ok ?? 0), 0), regroundFailed: settles.reduce((sum, pass) => sum + (pass.reground?.failed ?? 0), 0) },
    failures, errors, malformedLines: malformed,
  };
}

export function settleTelemetry(hooks, wait) {
  const launched = Boolean(hooks?.settleLaunched || wait?.sawWorker);
  const outcome = wait?.timedOut ? "timed-out"
    : hooks?.failures.some((f) => f.event.startsWith("settle")) ? "failed"
    : hooks?.settle.count ? "completed" : launched ? "launched-no-outcome" : "not-launched";
  return { settleLaunched: launched, settleOutcome: outcome };
}

/** `mex context status --json` after settle: flagged and eligible entities. */
export function contextStatus({ cliBin, workspace, env }) {
  const result = runMex(cliBin, ["context", "status", "--json"], workspace, env);
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  const data = report?.data ?? {};
  const list = (value) => (Array.isArray(value) ? value : []);
  const flagged = list(data.flagged ?? data.entities?.filter?.((entry) => entry.state === "flagged"));
  const eligible = list(data.eligible ?? data.entities?.filter?.((entry) => entry.state === "eligible"));
  return { raw: result.stdout, ok: report?.ok === true, flagged: flagged.length, eligible: eligible.length, flaggedIds: flagged.map((entry) => entry.id ?? entry.entityId).filter(Boolean), eligibleIds: eligible.map((entry) => entry.id ?? entry.entityId).filter(Boolean) };
}

/** Which of the blind alias ids exist in a context index, and how many entities carry aliases. */
export function aliasCoverage(indexPath, aliasIds) {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const ids = new Set(index.entities.map((entity) => entity.id));
  const present = aliasIds.filter((id) => ids.has(id));
  const facts = index.entities.filter((entity) => entity.type === "fact");
  return {
    entities: index.entities.length, facts: facts.length,
    entitiesWithAliases: index.entities.filter((entity) => entity.aliases?.length).length,
    factsWithAliases: facts.filter((entity) => entity.aliases?.length).length,
    aliasIds: aliasIds.length, present: present.length, missing: aliasIds.filter((id) => !ids.has(id)),
  };
}
