#!/usr/bin/env node
// MEX push prototype (eval only): delivers curated knowledge to the agent
// through Claude Code hooks instead of asking the agent to go and find it.
//   index  — build .mex/local/push-index.json (entities, prose, code links, health)
//   prompt — UserPromptSubmit: the few entries that match the task
//   read   — PostToolUse(Read): entries linked to the file just opened
//   edit   — PostToolUse(Edit|Write): entries describing the code just changed
//   stop   — Stop: re-record code links of entries whose code the agent changed
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";

const ROOT = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : process.cwd();
const MEX = join(ROOT, ".mex");
const LOCAL = join(MEX, "local");
const INDEX = join(LOCAL, "push-index.json");
const STATE = join(LOCAL, "push-state.json");
const BUDGET = { prompt: 2400, read: 1600, edit: 1600 };
const MAX_ENTRIES = { prompt: 5, read: 5, edit: 8 };

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
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Live drift per entity from `mex check`; the Wiki index's health is only as
// fresh as its last rebuild.
function driftFromCheck() {
  const check = mex(["check", "--json"]);
  const drift = {};
  try {
    for (const issue of JSON.parse(check.stdout).issues ?? []) {
      if (!String(issue.code).startsWith("GROUNDING_")) continue;
      const id = String(issue.message).match(/entity: (mx_[0-9A-Z]+)/)?.[1];
      if (id && !drift[id]) drift[id] = issue.code.replace("GROUNDING_", "").toLowerCase();
    }
  } catch { return null; }
  return drift;
}

// ---------- index ----------

function groundedFiles(meta) {
  const files = [];
  let inside = false, indent = -1;
  for (const line of meta.split(/\r?\n/)) {
    const key = line.match(/^(\s*)grounds_to:\s*$/);
    if (key) { inside = true; indent = key[1].length; continue; }
    if (!inside) continue;
    const lead = line.match(/^(\s*)/)[1].length;
    if (line.trim() && lead <= indent && !line.trim().startsWith("-")) { inside = false; continue; }
    const file = line.match(/^\s*-?\s*file:\s*(\S+)/);
    if (file) files.push(norm(file[1].replace(/^["']|["']$/g, "")));
  }
  return [...new Set(files)];
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
        id, file, level: 0,
        type: mexSection.match(/^\s{2}type:\s*(\S+)/m)?.[1] ?? "doc",
        title: (mexSection.match(/^\s{2}title:\s*(.+)$/m)?.[1] ?? file).trim(),
        body: oneLine(front[1].match(/^description:\s*(.+)$/m)?.[1] ?? ""),
        code: groundedFiles(mexSection),
      });
    }
  }
  const blocks = [...text.matchAll(/<!-- mex:entity\n([\s\S]*?)\n-->/g)];
  blocks.forEach((block, i) => {
    const meta = block[1];
    const id = meta.match(/^id:\s*(\S+)/m)?.[1];
    if (!id) return;
    const after = text.slice(block.index + block[0].length, i + 1 < blocks.length ? blocks[i + 1].index : text.length);
    const heading = after.match(/^(#{1,6})\s+(.+)$/m);
    let body = after;
    if (heading) {
      body = after.slice(heading.index + heading[0].length);
      const next = body.match(new RegExp(`^#{1,${heading[1].length}}\\s`, "m"));
      if (next) body = body.slice(0, next.index);
    }
    entities.push({
      id, file, level: heading ? heading[1].length : 9,
      type: meta.match(/^type:\s*(\S+)/m)?.[1] ?? "section",
      title: oneLine(heading?.[2] ?? id),
      body: oneLine(body).slice(0, 1500),
      code: groundedFiles(meta),
    });
  });
  return entities;
}

function buildIndex() {
  const entities = walk(MEX).flatMap(parseFile);
  const listed = mex(["wiki", "list", "--limit", "500", "--json"]);
  const health = {};
  try {
    for (const entity of JSON.parse(listed.stdout).data.entities) health[entity.id] = entity.health ?? null;
  } catch { throw new Error(`mex wiki list failed: ${listed.stderr || listed.stdout}`); }
  const drift = driftFromCheck() ?? {};
  for (const entity of entities) entity.health = drift[entity.id] ? (drift[entity.id] === "drift" ? "changed" : drift[entity.id]) : entity.code.length ? (health[entity.id] ?? "fresh") : null;
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
  if (!e.code.length || !e.health) return e.type;
  return e.health === "fresh" ? `${e.type} · verified` : `${e.type} · ⚠ ${e.health}: its code changed after this was written — check the code before relying on it`;
}

function line(e, bodyMax) {
  const t = e.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  const bodyStarts = e.body.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(t);
  let body = e.body.length > bodyMax ? `${e.body.slice(0, bodyMax).replace(/\s\S*$/, "")} …` : e.body;
  const text = bodyStarts && body ? body : body ? `${e.title} — ${body}` : e.title;
  const code = e.code.length ? ` Code: ${e.code.slice(0, 4).join(", ")}.` : "";
  return `- [${label(e)}] ${text}${code} (.mex/${e.file})`;
}

function pack(entries, budget, max, bodyMax) {
  const out = [];
  let used = 0;
  for (const e of entries) {
    if (out.length >= max) break;
    const l = line(e, e.level === 0 ? 200 : e.type === "fact" ? bodyMax : Math.min(bodyMax, 220));
    if (used + l.length > budget && out.length) continue;
    out.push({ e, l });
    used += l.length + 1;
  }
  return out;
}

const loadIndex = () => existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")).entities : null;
const loadState = (session) => {
  try { const all = JSON.parse(readFileSync(STATE, "utf8")); return all.session === session ? all : { session, shown: [], editShown: [], stopBlocked: false }; } catch { return { session, shown: [], editShown: [], stopBlocked: false }; }
};
const saveState = (state) => { mkdirSync(LOCAL, { recursive: true }); writeFileSync(STATE, JSON.stringify(state)); };
const emit = (event, context) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));

// ---------- hooks ----------

function onPrompt(input, entities) {
  const state = loadState(input.session_id);
  const ranked = rank(entities, input.prompt ?? "");
  if (!ranked.length) return log("prompt", { injected: 0 });
  const top = ranked[0].score;
  const keep = ranked.filter((r) => r.score >= Math.max(2.5, top * 0.6)).map((r) => r.e);
  const packed = pack(keep, BUDGET.prompt, MAX_ENTRIES.prompt, 360);
  if (!packed.length) return log("prompt", { injected: 0, top });
  const text = `MEX knowledge matching this task (curated project notes; "verified" means the code it describes is unchanged since it was written). Use it to orient, then confirm details in the code:\n${packed.map((p) => p.l).join("\n")}`;
  state.shown.push(...packed.map((p) => p.e.id));
  saveState(state);
  log("prompt", { injected: packed.length, chars: text.length, ids: packed.map((p) => p.e.id), scores: ranked.slice(0, 8).map((r) => [r.e.id, +r.score.toFixed(2)]), text });
  emit("UserPromptSubmit", text);
}

function linkedTo(entities, file) {
  // Facts first: they are the precise, independently checkable claims.
  const order = { fact: 0 };
  return entities.filter((e) => e.code.includes(file)).sort((a, b) => (order[a.type] ?? 1) - (order[b.type] ?? 1) || a.level - b.level);
}

function onRead(input, entities) {
  const path = input.tool_input?.file_path;
  if (!path) return;
  const file = norm(relative(ROOT, resolve(ROOT, path)));
  if (file.startsWith(".mex/") || file.startsWith("..")) return;
  const state = loadState(input.session_id);
  const fresh = linkedTo(entities, file).filter((e) => !state.shown.includes(e.id));
  if (!fresh.length) return log("read", { file, injected: 0 });
  const packed = pack(fresh, BUDGET.read, MAX_ENTRIES.read, 300);
  const text = `MEX knowledge about ${file}:\n${packed.map((p) => p.l).join("\n")}`;
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
  const state = loadState(input.session_id);
  const linked = linkedTo(entities, file).filter((e) => !state.editShown.includes(e.id));
  if (!linked.length) return log("edit", { file, injected: 0 });
  const packed = pack(linked, BUDGET.edit, MAX_ENTRIES.edit, 220);
  const text = `You changed ${file}. These MEX entries describe that code:\n${packed.map((p) => p.l).join("\n")}\nIf your change makes one of them false, rewrite that entry's prose in its .mex file (only the text under its heading; leave the <!-- mex:entity --> block alone). Do not compute fingerprints or edit grounding metadata: MEX re-records the code links when you finish.`;
  state.editShown.push(...packed.map((p) => p.e.id));
  state.shown.push(...packed.map((p) => p.e.id));
  saveState(state);
  log("edit", { file, injected: packed.length, chars: text.length, ids: packed.map((p) => p.e.id), text });
  emit("PostToolUse", text);
}

function changedFiles() {
  const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout ?? "";
  const files = [...git(["diff", "--name-only", "HEAD"]).split("\n"), ...git(["ls-files", "--others", "--exclude-standard"]).split("\n")];
  return [...new Set(files.map((f) => norm(f.trim())).filter((f) => f && !f.startsWith(".mex/")))];
}

function onStop(input, entities) {
  const state = loadState(input.session_id);
  const changed = changedFiles();
  const affected = entities.filter((e) => e.code.some((f) => changed.includes(f)));
  if (!affected.length) return log("stop", { changed: changed.length, affected: 0 });
  const refresh = mex(["graph", "refresh"]);
  const drift = driftFromCheck();
  if (!drift) return log("stop", { error: "mex check failed", refresh: refresh.code });
  const drifted = affected.filter((e) => drift[e.id]);
  if (!drifted.length) return log("stop", { changed: changed.length, affected: affected.length, drifted: 0 });
  const unseen = drifted.filter((e) => !state.editShown.includes(e.id));
  if (unseen.length && !state.stopBlocked && !input.stop_hook_active) {
    state.stopBlocked = true;
    state.editShown.push(...unseen.map((e) => e.id));
    saveState(state);
    const reason = `Before finishing: your change touched code that these MEX entries describe:\n${unseen.map((e) => line(e, 220)).join("\n")}\nIf your change makes one of them false, rewrite that entry's prose in its .mex file (leave the <!-- mex:entity --> block alone). If they still hold, change nothing. Then finish with your final answer again. MEX re-records the code links itself.`;
    log("stop-block", { drifted: drifted.map((e) => e.id), unseen: unseen.map((e) => e.id), chars: reason.length, text: reason });
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    return;
  }
  const results = drifted.map((e) => {
    const r = mex(["wiki", "reground", e.id, "--apply", "--reason", "agent reviewed the entry after changing its code (push prototype)"]);
    return { id: e.id, code: r.code, out: (r.stdout + r.stderr).slice(0, 300) };
  });
  log("stop-reground", { drifted: drifted.length, ok: results.filter((r) => r.code === 0).length, results });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "index") return buildIndex();
  const raw = readFileSync(0, "utf8");
  const input = raw ? JSON.parse(raw) : {};
  const entities = loadIndex();
  if (!entities) return log(mode, { error: "no push index" });
  if (mode === "prompt") return onPrompt(input, entities);
  if (mode === "read") return onRead(input, entities);
  if (mode === "edit") return onEdit(input, entities);
  if (mode === "stop") return onStop(input, entities);
}

main().catch((error) => { log("error", { mode: process.argv[2], error: String(error?.stack ?? error).slice(0, 2000) }); if (process.argv[2] === "index") process.exitCode = 1; });
