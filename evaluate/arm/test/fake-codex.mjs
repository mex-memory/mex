#!/usr/bin/env node
// Replays the measured host protocol; never invokes a model.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("fake-codex/probe-0.163.0"); process.exit(0); }
assert.equal(argv[0], "exec");
const value = (key) => argv[argv.indexOf(key) + 1];
const workspace = resolve(value("-C")), home = process.env.CODEX_HOME;
assert.equal(process.cwd(), workspace);
assert.ok(home && existsSync(join(home, "config.toml")));
assert.ok(!existsSync(join(home, "AGENTS.md")));
const config = readFileSync(join(home, "config.toml"), "utf8");
for (const feature of ["memories", "plugins", "apps", "browser_use", "multi_agent", "goals", "skill_search"]) assert.ok(config.includes(`${feature} = false`));
assert.ok(config.includes('web_search = "disabled"'));
const schema = JSON.parse(readFileSync(value("--output-schema"), "utf8"));
let prompt = ""; for await (const data of process.stdin) prompt += data;
assert.ok(prompt.length);
if (process.env.FAKE_CODEX_OBSERVE) writeFileSync(process.env.FAKE_CODEX_OBSERVE, JSON.stringify({ argv, workspace, home, config, homeFiles: (await import('node:fs')).readdirSync(home), authPresent: existsSync(join(home, "auth.json")), prompt }));
const change = Object.hasOwn(schema.properties, "summary");
const result = change ? { summary: "Applied the requested fixture change and ran its targeted verification.", filesChanged: [], testsRun: "Targeted checks delegated to the hidden grader." }
  : { answer: "The fixture follows the repository boundary and preserves the expected source behavior.", symbols: ["fixture"], evidence: [{ path: "README.md", line: 1 }], complete: true };
if (process.env.FAKE_CODEX_FIXES && change) {
  const fixes = JSON.parse(readFileSync(process.env.FAKE_CODEX_FIXES, "utf8"));
  for (const fix of fixes.filter((f) => prompt.includes(f.match))) for (const [path, content] of Object.entries(fix.files)) {
    const target = resolve(workspace, path); assert.ok(target.startsWith(`${workspace}${process.platform === 'win32' ? '\\' : '/'}`));
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); result.filesChanged.push(path);
  }
}
const hooksFile = join(workspace, ".codex", "hooks.json");
if (existsSync(hooksFile)) {
  assert.ok(argv.includes("--dangerously-bypass-hook-trust"));
  const config = JSON.parse(readFileSync(hooksFile, "utf8"));
  for (const record of readFileSync(new URL("probe/hook-log.jsonl", import.meta.url), "utf8").trim().split(/\r?\n/).map(JSON.parse)) {
    const payload = { ...JSON.parse(record.stdin), cwd: workspace, transcript_path: join(home, "sessions", "rollout.jsonl") };
    if (payload.prompt) payload.prompt = prompt;
    for (const group of config.hooks?.[record.event] ?? []) {
      if (group.matcher && !new RegExp(group.matcher).test(payload.tool_name ?? "")) continue;
      for (const hook of group.hooks ?? []) {
        const tokens = [...hook.command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
        const r = spawnSync(tokens[0], tokens.slice(1), { cwd: workspace, input: JSON.stringify(payload), env: process.env, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
      }
    }
  }
} else assert.ok(!argv.includes("--dangerously-bypass-hook-trust"));
const lines = readFileSync(new URL("probe/exec.jsonl", import.meta.url), "utf8").trim().split(/\r?\n/).map(JSON.parse);
for (const e of lines) {
  if (e.item?.changes) for (const c of e.item.changes) c.path = join(workspace, "math.js");
  if (e.item?.type === "agent_message" && e.item.id === "item_6") e.item.text = JSON.stringify(result);
}
if (process.env.FAKE_CODEX_HISTORY_PROBE) lines.splice(-1, 0, { type: "item.completed", item: { id: "history-probe", type: "command_execution", command: "git log --all", aggregated_output: "", exit_code: 0 } });
mkdirSync(join(home, "sessions"), { recursive: true }); writeFileSync(join(home, "sessions", "rollout.jsonl"), lines.map(JSON.stringify).join("\n"));
writeFileSync(value("-o"), process.env.FAKE_CODEX_INVALID ? '{"summary":"bad"}' : JSON.stringify(result));
for (const e of lines) {
  if (process.env.FAKE_CODEX_NO_TURN && e.type === "turn.completed") continue;
  if (!process.stdout.write(`${JSON.stringify(e)}\n`)) await once(process.stdout, "drain");
}
process.exitCode = Number(process.env.FAKE_CODEX_EXIT ?? 0);
