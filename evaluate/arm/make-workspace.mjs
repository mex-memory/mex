#!/usr/bin/env node
// A checkout whose history ends at one base, for running `mex setup` or `mex sync` by hand
// exactly where the harness will later run sessions: the base and its ancestors only, with
// the subject's installed dependencies linked in.
//
//   node evaluate/arm/make-workspace.mjs --subject <clone> --base <sha> --out <new dir> [--deps <node_modules>] [--suite <suite.json>]
//
// With --suite, every task's merge commit and hidden-test commit is checked to be absent.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clipRepository, verifyClippedHistory } from "./lib/history.mjs";
import { linkDependencies, resolveCommit } from "./lib/workspace.mjs";

const argv = process.argv.slice(2);
const arg = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
for (const name of ["--subject", "--base", "--out"]) if (!arg(name)) throw new Error(`${name} is required`);
const subject = resolve(arg("--subject")), out = resolve(arg("--out"));
if (existsSync(out)) throw new Error(`${out} already exists; choose a new folder`);
const base = resolveCommit(subject, arg("--base"));
clipRepository(subject, out, base);
const forbidden = [];
if (arg("--suite")) {
  const suite = JSON.parse(readFileSync(resolve(arg("--suite")), "utf8"));
  for (const task of suite.tasks ?? []) for (const sha of [task.mergeCommit, task.hiddenTests?.fromCommit]) if (sha && !forbidden.includes(sha)) forbidden.push(sha);
}
const history = verifyClippedHistory(out, base, forbidden);
if (arg("--deps")) linkDependencies(out, resolve(arg("--deps")));
console.log(JSON.stringify({ workspace: out, base, history, dependencies: arg("--deps") ? resolve(arg("--deps")) : null }, null, 2));
