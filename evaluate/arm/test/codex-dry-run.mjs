#!/usr/bin/env node
// Model-free, three-arm dry run on a new small subject clone, with real Graph maintenance.
import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../index.mjs";
import { git, resolveCommit } from "../lib/workspace.mjs";
import { clipRepository, verifyClippedHistory } from "../lib/history.mjs";
import { resourceGuard, resourceSnapshot, samplerSummary } from "../lib/resources.mjs";

const argv = process.argv.slice(2), arg = (name) => argv[argv.indexOf(name) + 1];
for (const name of ["--source", "--output"]) if (!argv.includes(name) || !arg(name)) throw new Error(`${name} required`);
const root = resolve(arg("--output")), source = resolve(arg("--source"));
if (existsSync(root)) throw new Error("dry-run output must be new");
mkdirSync(root, { recursive: true });
const work = join(root, "work"), output = join(root, "output"), subject = join(work, "subject"); mkdirSync(work);
const initial = await resourceGuard({ path: root, label: "dry-run preparation", minRamGB: 5, minDiskGB: 5 });
git(work, ["clone", "--no-local", source, subject]);
const base = resolveCommit(subject, "HEAD"), earlier = resolveCommit(subject, "HEAD~1");
assert.ok(existsSync(join(subject, ".mex/AGENTS.md")), "source needs a committed canonical scaffold");
writeFileSync(join(subject, "eval-fixture.cjs"), "module.exports=(a,b)=>a+b;\n");
writeFileSync(join(subject, "eval-hidden.cjs"), "const assert=require('node:assert/strict');const add=require('./eval-fixture.cjs');assert.equal(add(2,3),5);assert.equal(add(-3,3),0);console.log('Tests 2 passed (2)');\n");
git(subject, ["add", "eval-fixture.cjs", "eval-hidden.cjs"]); git(subject, ["commit", "-qm", "eval: hidden dry-run oracle"]); const merge = resolveCommit(subject, "HEAD");
const history = [];
for (const b of [earlier, base]) { const path = join(work, `clip-${b.slice(0, 8)}`); clipRepository(subject, path, b); history.push(verifyClippedHistory(path, b, [merge])); rmSync(path, { recursive: true, force: true }); }
const cliBin = join(work, "fixture-cli/node_modules/.bin"), dist = join(cliBin, "../mex-agent/dist"); mkdirSync(dist, { recursive: true }); mkdirSync(cliBin, { recursive: true });
copyFileSync(new URL("fake-cli.cjs", import.meta.url), join(dist, "cli.js"));
// Freeze the built CLI and its graph assets; dependencies are read through one link, never walked.
const harness = fileURLToPath(new URL("../../..", import.meta.url)), frozen = join(work, "frozen"); mkdirSync(frozen);
cpSync(join(harness, "dist"), join(frozen, "dist"), { recursive: true });
copyFileSync(join(harness, "package.json"), join(frozen, "package.json"));
symlinkSync(join(harness, "node_modules"), join(frozen, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const home = join(work, "source-home"); mkdirSync(home); writeFileSync(join(home, "auth.json"), '{"fixture":"dry-run-only"}');
const fixes = join(work, "fixes.json"); writeFileSync(fixes, JSON.stringify([{ match: "dry fixture", files: { "eval-fixture.cjs": "module.exports=(a,b)=>a+b;\n" } }]));
const suite = { id: "small-codex-dry-run", projectName: "project", agent: "codex", model: "gpt-6.1-sol", effort: "high", sandbox: "workspace-write", requiresDeps: false, mainRepetitions: 1, defaultArms: ["files", "mex-r2w", "mex-r3"], arms: { files: {}, "mex-r2w": { scaffold: true, hooks: true, lexical: true }, "mex-r3": { scaffold: true, hooks: true, semantic: true } }, scaffolds: { default: base }, tasks: [{ id: "dry-fixture", type: "change", base, scaffold: "default", mergeCommit: merge, prompt: "Implement the dry fixture addition function and verify positive and negative operands.", complexity: { repoSourceLoc: 1, goldFiles: 1, directories: 1, packages: 1, goldLinesChanged: 1, promptNamesGold: false }, gold: { code: [{ path: "eval-fixture.cjs" }] }, hiddenTests: { fromCommit: merge, files: ["eval-hidden.cjs"], command: ["{node}", "eval-hidden.cjs"] } }] };
const suiteFile = join(work, "suite.json"); writeFileSync(suiteFile, JSON.stringify(suite));
const saved = { ...process.env };
Object.assign(process.env, { CODEX_HOME: home, FAKE_CODEX_FIXES: fixes, FAKE_MEX_REAL_CLI: join(frozen, "dist/cli.js"), MEX_TELEMETRY_DISABLED: "1" });
try {
  const common = ["--suite", suiteFile, "--subject", subject, "--cli-bin", cliBin, "--output", output, "--fake-agent", fileURLToPath(new URL("fake-codex.mjs", import.meta.url)), "--min-ram-gb", "5", "--compare-base", base];
  // T0 seed is a full build at the same pinned base; the measured pipeline must use refresh.
  await main(["--prepare", ...common]);
  const prepared = JSON.parse(readFileSync(join(output, "prepare.json"), "utf8"));
  const seed = join(work, "seed.db"); copyFileSync(join(prepared.tasks["dry-fixture"].cachePath, "graph.db"), seed);
  const seedMap = join(work, "seeds.json"); writeFileSync(seedMap, JSON.stringify({ default: seed }));
  rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  common.push("--seed-graphs", seedMap);
  await main(["--pipeline", ...common]); await main(["--pipeline", "--resume", ...common]);
  const rows = readdirSync(join(output, "runs")).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(output, "runs", n))));
  assert.equal(rows.length, 3); assert.ok(rows.every((r) => r.valid && r.hiddenTests.ok), JSON.stringify(rows.map((r) => r.violations)));
  writeFileSync(join(output, "artifacts/history-two-bases.json"), JSON.stringify(history, null, 2));
  const samples = readdirSync(join(output, "artifacts")).filter((n) => n.endsWith(".resources.csv")).map((name) => ({ name, ...samplerSummary(join(output, "artifacts", name)) }));
  const summary = { rows: rows.length, valid: rows.filter((r) => r.valid).length, hiddenPasses: rows.map((r) => r.hiddenTests.passed), history, initial, final: resourceSnapshot(root), peakSampledRssBytes: Math.max(...samples.map((s) => s.peakRss ?? 0)), samples };
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  summary.final = resourceSnapshot(root);
  assert.deepEqual(readdirSync(root), ["output"]);
  for (const name of ["ws", "temp", "index-cache", "chain", "instruction-check"]) assert.equal(existsSync(join(output, name)), false);
  summary.cleaned = true; writeFileSync(join(output, "artifacts/dry-run-summary.json"), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
} finally { for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key]; Object.assign(process.env, saved); }
