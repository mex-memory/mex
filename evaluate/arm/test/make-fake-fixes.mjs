#!/usr/bin/env node
// Writes the FAKE_AGENT_FIXES file for test/fake-hooks-agent.mjs: for each change task with hidden tests, the
// base commit, the upstream commit that fixed it and the test files to leave out, so a fake run can apply the
// real fix and the hidden tests then pass. Usage: make-fake-fixes.mjs <suite.json> <prepare.json> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { buildPrompt } from "../lib/session.mjs";

const [suitePath, preparedPath, outPath] = process.argv.slice(2);
if (!suitePath || !preparedPath || !outPath) throw new Error("usage: make-fake-fixes.mjs <suite.json> <prepare.json> <out.json>");
const suite = JSON.parse(readFileSync(suitePath, "utf8"));
const prepared = JSON.parse(readFileSync(preparedPath, "utf8"));
const fixes = {};
for (const task of suite.tasks) {
  const info = prepared.tasks[task.id];
  if (task.type !== "change" || !info?.hiddenFrom) continue;
  // The fake agent keys on the start of the prompt it is given.
  fixes[buildPrompt(task, { appendPrompt: suite.appendPrompt }).slice(0, 60)] = { base: info.base, fix: info.hiddenFrom, exclude: task.hiddenTests.files ?? [] };
}
writeFileSync(outPath, `${JSON.stringify(fixes, null, 2)}\n`);
process.stdout.write(`${Object.keys(fixes).length} fix(es) written to ${outPath}\n`);
