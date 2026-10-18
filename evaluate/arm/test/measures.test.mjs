import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { claudeAdapter } from "../../adapters/agents/claude.mjs";
import { measureSession, neutralizeRows, priceUsage } from "../lib/measures.mjs";
const fixtures = JSON.parse(readFileSync(new URL("pilot-usage.json", import.meta.url)));
test("final cumulative model usage preserves every pilot token total and price", () => {
  for (const r of fixtures) {
    const u = Object.values(r.usage).reduce((a,u)=>({ uncachedInput:a.uncachedInput+u.inputTokens, cacheWrite:a.cacheWrite+u.cacheCreationInputTokens, cacheRead:a.cacheRead+u.cacheReadInputTokens, output:a.output+u.outputTokens }),{uncachedInput:0,cacheWrite:0,cacheRead:0,output:0});
    assert.deepEqual(u,r.oldTokens,r.id);
    assert.ok(Math.abs(priceUsage(u,"claude-sonnet-5-5")-r.expectedCost)<0.0001,r.id);
  }
  const rows=fixtures.map(r=>({arm:r.arm,repo:r.repo,firstCall:{model:"claude-sonnet-5-5",cacheRead:r.first.cache_read_input_tokens,cacheWrite:r.first.cache_creation_input_tokens},metrics:{costUsd:r.expectedCost}}));
  for(const repo of ["hono","ts","dj"])neutralizeRows(rows.filter(r=>r.repo===repo));
  // R3 has no cold sessions: its exact $0.5245082 cannot become the pilot's
  // $0.53 rounded-display summary without changing already warm sessions.
  for(const [arm,total] of [["files",.73228185],["mex-r2w",.61007485],["mex-r3",.5245082]])assert.ok(Math.abs(rows.filter(r=>r.arm===arm).reduce((s,r)=>s+r.metrics.neutralCostUsd,0)-total)<1e-9);
});
test("two result events use last cumulative cost and model totals",()=>{
 const u={input_tokens:2,cache_creation_input_tokens:3,cache_read_input_tokens:5,output_tokens:7};
 const event=(id)=>({type:"assistant",message:{id,usage:u,content:[]}});
 const raw=[event("a"),{type:"result",usage:u,total_cost_usd:.26,num_turns:1},event("b"),{type:"result",usage:u,total_cost_usd:.28,num_turns:1,modelUsage:{m:{inputTokens:4,cacheCreationInputTokens:6,cacheReadInputTokens:10,outputTokens:14}}}].map(JSON.stringify).join("\n");
 const p=claudeAdapter.parseTranscript(raw,{gold:[]});
 assert.equal(p.usage.reportedCostUsd,.28);assert.equal(p.usage.reportedTotal,34);assert.equal(p.usage.accountingValid,true);
});
test("injection uptake, redundancy, off-gold followups, graph absence and gold latency",()=>{
 const calls=[{name:"Grep",input:{pattern:"target"}},{name:"Read",input:{file_path:"src/a.ts"}},{name:"Bash",input:{command:"git grep target"}},{name:"Bash",input:{command:"mex wiki show mx_A"}},{name:"Bash",input:{command:"ls -R src"}}];
 const entries=[{event:"prompt",ids:["mx_A"],chars:60,text:"in #target (src/a.ts:1) source: .mex/other.md",toolCallIndex:0},{event:"graph",kind:"graph",ids:[],chars:20,text:"src/missing.ts",toolCallIndex:2}];
 const m=measureSession({raw:"",calls,entries,task:{gold:{code:[{path:"src/a.ts"}],knowledge:["context/right.md"]}}});
 assert.equal(m.discoveryCalls,3);assert.equal(m.injectionsUsed,1);assert.equal(m.injectionsIgnored,1);assert.equal(m.redundantSearches,2);assert.equal(m.turnsToGoldFile,2);assert.equal(m.wikiShowCalls,1);assert.equal(m.offGoldInjections.length,1);assert.equal(m.offGoldInjections[0].followingCalls.length,5);assert.equal(m.graphInjections,1);
 assert.equal(measureSession({raw:"",calls:[],task:{},entries:[]}).turnsToGoldFile,null);
});
