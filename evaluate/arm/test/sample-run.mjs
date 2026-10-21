#!/usr/bin/env node
// Reproducible model-free fixture, including prepare, main, resume and calibration.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../index.mjs";
import { git } from "../lib/workspace.mjs";

export async function sampleRun(root) {
  const previousCost = process.env.FAKE_AGENT_COST_USD;
  process.env.FAKE_AGENT_COST_USD = "0.001";
  const subject = join(root, "subject"), output = join(root, "main"), cliBin = join(root, "cli/node_modules/.bin");
  mkdirSync(subject, { recursive: true }); mkdirSync(cliBin, { recursive: true }); mkdirSync(join(cliBin, "../mex-agent/dist"), { recursive: true });
  git(subject, ["init", "-q"]);
  writeFileSync(join(subject, ".gitignore"), ".mex/local/\n.mex/*.db\n");
  writeFileSync(join(subject, "README.md"), "fixture\n"); writeFileSync(join(subject, "source.ts"), "export const hiddenSymbol = 1;\n");
  writeFileSync(join(subject, "CLAUDE.md"), "Read AGENTS.md before proceeding.\n"); writeFileSync(join(subject, "AGENTS.md"), "Repository guidance.\n");
  git(subject, ["add", "."]); git(subject, ["commit", "-qm", "fixture base"]); const base = git(subject, ["rev-parse", "HEAD"]).stdout.trim();
  mkdirSync(join(subject, ".mex")); writeFileSync(join(subject, ".mex/fact.md"), "fixture fact\n");
  git(subject, ["add", "."]); git(subject, ["commit", "-qm", "fixture scaffold"]); const scaffold = git(subject, ["rev-parse", "HEAD"]).stdout.trim();
  copyFileSync(new URL("fake-cli.cjs", import.meta.url), join(cliBin, "../mex-agent/dist/cli.js"));
  const suitePath = join(root, "suite.json");
  const suite = { id: "heavy-fixture", requiresDeps: false, arms: { files: {}, "mex-r3": { scaffold: true, hooks: true, semantic: true } }, scaffolds: { default: scaffold },
    tasks: ["deep-a", "deep-b", "control"].map((id) => ({ id, type: "qa", heavy: id !== "control", base, scaffold: "default", prompt: `Trace the boundary for ${id}.`,
      complexity: { repoSourceLoc: 1, goldFiles: 1, directories: 1, packages: 1, goldLinesChanged: 0, promptNamesGold: false }, gold: { code: [{ path: "source.ts" }], knowledge: ["mx_fixture"], answerPoints: ["fixture"] } })) };
  writeFileSync(suitePath, JSON.stringify(suite, null, 2));
  const common = ["--suite", suitePath, "--subject", subject, "--cli-bin", cliBin, "--output", output, "--model", "fake", "--fake-agent", fileURLToPath(new URL("fake-hooks-agent.mjs", import.meta.url))];
  await main(["--prepare", ...common]); await main(["--run", ...common]);
  const runsDir = join(output, "runs"); const names = readdirSync(runsDir).filter((n) => n.endsWith(".json"));
  assert.equal(names.length, 18);
  const firstPath = join(runsDir, names[0]); const invalid = JSON.parse(readFileSync(firstPath)); invalid.valid = false; writeFileSync(firstPath, JSON.stringify(invalid));
  await main(["--run", "--resume", ...common]);
  const resumed = JSON.parse(readFileSync(firstPath)); assert.equal(resumed.execution.restartCount, 1); assert.equal(resumed.execution.resumeCount, 1);
  for (const name of names) {
    const row = JSON.parse(readFileSync(join(runsDir, name))); assert.equal(row.valid, true, `${name}: ${row.violations}`);
    assert.equal(row.instructionParity.identical, true);
    if (row.arm === "mex-r3") {
      assert.ok(row.hooks.hookEvents > 0); assert.equal(row.mexCheck.counts.SCAFFOLD_ORPHANED, undefined);
      const task = suite.tasks.find((t) => t.id === row.taskId);
      const log = readFileSync(join(output, "artifacts", `${row.runId}.context-log.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(log.find((e) => e.event === "prompt").receivedPrompt, task.prompt);
    }
  }
  await main(["--report", "--suite", suitePath, "--output", output]);
  await main(["--calibrate", "--tasks", "deep-a", ...common]);
  const summary = JSON.parse(readFileSync(join(output, "calibration/summary.json")));
  assert.equal(summary.tasks.find((t) => t.taskId === "deep-a").runs.length, 2);
  assert.equal(summary.tasks.some((t) => t.selected), false);
  assert.equal(readdirSync(join(output, "calibration/runs")).length, 2);
  await assert.rejects(() => main(["--report", "--suite", suitePath, "--output", join(output, "calibration")]), /calibration/);
  assert.equal(existsSync(join(output, "ws/persistent/project")), false);
  if (previousCost === undefined) delete process.env.FAKE_AGENT_COST_USD; else process.env.FAKE_AGENT_COST_USD = previousCost;
  return join(output, "report.md");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--output");
  if (index < 0) throw new Error("--output <new scratch folder> required");
  const root = resolve(process.argv[index + 1]);
  if (existsSync(root)) throw new Error("fixture output must be new");
  process.stdout.write(`Sample: ${await sampleRun(root)}\n`);
}
