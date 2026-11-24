import { afterEach, describe, expect, it, vi } from "vitest";
import crossSpawn from "cross-spawn";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runModel, selectModel, DEFAULT_MODELS, MAX_MODEL_RESULT_BYTES, MAX_MODEL_PROMPT_BYTES, MAX_MODEL_STREAM_BYTES } from "../index.js";
import { buildModelCommand } from "../command.js";
import { openRecordReadOnly } from "../../record/index.js";

const temps: string[] = [], pids: number[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-model-runner-"))); temps.push(root);
  vi.stubEnv("MEX_HOME", root);
  return root;
}
afterEach(() => { for(const pid of pids.splice(0)) { try { process.kill(pid,"SIGKILL"); } catch {} } vi.unstubAllEnvs(); for(const root of temps.splice(0)) rmSync(root,{recursive:true,force:true}); });
function transport(source: string) {
  return vi.fn((_command: string, args: string[], options: Parameters<typeof crossSpawn>[2]) => crossSpawn(process.execPath, ["-e",source, "--", ...args], options)) as unknown as typeof crossSpawn;
}
function saved() {
  const reader = openRecordReadOnly();
  try { return reader?.all<Record<string,unknown>>("SELECT * FROM model_calls") ?? []; } finally { reader?.close(); }
}
const done = (agent: "claude" | "codex", text="answer") => agent === "claude"
  ? [{type:"result",subtype:"success",result:text,usage:{input_tokens:10,cache_read_input_tokens:4,output_tokens:3}}]
  : [{type:"item.completed",item:{type:"agent_message",text}},{type:"turn.completed",usage:{input_tokens:14,cached_input_tokens:4,output_tokens:3}}];

describe("model selection", () => {
  it.each(["claude","codex"] as const)("supports both setups and a missing cheap model for %s", agent => {
    expect(selectModel(agent,{role:"cheap"})).toBe(DEFAULT_MODELS[agent].cheap);
    expect(selectModel(agent,{role:"cheap",setup:"best-only"})).toBe(DEFAULT_MODELS[agent].best);
    expect(selectModel(agent,{role:"best"})).toBe(DEFAULT_MODELS[agent].best);
    expect(selectModel(agent,{role:"cheap",models:{...DEFAULT_MODELS,[agent]:{cheap:null,best:"best-fixture"}}})).toBe("best-fixture");
  });
  it("rejects model names that could be flags", () => {
    expect(() => selectModel("claude",{models:{...DEFAULT_MODELS,claude:{cheap:null,best:"--flag"}}})).toThrow("Invalid model");
  });
  it("scopes lean flags and permissions to the child command", () => {
    const claude = buildModelCommand("claude","",{role:"cheap"});
    expect(claude.env).toEqual({MEX_BACKGROUND:"1"});
    expect(claude.args).toEqual(expect.arrayContaining(["--safe-mode","--no-session-persistence","--model","haiku","--tools",""]));
    expect(claude.args).not.toContain("--bare");
    const codex = buildModelCommand("codex","-",{role:"best"});
    expect(codex.args).toEqual(expect.arrayContaining(["--ephemeral","hooks","project_doc_max_bytes=0","memories.generate_memories=false","memories.use_memories=false","read-only"]));
    expect(codex.args).not.toContain("--ignore-user-config");
    expect(codex.args).not.toContain("mcp_servers={}");
    expect(codex.env).toEqual({MEX_BACKGROUND:"1"});
  });
  it("gives a read-only call exactly the look-only tools and a turn cap, and nothing that edits", () => {
    const claude = buildModelCommand("claude","",{role:"cheap",access:"read",maxTurns:4});
    const tools = claude.args[claude.args.indexOf("--tools")+1];
    expect(tools).toBe("Read,Grep,Glob");
    expect(claude.args[claude.args.indexOf("--allowedTools")+1]).toBe("Read,Grep,Glob");
    expect(claude.args[claude.args.indexOf("--max-turns")+1]).toBe("4");
    expect(claude.args).not.toContain("acceptEdits");
    expect(buildModelCommand("claude","",{role:"cheap",access:"read",maxTurns:500}).args).toContain("20");
    const codex = buildModelCommand("codex","-",{role:"cheap",access:"read"});
    expect(codex.args[codex.args.indexOf("--sandbox")+1]).toBe("read-only");
    expect(codex.args).toEqual(expect.arrayContaining(["--ignore-user-config", 'approval_policy="never"', 'web_search="disabled"', "mcp_servers={}"]));
    expect(codex.args).not.toContain("--max-turns");
    // The default stays tool-less.
    expect(buildModelCommand("claude","",{role:"cheap"}).args[buildModelCommand("claude","",{role:"cheap"}).args.indexOf("--tools")+1]).toBe("");
  });
  it("isolates Codex evidence judgments from user context and tools", () => {
    const { args } = buildModelCommand("codex", "-", { role: "cheap", isolatedText: true, allowNonGit: true });
    expect(args).toEqual(expect.arrayContaining(["--ignore-user-config", "--ignore-rules", "mcp_servers={}",
      'web_search="disabled"', 'approval_policy="never"', "--skip-git-repo-check"]));
    expect(args.filter((_, i) => args[i - 1] === "--disable")).toEqual(expect.arrayContaining(["shell_tool", "apps", "plugins", "multi_agent_v2"]));
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args[args.indexOf("--model") + 1]).toBe(DEFAULT_MODELS.codex.cheap);
  });
});

describe("one-shot model runner with fake agents", () => {
  it.each(["claude","codex"] as const)("pipes the complete %s prompt, drains the terminal record and accounts once", async agent => {
    const root=fixture(), events=done(agent);
    const spawn=transport(`const fs=require('node:fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{fs.writeFileSync('observed.json',JSON.stringify({input,args:process.argv.slice(1),background:process.env.MEX_BACKGROUND}));for(const e of ${JSON.stringify(events)}){process.stdout.write(JSON.stringify(e));process.stdout.write(String.fromCharCode(10));}});`);
    const prompt="PRIVATE_PROMPT_"+"é".repeat(5000);
    const result=await runModel({agent,prompt,projectRoot:root,purpose:"filter.test",__internal:{spawn}});
    const observed=JSON.parse(readFileSync(join(root,"observed.json"),"utf8"));
    expect(observed.input).toBe(prompt); expect(observed.args.join(" ")).not.toContain(prompt); expect(observed.background).toBe("1");
    expect(result.text).toBe("answer");
    expect(result.usage).toMatchObject({input:10,cache_read:4,output:3,estimated:false});
    expect(result.selectedModel).toBe(DEFAULT_MODELS[agent].best);
    expect(saved()).toHaveLength(1); expect(saved()[0]).toMatchObject({agent,model:"unknown",purpose:"filter.test",estimated:0});
    expect(JSON.stringify(saved())).not.toContain("PRIVATE_PROMPT");
  });
  it("honors pre-start cancellation and the suite's no-real-agent guard", async () => {
    const root=fixture(), c=new AbortController(); c.abort(); const spawn=transport("process.exit(99)");
    await expect(runModel({agent:"claude",prompt:"task",projectRoot:root,purpose:"test",signal:c.signal,__internal:{spawn}})).rejects.toMatchObject({category:"cancelled"});
    expect(spawn).not.toHaveBeenCalled(); expect(saved()).toHaveLength(0);
    vi.stubEnv("MEX_SETUP_BACKGROUND_AGENTS","0");
    await expect(runModel({agent:"codex",prompt:"task",projectRoot:root,purpose:"test"})).rejects.toMatchObject({category:"launch"});
  });
  it("rejects invalid requests before spawning or accounting", async () => {
    const root=fixture(), spawn=transport("process.exit(99)");
    const base={agent:"claude" as const,prompt:"task",projectRoot:root,purpose:"test",__internal:{spawn}};
    for(const invalid of [{projectRoot:""},{timeoutMs:NaN},{purpose:undefined as unknown as string},{purpose:"private text must not be a label"},{models:{...DEFAULT_MODELS,claude:{cheap:null,best:"--bad"}}}]) {
      await expect(runModel({...base,...invalid})).rejects.toMatchObject({category:"arguments"});
    }
    expect(spawn).not.toHaveBeenCalled(); expect(saved()).toHaveLength(0);
  });
  it.each(["claude","codex"] as const)("accepts a complete large %s result within its declared bound", async agent => {
    const root=fixture(), text="x".repeat(MAX_MODEL_RESULT_BYTES);
    // Keep a large fixture out of the OS command-line limit too.
    const spawn=transport(`process.stdin.resume();const text='x'.repeat(${MAX_MODEL_RESULT_BYTES});const events=${JSON.stringify(done(agent,"PLACEHOLDER"))};for(const e of events){if(e.result)e.result=text;if(e.item)e.item.text=text;process.stdout.write(JSON.stringify(e));process.stdout.write(String.fromCharCode(10));}`);
    const result=await runModel({agent,prompt:"task",projectRoot:root,purpose:"test",__internal:{spawn}});
    expect(result.text).toBe(text); expect(result.usage.estimated).toBe(false); expect(saved()).toHaveLength(1);
  });
  it("refuses oversized input and returns no incomplete or oversized result", async () => {
    const root=fixture(); const spawn=transport("process.exit(99)");
    await expect(runModel({agent:"claude",prompt:"x".repeat(MAX_MODEL_PROMPT_BYTES+1),projectRoot:root,purpose:"test",__internal:{spawn}})).rejects.toMatchObject({category:"prompt"});
    expect(spawn).not.toHaveBeenCalled();
    const large=transport(`process.stdin.resume();process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'x'.repeat(${MAX_MODEL_RESULT_BYTES+1})}));process.stdout.write(String.fromCharCode(10));`);
    await expect(runModel({agent:"claude",prompt:"task",projectRoot:root,purpose:"test",__internal:{spawn:large}})).rejects.toMatchObject({category:"output"});
    const absent=transport(`process.stdin.resume();process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));`);
    await expect(runModel({agent:"codex",prompt:"task",projectRoot:root,purpose:"test",__internal:{spawn:absent}})).rejects.toMatchObject({category:"protocol"});
  });
  it("counts distinct Codex tool items and keeps the completed answer below the cap", async () => {
    const root = fixture();
    const item = { id: "item_1", type: "command_execution" };
    const events = ["started", "updated", "completed"].map(phase => ({ type: `item.${phase}`, item }));
    const spawn = transport(`process.stdin.resume(); process.stdout.write(${JSON.stringify([...events, ...done("codex")].map(e => JSON.stringify(e)).join("\n"))});`);
    const result = await runModel({ agent: "codex", prompt: "task", projectRoot: root, purpose: "verify.test",
      readOnlyTools: { maxTurns: 2 }, __internal: { spawn } });
    expect(result.text).toBe("answer");
    expect(saved()).toHaveLength(1);
  });

  it("terminates Codex at the tool cap, discards its answer and records reported usage", async () => {
    const root = fixture();
    const [partial, usage] = done("codex", '{"verdict":"keep"}');
    const events = [
      { type: "thread.started", thread_id: "verify-fixture" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_1", type: "command_execution" } },
      { type: "item.completed", item: { id: "item_1", type: "command_execution" } },
      partial, usage,
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_2", type: "mcp_tool_call" } },
    ];
    const spawn = transport(`process.stdin.resume(); process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join("\n") + "\n")}); setInterval(() => {}, 1000);`);
    await expect(runModel({ agent: "codex", prompt: "task", projectRoot: root, purpose: "verify.test", timeoutMs: 10_000,
      readOnlyTools: { maxTurns: 2 }, __internal: { spawn, onSpawn: pid => pids.push(pid) } })).rejects.toMatchObject({ category: "tool_limit" });
    expect(saved()).toEqual([expect.objectContaining({ purpose: "verify.test", input: 10, cache_read: 4, output: 3,
      estimated: 0, session_id: "verify-fixture" })]);
  });

  it("bounds total wall time even when stdout keeps refreshing inactivity", async () => {
    const root=fixture();
    const spawn=transport(`process.stdin.resume();setInterval(()=>{process.stdout.write('{"type":"tick"}');process.stdout.write(String.fromCharCode(10));},5);`);
    await expect(runModel({agent:"codex",prompt:"task",projectRoot:root,purpose:"test",timeoutMs:100,__internal:{spawn,onSpawn:pid=>pids.push(pid)}})).rejects.toMatchObject({category:"timeout"});
    expect(saved()).toHaveLength(1);
  });
  it("rejects malformed output and a stream beyond its total bound", async () => {
    const root=fixture();
    const malformed=transport(`process.stdin.resume();process.stdout.write('not json');process.stdout.write(String.fromCharCode(10));process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'partial'}));`);
    await expect(runModel({agent:"claude",prompt:"task",projectRoot:root,purpose:"test",__internal:{spawn:malformed}})).rejects.toMatchObject({category:"protocol"});
    const excessive=transport(`process.stdin.resume();const line=JSON.stringify({type:'tick',text:'x'.repeat(1024)})+String.fromCharCode(10);for(let n=0;n<${Math.ceil(MAX_MODEL_STREAM_BYTES / 1024) + 1};n++)process.stdout.write(line);`);
    await expect(runModel({agent:"codex",prompt:"task",projectRoot:root,purpose:"test",__internal:{spawn:excessive}})).rejects.toMatchObject({category:"output"});
    expect(saved()).toHaveLength(2);
  });
  it("cancels an owned child and records the attempt once", async () => {
    const root=fixture(), controller=new AbortController();
    const spawn=transport("process.stdin.resume();setInterval(()=>{},1000)");
    await expect(runModel({agent:"claude",prompt:"task",projectRoot:root,purpose:"test",signal:controller.signal,
      __internal:{spawn,onSpawn:pid=>{pids.push(pid);controller.abort();}}})).rejects.toMatchObject({category:"cancelled"});
    expect(saved()).toHaveLength(1);
  });
  it("keeps failed output out of error messages while recording the attempt", async () => {
    const root=fixture(), secret="PRIVATE_CHILD_TEXT";
    const spawn=transport(`process.stdin.resume();process.stderr.write('${secret} authentication failed');process.exitCode=1;`);
    const error=await runModel({agent:"claude",prompt:"task",projectRoot:root,purpose:"test",__internal:{spawn}}).catch(error=>error);
    expect(error.category).toBe("authentication"); expect(String(error)).not.toContain(secret); expect(saved()).toHaveLength(1);
  });
  it("keeps the requested model separate from a reported model", async () => {
    const root=fixture();
    const event={...done("claude")[0],model:"reported-model"};
    const spawn=transport(`process.stdin.resume();process.stdout.write(${JSON.stringify(JSON.stringify(event))});`);
    const result=await runModel({agent:"claude",prompt:"task",projectRoot:root,purpose:"test",__internal:{spawn}});
    expect(result.selectedModel).toBe(DEFAULT_MODELS.claude.best);
    expect(result.usage.model).toBe("reported-model");
    expect(saved()[0]?.model).toBe("reported-model");
  });
});

describe("AGENT_MODELS", () => {
  it("has a cheap and a best entry for every release-03 agent and reuses the runner table", async () => {
    const { AGENT_MODELS, DEFAULT_MODELS: defaults } = await import("../models.js");
    for (const agent of ["claude-code", "codex", "cursor", "antigravity", "gemini"]) {
      expect(AGENT_MODELS[agent]).toBeDefined();
      for (const name of [AGENT_MODELS[agent].cheap, AGENT_MODELS[agent].best]) {
        if (name !== null) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/);
      }
    }
    expect(AGENT_MODELS["claude-code"]).toBe(defaults.claude);
    expect(AGENT_MODELS.codex).toBe(defaults.codex);
  });
});
