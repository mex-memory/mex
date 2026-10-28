#!/usr/bin/env node
// One child per repository, each with its own output and temporary files.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan } from "./index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), mode = argv.includes("--pipeline") ? "pipeline" : argv.includes("--run") ? "run" : argv.includes("--prepare") ? "prepare" : "plan";
if (["--plan", "--prepare", "--run", "--pipeline"].filter((flag) => argv.includes(flag)).length > 1) throw new Error("choose only one mode");
const configPath = argv[argv.indexOf("--config") + 1];
if (!argv.includes("--config") || !configPath) throw new Error("--config <file> is required; default mode is --plan");
const config = JSON.parse(readFileSync(resolve(configPath), "utf8"));
const repos = config.repos;
const canonical = (p) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
const outputs = repos.map((r) => canonical(r.output));
if (repos.some((r, i) => outputs.some((p,j) => i !== j && (p === outputs[i] || p.startsWith(`${outputs[i]}${sep}`) || outputs[i].startsWith(`${p}${sep}`))))) throw new Error("repository outputs must be separate, non-nested folders");
if (new Set(repos.map((r) => canonical(r.subject))).size !== repos.length) throw new Error("one subject per concurrent run is required");
if (mode === "plan") {
  const plans = repos.map((r) => { const suite = JSON.parse(readFileSync(resolve(r.suite), "utf8")); return buildPlan(suite, { pilot: r.pilot, tasks: argv.includes("--pilot-tasks") ? suite.pilotTasks : null, effort: argv.includes("--effort") ? argv[argv.indexOf("--effort") + 1] : r.effort }); });
  process.stdout.write(`${JSON.stringify({ sessions: plans.reduce((n,p) => n+p.sessions,0), estimatedMeasuredUsd: plans.every((p)=>p.estimatedMeasuredUsd !== null) ? plans.reduce((n,p)=>n+p.estimatedMeasuredUsd,0) : null, warmupEstimateUsd: plans.reduce((n,p)=>n+p.warmupEstimateUsd,0), repos: plans }, null, 2)}\n`);
} else {
  const results = await Promise.all(repos.map((r) => new Promise((done, reject) => {
    const temp = join(resolve(r.output), "launcher-temp"); mkdirSync(temp, { recursive: true });
    const args = [join(here,"index.mjs"),`--${mode}`];
    for (const [key,flag] of [["suite","suite"],["subject","subject"],["cliBin","cli-bin"],["deps","deps"],["aliases","aliases"],["output","output"],["model","model"],["agent","agent"],["effort","effort"],["sandbox","sandbox"],["seedGraphs","seed-graphs"],["compareBase","compare-base"]]) if (r[key]) args.push(`--${flag}`,r[key]);
    if (argv.includes("--resume")) args.push("--resume");
    if (argv.includes("--no-warmup")) args.push("--no-warmup");
    if (argv.includes("--pilot-tasks")) args.push("--pilot-tasks");
    for (const key of ["effort", "min-ram-gb", "min-disk-gb"]) if (argv.includes(`--${key}`)) args.push(`--${key}`, argv[argv.indexOf(`--${key}`) + 1]);
    const child = spawn(process.execPath,args,{stdio:"inherit",env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp},windowsHide:true});
    child.on("error",reject);child.on("exit",(code)=>done({repo:r.name,code}));
  })));
  process.stdout.write(`${JSON.stringify(results)}\n`);
  if (results.some((r)=>r.code !== 0)) process.exitCode=1;
}
