// Paired cold-process measurements on synthetic files only. No saved tool runs.
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; };
const binary = resolve(arg("--binary")), base = resolve(arg("--base")), output = resolve(arg("--output"));
const pairs = Number(arg("--pairs", "200")), deliveryPairs = Number(arg("--delivery-pairs", "50"));
if (!Number.isInteger(pairs) || pairs < 200 || !Number.isInteger(deliveryPairs) || deliveryPairs < 1) throw Error("Use >=200 no-op pairs and a positive delivery sample");
const quantile = (xs, p) => [...xs].sort((a,b)=>a-b)[Math.min(xs.length-1, Math.floor(xs.length*p))];
const distribution = xs => ({ p50: quantile(xs,.5), p95: quantile(xs,.95), runs: xs.length });
const hash = text => createHash("sha256").update(text).digest("hex").slice(0,24);
const canonical = path => { const text = realpathSync.native(path); return process.platform === "win32" ? text.replace(/[A-Z]/g, c=>c.toLowerCase()) : text; };
const project = "g-0123456789abcdef01234567";
const work = join(output, "timing-" + Date.now());
mkdirSync(work,{recursive:true});

function fixture(count) {
 const root = join(work,"repo-"+count);
 mkdirSync(join(root,".git"),{recursive:true});mkdirSync(join(root,".mex","learned"),{recursive:true});mkdirSync(join(root,"src"),{recursive:true});
 writeFileSync(join(root,"src","a.ts"),"export const pool = 1;\n");
 for (let i=0;i<count-1;i++) {
  const id="mx_timing"+String(i).padStart(4,"0"), scope=i===0 ? "src/**" : `unused/${i}/**`;
  writeFileSync(join(root,".mex","learned",id+".md"),`---\nmex:\n  id: ${id}\n  kind: pitfall\n  scope: ["${scope}"]\n  source: {type: docs, ref: README.md}\n  evidence: docs\n  one_line: Keep the shared pool open.\n  checks: []\n  status: active\n  created: 2026-11-03\n---\nKeep the shared pool open because every request reuses it.\n`);
 }
 // A structured signature, never a command that this script executes.
 writeFileSync(join(root,".mex","learned","mx_failure.md"),`---\nmex:\n  id: mx_failure\n  kind: hint\n  scope: ["**"]\n  source: {type: docs, ref: README.md}\n  evidence: docs\n  one_line: The test service has to be available.\n  when: [{type: anti, match: literal, pattern: "connect ELOCAL"}]\n  checks: []\n  status: active\n  created: 2026-11-03\n---\nThe test service has to be available.\n`);
 return canonical(root);
}
function lane(root, count, name, exe) {
 const home=join(work,`${count}-${name}`),mex=join(home,".mex");mkdirSync(join(mex,"hook-checkouts"),{recursive:true});
 writeFileSync(join(mex,"controls.json"),JSON.stringify({version:1,off:false,capture:false}));
 writeFileSync(join(mex,"hook-checkouts",hash(root)+".json"),JSON.stringify({version:1,project_id:project,root,state:"on",off_until:"",provisional:false}));
 const stage=spawnSync(exe,["--check-run"],{input:JSON.stringify({action:"evaluate",checkout:root,project_id:project,mex_home:mex,record_directory:mex,store:true}),encoding:"utf8",windowsHide:true,timeout:120000,maxBuffer:1024*1024,env:{...process.env,MEX_HOME:home,MEX_TELEMETRY:"0"}});
 if(stage.status!==0 || !JSON.parse(stage.stdout).ok)throw Error(stage.stderr||stage.stdout||"fixture stage failed");
 plantBackground(root, mex);
 return {home,mex,exe,name};
}
// The file index, fix table and working set the background job would have
// written for this lane, in the layout the Node writers use. 2,000 indexed
// paths and 501 files with fix history, so lookups aren't trivially small.
function fnv(text) {
 let h=0xcbf29ce484222325n;
 for(const b of Buffer.from(text,"utf8")){h^=BigInt(b);h=(h*0x100000001b3n)&0xffffffffffffffffn;}
 return h;
}
function plantBackground(root, mex) {
 const key=hash(root), index=join(mex,"projects",project,"index"), ws=join(mex,"projects",project,"working-set");
 mkdirSync(join(index,"checkouts"),{recursive:true});mkdirSync(ws,{recursive:true});mkdirSync(join(root,"src","lib"),{recursive:true});
 writeFileSync(join(root,"src","lib","pool.ts"),"x\n");
 const tables="CREATE TABLE records(hash TEXT NOT NULL, lang TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hash, lang)) WITHOUT ROWID; CREATE TABLE symbols(name TEXT NOT NULL, hash TEXT NOT NULL, lang TEXT NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, PRIMARY KEY(name, hash, lang, ord)) WITHOUT ROWID; CREATE TABLE counts(hash TEXT NOT NULL, lang TEXT NOT NULL, pattern TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(hash, lang, pattern)) WITHOUT ROWID; CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;";
 if(!existsSync(join(index,"c-t.db"))){
  for(const name of ["base-t.db","c-t.db"]){const db=new DatabaseSync(join(index,name));db.exec(tables);
   if(name==="c-t.db"){db.exec("CREATE TABLE paths(path TEXT PRIMARY KEY, hash TEXT, lang TEXT, is_test INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL, reason TEXT, name TEXT NOT NULL) WITHOUT ROWID");
    const insert=db.prepare("INSERT INTO paths VALUES(?,?,?,0,1,'0',NULL,?)");
    for(let i=0;i<2000;i++){const rel=i===0?"src/lib/pool.ts":`src/m${i}/f${i}.ts`;insert.run(rel,"h"+i,"ts",rel.split("/").pop());}}
   db.close();}
 }
 writeFileSync(join(index,"checkouts",key+".json"),JSON.stringify({version:1,root,snapshot:"c-t.db",base:"base-t.db",as_of:"2026-11-15T00:00:00Z"}));
 const now=Math.floor(Date.now()/1000);
 const rows=[["src/a.ts",4,now-86400*15],...Array.from({length:500},(_, i)=>[`src/m${i}/f${i}.ts`,3,now-86400])].map(([p,c,l])=>({k:fnv(p),c,l})).sort((a,b)=>a.k<b.k?-1:a.k>b.k?1:0);
 const table=Buffer.alloc(4+rows.length*16);table.write("MXF1",0,"ascii");
 rows.forEach((r,i)=>{table.writeBigUInt64LE(r.k,4+i*16);table.writeUInt32LE(r.c,12+i*16);table.writeUInt32LE(r.l,16+i*16);});
 writeFileSync(join(ws,key+".fixes"),table);
 writeFileSync(join(ws,key+".json"),JSON.stringify({version:1,head:"",branch:"",defaultBranch:"",made:new Date().toISOString(),seeds:["src/a.ts"],hops:[],words:[],fixes:{}}));
}
function invoke(lane,root,kind,session,mode) {
 const event=kind==="noop" ? "PreToolUse" : kind==="tool-miss"||kind.startsWith("read")||kind.startsWith("edit") ? "PostToolBatch" : kind==="failure-shadow"||kind==="wrong-path" ? "PostToolUseFailure" : "SessionStart";
 const path=join(root,"src","a.ts");
 const data={session_id:session,cwd:kind==="start" ? join(root,"src") : root,hook_event_name:event,source:"startup",tool_name:"Read",tool_input:{file_path:path}};
 if(event==="PostToolBatch")data.tool_calls=[{tool_name:"Read",tool_input:{file_path:kind==="tool-miss" ? join(root,"elsewhere.ts") : path},tool_response:"1\tconst pool = sharedPool;\n"}];
 if(kind.startsWith("edit"))data.tool_calls=[{tool_name:"Edit",tool_input:{file_path:kind==="edit-history" ? path : join(root,"elsewhere.ts"),old_string:"a",new_string:"b"},tool_response:{filePath:path}}];
 if(event==="PostToolUseFailure"){data.tool_name="Bash";data.tool_input={command:"npm test"};data.error="Exit code 1\nconnect ELOCAL";}
 if(kind==="wrong-path"){data.tool_name="Read";data.tool_input={file_path:join(root,"src","old","pool.ts")};data.error="File does not exist.";}
 const begin=performance.now();
 const child=spawnSync(lane.exe,["claude-code",event,"--delivery-trace"],{input:JSON.stringify(data),encoding:"utf8",windowsHide:true,timeout:5000,maxBuffer:64*1024,env:{...process.env,MEX_HOME:lane.home,MEX_TELEMETRY:"0",MEX_BACKGROUND:"0",MEX_DELIVERY_SURFACES:mode,MEX_OFF:""}});
 const elapsed=performance.now()-begin;
 if(child.status!==0)throw Error(child.stderr||"hook process failure");
 const failed=child.stderr.includes("delivery failed:");
 const reply=JSON.parse(child.stdout),empty=Object.keys(reply).length===0;
 if(failed){if(!empty)throw Error("failed hook returned context");return {elapsed,failed,error:child.stderr};}
 // Lines only this build adds are expected from the current lane only.
 const added={"edit-history":"History:","wrong-path":"No file at"}[kind];
 if (["noop","tool-miss","edit"].includes(kind)||mode==="shadow"||(added&&lane.name==="base")) {if(!empty&&!added)throw Error("expected an empty reply");}
 else if(!child.stdout.includes(added ?? (kind==="failure-shadow" ? "test service" : kind==="start" ? "Priority:" : "shared pool")))throw Error("expected fixture delivery: "+child.stdout);
 return {elapsed,failed:false};
}
const results=[];
for(const count of [50,500]){
 const root=fixture(count),old=lane(root,count,"base",base),current=lane(root,count,"current",binary);
 for(const kind of ["noop","tool-miss","read-live","read-shadow","failure-shadow","start","edit","edit-history","wrong-path"].filter(kind=>!arg("--cases")||arg("--cases").split(",").includes(kind))){
  const runs=kind==="noop"||kind==="tool-miss"||kind==="edit" ? pairs : deliveryPairs;
  const mode=kind.endsWith("shadow") ? "shadow" : "on";
  const warmFailures=[];
  for(let i=0;i<3;i++){for(const [name,active,setting] of [["base",old,"on"],["current",current,mode]]){const row=invoke(active,root,kind,`warm-${kind}-${i}`,setting);if(row.failed)warmFailures.push({lane:name,error:row.error});}}
  const before=[],after=[],delta=[],failures=[],errors=[];
  for(let i=0;i<runs;i++){
   const session=`measure-${kind}-${i}`;let a,b;
   if(i%2){b=invoke(current,root,kind,session,mode);a=invoke(old,root,kind,session,"on");}
   else{a=invoke(old,root,kind,session,"on");b=invoke(current,root,kind,session,mode);}
   before.push(a.elapsed);after.push(b.elapsed);delta.push(b.elapsed-a.elapsed);
   if(a.failed)failures.push({lane:"base",session,error:a.error});if(b.failed)failures.push({lane:"current",session,error:b.error});
  }
  let receipts=[];
  if(existsSync(join(current.mex,"hooks.db"))){const db=new DatabaseSync(join(current.mex,"hooks.db"),{readOnly:true});receipts=db.prepare("SELECT action,count(*) AS count,sum(tokens) AS tokens,min(tokens) AS min,max(tokens) AS max FROM deliveries WHERE session_id LIKE ? GROUP BY action").all(`measure-${kind}-%`);db.close();}
  if(!["noop","tool-miss","edit"].includes(kind)){
   const emitted=receipts.filter(row=>["given","replaced","shadow"].includes(row.action)).reduce((n,row)=>n+row.count,0);
   const expected=runs-failures.filter(row=>row.lane==="current").length;
   if(emitted<expected || (kind!=="start"&&emitted!==expected))errors.push(`Receipt count ${emitted}, expected ${kind==="start"?"at least ":""}${expected}`);
  }
  const result={kind,entries:count,pairedRuns:runs,baseMS:distribution(before),currentMS:distribution(after),addedMS:distribution(delta),receipts,failures,warmFailures,errors};results.push(result);console.log(JSON.stringify(result));
 }
}
writeFileSync(join(output,"surface-timing.json"),JSON.stringify({definition:"Measured cold processes, alternating base/current order per pair, synthetic checkout, estimated receipt tokens. Failed-open samples remain in latency distributions and are counted, never discarded; any failure makes the command exit nonzero. Entry count includes one failure hint. No saved command executed.",results},null,2)+"\n");
if(results.some(row=>row.failures.length||row.warmFailures.length||row.errors.length))process.exitCode=1;
