import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { selectedSchedule, buildPlan, main } from "../index.mjs";
import { runWarmup, runAgentSession, claudeInvocation } from "../lib/session.mjs";
import { buildIndexCache, git, resetWorkspace, verifyWorkspace, workspaceProcessPattern } from "../lib/workspace.mjs";

test("filtered schedules balance first arm and full selection counts all heavy tasks twice",()=>{
 let total=0;
 const firstTotals={files:0,"mex-r2w":0,"mex-r3":0};
 for(const repo of ["hono","ts","dj"]){
  const suite=JSON.parse(readFileSync(new URL(`../suites/${repo}-hooks.json`,import.meta.url)));
  const legacy={arms:Object.keys(suite.arms)}; const p=buildPlan(suite,legacy);total+=p.sessions;
  for(const [arm,n]of Object.entries(p.firstPosition))firstTotals[arm]+=n;
  assert.ok(Math.max(...Object.values(p.firstPosition))-Math.min(...Object.values(p.firstPosition))<=1);
  for(const task of suite.tasks.filter(t=>t.heavy))assert.equal(selectedSchedule(suite,legacy).filter(r=>r.task.id===task.id).length,6);
  const slice=selectedSchedule(suite,{...legacy,tasks:suite.tasks.filter(t=>t.type==="qa").slice(0,4).map(t=>t.id)});
  const counts=Object.keys(suite.arms).map(a=>slice.filter(r=>r.armId===a&&r.orderIndex===0).length);
  assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
 }
 assert.equal(total,123);
 assert.ok(Math.max(...Object.values(firstTotals))-Math.min(...Object.values(firstTotals))<=1);
});
test("the fake warmup restores flags, budget, logs and clean status",async()=>{
 const root=join(process.env.TEMP??process.cwd(),`warmup-${process.pid}`);
 mkdirSync(join(root,".mex","local"),{recursive:true});
 try{
  git(root,["init","-q"]);writeFileSync(join(root,".gitignore"),".mex/local/\n");writeFileSync(join(root,"README.md"),"fixture");
  mkdirSync(join(root,".claude"));
  writeFileSync(join(root,".claude/state.cjs"),`const fs=require('node:fs');fs.mkdirSync('.mex/local/context-sessions',{recursive:true});fs.writeFileSync('.mex/local/context-sessions/budget.json','warmup');fs.writeFileSync('.mex/local/context-flags.json','changed');fs.writeFileSync('.mex/local/context-log.jsonl','warmup');`);
  writeFileSync(join(root,".claude/settings.json"),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:"command",command:`"${process.execPath.replaceAll("\\","/")}" .claude/state.cjs`}]}]}}));
  git(root,["add","."]);git(root,["commit","-qm","fixture"]);
  writeFileSync(join(root,".mex","local","context-flags.json"),"original");
  const invocation=claudeInvocation({task:{type:"qa",prompt:"test"},model:"fake",claudeCommand:[process.execPath,new URL("fake-hooks-agent.mjs",import.meta.url).pathname.replace(/^\/(\w:)/,"$1")]});
  const result=await runWarmup({invocation,workspace:root,env:process.env,outputPrefix:join(root,"..",`warmup-${process.pid}-artifacts`)});
  assert.equal(result.costUsd,0);assert.equal(readFileSync(join(root,".mex/local/context-flags.json"),"utf8"),"original");assert.equal(existsSync(join(root,".mex/local/context-log.jsonl")),false);assert.equal(existsSync(join(root,".mex/local/context-sessions")),false);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(join(root,"..",`warmup-${process.pid}-artifacts.warmup.jsonl`),{force:true});}
});

test("reset removes edits and ignored state; independence rejects wrong HEAD and cache bytes",()=>{
 const root=join(process.env.TEMP??process.cwd(),`independence-${process.pid}`), cache=join(root,"cache"), ws=join(root,"project");
 mkdirSync(join(ws,".mex/local"),{recursive:true});mkdirSync(cache,{recursive:true});
 try{
  git(ws,["init","-q"]);writeFileSync(join(ws,".gitignore"),".mex/local/\n.mex/*.db\n");writeFileSync(join(ws,"README.md"),"base");git(ws,["add","."]);git(ws,["commit","-qm","fixture"]);const head=git(ws,["rev-parse","HEAD"]).stdout.trim();
  for(const n of ["graph.db","wiki.db"]){writeFileSync(join(ws,".mex",n),"bytes");writeFileSync(join(cache,n),"bytes");}
  assert.equal(verifyWorkspace({workspace:ws,head,base:head,cachePath:cache}).clean,true);
  writeFileSync(join(ws,".mex/graph.db"),"changed");assert.throws(()=>verifyWorkspace({workspace:ws,head,base:head,cachePath:cache}),/hash mismatch/);
  assert.throws(()=>verifyWorkspace({workspace:ws,head:"wrong",base:head}),/HEAD/);
  writeFileSync(join(ws,"README.md"),"agent edit");writeFileSync(join(ws,".mex/local/context-flags.json"),"state");resetWorkspace(ws,head);
  assert.equal(readFileSync(join(ws,"README.md"),"utf8"),"base");assert.equal(existsSync(join(ws,".mex/local/context-flags.json")),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("fake measured sessions flag cold starts and exclude warmup usage",async()=>{
 const root=join(process.env.TEMP??process.cwd(),`session-${process.pid}`),ws=join(root,"project");mkdirSync(ws,{recursive:true});
 try{
  git(ws,["init","-q"]);writeFileSync(join(ws,"README.md"),"base");git(ws,["add","."]);git(ws,["commit","-qm","fixture"]);
  const common={task:{type:"qa",prompt:"test",gold:{}},armId:"files",armSpec:{withMex:false},workspace:ws,model:"fake",timeoutMs:10000,claudeCommand:[process.execPath,new URL("fake-hooks-agent.mjs",import.meta.url).pathname.replace(/^\/(\w:)/,"$1")],warmup:true};
  const warm=await runAgentSession({...common,env:process.env,outputPrefix:join(root,"warm")});assert.equal(warm.warmup.usage.reportedTotal,6019);assert.equal(warm.metrics.processed,12038);assert.ok(!warm.violations.includes("cold-start"));
  const cold=await runAgentSession({...common,env:{...process.env,FAKE_COLD_START:"1"},outputPrefix:join(root,"cold")});assert.ok(cold.violations.includes("cold-start"));assert.equal(cold.valid,false);
  const disabled=await runAgentSession({...common,warmup:false,env:{...process.env,FAKE_COLD_START:"1"},outputPrefix:join(root,"disabled")});assert.equal(disabled.warmup,null);assert.ok(!disabled.violations.includes("cold-start"));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("prepare seeds subsequent bases and refreshes without a second full graph",()=>{
 const root=join(process.env.TEMP??process.cwd(),`incremental-${process.pid}`),subject=join(root,"subject"),cliBin=join(root,"cli/node_modules/.bin");
 mkdirSync(join(subject,".mex"),{recursive:true});mkdirSync(cliBin,{recursive:true});mkdirSync(join(cliBin,"../mex-agent/dist"),{recursive:true});
 try{
  git(subject,["init","-q"]);writeFileSync(join(subject,".gitignore"),".mex/*.db\n");writeFileSync(join(subject,".mex/context.md"),"knowledge");writeFileSync(join(subject,"source.ts"),"base");git(subject,["add","."]);git(subject,["commit","-qm","fixture"]);const base=git(subject,["rev-parse","HEAD"]).stdout.trim();
  writeFileSync(join(subject,"source.ts"),"next");git(subject,["commit","-qam","next"]);const next=git(subject,["rev-parse","HEAD"]).stdout.trim();
  writeFileSync(join(cliBin,"../mex-agent/dist/cli.js"),`const fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='graph'){const p='.mex/graph.db';fs.writeFileSync(p,a[1]==='refresh'?fs.readFileSync(p,'utf8')+' refreshed':'built');}else if(a[0]==='wiki')fs.writeFileSync('.mex/wiki.db','wiki');else console.log('{}');`);
  const common={subjectRoot:subject,cacheDir:join(root,"cache"),scaffoldCommit:base,cliBin,env:process.env};
  const first=buildIndexCache({...common,key:"first",base});const second=buildIndexCache({...common,key:"second",base:next,seedCache:first});
  assert.equal(readFileSync(join(second,"graph.db"),"utf8"),"built refreshed");assert.equal(JSON.parse(readFileSync(join(second,"build-info.json"))).graphMode,"refresh");
  assert.equal(existsSync(join(root,"cache/first.template")),false);assert.equal(existsSync(join(root,"cache/second.template")),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("fake full harness prepares, runs both arms twice and removes its persistent workspace",async()=>{
 const root=join(process.env.TEMP??process.cwd(),`harness-${process.pid}`),subject=join(root,"subject"),cliBin=join(root,"cli/node_modules/.bin"),output=join(root,"output");
 mkdirSync(join(subject,".mex"),{recursive:true});mkdirSync(cliBin,{recursive:true});mkdirSync(join(cliBin,"../mex-agent/dist"),{recursive:true});
 try{
  git(subject,["init","-q"]);writeFileSync(join(subject,"README.md"),"fixture");writeFileSync(join(subject,".mex/context.md"),"fixture");git(subject,["add","."]);git(subject,["commit","-qm","fixture"]);const base=git(subject,["rev-parse","HEAD"]).stdout.trim();
  writeFileSync(join(cliBin,"../mex-agent/dist/cli.js"),"console.log('fixture cli');");
  const suite=join(root,"suite.json");writeFileSync(suite,JSON.stringify({id:"fixture",requiresDeps:false,repetitions:2,arms:{files:{scaffold:false},markdown:{scaffold:true,cli:false}},scaffolds:{default:base},tasks:[{id:"question",type:"qa",base,scaffold:"default",prompt:"fixture question",gold:{code:[{path:"README.md"}]}}]}));
  const common=["--suite",suite,"--subject",subject,"--cli-bin",cliBin,"--output",output,"--model","fake","--fake-agent",new URL("fake-hooks-agent.mjs",import.meta.url).pathname.replace(/^\/(\w:)/,"$1")];
  await main(["--prepare",...common]);await main(["--run",...common]);
  const rows=readdirSync(join(output,"runs")).map(f=>JSON.parse(readFileSync(join(output,"runs",f))));
  assert.equal(rows.length,4);assert.ok(rows.every(r=>r.valid));assert.equal(rows.filter(r=>r.setup.reused).length,2);assert.ok(rows.every(r=>r.independence.clean));assert.equal(existsSync(join(output,"ws/persistent/project")),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("workspace process matching is bounded and preserves siblings with the same prefix",()=>{
 const pattern=new RegExp(workspaceProcessPattern("C:/scratch/repo/project"),"i");
 for(const line of ['node C:/scratch/repo/project/worker.js','node "C:/scratch/repo/project"','node C:\\scratch\\repo\\project\\worker.js'])assert.ok(pattern.test(line),line);
 for(const line of ['node C:/scratch/repo/project-other/worker.js','node C:\\scratch\\repo\\project-other\\worker.js','node C:/scratch/another/project/worker.js'])assert.ok(!pattern.test(line),line);
});
