/**
 * `mex entries enrich`: an opt-in backfill of aliases and asks for entries
 * that have none. Three steps, so nothing is spent or written by surprise:
 * the bare command shows what one call would cover, `--run` makes that single
 * batched call inside the model cap and saves a filtered preview, and
 * `--apply --expect <revision>` writes exactly the previewed aids. Entries keep
 * their level; personal notes stay personal.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openRecord, projectDataDirectory } from "../record/index.js";
import { KnowledgeError, parseEntry, serializeEntry, type KnowledgeEntry } from "./entry.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { AID_WRITER_RULE, applyCandidateAids, corpusDigest, nativeAidRanker, type AidRanker, type AidVerdict } from "./aids.js";
import { aidCorpus, recordAidVerdicts, type CorpusItem } from "./aid-store.js";
import { replacePersonalFields } from "./mutations.js";
import { applyTeamWrite, prepareTeamWrite } from "./team.js";

/** One call covers at most this many entries; a second run picks up the rest. */
export const ENRICH_BATCH = 40;
const TEXT_CHARS = 600;

export interface EnrichPlan { entries: Array<{ id: string; level: CorpusItem["level"]; one_line: string }>; remaining: number; estimate: { input: number; output: number }; }
export interface EnrichPreview {
  revision: string; corpus: string;
  changes: Array<{ id: string; level: CorpusItem["level"]; aliases: string[]; asks: string[]; before: string }>;
  verdicts: AidVerdict[];
}

function candidates(items: CorpusItem[]): CorpusItem[] {
  return items.filter(i => !i.entry.mex.aliases?.length && !i.entry.mex.asks?.length && i.entry.mex.status !== "retired");
}

export function enrichPrompt(entries: readonly KnowledgeEntry[]): string {
  return [
    "You write search aids for a project's knowledge entries. Reply with JSON only, in the form",
    '{"entries":[{"id":"mx_...","aliases":["..."],"asks":["..."]}]}.',
    AID_WRITER_RULE,
    "Entries:",
    JSON.stringify(entries.map(e => ({ id: e.mex.id, kind: e.mex.kind, scope: e.mex.scope, one_line: e.mex.one_line, text: e.text.slice(0, TEXT_CHARS) }))),
  ].join("\n");
}

/** What one run would cover, at $0. */
export function planEnrich(options: KnowledgeOptions): EnrichPlan {
  const todo = candidates(aidCorpus(options).items);
  const batch = todo.slice(0, ENRICH_BATCH);
  const prompt = enrichPrompt(batch.map(i => i.entry));
  return {
    entries: batch.map(i => ({ id: i.entry.mex.id, level: i.level, one_line: i.entry.mex.one_line })),
    remaining: todo.length - batch.length,
    // Estimated, not measured: about 4 bytes a token, and about 90 output tokens an entry.
    estimate: { input: Math.ceil(Buffer.byteLength(prompt) / 4), output: batch.length * 90 },
  };
}

export function parseEnrichReply(text: string, ids: ReadonlySet<string>): Map<string, { aliases?: unknown; asks?: unknown }> {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { throw new KnowledgeError("ENRICH_REPLY", "The model's reply wasn't the JSON asked for; nothing was written."); }
  const list = (value as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) throw new KnowledgeError("ENRICH_REPLY", "The model's reply had no entries list; nothing was written.");
  const out = new Map<string, { aliases?: unknown; asks?: unknown }>();
  for (const item of list.slice(0, ENRICH_BATCH)) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id === "string" && ids.has(id) && !out.has(id)) out.set(id, item as { aliases?: unknown; asks?: unknown });
  }
  return out;
}

export type EnrichModel = (prompt: string, estimate: EnrichPlan["estimate"]) => Promise<string>;

function previewPath(options: KnowledgeOptions): string {
  const writer = openRecord({ ...options, create: true });
  try {
    const projectId = writer.checkout(options.projectPath)?.project_id ?? knowledgeProject(options).projectId;
    if (!writer.project(projectId)) throw new KnowledgeError("RECORD_UNAVAILABLE", "MEX is not set up in this project. Run mex first.");
    return join(projectDataDirectory(writer.location, projectId), "enrich-preview.json");
  } finally { writer.close(); }
}

/** The one model call, then the filter. Saves the preview; writes no entry. */
export async function runEnrich(options: KnowledgeOptions, model: EnrichModel, rank: AidRanker = nativeAidRanker): Promise<EnrichPreview & { plan: EnrichPlan }> {
  const plan = planEnrich(options);
  if (!plan.entries.length) throw new KnowledgeError("NOTHING_TO_ENRICH", "Every entry already has aliases or asks.");
  const { items } = aidCorpus(options);
  const byId = new Map(items.map(i => [i.entry.mex.id, i]));
  const batch = plan.entries.map(e => byId.get(e.id)!);
  const reply = parseEnrichReply(await model(enrichPrompt(batch.map(i => i.entry)), plan.estimate), new Set(plan.entries.map(e => e.id)));
  const corpus = items.map(i => i.entry);
  const verdicts: AidVerdict[] = [];
  const changes: EnrichPreview["changes"] = [];
  for (const item of batch) {
    const { entry, verdicts: v } = applyCandidateAids(item.entry, reply.get(item.entry.mex.id), corpus, rank);
    verdicts.push(...v);
    if (entry.mex.aliases?.length || entry.mex.asks?.length) changes.push({ id: entry.mex.id, level: item.level, aliases: entry.mex.aliases ?? [], asks: entry.mex.asks ?? [], before: serializeEntry(item.entry) });
  }
  const digest = corpusDigest(corpus);
  recordAidVerdicts(options, verdicts, "enrich", digest);
  const revision = createHash("sha256").update(JSON.stringify({ digest, changes })).digest("hex").slice(0, 16);
  const preview: EnrichPreview = { revision, corpus: digest, changes, verdicts };
  const file = previewPath(options);
  writeFileSync(`${file}.tmp`, JSON.stringify(preview), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return { ...preview, plan };
}

/** Write exactly the saved preview. An entry that changed since is skipped, not overwritten. */
export function applyEnrich(options: KnowledgeOptions, expected: string): { written: string[]; stale: string[] } {
  const file = previewPath(options);
  let preview: EnrichPreview;
  try { preview = JSON.parse(readFileSync(file, "utf8")); } catch { throw new KnowledgeError("PREVIEW_REQUIRED", "Run mex entries enrich --run first."); }
  if (preview.revision !== expected) throw new KnowledgeError("STALE_PREVIEW", "That isn't the revision of the saved preview; run mex entries enrich --run again.");
  const written: string[] = [], stale: string[] = [];
  const current = new Map(aidCorpus(options).items.map(i => [i.entry.mex.id, i]));
  for (const change of preview.changes) {
    const item = current.get(change.id);
    if (!item || serializeEntry(item.entry) !== change.before) { stale.push(change.id); continue; }
    const next = parseEntry(change.before);
    if (change.aliases.length) next.mex.aliases = change.aliases;
    if (change.asks.length) next.mex.asks = change.asks;
    if (item.level === "personal") replacePersonalFields(change.id, () => next, options);
    else { const p = prepareTeamWrite(next, options); applyTeamWrite(p, p.revision, options); }
    written.push(change.id);
  }
  rmSync(file, { force: true });
  return { written, stale };
}
