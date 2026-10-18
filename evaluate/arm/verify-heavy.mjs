#!/usr/bin/env node
// Verify hidden graders without agent sessions; question graders retain answer keys.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, removeWorkspace, unlinkDependencies } from "./lib/workspace.mjs";
import { runHiddenTests } from "./lib/session.mjs";

const argv = process.argv.slice(2);
const value = (name) => { const i=argv.indexOf(name); return i < 0 ? null : argv[i+1]; };
if (!value("--config") || !value("--output")) throw new Error("--config <file> --output <folder> are required");
const config=JSON.parse(readFileSync(resolve(value("--config")),"utf8")), output=resolve(value("--output"));
mkdirSync(output,{recursive:true});
const results=[];
for (const repo of config.repos) {
  const suite=JSON.parse(readFileSync(resolve(repo.suite),"utf8"));
  for (const task of suite.tasks.filter((t)=>t.heavy)) {
    if (task.type !== "change") {
      const spans=task.gold.code.map((gold)=>{
        const lines=git(repo.subject,["show",`${task.base}:${gold.path}`]).stdout.split("\n");
        if (gold.startLine < 1 || gold.endLine > lines.length) throw new Error(`invalid gold span: ${task.id} ${gold.path}`);
        return {path:gold.path,start:gold.startLine,end:gold.endLine};
      });
      if (!task.gold.answerPoints?.length) throw new Error(`missing question grader: ${task.id}`);
      results.push({task:task.id,kind:"answer-points",answerPoints:task.gold.answerPoints.length,spans,ok:true});
    } else {
      const workspace=join(output,task.id,suite.projectName), states=[];
      if (existsSync(workspace)) throw new Error(`verification workspace already exists: ${workspace}`);
      mkdirSync(join(output,task.id),{recursive:true});
      try {
        git(repo.subject,["worktree","add","--detach",workspace,task.base]);
        for (const state of ["base","fix"]) {
          if (state === "fix") {
            if (repo.deps) unlinkDependencies(workspace);
            git(workspace,["reset","--hard",task.mergeCommit ?? task.hiddenTests.fromCommit]);
            git(workspace,["clean","-ffdx"]);
          }
          if (repo.deps) symlinkSync(resolve(repo.deps),join(workspace,"node_modules"),"junction");
          const result=runHiddenTests(workspace,{...task.hiddenTests,python:value("--python") ?? suite.python},{...process.env,TEMP:output,TMP:output,TMPDIR:output});
          writeFileSync(join(output,`${task.id}-${state}.txt`),result.output ?? JSON.stringify(result));
          states.push({state,python:task.hiddenTests.runner === "django" ? value("--python") ?? suite.python : null,...result});
        }
      } finally { removeWorkspace(repo.subject,workspace,{removeParent:true}); }
      results.push({task:task.id,kind:"hidden-tests",states,ok:states[0].total>0 && !states[0].ok && states[1].ok});
    }
    writeFileSync(join(output,"verification.json"),`${JSON.stringify(results,null,2)}\n`);
  }
}
process.stdout.write(`${JSON.stringify(results.map(({task,kind,ok})=>({task,kind,ok})),null,2)}\n`);
if (results.some((r)=>!r.ok)) process.exitCode=1;
