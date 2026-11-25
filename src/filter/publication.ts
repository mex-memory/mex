import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import type { RecordWriter } from "../record/index.js";
import { openHooksReadOnly } from "../record/index.js";
import type { JobRow } from "../record/jobs.js";
import { shortHash, projectIdentity, realPath } from "../record/project.js";
import { parseEntry, EntryIdSchema, KnowledgeError, serializeEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { containedDirectory, readEntryFile } from "../knowledge/files.js";
import { assertNoSecrets } from "../knowledge/gates.js";
import { shareProblems } from "../knowledge/share-checks.js";
import { localSettings, claimHash, retiredClaimHashes } from "../knowledge/state.js";
import { prepareTeamWrite, applyTeamWrite, teamEntries, teamEntry } from "../knowledge/team.js";
import { hash, position, samePosition, readSource, type Position } from "../judge/evidence.js";
import { evaluate } from "../judge/native.js";
import { judgeActor } from "../judge/ownership.js";
import { wakeNotice } from "../judge/notices.js";
import { withCheckoutPublication } from "../judge/publication.js";
import { filterAllowed, filterSession, type FilterParams } from "./input.js";
import { contextSource, hostCorroborated, learningMetadata, type SourceRecord } from "./metadata.js";
import { typedQuote } from "./transcript.js";
import { promotionDecision, type Evidence } from "./evidence.js";
import { repositoryPolicy, sharingEnabled } from "./repository.js";
import { backgroundEnvironment } from "./environment.js";
import { stageReview, reviewQuiet, learningReviewId } from "../review/state.js";
import { reviewReason } from "../review/reasons.js";

export const PUBLICATION_WAIT = "Waiting: show the learned entry diff in this session";
const PositionSchema = z.object({ branch: z.string().nullable(), head: z.string().nullable() }).strict();
const Offer = z.object({ version: z.literal(1), id: EntryIdSchema, checkout: z.string().max(4096), position: PositionSchema,
  personal_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u), state: z.enum(["pending", "preview", "applied", "held", "review"]),
  last_job: z.string().max(128).optional(), reason: z.string().max(128).optional(), notice: z.string().max(128).optional(),
  actor: z.string().max(24).optional(), session: z.string().max(512).optional(), preview_at: z.number().optional(), review_at: z.number().optional(),
  revision: z.string().max(64).optional(), after: z.string().max(64 << 10).optional(), metadata_hash: z.string().max(80).optional(),
}).strict();
type OfferRow = z.infer<typeof Offer>;
type Observation = NonNullable<Evidence["observations"]>[number];
export interface PublicationDependencies { repository: typeof repositoryPolicy; evaluate: typeof evaluate; verify: typeof verifySources; clock: () => number; }
const dependencies: PublicationDependencies = { repository: repositoryPolicy, evaluate, verify: verifySources, clock: Date.now };
const keyFor = (id: string) => `learning.offer.${id}`;
function set(writer: RecordWriter, project: string, offer: OfferRow) {
  const raw = JSON.stringify(offer);
  if (Buffer.byteLength(raw) > 128 << 10) throw new Error("The learned-entry publication exceeds its storage limit.");
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(project, keyFor(offer.id), raw);
}
/** Called in the consolidation transaction; a lost checkpoint cannot lose a promotion. */
export function stagePromotion(writer: RecordWriter, project: string, id: string, checkout: string, at: Position, personalHash: string): void {
  set(writer, project, { version: 1, id, checkout, position: at, personal_hash: personalHash, state: "pending" });
}
function owned(writer: RecordWriter, project: string, params: FilterParams, job: JobRow): boolean {
  return filterAllowed(writer, project, params) && !!writer.db.prepare("SELECT 1 FROM jobs WHERE id=? AND owner=? AND state='running' AND request IS NULL").get(job.id, job.owner);
}
function save(writer: RecordWriter, project: string, params: FilterParams, job: JobRow, offer: OfferRow, extra?: () => void) {
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    if (!owned(writer, project, params, job)) throw new Error("Publication ownership or consent changed.");
    set(writer, project, offer); extra?.(); writer.db.exec("COMMIT");
  } catch (e) { writer.db.exec("ROLLBACK"); throw e; }
}
function notice(writer: RecordWriter, offer: OfferRow, type: "preview" | "updated", text: string): void {
  if (!offer.notice || !offer.actor) return;
  const id = `${offer.notice}.${type}`;
  writer.db.prepare("INSERT INTO notices VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING").run(id, `learning-${type}.${offer.actor}`,
    JSON.stringify({ version: 1, position: offer.position, text }), new Date().toISOString());
  wakeNotice(writer, offer.actor, id);
}
function shown(writer: RecordWriter, offer: OfferRow): boolean {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try { return !!hooks && !hooks.diagnostic && !!hooks.get("SELECT 1 FROM notices_shown WHERE notice_id=? AND session_id=?", `${offer.notice}.preview`, offer.session ?? ""); }
  finally { hooks?.close(); }
}
export function publicationReady(writer: RecordWriter, job: JobRow): boolean {
  let params: FilterParams;
  try { params = JSON.parse(job.params) as FilterParams; } catch { return false; }
  if (writer.setting(job.project_id!, "learning.sharing") === "manual" || !sharingEnabled(writer, job.project_id!, params.checkout)) return true;
  const rows = localSettings(writer, job.project_id!, "learning.offer.", 128 << 10);
  return rows.some(row => { try { const offer = Offer.parse(JSON.parse(String(row.value))); return offer.checkout === params.checkout && offer.session === params.sessionId && offer.state === "preview" && (shown(writer, offer) || Date.now() - (offer.preview_at ?? 0) >= 5 * 60_000); } catch { return false; } });
}
function readPersonal(writer: RecordWriter, project: string, id: string) {
  const dir = containedDirectory(writer.location.home, ["projects", project, "notes"]);
  const raw = dir && readEntryFile(join(dir, `${id}.md`));
  if (!raw || writer.setting(project, `knowledge.retired.${id}`)) return undefined;
  const entry = parseEntry(raw);
  return entry.mex.id === id && entry.mex.status === "active" && !retiredClaimHashes(writer, project).has(claimHash(entry.text)) ? { entry, raw, path: join(dir!, `${id}.md`) } : undefined;
}
/** Replay exact user quotes against their retained host transcript, with current delivery exclusions. */
export function verifySources(writer: RecordWriter, project: string, entry: KnowledgeEntry, sources: SourceRecord[]): Observation[] {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try { return sources.map(record => {
    const s = record.source;
    const result: Observation = { session: s.session ?? `note:${s.note_id ?? "unknown"}`, lasting: record.label === "lasting", verified: false, marked: !!s.marks, delivered: s.delivered.includes(entry.mex.id) };
    if (s.note_id && !s.session) {
      result.verified = s.note_id === entry.mex.id && !!entry.mex.source.quote?.includes(record.quote); return result;
    }
    if (!hooks || hooks.diagnostic || !s.session || !s.row || !s.message_hash) return result;
    const session = hooks.get<{ checkout: string; agent: string; paused: number }>("SELECT checkout,agent,paused FROM sessions WHERE session_id=? AND project_id=?", s.session, project);
    if (!session || !["claude-code", "codex"].includes(session.agent)) return result;
    const host = hostCorroborated(entry);
    if (host && session.paused) return result;
    const info = filterSession(writer, project, session.checkout, s.session);
    if (!info || info.agent !== session.agent) return result;
    const live = hooks.get<{ text: string; marks: string; ts: string }>("SELECT text,marks,ts FROM journal WHERE id=? AND session_id=? AND kind='typed'", s.row, s.session);
    if (live && (hash(Array.from(live.text).slice(0, 1200).join("")) !== s.message_hash || live.marks || live.ts !== s.at)) return result;
    result.delivered ||= !!hooks.get("SELECT 1 FROM deliveries WHERE session_id=? AND entry_id=? AND action IN ('given','replaced')", s.session, entry.mex.id);
    // Host-backed Stage 2 kept the typed journal bytes as its sole wording
    // authority. The host's hint is never replayed as a source for Review.
    result.verified = host && !!live && Array.from(live.text).slice(0, 1200).join("").includes(record.quote)
      || typedQuote(info.transcript, session.agent === "claude-code" ? "claude" : "codex", record.quote, s.message_hash);
    return result;
  }); } finally { hooks?.close(); }
}
function git(root: string, args: string[], bytes = 1 << 20): string {
  return execFileSync("git", ["--literal-pathspecs", "-C", root, ...args], { encoding: "utf8", timeout: 1500, maxBuffer: bytes, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: backgroundEnvironment() });
}
function stamp(root: string): string { return hash(git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--", "."], 4 << 20) + git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])); }
function overlap(a: string[], b: string[]): boolean {
  const prefix = (s: string) => s.split(/[*?\[{]/u)[0]!;
  return a.some(x => b.some(y => x === "**" || y === "**" || prefix(x).startsWith(prefix(y)) || prefix(y).startsWith(prefix(x))));
}
/** One durable entry per batch. No model, Git commit, push, staging or branch creation. */
export async function publishNext(writer: RecordWriter, project: string, params: FilterParams, job: JobRow,
  overrides: Partial<PublicationDependencies> = {}): Promise<{ results: number; summary: string; wait?: string } | undefined> {
  const deps = { ...dependencies, ...overrides };
  // Existing learned notes from the previous slice have provenance but no offer.
  // Backfill one at a time; arbitrary personal files never enter this path.
  const legacy = writer.db.prepare(`SELECT s.key FROM settings s WHERE s.scope=? AND s.key LIKE 'learning.note.%'
    AND NOT EXISTS(SELECT 1 FROM settings o WHERE o.scope=s.scope AND o.key='learning.offer.'||substr(s.key,15)) ORDER BY s.key LIMIT 1`).get(project);
  if (legacy) {
    const id = String(legacy.key).slice("learning.note.".length);
    if (!EntryIdSchema.safeParse(id).success) throw new Error("Invalid learned-note identity.");
    const personal = readPersonal(writer, project, id);
    const backfill: OfferRow = { version: 1, id, checkout: params.checkout, position: await position(params.checkout), personal_hash: hash(personal?.raw ?? ""), state: personal ? "pending" : "applied" };
    save(writer, project, params, job, backfill);
    if (!personal) return { results: 0, summary: "Retired learned entry left personal" };
  }
  const row = writer.db.prepare(`SELECT value FROM settings WHERE scope=? AND key LIKE 'learning.offer.%'
    AND (json_valid(value)=0 OR (json_extract(value,'$.checkout')=? AND json_extract(value,'$.state')<>'applied'
    AND (json_extract(value,'$.state')<>'review' OR coalesce(json_extract(value,'$.reason'),'')<>'host-memory')
    AND (coalesce(json_extract(value,'$.last_job'),'')<>? OR json_extract(value,'$.state')='preview'))) ORDER BY key LIMIT 1`).get(project, params.checkout, job.id);
  if (!row) return undefined;
  let offer: OfferRow;
  try { if (Buffer.byteLength(String(row.value)) > 128 << 10) throw new Error(); offer = Offer.parse(JSON.parse(String(row.value))); }
  catch { throw new Error("Learned-entry publication metadata is invalid; notes were kept."); }
  const hold = (reason: string, review = false, reviewEntry?: KnowledgeEntry) => {
    offer = { ...offer, state: review ? "review" : "held", reason, last_job: job.id, ...(review ? { review_at: offer.review_at ?? deps.clock() } : {}) };
    save(writer, project, params, job, offer, () => {
      if (!review) return;
      const personal = readPersonal(writer, project, offer.id);
      if (!personal || hash(personal.raw) !== offer.personal_hash) return;
      const entry = reviewEntry ?? personal.entry;
      stageReview(writer, project, learningReviewId(project, entry), entry, { producer: "learning", key: keyFor(offer.id),
        checkout: params.checkout, level: "personal", path: personal.path, original_hash: offer.personal_hash }, reviewReason(reason), true, offer.review_at);
    });
    return { results: 0, summary: "Learned entry stays personal: " + reason };
  };
  if (!sharingEnabled(writer, project, params.checkout)) return hold("not-shared");
  const found = readPersonal(writer, project, offer.id);
  const host = !!found && hostCorroborated(found.entry);
  const manual = writer.setting(project, "learning.sharing") === "manual";
  if (manual && !host) return hold("manual-sharing");
  if (!found || hash(found.raw) !== offer.personal_hash) return hold("personal-entry-changed");
  const quiet = reviewQuiet(writer, project, found.entry, deps.clock());
  if (quiet) return hold(quiet);
  const metadata = learningMetadata(writer, project, offer.id), metadataHash = hash(JSON.stringify(metadata));
  if (metadata.holds?.length || shareProblems(found.entry).length) return hold("privacy");
  if (host) {
    const sources = metadata.sources ?? [], quote = found.entry.mex.source.quote;
    const observations = deps.verify(writer, project, found.entry, sources).filter((_, i) => sources[i]?.quote === quote);
    const decision = promotionDecision({ evidence: { source: "person", observations,
      corroboration: { kind: "host-memory", verified: metadata.corroborated === "host-memory", sameClaim: !!quote } },
      shared: true, manual, visibility: "unknown", authorized: false, privacyHolds: [],
      checksHold: !metadata.needs_checks && found.entry.mex.checks.some(check => check.role === "complete"), conflict: false });
    // The personal entry retains observed evidence. Review proposes a new team
    // copy from the independently verified person quote, with explicit consent.
    return hold(decision.reason, decision.destination === "review", { ...found.entry, mex: { ...found.entry.mex, evidence: "person" } });
  }
  if (found.entry.mex.source.type !== "person" || found.entry.mex.evidence !== "person") return hold("producer-evidence-unavailable");
  const at = await position(params.checkout);
  if (!at.branch || !at.head || !samePosition(at, offer.position)) return hold("checkout-changed");
  const policy = await deps.repository(params.checkout);
  const sources = metadata.sources ?? [], observations = deps.verify(writer, project, found.entry, sources);
  const sourceDecision = promotionDecision({ evidence: { source: "person", observations }, shared: true, manual: false, ...policy, privacyHolds: metadata.holds ?? [], checksHold: true, conflict: false });
  if (sourceDecision.destination !== "team") return hold(sourceDecision.reason, sourceDecision.destination === "review");
  const targetMatches = () => projectIdentity(params.checkout).rootPath === realPath(params.checkout);
  if (!targetMatches()) return hold("checkout-identity-changed");
  const observedStamp = stamp(params.checkout);
  let preview;
  try { preview = prepareTeamWrite(found.entry, { home: writer.location.home, projectPath: params.checkout }, found.entry.mex.source.quote); }
  catch (error) { if (error instanceof KnowledgeError && error.code === "RETIRED_ENTRY") return hold("retired-team-entry", true); throw error; }
  // Team files carry no local provenance fields; compare against the bytes a team write makes.
  const teamBytes = serializeEntry(teamEntry(found.entry));
  if (preview.after !== teamBytes) return hold("write-gates-changed", true);
  let report;
  try { report = await deps.evaluate({ checkout: params.checkout, project_id: project, mex_home: writer.location.home, record_directory: writer.location.directory }); }
  catch { return hold("checks-unavailable", true); }
  const item = report.items?.find(i => i.id === offer.id && i.level === "personal" && i.path === found.path);
  const result = report.results?.find(r => r.entry_id === offer.id);
  const checksHold = !metadata.needs_checks && found.entry.mex.checks.length > 0 && item?.entry_hash === offer.personal_hash && result?.verdict === "held"
    && result.checks.length === found.entry.mex.checks.length && result.checks.every(c => c.status === "pass") && !!result.inputs;
  const team = teamEntries({ home: writer.location.home, projectPath: params.checkout }).entries;
  const teamHash = hash(JSON.stringify(team.map(t => serializeEntry(t.entry))));
  if (team.some(t => t.entry.mex.id !== offer.id && t.entry.mex.kind === found.entry.mex.kind && claimHash(t.entry.text) === claimHash(found.entry.text)
    && JSON.stringify([...new Set(t.entry.mex.scope)].sort()) === JSON.stringify([...new Set(found.entry.mex.scope)].sort()))) {
    save(writer, project, params, job, { ...offer, state: "applied", last_job: job.id, reason: "already-shared-claim" });
    return { results: 0, summary: "This claim is already shared; no duplicate file added" };
  }
  const same = team.find(t => t.entry.mex.id === offer.id);
  const conflict = team.some(t => t.entry.mex.id !== offer.id && t.entry.mex.kind === "decision" && overlap(t.entry.mex.scope, found.entry.mex.scope) && t.entry.text !== found.entry.text)
    || !!same && serializeEntry(same.entry) !== teamBytes;
  const decision = promotionDecision({ evidence: { source: "person", observations }, shared: true, manual: false, ...policy, privacyHolds: metadata.holds ?? [], checksHold, conflict });
  if (decision.destination !== "team") return hold(decision.reason, decision.destination === "review");
  if (!found.entry.mex.source.quote || !sources.some((s, index) => s.quote === found.entry.mex.source.quote && observations[index]?.verified && !observations[index]?.marked && !observations[index]?.delivered)) return hold("current-quote-unverified");
  if (contextSource(metadata)) return hold("context-assisted", true);
  if (!params.sessionId) return hold("preview-session-unavailable", true);
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    const host = params.agent === "claude" ? "claude-code" : params.agent;
    if (!hooks || hooks.diagnostic || !hooks.get("SELECT 1 FROM sessions WHERE session_id=? AND agent=? AND project_id=? AND checkout=? AND paused=0", params.sessionId, host, project, params.checkout)) return hold("preview-session-unavailable", true);
  } finally { hooks?.close(); }
  const actor = judgeActor(params.checkout, params.agent, params.sessionId);
  if (offer.state === "preview" && (offer.actor !== actor || offer.session !== params.sessionId || offer.metadata_hash !== metadataHash || offer.after !== preview.after)) return hold("preview-context-changed", true);
  if (preview.before !== null && preview.before !== preview.after) return hold("team-conflict", true);
  if (offer.state !== "preview") {
    if (preview.before === preview.after) { save(writer, project, params, job, { ...offer, state: "applied", last_job: job.id }); return { results: 0, summary: "Learned entry is already shared" }; }
    offer = { ...offer, state: "preview", actor, session: params.sessionId, notice: `learning.team.${shortHash(JSON.stringify([params.checkout, offer.id, offer.personal_hash, at, actor, preview.revision]))}`,
      after: preview.after, revision: preview.revision, metadata_hash: metadataHash, preview_at: deps.clock() };
    save(writer, project, params, job, offer, () => notice(writer, offer, "preview", `MEX proposes adding ${preview.path} to this working tree. The exact diff follows; it will apply only while this session and its evidence still match.\n${preview.diff}`));
    return { results: 0, summary: "Learned-entry diff queued for the current session", wait: PUBLICATION_WAIT };
  }
  if (!shown(writer, offer)) {
    if (deps.clock() - (offer.preview_at ?? 0) >= 5 * 60_000) return hold("preview-not-shown", true);
    return { results: 0, summary: "Waiting for the learned-entry diff to reach the person", wait: PUBLICATION_WAIT };
  }
  if (preview.before === null && preview.revision !== offer.revision) return hold("preview-changed", true);
  if (JSON.stringify(await deps.repository(params.checkout)) !== JSON.stringify(policy)) return hold("repository-policy-changed", true);
  await withCheckoutPublication(params.checkout, at, () => {
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      if (!owned(writer, project, params, job) || !sharingEnabled(writer, project, params.checkout) || writer.setting(project, "learning.sharing") === "manual"
        || readPersonal(writer, project, offer.id)?.raw !== found.raw || hash(JSON.stringify(learningMetadata(writer, project, offer.id))) !== metadataHash
        || stamp(params.checkout) !== observedStamp || !shown(writer, offer) || reviewQuiet(writer, project, found.entry, deps.clock())) throw new Error("Publication inputs or consent changed; entry was kept personal.");
      if (hash(JSON.stringify(deps.verify(writer, project, found.entry, sources))) !== hash(JSON.stringify(observations))) throw new Error("Publication source changed; entry was kept personal.");
      if (hash(JSON.stringify(teamEntries({ home: writer.location.home, projectPath: params.checkout }).entries.map(t => serializeEntry(t.entry)))) !== teamHash) throw new Error("Team decisions changed; entry was kept personal.");
      for (const [path, baseline] of Object.entries(result!.inputs!)) {
        const text = readSource(params.checkout, path);
        if ((text === null ? "missing" : hash(text)) !== baseline) throw new Error("Publication checks changed; entry was kept personal.");
      }
      assertNoSecrets(found.entry);
      if (shareProblems(found.entry).length) throw new KnowledgeError("SECRET_FOUND", "The learned entry was withheld by the sharing scan.");
      if (!targetMatches()) throw new Error("Publication checkout identity changed; entry was kept personal.");
      if (preview.before === null) applyTeamWrite(preview, offer.revision!, { home: writer.location.home, projectPath: params.checkout }, found.entry.mex.source.quote);
      offer = { ...offer, state: "applied", last_job: job.id };
      set(writer, project, offer);
      notice(writer, offer, "updated", `MEX added ${preview.path} to this working tree from what you said. Include it in the normal PR.`);
      writer.db.exec("COMMIT");
    } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
  });
  return { results: 1, summary: "Learned entry added to this working tree; nothing staged or committed" };
}
