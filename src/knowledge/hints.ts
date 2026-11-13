import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { openRecord, openRecordReadOnly, RecordReader, type RecordWriter } from "../record/index.js";
import { absolutePath } from "../record/project.js";
import { EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, parseEntry, serializeEntry, type KnowledgeEntry } from "./entry.js";
import { knowledgeProject } from "./context.js";
import { containedDirectory, createEntryFile, readEntryFile, replaceEntryFile } from "./files.js";
import { gateEntry, sanitizeText, stripHidden, hasSecret } from "./gates.js";
import { entryLabel } from "./labels.js";
import { references } from "./references.js";
import { claimHash, saveTombstone, saveHashedTombstone, tombstone, localSettings, retiredClaimHashes, type Tombstone } from "./state.js";
import { checkMemorySource, discoverMemory, memoryRoots, normalizeMemoryAgent, MEMORY_LIMITS, type MemoryAgent, type MemoryOptions } from "./host-memory.js";
import type { NoteInput, PersonalEntry } from "./store.js";

const PREFIX = "knowledge.hint.", EXPIRY = "knowledge.hint_expiry_months";
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const HintStateSchema = z.object({
  version: z.literal(1), id: EntryIdSchema, agent: z.enum(["claude-code", "codex"]),
  firstSeen: z.number().finite().nonnegative(), lastSeen: z.number().finite().nonnegative(),
  observations: z.array(hash).min(1).max(128), confirmed: z.boolean(), claimHash: hash,
  sourceRoot: z.string().min(1).max(4096), sourcePath: z.string().min(1).max(2048), sourceHash: hash,
  sourceBytes: z.number().int().nonnegative().max(MEMORY_LIMITS.fileBytes), ref: z.string().min(1).max(2048),
}).strict().refine(value => value.lastSeen >= value.firstSeen);
type HintState = z.infer<typeof HintStateSchema>;
export interface HintEntry { level: "hint"; label: string; origin: MemoryAgent; observations: number; entry: KnowledgeEntry; }
export interface HintRead { entries: HintEntry[]; withheld: number; partial: boolean; }
const stateKey = (id: string) => PREFIX + id;
function separateStorage(home: string, projectId: string, roots: Array<{ root: string }>): void {
  const destination = absolutePath(join(home, "projects", projectId, "hints"));
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  if (roots.some(source => inside(absolutePath(source.root), destination) || inside(destination, absolutePath(source.root)))) {
    throw new KnowledgeError("UNSAFE_SOURCE", "Host memory and MEX hint storage must use separate directories.");
  }
}
function parseState(value: string | undefined, id: string): HintState | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value) > 32 * 1024) throw new KnowledgeError("STORE_LIMIT", "A hint observation record exceeds its size limit.");
  try {
    const state = HintStateSchema.parse(JSON.parse(value));
    if (state.id !== id) throw new Error("Hint id mismatch");
    return state;
  } catch { throw new KnowledgeError("INVALID_STATE", "A local hint observation record is invalid."); }
}
function states(reader: RecordReader | RecordWriter, projectId: string): HintState[] {
  return localSettings(reader, projectId, PREFIX).map(row => parseState(row.value, row.key.slice(PREFIX.length))!);
}
function put(writer: RecordWriter, projectId: string, key: string, value: unknown): void {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > 32 * 1024) throw new KnowledgeError("STORE_LIMIT", "Hint state exceeds its size limit.");
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(projectId, key, bytes);
}
function expiryMonths(reader: Pick<RecordReader, "setting">, projectId: string): number {
  const raw = reader.setting(projectId, EXPIRY) ?? reader.setting("global", EXPIRY);
  const months = raw === undefined ? 6 : Number(raw);
  if (!Number.isSafeInteger(months) || months < 1 || months > 120) throw new KnowledgeError("INVALID_SETTING", "Hint expiry must be between 1 and 120 calendar months.");
  return months;
}
export function hintExpiresAt(lastSeen: number, months: number): number {
  const date = new Date(lastSeen), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}
function hintDirectory(writer: RecordWriter, projectId: string, create = false): string | undefined {
  return containedDirectory(writer.location.home, ["projects", projectId, "hints"], create);
}
function readHint(directory: string, state: HintState): { entry: KnowledgeEntry; content: string } | undefined {
  const content = readEntryFile(join(directory, `${state.id}.md`));
  if (!content) return undefined;
  const entry = parseEntry(content);
  if (entry.mex.id !== state.id || entry.mex.kind !== "hint" || entry.mex.source.type !== "agent-memory"
    || entry.mex.evidence !== "observed" || entry.mex.source.ref !== state.ref || entry.mex.checks.length !== 0
    || claimHash(entry.text) !== state.claimHash) throw new KnowledgeError("INVALID_STATE", "A hint does not match its local source observation.");
  return { entry, content };
}
function removeHintFile(home: string, projectId: string, id: string): boolean {
  const directory = containedDirectory(home, ["projects", projectId, "hints"]);
  if (!directory) return true;
  const path = join(directory, `${id}.md`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    unlinkSync(path); return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** A read checks only source identity/hash. It never refreshes, rewrites or expires. */
export function readHints(options: MemoryOptions, now = new Date()): HintRead {
  const consumer = normalizeMemoryAgent(options.consumerAgent);
  if (!consumer) return { entries: [], withheld: 0, partial: false };
  const project = knowledgeProject(options), reader = openRecordReadOnly(options);
  if (!reader) return { entries: [], withheld: 0, partial: false };
  try {
    if (reader.diagnostic) throw new KnowledgeError("RECORD_UNAVAILABLE", reader.diagnostic);
    const directory = containedDirectory(project.location.home, ["projects", project.projectId, "hints"]);
    if (!directory) return { entries: [], withheld: 0, partial: false };
    const context = references(project.root), months = expiryMonths(reader, project.projectId);
    const forgotten = retiredClaimHashes(reader, project.projectId);
    let roots;
    try { roots = memoryRoots(options); } catch { return { entries: [], withheld: states(reader, project.projectId).length, partial: true }; }
    const checked = new Map<string, boolean>(), entries: HintEntry[] = [];
    let sourceBytes = 0, entryBytes = 0, withheld = 0, partial = false;
    const all = states(reader, project.projectId).sort((a, b) => b.lastSeen - a.lastSeen || a.id.localeCompare(b.id));
    const alreadyLoaded = new Set(all.filter(state => state.agent === consumer && !state.confirmed).map(state => state.claimHash));
    for (const state of all) {
      if (state.confirmed || state.agent === consumer || alreadyLoaded.has(state.claimHash) || project.retired.has(state.id) || forgotten.has(state.claimHash)) continue;
      if (hintExpiresAt(state.lastSeen, months) <= now.getTime()) { withheld++; continue; }
      const found = readHint(directory, state);
      if (!found || found.entry.mex.status !== "active") continue;
      entryBytes += Buffer.byteLength(found.content);
      if (entryBytes > KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("STORE_LIMIT", "Hints exceed the byte scan limit.");
      const key = `${state.agent}\n${state.sourceRoot}\n${state.sourcePath}\n${state.sourceHash}`;
      if (!checked.has(key)) {
        sourceBytes += state.sourceBytes;
        if (sourceBytes > MEMORY_LIMITS.bytes) { partial = true; withheld++; continue; }
        checked.set(key, checkMemorySource(state, options, roots));
      }
      if (!checked.get(key)) { withheld++; continue; }
      try {
        const entry = gateEntry(found.entry, context);
        const observations = state.observations.length;
        entries.push({ level: "hint", label: observations >= 128 ? "[hint, seen at least 128 times]" : entryLabel(entry, "hint", observations), origin: state.agent, observations, entry });
      } catch (error) {
        if (!(error instanceof KnowledgeError) || error.code !== "SECRET_FOUND") throw error;
        withheld++;
      }
    }
    return { entries, withheld, partial };
  } finally { reader.close(); }
}

function expireWithWriter(writer: RecordWriter, projectId: string, now: Date, roots: ReturnType<typeof memoryRoots>): { expired: number; retainedFiles: number } {
  const directory = hintDirectory(writer, projectId);
  if (!directory) return { expired: 0, retainedFiles: 0 };
  const months = expiryMonths(writer, projectId), cleanup: string[] = [];
  let expired = 0;
  const all = states(writer, projectId);
  separateStorage(writer.location.home, projectId, [...roots, ...all.map(state => ({ root: state.sourceRoot }))]);
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    for (const state of all) {
      if (state.confirmed) continue;
      const personal = containedDirectory(writer.location.home, ["projects", projectId, "notes"]);
      const note = personal && readEntryFile(join(personal, `${state.id}.md`));
      // A crash after confirmation's file publication cannot age out that note.
      if (note) {
        const personal = parseEntry(note);
        if (personal.mex.id === state.id && personal.mex.status === "active" && personal.mex.source.type === "person" && personal.mex.evidence === "person") continue;
      }
      const marker = tombstone(writer, projectId, state.id);
      if (!marker && hintExpiresAt(state.lastSeen, months) > now.getTime()) continue;
      if (!marker) {
        saveHashedTombstone(writer, projectId, { id: state.id, claim_hash: state.claimHash, retired: { reason: "Hint expired without a repeat.", by: "mex hints expire", at: now.toISOString().slice(0, 10) } });
        expired++;
      }
      cleanup.push(state.id);
    }
    writer.db.exec("COMMIT");
  } finally { try { writer.db.exec("ROLLBACK"); } catch { /* already committed */ } }
  let retainedFiles = 0;
  for (const id of cleanup) if (!removeHintFile(writer.location.home, projectId, id)) retainedFiles++;
  return { expired, retainedFiles };
}

export function expireHints(options: MemoryOptions, now = new Date()): { expired: number; retainedFiles: number } {
  const project = knowledgeProject(options), reader = openRecordReadOnly(options);
  if (!reader) return { expired: 0, retainedFiles: 0 };
  const roots = memoryRoots(options);
  try {
    const all = states(reader, project.projectId);
    if (!all.length) return { expired: 0, retainedFiles: 0 };
    separateStorage(project.location.home, project.projectId, [...roots, ...all.map(state => ({ root: state.sourceRoot }))]);
  } finally { reader.close(); }
  const writer = openRecord(options);
  try { return expireWithWriter(writer, writer.checkout(options.projectPath)!.project_id, now, roots); }
  finally { writer.close(); }
}

export function refreshHints(options: MemoryOptions, now = new Date(), setting?: number) {
  if (setting !== undefined && (!Number.isSafeInteger(setting) || setting < 1 || setting > 120)) throw new KnowledgeError("INVALID_SETTING", "Hint expiry must be between 1 and 120 calendar months.");
  const discovery = discoverMemory(options, now), project = knowledgeProject(options);
  const context = references(project.root), prepared: Array<{ candidate: typeof discovery.candidates[number]; entry: KnowledgeEntry }> = [];
  const sourceChecks = new Map<string, boolean>();
  const allowedRoots = memoryRoots(options);
  separateStorage(project.location.home, project.projectId, allowedRoots);
  for (const candidate of discovery.candidates) {
    try {
      const sourceKey = `${candidate.agent}\n${candidate.sourceRoot}\n${candidate.sourcePath}\n${candidate.sourceHash}`;
      if (!sourceChecks.has(sourceKey)) sourceChecks.set(sourceKey, checkMemorySource(candidate, options, allowedRoots));
      if (!sourceChecks.get(sourceKey)) { discovery.skipped++; discovery.partial = true; continue; }
      const text = sanitizeText(candidate.text, context);
      const id = `mx_${createHash("sha256").update(`${candidate.agent}\n${claimHash(text)}`).digest("hex").slice(0, 32)}`;
      const entry = gateEntry({ mex: { id, kind: "hint", scope: ["**"], source: { type: "agent-memory", ref: candidate.ref }, evidence: "observed", one_line: text,
        checks: [], status: "active", created: new Date(candidate.observedAt).toISOString().slice(0, 10) }, text }, context);
      prepared.push({ candidate, entry });
    } catch (error) {
      if (!(error instanceof KnowledgeError) || !["SECRET_FOUND", "INVALID_ENTRY"].includes(error.code)) throw error;
      discovery.skipped++;
    }
  }
  if (!prepared.length && setting === undefined) {
    const reader = openRecordReadOnly(options);
    let hasState = false;
    try { hasState = !!reader && states(reader, project.projectId).length > 0; } finally { reader?.close(); }
    if (!hasState) return { imported: 0, expired: 0, retainedFiles: 0, skipped: discovery.skipped, partial: discovery.partial, agents: discovery.agents };
  }
  const writer = openRecord(options);
  let imported = 0;
  try {
    const projectId = writer.checkout(options.projectPath)!.project_id;
    separateStorage(writer.location.home, projectId, allowedRoots);
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      if (setting !== undefined) put(writer, projectId, EXPIRY, setting);
      const retiredClaims = retiredClaimHashes(writer, projectId);
      for (const { candidate, entry } of prepared) {
        if (tombstone(writer, projectId, entry.mex.id) || retiredClaims.has(claimHash(entry.text))) continue;
        const previous = parseState(writer.setting(projectId, stateKey(entry.mex.id)), entry.mex.id);
        if (previous?.confirmed) continue;
        const observations = previous?.observations ?? [];
        const repeated = !observations.includes(candidate.observation);
        const state: HintState = HintStateSchema.parse({ version: 1, id: entry.mex.id, agent: candidate.agent, confirmed: false, claimHash: claimHash(entry.text),
          firstSeen: previous?.firstSeen ?? candidate.observedAt, lastSeen: repeated ? Math.max(previous?.lastSeen ?? 0, candidate.observedAt) : previous!.lastSeen,
          observations: repeated && observations.length < 128 ? [...observations, candidate.observation] : observations,
          sourceRoot: candidate.sourceRoot, sourcePath: candidate.sourcePath, sourceHash: candidate.sourceHash, sourceBytes: candidate.sourceBytes, ref: candidate.ref });
        const directory = hintDirectory(writer, projectId, true)!;
        const path = join(directory, `${entry.mex.id}.md`), existing = readEntryFile(path);
        const content = serializeEntry({ ...entry, mex: { ...entry.mex, created: new Date(state.firstSeen).toISOString().slice(0, 10) } });
        if (existing === undefined) createEntryFile(directory, entry.mex.id, content);
        else if (existing !== content) replaceEntryFile(directory, entry.mex.id, existing, content);
        put(writer, projectId, stateKey(state.id), state);
        imported++;
      }
      put(writer, projectId, "knowledge.hints_status", { at: now.toISOString(), partial: discovery.partial, skipped: discovery.skipped, agents: discovery.agents });
      writer.db.exec("COMMIT");
    } finally { try { writer.db.exec("ROLLBACK"); } catch { /* already committed */ } }
    return { imported, ...expireWithWriter(writer, projectId, now, allowedRoots), skipped: discovery.skipped, partial: discovery.partial, agents: discovery.agents };
  } finally { writer.close(); }
}

export function hintStatus(options: MemoryOptions) {
  const project = knowledgeProject(options), reader = openRecordReadOnly(options);
  if (!reader) return { active: 0, confirmed: 0, expiryMonths: 6, lastRefresh: null };
  try {
    const all = states(reader, project.projectId);
    const raw = reader.setting(project.projectId, "knowledge.hints_status");
    return { active: all.filter(state => !state.confirmed && !project.retired.has(state.id)).length,
      confirmed: all.filter(state => state.confirmed).length, expiryMonths: expiryMonths(reader, project.projectId), lastRefresh: raw ? JSON.parse(raw) : null };
  } finally { reader.close(); }
}

export function confirmHint(id: string, input: NoteInput, options: MemoryOptions, now = new Date()): PersonalEntry {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Invalid entry id.");
  const project = knowledgeProject(options), context = references(project.root);
  const text = sanitizeText(input.text, context);
  const entry = gateEntry({ mex: { id, kind: input.kind ?? "rule", scope: input.scope ?? ["**"], source: { type: "person", ref: `mex edit ${now.toISOString().slice(0, 10)}`, quote: text },
    evidence: "person", one_line: input.oneLine ?? text.trim().replace(/\s+/gu, " "), checks: [], status: "active", created: now.toISOString().slice(0, 10) }, text }, context);
  const existing = openRecordReadOnly(options);
  let known: HintState | undefined;
  try { known = existing && parseState(existing.setting(project.projectId, stateKey(id)), id); } finally { existing?.close(); }
  if (!known || known.confirmed || project.retired.has(id)) throw new KnowledgeError("NOT_FOUND", "No active hint has that id.");
  separateStorage(project.location.home, project.projectId, [...memoryRoots(options), { root: known.sourceRoot }]);
  const writer = openRecord(options);
  try {
    const projectId = writer.checkout(options.projectPath)!.project_id;
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      const state = parseState(writer.setting(projectId, stateKey(id)), id);
      if (!state || state.confirmed || tombstone(writer, projectId, id) || hintExpiresAt(state.lastSeen, expiryMonths(writer, projectId)) <= now.getTime()) throw new KnowledgeError("NOT_FOUND", "No active hint has that id.");
      const directory = containedDirectory(writer.location.home, ["projects", projectId, "notes"], true)!;
      createEntryFile(directory, id, serializeEntry(entry));
      put(writer, projectId, stateKey(id), { ...state, confirmed: true });
      writer.db.exec("COMMIT");
    } finally { try { writer.db.exec("ROLLBACK"); } catch { /* preserve outcome */ } }
    removeHintFile(writer.location.home, projectId, id);
    return { level: "personal", label: entryLabel(entry, "personal"), entry };
  } finally { writer.close(); }
}

export function forgetHint(id: string, reason: string, options: MemoryOptions, now = new Date(), action: "forget" | "wrong" = "forget"): Tombstone {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Invalid entry id.");
  reason = stripHidden(reason);
  if (hasSecret(reason)) throw new KnowledgeError("SECRET_FOUND", "The retirement reason contains a possible secret.");
  const project = knowledgeProject(options), reader = openRecordReadOnly(options);
  let known: HintState | undefined;
  try { known = reader && parseState(reader.setting(project.projectId, stateKey(id)), id); } finally { reader?.close(); }
  if (!known || known.confirmed || project.retired.has(id)) throw new KnowledgeError("NOT_FOUND", "No active hint has that id.");
  separateStorage(project.location.home, project.projectId, [...memoryRoots(options), { root: known.sourceRoot }]);
  const writer = openRecord(options);
  try {
    const projectId = writer.checkout(options.projectPath)!.project_id;
    writer.db.exec("BEGIN IMMEDIATE");
    let marker: Tombstone;
    try {
      const state = parseState(writer.setting(projectId, stateKey(id)), id);
      const directory = hintDirectory(writer, projectId);
      const found = state && directory && readHint(directory, state);
      if (!found || state!.confirmed) throw new KnowledgeError("NOT_FOUND", "No active hint has that id.");
      marker = saveTombstone(writer, projectId, found.entry, { reason, by: `mex ${action}`, at: now.toISOString().slice(0, 10) });
      writer.db.exec("COMMIT");
    } finally { try { writer.db.exec("ROLLBACK"); } catch { /* already committed */ } }
    removeHintFile(writer.location.home, projectId, id);
    return marker!;
  } finally { writer.close(); }
}
