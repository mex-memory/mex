// Offline cold-process measurements. All generated bundles and subject state
// live under the caller's scratch directory; input caches are read only.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const [scratch, subject, cache, label = 'before', count = '11', recipe = 'lexical'] = process.argv.slice(2);
if (!scratch || !subject || !cache) throw Error('Usage: node scripts/benchmark-hook-runtime.mjs SCRATCH SUBJECT CACHE LABEL [COUNT] [lexical|semantic]');
if (!Number.isSafeInteger(Number(count)) || Number(count) < 1 || Number(count) > 101) throw Error('COUNT must be 1..101');
const out = resolve(scratch, label);
const baseline = label.startsWith('before');
const baselineSource = baseline ? execFileSync('git', ['-c', `safe.directory=${process.cwd().replaceAll('\\','/')}`, 'show', `${process.env.MEX_HOOK_BASELINE_REF ?? '45095ff'}:src/context/hook/run.ts`], {encoding:'utf8',windowsHide:true}) : null;
mkdirSync(out, { recursive: true });
const copy = resolve(scratch, 'subject');
if (resolve(subject) === copy || resolve(cache).startsWith(copy)) throw Error('Subject and cache must be outside the output copy');
mkdirSync(copy, { recursive: true });
if (!existsSync(join(copy, 'src'))) cpSync(join(subject, 'src'), join(copy, 'src'), { recursive: true });
mkdirSync(join(copy, '.mex/local'), { recursive: true });
for (const file of ['graph.db', 'wiki.db']) cpSync(join(cache, file), join(copy, '.mex', file));
for (const file of ['context-index.json', 'context-aliases.json']) cpSync(join(cache, file), join(copy, '.mex/local', file));
// The subject's tracked scaffold is needed for prompt freshness checks.
if (existsSync(join(subject, '.mex'))) cpSync(join(subject, '.mex'), join(copy, '.mex'), {
  recursive: true, filter: p => !/([\\/](local|graph\.db[^\\/]*|wiki\.db[^\\/]*))([\\/]|$)/.test(p),
});
const require = createRequire(import.meta.url);
const phases = [
  ['index', 'const loaded = loadContextIndex(root.localDir);', 'const loaded = phase("index", () => loadContextIndex(root.localDir));'],
  ['graph', 'const { reader } = openGraphReader(root.scaffoldRoot);', 'const { reader } = phase("graph", () => openGraphReader(root.scaffoldRoot));'],
  ['promptIndex', 'const ensured = await ensureContextIndex(root, "if-stale");', 'const ensured = await asyncPhase("promptIndex", () => ensureContextIndex(root, "if-stale"));'],
  ['model', 'embedder = (await loadEmbedder()).embedder;', 'embedder = (await asyncPhase("model", () => loadEmbedder())).embedder;'],
  ['scoring', 'outcome = await composePrompt(index, prompt, { scaffoldRoot: root.scaffoldRoot, shown, embedder });', 'outcome = await asyncPhase("scoring", () => composePrompt(index, prompt, { scaffoldRoot: root.scaffoldRoot, shown, embedder }));'],
  ['dispose', 'await embedder?.dispose?.();', 'await asyncPhase("dispose", () => embedder?.dispose?.());'],
];
const helper = `const phase=(name,fn)=>{const t=performance.now();try{return fn()}finally{globalThis.__phases[name]=(globalThis.__phases[name]??0)+performance.now()-t}}; const asyncPhase=async(name,fn)=>{const t=performance.now();try{return await fn()}finally{globalThis.__phases[name]=(globalThis.__phases[name]??0)+performance.now()-t}};`;
await build({ entryPoints: {run: 'src/context/hook/run.ts', preflight: 'src/hooks/preflight.ts'}, outdir: out, bundle: true, splitting: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'measure', setup(b) {
  b.onResolve({ filter: /^[^./]/ }, args => args.path.startsWith('node:') ? undefined : ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  b.onLoad({ filter: /[\\/](run|prompt|events|graph)\.ts$/ }, args => {
    let source = baselineSource !== null && args.path.endsWith('run.ts') ? baselineSource : readFileSync(args.path, 'utf8');
    for (const [, from, to] of phases) source = source.replaceAll(from, to);
    for (const name of ['composeRead','composeEdit','composeGrep','composeGraphSearch','composeGraphEdit']) {
      if (source.includes(`export function ${name}(`)) {
        source = source.replace(`export function ${name}(`, `function measured_${name}(`);
        source += `\nexport const ${name} = (...args: Parameters<typeof measured_${name}>) => phase("composer", () => measured_${name}(...args));`;
      }
    }
    return { contents: helper + source, loader: 'ts' };
  });
} }] });
const child = join(out, 'child.mjs');
writeFileSync(child, `import {performance} from 'node:perf_hooks'; globalThis.__phases={}; const t=performance.now(); let result={stdout:''}, imports=0, runner=0; const env={cwd:process.env.SUBJECT,lexical:process.env.LEXICAL==='1'}; let eligible=true; ${baseline ? '' : `const {preflightHook,hookSwitches}=await import('./preflight.js'); eligible=await preflightHook(process.env.PAYLOAD,env.cwd); env.tools=hookSwitches();`} if(eligible){const {runHook}=await import('./run.js');imports=performance.now()-t;const start=performance.now();result=await runHook(process.env.PAYLOAD,env);runner=performance.now()-start;}else imports=performance.now()-t; console.log(JSON.stringify({imports,runner,phases:globalThis.__phases,injected:result.stdout.length}));`);
const post = (tool, input, response = '') => ({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: response });
const events = {
  noop: post('Bash', {command: 'pwd'}),
  outside: post('Read', {file_path: join(copy, 'unindexed.txt')}),
  read: post('Read', {file_path: join(copy, 'src/compiler/checker.ts'), offset: 29000, limit: 50}),
  edit: post('Edit', {file_path: join(copy, 'src/compiler/checker.ts')}),
  grep: post('Grep', {pattern: 'getFlowTypeOfReference'}, 'src/compiler/checker.ts:29000:function getFlowTypeOfReference()'),
  compound: post('Bash', {command: 'rg -n getFlowTypeOfReference src/compiler/checker.ts | head -20'}, {stdout: 'src/compiler/checker.ts:29000:function getFlowTypeOfReference()'}),
  stop: {hook_event_name:'Stop'},
  prompt: {hook_event_name: 'UserPromptSubmit', prompt: 'Explain how getFlowTypeOfReference handles narrowing.'},
};
if (recipe === 'semantic') for (const key of Object.keys(events)) if (key !== 'prompt') delete events[key];
const median = a => [...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const samples = {};
for (const [event, payload] of Object.entries(events)) {
  samples[event] = [];
  for (let i=0;i<Number(count);i++) {
    const t=performance.now();
    const p=spawnSync(process.execPath, [child], {encoding:'utf8',windowsHide:true,env:{...process.env,MEX_TELEMETRY:'0',PAYLOAD:JSON.stringify(payload),SUBJECT:copy,LEXICAL:recipe === 'semantic' ? '0' : '1'}});
    if (p.status!==0) throw Error(p.stderr);
    samples[event].push({wall:performance.now()-t,...JSON.parse(p.stdout)});
  }
}
const startup=[];
for(let i=0;i<Number(count);i++){const t=performance.now();spawnSync(process.execPath,['-e',''],{windowsHide:true});startup.push(performance.now()-t)}
const summary={node:median(startup),events:Object.fromEntries(Object.entries(samples).map(([event,rows])=>[event,{wall:median(rows.map(r=>r.wall)),imports:median(rows.map(r=>r.imports)),runner:median(rows.map(r=>r.runner)),injected:median(rows.map(r=>r.injected)),phases:Object.fromEntries([...new Set(rows.flatMap(r=>Object.keys(r.phases)))].map(k=>[k,median(rows.map(r=>r.phases[k]??0))]))}]))};
writeFileSync(join(out,'measurements.json'),JSON.stringify({summary,samples},null,2));
console.log(JSON.stringify(summary,null,2));
