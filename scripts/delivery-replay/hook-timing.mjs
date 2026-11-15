// Paired cold-process hook timing: a base build against the current one (not a shipped feature).
//
//   node scripts/delivery-replay/hook-timing.mjs --base <mex-hook> --current <mex-hook> --cli <base dist/cli.js>
//        --work <dir> [--entries 50,500] [--pairs 200] [--output timing.json]
//
// For each corpus size, one fixture home is made with the base CLI (so both builds read the same
// record version) and copied, so each build has its own identical home. Each pair runs the two
// builds back to back on the same event, alternating which goes first. Events: a typed prompt that
// sends nothing, one that delivers, a non-commit shell post-tool event, and a session start.
// Reported: per build p50/p95, and p50/p95 of the paired difference (current - base), in ms.
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { arg } from "./evaluate.mjs";

const base = resolve(arg("--base")), current = resolve(arg("--current")), cli = resolve(arg("--cli"));
const work = resolve(arg("--work")), pairs = Number(arg("--pairs", "200"));
const sizes = String(arg("--entries", "50,500")).split(",").map(Number);
const words = ["cache", "router", "webhook", "billing", "session", "token", "queue", "schema", "logger", "upload", "retry", "metrics", "locale", "invoice", "tenant", "export"];
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const round = x => Math.round(x * 100) / 100;

function fixture(n) {
  const root = join(work, `timing-${n}-${Date.now()}`), repo = join(root, "repo"), home = join(root, "home-base");
  mkdirSync(repo, { recursive: true });
  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Timing"); git("config", "user.email", "timing@example.test");
  git("commit", "-q", "--allow-empty", "-m", "Initial");
  const env = { ...process.env, MEX_HOME: home, MEX_TELEMETRY: "0", MEX_BACKGROUND: "0" };
  const saved = spawnSync(process.execPath, [cli, "note", "Seed note so the project is registered."], { cwd: repo, env, encoding: "utf8" });
  if (saved.status !== 0) throw Error(`base CLI note failed: ${saved.stderr}`);
  const project = readdirSync(join(home, ".mex", "projects")).find(d => /^[gf]-[a-f0-9]{24}$/u.test(d));
  const notes = join(home, ".mex", "projects", project, "notes");
  for (let i = 0; i < n - 1; i++) {
    const a = words[i % words.length], b = words[(i * 7 + 3) % words.length];
    const id = `mx_t${String(i).padStart(6, "0")}`;
    const line = `The ${a} module ${i} wraps ${b} calls through one helper, because direct calls skip the audit.`;
    writeFileSync(join(notes, `${id}.md`), `---\nmex:\n  id: ${id}\n  kind: rule\n  scope:\n    - "**"\n  source:\n    type: person\n    ref: timing\n    quote: "${line}"\n  evidence: person\n  one_line: "${line}"\n  checks: []\n  status: active\n  created: 2026-11-15\n---\n${line}\n`);
  }
  const copy = join(root, "home-current");
  cpSync(home, copy, { recursive: true });
  return { repo, homes: { base: home, current: copy } };
}

function call(binary, home, repo, native, payload) {
  const env = { ...process.env, MEX_HOME: home, MEX_TELEMETRY: "0", MEX_BACKGROUND: "0" };
  const t = performance.now();
  const r = spawnSync(binary, ["claude-code", native], { input: JSON.stringify({ cwd: repo, ...payload }), env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  const ms = performance.now() - t;
  if (r.status !== 0) throw Error(`${native} exited ${r.status}: ${r.stderr}`);
  return { ms, out: r.stdout };
}

const report = {};
for (const n of sizes) {
  const { repo, homes } = fixture(n);
  const events = {
    "prompt, sends nothing": i => ["UserPromptSubmit", { session_id: `t-${i}`, prompt: "please give this variable a clearer name" }],
    "prompt, delivers": i => ["UserPromptSubmit", { session_id: `t-${i}`, prompt: "how does the webhook module 2 wrap billing calls" }],
    "shell post-tool": i => ["PostToolUse", { session_id: `t-${i}`, tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ok", exit_code: 0 } }],
    "session start": i => ["SessionStart", { session_id: `t-${i}`, source: "startup" }],
  };
  report[n] = {};
  for (const [name, make] of Object.entries(events)) {
    for (let w = 0; w < 5; w++) for (const b of ["base", "current"]) call(b === "base" ? base : current, homes[b], repo, ...make(`warm-${name}-${w}`));
    const times = { base: [], current: [] }, diff = [];
    let delivered = { base: 0, current: 0 };
    for (let i = 0; i < pairs; i++) {
      const order = i % 2 ? ["base", "current"] : ["current", "base"];
      const pair = {};
      for (const b of order) {
        const r = call(b === "base" ? base : current, homes[b], repo, ...make(`${name}-${i}`));
        pair[b] = r.ms; times[b].push(r.ms);
        if (r.out.includes("additionalContext")) delivered[b]++;
      }
      diff.push(pair.current - pair.base);
    }
    report[n][name] = {
      base: { p50: round(q(times.base, .5)), p95: round(q(times.base, .95)) },
      current: { p50: round(q(times.current, .5)), p95: round(q(times.current, .95)) },
      added: { p50: round(q(diff, .5)), p95: round(q(diff, .95)) }, delivered,
    };
    console.log(n, name, JSON.stringify(report[n][name]));
  }
}
const output = arg("--output");
if (output) writeFileSync(resolve(output), `${JSON.stringify({ pairs, report }, null, 2)}\n`);
