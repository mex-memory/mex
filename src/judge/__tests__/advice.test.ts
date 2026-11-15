import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { serializeEntry } from "../../knowledge/entry.js";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import type { NativeReport } from "../../knowledge/check.js";
import { hash, position } from "../evidence.js";
import { what } from "../../knowledge/what.js";
import { adviceOrigin } from "../advice-history.js";
import { adviceReport, formatAdvice, refreshAdvice, wrongAllAlong } from "../advice.js";

let base: string, binary: string, root: string, home: string, writer: RecordWriter, hooks: DatabaseSync, project: string, content: string, baseline: string;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const commit = (message: string) => { git("add", "package.json"); git("-c", "commit.gpgsign=false", "commit", "-qm", message); return git("rev-parse", "HEAD"); };
const old = '{"packageManager":"npm"}\n', current = '{"packageManager":"pnpm"}\n';
const note = () => entry("mx_advice", { kind: "fact", one_line: "Use npm.", checks: [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/packageManager" }, saw: { value: "npm" }, files: { "package.json": hash(old) } }] }, "Use npm.");
function receipt(id: string, head: string, branch = "refs/heads/work", entryHash = hash(content)) {
  hooks.prepare("INSERT INTO deliveries(id,project_id,checkout,agent_id,epoch,session_id,entry_id,form,action,moment,detail) VALUES(?,?,?,'',0,?,?,?,'given','read',?)").run(id, project, root, "session-"+id, "mx_advice", "full", JSON.stringify({ version: 1, branch, head, entry_hash: entryHash, verdict: "held", inputs_hash: hash([`entry ${entryHash}`,`file package.json ${hash(head===baseline?old:current)}`,`file package.json ${hash(head===baseline?old:current)}`].sort().join("\n")) }));
}
function report(): NativeReport { return { ok: true, stored: false, problems: [], items: [{ id: "mx_advice", path: join(root,".mex/learned/mx_advice.md"), level: "team", kind: "fact", status: "active", verdict: "broken", entry_hash: hash(content) }],
  results: [{ entry_id: "mx_advice", verdict: "broken", checks: [{ index: 0, kind: "key", role: "complete", status: "fail" }], inputs: { "package.json": hash(readFileSync(join(root,"package.json"),"utf8")) } }] }; }
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(),"mex-advice-"))); binary=join(base,process.platform==="win32"?"mex-hook.exe":"mex-hook");
  execFileSync("go",["build","-o",binary,"./cmd/mex-hook"],{cwd:resolve("native"),stdio:"pipe",timeout:240_000});
},300_000);
beforeEach(() => {
  const folder=realpathSync(mkdtempSync(join(base,"case-"))); root=join(folder,"repo"); home=join(folder,"home"); mkdirSync(root);
  git("init","-q","-b","work"); git("config","user.name","Fixture"); git("config","user.email","fixture@example.invalid");
  writeFileSync(join(root,"package.json"),old); baseline=commit("baseline");
  content=serializeEntry(note()); mkdirSync(join(root,".mex/learned"),{recursive:true}); writeFileSync(join(root,".mex/learned/mx_advice.md"),content);
  vi.stubEnv("MEX_HOME",home); vi.stubEnv("MEX_HOOK_BINARY",binary);
  writer=openRecord({home,projectPath:root,isNetwork:()=>false}); project=writer.checkout(root)!.project_id;
  hooks=new DatabaseSync(writer.location.hooks);
  hooks.exec(`CREATE TABLE deliveries(id TEXT PRIMARY KEY,project_id TEXT,checkout TEXT,agent_id TEXT,epoch INTEGER,session_id TEXT,entry_id TEXT,form TEXT,action TEXT,moment TEXT,detail TEXT,title TEXT DEFAULT '',kind TEXT DEFAULT 'fact',level TEXT DEFAULT 'team');
    CREATE TABLE epochs(session_id TEXT,agent_id TEXT,epoch INTEGER,closed INTEGER);
    CREATE TABLE delivery_touches(delivery_id TEXT);
    CREATE TABLE followups(id INTEGER PRIMARY KEY,delivery_id TEXT,kind TEXT,detail TEXT);
    PRAGMA user_version=6`);
});
afterEach(()=>{hooks.close();writer.close();vi.unstubAllEnvs();});
afterAll(()=>rmSync(base,{recursive:true,force:true}));

it("proves outdated-since C, separates earlier held observations, and keeps named follow-ups in Review/report",async()=>{
  receipt("before",baseline);
  writeFileSync(join(root,"package.json"),current); const changed=commit("change package manager"); receipt("after",changed);
  const effect={version:1,key:"a".repeat(64),summary:"edited .github/workflows/ci.yml",external:false};
  hooks.prepare("INSERT INTO followups(delivery_id,kind,detail) VALUES('after','edit',?)").run(JSON.stringify(effect));
  await refreshAdvice(writer,project,root,report(),await position(root),()=>true);
  const out=await adviceReport({projectPath:root,home}); expect(out.advisories).toHaveLength(1);
  const advisory=out.advisories[0]!;
  expect(advisory.origin).toMatchObject({kind:"outdated-since",commit:changed,previous:baseline,held_inputs_hash:expect.stringMatching(/^sha256:/),evidence:"complete checks on first-parent history"});
  expect(advisory.receipts.find(r=>r.id==="before")!.before_change).toBe(true);
  expect(advisory.receipts.find(r=>r.id==="after")!.before_change).toBe(false);
  expect(formatAdvice(advisory)).toContain("edited .github/workflows/ci.yml");
  expect(writer.db.prepare("SELECT reason,state FROM review").get()).toMatchObject({state:"pending",reason:expect.stringContaining("Advice already used")});
  await refreshAdvice(writer,project,root,report(),await position(root),()=>true);
  expect(writer.db.prepare("SELECT count(*) n FROM review").get()!.n).toBe(1);
  git("switch","-c","unrelated"); expect((await adviceReport({projectPath:root,home})).advisories).toEqual([]);
  git("switch","work"); expect((await adviceReport({projectPath:root,home})).advisories).toHaveLength(1);
  hooks.prepare("DELETE FROM followups WHERE delivery_id='after'").run(); hooks.prepare("DELETE FROM deliveries WHERE id='after'").run();
  await refreshAdvice(writer,project,root,report(),await position(root),()=>true);
  expect(formatAdvice((await adviceReport({projectPath:root,home})).advisories[0]!)).toContain("edited .github/workflows/ci.yml");
});
it("keeps wrong-all-along distinct and labels every use suspect only after explicit confirmation",async()=>{
  receipt("first",baseline); receipt("second",baseline,"refs/heads/work",hash("an older version")); receipt("other",baseline,"refs/heads/other");
  await wrongAllAlong("mx_advice",{projectPath:root,home});
  const result=await adviceReport({projectPath:root,home}); expect(result.advisories).toHaveLength(1);
  const advisory=result.advisories[0]!; expect(advisory.origin).toEqual({kind:"wrong-all-along",evidence:"person-confirmed"});
  expect(advisory.receipts).toHaveLength(2); expect(advisory.receipts.every(r=>!r.before_change)).toBe(true);
  expect(formatAdvice(advisory)).toContain("every recorded use is suspect");
  git("switch","-c","other"); expect((await adviceReport({projectPath:root,home})).advisories[0]!.receipts.map(r=>r.id)).toEqual(["other"]);
});
it("leaves uncommitted, incomplete and unavailable history unknown",async()=>{
  writeFileSync(join(root,"package.json"),current);
  expect(await adviceOrigin(root,note(),content,await position(root))).toEqual({kind:"unknown"});
  const incomplete=note(); incomplete.mex.checks[0]!.role="supporting";
  expect(await adviceOrigin(root,incomplete,serializeEntry(incomplete),await position(root))).toEqual({kind:"unknown"});
  git("config","core.quotePath","false");
  expect(await adviceOrigin(root,note(),content,{branch:"refs/heads/work",head:"f".repeat(40)})).toEqual({kind:"unknown"});
});
it("rejects stale source, entry-version and ownership proofs",async()=>{
  receipt("old-version",baseline,"refs/heads/work",hash("other content"));
  writeFileSync(join(root,"package.json"),current); commit("switch");
  await refreshAdvice(writer,project,root,report(),await position(root),()=>true);
  expect((await adviceReport({projectPath:root,home})).advisories).toEqual([]);
  receipt("current",baseline);
  await refreshAdvice(writer,project,root,report(),await position(root),()=>false);
  const stale=report(); writeFileSync(join(root,"package.json"),old);
  await refreshAdvice(writer,project,root,stale,await position(root),()=>true);
  expect((await adviceReport({projectPath:root,home})).advisories).toEqual([]);
});
it("rejects redirected hint storage without writing outside the record",async()=>{
  const outside=join(base,"outside"); mkdirSync(outside,{recursive:true});
  symlinkSync(outside,join(writer.location.directory,"judge-advice"),process.platform==="win32"?"junction":"dir");
  receipt("used",baseline); writeFileSync(join(root,"package.json"),current); commit("switch");
  await expect(refreshAdvice(writer,project,root,report(),await position(root),()=>true)).rejects.toThrow();
});

it("prepares every free correction page before asking for any model work",async()=>{
  writeFileSync(join(root,"package.json"),current); commit("switch");
  const large=report(); large.items=[]; large.results=[];
  for(let n=0;n<6;n++) {
    const id=`mx_used0${n}`, value=note(); value.mex.id=id;
    const text=serializeEntry(value), path=join(root,".mex/learned",`${id}.md`); writeFileSync(path,text);
    hooks.prepare("INSERT INTO deliveries(id,project_id,checkout,agent_id,epoch,session_id,entry_id,form,action,moment,detail) VALUES(?,?,?,'',0,?,?,?,'given','read',?)").run(`used${n}`,project,root,`session${n}`,id,"full",JSON.stringify({version:1,branch:"refs/heads/work",head:baseline,entry_hash:hash(text),verdict:"held",inputs_hash:"unverified"}));
    large.items.push({...report().items![0]!,id,path,entry_hash:hash(text)}); large.results.push({...report().results![0]!,entry_id:id});
  }
  expect(await refreshAdvice(writer,project,root,large,await position(root),()=>true)).toBe(true);
  expect(writer.db.prepare("SELECT count(*) n FROM review").get()!.n).toBe(5);
  expect(await refreshAdvice(writer,project,root,large,await position(root),()=>true)).toBe(false);
  expect(writer.db.prepare("SELECT count(*) n FROM review").get()!.n).toBe(6);
});


it("keeps temporal command associations out of advice-following estimates",()=>{
  receipt("unrelated",baseline);
  hooks.prepare("INSERT INTO epochs VALUES('session-unrelated','',0,1)").run();
  hooks.prepare("INSERT INTO followups(delivery_id,kind,detail) VALUES('unrelated','command',?)").run(JSON.stringify({version:1,key:"b".repeat(64),summary:"ran a shell command (arguments omitted)",external:false}));
  const summary=()=>what({projectPath:root,home},"session-unrelated");
  expect(summary()).toMatchObject({gave:1,closedDeliveries:1,estimatedFalse:1});
  hooks.prepare("INSERT INTO followups(delivery_id,kind,detail) VALUES('unrelated','followed',NULL)").run();
  expect(summary().estimatedFalse).toBe(0);
});

it("recomputes the transition after recovery and a second break",async()=>{
  receipt("before",baseline);
  writeFileSync(join(root,"package.json"),current); const first=commit("first break");
  await refreshAdvice(writer,project,root,report(),await position(root),()=>true);
  expect((await adviceReport({projectPath:root,home})).advisories[0]!.origin).toMatchObject({kind:"outdated-since",commit:first});
  writeFileSync(join(root,"package.json"),old); commit("recovery");
  writeFileSync(join(root,"package.json"),current); const second=commit("second break");
  await refreshAdvice(writer,project,root,report(),await position(root),()=>true);
  expect((await adviceReport({projectPath:root,home})).advisories[0]!.origin).toMatchObject({kind:"outdated-since",commit:second});
  // An unsupported new history must not inherit the prior transition either.
  git("checkout","--orphan","replacement"); git("rm","--cached","package.json"); commit("unrelated history");
  git("branch","-M","work");
  await refreshAdvice(writer,project,root,report(),await position(root),()=>true);
  expect((await adviceReport({projectPath:root,home})).advisories[0]!.origin).toEqual({kind:"unknown"});
});

it("finds matching receipts before applying the per-entry scan bound",async()=>{
  receipt("relevant",baseline);
  for(let n=0;n<130;n++) receipt(`other-${n}`,baseline,"refs/heads/other");
  writeFileSync(join(root,"package.json"),current); commit("break");
  await refreshAdvice(writer,project,root,report(),await position(root),()=>true);
  expect((await adviceReport({projectPath:root,home})).advisories[0]?.receipts.map(r=>r.id)).toEqual(["relevant"]);
});

it("filters report checkout and branch before its work bound",async()=>{
  receipt("relevant",baseline); await wrongAllAlong("mx_advice",{projectPath:root,home});
  const existing=writer.db.prepare("SELECT key,value FROM settings WHERE key GLOB 'advice.*'").get()!;
  const value=JSON.parse(String(existing.value));
  const put=writer.db.prepare("INSERT INTO settings VALUES(?,?,?)"), review=writer.db.prepare("INSERT INTO review(id,project_id,entry_id,reason,state,created_at) VALUES(?,?,?,'other','pending','2099-01-01')");
  for(let n=0;n<201;n++) {
    const id=`advice.${n.toString(16).padStart(24,"0")}`;
    put.run(project,id,JSON.stringify({...value,id,branch:"refs/heads/other"})); review.run(id,project,"mx_advice");
  }
  const result=await adviceReport({projectPath:root,home});
  expect(result.advisories).toHaveLength(1); expect(result.partial).toBe(false);
});

it.skipIf(process.platform==="win32")("never treats a historical symlink parent as a missing target",async()=>{
  mkdirSync(join(root,"src")); writeFileSync(join(root,"src/config.json"),old);
  git("add","src"); git("-c","commit.gpgsign=false","commit","-qm","directory baseline");
  const value=note(); value.mex.checks[0]!.target={file:"src/config.json",pointer:"/packageManager"}; value.mex.checks[0]!.files={"src/config.json":hash(old)};
  mkdirSync(join(root,"backing")); writeFileSync(join(root,"backing/config.json"),old);
  rmSync(join(root,"src"),{recursive:true}); symlinkSync("backing",join(root,"src"));
  git("add","src","backing"); git("-c","commit.gpgsign=false","commit","-qm","same content through a link");
  unlinkSync(join(root,"src")); mkdirSync(join(root,"src")); writeFileSync(join(root,"src/config.json"),current);
  git("add","src"); git("-c","commit.gpgsign=false","commit","-qm","actual break");
  expect(await adviceOrigin(root,value,serializeEntry(value),await position(root))).toEqual({kind:"unknown"});
});

it("assesses actions independently of an earlier valid delivery",async()=>{
  receipt("before",baseline);
  writeFileSync(join(root,"package.json"),current); commit("break");
  await refreshAdvice(writer,project,root,report(),await position(root),()=>true);
  const value=(await adviceReport({projectPath:root,home})).advisories[0]!;
  expect(value.origin.kind).toBe("outdated-since"); if(value.origin.kind!=="outdated-since") throw Error("missing transition");
  const insert=hooks.prepare("INSERT INTO followups(delivery_id,kind,detail) VALUES('before','command',?)");
  insert.run(JSON.stringify({version:1,key:"c".repeat(64),summary:"ran before the change",external:false,observed:{branch:"refs/heads/work",head:baseline,verdict:"held",inputs_hash:value.origin.held_inputs_hash}}));
  insert.run(JSON.stringify({version:1,key:"d".repeat(64),summary:"ran after the change",external:false,observed:{branch:"refs/heads/work",head:git("rev-parse","HEAD"),verdict:"broken",inputs_hash:"sha256:"+"e".repeat(64)}}));
  const rendered=formatAdvice((await adviceReport({projectPath:root,home})).advisories[0]!);
  expect(rendered).toContain("ran before the change — checks held at this action");
  expect(rendered).toContain("ran after the change — review this action (timing unverified)");
  expect(rendered).not.toContain("inputs held before the change");
});

it("proves a nested-file transition without enumerating unrelated siblings",async()=>{
  mkdirSync(join(root,"src")); writeFileSync(join(root,"src/config.json"),old);
  for(let n=0;n<800;n++) writeFileSync(join(root,"src",`${String(n).padStart(3,"0")}-${"x".repeat(48)}.ts`),"x");
  git("add","src"); git("-c","commit.gpgsign=false","commit","-qm","nested baseline");
  const value=note(); value.mex.checks[0]!.target={file:"src/config.json",pointer:"/packageManager"}; value.mex.checks[0]!.files={"src/config.json":hash(old)};
  writeFileSync(join(root,"src/config.json"),current); git("add","src/config.json"); git("-c","commit.gpgsign=false","commit","-qm","nested break");
  expect(await adviceOrigin(root,value,serializeEntry(value),await position(root))).toMatchObject({kind:"outdated-since",commit:git("rev-parse","HEAD")});
});

it("discovers distinct historical branches before the receipt bound",async()=>{
  receipt("other",baseline,"refs/heads/other");
  for(let n=0;n<130;n++) receipt(`current-${n}`,baseline);
  await wrongAllAlong("mx_advice",{projectPath:root,home});
  git("switch","-c","other");
  expect((await adviceReport({projectPath:root,home})).advisories[0]?.receipts.map(r=>r.id)).toEqual(["other"]);
});
