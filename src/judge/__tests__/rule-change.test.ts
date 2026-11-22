import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { realPath } from "../../record/project.js";
import { serializeEntry, type KnowledgeEntry } from "../../knowledge/entry.js";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import type { NativeReport } from "../../knowledge/check.js";
import { hash, position } from "../evidence.js";
import { refreshRuleChanges, ruleChangeKey, titleChangesRule } from "../rule-change.js";

let base:string,root:string,writer:RecordWriter,projectId:string,report:NativeReport;
const git=(...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8",stdio:"pipe"}).trim();
function source(path:string,text:string){mkdirSync(join(root,path,".."),{recursive:true});writeFileSync(join(root,path),text);}
function add(value:KnowledgeEntry,verdict:"held"|"changed"="held") {
 const path=join(root,".mex/learned",`${value.mex.id}.md`),content=serializeEntry(value);source(`.mex/learned/${value.mex.id}.md`,content);
 report.items!.push({id:value.mex.id,path,level:"team",kind:value.mex.kind,status:"active",verdict,entry_hash:hash(content)});
 report.results!.push({entry_id:value.mex.id,verdict,checks:value.mex.checks.flatMap((c,index)=>c.kind==="pattern"?[{index,kind:"pattern",role:c.role,status:"pass" as const,now:c.saw.count}]:[]),inputs:Object.assign({},...value.mex.checks.map(c=>c.files))});return path;
}
const rule=()=>entry("mx_policy0",{created:"2026-11-01",scope:["src/**"],one_line:"Dates use datefns.",when:[{type:"anti",match:"literal",pattern:"moment("},{type:"required",match:"literal",pattern:"datefns("}],checks:[
 {kind:"pattern",role:"supporting",target:{scope:"src/**",pattern:"moment(",match:"literal"},saw:{count:0},files:{}},
 {kind:"pattern",role:"supporting",target:{scope:"src/**",pattern:"datefns(",match:"literal"},saw:{count:2},files:{}}
]});
const refresh=async()=>refreshRuleChanges(writer,projectId,root,report,await position(root));
function observe(anti:number,required:number){report.results![0]!.checks.forEach(r=>{r.now=r.index===0?anti:required;r.status="fail";});}
beforeEach(()=>{
 base=realPath(mkdtempSync(join(tmpdir(),"mex-rule-change-")));root=join(base,"repo");mkdirSync(root);
 vi.stubEnv("MEX_HOME",join(base,"home"));git("init","-b","work");git("config","user.name","Test");git("config","user.email","test@example.invalid");
 source("src/main.ts","datefns(); datefns();\n");git("add",".");git("commit","-qm","Initial fixture");
 writer=openRecord({home:join(base,"home"),projectPath:root,isNetwork:()=>false});projectId=writer.checkout(root)!.project_id;
 report={ok:true,stored:false,items:[],results:[],problems:[]};
});
afterEach(()=>{writer.close();vi.unstubAllEnvs();rmSync(base,{recursive:true,force:true});});

describe("free rule-change evidence",()=>{
 it("does not use a migration title older than the exact committed entry revision",async()=>{
  const value=rule(),file=add(value);git("add",".");git("commit","-qm","Add original policy");
  git("commit","--allow-empty","-qm","Replace moment");
  value.mex.one_line="Dates have an explicitly refreshed policy.";value.text="The dates policy has been reviewed against current code.";
  const content=serializeEntry(value);writeFileSync(file,content);report.items![0]!.entry_hash=hash(content);
  git("add",".");git("commit","-qm","Review current policy");
  expect((await refresh()).snapshot.entries).toEqual([]);
 });
 it("does not turn a newer code fact into evidence that a policy reversed",async()=>{
  add(rule());source("docs/dates.md","A legacy adapter calls moment.\n");
  add(entry("mx_newfact",{kind:"fact",created:"2026-11-02",scope:["src/**"],source:{type:"docs",ref:"docs/dates.md"},evidence:"docs",when:[{type:"required",match:"literal",pattern:"moment("}],checks:[{kind:"source",role:"supporting",target:{file:"docs/dates.md"},saw:{hash:hash("A legacy adapter calls moment.\n")},files:{"docs/dates.md":hash("A legacy adapter calls moment.\n")}}]}));
  expect((await refresh()).snapshot.entries).toEqual([]);
 });
 it("keeps a personal policy under the personal-note contract",async()=>{
  const value=rule(),content=serializeEntry(value),path=join(writer.location.home,"projects",projectId,"notes",`${value.mex.id}.md`);
  mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,content);
  report.items!.push({id:value.mex.id,path,level:"personal",kind:"rule",status:"active",verdict:"held",entry_hash:hash(content)});
  git("switch","-c","migrate-moment");
  expect((await refresh()).snapshot.entries).toEqual([]);
  expect(writer.db.prepare("SELECT count(*) n FROM review").get()!.n).toBe(0);
 });
 it("records a migration for a personal learned rule",async()=>{
  const value=rule();
  value.mex.id=`mx_deep${"a".repeat(32)}`;
  value.mex.source={type:"docs",ref:"README.md",producer:"learn-deeper"};
  value.mex.evidence="docs";
  add(value);
  const content=serializeEntry(value),path=join(writer.location.home,"projects",projectId,"notes",`${value.mex.id}.md`);
  mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,content);
  Object.assign(report.items![0]!,{path,level:"personal"});
  source("src/main.ts","moment(); datefns();\n");observe(1,1);
  const signal=(await refresh()).snapshot.entries[0];
  expect(signal?.id).toBe(value.mex.id);
  expect(signal?.reasons).toContain("In scope, the anti-pattern count rose and the required-pattern count fell");
 });
 it("advances beyond the first page while retaining earlier evidence",async()=>{
  for(let i=0;i<129;i++) {
   const value=rule();value.mex.id=`mx_page${String(i).padStart(4,"0")}`;
   value.mex.when=[{type:"anti",match:"literal",pattern:i===0||i===128?"specialSubject(":"neutralPattern("}];value.mex.checks=[];
   add(value);
  }
  git("switch","-c","migrate-specialSubject");
  const first=await refresh();expect(first.snapshot.entries.map(e=>e.id)).toEqual(["mx_page0000"]);
  const second=await refresh();expect(second.snapshot.entries.map(e=>e.id)).toEqual(["mx_page0000","mx_page0128"]);
 });
 it("requires both count directions in the same scoped pair; conformance alone is not a migration",async()=>{
  const file=add(rule()),before=readFileSync(file,"utf8");source("src/main.ts","moment(); datefns(); datefns();\n");observe(1,2);
  expect((await refresh()).snapshot.entries).toEqual([]);
  source("src/main.ts","moment(); datefns();\n");observe(1,1);source("outside.ts","datefns();datefns();datefns();\n");
  const got=await refresh();expect(got.snapshot.entries[0]!.reasons[0]).toContain("count rose");
  expect(got.snapshot.entries[0]!.files.map(f=>f.path)).toEqual(["src/main.ts"]);
  expect(got.snapshot.entries[0]!.directories).toHaveLength(1);
  await refresh();expect(writer.db.prepare("SELECT count(*) n FROM review").get()!.n).toBe(1);
  expect(readFileSync(file,"utf8")).toBe(before);
 });
 it.each(["same-direction","other-scope","structural","oversized"])("does not invent migration evidence for %s",async what=>{
  const value=rule();
  if(what==="other-scope") (value.mex.checks[1]!.target as {scope:string}).scope="other/**";
  if(what==="structural") value.mex.when![0]!.match="structural";
  add(value);observe(1,what==="same-direction"?3:0);source("src/main.ts",what==="oversized"?"x".repeat((64<<10)+1):what==="same-direction"?"moment();datefns();datefns();datefns();":"moment();");
  expect((await refresh()).snapshot.entries).toEqual([]);
 });
 it("matches branch and newer commit/PR titles by subject and explicit change verbs",async()=>{
  add(rule());git("add",".");git("commit","-qm","Add policy");git("switch","-c","migrate-moment-to-datefns");
  expect((await refresh()).snapshot.entries[0]!.reasons[0]).toContain("branch");
  git("switch","work");git("commit","--allow-empty","-qm","Replace moment with datefns (#321)");
  expect((await refresh()).snapshot.entries[0]!.reasons[0]).toMatch(/^Commit [a-f0-9]{40} names/);
 });
 it("does not infer assertion order for an uncommitted entry rewrite",async()=>{
  const value=rule(),file=add(value);git("add",".");git("commit","-qm","Add policy");git("commit","--allow-empty","-qm","Replace moment");
  value.text="This is an uncommitted fresh assertion.";const content=serializeEntry(value);writeFileSync(file,content);report.items![0]!.entry_hash=hash(content);
  expect((await refresh()).snapshot.entries).toEqual([]);
 });
 it("ignores unrelated words, substrings, old titles and explicit negation",async()=>{
  const value=rule();add(value);
  for(const title of ["Migrate unrelated storage","Remove momentous drift","Do not remove moment","Refactor moment adapter"]) expect(titleChangesRule(value,title)).toBe(false);
  execFileSync("git",["-C",root,"-c","user.name=Test","commit","--allow-empty","-qm","Replace moment"],{env:{...process.env,GIT_AUTHOR_DATE:"2026-10-01T00:00:00Z",GIT_COMMITTER_DATE:"2026-10-01T00:00:00Z"},stdio:"pipe"});
  expect((await refresh()).snapshot.entries).toEqual([]);
 });
 it("uses exact entry history to order same-day changes and reads a merge PR's title",async()=>{
  const value=rule();value.mex.created=new Date().toISOString().slice(0,10);add(value);git("add",".");git("commit","-qm","Add date policy");
  git("switch","-c","feature");source("unrelated.txt","change\n");git("add",".");git("commit","-qm","Update fixture");
  git("switch","work");git("merge","--no-ff","feature","-m","Merge pull request #123 from feature","-m","Migrate moment to datefns");
  expect((await refresh()).snapshot.entries[0]!.reasons).toEqual([expect.stringMatching(/^Commit .* explicit rule change$/)]);
 });
 it.each(["docs","review"] as const)("accepts a newer checked %s entry that explicitly reverses a pattern",async type=>{
  add(rule());source("docs/dates.md","Dates now use moment.\n");
  add(entry("mx_newdoc0",{created:"2026-11-02",scope:["src/**"],source:{type,ref:"docs/dates.md"},evidence:type,when:[{type:"required",match:"literal",pattern:"moment("}],checks:[{kind:"source",role:"supporting",target:{file:"docs/dates.md"},saw:{hash:hash("Dates now use moment.\n")},files:{"docs/dates.md":hash("Dates now use moment.\n")}}]}));
  const signal=(await refresh()).snapshot.entries.find(s=>s.id==="mx_policy0")!;
  expect(signal.reasons).toContain(`Newer ${type} entry mx_newdoc0 reverses this pattern in the same scope`);
  expect(signal.files[0]!.path).toBe(".mex/learned/mx_newdoc0.md");
 });
 it("does not treat an older, unchecked, unrelated or merely similar doc as a reversal",async()=>{
  add(rule());add(entry("mx_newdoc0",{created:"2026-10-01",scope:["src/**"],source:{type:"docs",ref:"docs/dates.md"},evidence:"docs",when:[{type:"required",match:"literal",pattern:"moment("}]}));
  expect((await refresh()).snapshot.entries).toEqual([]);
 });
 it("counts distinct override people or sessions, never repeated receipts or unrelated projects",async()=>{
  const file=add(rule()),entryHash=hash(readFileSync(file,"utf8"));
  const hooks=new DatabaseSync(writer.location.hooks);
  try {
   hooks.exec("CREATE TABLE sessions(session_id TEXT,agent TEXT);CREATE TABLE deliveries(id TEXT,session_id TEXT,entry_id TEXT,project_id TEXT,agent_id TEXT,moment TEXT,action TEXT);CREATE TABLE followups(id INTEGER PRIMARY KEY,delivery_id TEXT,kind TEXT,detail TEXT);PRAGMA user_version=6");
   const insert=(id:string,session:string,person?:string,project=projectId,version=1)=>{hooks.prepare("INSERT INTO sessions VALUES(?,?)").run(session,"codex");hooks.prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)").run(id,session,"mx_policy0",project,"","speed-bump","given");hooks.prepare("INSERT INTO followups(delivery_id,kind,detail) VALUES(?,'wrong',?)").run(id,JSON.stringify({version,type:"speed-bump-override",entry_hash:entryHash,person}));};
   insert("a","s1","a".repeat(64));insert("b","s1","a".repeat(64));expect((await refresh()).snapshot.entries).toEqual([]);
   insert("c","s2","b".repeat(64));expect((await refresh()).snapshot.entries[0]!.reasons[0]).toContain("overridden");
   hooks.exec("DELETE FROM followups;DELETE FROM deliveries;DELETE FROM sessions");
   insert("a","s1");insert("b","s2");insert("other","s3",undefined,"other-project");expect((await refresh()).snapshot.entries).toEqual([]);
   insert("c","s3");expect((await refresh()).snapshot.entries).toHaveLength(1);
  } finally {hooks.close();}
 });
 it("keeps facts, retired rules and ambiguous duplicate ids out; clears the derived snapshot",async()=>{
  const value=rule();value.mex.kind="fact";add(value);source("src/main.ts","moment();");
  expect((await refresh()).snapshot.entries).toEqual([]);
  expect(JSON.parse(writer.setting(projectId,ruleChangeKey(root))!).entries).toEqual([]);
 });
 it("preserves a dismissed snapshot, but supersedes older pending evidence when inputs change",async()=>{
  add(rule());source("src/main.ts","moment();datefns();\n");observe(1,1);await refresh();
  const first=writer.db.prepare("SELECT id FROM review").get()!.id!;
  writer.db.prepare("UPDATE review SET state='dismissed' WHERE id=?").run(first);
  expect((await refresh()).snapshot.entries).toEqual([]);
  source("src/main.ts","moment();moment();datefns();\n");observe(2,1);expect((await refresh()).snapshot.entries).toHaveLength(1);
  const second=writer.db.prepare("SELECT id FROM review WHERE state='pending'").get()!.id!;
  const old=writer.setting(projectId,second as string);
  source("src/main.ts","moment();moment();moment();\n");observe(3,0);await refresh();
  expect(writer.db.prepare("SELECT count(*) n FROM review WHERE state='pending'").get()!.n).toBe(1);
  expect(writer.db.prepare("SELECT state FROM review WHERE id=?").get(second)!.state).toBe("dismissed");
  expect(writer.setting(projectId,second as string)).toBe(old);
 });
 it("rechecks publication authority after collecting free evidence",async()=>{
  add(rule());source("src/main.ts","moment();\n");observe(1,0);
  const result=await refreshRuleChanges(writer,projectId,root,report,await position(root),()=>false);
  expect(result.stopped).toBe(true);expect(writer.db.prepare("SELECT count(*) n FROM review").get()!.n).toBe(0);
  expect(writer.setting(projectId,ruleChangeKey(root))).toBeUndefined();
 });
 it("requires current indexed counts to agree with the fresh scope recount",async()=>{
  add(rule());source("src/main.ts","moment();\n");observe(1,1);expect((await refresh()).snapshot.entries).toEqual([]);
  report.results![0]!.checks.forEach(r=>{r.status="floor";delete r.now;});expect((await refresh()).snapshot.entries).toEqual([]);
 });
 it("ignores inherited Git redirects when binding titles to this checkout",async()=>{
  add(rule());const at=await position(root),other=join(base,"other");mkdirSync(other);
  const otherGit=(...args:string[])=>execFileSync("git",["-C",other,...args],{stdio:"pipe"});
  otherGit("init","-b","other");otherGit("-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-qm","Replace moment");
  vi.stubEnv("GIT_DIR",join(other,".git"));vi.stubEnv("GIT_WORK_TREE",other);vi.stubEnv("GIT_NAMESPACE","foreign");
  expect(await position(root)).toEqual(at);expect((await refresh()).snapshot.entries).toEqual([]);
 });
});
