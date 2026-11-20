import { createHash } from "node:crypto";
import { existsSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../record/index.js";
import { realPath } from "../record/project.js";
import { readConflict, stageConflict, type StoredConflict } from "../review/conflicts.js";
import { REVIEW_DAYS } from "../review/state.js";
import { nativeBinary, runNative, type Verdict } from "./check.js";
import { knowledgeProject, type KnowledgeProject } from "./context.js";
import { CheckSchema, EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, parseEntry, serializeEntry, validateEntry, type EntryCheck, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, readBoundedTextFile, readEntryFile } from "./files.js";
import { scopesOverlap } from "./gate-scopes.js";
import type { AcceptedEntry, Dropped, GateContext, GateResult, Observation, Proposal, ProposedCheck } from "./gate-types.js";
import { assertNoSecrets, gateEntry } from "./gates.js";
import { publishNotes, readNotes, recoverNotes } from "./personal-store.js";
import { entryProducer, ownsEntryId, producer, producerEntryId, PRODUCER_IDS } from "./producers.js";
import { references, repoFile, withoutEnvironment } from "./references.js";
import { scanRuleFiles } from "./rule-files.js";
import { claimHash, retiredClaimHashes, saveTombstone } from "./state.js";
import { teamClaims } from "./team.js";

export type { Accepted, AcceptedEntry, Conflict, Dropped, DropReason, GateContext, GateResult, Observation, ObserveChecks, Proposal, ProposedCheck, Sweep } from "./gate-types.js";

const FINGERPRINT = "sha256:" + "0".repeat(64);
const defaults = {
  key: { value: true }, value: { value: null }, command: { exists: true }, pattern: { count: 0 }, relation: { count: 0 },
  source: { hash: FINGERPRINT }, section: { hash: FINGERPRINT }, symbol: { fingerprint: FINGERPRINT },
};
const normalize = (text: string) => text.trim().replace(/\s+/gu, " ");
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const drop = (reason: Dropped["reason"], detail?: string): Dropped => ({ status: "dropped", reason, ...(detail ? { detail } : {}) });
const invalid = (message: string): never => { throw new KnowledgeError("INVALID_ENTRY", message); };
const message = (error: unknown) => error instanceof Error ? error.message : undefined;
const publicationKey = (id: string) => `knowledge.gate.${id}`;
const sweepBy = (id: Proposal["producer"]) => id === "setup-recipe" ? "mex setup" : `mex ${id} refresh`;
const isActive = (e: KnowledgeEntry) => e.mex.status === "active";

interface Candidate {
  entry: KnowledgeEntry;
  checks: ProposedCheck[];
  evidence: NonNullable<Proposal["evidence"]>;
  replaces?: string;
  sanitized: NonNullable<AcceptedEntry["sanitized"]>;
}
interface Active { entry: KnowledgeEntry; level: "personal" | "team" | "hint"; }
interface Existing extends Active { claim: string; }
type ConflictProof = StoredConflict["conflicts"][number];
interface Publication { hash: string; evidence: Candidate["evidence"]; replaces?: string; approved?: ConflictProof[]; }
const conflictProof = ({ entry, level }: Existing): ConflictProof =>
  ({ id: entry.mex.id, level, revision: digest(serializeEntry(entry)) });

function publication(writer: RecordWriter, project: string, id: string): Publication | undefined {
  const value = writer.setting(project, publicationKey(id));
  if (!value || Buffer.byteLength(value) > 256 << 10) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed.hash === "string" ? parsed as Publication : undefined;
  } catch { return undefined; }
}

function preflight(p: Proposal, tree: string, date: string, source: () => ReturnType<typeof references>,
  special?: { entry: KnowledgeEntry; mode: "note" | "judge" | "review" }): Candidate | Dropped {
  let entry: KnowledgeEntry, checks: ProposedCheck[], evidence: Candidate["evidence"];
  try {
    if (!PRODUCER_IDS.includes(p.producer)) invalid("Unknown producer.");
    const owner = producer(p.producer);
    if (p.key !== undefined && (typeof p.key !== "string" || !p.key.trim() || Buffer.byteLength(p.key) > 4096 || p.id !== undefined)) invalid("Supply a bounded key or an entry id.");
    if (p.id !== undefined && (!EntryIdSchema.safeParse(p.id).success || (special?.mode !== "judge" && !ownsEntryId(p.id, owner)))) invalid("Entry id is outside the producer's namespace.");
    if (p.replaces !== undefined && (!EntryIdSchema.safeParse(p.replaces).success || !ownsEntryId(p.replaces, owner) || p.replaces === p.id)) invalid("Replacement id is outside the producer's namespace or is the same entry.");
    if (p.kind as string === "hint") invalid("Hints are not producer entries.");
    if (p.model === undefined || p.model === null) invalid("Specify a model or none.");
    if (p.evidenceClass !== undefined && !owner.variesEvidence) invalid("This producer has a fixed evidence class.");
    evidence = p.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.length > 32 || !evidence.every(ref =>
      typeof ref === "string" ? ref.length > 0 && ref.length <= 512 : Number.isFinite(ref))) invalid("Evidence references exceed the proposal limits.");
    const symbols: ProposedCheck[] = (p.anchors?.symbols ?? []).map(target => ({ kind: "symbol", role: "supporting", target }));
    checks = [...(p.checks ?? []), ...symbols];
    const storedChecks = checks.map(check => {
      const { saw, ...request } = check;
      if (!Object.hasOwn(defaults, check.kind)) invalid("Unsupported proposed check.");
      return { ...request, saw: saw === undefined ? defaults[check.kind] : saw, files: {} };
    });
    const { type, ref, quote } = p.source;
    if (p.source.text !== undefined && (typeof p.source.text !== "string" || Buffer.byteLength(p.source.text) > 1024 * 1024)) invalid("Source text exceeds its verification limit.");
    const old = special?.entry.mex;
    entry = validateEntry({ text: p.text.trim().replace(/\r\n/gu, "\n"), mex: {
      id: p.id ?? producerEntryId(p.producer, p.key), kind: p.kind, scope: p.anchors?.scope ?? ["**"],
      source: { type, ref, ...(quote === undefined ? {} : { quote }), producer: p.producer,
        ...(p.model === "none" ? {} : { model: p.model }), ...(p.label === undefined ? {} : { label: p.label }) },
      evidence: p.evidenceClass ?? owner.evidence, one_line: p.oneLine ?? normalize(p.text),
      aliases: p.aliases, asks: p.asks, when: p.anchors?.when, checks: storedChecks,
      status: old?.status ?? "active", created: old?.created ?? date,
      ...(old?.commit ? { commit: old.commit } : {}), ...(old?.supersedes ? { supersedes: old.supersedes } : {}),
      ...(old?.companions ? { companions: old.companions } : {}),
    } });
    serializeEntry(entry);
    if (p.replaces === entry.mex.id) invalid("An entry cannot replace itself.");
  } catch (error) { return drop("invalid", message(error)); }

  const owner = producer(p.producer);
  if (!owner.active) return drop("inactive-producer");
  try { assertNoSecrets({ entry, evidence }); }
  catch (error) { return drop("secret", message(error)); }
  let gated: KnowledgeEntry;
  const kept: number[] = [];
  try { gated = gateEntry(entry, source(), index => kept.push(index)); }
  catch (error) { return drop(error instanceof KnowledgeError && error.code === "SECRET_FOUND" ? "secret" : "undefined-command", message(error)); }
  const sanitized: Candidate["sanitized"] = [];
  if (gated.text !== entry.text) sanitized.push("text");
  if (gated.mex.one_line !== entry.mex.one_line) sanitized.push("oneLine");
  if (!isDeepStrictEqual(gated.mex.checks, entry.mex.checks)) sanitized.push("checks");
  if (gated.mex.source.quote !== entry.mex.source.quote) sanitized.push("quote");
  if (!owner.personAuthored && sanitized.some(field => field !== "quote")) return drop("undefined-command", "The entry contains an unverified command, link or check.");
  // A judge rewrite repairs an existing entry; it keeps whatever anchors the original had.
  if (owner.requiresAnchor && special?.mode !== "judge" && !gated.mex.scope.some(glob => !/^(?:\*\*\/)*\*\*$/u.test(glob)) && !gated.mex.when?.length
    && !p.anchors?.symbols?.length && !gated.mex.checks.some(check => check.kind === "symbol"
      || (check.kind === "command" && ["recipe", "procedure"].includes(gated.mex.kind)))) return drop("no-anchor");
  const quote = entry.mex.source.quote;
  if (quote !== undefined) {
    try {
      const file = repoFile(tree, p.source.ref);
      const body = file ? readBoundedTextFile(file, 1024 * 1024) : p.source.text;
      if (!normalize(quote) || !body || !normalize(body).includes(normalize(quote))) return drop("quote-not-found");
    } catch { return drop("quote-not-found"); }
  }

  const cleanChecks = gated.mex.checks.map((check, i) => toProposedCheck(check, checks[kept[i]!]!.saw !== undefined));
  return { entry: gated, checks: cleanChecks, evidence, replaces: p.replaces, sanitized };
}

export function toProposedCheck(check: Exclude<EntryCheck, { kind: "legacy-grounding" }>, withSaw?: boolean): ProposedCheck;
export function toProposedCheck(check: EntryCheck, withSaw?: boolean): ProposedCheck;
export function toProposedCheck(check: EntryCheck, withSaw = true): ProposedCheck {
  if (check.kind === "legacy-grounding") invalid("Legacy checks cannot be renewed.");
  const { kind, role, target, saw } = check;
  return { kind, role, target, ...(withSaw ? { saw } : {}) } as ProposedCheck;
}

function ruleClaims(tree: string): Set<string> {
  const claims = new Set<string>();
  const add = (text: string) => { const value = ruleKey(text); if (value) claims.add(value); };
  const scan = scanRuleFiles(tree, undefined, undefined, body => body.split(/\r?\n/gu).forEach(add));
  for (const { entry } of scan.entries) { add(entry.text); add(entry.mex.one_line); }
  return claims;
}
const ruleKey = (text: string) => normalize(text.normalize("NFKC").toLowerCase().replace(/[`*_>]/gu, "").replace(/^\s*(?:#+|[-+]|\d+[.)])\s+/u, ""));
const scopeKey = (entry: KnowledgeEntry) => JSON.stringify([...new Set(entry.mex.scope)].sort());
function sameTarget(a: EntryCheck, b: EntryCheck): boolean {
  if (a.kind === "command" && b.kind === "command") return isDeepStrictEqual(
    { ...a.target, run: withoutEnvironment(a.target.run.trim()) }, { ...b.target, run: withoutEnvironment(b.target.run.trim()) });
  if (a.kind === "pattern" && b.kind === "pattern") return isDeepStrictEqual(
    { ...a.target, match: a.target.match ?? "literal" }, { ...b.target, match: b.target.match ?? "literal" });
  return a.kind === b.kind && isDeepStrictEqual(a.target, b.target);
}
function duplicate(a: KnowledgeEntry, b: Existing, hash: string): boolean {
  if (hash === b.claim) return true;
  if (a.mex.kind === b.entry.mex.kind && a.mex.checks.some(check => check.role === "complete"
    && b.entry.mex.checks.some(old => old.role === "complete" && sameTarget(check, old)))) return true;
  return !!a.mex.when?.some(trigger => b.entry.mex.when?.some(old => trigger.type === old.type && trigger.pattern === old.pattern))
    && scopeKey(a) === scopeKey(b.entry);
}
function checkRequest(project: KnowledgeProject, tree: string) {
  return { checkout: tree, project_id: project.projectId, mex_home: project.location.home, record_directory: project.location.directory };
}
function observations(checks: ProposedCheck[], context: GateContext, project: KnowledgeProject, tree: string): Observation[] | undefined {
  if (!checks.length) return [];
  try {
    if (context.observeChecks) return context.observeChecks(checks, tree);
    const binary = nativeBinary(context.env);
    if (!binary) return undefined;
    const result = runNative(binary, { ...checkRequest(project, tree), action: "record-batch",
      items: checks.map(({ kind, role, target }) => ({ kind, role, target })) }) as unknown as {
        results?: Array<{ ok?: boolean; check?: unknown; error?: string }>;
      };
    return result.results?.map(item => {
      const check = CheckSchema.safeParse(item.check);
      return item.ok && check.success ? { check: check.data } : { reason: (item.error ?? "Invalid recorded check.").slice(0, 512) };
    });
  } catch { return undefined; }
}
function currentVerdicts(context: GateContext, project: KnowledgeProject): ReadonlyMap<string, Verdict> {
  try {
    if (context.observeVerdicts) return context.observeVerdicts(project.root);
    const binary = nativeBinary(context.env);
    if (binary) return new Map(runNative(binary, { ...checkRequest(project, project.root), action: "evaluate", store: false })
      .items?.map(item => [`${item.id}:${item.level}`, item.verdict]));
  } catch { /* Unknown verdicts cannot dismiss a conflict. */ }
  return new Map();
}

function conflictWith(entry: KnowledgeEntry, old: Existing, verdicts: () => ReadonlyMap<string, Verdict>): boolean {
  const opposite = (a: string, b: string) => a === "required" && (b === "anti" || b === "rejected");
  if (entry.mex.when?.some(trigger => old.entry.mex.when?.some(other => trigger.pattern === other.pattern
    && (opposite(trigger.type, other.type) || opposite(other.type, trigger.type))))
    && entry.mex.scope.some(a => old.entry.mex.scope.some(b => scopesOverlap(a, b)))) return true;
  if (!entry.mex.checks.some(check => old.entry.mex.checks.some(other => sameTarget(check, other) && !isDeepStrictEqual(check.saw, other.saw)))) return false;
  const current = verdicts(), id = old.entry.mex.id;
  const verdict = current.get(`${id}:${old.level}`) ?? current.get(id);
  return verdict !== "broken" && verdict !== "changed";
}
function hintClaims(project: KnowledgeProject): KnowledgeEntry[] {
  const directory = containedDirectory(project.location.home, ["projects", project.projectId, "hints"]);
  if (!directory) return [];
  const handle = opendirSync(directory), entries: KnowledgeEntry[] = [];
  try {
    let item, count = 0, bytes = 0;
    while ((item = handle.readSync())) {
      if (++count > KNOWLEDGE_LIMITS.entries) throw new KnowledgeError("STORE_LIMIT", "Hints exceed the directory scan limit.");
      if (!/^mx_[a-z0-9]{6,64}\.md$/u.test(item.name)) continue;
      const raw = readEntryFile(join(directory, item.name));
      if (!raw) continue;
      bytes += Buffer.byteLength(raw);
      if (bytes > KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("STORE_LIMIT", "Hints exceed the byte scan limit.");
      const entry = parseEntry(raw);
      if (entry.mex.id + ".md" !== item.name) invalid("Hint id differs from its filename.");
      if (isActive(entry)) entries.push(entry);
    }
    return entries;
  } finally { handle.closeSync(); }
}

const activeEntry = (entry: KnowledgeEntry, level: Active["level"]): Existing => ({ entry, level, claim: claimHash(entry.text) });
function compare(p: Candidate, others: Existing[], forgotten: Set<string>, retired: (id: string) => boolean, rules: () => Set<string>): Dropped | undefined {
  const { entry } = p, { id, kind } = entry.mex, hash = claimHash(entry.text);
  if (retired(id) || forgotten.has(hash)) return drop("forgotten");
  const duplicateId = others.find(other => (other.entry.mex.id === id || duplicate(entry, other, hash)));
  if (duplicateId) return drop("duplicate-entry", duplicateId.entry.mex.id);
  const commandRecipe = kind === "recipe" && entry.mex.checks.some(check => check.kind === "command");
  const commandOnly = (text: string) => commandRecipe && entry.mex.checks.some(check =>
    check.kind === "command" && ruleKey(withoutEnvironment(check.target.run.trim())) === ruleKey(withoutEnvironment(text.replace(/[`]/gu, "").trim())));
  if ([entry.text, entry.mex.one_line].some(text => !commandOnly(text) && rules().has(ruleKey(text)))) return drop("duplicate-rule-line");
  return undefined;
}

function recheck(p: Candidate, observed?: Observation[]): Dropped | undefined {
  if (!p.checks.length) return undefined;
  if (!observed || observed.length !== p.checks.length) return drop("checks-unavailable");
  const fresh: EntryCheck[] = [];
  for (const [i, request] of p.checks.entries()) {
    const outcome = observed[i]!;
    if ("reason" in outcome) return drop("check-fails", outcome.reason);
    const parsed = CheckSchema.safeParse(outcome.check);
    if (!parsed.success || parsed.data.kind !== request.kind || parsed.data.role !== request.role || !isDeepStrictEqual(parsed.data.target, request.target)) {
      return drop("check-fails", "The evaluator returned a different check.");
    }
    if (parsed.data.kind === "command" && !parsed.data.saw.exists) return drop("check-fails", "The command is not defined.");
    if (request.saw !== undefined && !isDeepStrictEqual(request.saw, parsed.data.saw)) return drop("check-fails", "The stated observation differs from today's observation.");
    fresh.push(parsed.data);
  }
  p.entry.mex.checks = fresh;
  try { assertNoSecrets(fresh); } catch (error) { return drop("secret", message(error)); }
  try { serializeEntry(p.entry); } catch (error) { return drop("invalid", message(error)); }
  return undefined;
}

function owns(writer: RecordWriter, project: string, entry: KnowledgeEntry, raw: string, owner: Proposal["producer"]): boolean {
  const { id, source, kind } = entry.mex;
  if (!ownsEntryId(id, producer(owner)) || entryProducer(entry.mex) !== owner) return false;
  const proof = publication(writer, project, id);
  if (proof) return proof.hash === digest(raw);
  if (source.producer || source.type === "person" && /^mex edit(?: |$)/u.test(source.ref)) return false;
  if (owner === "setup-recipe") return kind === "recipe" && source.type === "config";
  if (owner !== "learn-deeper") return false;
  const legacy = writer.setting(project, `learning.deep.note.${id}`);
  if (!legacy || Buffer.byteLength(legacy) > 20_000) return false;
  try { return JSON.parse(legacy).hash === digest(raw); } catch { return false; }
}

function activeClaims(project: KnowledgeProject, notes: Map<string, KnowledgeEntry>): Existing[] {
  return [
    ...[...notes.values()].filter(isActive).map(entry => activeEntry(entry, "personal")),
    ...teamClaims(project.root).map(entry => activeEntry(entry, "team")),
    ...hintClaims(project).map(entry => activeEntry(entry, "hint")),
  ].filter(({ entry }) => !project.retired.has(entry.mex.id));
}

function saveBatch(proposals: Proposal[], context: GateContext, special?: { entry: KnowledgeEntry; mode: "note" | "review" },
  approval?: { id: string; item: StoredConflict }): GateResult[] {
  if (proposals.length > KNOWLEDGE_LIMITS.entries) return proposals.map(() => drop("invalid", "Too many proposals."));
  const now = context.now ?? new Date(), date = now.toISOString().slice(0, 10);
  let project = knowledgeProject(context);
  const checkout = project.root;
  const tree = context.checkTree === undefined ? project.root : realPath(context.checkTree);
  let refs: ReturnType<typeof references> | undefined;
  let ruleLines: Set<string> | undefined;
  const rules = () => ruleLines ??= ruleClaims(tree);
  const pending = Array.from(proposals, p => preflight(p, tree, date, () => refs ??= references(tree), special));
  if (pending.every(item => "status" in item) && !context.sweep && !context.validate && !context.onAccepted) return pending as Dropped[];

  const writer = openRecord({ ...context, create: true });
  try {
    writer.db.exec("BEGIN IMMEDIATE");
    context.validate?.(writer);
    project = knowledgeProject(context);
    if (project.root !== checkout) throw new KnowledgeError("STALE_ENTRY", "The checkout changed before saving.");
    const { projectId, location } = project;
    if (writer.checkout(context.projectPath)?.project_id !== projectId) throw new KnowledgeError("RECORD_UNAVAILABLE", "The project could not be registered.");
    const parent = containedDirectory(location.home, ["projects", projectId]);
    if (parent && existsSync(join(parent, "notes.pending"))) {
      recoverNotes(writer, projectId, true);
    }
    const snapshot = readNotes(location.home, projectId), files = new Map(snapshot.files);
    const notes = new Map([...files].map(([id, raw]) => [id, parseEntry(raw)]));
    let active = activeClaims(project, notes);
    const forgotten = retiredClaimHashes(writer, projectId);
    const retired = (id: string) => project.retired.has(id);
    const accepted: AcceptedEntry[] = [];
    let storedBytes = [...files.values()].reduce((n, raw) => n + Buffer.byteLength(raw), 0);
    const put = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value WHERE settings.value<>excluded.value");
    const save = (id: string, hash: string, evidence?: Candidate["evidence"], replaces?: string, approved?: ConflictProof[]) => {
      const previous = publication(writer, projectId, id);
      const record = JSON.stringify({ hash, evidence: evidence ?? previous?.evidence ?? [], replaces, approved });
      if (Buffer.byteLength(record) > 256 << 10) throw new KnowledgeError("STORE_LIMIT", "Producer metadata exceeds its size limit.");
      if (JSON.stringify(previous) !== record) put.run(projectId, publicationKey(id), record);
    };
    const retire = (entry: KnowledgeEntry, reason: string, by: string, permanent: boolean) => {
      const info = { reason, by, at: date };
      const raw = serializeEntry({ ...entry, mex: { ...entry.mex, status: "retired", retired: info } });
      storedBytes += Buffer.byteLength(raw) - Buffer.byteLength(files.get(entry.mex.id) ?? "");
      files.set(entry.mex.id, raw);
      if (permanent) {
        saveTombstone(writer, projectId, entry, info);
        project.retired.add(entry.mex.id);
        forgotten.add(claimHash(entry.text));
      } else save(entry.mex.id, digest(raw));
      active = active.filter(other => other.level !== "personal" || other.entry.mex.id !== entry.mex.id);
    };

    const beforeChecks = (p: Candidate) => {
      const { id, source } = p.entry.mex, owner = source.producer!;
      const old = notes.get(id), raw = files.get(id);
      if (retired(id) || forgotten.has(claimHash(p.entry.text))) return drop("forgotten");
      if (old && (!isActive(old) && old.mex.status !== "proposed" && old.mex.retired?.by !== sweepBy(owner))) return drop("forgotten");
      if (old && (!raw || !owns(writer, projectId, old, raw, owner))) return drop("duplicate-entry", "That entry was edited outside this producer.");
      if (p.replaces) {
        const replaced = notes.get(p.replaces), replacementRaw = files.get(p.replaces);
        if (!replaced || !isActive(replaced) || retired(p.replaces) || !replacementRaw || !owns(writer, projectId, replaced, replacementRaw, owner)) {
          const previous = old && publication(writer, projectId, id);
          if (!previous || previous.replaces !== p.replaces) return drop("invalid", "The replacement target is no longer an active entry owned by this producer.");
        }
      }
      return compare(p, active.filter(other => other.level !== "personal" || other.entry.mex.id !== id), forgotten, retired, rules);
    };
    const checks: ProposedCheck[] = [], offsets = new Map<Candidate, number>();
    const firstPass = pending.map(p => {
      if ("status" in p) return p;
      const failure = beforeChecks(p);
      if (failure) return failure;
      if (checks.length + p.checks.length <= 4096) {
        offsets.set(p, checks.length);
        checks.push(...p.checks);
      }
      return p;
    });
    const observed = observations(checks, context, project, tree);
    let verdicts: ReadonlyMap<string, Verdict> | undefined;
    const getVerdicts = () => verdicts ??= currentVerdicts(context, project);

    if (approval) {
      const { id, item } = approval;
      const current = readConflict(writer, projectId, id);
      if (!isDeepStrictEqual(item, current) || item.checkout !== project.root ||
        !writer.db.prepare("SELECT 1 FROM review WHERE id=? AND project_id=? AND reason='contradiction' AND state='pending' AND created_at>? AND created_at<=?").get(id, projectId, new Date(now.getTime() - REVIEW_DAYS * 86400000).toISOString(), now.toISOString())) {
        throw new KnowledgeError("STALE_PREVIEW", "Review inputs changed; preview the action again.");
      }
      if (item.conflicts.some(conflict => !active.some(other => other.level === conflict.level && other.entry.mex.id === conflict.id
        && digest(serializeEntry(other.entry)) === conflict.revision))) throw new KnowledgeError("STALE_PREVIEW", "A conflicting entry changed; preview the action again.");
    }

    const results = firstPass.map((p): GateResult => {
      if ("status" in p) return p;
      const failure = beforeChecks(p);
      if (failure) return failure;
      const offset = offsets.get(p);
      const checkFailure = recheck(p, offset === undefined ? undefined : observed?.slice(offset, offset + p.checks.length));
      if (checkFailure) return checkFailure;
      const { entry } = p, { id, source } = entry.mex;
      const old = notes.get(id);
      if (old) entry.mex.created = old.mex.created;
      const raw = serializeEntry(entry);
      const hash = digest(raw), previous = publication(writer, projectId, id);
      const reviewed = previous?.hash === hash && Array.isArray(previous.approved) ? previous.approved : [];
      const conflicts = approval ? [] : active.filter(other => other.entry.mex.id !== id && conflictWith(entry, other, getVerdicts)
        && !reviewed.some(prior => prior?.id === other.entry.mex.id && prior.level === other.level
          && prior.revision === conflictProof(other).revision));
      if (conflicts.length) {
        const proof = conflicts.map(conflictProof)
          .sort((a, b) => a.id.localeCompare(b.id) || a.level.localeCompare(b.level));
        const reviewId = stageConflict(writer, projectId, { entry, checkout: project.root, evidence: p.evidence, replaces: p.replaces, conflicts: proof }, now);
        return { status: "review", reason: "contradiction", conflictsWith: [...new Set(proof.map(other => other.id))], reviewId };
      }
      const before = files.get(id);
      const bytes = storedBytes + Buffer.byteLength(raw) - Buffer.byteLength(before ?? "");
      if ((!before && files.size >= KNOWLEDGE_LIMITS.entries) || bytes > KNOWLEDGE_LIMITS.scanBytes) {
        return drop("invalid", "The entry would exceed the personal store limits.");
      }
      storedBytes = bytes;
      const result: GateResult = { status: "accepted", entryId: id, change: before === undefined ? "new" : before === raw ? "unchanged" : "updated",
        ...(p.sanitized.length ? { sanitized: p.sanitized } : {}) };
      files.set(id, raw);
      notes.set(id, entry);
      active = active.filter(other => other.level !== "personal" || other.entry.mex.id !== id);
      if (isActive(entry)) active.push(activeEntry(entry, "personal"));
      const approved = approval?.item.conflicts.filter(other => other.level !== "personal") ?? reviewed;
      save(id, hash, p.evidence, p.replaces, approved.length ? approved : undefined);
      const replaced = p.replaces && notes.get(p.replaces);
      if (replaced && isActive(replaced) && !retired(replaced.mex.id)) retire(replaced, "Superseded by a newer entry.", `mex ${source.producer}`, true);
      if (approval) for (const other of approval.item.conflicts) {
        if (other.level !== "personal") continue;
        const old = notes.get(other.id)!;
        retire(old, "replaced in review", "mex review", true);
      }
      accepted.push({ ...result, entry });
      return result;
    });
    if (approval && accepted.length) {
      writer.db.prepare("UPDATE review SET state='accepted' WHERE id=? AND project_id=?").run(approval.id, projectId);
    }

    const sweep = context.sweep;
    if (sweep && !results.some((result, i) => proposals[i]?.producer === sweep.producer && result.status === "dropped"
      && !["forgotten", "duplicate-entry", "duplicate-rule-line"].includes(result.reason))) {
      const wanted = new Set(pending.flatMap((p, i) => proposals[i]?.producer !== sweep.producer ? [] :
        ["status" in p ? proposals[i]!.id : p.entry.mex.id]));
      for (const [id, entry] of notes) {
        const raw = files.get(id)!;
        if (!wanted.has(id) && !retired(id) && isActive(entry) && owns(writer, projectId, entry, raw, sweep.producer) && (!sweep.includes || sweep.includes(entry))) {
          retire(entry, sweep.producer === "setup-recipe" ? "This command is no longer in the setup recipes." : "This entry is no longer produced.", sweepBy(sweep.producer), false);
        }
      }
    }

    if (storedBytes > KNOWLEDGE_LIMITS.scanBytes) {
      throw new KnowledgeError("STORE_LIMIT", "Personal notes exceed the byte or entry limit.");
    }
    const changed = files.size !== snapshot.files.size || [...files].some(([id, raw]) => snapshot.files.get(id) !== raw);
    if (changed) publishNotes(writer, projectId, snapshot, files, () => context.onAccepted?.(writer, accepted), { locked: true });
    else { context.onAccepted?.(writer, accepted); writer.db.exec("COMMIT"); }
    return results;
  } finally {
    try { writer.db.exec("ROLLBACK"); } catch { /* The transaction already ended. */ }
    finally { writer.close(); }
  }
}

/** Save proposals in order, with one write transaction for the batch. */
export async function propose(proposals: Proposal[], context: GateContext): Promise<GateResult[]> {
  return saveBatch(proposals, context);
}

/** Synchronous entry point for setup's existing local writer. */
export function proposeSync(proposals: Proposal[], context: GateContext): GateResult[] {
  return saveBatch(proposals, context);
}

/** Preserve decision metadata and the synchronous note command. */
export function proposeNote(proposal: Proposal, entry: KnowledgeEntry, context: GateContext): GateResult {
  return saveBatch([proposal], context, { entry, mode: "note" })[0]!;
}

export function proposalFromEntry(entry: KnowledgeEntry, producer: Proposal["producer"], options: {
  model?: Proposal["model"]; evidence?: Proposal["evidence"]; sourceText?: string; replaces?: string; includeEvidenceClass?: boolean;
} = {}): Proposal {
  const m = entry.mex;
  if (m.kind === "hint") throw new KnowledgeError("INVALID_ENTRY", "Hints are not producer entries.");
  return { producer, id: m.id, kind: m.kind, text: entry.text, oneLine: m.one_line, aliases: m.aliases, asks: m.asks,
    source: { type: m.source.type, ref: m.source.ref, quote: m.source.quote, text: options.sourceText },
    anchors: { scope: m.scope, when: m.when }, checks: m.checks.map(check => toProposedCheck(check)),
    model: options.model ?? m.source.model ?? "none", label: m.source.label, replaces: options.replaces,
    evidence: options.evidence, ...(options.includeEvidenceClass ? { evidenceClass: m.evidence } : {}) };
}

/** Revalidate an exact, pending personal Review proposal. Only Review authorizes this path. */
export function useConflict(id: string, item: StoredConflict, context: GateContext): GateResult {
  const owner = item.entry.mex.source.producer!;
  const proposal = proposalFromEntry(item.entry, owner, {
    evidence: item.evidence, sourceText: item.entry.mex.source.quote, replaces: item.replaces, includeEvidenceClass: producer(owner).variesEvidence,
  });
  return saveBatch([proposal], context, { entry: item.entry, mode: "review" }, { id, item })[0]!;
}

/** Vet an in-place judge rewrite without writing it or changing its stable id. */
export function vetRewrite(entry: KnowledgeEntry, original: KnowledgeEntry, model: NonNullable<KnowledgeEntry["mex"]["source"]["model"]>,
  context: GateContext, writer?: RecordWriter): { entry: KnowledgeEntry } | Dropped | { status: "review"; reason: "contradiction" } {
  if (entry.mex.id !== original.mex.id || !isDeepStrictEqual(entry.mex.source, original.mex.source)) {
    return drop("invalid", "A rewrite must preserve the original id and source.");
  }
  const project = knowledgeProject(context), tree = context.checkTree === undefined ? project.root : realPath(context.checkTree);
  let candidate: Candidate | Dropped;
  try {
    const proposal = proposalFromEntry(entry, "judge", { model, includeEvidenceClass: true, sourceText: original.mex.source.quote });
    candidate = preflight(proposal, tree, entry.mex.created, () => references(tree), { entry, mode: "judge" });
  } catch (error) { return drop("invalid", message(error)); }
  if ("status" in candidate) return candidate;
  const reader = writer ?? openRecordReadOnly(context);
  let forgotten: Set<string>;
  try { forgotten = reader ? retiredClaimHashes(reader, project.projectId) : new Set(); }
  finally { if (!writer) reader?.close(); }
  const notes = new Map([...readNotes(project.location.home, project.projectId).files].map(([id, raw]) => [id, parseEntry(raw)]));
  const others = activeClaims(project, notes).filter(other => other.entry.mex.id !== entry.mex.id);
  const failure = compare(candidate, others, forgotten, id => project.retired.has(id), () => ruleClaims(tree))
    ?? recheck(candidate, observations(candidate.checks, context, project, tree));
  if (failure) return failure;
  let verdicts: ReadonlyMap<string, Verdict> | undefined;
  if (others.some(other => conflictWith(candidate.entry, other, () => verdicts ??= currentVerdicts(context, project)))) return { status: "review", reason: "contradiction" };
  return { entry: candidate.entry };
}

export function summarizeResults(results: readonly GateResult[]): string {
  const saved = results.filter(result => result.status === "accepted").length;
  const review = results.filter(result => result.status === "review").length;
  const reasons = new Map<string, number>();
  let dropped = 0;
  for (const result of results) if (result.status === "dropped") {
    dropped++;
    reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
  }
  return `${saved} saved, ${review} to Review, ${dropped} dropped${dropped ? ` (${[...reasons].map(([reason, n]) => `${reason} ${n}`).join(", ")})` : ""}`;
}
