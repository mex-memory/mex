import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord } from "../../record/index.js";
import { enqueueJob, registerJobKind, runOneBatch, requeueReadyJobs } from "../../record/jobs.js";
import { serializeEntry } from "../../knowledge/entry.js";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import { createJudgeKind, readJudgement } from "../job.js";
import { evaluate, recordChecks } from "../native.js";
import { hash } from "../evidence.js";
import { pendingJudgeRequest, queuePendingJudgements } from "../pending.js";
import { ModelWaitError } from "../../model-runner/index.js";
import { refreshRuleChanges } from "../rule-change.js";
import { position } from "../evidence.js";
import { buildIndex } from "../../file-index/build.js";
import { literalPattern } from "../../file-index/classify.js";
import { indexDirectory, writePatterns } from "../../file-index/store.js";

let base: string, binary: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-judge-native-")));
  binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(base, { recursive: true, force: true }));

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
