// Counts routing opportunities, not useful injections. Input artifacts stay read only.
import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [data, scratch, measurement] = process.argv.slice(2);
if (!data || !scratch) throw Error('Usage: node scripts/replay-hook-coverage.mjs DATA SCRATCH');
mkdirSync(scratch,{recursive:true});
const bundle=resolve(scratch,'shell.mjs');
await build({entryPoints:['src/hooks/shell.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm'});
const {bashSearchPattern,bashReads,shellSegments}=await import(pathToFileURL(bundle).href);
const totals={}, sessions=[];
const measured=measurement?JSON.parse(readFileSync(measurement,'utf8')).summary:null;
const wall=[];
for(const subject of ['hono','ts','dj']) {
  const artifacts=join(data,subject,'artifacts');
  const cache=join(data,subject,'index-cache');
  const indexed=new Set();
  // Context-index membership proves linked source. Also count other source paths
  // separately: only linked reads can inject knowledge through today's composer.
  for(const base of readdirSync(cache)) {
    const index=JSON.parse(readFileSync(join(cache,base,'context-index.json'),'utf8'));
    for(const e of index.entities) for(const path of e.code??[]) indexed.add(path);
  }
  for(const file of readdirSync(artifacts).filter(f=>f.endsWith('.calls.json'))) {
    const arm=file.includes('-mex-r2w')?'mex-r2w':file.includes('-mex-r3')?'mex-r3':'files';
    const calls=JSON.parse(readFileSync(join(artifacts,file),'utf8'));
    const rows=readFileSync(join(artifacts,file.replace('.calls.json','.jsonl')),'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
    const root=rows.find(r=>r.type==='system'&&r.cwd)?.cwd;
    const stat={sessions:1,bash:0,beforeSearch:0,afterSearch:0,compound:0,sourceReads:0,linkedReads:0,afterEither:0,beforeSpawns:0,afterSpawns:0};
    let toolWall=0;
    for(const c of calls) {
      if(c.status!=='executed')continue;
      if(['Read','Edit','Write','MultiEdit','Grep','Bash'].includes(c.name))stat.beforeSpawns++;
      if(['Grep','Bash'].includes(c.name))stat.afterSpawns++;
      if(measured && c.name==='Grep')toolWall+=c.outputChars>0?measured.events.grep.wall:measured.events.noop.wall;
      if(c.name!=='Bash')continue;
      stat.bash++;
      const cmd=c.command??'';
      const pattern=bashSearchPattern(cmd);
      const search=Boolean(pattern)&&c.outputChars>0;
      if(measured)toolWall+=search?measured.events.compound.wall:measured.events.noop.wall;
      const before=search&&!/[|;&<>\n]/.test(cmd);
      const reads=root?bashReads(cmd,root):[];
      const source=reads.some(r=>/\.(ts|tsx|js|jsx|mjs|py|c|h|rs|go|java)$/.test(r.file));
      const linked=reads.some(r=>indexed.has(r.file));
      stat.beforeSearch+=Number(before);stat.afterSearch+=Number(search);
      stat.compound+=Number(search&&shellSegments(cmd).length>1);
      stat.sourceReads+=Number(source);stat.linkedReads+=Number(linked);
      stat.afterEither+=Number(search||linked);
    }
    sessions.push({subject,arm,file,...stat});
    const logFile=join(artifacts,file.replace('.calls.json','.context-log.jsonl'));
    if(measured&&arm!=='files'&&existsSync(logFile)){
      const log=readFileSync(logFile,'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l)).filter(e=>['prompt','read','edit','grep','bash','stop','stop-block','error'].includes(e.event));
      const before=log.reduce((n,e)=>n+550+(e.ms??0),0);
      const envelope=measured.events.prompt.wall-measured.events.prompt.runner;
      const after=toolWall+log.filter(e=>['prompt','stop','stop-block'].includes(e.event)).reduce((n,e)=>n+envelope+(e.ms??0),0);
      wall.push({subject,arm,file,before,after,reduction:1-after/before});
    }
    for(const key of [arm,'all']) {
      totals[key]??=Object.fromEntries(Object.keys(stat).map(k=>[k,0]));
      for(const [k,v] of Object.entries(stat))totals[key][k]+=v;
    }
  }
}
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const wallProjection=wall.length?{method:'Offline projection, not new sessions: before = recorded hook ms + audit 550 ms spawn per event; after = measured tool costs with default matchers, keeping original prompt/Stop internal ms plus measured import/start envelope. No semantic or settle speedup assumed.',sessions:wall.length,before:median(wall.map(r=>r.before)),after:median(wall.map(r=>r.after)),pairedReduction:median(wall.map(r=>r.reduction)),rows:wall}:null;
writeFileSync(join(scratch,'coverage.json'),JSON.stringify({method:'All calls files; executed calls only; search requires nonempty recorded output; reads intersect the subject context-index code paths. Counts are routing opportunities before dedup/gates. Before searches require the old simple-pattern parser, though old compound searches could still deliver knowledge-only hits. Reads are opt-in.',totals,sessions,wallProjection},null,2));
console.log(JSON.stringify({totals,wallProjection:wallProjection?{...wallProjection,rows:undefined}:null},null,2));
