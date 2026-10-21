// Alternate prepared before/after bundles to reduce shared-machine timing bias.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
const [scratch, count='11', recipe='semantic'] = process.argv.slice(2);
if(!scratch||!Number.isSafeInteger(Number(count))||Number(count)<1||Number(count)>101)throw Error('Usage: node scripts/compare-hook-prompt.mjs SCRATCH [COUNT]');
const post=(tool,input,response='')=>({hook_event_name:'PostToolUse',tool_name:tool,tool_input:input,tool_response:response});
const events={
  prompt:{hook_event_name:'UserPromptSubmit',prompt:'Explain how getFlowTypeOfReference handles narrowing.'},
  ...(recipe==='semantic'?{}:{
    noop:post('Bash',{command:'pwd'}),
    read:post('Read',{file_path:resolve(scratch,'subject/src/compiler/checker.ts'),offset:29000,limit:50}),
    edit:post('Edit',{file_path:resolve(scratch,'subject/src/compiler/checker.ts')}),
    grep:post('Grep',{pattern:'getFlowTypeOfReference'},'src/compiler/checker.ts:29000:function getFlowTypeOfReference()'),
    compound:post('Bash',{command:'rg -n getFlowTypeOfReference src/compiler/checker.ts | head -20'},{stdout:'src/compiler/checker.ts:29000:function getFlowTypeOfReference()'}),
    stop:{hook_event_name:'Stop'},
  }),
};
const samples=Object.fromEntries(Object.keys(events).map(event=>[event,{before:[],after:[]}]));
const startup=[];
for(let i=0;i<Number(count);i++) {
  const bare=performance.now();spawnSync(process.execPath,['-e',''],{windowsHide:true});startup.push(performance.now()-bare);
  for(const [event,payload] of Object.entries(events)) for(const label of i%2?['after','before']:['before','after']){
  const t=performance.now();
  const p=spawnSync(process.execPath,[resolve(scratch,`${label}-${recipe==='semantic'?'semantic':'final'}/child.mjs`)],{encoding:'utf8',windowsHide:true,env:{...process.env,MEX_TELEMETRY:'0',PAYLOAD:JSON.stringify(payload),SUBJECT:resolve(scratch,'subject'),LEXICAL:recipe==='semantic'?'0':'1'}});
  if(p.status!==0)throw Error(p.stderr);
  samples[event][label].push({wall:performance.now()-t,...JSON.parse(p.stdout)});
  }
}
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const summary=Object.fromEntries(Object.entries(samples).map(([event,arms])=>[event,Object.fromEntries(Object.entries(arms).map(([label,rows])=>[label,{
  wall:median(rows.map(r=>r.wall)),imports:median(rows.map(r=>r.imports)),runner:median(rows.map(r=>r.runner)),
  phases:Object.fromEntries([...new Set(rows.flatMap(r=>Object.keys(r.phases)))].map(k=>[k,median(rows.map(r=>r.phases[k]??0))])),
}]))]));
const prepared=Object.fromEntries(['before','after'].map(label=>[label,JSON.parse(readFileSync(join(scratch,`${label}-${recipe==='semantic'?'semantic':'final'}/measurements.json`),'utf8')).summary]));
writeFileSync(resolve(scratch,`paired-${recipe}.json`),JSON.stringify({summary,samples,prepared,node:median(startup)},null,2));
console.log(JSON.stringify({summary,node:median(startup)},null,2));
