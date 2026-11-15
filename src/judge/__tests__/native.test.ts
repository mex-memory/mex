import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { openRecord } from "../../record/index.js";
import { enqueueJob, registerJobKind, runOneBatch, requeueReadyJobs } from "../../record/jobs.js";
import { serializeEntry } from "../../knowledge/entry.js";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import { createJudgeKind, readJudgement } from "../job.js";
import { evaluate, nativeRequest, recordChecks } from "../native.js";
import { hash } from "../evidence.js";
import { pendingJudgeRequest, queuePendingJudgements } from "../pending.js";
import { ModelWaitError } from "../../model-runner/index.js";
import { refreshRuleChanges } from "../rule-change.js";
import { position } from "../evidence.js";
import { buildIndex } from "../../file-index/build.js";
import { literalPattern } from "../../file-index/classify.js";
import { indexDirectory, writePatterns } from "../../file-index/store.js";
import { runJudgeSync } from "../sync.js";
import { shortHash } from "../../record/project.js";
import { resultKey } from "../result.js";

let base: string, binary: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-judge-native-")));
  binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(base, { recursive: true, force: true }));

it("restores full labelled delivery for a fresh still-true judgment and expires it on every bound input", async () => {
  const root=join(base,"still-true-repo"),home=join(base,"still-true-home");mkdirSync(root);
  vi.stubEnv("MEX_HOME",home);vi.stubEnv("MEX_HOOK_BINARY",binary);vi.stubEnv("CODEX_THREAD_ID","");vi.stubEnv("CLAUDECODE","");
  const git=(...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8",stdio:"pipe"}).trim();
  git("init","-b","main");git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");
  const source=join(root,"settings.ts");writeFileSync(source,"export const timeout = 30; // initial\n");
  git("add",".");git("-c","commit.gpgsign=false","commit","-qm","Baseline");
  const writer=openRecord({home,projectPath:root,isNetwork:()=>false});
  try {
    const projectId=writer.checkout(root)!.project_id,id="mx_stilltrue0";
    const request={checkout:root,project_id:projectId,mex_home:home,record_directory:writer.location.directory};
    const checks=await recordChecks(request,[{kind:"source",role:"supporting",target:{file:"settings.ts"}}]);
    const path=join(root,".mex/learned",`${id}.md`);mkdirSync(join(root,".mex/learned"),{recursive:true});
    const original=serializeEntry(entry(id,{kind:"fact",checks:checks!},"The timeout is 30 seconds."));writeFileSync(path,original);
    const judgedCode="export const timeout = 30; // comment changed\n";writeFileSync(source,judgedCode);
    expect((await evaluate(request)).items![0]!.verdict).toBe("changed");
    const model=vi.fn(async()=>({selectedModel:"fixture",usage:{input:100,cache_write:0,cache_read:0,output:20,model:"fixture",estimated:false},text:JSON.stringify({results:[{id,result:"still-true"}]})}));
    registerJobKind(createJudgeKind({evaluate,recordChecks,model}));
    const job=await runJudgeSync({home,projectPath:root},{available:()=>true,write:()=>{}});
    expect(job.state).toBe("done");expect(model).toHaveBeenCalledTimes(1);
    const key=resultKey(root,id),raw=writer.setting(projectId,key)!;
    expect(JSON.parse(raw).evaluation_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const verdict=async()=>{
      const report=await nativeRequest({...request,action:"evaluate",store:true}) as {items:Array<{verdict:string;label?:string}>};
      return report.items[0]!;
    };
    expect(await verdict()).toMatchObject({verdict:"held",label:"checked by model"});
    const probe=spawnSync(binary,["--delivery-probe"],{encoding:"utf8",input:JSON.stringify({...request,entries:[id]})});
    expect(probe.status).toBe(0);expect(JSON.parse(probe.stdout).results[0]).toMatchObject({form:"full",verdict:"held"});
    expect(JSON.parse(probe.stdout).results[0].text).toContain("checked by model");
    expect(readFileSync(path,"utf8")).toBe(original);
    const set=(value:string)=>writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(value,projectId,key);
    for(const change of [
      (p:any)=>delete p.evaluation_hash,
      (p:any)=>p.evaluation_hash=hash("different checks"),
      (p:any)=>p.entry_hash=hash("different entry"),
      (p:any)=>p.position.head="b".repeat(40),
      (p:any)=>p.checkout=join(base,"another-checkout"),
      (p:any)=>p.result="cannot-tell",
      (p:any)=>p.files=[],
      (p:any)=>p.files[0].hash=null,
      (p:any)=>p.files[0].path="../settings.ts",
    ]) {
      const p=JSON.parse(raw);change(p);set(JSON.stringify(p));
      expect((await verdict()).verdict).toBe("changed");set(raw);
      expect((await verdict()).verdict).toBe("held");
    }
    set("x".repeat(129<<10));expect((await verdict()).verdict).toBe("changed");set(raw);
    writeFileSync(source,"export const timeout = 60;\n");expect((await verdict()).verdict).toBe("changed");
    writeFileSync(source,judgedCode);expect((await verdict()).verdict).toBe("held");
    writeFileSync(path,original.replace("30 seconds","60 seconds"));expect((await verdict()).verdict).toBe("changed");
    writeFileSync(path,original);expect((await verdict()).verdict).toBe("held");
    git("checkout","-b","other");expect((await verdict()).verdict).toBe("changed");
    git("checkout","main");expect((await verdict()).verdict).toBe("held");
    writer.db.prepare("DELETE FROM judgements WHERE project_id=? AND entry_id=?").run(projectId,id);
    expect((await verdict()).verdict).toBe("changed");
  } finally { writer.close(); }
});

it("runs sync through the real evaluator and routes a fake model's checked team rewrite to Review", async () => {
  const root = join(base, "sync-repo"), home = join(base, "sync-home"); mkdirSync(root);
  vi.stubEnv("MEX_HOME", home); vi.stubEnv("MEX_HOOK_BINARY", binary); vi.stubEnv("CODEX_THREAD_ID", ""); vi.stubEnv("CLAUDECODE", "");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  const file = join(root, "package.json"); writeFileSync(file, '{"scripts":{"test":"old-test"}}\n');
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "Baseline");
  const writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  try {
    const projectId = writer.checkout(root)!.project_id;
    const request = { checkout: root, project_id: projectId, mex_home: home, record_directory: writer.location.directory };
    const checks = await recordChecks(request, [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }]);
    mkdirSync(join(root, ".mex/learned"), { recursive: true });
    const path = join(root, ".mex/learned/mx_syncnat0.md"), original = serializeEntry(entry("mx_syncnat0", { kind: "fact", checks: checks! }, "The test script runs old-test."));
    writeFileSync(path, original); writeFileSync(file, '{"scripts":{"test":"new-test"}}\n');
    const model = vi.fn(async () => ({ selectedModel: "fake-cheap", usage: { input: 100, cache_write: 0, cache_read: 0, output: 20, model: "fake", estimated: false },
      text: JSON.stringify({ results: [{ id: "mx_syncnat0", result: "rewritten", text: "The test script runs new-test.", one_line: "Tests use new-test.", checks: [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }] }] }) }));
    registerJobKind(createJudgeKind({ evaluate, recordChecks, model }));
    const lines: string[] = [];
    const job = await runJudgeSync({ home, projectPath: root }, { available: () => true, write: line => lines.push(line) });
    expect(job).toMatchObject({ state: "done with gaps", results: 1 }); expect(model).toHaveBeenCalledTimes(1);
    expect(writer.db.prepare("SELECT count(*) n FROM review WHERE entry_id='mx_syncnat0'").get()!.n).toBe(1);
    expect(lines.join("\n")).toContain("checked by model"); expect(readFileSync(path, "utf8")).toBe(original);
    expect(git("diff", "--cached", "--name-only")).toBe("");
  } finally { writer.close(); }
});

it("ships distinct judge/deep CLI paths and a noninitializing dry run with no launcher or telemetry writes", () => {
  const root = join(base, "cli-sync-repo"), user = join(base, "cli-sync-user"), home = join(user, ".mex"), bin = join(base, "cli-sync-bin");
  mkdirSync(root); mkdirSync(bin);
  execFileSync("git", ["-C", root, "init", "-b", "main"], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Baseline"], { stdio: "pipe" });
  // Discovery may find this runner; executing it is always a test failure.
  writeFileSync(join(bin, process.platform === "win32" ? "claude.cmd" : "claude"), process.platform === "win32" ? "@exit /b 93\r\n" : "#!/bin/sh\nexit 93\n", { mode: 0o755 });
  const env = { ...process.env, CODEX_THREAD_ID: "", CLAUDECODE: "", MEX_HOME: user, MEX_BACKGROUND: "0", MEX_TELEMETRY: "1", MEX_HOOK_BINARY: binary, MEX_SETUP_BACKGROUND_AGENTS: "0", NO_COLOR: "1", PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  const preload = "data:text/javascript," + encodeURIComponent(`
    import https from 'node:https'; import http from 'node:http'; import child from 'node:child_process';
    import {writeFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const deny=()=>{throw new Error('Unexpected network')}; https.request=deny; http.request=deny; globalThis.fetch=deny;
    const spawn=child.spawn;
    child.spawn=(command,args,options)=>{
      if(args.includes('__background')) { writeFileSync(process.env.MEX_TEST_BG_TRACE,'attempted'); throw new Error('Unexpected background start'); }
      return spawn(command,args,options);
    };
    syncBuiltinESMExports(); Object.defineProperty(process.stderr,'isTTY',{value:true});
  `);
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", preload, resolve("dist/cli.js"), "sync", ...args], { cwd: root, env, encoding: "utf8", timeout: 15_000 });
  const missing = run("--dry-run"); expect(missing.status, missing.stderr).toBe(1); expect(missing.stderr).toContain("not registered"); expect(existsSync(user)).toBe(false);
  const writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  try {
    const before = readFileSync(writer.location.record);
    const preview = run("--dry-run"); expect(preview.status, preview.stderr + preview.stdout).toBe(0); expect(preview.stdout).toContain("Would run the knowledge judge");
    expect(existsSync(join(home, "config.json"))).toBe(false); expect(existsSync(join(home, "bin/launcher.json"))).toBe(false);
    expect(readFileSync(writer.location.record)).toEqual(before);
    const warning = run("--dry-run", "--warnings"); expect(warning.status).toBe(1); expect(warning.stderr).toContain("--deep --warnings");
    const normal = run(); expect(normal.status, normal.stderr + normal.stdout).toBe(0); expect(normal.stdout).toContain("Knowledge judge: done"); expect(normal.stdout).not.toContain("Running drift check");
    const projectId = writer.checkout(root)!.project_id;
    const held = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "claude", near: [] } }).job;
    const paused = join(writer.location.directory, "hook-paused"); mkdirSync(paused);
    writeFileSync(join(paused, shortHash("codex\0paused-sync")), ""); writeFileSync(join(home, "jobs-pending"), "");
    const trace = join(base, "sync-background-attempt");
    Object.assign(env, { CODEX_THREAD_ID: "paused-sync", MEX_BACKGROUND: "", MEX_TELEMETRY: "0", MEX_TEST_BG_TRACE: trace });
    const pausedRun = run(); expect(pausedRun.status, pausedRun.stderr + pausedRun.stdout).toBe(0); expect(pausedRun.stdout).toContain("paused in this session");
    expect(existsSync(trace)).toBe(false); expect(writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(held.id)!.state).toBe("queued");
    Object.assign(env, { CODEX_THREAD_ID: "", MEX_BACKGROUND: "0" });
    mkdirSync(join(root, ".mex")); writeFileSync(join(root, ".mex/ROUTER.md"), "---\nname: router\ndescription: Fixture\n---\n# Fixture\n");
    const deep = run("--deep", "--dry-run", "--warnings"); expect(deep.status, deep.stderr + deep.stdout).toBe(0); expect(deep.stdout).toContain("Running drift check"); expect(deep.stdout).not.toContain("Knowledge judge:");
    expect(existsSync(join(root, ".mex/config.json"))).toBe(false);
    const help = run("--help"); expect(help.stdout).toContain("--deep");
  } finally { writer.close(); }
});

it("finishes every free page before model admission and retains more than 128 active signals",async()=>{
  const root=join(base,"paged-repo"),home=join(base,"paged-home");mkdirSync(root);
  vi.stubEnv("MEX_HOME",home);vi.stubEnv("MEX_HOOK_BINARY",binary);
  const git=(...args:string[])=>execFileSync("git",["-C",root,...args],{stdio:"pipe"});
  git("init","-b","migrate-specialSubject");git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-qm","Baseline");
  const writer=openRecord({home,projectPath:root,isNetwork:()=>false});
  try {
    const projectId=writer.checkout(root)!.project_id,request={checkout:root,project_id:projectId,mex_home:home,record_directory:writer.location.directory};
    mkdirSync(join(root,".mex/learned"),{recursive:true});
    for(let i=0;i<129;i++) {
      const id=`mx_bulk${String(i).padStart(4,"0")}`;
      writeFileSync(join(root,".mex/learned",`${id}.md`),serializeEntry(entry(id,{when:[{type:"anti",match:"literal",pattern:"specialSubject("}]})));
    }
    const model=vi.fn(async()=>{throw new ModelWaitError("cap");});registerJobKind(createJudgeKind({evaluate,recordChecks,model}));
    const {job}=enqueueJob(writer,{kind:"judge",projectId,params:{checkout:root,agent:"codex",near:[]}});
    const run=()=>runOneBatch(writer,"paged-native",{only:new Set([job.id])});
    await run();expect(model).not.toHaveBeenCalled();expect(writer.db.prepare("SELECT count(*) n FROM review").get()!.n).toBe(128);
    await run();expect(model).toHaveBeenCalledTimes(1);expect(writer.db.prepare("SELECT count(*) n FROM review").get()!.n).toBe(129);
    expect((await evaluate(request)).items!.filter(item=>item.rule_evidence?.length)).toHaveLength(129);
  } finally {writer.close();}
});

it("publishes free rule evidence and Review before the cap, invalidates new files, and never sends the old policy in a brief", async () => {
  const root=join(base,"rule-repo"),home=join(base,"rule-home");mkdirSync(root);mkdirSync(join(root,"src"));
  vi.stubEnv("MEX_HOME",home);vi.stubEnv("MEX_HOOK_BINARY",binary);
  const git=(...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8",stdio:"pipe"}).trim();
  git("init","-b","work");git("config","user.name","Test");git("config","user.email","test@example.invalid");
  writeFileSync(join(root,"src/dates.ts"),"datefns();datefns();\n");git("add",".");git("commit","-qm","Baseline");
  const writer=openRecord({home,projectPath:root,isNetwork:()=>false});
  try {
    const projectId=writer.checkout(root)!.project_id,request={checkout:root,project_id:projectId,mex_home:home,record_directory:writer.location.directory};
    mkdirSync(join(root,".mex/learned"),{recursive:true});
    const value=entry("mx_policy0",{scope:["src/**"],when:[{type:"anti",match:"literal",pattern:"moment("},{type:"required",match:"literal",pattern:"datefns("}],checks:[
      {kind:"pattern",role:"supporting",target:{scope:"src/**",pattern:"moment(",match:"literal"},saw:{count:0},files:{}},
      {kind:"pattern",role:"supporting",target:{scope:"src/**",pattern:"datefns(",match:"literal"},saw:{count:2},files:{}}
    ]},"Dates use datefns because that is the convention.");
    const file=join(root,".mex/learned/mx_policy0.md"),original=serializeEntry(value);writeFileSync(file,original);
    writeFileSync(join(root,"src/dates.ts"),"moment();datefns();\n");
    writePatterns(indexDirectory(writer.location.directory,projectId),[literalPattern("moment("),literalPattern("datefns(")]);
    await buildIndex({root,projectId,recordDirectory:writer.location.directory,workers:0});
    const model=vi.fn(async(_request: {prompt:string})=>{throw new ModelWaitError("cap");});
    registerJobKind(createJudgeKind({evaluate,recordChecks,model}));
    const {job}=enqueueJob(writer,{kind:"judge",projectId,params:{checkout:root,agent:"codex",near:["src/dates.ts"]}});
    await runOneBatch(writer,"rule-native",{only:new Set([job.id])});
    expect(writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id)!.state).toBe("waiting");
    expect(writer.db.prepare("SELECT reason FROM review WHERE entry_id='mx_policy0'").get()!.reason).toContain("free evidence");
    expect(model).toHaveBeenCalledTimes(1);expect(model.mock.calls[0]![0]!.prompt).toContain("rule_change");
    expect((await evaluate(request)).items![0]).toMatchObject({verdict:"changed",rule_evidence:[expect.stringContaining("count rose")]});
    const brief=JSON.parse(execFileSync(binary,["--brief-run"],{encoding:"utf8",input:JSON.stringify({...request,path:"src/dates.ts",agent:"codex"})}));
    expect(brief.ok).toBe(true);expect(brief.items).toEqual([]);
    writeFileSync(join(root,"src/new.ts"),"datefns();datefns();\n");
    expect((await evaluate(request)).items![0]!.rule_evidence).toBeUndefined();
    const fresh=await evaluate(request);await refreshRuleChanges(writer,projectId,root,fresh,await position(root));
    expect((await evaluate(request)).items![0]!.rule_evidence).toBeUndefined();
    expect(readFileSync(file,"utf8")).toBe(original);expect(git("diff","--cached","--name-only")).toBe("");
  } finally {writer.close();}
});

it("takes a real broken verdict through a fake judge and records current checks without changing either database owner", async () => {
  const root = join(base, "repo"), home = join(base, "home"); mkdirSync(root);
  vi.stubEnv("MEX_HOME", home); vi.stubEnv("MEX_HOOK_BINARY", binary);
  const writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  try {
    const projectId = writer.checkout(root)!.project_id;
    const request = { checkout: root, project_id: projectId, mex_home: home, record_directory: writer.location.directory };
    const path = join(root, "package.json");
    const before = '{"scripts":{"test":"old-test"}}\n', after = '{"scripts":{"test":"new-test"}}\n';
    writeFileSync(path, before);
    const checks = await recordChecks(request, [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }]);
    expect(checks).toHaveLength(1);
    mkdirSync(join(root, ".mex/learned"), { recursive: true });
    const file = join(root, ".mex/learned/mx_native0.md");
    const original = serializeEntry(entry("mx_native0", { kind: "fact", checks: checks! }, "The test script runs old-test."));
    writeFileSync(file, original); writeFileSync(path, after);
    expect((await evaluate(request)).items?.[0]?.verdict).toBe("broken");
    const model = vi.fn(async () => ({ selectedModel: "fake-cheap", usage: { input: 100, cache_write: 0, cache_read: 0, output: 20, model: "fake", estimated: false },
      text: JSON.stringify({ results: [{ id: "mx_native0", result: "rewritten", text: "The test script runs new-test.", one_line: "Tests use new-test.", checks: [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }] }] }) }));
    registerJobKind(createJudgeKind({ evaluate, recordChecks, model }));
    const { job } = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "codex", near: ["package.json"] } });
    await runOneBatch(writer, "native-test", { only: new Set([job.id]) });
    const result = readJudgement(writer, projectId, root, "mx_native0");
    expect(model).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ result: "rewritten", label: "checked by model", rewrite: { mex: { checks: [{ kind: "key", saw: { value: "new-test" }, files: { "package.json": hash(after) } }] } } });
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(path, "utf8")).toBe(after);
    expect((await evaluate(request)).items?.[0]?.verdict).toBe("broken");
  } finally { writer.close(); }
});

it("routes a real paired hook edit through a visible preview to the same PR without a second model call", async () => {
  const root = join(base, "owned-repo"), userHome = join(base, "owned-home"), home = join(userHome, ".mex"); mkdirSync(root);
  vi.stubEnv("MEX_HOME", userHome); vi.stubEnv("MEX_HOOK_BINARY", binary);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "work"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  const path = join(root, "package.json"), before = '{"scripts":{"test":"old-test"}}\n', after = '{"scripts":{"test":"new-test"}}\n';
  writeFileSync(path, before); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
  const writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  try {
    const projectId = writer.checkout(root)!.project_id;
    const request = { checkout: root, project_id: projectId, mex_home: home, record_directory: writer.location.directory };
    const checks = await recordChecks(request, [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }]);
    mkdirSync(join(root, ".mex/learned"), { recursive: true });
    const file = join(root, ".mex/learned/mx_owned00.md"), original = serializeEntry(entry("mx_owned00", { kind: "fact", checks: checks! }, "The test script runs old-test."));
    writeFileSync(file, original); git("add", ".mex"); git("-c", "commit.gpgsign=false", "commit", "-qm", "entry");
    const hook = (event: string, payload: Record<string, unknown> = {}) => JSON.parse(execFileSync(binary, ["claude-code", event], {
      encoding: "utf8", timeout: 20_000, env: { ...process.env, MEX_HOME: userHome },
      input: JSON.stringify({ session_id: "editing", cwd: root, hook_event_name: event, ...payload }),
    }));
    hook("SessionStart", { source: "startup" });
    const tool = { tool_name: "Edit", tool_input: { file_path: path, old_string: "old-test", new_string: "new-test" } };
    hook("PreToolUse", tool); writeFileSync(path, after); hook("PostToolUse", { ...tool, tool_response: { success: true } }); hook("Stop");
    const model = vi.fn(async () => ({ selectedModel: "fake-cheap", usage: { input: 100, cache_write: 0, cache_read: 0, output: 20, model: "fake", estimated: false },
      text: JSON.stringify({ results: [{ id: "mx_owned00", result: "rewritten", text: "The test script runs new-test.", one_line: "Tests use new-test.", checks: [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }] }] }) }));
    registerJobKind(createJudgeKind({ evaluate, recordChecks, model }));
    const pending = pendingJudgeRequest(writer.location.directory, root);
    expect(pending).toMatchObject({ reason: "idle", session_id: "editing", near: ["package.json"] });
    expect(pending!.not_before).toBeLessThanOrEqual(Date.now());
    // A transient hook-store read can defer dispatch to the next background
    // pass. Keep the idle requirement above; never wait out an edit debounce.
    await expect.poll(() => queuePendingJudgements(writer, enqueueJob), { timeout: 2000, interval: 20 }).toBe(1);
    expect(writer.db.prepare("SELECT count(*) n FROM jobs WHERE kind='judge'").get()!.n).toBe(1);
    const job = writer.db.prepare("SELECT id FROM jobs WHERE kind='judge'").get()!;
    const run = () => runOneBatch(writer, "owned-native-test", { only: new Set([job.id as string]) });
    await run(); await run();
    expect(writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id!)!.state).toBe("waiting");
    expect(readFileSync(file, "utf8")).toBe(original);
    const reply = hook("UserPromptSubmit", { prompt: "continue" });
    expect(reply.systemMessage).toContain("-The test script runs old-test."); expect(reply.systemMessage).toContain("+The test script runs new-test.");
    expect(requeueReadyJobs(writer)).toBe(1); await run(); await run();
    expect(writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id!)!.state).toBe("done");
    expect(model).toHaveBeenCalledTimes(1); expect(readFileSync(file, "utf8")).toContain("The test script runs new-test.");
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(git("diff", "--name-only").split("\n")).toEqual([".mex/learned/mx_owned00.md", "package.json"]);
    expect((await evaluate(request)).items?.[0]?.verdict).toBe("held");
    expect(hook("UserPromptSubmit", { prompt: "continue" }).systemMessage).toContain("same PR");
  } finally { writer.close(); }
});
