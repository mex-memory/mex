import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const identifier = value => typeof value === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value);
const nonblank = value => typeof value === "string" && value.trim() !== "";
export const relativePath = value => nonblank(value) && !isAbsolute(value) && !/[:\\\0]/.test(value)
  && value.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

export function loadSuite(file) {
  const suite = JSON.parse(readFileSync(file, "utf8"));
  if (suite.schemaVersion !== 1 || !identifier(suite.id) || !nonblank(suite.subjectRepo)
      || !Array.isArray(suite.tasks) || suite.tasks.length === 0) throw new Error("Invalid release suite");
  if (suite.setupBase !== undefined && !nonblank(suite.setupBase)) throw new Error("Invalid setupBase");
  const ids = new Set();
  for (const task of suite.tasks) {
    // A PR with no reviewer lesson has no turn 2: notes are the PR's own, never written for the run.
    if (!identifier(task.id) || ids.has(task.id) || !nonblank(task.base) || !nonblank(task.prompt)
        || (task.reviewerNotes !== undefined && !nonblank(task.reviewerNotes))
        || !Array.isArray(task.testNames) || !task.testNames.every(nonblank)) {
      throw new Error("Invalid or duplicate task");
    }
    ids.add(task.id);
    const hidden = task.hiddenTests;
    if (!hidden || !Array.isArray(hidden.files) || !hidden.files.every(relativePath)
        || [hidden.fromCommit, hidden.fromDirectory].filter(nonblank).length !== Number(hidden.files.length > 0)
        || !Array.isArray(hidden.command) || !hidden.command.length || !hidden.command.every(nonblank)) {
      throw new Error("Invalid hidden tests for " + task.id);
    }
    if (hidden.fromDirectory) hidden.fromDirectory = resolve(dirname(file), hidden.fromDirectory);
  }
  return suite;
}

export function taskPrompt(task) {
  return task.testNames.length ? task.prompt + "\n\nNames called by the tests:\n" + task.testNames.join("\n") : task.prompt;
}

export const armOrder = index => index % 2 === 0 ? ["baseline", "mex"] : ["mex", "baseline"];
