import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ENTRY_KINDS, EntryIdSchema, KnowledgeError, KNOWLEDGE_LIMITS, parseEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { claimHash } from "../knowledge/state.js";
import type { RecordReader, RecordWriter } from "../record/index.js";
import { command, repoPath } from "./git.js";
import type { LearningPlan } from "./plan.js";
import { repository, sourceDigest, type LearningSource, type Repository } from "./source.js";

export const MANIFEST_PATH = ".mex/sources.json";
export const MANIFEST_BYTES = 1 << 20;
const MAX_TEAM_FILES = 256;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const repositorySchema = z.object({ host: z.enum(["github.com", "gitlab.com"]), slug: z.string().max(220) }).strict()
  .refine(value => repository(value.host, value.slug)?.slug === value.slug);
export const SourceRef = z.object({ id: z.string().max(360), hash, link: z.string().max(2048), coverage: z.enum(["full", "partial"]).optional() }).strict()
  .refine(source => source.coverage === undefined || source.id.startsWith("doc:"));
export type SourceRef = z.infer<typeof SourceRef>;

export function sourceRef(source: LearningSource): SourceRef {
  const { id, hash, link } = source;
  return source.kind === "docs" ? { id, hash, link, coverage: source.coverage } : { id, hash, link };
}
const ForgeSource = SourceRef.refine(source => {
  const url = /^https:\/\/(github\.com|gitlab\.com)\/([^?#\s]+?)(?:\/-)?\/(?:blob\/|pull\/|issues\/|merge_requests\/)[^?\s]+$/u.exec(source.link);
  return !!url && !!repository(url[1]!, url[2]!) && (source.id.startsWith("doc:") ? repoPath(source.id.slice(4).split("#", 1)[0]!)
    : /^(?:github:[a-z_-]+:\d+|gitlab:(?:note|description):\d+)$/u.test(source.id)
      || url[1] === "github.com" && /^gh:(?:(?:pr|closed|issue):[1-9]\d*|(?:thread|conversation|review-summary):[A-Za-z0-9_+/=-]{1,200})$/u.test(source.id));
});
const Shared = z.object({ id: EntryIdSchema, claim: hash, sources: z.array(ForgeSource).max(8) }).strict();
export type SharedCoverage = z.infer<typeof Shared>;
const portableNetwork = z.object({
  id: EntryIdSchema,
  url: z.string().max(2048),
  hash,
  nodes: z.array(z.string().regex(/^[A-Za-z0-9_+/=-]{1,200}$/u)).max(64),
  commentHashes: z.record(z.string().regex(/^[A-Za-z0-9_+/=-]{1,200}$/u), hash).optional(),
}).strict();
const manifest = z.object({
  version: z.literal(1), rule_files: z.array(z.unknown()).max(10_000),
  learn_deeper: z.array(Shared).max(2048).optional(),
  learn_deeper_network: z.array(portableNetwork).max(2048).optional(),
}).passthrough();

export function parseManifest(raw: string | undefined): z.infer<typeof manifest> | undefined {
  if (raw === undefined) return undefined;
  try {
    if (Buffer.byteLength(raw) > MANIFEST_BYTES) throw new Error();
    const parsed = manifest.parse(JSON.parse(raw));
    if (new Set(parsed.learn_deeper?.map(item => item.id)).size !== (parsed.learn_deeper?.length ?? 0)) throw new Error();
    return parsed;
  } catch { throw new KnowledgeError("LEARN_SOURCES", "The team's .mex/sources.json could not be read safely."); }
}

const LessonSupport = z.object({
  pulls: z.array(z.number().int().positive()).max(256),
  commits: z.array(z.string().regex(gitHash)).max(256),
  reviewers: z.array(z.string().min(1).max(128)).max(256),
}).strict();
export type LessonSupport = z.infer<typeof LessonSupport>;

const NoteProof = z.object({ origin: repositorySchema.optional(), source: repositorySchema, visibility: z.enum(["public", "private"]),
  hash, sources: z.array(ForgeSource).max(8).default([]),
  support: LessonSupport.optional(),
  evidenceDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional() }).strict();
export const noteKey = (id: string) => `learning.deep.note.${id}`;

function readProof(value: string | undefined, raw: string): z.infer<typeof NoteProof> | undefined {
  if (!value || Buffer.byteLength(value) > 20_000) return undefined;
  try {
    const proof = NoteProof.parse(JSON.parse(value));
    return proof.hash === sourceDigest(raw) ? proof : undefined;
  } catch { return undefined; }
}

export function learningProof(plan: LearningPlan, raw: string, value: string | undefined): z.infer<typeof NoteProof> | undefined {
  const proof = readProof(value, raw);
  return proof && isDeepStrictEqual(proof.source, plan.source) && proof.visibility === plan.visibility
    && (!proof.origin || isDeepStrictEqual(proof.origin, plan.origin)) ? proof : undefined;
}

export function makeNoteProof(plan: LearningPlan, raw: string, sources: SourceRef[], evidenceDay?: string, support?: LessonSupport): string {
  return JSON.stringify({ origin: plan.origin, source: plan.source, visibility: plan.visibility, hash: sourceDigest(raw),
    sources: sources.filter(source => ForgeSource.safeParse(source).success), evidenceDay, support });
}

export function approvedCoverage(entry: KnowledgeEntry, raw: string, value: string | undefined, origin?: Repository): SharedCoverage {
  const proof = readProof(value, raw);
  return { id: entry.mex.id, claim: claimHash(entry.text), sources: origin && proof && isDeepStrictEqual(proof.origin, origin)
    && ["docs", "review"].includes(entry.mex.source.type) ? proof.sources : [] };
}

// Older document receipts have no extent and cannot prove either a full read or this excerpt.
function recordedSource({ hash, coverage }: SourceRef): string { return coverage ? `${hash}:${coverage}` : hash; }

export const coverageKey = (source: SourceRef) => `${source.id}\0${recordedSource(source)}`;

function localKey(plan: LearningPlan, source: SourceRef): string {
  const repo = source.id.startsWith("doc:") ? plan.origin : plan.source;
  return `learning.deep.source.${sourceDigest(JSON.stringify([repo, source.id])).slice(7)}`;
}

export function sourceRead(store: Pick<RecordReader, "setting">, project: string, plan: LearningPlan, source: SourceRef): boolean {
  return store.setting(project, localKey(plan, source)) === recordedSource(source);
}

export function saveSourceReads(writer: RecordWriter, project: string, plan: LearningPlan, sources: SourceRef[]): void {
  const set = writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
  for (const source of sources) if (source.id.startsWith("doc:") || source.id.startsWith("gh:") || source.id.startsWith("github:") || source.id.startsWith("gitlab:")) {
    set.run(project, localKey(plan, source), recordedSource(source));
  }
}

function entryId(path: string) {
  const [, kind, id] = /^\.mex\/learned\/(?:(\w+)\/)?(mx_[a-z0-9]{6,64})\.md$/u.exec(path) ?? [];
  return id && (!kind || (ENTRY_KINDS as readonly string[]).includes(kind)) ? id : undefined;
}

export interface TeamCoverage {
  entries: KnowledgeEntry[];
  claimed: Set<string>;
  retired: Set<string>;
  retiredIds: Set<string>;
  retiredEvidence: Set<string>;
  read: Set<string>;
}

function sourceIdentity(sources: SourceRef[]): string | undefined {
  // A PR description or doc alone may supply many unrelated lessons. An
  // exact set containing a stable comment/thread identity is more specific.
  const specific = sources.some(source => /^(?:gh:thread:|github:(?:issuecomment-?|discussion_r|pullrequestreview|comment):|gitlab:note:)/u.test(source.id));
  if (!specific) return undefined;
  return JSON.stringify([...new Set(sources.map(source => {
    const url = new URL(source.link);
    const repository = url.pathname.split("/").slice(1, url.hostname === "github.com" ? 3 : url.pathname.split("/-/")[0]!.split("/").length).join("/");
    return `${url.hostname}/${repository.toLowerCase()}\n${source.id}`;
  }))].sort());
}

export function teamRetired(team: TeamCoverage, entry: KnowledgeEntry, raw?: string, proofValue?: string): boolean {
  if (team.entries.some(active => active.mex.id === entry.mex.id)) return false;
  if (team.retiredIds.has(entry.mex.id) || team.retired.has(claimHash(entry.text))) return true;
  const proof = raw && readProof(proofValue, raw);
  const identity = proof && sourceIdentity(proof.sources);
  return !!identity && team.retiredEvidence.has(identity);
}

/** The hosted default branch supplies the exact commit. The working tree is never consulted. */
export async function readTeamCoverage(root: string, head: string, since: string): Promise<TeamCoverage> {
  const failure = () => new KnowledgeError("LEARN_SOURCES", "The team's sources or rules could not be verified on the default branch.");
  if (!gitHash.test(head) || !Number.isFinite(Date.parse(since))) throw failure();
  const summary = await command(root, "git", ["ls-tree", "-rz", "--full-tree", head, "--", ".mex"], undefined, 512 << 10);
  if (summary === undefined) throw failure();
  const active = new Map<string, string>();
  let manifestOid: string | undefined;
  for (const row of summary.split("\0")) {
    const [, mode, oid, path] = /^(\d+) \w+ ([a-f0-9]+)\t(.+)$/u.exec(row) ?? [];
    if (!path) continue;
    if (path === ".mex" || path === ".mex/learned") throw failure();
    const id = entryId(path);
    if (!id && path !== MANIFEST_PATH) continue;
    if (!oid || !gitHash.test(oid) || !(mode === "100644" || mode === "100755")) throw failure();
    if (id) {
      if (active.has(id) || active.size >= MAX_TEAM_FILES) throw failure();
      active.set(id, oid);
    } else manifestOid = oid;
  }
  const blob = async (oid: string, limit: number) => {
    const raw = await command(root, "git", ["cat-file", "blob", oid], undefined, limit);
    if (raw === undefined || raw.includes("\0")) throw failure();
    return raw;
  };
  const saved = parseManifest(manifestOid && await blob(manifestOid, MANIFEST_BYTES))?.learn_deeper ?? [];
  const result: TeamCoverage = { entries: [], claimed: new Set(), retired: new Set(), retiredIds: new Set(), retiredEvidence: new Set(), read: new Set() };
  for (const record of saved) {
    for (const source of record.sources) result.read.add(coverageKey(source));
    if (!active.has(record.id)) { result.retired.add(record.claim); result.retiredIds.add(record.id); }
  }
  const add = async (files: Array<[string, string]>, deleted: boolean) => {
    for (let offset = 0; offset < files.length; offset += 8) {
      const chunk = await Promise.all(files.slice(offset, offset + 8).map(async ([id, oid]) => {
        const entry = parseEntry(await blob(oid, KNOWLEDGE_LIMITS.entryBytes));
        if (entry.mex.id !== id) throw failure();
        return entry;
      }));
      for (const entry of chunk) {
        const claim = claimHash(entry.text);
        if (deleted || entry.mex.status === "retired") { result.retired.add(claim); result.retiredIds.add(entry.mex.id); }
        else if (entry.mex.status === "active") { result.entries.push(entry); result.claimed.add(claim); }
      }
    }
  };
  await add([...active], false);
  // Older team entries can predate the manifest. Use the old blob of a deletion
  // on the first-parent history so a fresh machine can still see the tombstone.
  const history = await command(root, "git", ["log", "--first-parent", "--diff-merges=first-parent", "--diff-filter=D", "--no-renames", "--format=%x00parent:%P%x00",
    "--no-abbrev", "--raw", "-z", `--since=${since}`, "-n", "128", head, "--", ".mex/learned"], undefined, 512 << 10);
  if (history === undefined) throw failure();
  const deleted = new Map<string, [string, string]>();
  const manifests = new Map<string, Set<string>>();
  const savedIds = new Set(saved.map(record => record.id));
  const pieces = history.split("\0");
  let parent = "";
  for (let i = 0; i + 1 < pieces.length; i++) {
    const token = pieces[i]!;
    const marker = /^\s*parent:([a-f0-9]+)(?:\s|$)/u.exec(token)?.[1];
    if (marker) { parent = gitHash.test(marker) ? marker : ""; continue; }
    const oid = /^\s*:100(?:644|755) 000000 ([a-f0-9]+) 0+ D$/u.exec(token)?.[1];
    if (!oid) continue;
    const id = entryId(pieces[++i]!);
    if (!id || !oid || !gitHash.test(oid) || active.has(id)) continue;
    if (deleted.size >= MAX_TEAM_FILES) throw failure();
    deleted.set(oid, [id, oid]);
    if (parent && !savedIds.has(id) && (manifests.has(parent) || manifests.size < 8)) {
      const ids = manifests.get(parent) ?? new Set<string>();
      ids.add(id);
      manifests.set(parent, ids);
    }
  }
  await add([...deleted.values()], true);
  const current = new Set(saved.filter(record => !result.retiredIds.has(record.id)).map(record => sourceIdentity(record.sources)));
  const addSources = (record: SharedCoverage) => {
    const identity = sourceIdentity(record.sources);
    if (identity && !current.has(identity)) result.retiredEvidence.add(identity);
  };
  for (const record of saved) if (result.retiredIds.has(record.id)) addSources(record);
  for (const [parent, ids] of manifests) {
    const raw = await command(root, "git", ["show", `${parent}:${MANIFEST_PATH}`], undefined, MANIFEST_BYTES);
    for (const record of parseManifest(raw)?.learn_deeper ?? []) if (ids.has(record.id)) addSources(record);
  }
  return result;
}
