/** Free signals doubt a policy; they never certify a rewrite or retire it. */
import { lstatSync, opendirSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { globPrefix, globToRegExp } from "../file-index/glob.js";
import { isLearnedEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import type { NativeReport } from "../knowledge/check.js";
import type { CheckResult } from "../knowledge/check.js";
import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import { absolutePath, realPath, shortHash } from "../record/project.js";
import { git, hash, position, readCandidate, readSource, samePosition, type Position } from "./evidence.js";

export const RULE_CHANGE_LIMITS = Object.freeze({ rules: 128, signals: 10_000, files: 128, directories: 128, bytes: 8 << 20, snapshot: 512 << 10 });
export const ruleChangeKey = (checkout: string) => `rule-change.${shortHash(checkout)}`;
export interface RuleSignal {
  id: string; entry_hash: string; reasons: string[];
  files: Array<{ path: string; hash: string }>;
  directories: Array<{ path: string; hash: string }>;
}
export interface RuleSnapshot { version: 1; checkout: string; position: Position; entries: RuleSignal[]; }
type Loaded = { entry: KnowledgeEntry; content: string; path: string; level: string; verdict: string; inputs?: Record<string,string> };
const policy = (entry: KnowledgeEntry) => ["rule", "decision", "pitfall"].includes(entry.mex.kind);
const policyKind = (kind: string) => ["rule", "decision", "pitfall"].includes(kind);
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const PositionSchema = z.object({branch:z.string().max(1024).nullable(),head:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u).nullable()}).strict();
const InputSchema = z.object({path:z.string().min(1).max(4096),hash:sha}).strict();
const SnapshotSchema = z.object({version:z.literal(1),checkout:z.string().max(4096),position:PositionSchema,entries:z.array(z.object({
  id:z.string().regex(/^mx_[a-z0-9]{6,64}$/u),entry_hash:sha,reasons:z.array(z.string().min(1).max(512)).min(1).max(5),
  files:z.array(InputSchema).max(128),directories:z.array(InputSchema).max(128),
}).strict()).max(RULE_CHANGE_LIMITS.signals)}).strict();
const CursorSchema = z.object({position:PositionSchema,manifest:sha,after:z.string().regex(/^mx_[a-z0-9]{6,64}$/u)}).strict();
const comparePath = (a: {path:string},b: {path:string}) => Buffer.compare(Buffer.from(a.path),Buffer.from(b.path));
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
const action = /^(?:replac(?:e|es|ed|ing)|migrat(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|renam(?:e|es|ed|ing)|deprecat(?:e|es|ed|ing))$/u;
const generic = new Set(["src", "lib", "index", "test", "tests", "use", "uses", "the", "with", "from", "must", "this", "that", "api", "json", "typescript"]);

/** Match a specific subject near an explicit change verb, never a substring. */
export function titleChangesRule(entry: KnowledgeEntry, title: string): boolean {
  const subjects = new Set([
    ...(entry.mex.when ?? []).flatMap(t => words(t.pattern)),
    ...entry.mex.checks.flatMap(c => "symbol" in c.target && typeof c.target.symbol === "string" ? words(c.target.symbol) : []),
    ...entry.mex.checks.flatMap(c => "file" in c.target && typeof c.target.file === "string" ? words(c.target.file.split("/").at(-1)!.replace(/\.[^.]+$/u,"")) : []),
    ...[...entry.mex.one_line.matchAll(/`([^`]+)`/gu)].flatMap(m=>words(m[1]!)),
  ].filter(w => w.length >= 4 && !generic.has(w) && !action.test(w)));
  const tokens = words(title.slice(0, 1024));
  return tokens.some((token, i) => action.test(token) && !tokens.slice(Math.max(0, i - 2), i).some(w => ["not", "never", "without", "dont"].includes(w))
    && tokens.slice(Math.max(0, i - 6), i + 7).some(w => subjects.has(w)));
}

function migration(checkout: string, entry: KnowledgeEntry, observations: CheckResult[], budget: { bytes: number; work: number; deadline: number; limited: boolean }): Pick<RuleSignal, "files" | "directories"> | undefined {
  const checks = entry.mex.checks.filter(c => c.kind === "pattern" && (c.target.match ?? "literal") === "literal");
  const triggers = entry.mex.when ?? [];
  for (const anti of checks) for (const required of checks) {
    if (anti.kind !== "pattern" || required.kind !== "pattern" || anti.target.scope !== required.target.scope || anti.target.pattern === required.target.pattern
      || !triggers.some(t => t.type === "anti" && t.match === "literal" && t.pattern === anti.target.pattern)
      || !triggers.some(t => t.type === "required" && t.match === "literal" && t.pattern === required.target.pattern)
      || !entry.mex.scope.includes(anti.target.scope)) continue;
    const antiObserved=observations.find(r=>r.index===entry.mex.checks.indexOf(anti) && r.kind==="pattern");
    const requiredObserved=observations.find(r=>r.index===entry.mex.checks.indexOf(required) && r.kind==="pattern");
    if (!antiObserved || !requiredObserved || !["pass","fail"].includes(antiObserved.status) || !["pass","fail"].includes(requiredObserved.status)
      || typeof antiObserved.now!=="number" || typeof requiredObserved.now!=="number") continue;
    const files: RuleSignal["files"] = [], directories: RuleSignal["directories"] = [];
    let antiNow = 0, requiredNow = 0, visited = 0;
    const matches = globToRegExp(anti.target.scope);
    const walk = (path: string): boolean => {
      if (directories.length >= RULE_CHANGE_LIMITS.directories || Date.now()>budget.deadline) { budget.limited=true; return false; }
      let safe = checkout;
      try {
        for (const part of path ? path.split("/") : []) {
          if (!part || part === "." || part === "..") return false;
          safe = join(safe,part); const info=lstatSync(safe);
          if (!info.isDirectory() || info.isSymbolicLink() || realPath(safe)!==absolutePath(safe)) return false;
        }
      } catch { return false; }
      const rows: import("node:fs").Dirent[]=[];
      try {
        const dir=opendirSync(safe);
        try { let row; while ((row=dir.readSync())) { if (rows.length===1000 || ++budget.work>10_000) { budget.limited=true; return false; } if (/[\x00-\x1f]/u.test(row.name)) return false; rows.push(row); } }
        finally { dir.closeSync(); }
      } catch { return false; }
      directories.push({ path: path || ".", hash: hash(rows.map(r => r.name).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).join("\n")) });
      for (const row of rows) {
        if (++visited > 1000) { budget.limited=true; return false; }
        if ([".git", ".mex", "node_modules"].includes(row.name)) continue;
        const child = path ? `${path}/${row.name}` : row.name;
        if (row.isSymbolicLink()) return false;
        if (row.isDirectory()) { if (!walk(child)) return false; }
        else if (matches.test(child)) {
          if (files.length >= RULE_CHANGE_LIMITS.files) { budget.limited=true; return false; }
          if (!row.isFile()) return false;
          let text; try { text = readSource(checkout, child); } catch { return false; }
          if (text === null) return false;
          if ((budget.bytes += Buffer.byteLength(text)) > RULE_CHANGE_LIMITS.bytes) { budget.limited=true; return false; }
          files.push({ path: child, hash: hash(text) });
          antiNow += text.split(anti.target.pattern).length - 1;
          requiredNow += text.split(required.target.pattern).length - 1;
        }
      }
      return true;
    };
    const prefix = globPrefix(anti.target.scope).replace(/\/$/u, "");
    // A literal file scope needs its parent inventory too, to catch deletion.
    const start = !/[*?{]/u.test(anti.target.scope) || (prefix && !globPrefix(anti.target.scope).endsWith("/"))
      ? prefix.slice(0, Math.max(0, prefix.lastIndexOf("/"))) : prefix;
    // The fresh recount must agree with the evaluator's indexed universe.
    // Ignored/binary/generated files cannot manufacture a count transition;
    // a missing or stale index supplies no migration evidence.
    if (walk(start) && antiNow===antiObserved.now && requiredNow===requiredObserved.now && antiNow > anti.saw.count && requiredNow < required.saw.count) return { files, directories };
  }
  return undefined;
}

function contradicts(older: KnowledgeEntry, newer: KnowledgeEntry): boolean {
  if (!policy(newer) || newer.mex.created <= older.mex.created || !["docs", "review"].includes(newer.mex.source.type)
    || JSON.stringify([...older.mex.scope].sort()) !== JSON.stringify([...newer.mex.scope].sort())) return false;
  return (older.mex.when ?? []).some(a => (newer.mex.when ?? []).some(b => a.match === "literal" && b.match === "literal"
    && a.pattern === b.pattern && ((a.type === "anti" && b.type === "required") || (a.type === "required" && b.type === "anti"))
    && !(newer.mex.when ?? []).some(t=>t.match==="literal" && t.pattern===a.pattern && t.type===a.type)));
}

function overrides(writer: RecordWriter, projectId: string): Map<string, { people: Set<string>; sessions: Set<string> }> {
  const out = new Map<string, { people: Set<string>; sessions: Set<string> }>();
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic) return out;
    const rows = hooks.all<{ entry_id: string; session_id: string; agent: string; detail: string }>(`SELECT d.entry_id,d.session_id,s.agent,f.detail
      FROM (SELECT delivery_id,detail FROM followups WHERE kind='wrong' ORDER BY id DESC LIMIT 5000) f
      JOIN deliveries d ON d.id=f.delivery_id JOIN sessions s ON s.session_id=d.session_id
      WHERE d.project_id=? AND d.agent_id='' AND d.moment='speed-bump' AND d.action='given' AND length(CAST(f.detail AS BLOB))<=1024`, projectId);
    for (const row of rows) {
      let detail; try { detail = JSON.parse(row.detail); } catch { continue; }
      if (detail?.version !== 1 || detail.type !== "speed-bump-override" || !/^sha256:[a-f0-9]{64}$/u.test(detail.entry_hash)) continue;
      const key = `${row.entry_id}:${detail.entry_hash}`, got = out.get(key) ?? { people: new Set<string>(), sessions: new Set<string>() };
      got.sessions.add(`${row.agent}:${row.session_id}`);
      if (typeof detail.person === "string" && /^[a-f0-9]{64}$/u.test(detail.person)) got.people.add(detail.person);
      out.set(key, got);
    }
  } catch { /* An absent/old/busy observation table supplies no evidence. */ }
  finally { hooks?.close(); }
  return out;
}

/** Run before paid admission. Missing sources are absent evidence, never zero. */
export async function refreshRuleChanges(writer: RecordWriter, projectId: string, checkout: string, report: NativeReport, at: Position, canPublish: ()=>boolean = ()=>true): Promise<{ snapshot: RuleSnapshot; limited: boolean; more: boolean; stopped?: true }> {
  const snapshot: RuleSnapshot = { version: 1, checkout, position: at, entries: [] };
  const loaded: Loaded[] = [], seen = new Set<string>(), duplicates = new Set<string>();
  if ((report.items?.length ?? 0)>10_000) throw new Error("Rule evidence exceeds the entry limit");
  for(const item of report.items ?? []) { if(seen.has(item.id)) duplicates.add(item.id); seen.add(item.id); }
  const items=(report.items ?? []).filter(item=> {
    const learned = (item as typeof item & { learned?: boolean }).learned || /^mx_deep[a-f0-9]{32}$/u.test(item.id);
    return (item.level==="team" && policyKind(item.kind) || item.level==="personal" && learned && (policyKind(item.kind) || item.kind==="procedure")
      || item.level==="team" && learned && item.kind==="procedure") && item.status==="active"
      && !duplicates.has(item.id) && !writer.setting(projectId,`knowledge.retired.${item.id}`);
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const manifest=hash(JSON.stringify(items.map(item=>[item.id,item.entry_hash])));
  const key=ruleChangeKey(checkout),cursorKey=`${key}.after`;
  let after="",previous:RuleSnapshot|undefined;
  const stored=writer.db.prepare("SELECT value FROM settings WHERE scope=? AND key=? AND length(CAST(value AS BLOB))<=?").get(projectId,key,RULE_CHANGE_LIMITS.snapshot)?.value;
  if(typeof stored==="string") {
    let parsed:RuleSnapshot;try {parsed=SnapshotSchema.parse(JSON.parse(stored));}catch {throw new Error("Stored rule evidence is invalid");}
    if(parsed.checkout===checkout && samePosition(parsed.position,at)) previous=parsed;
  }
  const rawCursor=writer.db.prepare("SELECT value FROM settings WHERE scope=? AND key=? AND length(CAST(value AS BLOB))<=4096").get(projectId,cursorKey)?.value;
  try { const cursor=CursorSchema.parse(JSON.parse(typeof rawCursor==="string"?rawCursor:"null")); if(cursor.manifest===manifest && samePosition(cursor.position,at)) after=cursor.after; } catch { /* A cursor is only a restart hint. */ }
  const start=after?items.findIndex(item=>item.id>after):0;
  const offset=start<0?0:start;
  const page=items.slice(offset,offset+RULE_CHANGE_LIMITS.rules),pageIds=new Set(page.map(item=>item.id));
  // Read this page first so a large source corpus cannot starve later pages.
  const ordered=[...page,...items.filter(item=>!pageIds.has(item.id))];
  let bytes = 0;
  let limited=false;
  for (const item of ordered) {
    const found = readCandidate(item, checkout, writer.location.home, projectId);
    if (!found || item.entry_hash !== hash(found.content)) continue;
    if (item.level === "personal" && !isLearnedEntry(found.entry.mex)) continue;
    if ((bytes += Buffer.byteLength(found.content)) > RULE_CHANGE_LIMITS.bytes) break;
    loaded.push({ ...found, path: item.path, level: item.level, verdict: item.verdict, inputs: report.results?.find(r=>r.entry_id===item.id)?.inputs });
  }
  const eligible = loaded;
  const rules = new Map(loaded.map(rule=>[rule.entry.mex.id,rule]));
  const repeated = overrides(writer, projectId), budget = { bytes: 0, work: 0, deadline: Date.now()+30_000, limited: false };
  const scannedIds=new Set<string>();
  let scanned=0;
  for (const item of page) {
    if (Date.now()>budget.deadline) break;
    scanned++;scannedIds.add(item.id);
    const rule=rules.get(item.id); if(!rule) {limited=true;continue;}
    const entry = rule.entry, reasons: string[] = [];
    const pattern = migration(checkout,entry,report.results?.find(r=>r.entry_id===entry.mex.id)?.checks ?? [],budget);
    if (pattern) reasons.push("In scope, the anti-pattern count rose and the required-pattern count fell");
    if (at.branch && titleChangesRule(entry, at.branch.slice("refs/heads/".length))) reasons.push("The current branch names this subject and an explicit rule change");
    // Creation is not the last assertion time. Only history after an exact
    // committed entry revision may challenge that revision.
    let history:string[]=[];
    if (rule.level === "team") {
      const path=relative(checkout,rule.path).split("\\").join("/");
      const commit=(await git(checkout,["log","-1","--format=%H","--",path]))?.trim();
      if (commit && /^[a-f0-9]{40,64}$/u.test(commit)) {
        const text=await git(checkout,["show",`${commit}:${path}`],64<<10);
        if (text!==undefined && hash(text)===hash(rule.content)) history=(await git(checkout,["log","-32","--format=%H%x00%cI%x00%P%x00%s%x00%b%x00",`${commit}..HEAD`],128<<10))?.split("\0") ?? [];
      }
    } else {
      let since = `${entry.mex.created}T00:00:00Z`;
      try {
        const verified = JSON.parse(writer.setting(projectId, `knowledge.verified.${entry.mex.id}`) ?? "{}") as { at?: string };
        if (verified.at && Number.isFinite(Date.parse(verified.at))) since = new Date(verified.at).toISOString();
      } catch { /* Use the entry's creation date when verification is unavailable. */ }
      history = (await git(checkout, ["log", "-32", "--format=%H%x00%cI%x00%P%x00%s%x00%b%x00", `--since=${since}`], 128 << 10))?.split("\0") ?? [];
    }
    for (let i = 0; i + 4 < history.length; i += 5) {
      const [commit, date, parents, subject, body] = history.slice(i, i + 5).map(s => s!.trim());
      if (!/^[a-f0-9]{40,64}$/u.test(commit!)) continue;
      const title = parents!.split(" ").length > 1 && /^Merge pull request #\d+/u.test(subject!) ? body!.split("\n").find(s => s.trim()) ?? "" : subject!;
      if (titleChangesRule(entry, title)) { reasons.push(`Commit ${commit} names this subject and an explicit rule change`); break; }
    }
    const newer = eligible.find(other => other.level === "team" && other.verdict === "held" && other.entry.mex.checks.length > 0 && contradicts(entry, other.entry));
    const files = pattern?.files ?? [], directories = pattern?.directories ?? [];
    if (newer) {
      const path = relative(checkout, newer.path).split("\\").join("/");
      try {
        const text = readSource(checkout, path), inputs=Object.entries(newer.inputs ?? {});
        const observed=inputs.map(([path,want])=>{
          const text=readSource(checkout,path);
          if(text===null || (budget.bytes+=Buffer.byteLength(text))>RULE_CHANGE_LIMITS.bytes) { budget.limited=true; throw new Error("Source scan incomplete"); }
          return {path,hash:hash(text),want};
        });
        if (text !== null && hash(text) === hash(newer.content) && observed.length>0 && files.length+observed.length+1<=RULE_CHANGE_LIMITS.files && observed.every(f=>f.hash===f.want)) {
          reasons.push(`Newer ${newer.entry.mex.source.type} entry ${newer.entry.mex.id} reverses this pattern in the same scope`);
          files.push({ path, hash: hash(text) },...observed.map(({path,hash})=>({path,hash})));
        }
      } catch { /* An unreadable source cannot contradict a rule. */ }
    }
    const count = repeated.get(`${entry.mex.id}:${hash(rule.content)}`);
    if (count && (count.people.size >= 2 || count.sessions.size >= 3)) reasons.push("The speed bump was deliberately overridden by at least two people or in at least three sessions");
    if (reasons.length) snapshot.entries.push({ id: entry.mex.id, entry_hash: hash(rule.content), reasons, files:files.sort(comparePath), directories:directories.sort(comparePath) });
  }
  const nativeById=new Map(items.map(item=>[item.id,item]));
  snapshot.entries.push(...(previous?.entries ?? []).filter(signal=>!scannedIds.has(signal.id) && nativeById.get(signal.id)?.entry_hash===signal.entry_hash));
  snapshot.entries.sort((a,b)=>a.id.localeCompare(b.id));
  const more=scanned>0 && offset+scanned<items.length;
  if (!samePosition(at, await position(checkout))) throw new Error("Checkout changed while collecting rule evidence");
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    if(!canPublish()) { writer.db.exec("COMMIT"); return {snapshot:{...snapshot,entries:[]},limited:false,more:false,stopped:true}; }
    const active: RuleSignal[]=[];
    for (const signal of snapshot.entries) {
      const proposal=JSON.stringify({checkout,position:at,...signal});
      const id = `rule-change.${shortHash(proposal)}`;
      const current=writer.db.prepare("SELECT state FROM review WHERE id=? AND project_id=?").get(id,projectId);
      if (current && current.state!=="pending") continue;
      // A proposal id binds its exact evidence. Keep closed snapshots immutable;
      // automatically supersede only this checkout's older pending proposals.
      const prior=writer.db.prepare("SELECT id FROM review WHERE project_id=? AND entry_id=? AND state='pending' AND id LIKE 'rule-change.%' ORDER BY created_at DESC LIMIT 128").all(projectId,signal.id);
      for(const row of prior) {
        if(row.id===id) continue;
        const stored=writer.db.prepare("SELECT value FROM settings WHERE scope=? AND key=? AND length(CAST(value AS BLOB))<=?").get(projectId,row.id!,RULE_CHANGE_LIMITS.snapshot)?.value;
        try { if(typeof stored==="string" && JSON.parse(stored).checkout===checkout) writer.db.prepare("UPDATE review SET state='dismissed',reason=reason||' (superseded by new free evidence)' WHERE id=? AND state='pending'").run(row.id!); }
        catch { /* Corrupt unrelated proposal metadata cannot own this scan. */ }
      }
      active.push(signal);
      writer.db.prepare("INSERT INTO review(id,project_id,entry_id,reason,state,created_at) VALUES(?,?,?,?,'pending',?) ON CONFLICT(id) DO NOTHING")
        .run(id, projectId, signal.id, `Rule may have changed: ${signal.reasons.join("; ")} (free evidence)`, new Date().toISOString());
      writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO NOTHING").run(projectId,id,proposal);
    }
    snapshot.entries=active;
    const raw=JSON.stringify(SnapshotSchema.parse(snapshot));
    if(Buffer.byteLength(raw)>RULE_CHANGE_LIMITS.snapshot) throw new Error("Rule evidence exceeds its storage bound");
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(projectId,key,raw);
    if(more) writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(projectId,cursorKey,JSON.stringify({position:at,manifest,after:page[scanned-1]!.id}));
    else writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(projectId,cursorKey);
    writer.db.exec("COMMIT");
  } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
  return { snapshot, more, limited: limited || bytes>RULE_CHANGE_LIMITS.bytes || budget.limited || (scanned===0 && page.length>0) };
}
