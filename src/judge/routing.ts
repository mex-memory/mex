import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { z } from "zod";
import { automaticWorkEnabled } from "../controls/index.js";
import { EntryIdSchema, KnowledgeError, serializeEntry, parseEntry } from "../knowledge/entry.js";
import { stageReview, reviewQuiet } from "../review/state.js";
import { learningMetadata } from "../filter/metadata.js";
import { containedDirectory, replaceEntryFile } from "../knowledge/files.js";
import { gateEntry } from "../knowledge/gates.js";
import { references } from "../knowledge/references.js";
import { prepareTeamWrite, applyTeamWrite } from "../knowledge/team.js";
import type { NativeReport } from "../knowledge/check.js";
import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import type { JobRow } from "../record/jobs.js";
import { shortHash } from "../record/project.js";
import { git, hash, position, readCandidate, readSource, samePosition, entryFiles, type Candidate, type Position } from "./evidence.js";
import { JudgementSchema, type Judgement } from "./result.js";
import { ownsChanges, judgeActor } from "./ownership.js";
import type { JudgeParams } from "./pending.js";
import { wakeNotice } from "./notices.js";
import { sessionWorkEnabled } from "./session.js";
import { withCheckoutPublication } from "./publication.js";

export const PREVIEW_WAIT = "Waiting: show the proposed knowledge diff in the editing session";
const PREVIEW_TIMEOUT_MS = 5 * 60_000;
const FixSchema = z.object({
  judgement: JudgementSchema,
  item: z.object({ id: EntryIdSchema, path: z.string().max(4096), level: z.enum(["team", "personal"]) }).strict(),
  before: z.string().max(64 << 10), agent: z.enum(["claude", "codex"]), sessionId: z.string().max(512).optional(),
  state: z.enum(["pending", "preview", "applied", "review", "discarded"]),
  previewAt: z.string().datetime().optional(), previewRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict().refine(fix => fix.item.id === fix.judgement.id && hash(fix.before) === fix.judgement.entry_hash, "Fix identity changed");
type Fix = z.infer<typeof FixSchema>;
const keyFor = (result: Judgement) => `judge.fix.${shortHash(`${result.checkout}\0${result.id}\0${result.inputs_hash}`)}`;
const queueKey = (job: JobRow) => `judge.routes.${job.id}`;
const previewId = (key: string) => `${key}.preview`;
const set = (writer: RecordWriter, scope: string, key: string, value: unknown) => writer.db.prepare(
  "INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(scope, key, JSON.stringify(value));

export function needsRouting(writer: RecordWriter, projectId: string, result: Judgement): boolean {
  return result.result !== "still-true" && writer.setting(projectId, keyFor(result)) === undefined;
}

/** Called in the judgement's transaction, so a lost checkpoint cannot lose a fix. */
export function stageFixes(writer: RecordWriter, job: JobRow, results: Judgement[], candidates: Candidate[], params: JudgeParams, sessionId?: string): void {
  const keys: string[] = [];
  for (const result of results) {
    if (result.result === "still-true") continue;
    const candidate = candidates.find(candidate => candidate.item.id === result.id)!;
    const key = keyFor(result);
    const fix = FixSchema.parse({ judgement: result, item: { id: result.id, path: candidate.item.path, level: candidate.item.level },
      before: candidate.content, agent: params.agent, ...(sessionId ? { sessionId } : {}), state: "pending" });
    const raw = JSON.stringify(fix);
    if (Buffer.byteLength(raw) > 256 << 10) throw new Error("The judge fix exceeds its storage bound.");
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO NOTHING").run(job.project_id!, key, raw);
    keys.push(key);
  }
  if (keys.length) set(writer, job.project_id!, queueKey(job), keys);
}

function pendingKeys(writer: RecordWriter, job: JobRow): string[] {
  const raw = writer.setting(job.project_id!, queueKey(job));
  return raw ? z.array(z.string().regex(/^judge\.fix\.[a-f0-9]{24}$/u)).max(5).parse(JSON.parse(raw)) : [];
}
export function hasPendingFixes(writer: RecordWriter, job: JobRow): boolean { return pendingKeys(writer, job).length > 0; }
function readFix(writer: RecordWriter, job: JobRow, key: string): Fix {
  const raw = writer.db.prepare("SELECT CASE WHEN length(CAST(value AS BLOB))<=? THEN value ELSE NULL END value FROM settings WHERE scope=? AND key=?")
    .get(256 << 10, job.project_id!, key)?.value;
  return FixSchema.parse(JSON.parse(typeof raw === "string" ? raw : ""));
}
function shown(writer: RecordWriter, key: string, sessionId?: string): boolean {
  if (!sessionId) return false;
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try { return !!hooks && !hooks.diagnostic && !!hooks.get("SELECT 1 FROM notices_shown WHERE notice_id=? AND session_id=?", previewId(key), sessionId); }
  finally { hooks?.close(); }
}
export function fixPreviewReady(writer: RecordWriter, job: JobRow): boolean {
  return pendingKeys(writer, job).some(key => {
    const fix = readFix(writer, job, key);
    return sessionWorkEnabled(writer, fix.agent, fix.sessionId) && shown(writer, key, fix.sessionId);
  });
}

/** Inspect local AND fetched branches without checking one out or fetching. */
export async function existingFixBranch(checkout: string, id: string): Promise<string | null | undefined> {
  const suffix = `/mex/fix-${id}`;
  const refs = await git(checkout, ["for-each-ref", "--format=%(refname)", `refs/heads/mex/fix-${id}`, "refs/remotes"], 32 << 10);
  return refs === undefined ? undefined : refs.split("\n").find(ref => ref.endsWith(suffix)) ?? null;
}
function syncPosition(checkout: string): Position {
  const run = (args: string[]) => { try { return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", timeout: 1500, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return null; } };
  return { branch: run(["symbolic-ref", "--quiet", "HEAD"]), head: run(["rev-parse", "--verify", "HEAD"]) };
}
function fixBranchNow(checkout: string, id: string): boolean {
  const refs = execFileSync("git", ["-C", checkout, "for-each-ref", "--format=%(refname)", `refs/heads/mex/fix-${id}`, "refs/remotes"],
    { encoding: "utf8", timeout: 1500, maxBuffer: 32 << 10, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return refs.split("\n").some(ref => ref.endsWith(`/mex/fix-${id}`));
}
function enabled(writer: RecordWriter, job: JobRow, checkout: string, fix: Fix): boolean {
  const c = writer.checkout(checkout);
  const j = writer.db.prepare("SELECT state,owner,request FROM jobs WHERE id=?").get(job.id);
  return c?.project_id === job.project_id && c.state !== "off" && !(c.state === "off until" && Date.parse(c.off_until ?? "") > Date.now())
    && automaticWorkEnabled(writer, job.project_id!) && sessionWorkEnabled(writer, fix.agent, fix.sessionId)
    && j?.state === "running" && j.owner === job.owner && j.request === null;
}
function filesMatch(fix: Fix): boolean {
  return fix.judgement.files.every(file => { const text = readSource(fix.judgement.checkout, file.path); return (text === null ? null : hash(text)) === file.hash; });
}
function original(fix: Fix, writer: RecordWriter, projectId: string) {
  return readCandidate({ ...fix.item, status: "active", kind: "fact", verdict: "changed" }, fix.judgement.checkout, writer.location.home, projectId);
}
function freshChecks(fix: Fix, report: NativeReport): boolean {
  const item = report.items?.find(item => item.id === fix.item.id && item.path === fix.item.path && item.level === fix.item.level);
  if(item?.rule_evidence_pending) return false;
  const observed = report.results?.find(result => result.entry_id === fix.item.id);
  return item?.entry_hash === fix.judgement.entry_hash && !!observed && hash(JSON.stringify({ verdict: item.verdict, checks: observed.checks, inputs: observed.inputs,
    ...(item.rule_evidence?.length ? { rule_evidence: item.rule_evidence } : {}) })) === fix.judgement.checks_hash;
}
function notice(writer: RecordWriter, key: string, fix: Fix, type: "preview" | "updated", text: string): void {
  if (!fix.sessionId) return;
  const actor = judgeActor(fix.judgement.checkout, fix.agent, fix.sessionId);
  writer.db.prepare("INSERT INTO notices(id,kind,text,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING").run(`${key}.${type}`,
    `judge-${type}.${actor}`,
    JSON.stringify({ version: 1, position: fix.judgement.position, text }), new Date().toISOString());
  wakeNotice(writer, actor, `${key}.${type}`);
}
function review(writer: RecordWriter, job: JobRow, key: string, fix: Fix, reason: string): void {
  stageReview(writer, job.project_id!, key, fix.judgement.rewrite ?? parseEntry(fix.before),
    { producer: "judge", key, checkout: fix.judgement.checkout, level: fix.item.level, path: fix.item.path, original_hash: fix.judgement.entry_hash },
    `${reason} (checked by model)`, fix.item.level === "team" || !!learningMetadata(writer, job.project_id!, fix.item.id).sources?.length, Date.parse(fix.judgement.at));
  fix.state = "review"; set(writer, job.project_id!, key, fix);
  writer.db.prepare("DELETE FROM notices WHERE id=?").run(previewId(key));
}

/** Resume routing before spending again. Only this project's running job writes. */
export async function routeFixes(writer: RecordWriter, job: JobRow, report: NativeReport): Promise<{ waiting: boolean; gaps: boolean }> {
  let waiting = false, gaps = false;
  for (const key of pendingKeys(writer, job)) {
    const fix = readFix(writer, job, key), result = fix.judgement, checkout = result.checkout;
    if (["applied", "review", "discarded"].includes(fix.state)) { gaps ||= fix.state === "review"; continue; }
    // Do the branch check before even a personal update, and repeat at publication.
    const branch = await existingFixBranch(checkout, fix.item.id);
    const at = await position(checkout);
    writer.db.exec("BEGIN IMMEDIATE");
    let rolledBack = false;
    try {
      if (!enabled(writer, job, checkout, fix)) { waiting = true; continue; }
      if (reviewQuiet(writer, job.project_id!, fix.judgement.rewrite ?? parseEntry(fix.before))) {
        fix.state = "discarded"; set(writer, job.project_id!, key, fix); writer.db.prepare("DELETE FROM notices WHERE id=?").run(previewId(key)); continue;
      }
      if (writer.setting(job.project_id!, `knowledge.retired.${fix.item.id}`)) {
        // A retirement is final; no rewrite or Review resurrection.
        fix.state = "discarded"; set(writer, job.project_id!, key, fix); writer.db.prepare("DELETE FROM notices WHERE id=?").run(previewId(key)); continue;
      }
      if (branch !== null) { review(writer, job, key, fix, branch ? `An existing mex/fix-${fix.item.id} branch already owns this fix` : "Fix branches could not be checked"); gaps = true; continue; }
      if (result.result !== "rewritten" || !result.rewrite) { review(writer, job, key, fix, "The judge could not resolve the entry"); gaps = true; continue; }
      if (!samePosition(result.position, at) || !samePosition(result.position, syncPosition(checkout)) || !filesMatch(fix)) {
        review(writer, job, key, fix, "The checkout or judge inputs changed before the fix could land"); gaps = true; continue;
      }
      const found = original(fix, writer, job.project_id!);
      const after = serializeEntry(result.rewrite);
      // Recover a crash after atomic file publication but before the DB commit.
      if (found?.content === after) {
        notice(writer, key, fix, "updated", fix.item.level === "team"
          ? `MEX fix for ${fix.item.id} is present in this working tree (checked by model); include it in the same PR.`
          : `MEX fix for personal entry ${fix.item.id} is present locally (checked by model).`);
        fix.state = "applied"; set(writer, job.project_id!, key, fix); writer.db.prepare("DELETE FROM notices WHERE id=?").run(previewId(key)); continue;
      }
      if (!found || found.content !== fix.before || hash(found.content) !== result.entry_hash || !freshChecks(fix, report)) {
        review(writer, job, key, fix, "The entry or its checks changed before the fix could land"); gaps = true; continue;
      }
      if (fix.item.level === "team") {
        const owns = () => ownsChanges(writer.location.directory, job.project_id!, checkout, fix.agent, fix.sessionId, at,
          { entry: found.entry, files: [...new Set([...entryFiles(found.entry), ...Object.keys(report.results?.find(r => r.entry_id === fix.item.id)?.inputs ?? {})])] }, result.files);
        if (!owns()) {
          review(writer, job, key, fix, "The code change was not proved to belong to this session; keep the team fix in Review"); gaps = true; continue;
        }
        const preview = prepareTeamWrite(result.rewrite, { projectPath: checkout, home: writer.location.home });
        if (join(checkout, preview.path) !== fix.item.path || preview.before !== fix.before) throw new Error("The fix no longer names the same entry.");
        if (preview.after !== after || (fix.previewRevision && fix.previewRevision !== preview.revision)) {
          review(writer, job, key, fix, "The proposed diff changed at the entry's write gates"); gaps = true; continue;
        }
        if (!shown(writer, key, fix.sessionId)) {
          if (fix.previewAt && Date.now() - Date.parse(fix.previewAt) >= PREVIEW_TIMEOUT_MS) {
            review(writer, job, key, fix, "The editing session did not receive its preview; keep the fix in Review"); gaps = true; continue;
          }
          notice(writer, key, fix, "preview", `MEX proposes updating ${fix.item.id} in this working tree (checked by model). The exact diff follows; it will apply only while this session's branch and inputs still match.\n${preview.diff}`);
          fix.state = "preview"; fix.previewAt ??= new Date().toISOString(); fix.previewRevision = preview.revision;
          set(writer, job.project_id!, key, fix); waiting = true; continue;
        }
        if (fix.previewRevision !== preview.revision) { review(writer, job, key, fix, "No receipt exists for this exact proposed diff"); gaps = true; continue; }
        // Refuse a ref created while the asynchronous checks above were running.
        if (fixBranchNow(checkout, fix.item.id)) { review(writer, job, key, fix, "A fix branch appeared before the update could land"); gaps = true; continue; }
        await withCheckoutPublication(checkout, result.position, () => {
          if (!samePosition(result.position, syncPosition(checkout)) || !filesMatch(fix) || !enabled(writer, job, checkout, fix) || !owns()) {
            throw new KnowledgeError("STALE_PREVIEW", "The checkout or consent changed before publication.");
          }
          applyTeamWrite(preview, preview.revision, { projectPath: checkout, home: writer.location.home });
        });
        notice(writer, key, fix, "updated", `MEX updated ${preview.path} in this working tree (checked by model); include it in the same PR.`);
      } else {
        if (serializeEntry(gateEntry(result.rewrite, references(checkout))) !== after) throw new KnowledgeError("STALE_PREVIEW", "The proposed fix changed at the write gates.");
        const directory = containedDirectory(writer.location.home, ["projects", job.project_id!, "notes"]);
        if (!directory || dirname(fix.item.path) !== directory) throw new Error("Personal fix storage changed.");
        if (fixBranchNow(checkout, fix.item.id) || !samePosition(result.position, syncPosition(checkout)) || !filesMatch(fix)) {
          review(writer, job, key, fix, "The checkout or fix branch changed before the personal update"); gaps = true; continue;
        }
        replaceEntryFile(directory, fix.item.id, fix.before, after);
        notice(writer, key, fix, "updated", `MEX updated personal entry ${fix.item.id} locally (checked by model).`);
      }
      fix.state = "applied"; set(writer, job.project_id!, key, fix);
      writer.db.prepare("DELETE FROM notices WHERE id=?").run(previewId(key));
    } catch (error) {
      writer.db.exec("ROLLBACK"); rolledBack = true;
      if (!(error instanceof KnowledgeError)) throw error;
      writer.db.exec("BEGIN IMMEDIATE");
      try {
        if (enabled(writer, job, checkout, fix) && !writer.setting(job.project_id!, `knowledge.retired.${fix.item.id}`)) {
          review(writer, job, key, fix, error.code === "GIT_BUSY" ? "Git was busy or could not guard this checkout; keep the fix in Review" : "The fix no longer passes the entry's write gates"); gaps = true;
        } else waiting = true;
        writer.db.exec("COMMIT");
      } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
    } finally {
      // Files publish atomically. Their exact after-bytes make DB replay safe.
      if (!rolledBack) writer.db.exec("COMMIT");
    }
  }
  if (!waiting) writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(job.project_id!, queueKey(job));
  return { waiting, gaps };
}
