import { existsSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { openRecordReadOnly, projectIdentity } from "../record/index.js";
import { EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, parseEntry, serializeEntry, type EntryKind, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, readEntryFile, personalReadGuard } from "./files.js";
import { knowledgeProject, type KnowledgeOptions, type KnowledgeProject } from "./context.js";
import { references, type References } from "./references.js";
import { gateEntry } from "./gates.js";
import { entryLabel, KNOWLEDGE_PRIORITY, type KnowledgeLevel } from "./labels.js";
import { expandTeam, teamEntries, type TeamEntry } from "./team.js";
import { readHints, type HintEntry } from "./hints.js";
import { aidsEnabled, rankNative } from "./native-rank.js";
import { deriveNoteChecks } from "./note-checks.js";
import { cachedVerdicts } from "./check.js";
import { proposalFromEntry, proposeNote, proposeSync, type GateResult } from "./gate.js";
import { producerEntryId } from "./producers.js";
export type { KnowledgeOptions } from "./context.js";

export interface PersonalEntry { level: "personal"; label: string; entry: KnowledgeEntry; }
export type StoredEntry = PersonalEntry | TeamEntry | HintEntry;
/** savedBy: the agent that ran `mex note` for the person; its notes are labelled as the agent's, never "you said". */
export interface NoteInput { text: string; kind?: EntryKind; scope?: string[]; oneLine?: string; savedBy?: "claude-code" | "codex"; }
/** A decision that cites a commit is proposed until that commit lands on the default branch. */
export interface DecisionInput { commit?: NonNullable<KnowledgeEntry["mex"]["commit"]>; supersedes?: string[]; }
function readDirectory(project: KnowledgeProject): string | undefined {
  if (!existsSync(project.location.home)) return undefined;
  return containedDirectory(project.location.home, ["projects", project.projectId, "notes"]);
}
function display(entry: KnowledgeEntry): PersonalEntry {
  return { level: "personal", label: entryLabel(entry, "personal"), entry };
}
/** A reserved id namespace marks setup's entries without changing manifest provenance. */
export function isSetupRecipe(entry: KnowledgeEntry): boolean {
  return /^mx_setup[a-f0-9]{24}$/u.test(entry.mex.id) && entry.mex.kind === "recipe" && entry.mex.source.type === "config";
}

/**
 * Every package's test and build, within a bound. A package's commands sit in
 * a rule file that loads only for that package, so they cost nothing until the
 * agent works there; the bound keeps a very large monorepo's setup quick.
 */
export const MAX_SETUP_RECIPES = 120;

/** Refresh only setup-owned personal entries. */
export function refreshSetupRecipes(entries: KnowledgeEntry[], options: KnowledgeOptions, retireMissing = true, now = new Date()): GateResult[] {
  if (entries.length > MAX_SETUP_RECIPES || entries.some(entry => !isSetupRecipe(entry) || entry.mex.status !== "active"
    || entry.mex.checks.length !== 1 || entry.mex.checks[0]?.kind !== "command" || entry.mex.checks[0]?.role !== "complete")) {
    throw new KnowledgeError("INVALID_ENTRY", `Setup requires at most ${MAX_SETUP_RECIPES} recipes with complete command checks.`);
  }
  return proposeSync(entries.map(entry => proposalFromEntry(entry, "setup-recipe")), {
    ...options, now, ...(retireMissing ? { sweep: { producer: "setup-recipe" } } : {}),
  });
}

/** Explicit note creation uses the same gates and personal store as setup. */
export function note(input: NoteInput & DecisionInput, options: KnowledgeOptions, now = new Date()): PersonalEntry {
  const created = now.toISOString().slice(0, 10);
  const entry: KnowledgeEntry = {
    mex: {
      id: producerEntryId("note"), kind: input.kind ?? "rule", scope: input.scope ?? ["**"],
      source: { type: "person", ref: input.savedBy ? `mex note by ${input.savedBy} ${created}` : `mex note ${created}`, quote: input.text }, evidence: "person",
      one_line: input.oneLine ?? input.text.trim().replace(/\s+/gu, " "), checks: [], status: input.commit ? "proposed" : "active", created,
      ...(input.commit ? { commit: input.commit } : {}), ...(input.supersedes?.length ? { supersedes: input.supersedes } : {}),
    }, text: input.text.trim().replace(/\r\n/g, "\n"),
  };
  serializeEntry(entry);
  const root = projectIdentity(options.projectPath).rootPath;
  if (!input.commit) entry.mex.checks = deriveNoteChecks(entry.text, root, { env: options.env });
  const result = proposeNote(proposalFromEntry(entry, "note", { sourceText: input.text }), entry, { ...options, now });
  if (result.status === "accepted") return expandPersonal(result.entryId, options);
  if (result.status === "review") throw new KnowledgeError("CONTRADICTION", "That note conflicts with an existing entry. Run mex review.");
  if (result.reason === "secret") throw new KnowledgeError("SECRET_FOUND", "The entry contains a possible secret and was withheld.");
  if (result.reason === "quote-not-found") throw new KnowledgeError("UNVERIFIED_SOURCE", "The person quote was not found in the supplied typed text.");
  if (result.reason === "checks-unavailable") throw new KnowledgeError("CHECKS_UNAVAILABLE", "The check evaluator gave no answer.");
  if (result.reason === "duplicate-entry") throw new KnowledgeError("DUPLICATE_ENTRY", "That note matches an existing entry.");
  if (result.reason === "duplicate-rule-line") throw new KnowledgeError("DUPLICATE_RULE_LINE", "That note matches an existing repository rule.");
  if (result.reason === "forgotten") throw new KnowledgeError("RETIRED_ENTRY", "That note matches an entry you retired.");
  throw new KnowledgeError("INVALID_ENTRY", result.detail ?? "The note could not be saved.");
}
function words(text: string): string[] { return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []; }
function load(directory: string, id: string): KnowledgeEntry | undefined {
  const content = readEntryFile(join(directory, `${id}.md`));
  if (content === undefined) return undefined;
  const entry = parseEntry(content);
  if (entry.mex.id !== id) throw new KnowledgeError("INVALID_ENTRY", "Entry id does not match its filename.");
  return entry.mex.status === "active" ? entry : undefined;
}
/** proposed: also read a decision that isn't in force yet (to show or retire it, never to edit its claim). */
export function personalSnapshot(id: string, options: KnowledgeOptions, project = knowledgeProject(options), source?: References, gated = true, proposed = false) {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Expected a stable entry id such as mx_7f3k2a.");
  const directory = readDirectory(project);
  const content = directory && !project.retired.has(id) && readEntryFile(join(directory, `${id}.md`));
  if (!directory || !content) throw new KnowledgeError("NOT_FOUND", "No active personal note has that id in this project.");
  const entry = parseEntry(content);
  if (entry.mex.id !== id) throw new KnowledgeError("INVALID_ENTRY", "Entry id does not match its filename.");
  if (entry.mex.status !== "active" && !(proposed && entry.mex.status === "proposed")) throw new KnowledgeError("NOT_FOUND", "No active personal note has that id in this project.");
  return { ...display(gated ? gateEntry(entry, source ?? references(project.root)) : entry), directory, content };
}
export function expandPersonal(id: string, options: KnowledgeOptions, project = knowledgeProject(options), source?: References): PersonalEntry {
  const { level, label, entry } = personalSnapshot(id, options, project, source, true, true);
  return { level, label, entry };
}
export function expand(id: string, options: KnowledgeOptions): StoredEntry {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Expected a stable entry id such as mx_7f3k2a.");
  const project = knowledgeProject(options);
  if (project.retired.has(id)) throw new KnowledgeError("NOT_FOUND", "No active entry has that id in this project.");
  try { return expandPersonal(id, options, project); }
  catch (error) { if (!(error instanceof KnowledgeError) || error.code !== "NOT_FOUND") throw error; }
  const team = expandTeam(id, options);
  if (team) return team;
  const hint = readHints(options).entries.find(item => item.entry.mex.id === id);
  if (hint) return hint;
  throw new KnowledgeError("NOT_FOUND", "No active entry has that id in this project.");
}
export interface RecallItem {
  id: string; level: KnowledgeLevel; label: string; kind: EntryKind; one_line: string;
  scope: string[]; source: Pick<KnowledgeEntry["mex"]["source"], "type" | "ref">;
  evidence: KnowledgeEntry["mex"]["evidence"]; created: string;
  branch?: TeamEntry["branch"];
  score?: number;
  why?: { matched: string[]; exact: boolean };
  /** "changed": the code it names changed since it was written; it's being checked. */
  verdict?: "changed";
}
export interface RecallResult {
  entries: RecallItem[]; truncated: boolean; withheld?: number;
  /** Entries left out because the code no longer matches them (their check fails). */
  stale?: number;
  hintsPartial?: boolean; ranking?: { engine: "native" | "legacy"; reason?: string };
}

/**
 * The truth gate for pulled knowledge, the same as for pushed: an entry whose
 * check fails on today's code (broken) is left out, one whose code changed is
 * marked. Verdicts come from the evaluator's cache; without it nothing is
 * filtered, as delivery does.
 */
export function gateRecall(items: RecallItem[], options: KnowledgeOptions, project: KnowledgeProject): { kept: RecallItem[]; stale: number } {
  const verdicts = cachedVerdicts(options, project.projectId, project.root);
  if (!verdicts?.size) return { kept: items, stale: 0 };
  let stale = 0;
  const kept: RecallItem[] = [];
  for (const item of items) {
    const verdict = verdicts.get(item.id);
    if (verdict === "broken") { stale++; continue; }
    kept.push(verdict === "changed" ? { ...item, verdict: "changed" } : item);
  }
  return { kept, stale };
}

/** The cached verdict of one entry in this checkout, if the evaluator has one. */
export function entryVerdict(id: string, options: KnowledgeOptions): string | undefined {
  const project = knowledgeProject(options);
  return cachedVerdicts(options, project.projectId, project.root)?.get(id);
}
export function recallItem(item: { level: KnowledgeLevel; label: string; entry: KnowledgeEntry; branch?: TeamEntry["branch"] }): RecallItem {
  const { id, kind, one_line, scope, source, evidence, created } = item.entry.mex;
  return { id, level: item.level, label: item.label, kind, one_line, scope, source: { type: source.type, ref: source.ref }, evidence, created, ...(item.branch ? { branch: item.branch } : {}) };
}
export function matchesQuery(entry: KnowledgeEntry, query: string): boolean {
  const searchable = new Set(words([entry.text, entry.mex.one_line, entry.mex.kind, ...entry.mex.scope].join(" ")));
  return [...new Set(words(query))].every(term => searchable.has(term));
}
export function recallPersonal(query: string, options: KnowledgeOptions, limit = 20, project = knowledgeProject(options), source?: References, collect?: (entry: KnowledgeEntry) => void): RecallResult {
  const check = personalReadGuard(join(project.location.home, "projects", project.projectId, "notes"));
  if (query.length > KNOWLEDGE_LIMITS.queryCharacters) throw new KnowledgeError("INVALID_QUERY", "Search text exceeds 256 characters.");
  const terms = [...new Set(words(query))];
  if (!terms.length) throw new KnowledgeError("INVALID_QUERY", "Search requires at least one word.");
  if (!Number.isInteger(limit) || limit < 1 || limit > KNOWLEDGE_LIMITS.results) throw new KnowledgeError("INVALID_LIMIT", "Search limit must be between 1 and 100.");
  const directory = readDirectory(project);
  if (!directory) return { entries: [], truncated: false };
  const { retired } = project;
  const names: string[] = [];
  const handle = opendirSync(directory);
  try {
    let child, seen = 0;
    while ((child = handle.readSync())) {
      if (++seen > KNOWLEDGE_LIMITS.entries) throw new KnowledgeError("STORE_LIMIT", "Personal note directory exceeds the scan limit.");
      if (/^mx_[a-z0-9]{6,64}\.md$/u.test(child.name)) names.push(child.name.slice(0, -3));
    }
  } finally { handle.closeSync(); }
  names.sort();
  const matches: RecallItem[] = [];
  let totalBytes = 0;
  for (const id of names) {
    const content = readEntryFile(join(directory, `${id}.md`));
    if (content === undefined) continue;
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("STORE_LIMIT", "Personal notes exceed the byte scan limit.");
    if (retired.has(id)) continue;
    let entry = parseEntry(content);
    if (entry.mex.id !== id) throw new KnowledgeError("INVALID_ENTRY", "Entry id does not match its filename.");
    if (entry.mex.status !== "active") continue;
    source ??= references(project.root);
    entry = gateEntry(entry, source);
    collect?.(entry);
    const searchable = new Set(words([entry.text, entry.mex.one_line, entry.mex.kind, ...entry.mex.scope].join(" ")));
    if (terms.every(term => searchable.has(term))) {
      const { kind, one_line, scope, source, evidence, created } = entry.mex;
      matches.push({ id, level: "personal", label: display(entry).label, kind, one_line, scope, source: { type: source.type, ref: source.ref }, evidence, created });
    }
  }
  matches.sort((a, b) => a.created !== b.created ? (a.created > b.created ? -1 : 1) : a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
  check();
  return { entries: matches.slice(0, limit), truncated: matches.length > limit };
}

export function recall(query: string, options: KnowledgeOptions, limit = 20): RecallResult {
  const project = knowledgeProject(options);
  const personalEntries: PersonalEntry[] = [];
  const personal = recallPersonal(query, options, limit, project, undefined, entry => personalEntries.push(display(entry)));
  const team = teamEntries(options);
  const hints = readHints(options);
  const candidates = [...personalEntries, ...team.entries, ...hints.entries].filter(item => !project.retired.has(item.entry.mex.id));
  const byId = new Map<string, StoredEntry>();
  for (const item of candidates) if (!byId.has(item.entry.mex.id)) byId.set(item.entry.mex.id, item);
  const reader = openRecordReadOnly(options);
  let setting: string | undefined;
  try { setting = reader?.setting("global", "delivery.aliases"); } finally { reader?.close(); }
  const ranked = rankNative(query, [...byId.values()].map(item => item.entry), aidsEnabled(options.env ?? process.env, setting));
  // The ranker leaves out words most entries share, so with a few notes a word
  // they all use ("staging") finds nothing; the literal match then answers.
  if (ranked.hits?.length) {
    const { kept: found, stale } = gateRecall(ranked.hits.map(hit => ({ ...recallItem(byId.get(hit.id)!), score: hit.score, why: { matched: hit.matched, exact: hit.exact } })), options, project);
    return { entries: found.slice(0, limit), truncated: found.length > limit, withheld: team.withheld + hints.withheld, ...(stale ? { stale } : {}), ...(hints.partial ? { hintsPartial: true } : {}), ranking: { engine: "native" } };
  }
  const items = [...personal.entries, ...[...team.entries, ...hints.entries].filter(item => !project.retired.has(item.entry.mex.id) && matchesQuery(item.entry, query)).map(recallItem)];
  const seen = new Set<string>();
  const unique = items.filter(item => !seen.has(item.id) && !!seen.add(item.id));
  unique.sort((a, b) => KNOWLEDGE_PRIORITY.indexOf(a.level) - KNOWLEDGE_PRIORITY.indexOf(b.level)
    || b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
  const { kept: entries, stale } = gateRecall(unique, options, project);
  const withheld = team.withheld + hints.withheld;
  return { entries: entries.slice(0, limit), truncated: personal.truncated || entries.length > limit, ...(withheld ? { withheld } : {}), ...(stale ? { stale } : {}), ...(hints.partial ? { hintsPartial: true } : {}), ranking: { engine: "legacy", reason: ranked.reason ?? "no-native-hits" } };
}
