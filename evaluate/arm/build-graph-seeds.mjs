#!/usr/bin/env node
// Build one full graph per task base, for `--prepare --graph-seeds <out>`. Bases run one at a
// time and a finished seed is skipped, so the script can be rerun after a stop.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWorkspace, removeWorkspace, resolveCommit, runMex } from "./lib/workspace.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
for (const key of ["suite", "subject", "cli-bin", "out"]) if (!args[key]) throw new Error(`--${key} is required`);
const suite = JSON.parse(readFileSync(resolve(args.suite), "utf8"));
const subject = resolve(args.subject), cliBin = resolve(args["cli-bin"]), out = resolve(args.out);
// `--tasks a,b,...` also sets the build order, so pilot bases can come first.
const tasks = args.tasks ? args.tasks.split(",").map((id) => suite.tasks.find((t) => t.id === id) ?? (() => { throw new Error(`unknown task ${id}`); })()) : suite.tasks;
const bases = [...new Set(tasks.map((t) => resolveCommit(subject, t.base)))];
const projectName = suite.projectName ?? "project";

for (const [i, base] of bases.entries()) {
  const target = join(out, base);
  if (existsSync(join(target, "graph.db"))) { console.log(`[${i + 1}/${bases.length}] ${base.slice(0, 10)} exists`); continue; }
  const workspace = join(out, `${base}.work`, projectName);
  removeWorkspace(subject, workspace, { removeParent: true });
  const started = Date.now();
  try {
    createWorkspace({ subjectRoot: subject, workspace, base, depsDir: args.deps ? resolve(args.deps) : null });
    // The graph scope must match the scaffold's `.mex/config.json`, or a session's first refresh re-extracts everything.
    if (args.config) { mkdirSync(join(workspace, ".mex"), { recursive: true }); copyFileSync(resolve(args.config), join(workspace, ".mex", "config.json")); }
    const result = runMex(cliBin, ["graph"], workspace, process.env);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    mkdirSync(target, { recursive: true });
    copyFileSync(join(workspace, ".mex", "graph.db"), join(target, "graph.db"));
    writeFileSync(join(target, "seed-info.json"), `${JSON.stringify({ base, ms: Date.now() - started, builtAt: new Date().toISOString() }, null, 2)}\n`);
    console.log(`[${i + 1}/${bases.length}] ${base.slice(0, 10)} built in ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (error) {
    console.log(`[${i + 1}/${bases.length}] ${base.slice(0, 10)} FAILED: ${String(error.message).slice(-800)}`);
  } finally {
    removeWorkspace(subject, workspace, { removeParent: true });
  }
}
console.log("done");
