// Category 3 — end-to-end eval driven by a REAL model (headless Claude Code).
//
// For each variant (minimal vs source) x natural-language task, it runs a real
// agent (`claude -p`) in the subject repo with variant-specific graph-usage
// instructions, then parses the stream-json transcript for: which tools the agent
// actually called (graph scope/get vs Read/Grep fallback), the final answer, cost,
// and turns. Correctness is rubric-graded on the answer.
//
// This is the run that settles the default --detail, because only a real model
// reveals Read/Grep fallback and genuine answer quality (the scripted driver in
// agent-e2e.mjs cannot).
//
// Flags: --root <dir>, --limit <n> (first n tasks), --model <name>
//
// Requires the `claude` CLI on PATH (Claude Code), authenticated. Each run costs
// real tokens.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { grade } from "./lib/grade.mjs";
import { REPO_ROOT } from "./lib/run-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const VARIANT_INSTRUCTIONS = {
  minimal:
    'Use the mex code graph CLI from the repo root. Run `node dist/cli.js graph scope "<question>"` — it returns a compact JSONL manifest (facts with node ids, no source). Expand the specific node ids you need with `node dist/cli.js graph get <id> --detail source`.',
  source:
    'Use the mex code graph CLI from the repo root. Run `node dist/cli.js graph scope "<question>" --detail source` — it returns facts with source grouped inline, so you usually need no expansion step.',
};

function buildPrompt(task, variantId) {
  return [
    VARIANT_INSTRUCTIONS[variantId],
    "You may use Read/Grep only if the graph is insufficient.",
    `Question: ${task.query}`,
    "Answer in one or two sentences, naming the key function/symbol(s) that implement the behavior.",
  ].join("\n\n");
}

function runAgent(prompt, root, model) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--allowedTools", "Bash Read Grep Glob"];
  if (model) args.push("--model", model);
  const res = spawnSync("claude", args, { cwd: root, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 });
  return res.stdout ?? "";
}

const FALLBACK_BASH = /\b(grep|rg|cat|head|tail|sed|awk|find|ls)\b/;

function parseTranscript(stdout) {
  let graphScope = 0, graphGet = 0, graphOther = 0, readGrepFallback = 0;
  let result = "", cost = 0, turns = 0, denials = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "assistant") {
      for (const block of obj.message?.content ?? []) {
        if (block.type !== "tool_use") continue;
        if (block.name === "Read" || block.name === "Grep" || block.name === "Glob") { readGrepFallback += 1; continue; }
        if (block.name === "Bash") {
          const cmd = String(block.input?.command ?? "");
          if (cmd.includes("graph scope")) graphScope += 1;
          else if (cmd.includes("graph get")) graphGet += 1;
          else if (cmd.includes("dist/cli.js")) graphOther += 1;
          else if (FALLBACK_BASH.test(cmd)) readGrepFallback += 1;
        }
      }
    } else if (obj.type === "result") {
      result = obj.result ?? "";
      cost = obj.total_cost_usd ?? 0;
      turns = obj.num_turns ?? 0;
      denials = (obj.permission_denials ?? []).length;
    }
  }
  return { graphScope, graphGet, graphOther, readGrepFallback, result, cost, turns, denials };
}

function parseArgs(argv) {
  const args = { root: REPO_ROOT, limit: Infinity, model: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = resolve(argv[++i]);
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--model") args.model = argv[++i];
  }
  return args;
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = JSON.parse(readFileSync(join(HERE, "fixtures", "nl-tasks.json"), "utf-8")).slice(0, args.limit);

  const rows = [];
  const perVariant = {};
  for (const variantId of ["minimal", "source"]) {
    const variantRows = [];
    for (const task of tasks) {
      process.stderr.write(`[eval:e2e:model] ${variantId} / ${task.id} ...\n`);
      const stdout = runAgent(buildPrompt(task, variantId), args.root, args.model);
      const t = parseTranscript(stdout);
      const g = grade(t.result, task.rubric);
      const row = {
        variant: variantId, task: task.id,
        scope: t.graphScope, get: t.graphGet, fallback: t.readGrepFallback,
        turns: t.turns, cost: Number(t.cost.toFixed(3)), correct: g.correct, denials: t.denials,
      };
      rows.push(row);
      variantRows.push(row);
    }
    perVariant[variantId] = {
      correctRate: Number((variantRows.filter((r) => r.correct).length / variantRows.length).toFixed(3)),
      meanCost: Number(mean(variantRows.map((r) => r.cost)).toFixed(3)),
      meanTurns: Number(mean(variantRows.map((r) => r.turns)).toFixed(1)),
      meanGetCalls: Number(mean(variantRows.map((r) => r.get)).toFixed(2)),
      meanFallbacks: Number(mean(variantRows.map((r) => r.fallback)).toFixed(2)),
    };
  }

  console.log("\n== end-to-end (real model) ==");
  console.table(rows);
  console.log("\n== per-variant summary ==");
  console.table(perVariant);

  const ranked = Object.entries(perVariant).sort(
    (a, b) => b[1].correctRate - a[1].correctRate || a[1].meanCost - b[1].meanCost,
  );
  console.log(`\n[eval:e2e:model] best (correctness, then cost): ${ranked[0][0]}`);

  const outDir = join(HERE, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "agent-e2e-model.json"), JSON.stringify({ perVariant, rows }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
