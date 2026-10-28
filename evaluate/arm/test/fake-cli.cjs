// Local fixture only: emits deterministic maintenance results and hook logs.
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), local = ".mex/local";
const bin = path.resolve(__dirname, "../../.bin");
const reply = (data) => console.log(JSON.stringify({ ok: true, data }));
if (args[0] === "--version") console.log("fixture-cli");
else if (args[0] === "graph") {
  if (process.env.FAKE_MEX_REAL_CLI) {
    const r = require("node:child_process").spawnSync(process.execPath, [process.env.FAKE_MEX_REAL_CLI, ...args], { cwd: process.cwd(), env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(r.stdout ?? ""); process.stderr.write(r.stderr ?? ""); process.exitCode = r.status ?? 1;
  } else fs.writeFileSync(".mex/graph.db", "fixture graph");
}
else if (args[0] === "wiki") fs.writeFileSync(".mex/wiki.db", "fixture wiki");
else if (args[0] === "check") console.log(JSON.stringify({ score: 100, issues: [{ code: "SCAFFOLD_ORPHANED", file: ".mex/fact.md" }] }));
else if (args[0] === "context" && args[1] === "semantic") reply({ state: "installed" });
else if (args[0] === "context" && args[1] === "index") {
  fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(`${local}/context-index.json`, '{"entities":[]}');
} else if (args[0] === "hooks" && args[1] === "install") {
  if (args[args.indexOf("--tool") + 1] === "codex") {
    fs.mkdirSync(".codex", { recursive: true });
    const script = `const fs=require('node:fs');let raw='';process.stdin.on('data',s=>raw+=s);process.stdin.on('end',()=>{const p=JSON.parse(raw);const event=p.hook_event_name==='UserPromptSubmit'?'prompt':p.hook_event_name==='Stop'?'stop':p.hook_event_name==='SessionStart'?'start':p.tool_name==='apply_patch'?'edit':'bash';fs.mkdirSync('.mex/local',{recursive:true});fs.appendFileSync('.mex/local/context-log.jsonl',JSON.stringify({event,at:new Date().toISOString(),ms:1,ids:[],chars:0,note:event==='prompt'?(process.argv.includes('--lexical')?'R2w/fixture':'R3/fixture'):null,lexicalEnv:process.env.MEX_HOOK_LEXICAL??null,lexicalSwitch:process.argv.includes('--lexical'),payload:p})+'\\n');});`;
    fs.writeFileSync(".codex/fixture.cjs", script);
    const command = `"${process.execPath.replaceAll("\\", "/")}" .codex/fixture.cjs${process.env.MEX_HOOK_LEXICAL === "1" ? " --lexical" : ""} --mex-managed`;
    const hooks = Object.fromEntries(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].map((event) => [event, [{ hooks: [{ type: "command", command }] }]]));
    fs.writeFileSync(".codex/hooks.json", JSON.stringify({ hooks }));
    const original = fs.existsSync("AGENTS.md") ? fs.readFileSync("AGENTS.md", "utf8") : "";
    fs.writeFileSync("AGENTS.md", original + "\n<!-- mex:hooks:start -->\nFixture managed block.\n<!-- mex:hooks:end -->\n");
    reply({});
    return;
  }
  fs.mkdirSync(".claude", { recursive: true });
  const script = `const fs=require('node:fs');let raw='';process.stdin.on('data',s=>raw+=s);process.stdin.on('end',()=>{const p=JSON.parse(raw);const event=p.hook_event_name==='UserPromptSubmit'?'prompt':p.hook_event_name==='Stop'?'stop':p.tool_name.toLowerCase();fs.mkdirSync('.mex/local',{recursive:true});fs.appendFileSync('.mex/local/context-log.jsonl',JSON.stringify({event,at:new Date().toISOString(),ms:1,ids:[],chars:0,receivedPrompt:p.prompt})+'\\n');});`;
  fs.writeFileSync(".claude/fixture.cjs", script);
  const command = `"${process.execPath.replaceAll("\\", "/")}" .claude/fixture.cjs --mex-managed`;
  const hooks = Object.fromEntries(["UserPromptSubmit", "PostToolUse", "Stop"].map((event) => [event, [{ hooks: [{ type: "command", command }] }]]));
  fs.writeFileSync(".claude/settings.json", JSON.stringify({ hooks }));
  const original = fs.existsSync("CLAUDE.md") ? fs.readFileSync("CLAUDE.md", "utf8") : "";
  fs.writeFileSync("CLAUDE.md", original + "\n<!-- mex:hooks:start -->\nFixture managed block.\n<!-- mex:hooks:end -->\n");
  reply({});
} else if (args[0] === "hooks" && args[1] === "status") reply({ installed: { kind: "bin", target: path.join(bin, "mex-hook.cmd"), exists: true } });
else reply({});
