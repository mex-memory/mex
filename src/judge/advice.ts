import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { openHooksReadOnly, openRecord, openRecordReadOnly, type RecordWriter, type RecordReader } from "../record/index.js";
import { shortHash } from "../record/project.js";
import { knowledgeProject, type KnowledgeOptions } from "../knowledge/context.js";
import { containedDirectory } from "../knowledge/files.js";
import { assertNoSecrets } from "../knowledge/gates.js";
import type { NativeReport } from "../knowledge/check.js";
import { adviceOrigin, originLine, type AdviceOrigin } from "./advice-history.js";
import { entryFiles, hash, position, readCandidate, readSource, samePosition, type Position } from "./evidence.js";
import type { Candidate } from "./evidence.js";

const Origin = z.discriminatedUnion("kind", [z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("wrong-all-along"), evidence: z.literal("person-confirmed") }),
  z.object({ kind: z.literal("outdated-since"), commit: z.string().regex(/^[a-f0-9]{40,64}$/u), previous: z.string().regex(/^[a-f0-9]{40,64}$/u), held_inputs_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u), evidence: z.literal("complete checks on first-parent history") })]);
const Effect = z.object({ version: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/u), summary: z.string().min(1).max(512).refine(s => !/[\x00-\x1f]/u.test(s)), external: z.boolean() }).strict();
const Context = z.object({ version: z.literal(1), branch: z.string().max(512), head: z.string().max(64), entry_hash: z.string(), verdict: z.string(), inputs_hash: z.string() });
const Advisory = z.object({ version: z.literal(1), id: z.string().regex(/^advice\.[a-f0-9]{24}$/u), checkout: z.string(), branch: z.string(), entry: z.string(), entry_hash: z.string(),
  head: z.string().nullable(),
  title: z.string().max(1024), text: z.string().max(2048), origin: Origin, label: z.enum(["checked by checks", "checked by model", "person-confirmed"]), at: z.string().datetime(),
  receipts: z.array(z.object({ id: z.string().max(128), session: z.string().max(512), agent: z.string().max(128), epoch: z.number().int(), before_change: z.boolean(),
    effects: z.array(Effect).max(64), partial: z.boolean() })).max(128), partial: z.boolean() });
export type AdviceAdvisory = z.infer<typeof Advisory>;
const hintIDs = z.array(z.string().regex(/^advice\.[a-f0-9]{24}$/u)).max(32);
export const adviceKey = (checkout: string, branch: string) => `advice-index.${shortHash(`${checkout}\0${branch}`)}`;
interface ReceiptRow { id: string; session_id: string; agent_id: string; epoch: number; detail: string; }
function effects(hooks: RecordReader, id: string) {
  const rows = hooks.all<{ detail: string }>("SELECT CASE WHEN length(CAST(detail AS BLOB))<=2048 THEN detail ELSE '' END AS detail FROM followups WHERE delivery_id=? AND kind IN ('edit','command') ORDER BY id LIMIT 65", id);
  const values = rows.flatMap(row => { try { return [Effect.parse(JSON.parse(row.detail))]; } catch { return []; } });
  return { effects: values.slice(0, 64), partial: rows.length >= 64 || values.length !== rows.length };
}
function parse(text: string | undefined): AdviceAdvisory | undefined { try { return Advisory.parse(JSON.parse(text ?? "")); } catch { return undefined; } }
function index(writer: RecordWriter, project: string, checkout: string, branch: string): string[] {
  try { return hintIDs.parse(JSON.parse(writer.setting(project, adviceKey(checkout, branch)) ?? "[]")); } catch { return []; }
}
function wake(writer: RecordWriter, project: string, checkout: string, branch: string): void {
  const dir = containedDirectory(writer.location.directory, ["judge-advice"], true)!;
  const path = join(dir, `${shortHash(`${checkout}\0${branch}`)}.json`), temporary = join(dir, `.advice-${randomUUID()}`);
  try { writeFileSync(temporary, JSON.stringify(index(writer, project, checkout, branch)), { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch { /* already published */ } }
}

async function stage(writer: RecordWriter, project: string, checkout: string, at: Position, item: { id: string; title: string; entry_hash: string }, origin: AdviceOrigin,
  label: AdviceAdvisory["label"], valid: () => boolean, branch = at.branch): Promise<boolean> {
  if (!branch || !at.head) return false;
  const hooks = openHooksReadOnly({ home: writer.location.home });
  if (!hooks || hooks.diagnostic || hooks.version < 5 || !hooks.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries'")) { hooks?.close(); return false; }
  let receipts: AdviceAdvisory["receipts"] = [];
  let partial = false;
  try {
    const rows = hooks.all<ReceiptRow>(`SELECT id,session_id,agent_id,epoch,detail FROM deliveries WHERE project_id=? AND checkout=? AND entry_id=?
      AND action IN ('given','replaced') AND moment<>'correction' ORDER BY rowid DESC LIMIT 129`, project, checkout, item.id);
    partial = rows.length > 128;
    for (const row of rows.slice(0, 128)) {
      let context: z.infer<typeof Context>;
      try { context = Context.parse(JSON.parse(row.detail)); } catch { partial = true; continue; }
      if (context.branch !== branch || (origin.kind !== "wrong-all-along" && context.entry_hash !== item.entry_hash)) continue;
      // Match the actual recorded check inputs, rather than assuming a clean
      // working tree from the receipt's HEAD or its timestamp.
      const before = origin.kind === "outdated-since" && context.verdict === "held" && context.inputs_hash === origin.held_inputs_hash;
      receipts.push({ id: row.id, session: row.session_id, agent: row.agent_id, epoch: row.epoch, before_change: before, ...effects(hooks, row.id) });
    }
  } finally { hooks.close(); }
  if (!receipts.length || !samePosition(at, await position(checkout)) || !valid()) return false;
  const id = `advice.${shortHash(`${checkout}\0${branch}\0${item.id}\0${item.entry_hash}`)}`;
  const value: AdviceAdvisory = { version: 1, id, checkout, branch, head: at.head, entry: item.id, entry_hash: item.entry_hash,
    title: item.title.replace(/[\x00-\x1f]/gu, " ").slice(0, 1024), text: `Correction: set aside entry ${item.id}. ${originLine(origin)}`, origin, label,
    at: new Date().toISOString(), receipts, partial };
  assertNoSecrets(value);
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    if (!valid()) { writer.db.exec("ROLLBACK"); return false; }
    const old = parse(writer.setting(project, id));
    if (old) {
      const merged = new Map(value.receipts.map(r => [r.id,r]));
      for (const previous of old.receipts) {
        const live = merged.get(previous.id);
        if (!live) { merged.set(previous.id,previous); continue; }
        const all = new Map([...previous.effects,...live.effects].map(e => [e.key,e]));
        live.effects = [...all.values()].slice(0,64); live.partial ||= previous.partial || all.size>64;
      }
      value.receipts = [...merged.values()].slice(0,128); value.partial ||= old.partial || merged.size>128;
    }
    // A later model pass or an explicit person statement may improve an
    // unknown origin, but a subsequent unknown never erases a proved timeline.
    if (old && value.origin.kind === "unknown" && old.origin.kind !== "unknown") { value.origin = old.origin; value.text = old.text; }
    // Keep bounded durable snapshots even after Go prunes its receipt history.
    while (Buffer.byteLength(JSON.stringify(value)) > 60 << 10) {
      const largest = [...value.receipts].sort((a,b) => b.effects.length-a.effects.length)[0];
      if (largest?.effects.length) { largest.effects.pop(); largest.partial = true; }
      else { value.receipts.pop(); value.partial = true; }
    }
    const put = writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
    put.run(project, id, JSON.stringify(Advisory.parse(value)));
    writer.db.prepare("INSERT INTO review(id,project_id,entry_id,reason,state,created_at) VALUES(?,?,?,?,'pending',?) ON CONFLICT(id) DO UPDATE SET reason=excluded.reason")
      .run(id, project, item.id, `Advice already used: ${value.text} (${label}). Details: mex report.`, value.at);
    const ids = [id, ...index(writer, project, checkout, branch).filter(existing => existing !== id)].slice(0, 32);
    put.run(project, adviceKey(checkout, branch), JSON.stringify(ids));
    writer.db.exec("COMMIT");
  } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
  wake(writer, project, checkout, branch);
  return true;
}

/** Runs before model/cap admission: a failed complete check already proves the
 * old claim false. Local advisory work makes no model call or repository edit. */
export async function refreshAdvice(writer: RecordWriter, project: string, checkout: string, report: NativeReport, at: Position, valid: () => boolean): Promise<boolean> {
  if (!report.items?.some(item => item.verdict === "broken" && item.status === "active" && item.level !== "hint")) return false;
  const hooks = openHooksReadOnly({ home: writer.location.home });
  if (!hooks || hooks.diagnostic || hooks.version < 5 || !hooks.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries'")) { hooks?.close(); return false; }
  let used: Set<string>;
  try { used = new Set(hooks.all<{ entry_id: string; detail: string }>("SELECT entry_id,detail FROM deliveries WHERE project_id=? AND checkout=? AND action IN ('given','replaced') AND moment<>'correction' ORDER BY rowid DESC LIMIT 1000", project, checkout).flatMap(r => {
    try { const c = Context.parse(JSON.parse(r.detail)); return c.branch === at.branch ? [`${r.entry_id}\0${c.entry_hash}`] : []; } catch { return []; }
  })); }
  finally { hooks.close(); }
  let work = 0;
  let more = false;
  for (const item of report.items ?? []) {
    if (item.verdict !== "broken" || item.level === "hint" || item.status !== "active") continue;
    const found = readCandidate(item, checkout, writer.location.home, project);
    if (!found || item.entry_hash !== hash(found.content)) continue;
    if (!used.has(`${item.id}\0${hash(found.content)}`)) continue;
    const observed = report.results?.find(r => r.entry_id === item.id);
    const current = () => valid() && !writer.setting(project,`knowledge.retired.${item.id}`) && readCandidate(item, checkout, writer.location.home, project)?.content === found.content
      && observed?.verdict === "broken" && observed.inputs !== undefined && entryFiles(found.entry).every(path => path in observed.inputs!) && Object.entries(observed.inputs).every(([path, input]) => {
        const text = readSource(checkout, path); return (text === null ? "missing" : hash(text)) === input;
      });
    if (!current()) continue;
    const key = `advice.${shortHash(`${checkout}\0${at.branch}\0${item.id}\0${hash(found.content)}`)}`;
    const old = parse(writer.setting(project, key));
    const needsHistory = !old || (old.origin.kind === "unknown" && old.head !== at.head);
    if (needsHistory && work++ >= 5) { more = true; continue; }
    const origin = needsHistory ? await adviceOrigin(checkout, found.entry, found.content, at) : old!.origin;
    await stage(writer, project, checkout, at, { id: item.id, title: found.entry.mex.one_line, entry_hash: hash(found.content) }, origin, "checked by checks",
      current);
  }
  if (at.branch && index(writer, project, checkout, at.branch).length) wake(writer, project, checkout, at.branch);
  return more;
}
export async function modelAdvice(writer: RecordWriter, project: string, candidate: Candidate, checkout: string, at: Position, valid: () => boolean): Promise<void> {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic || hooks.version<5 || !hooks.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries'")
      || !hooks.get("SELECT 1 FROM deliveries WHERE project_id=? AND checkout=? AND entry_id=? AND action IN ('given','replaced') AND moment<>'correction' LIMIT 1",project,checkout,candidate.item.id)) return;
  } finally { hooks?.close(); }
  await stage(writer, project, checkout, at, { id: candidate.item.id, title: candidate.entry.mex.one_line, entry_hash: hash(candidate.content) },
    await adviceOrigin(checkout, candidate.entry, candidate.content, at), "checked by model", () => valid() && !writer.setting(project,`knowledge.retired.${candidate.item.id}`));
}

/** Explicit assertion, after successful retirement. A generic `mex wrong`
 * deliberately does not mean the note was wrong at every point in history. */
export async function wrongAllAlong(id: string, options: KnowledgeOptions): Promise<void> {
  const project = knowledgeProject(options), writer = openRecord(options);
  try {
    const at = await position(project.root);
    const hooks = openHooksReadOnly(options);
    let branches: string[] = [];
    try { if (hooks && !hooks.diagnostic && hooks.version>=5 && hooks.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries'")) branches = [...new Set(hooks.all<{detail:string}>("SELECT detail FROM deliveries WHERE project_id=? AND checkout=? AND entry_id=? AND action IN ('given','replaced') AND moment<>'correction' ORDER BY rowid DESC LIMIT 128",project.projectId,project.root,id).flatMap(r => {
      try { const c=Context.parse(JSON.parse(r.detail)); return c.branch.startsWith("refs/heads/") ? [c.branch] : []; } catch { return []; }
    }))]; } finally { hooks?.close(); }
    for (const branch of branches.slice(0,32)) await stage(writer, project.projectId, project.root, at, { id, title: id, entry_hash: "person-confirmed-all-versions" },
      { kind: "wrong-all-along", evidence: "person-confirmed" }, "person-confirmed", () => true, branch);
  } finally { writer.close(); }
}

/** Read-only: no registration, migrations, graph rebuild, hint repair or writes. */
export async function adviceReport(options: KnowledgeOptions): Promise<{ advisories: AdviceAdvisory[]; partial: boolean }> {
  const project = knowledgeProject(options), at = await position(project.root), reader = openRecordReadOnly(options);
  if (!reader) return { advisories: [], partial: false };
  try {
    if (reader.diagnostic) throw Error(reader.diagnostic);
    const rows = reader.all<{ key: string; value: string }>(`SELECT s.key,s.value FROM review r JOIN settings s ON s.scope=r.project_id AND s.key=r.id
      WHERE r.project_id=? AND r.id GLOB 'advice.*' ORDER BY r.created_at DESC LIMIT 201`, project.projectId);
    const advisories = rows.slice(0, 200).flatMap(row => {
      const value = parse(row.value);
      return value && value.checkout === project.root && value.branch === at.branch ? [value] : [];
    });
    const hooks = openHooksReadOnly(options);
    try { if (hooks && !hooks.diagnostic) for (const value of advisories) for (const receipt of value.receipts) {
      const live = effects(hooks, receipt.id), merged = new Map([...receipt.effects, ...live.effects].map(e => [e.key, e]));
      receipt.effects = [...merged.values()].slice(0,64); receipt.partial ||= live.partial || merged.size>64;
    } } finally { hooks?.close(); }
    return { advisories, partial: rows.length>200 };
  } finally { reader.close(); }
}
export function formatAdvice(value: AdviceAdvisory): string {
  const lines = [`${value.text} (${value.label})`, value.title];
  for (const receipt of value.receipts) {
    lines.push(`Delivery ${receipt.id}, session ${receipt.session}, epoch ${receipt.epoch}${receipt.before_change ? " — recorded inputs held before the change" : " — review this use"}:`);
    for (const effect of receipt.effects) lines.push(`  ${effect.summary}`);
    if (!receipt.effects.length) lines.push("  No edits or commands were recorded.");
    if (receipt.partial) lines.push("  Follow-up list reached its limit.");
  }
  if (value.partial) lines.push("Delivery history is partial; some versions or older receipts could not be verified.");
  return lines.join("\n");
}
