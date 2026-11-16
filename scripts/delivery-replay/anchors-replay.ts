// Explicit dev-only, offline replay. Index writes go only to --output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildIndex } from '../../src/file-index/build.js';
import { globToRegExp } from '../../src/file-index/glob.js';
import { arg, corpus, rows, native } from './evaluate.mjs';
import { transcript, convert } from './convert.mjs';

const qset = resolve(arg('--qset')), sessions = resolve(arg('--sessions')), output = resolve(arg('--output'));
const binary = resolve(arg('--binary')), sources = JSON.parse(readFileSync(resolve(arg('--sources')), 'utf8'));
mkdirSync(output, {recursive:true});
const labels = rows(join(qset,'prompts','dev.jsonl'));
const sessionLabels = rows(join(qset,'sessions','dev.jsonl'));
const report: Record<string, unknown> = { split:'dev', labelsHaveDeadlines:false, onTimeDefinition:'proxy: required entry is available at first touch of a verified anchor; prompt labels have no touch deadlines' };
const totals = {queries:0,withExtracted:0,withVerified:0,extracted:0,verified:0,pointers:0,noGold:0,falsePointer:0,required:0,baselineRequired:0,anchorRequired:0,armedRequired:0};
const realTotals = {queries:0,withExtracted:0,withVerified:0,pointers:0,extracted:0,verified:0,phraseMatched:0,phrasePointers:0,phraseLines:0};
// Team-phrase pointer census: an entry alias of two words, or six characters, matched at word boundaries.
const control = {entriesWithAliases:0,aliasPrompts:0,pointers:0,entriesWithPointer:0};
const vocabularyTotals = {queries:0,withAliasMatch:0,withPointer:0,pointers:0,rightEntry:0,wrongEntry:0,noGold:0,falsePointerPrompts:0,aliasEntries:0};
const eligible=(a:string)=>{const k=a.toLowerCase().split(/\s+/).filter(Boolean);return k.length>=2||k.join(' ').length>=6;};
const wordChar=(c:string)=>/[\p{L}\p{N}_]/u.test(c);
const phraseMatches=(text:string,aliases:string[])=>{const hay=text.toLowerCase().split(/\s+/).filter(Boolean).join(' ');return aliases.filter(eligible).some(a=>{const key=a.toLowerCase().split(/\s+/).filter(Boolean).join(' ');for(let at=hay.indexOf(key);at>=0;at=hay.indexOf(key,at+1)){if((at===0||!wordChar(hay[at-1]))&&(at+key.length===hay.length||!wordChar(hay[at+key.length])))return true;}return false;});};
for (const repo of Object.keys(sources).sort()) {
 const root=resolve(sources[repo]), project=`study-${repo}`, directory=join(output,'index');
 const built=await buildIndex({root,projectId:project,recordDirectory:directory,workers:0});
 const c=corpus(qset,repo), qs=labels.filter(q=>q.repo===repo);
 const real: Array<{prompt:string}> = [];
 for (const q of sessionLabels.filter(q=>q.repo===repo)) {
  const records=await transcript(join(sessions,q.session));
  const events=convert(records,{session:q.session,project,checkout:root,oldRoot:q.checkout_root,subagent:q.session.includes('subagents')});
  for (const ev of events) if (ev.kind==='prompt' && ev.prompt?.typed) real.push({prompt:ev.prompt.text});
 }
 const all=[...qs,...real];
 const child=spawnSync(binary,['--anchor-study'],{input:JSON.stringify({record_directory:directory,project,checkout:root,prompts:all.map(q=>q.prompt),entries:c.entries.map(e=>({...e,aliases:c.aliases[e.id]||[]}))}),encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:16<<20});
 if(child.status!==0) throw Error(child.stderr || 'anchor peer failed');
 const answers=JSON.parse(child.stdout);
 const wanted_entries=c.entries.map(e=>({...e,aliases:c.aliases[e.id]||[]})).filter(e=>e.aliases.some(eligible));
 const probes=wanted_entries.flatMap(e=>e.aliases.filter(eligible).map(a=>({entry:e.id,prompt:`Why does ${a} happen again?`})));
 const probeChild=spawnSync(binary,['--anchor-study'],{input:JSON.stringify({record_directory:directory,project,checkout:root,prompts:probes.map(p=>p.prompt),entries:wanted_entries}),encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:16<<20});
 if(probeChild.status!==0) throw Error(probeChild.stderr || 'anchor probe failed');
 const probeRows=JSON.parse(probeChild.stdout), earned=new Set<string>();
 probeRows.forEach((r,i)=>{control.aliasPrompts++;const own=(r.phrases||[]).filter(h=>h.entry===probes[i].entry);control.pointers+=own.length;if(own.length)earned.add(probes[i].entry);});
 control.entriesWithAliases+=wanted_entries.length;control.entriesWithPointer+=earned.size;
 const base=native(binary,{entries:c.entries,queries:qs.map(q=>({id:q.id,text:q.prompt})),gates:[{learned:true}]});
 const counts={...totals}; for (const k of Object.keys(counts)) counts[k]=0;
 answers.forEach((answer,i)=>{
  const extracted=answer.extracted||[], verified=answer.verified||[];
  const pointer=verified.find(a=>a.kind==='identifier' && a.signature);
  const phrases=answer.phrases||[], matched=c.entries.some(e=>phraseMatches(all[i].prompt,c.aliases[e.id]||[]));
  if(i>=qs.length){realTotals.phraseMatched+=Number(matched);realTotals.phrasePointers+=Number(phrases.length>0);realTotals.phraseLines+=phrases.length;realTotals.queries++;realTotals.withExtracted+=Number(extracted.length>0);realTotals.withVerified+=Number(verified.length>0);realTotals.pointers+=Number(!!pointer);realTotals.extracted+=extracted.length;realTotals.verified+=verified.length;return;}
  const q=qs[i], selected=(base.results[i]?.selected?.[0]||[]).map(r=>r.id);
  const armed=c.entries.filter(e=>verified.some(a=>(e.scope||[]).some(g=>globToRegExp(g).test(a.path)) || (e.when||[]).some(w=>w.match==='literal' && a.text.includes(w.pattern)))).map(e=>e.id);
  counts.queries++;counts.withExtracted+=Number(extracted.length>0);counts.withVerified+=Number(verified.length>0);counts.extracted+=extracted.length;counts.verified+=verified.length;counts.pointers+=Number(!!pointer);
  const wanted=new Set([...q.relevant,...q.acceptable]);
  vocabularyTotals.queries++;vocabularyTotals.withAliasMatch+=Number(matched);vocabularyTotals.withPointer+=Number(phrases.length>0);vocabularyTotals.pointers+=phrases.length;
  vocabularyTotals.rightEntry+=phrases.filter(h=>wanted.has(h.entry)).length;vocabularyTotals.wrongEntry+=phrases.filter(h=>!wanted.has(h.entry)).length;
  const noGold=!q.relevant.length && !q.acceptable.length;vocabularyTotals.noGold+=Number(noGold);vocabularyTotals.falsePointerPrompts+=Number(noGold && phrases.length>0);counts.noGold+=Number(noGold);counts.falsePointer+=Number(noGold && !!pointer);
  counts.required+=q.relevant.length;counts.baselineRequired+=q.relevant.filter(id=>selected.includes(id)).length;counts.anchorRequired+=q.relevant.filter(id=>selected.includes(id)||armed.includes(id)).length;counts.armedRequired+=q.relevant.filter(id=>armed.includes(id)).length;
 });
 for(const k of Object.keys(totals)) totals[k]+=counts[k];
 report[repo]={files:built.files,indexed:built.indexed,...counts};
 console.log(`${repo}: indexed ${built.indexed}/${built.files}, dev prompts ${qs.length}, real typed turns ${real.length}`);
}
report.dev={...totals,anchorHitRate:totals.withExtracted/totals.queries,verifiedPromptRate:totals.withVerified/totals.queries,verifiedAnchorRate:totals.verified/totals.extracted,falsePointerRate:totals.falsePointer/totals.noGold};
report.realTyped={...realTotals,anchorHitRate:realTotals.withExtracted/realTotals.queries,verifiedPromptRate:realTotals.withVerified/realTotals.queries,verifiedAnchorRate:realTotals.verified/realTotals.extracted};
report.vocabulary={...vocabularyTotals,positiveControl:{...control,definition:'Each eligible alias placed in a generic sentence; shows how often the entry has verifiable scope paths or unique identifiers, not whether real prompts use the phrase'},definition:'Aliases are the frozen setup-style symptom aliases of each corpus; pointers need a verified scope path or a unique identifier, so a matched phrase can still stay silent',aliasMatchRate:vocabularyTotals.withAliasMatch/vocabularyTotals.queries,pointerRate:vocabularyTotals.withPointer/vocabularyTotals.queries,rightEntryShare:vocabularyTotals.rightEntry/Math.max(1,vocabularyTotals.pointers),falsePointerRateOnNoGold:vocabularyTotals.falsePointerPrompts/Math.max(1,vocabularyTotals.noGold)};
report.keepRule={onTimeRiseProxy:totals.anchorRequired>totals.baselineRequired,falsePointersAtMost5Percent:totals.falsePointer/totals.noGold<=.05,liveActedAboveBase:'unmeasured; trial remains gated'};
writeFileSync(join(output,'anchors.json'),JSON.stringify(report,null,2)+'\n');
