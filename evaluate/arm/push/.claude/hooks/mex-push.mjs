#!/usr/bin/env node
// MEX push prototype v2 (eval only): delivers curated knowledge to the agent
// through Claude Code hooks instead of asking the agent to go and find it.
//   index  — build .mex/local/push-index.json (entities, prose, code locations, health)
//   prompt — UserPromptSubmit: the few entries that match the task
//   read   — PostToolUse(Read): facts linked to the file just opened
//   edit   — PostToolUse(Edit|Write): entries describing the code just changed, with
//            the exact line of their prose so they can be fixed without searching
//   stop   — Stop: find entries whose linked code the diff touches (no graph work),
//            ask once about unseen ones, then hand re-recording to `settle`
//   settle — detached worker: one graph refresh, re-record drifted entries, rebuild
//            the index; the session never waits for it
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : process.cwd();
const MEX = join(ROOT, ".mex");
const LOCAL = join(MEX, "local");
const INDEX = join(LOCAL, "push-index.json");
const STATE = join(LOCAL, "push-state.json");
// The settle worker holds LOCK while it runs; a stop during that run leaves AGAIN.
const LOCK = join(LOCAL, "push-settle.lock");
const AGAIN = join(LOCAL, "push-settle.again");
const BUDGET = { prompt: 1200, read: 1000, edit: 1400 };
const MAX_ENTRIES = { prompt: 3, read: 4, edit: 8 };

const started = Date.now();
const norm = (p) => p.replace(/\\/g, "/");
const oneLine = (text) => text.replace(/\[([^\]]*)\]\(mex:\/\/[^)]*\)/g, "$1").replace(/\s+/g, " ").trim();

function log(event, data) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ms: Date.now() - started, ...data });
  const target = process.env.MEX_PUSH_LOG || join(LOCAL, "push-log.jsonl");
  try { appendFileSync(target, `${line}\n`); } catch { /* logging never breaks the session */ }
}

// The `mex` on PATH is an npm shim (mex.cmd on Windows); run its entry point
// with this Node so arguments need no shell quoting.
function mexEntry() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const entry = join(dir, "..", "mex-agent", "dist", "cli.js");
    if (dir && existsSync(join(dir, process.platform === "win32" ? "mex.cmd" : "mex")) && existsSync(entry)) return entry;
  }
  return null;
}

function mex(args) {
  const entry = mexEntry();
  if (!entry) return { code: 127, stdout: "", stderr: "mex is not on PATH" };
  let result;
  // A console-less (detached) process on Windows sometimes fails to start a child
  // with STATUS_DLL_INIT_FAILED (0xC0000142); that child never ran, so retry it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (result.status !== 0xC0000142) break;
  }
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Read-only lookups in the disposable graph index: where a node is, and the
// hash of its current body (the same value a grounding records as bodyHash).
async function graphNodes(ids) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(MEX, "graph.db"), { readOnly: true });
  try {
    const get = db.prepare("SELECT id, name, file_path, start_line, end_line, body_hash FROM nodes WHERE id = ?");
    return Object.fromEntries(ids.map((id) => [id, get.get(id) ?? null]));
  } finally { db.close(); }
}

// ---------- index ----------

function groundings(meta) {
  const out = [];
  let inside = false, indent = -1, current = null;
  for (const line of meta.split(/\r?\n/)) {
    const key = line.match(/^(\s*)grounds_to:\s*$/);
    if (key) { inside = true; indent = key[1].length; continue; }
    if (!inside) continue;
    const lead = line.match(/^(\s*)/)[1].length;
    if (line.trim() && lead <= indent && !line.trim().startsWith("-")) { inside = false; continue; }
    const file = line.match(/^\s*-\s*file:\s*(\S+)/);
    if (file) { current = { file: norm(file[1].replace(/^["']|["']$/g, "")) }; out.push(current); continue; }
    const field = line.match(/^\s*(node|bodyHash):\s*(\S+)/);
    if (field && current) current[field[1]] = field[2];
  }
  return out;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "local" || entry.name === "events") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

function parseFile(path) {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const file = norm(relative(MEX, path));
  const entities = [];
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (front) {
    const mexSection = front[1].match(/^mex:\n((?:[ \t]+.*\n?|\n)*)/m)?.[1] ?? "";
    const id = mexSection.match(/^\s{2}id:\s*(\S+)/m)?.[1];
    if (id) {
      entities.push({
        id, file, level: 0, line: 1,
        type: mexSection.match(/^\s{2}type:\s*(\S+)/m)?.[1] ?? "doc",
        title: (mexSection.match(/^\s{2}title:\s*(.+)$/m)?.[1] ?? file).trim(),
        body: oneLine(front[1].match(/^description:\s*(.+)$/m)?.[1] ?? ""),
        grounds: groundings(mexSection),
      });
    }
  }
  const blocks = [...text.matchAll(/<!-- mex:entity\n([\s\S]*?)\n-->/g)];
  blocks.forEach((block, i) => {
    const meta = block[1];
    const id = meta.match(/^id:\s*(\S+)/m)?.[1];
    if (!id) return;
    const start = block.index + block[0].length;
    const after = text.slice(start, i + 1 < blocks.length ? blocks[i + 1].index : text.length);
    const heading = after.match(/^(#{1,6})\s+(.+)$/m);
    let body = after, bodyAt = start;
    if (heading) {
      body = after.slice(heading.index + heading[0].length);
      bodyAt = start + heading.index;
      const next = body.match(new RegExp(`^#{1,${heading[1].length}}\\s`, "m"));
      if (next) body = body.slice(0, next.index);
    }
    entities.push({
      id, file, level: heading ? heading[1].length : 9, line: lineAt(text, bodyAt),
      type: meta.match(/^type:\s*(\S+)/m)?.[1] ?? "section",
      title: oneLine(heading?.[2] ?? id),
      body: oneLine(body).slice(0, 1500),
      grounds: groundings(meta),
    });
  });
  return entities;
}

async function buildIndex() {
  const entities = walk(MEX).flatMap(parseFile);
  // Diff hunks are base-side (HEAD) lines, so keep the session-start locations across rebuilds.
  const before = Object.fromEntries((loadIndex() ?? []).map((e) => [e.id, e.baseLocs ?? e.locs]));
  const nodes = await graphNodes([...new Set(entities.flatMap((e) => e.grounds.map((g) => g.node).filter(Boolean)))]);
  for (const e of entities) {
    e.code = [...new Set(e.grounds.map((g) => g.file))];
    e.locs = e.grounds.map((g) => nodes[g.node]).filter(Boolean)
      .map((n) => ({ file: n.file_path, name: n.name, start: n.start_line, end: n.end_line }));
    e.baseLocs = before[e.id] ?? e.locs;
    const drift = e.grounds.filter((g) => g.node && (!nodes[g.node] || (g.bodyHash && nodes[g.node].body_hash !== g.bodyHash)));
    e.health = !e.grounds.length ? null : drift.length ? (drift.some((g) => !nodes[g.node]) ? "missing" : "changed") : "fresh";
  }
  mkdirSync(LOCAL, { recursive: true });
  writeFileSync(INDEX, JSON.stringify({ builtAt: new Date().toISOString(), entities }));
  const counts = { entities: entities.length, linked: entities.filter((e) => e.code.length).length, notFresh: entities.filter((e) => e.health && e.health !== "fresh").length };
  log("index", counts);
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

// ---------- retrieval and formatting ----------

const STOP = new Set("the a an and or of to in on for with from by is are was were be been how what why when which who does do did this that these those it its into via as at than then there their they you your not no can will would should could about after before over under between only also just more most some any each every one two all get got make made use used using hono".split(" "));
const stem = (w) => {
  for (const suffix of ["ing", "ed", "es", "s"]) if (w.length > suffix.length + 3 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
  return w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w;
};
const tokens = (text) => text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);

function rank(entities, query) {
  const q = [...new Set(tokens(query))];
  const docs = entities.map((e) => {
    const terms = [...tokens(e.title), ...tokens(e.title), ...tokens(e.title), ...tokens(e.body), ...e.code.flatMap((f) => tokens(f))];
    const tf = {};
    for (const t of terms) tf[t] = (tf[t] ?? 0) + 1;
    return { e, tf, len: terms.length };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  const df = Object.fromEntries(q.map((t) => [t, docs.filter((d) => d.tf[t]).length]));
  return docs.map((d) => {
    let score = 0;
    for (const t of q) {
      if (!d.tf[t]) continue;
      const idf = Math.log(1 + (docs.length - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * (d.tf[t] * 2.2) / (d.tf[t] + 1.2 * (0.25 + 0.75 * d.len / avg));
    }
    return { e: d.e, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
}

function label(e) {
  if (!e.health) return e.type;
  return e.health === "fresh" ? `${e.type} ✓` : `${e.type} ⚠ ${e.health}: code changed since this was written, verify`;
}

const where = (e) => e.locs.length
  ? ` → ${e.locs.slice(0, 3).map((l) => `${l.file}:${l.start}-${l.end} ${l.name}`).join("; ")}`
  : e.code.length ? ` → ${e.code.slice(0, 2).join(", ")}` : "";

function line(e, bodyMax, { source = false } = {}) {
  const t = e.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  const bodyStarts = e.body.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(t);
  const body = e.body.length > bodyMax ? `${e.body.slice(0, bodyMax).replace(/\s\S*$/, "")} …` : e.body;
  const text = bodyStarts && body ? body : body ? `${e.title} — ${body}` : e.title;
  const src = source || !e.code.length ? ` (.mex/${e.file}:${e.line})` : "";
  return `- [${label(e)}] ${text}${where(e)}${src}`;
}

function pack(entries, budget, max, bodyMax, options) {
  const out = [];
  let used = 0;
  for (const e of entries) {
    if (out.length >= max) break;
    const l = line(e, e.type === "fact" ? bodyMax : Math.min(bodyMax, 200), options);
    if (used + l.length > budget && out.length) continue;
    out.push({ e, l });
    used += l.length + 1;
  }
  return out;
}

const loadIndex = () => existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")).entities : null;
const blankState = (session) => ({ session, shown: [], editShown: [], bashSeen: [], stopBlocked: false });
const loadState = (session) => {
  try { const all = JSON.parse(readFileSync(STATE, "utf8")); return all.session === session ? all : blankState(session); } catch { return blankState(session); }
};
const saveState = (state) => { mkdirSync(LOCAL, { recursive: true }); writeFileSync(STATE, JSON.stringify(state)); };
const emit = (event, context) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
// File-level overviews are whole documents; they are too broad to inject.
const sections = (entities) => entities.filter((e) => e.level > 0);

// ---------- hooks ----------

function onPrompt(input, entities) {
  // Background-task completions arrive as prompts; they are not a new task.
  if (/^\s*<task-notification>/.test(input.prompt ?? "")) return log("prompt", { injected: 0, skipped: "task-notification" });
  const state = loadState(input.session_id);
  const ranked = rank(sections(entities).filter((e) => !state.shown.includes(e.id)), input.prompt ?? "");
  if (!ranked.length) return log("prompt", { injected: 0 });
  const top = ranked[0].score;
  const keep = ranked.filter((r) => r.score >= Math.max(3, top * 0.7)).map((r) => r.e);
  const packed = pack(keep, BUDGET.prompt, MAX_ENTRIES.prompt, 260);
  if (!packed.length) return log("prompt", { injected: 0, top });
  const text = `MEX knowledge for this task (✓ = its code is unchanged since written). Start from these locations:\n${packed.map((p) => p.l).join("\n")}`;
  state.shown.push(...packed.map((p) => p.e.id));
  saveState(state);
  log("prompt", { injected: packed.length, chars: text.length, ids: packed.map((p) => p.e.id), scores: ranked.slice(0, 8).map((r) => [r.e.id, +r.score.toFixed(2)]), text });
  emit("UserPromptSubmit", text);
}

const linkedTo = (entities, file) => entities.filter((e) => e.code.includes(file));

function onRead(input, entities) {
  const path = input.tool_input?.file_path;
  if (!path) return;
  const file = norm(relative(ROOT, resolve(ROOT, path)));
  if (file.startsWith(".mex/") || file.startsWith("..")) return;
  const state = loadState(input.session_id);
  // Facts only: precise, independently checkable claims about this file's code.
  // A partial read (offset/limit) of a large file gets only the facts whose
  // linked functions lie in the lines read.
  const from = Number(input.tool_input?.offset) || 0;
  const to = from ? from + (Number(input.tool_input?.limit) || 2000) - 1 : Infinity;
  const inRange = (e) => !from || e.locs.some((l) => l.file === file && l.start <= to && l.end >= from);
  const fresh = linkedTo(entities, file).filter((e) => e.type === "fact" && !state.shown.includes(e.id) && inRange(e));
  if (!fresh.length) return log("read", { file, injected: 0 });
  const packed = pack(fresh, BUDGET.read, MAX_ENTRIES.read, 200, { source: true });
  const text = `MEX facts about ${file}:\n${packed.map((p) => p.l).join("\n")}`;
  state.shown.push(...packed.map((p) => p.e.id));
  saveState(state);
  log("read", { file, injected: packed.length, chars: text.length, ids: packed.map((p) => p.e.id), text });
  emit("PostToolUse", text);
}

function onEdit(input, entities) {
  const path = input.tool_input?.file_path;
  if (!path) return;
  const file = norm(relative(ROOT, resolve(ROOT, path)));
  if (file.startsWith(".mex/") || file.startsWith("..")) return;
  notifyChanged([file], loadState(input.session_id), entities, "edit");
}

// Edits made through Bash (sed, scripts) bypass the Edit hook: after each Bash
// call, notice source files that changed since the last check.
function onBash(input, entities) {
  const state = loadState(input.session_id);
  state.bashSeen ??= [];
  const fresh = changedFiles().filter((f) => !state.bashSeen.includes(f));
  if (!fresh.length) return;
  state.bashSeen.push(...fresh);
  notifyChanged(fresh, state, entities, "bash");
}

// An entry is touched when a diff hunk overlaps one of its linked functions, or
// when it links the file without a function location.
function touchedEntries(entities, files) {
  const ranges = touchedRanges(files);
  return entities.filter((e) => e.code.some((f) => files.includes(f)) && (
    e.baseLocs.some((l) => (ranges[l.file] ?? []).some(([a, b]) => a <= l.end && b >= l.start))
    || e.grounds.some((g) => files.includes(g.file) && !e.baseLocs.some((l) => l.file === g.file))));
}

function notifyChanged(files, state, entities, event) {
  const file = files.join(", ");
  const linked = touchedEntries(entities, files).filter((e) => !state.editShown.includes(e.id));
  if (!linked.length) { saveState(state); return log(event, { file, injected: 0 }); }
  const packed = pack(sections(linked), BUDGET.edit, MAX_ENTRIES.edit, 200, { source: true });
  const overviews = linked.filter((e) => e.level === 0);
  const text = `You changed ${file}. MEX entries that describe this code:\n${packed.map((p) => p.l).join("\n")}${overviews.length ? `\nAlso linked overviews: ${overviews.map((e) => `.mex/${e.file}`).join(", ")}.` : ""}\nIf your change makes an entry false, read a few lines at its .mex line (offset/limit) and rewrite just that prose. Never touch <!-- mex:entity --> blocks or fingerprints: MEX re-records code links when you finish.`;
  // Only what was actually listed counts as seen; the rest can still surface at stop.
  const listed = [...packed.map((p) => p.e.id), ...overviews.map((e) => e.id)];
  state.editShown.push(...listed);
  state.shown.push(...listed);
  saveState(state);
  log(event, { file, injected: packed.length + overviews.length, chars: text.length, ids: linked.map((e) => e.id), text });
  emit("PostToolUse", text);
}

function git(args) {
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (result.status !== 0xC0000142) break;
  }
  return result.stdout ?? "";
}

function changedFiles() {
  const files = [...git(["diff", "--name-only", "HEAD"]).split("\n"), ...git(["ls-files", "--others", "--exclude-standard"]).split("\n")];
  return [...new Set(files.map((f) => norm(f.trim())).filter((f) => f && !f.startsWith(".mex/")))];
}

/** Base-side line ranges each file's diff touches (`@@ -a,b` hunks). */
function touchedRanges(files) {
  const ranges = {};
  let current = null;
  for (const l of git(["diff", "-U0", "HEAD", "--", ...files]).split("\n")) {
    const header = l.match(/^\+\+\+ b\/(.+)$/) ?? l.match(/^--- a\/(.+)$/);
    if (header) { current = norm(header[1]); ranges[current] ??= []; continue; }
    const hunk = l.match(/^@@ -(\d+)(?:,(\d+))? /);
    if (hunk && current) {
      const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      ranges[current].push([start, start + Math.max(count, 1) - 1]);
    }
  }
  return ranges;
}

// The stop hook does no graph work: the diff alone says which entries' code was
// touched. Re-recording their links needs a graph refresh (100 s on a large
// repo), so a detached `settle` worker does it after the agent is done.
async function onStop(input, entities) {
  const state = loadState(input.session_id);
  const changed = changedFiles();
  const hit = touchedEntries(entities, changed).filter((e) => e.baseLocs.length);
  if (!hit.length) return log("stop", { changed: changed.length, touched: 0 });
  const unseen = hit.filter((e) => !state.editShown.includes(e.id));
  if (unseen.length && !state.stopBlocked && !input.stop_hook_active) {
    state.stopBlocked = true;
    state.editShown.push(...unseen.map((e) => e.id));
    saveState(state);
    const reason = `Before finishing: your change touched code that these MEX entries describe:\n${unseen.map((e) => line(e, 200, { source: true })).join("\n")}\nIf your change makes one false, read a few lines at its .mex line and rewrite just that prose (leave <!-- mex:entity --> blocks alone). If they still hold, change nothing. Then finish with your final answer again. MEX re-records the code links itself.`;
    log("stop-block", { touched: hit.map((e) => e.id), unseen: unseen.map((e) => e.id), chars: reason.length, text: reason });
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    return;
  }
  // A later stop with the same code diff (e.g. after a background task) has nothing new to settle.
  const signature = createHash("sha1").update(git(["diff", "HEAD", "--", ...new Set(hit.flatMap((e) => e.code))])).digest("hex");
  if (state.settled === signature) return log("stop", { changed: changed.length, touched: hit.length, settle: "unchanged" });
  state.settled = signature;
  saveState(state);
  log("stop", { changed: changed.length, touched: hit.length, settle: startSettle() });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function startSettle() {
  mkdirSync(LOCAL, { recursive: true });
  if (existsSync(LOCK) && alive(Number(readFileSync(LOCK, "utf8")))) { writeFileSync(AGAIN, ""); return "queued"; }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "settle"], { cwd: ROOT, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
  writeFileSync(LOCK, String(child.pid));
  child.unref();
  return "started";
}

async function settle() {
  writeFileSync(LOCK, String(process.pid));
  try {
    do {
      rmSync(AGAIN, { force: true });
      const entities = loadIndex();
      const hit = touchedEntries(entities, changedFiles()).filter((e) => e.baseLocs.length);
      const t0 = Date.now();
      const refresh = mex(["graph", "refresh"]);
      const refreshMs = Date.now() - t0;
      const nodes = await graphNodes([...new Set(hit.flatMap((e) => e.grounds.map((g) => g.node).filter(Boolean)))]);
      const drifted = hit.filter((e) => e.grounds.some((g) => g.node && (!nodes[g.node] || (g.bodyHash && nodes[g.node].body_hash !== g.bodyHash))));
      const results = drifted.map((e) => {
        const r = mex(["wiki", "reground", e.id, "--apply", "--reason", "agent reviewed the entry after changing its code (push prototype)"]);
        return { id: e.id, code: r.code, out: (r.stdout + r.stderr).slice(0, 300) };
      });
      // The index must describe the re-recorded links, or the next stop sees them as drifted again.
      if (results.length) await buildIndex();
      log("settle", { touched: hit.length, refresh: refresh.code, refreshMs, ...(refresh.code ? { refreshErr: (refresh.stderr || refresh.stdout).slice(-1500) } : {}), drifted: drifted.length, ok: results.filter((r) => r.code === 0).length, results });
    } while (existsSync(AGAIN));
  } finally {
    rmSync(LOCK, { force: true });
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "index") return buildIndex();
  if (mode === "settle") return settle();
  const raw = readFileSync(0, "utf8");
  const input = raw ? JSON.parse(raw) : {};
  const entities = loadIndex();
  if (!entities) return log(mode, { error: "no push index" });
  if (mode === "prompt") return onPrompt(input, entities);
  if (mode === "read") return onRead(input, entities);
  if (mode === "edit") return onEdit(input, entities);
  if (mode === "bash") return onBash(input, entities);
  if (mode === "stop") return onStop(input, entities);
}

process.removeAllListeners("warning");
main().catch((error) => { log("error", { mode: process.argv[2], error: String(error?.stack ?? error).slice(0, 2000) }); if (process.argv[2] === "index") process.exitCode = 1; });
