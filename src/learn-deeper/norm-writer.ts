import { z } from "zod";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import { claimHash } from "../knowledge/state.js";
import { draftSupport, type DraftSupport } from "./draft-evidence.js";
import type { Candidate } from "./harvest/types.js";
import { WRITER_CHAR_LIMIT } from "./harvest/estimate.js";
import { newCandidate } from "./harvest/evidence.js";
import { readsAsComment, statesAction, squash, polarityMismatch } from "./lesson-text.js";
import { processConfirmed } from "./prove.js";
import { replyJson } from "./reply.js";
import { narrowsRepo, pinnedScope } from "./scope.js";
import { findQuote, NormKind, NormScope, type Observation } from "./triage.js";
import { WriterEntry } from "./write.js";
import { docWriter, normWriter } from "./writer-prompts.js";

const writerFields = { text: z.string().trim().min(1).max(950), kind: NormKind, scope: NormScope };
const norm = z.object({ ...writerFields, support: z.array(z.string()).min(1).max(256), patternable: z.boolean(),
  extends: z.string().optional(), refusal: z.string().optional(), lint: WriterEntry.shape.lint, alternatives: WriterEntry.shape.alternatives }).strict();
const doc = z.object({ ...writerFields, source: z.string().max(512), quote: z.string().trim().min(1).max(1800)
  .refine(text => text.split(/\s+/u).length <= 30) }).strict();
const policy = z.object({ policy: z.string().min(1).max(950), support: z.array(z.string()).min(1).max(256), prs: z.number().int().nonnegative() }).strict();
const normReply = z.object({ policies: z.array(policy).max(256), norms: z.array(z.unknown()).max(256) }).strict();
const docReply = z.object({ rules: z.array(z.unknown()).max(256) }).strict();

const families: string[][] = [
  ["placement", "api-design", "compatibility"], ["tests", "docs-comments", "process"],
  ["conventions", "scope", "size-performance", "dependencies", "pitfall", "security"],
];

export interface EarlierNorm { id: string; claim: string; refused?: boolean }
export interface Draft { entry: WriterEntry; support: DraftSupport; patternable: boolean }

function observationInput(item: Observation) {
  const { id, at, sourceKind: source, pull: pr, quote, norm, why, kind, scope, form, stated_as_rule, response } = item;
  return { id, date: at.slice(0, 10), source, pr, quote, norm, why, kind, scope, form, stated_as_rule, response };
}

const oldest = (a: Observation, b: Observation) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
export function normPrompt(items: readonly Observation[], earlier: readonly EarlierNorm[]): string {
  return normWriter + "\nOptional lint is {config,rule} only for a known rule that would enforce the observation. For a decision with an option explicitly ruled out and its reason, optional alternatives is [{option,reason}].\nExisting rules and refusals:\n" + JSON.stringify(earlier) + "\n"
    + [...items].sort(oldest).map(item => JSON.stringify(observationInput(item))).join("\n");
}

export function packObservations(items: readonly Observation[], earlier: readonly EarlierNorm[]): Observation[][] {
  if (!items.length) return [];
  const limit = Math.max(30_000, WRITER_CHAR_LIMIT - normPrompt([], earlier).length);
  const size = (item: Observation) => JSON.stringify(observationInput(item)).length + 1;
  if (items.reduce((sum, item) => sum + size(item), 0) <= limit) return [[...items]];
  const batches: Observation[][] = [];
  for (const family of families) {
    let batch: Observation[] = [], total = 0;
    for (const item of [...items].filter(item => family.includes(item.kind)).sort(oldest)) {
      const characters = size(item);
      if (batch.length && total + characters > limit) { batches.push(batch); batch = []; total = 0; }
      batch.push(item);
      total += characters;
    }
    if (batch.length) batches.push(batch);
  }
  return batches;
}

export function docsPrompt(items: readonly Candidate[]): string {
  const files = new Map<string, string[]>();
  for (const item of items) if (item.path) {
    const passages = files.get(item.path) ?? [];
    passages.push([...(item.document?.headings ?? []), item.text].join("\n"));
    files.set(item.path, passages);
  }
  return docWriter + "\n\n" + [...files].map(([path, passages]) =>
    "=== FILE " + path + "\n" + passages.join("\n\n")).join("\n\n");
}

function unique<T>(items: readonly T[]): T[] { return [...new Set(items)]; }

function scopeFor(scope: z.infer<typeof NormScope>, paths: readonly string[]): string[] {
  const entries = scope === "repo" || scope.length === 1 && scope[0] === "repo" ? ["**"] : scope;
  return unique(unique(entries).flatMap(input => {
    const glob = pinnedScope(input, paths);
    return glob && (glob !== "**" || entries.length === 1) ? [glob] : [];
  }));
}

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
function claimAndWhy(text: string) {
  const [claim = "", ...reasons] = [...sentences.segment(squash(text))].map(item => item.segment.trim());
  return { claim, why: reasons.join(" ") };
}

function namedInRepo(text: string, sources: readonly string[], paths: readonly string[]): boolean {
  const source = sources.join("\n").toLowerCase();
  const names = [
    ...[...text.matchAll(/\x60([^\x60\r\n]+)\x60/gu)].map(match => match[1]!),
    ...[...text.matchAll(/(?:^|[\s(])((?:[\w.-]+\/)+[\w.*-]+|[\w-]+\.[a-z\d]{1,8})(?=[\s),.;:]|$)/giu)].map(match => match[1]!),
    ...[...text.matchAll(/\b(?:[a-z]+[A-Z][\w]*|[A-Z]{2,}[\w]*|[A-Za-z][\w]*[-_][\w-]+|\d+\.\d+(?:\.\d+)?|(?:main|master|next|stable|develop|trunk)\s+branch)\b/gu)].map(match => match[0]),
  ];
  return names.some(name => {
    const value = name.trim().toLowerCase();
    if (value.length < 2 || /^(?:pr|ci|api|cli|http|https|url|json|readme|tests?|docs?|branch|code|repo|test command)$/iu.test(value)) return false;
    return source.includes(value) || paths.some(path => path === name || path.startsWith(name.replace(/\/$/u, "") + "/"));
  });
}

function observedCandidate(observation: Observation, candidates: ReadonlyMap<string, Candidate>): Candidate {
  const { source, sourceKind, at, pull, quote } = observation;
  const current = candidates.get(source.id);
  const nodeIds = source.node ? [source.node] : current?.nodeIds ?? [];
  const hash = source.node ? source.hash : current?.hash ?? source.hash;
  const documentPath = sourceKind === "adr" ? source.link.split("#", 1)[0] : undefined;
  const gets = newCandidate({
    ...current, path: current?.path ?? documentPath, id: observation.id, kind: sourceKind, text: quote, at, pull, hash, link: source.link,
    nodeIds, commentHashes: source.node ? { [source.node]: source.hash } : current?.commentHashes,
    reviewers: source.reviewers ?? current?.reviewers ?? [],
  });
  return { ...gets, document: current?.document, lines: undefined, context: undefined };
}

function toDraft(text: string, kind: z.infer<typeof NormKind>, scope: string[], members: Candidate[],
  quotes: Array<{ id: string; quote: string }>, observations: Observation[], source: DraftSupport["source"],
  patternable: boolean, earlier?: string, refused = false): Draft | undefined {
  const { claim, why } = claimAndWhy(text);
  const decision = observations.length && observations.every(item => item.form === "decision");
  const ruledOut = observations.some(item => item.sourceKind === "closed-pr" || item.sourceKind === "issue")
    && decision && /\b(?:avoid|do not|don't|never|rather than|instead of)\b/iu.test(claim);
  const process = kind === "process" || kind === "compatibility" && processConfirmed({ claim, why }) && /\b(?:branch|release|changelog|version)\b/iu.test(claim);
  const route = process ? "process-rule" : ruledOut ? "ruled-out" : kind === "pitfall" ? "pitfall" : decision ? "decision" : "code-rule";
  const entryKind = route === "pitfall" ? "pitfall" : route === "decision" || route === "ruled-out" ? "decision" : "rule";
  if (!scope.length || !statesAction(claim, entryKind) || readsAsComment(claim) || stripHidden(text) !== text || hasSecret(text)) return;
  if (quotes.every(item => polarityMismatch(claim, item.quote))) return;
  const key = claimHash(claim).slice(7);
  const entry: WriterEntry = { cluster: key, route, kind: entryKind, claim, why,
    clauses: [{ text: claim, quotes }, ...(why ? [{ text: why, quotes }] : [])], scope, when: [], aliases: [] };
  const support = { ...draftSupport(members, observations, source, key), earlier, refused };
  return { entry, support, patternable };
}

export function parseNorms(text: string, items: readonly Observation[], earlier: readonly EarlierNorm[],
  candidates: ReadonlyMap<string, Candidate>, paths: readonly string[]) {
  const parsed = normReply.safeParse(replyJson(text));
  const drafts: Draft[] = [], drops: Record<string, number> = {};
  const drop = (reason: string) => { drops[reason] = (drops[reason] ?? 0) + 1; };
  if (!parsed.success) { drop("envelope"); return { drafts, drops }; }
  const known = new Map(items.map(item => [item.id, item])), prior = new Map(earlier.map(item => [item.id, item]));
  for (const item of parsed.data.policies) if (item.support.some(id => !known.has(id))
    || new Set(item.support.map(id => known.get(id)?.pull).filter(Boolean)).size !== item.prs) drop("policy-support");
  for (const value of parsed.data.norms) {
    const data = norm.safeParse(value);
    if (!data.success) { drop("format"); continue; }
    const { support, kind, scope, text, patternable, extends: extend, refusal } = data.data;
    const evidence = unique(support).map(id => known.get(id));
    if (evidence.some(item => !item) || extend && (!prior.has(extend) || prior.get(extend)?.refused)
      || refusal && !prior.get(refusal)?.refused) { drop("unknown-support"); continue; }
    const observations = (evidence as Observation[]).sort(oldest);
    const pulls = unique(observations.flatMap(item => item.pull === undefined ? [] : [item.pull]));
    const newest = observations.at(-1)!;
    const solo = newest.stated_as_rule && newest.response !== "disputed" && newest.pull !== undefined;
    if (!extend && pulls.length < 2 && !solo || newest.response === "disputed") { drop("support"); continue; }
    const scopes = scopeFor(scope, paths);
    if (!namedInRepo(text, observations.flatMap(item => [item.quote, item.norm]), paths) && !narrowsRepo(scopes, paths)) { drop("unnamed"); continue; }
    const members = observations.map(item => observedCandidate(item, candidates));
    const source = observations.some(item => item.pull !== undefined) ? "review" : "history";
    const draft = toDraft(text, kind, scopes, members,
      observations.map(item => ({ id: item.id, quote: item.quote })), observations, source, patternable, extend, !!refusal);
    if (draft) {
      draft.entry.lint = data.data.lint;
      draft.entry.alternatives = data.data.alternatives;
      drafts.push(draft);
    } else drop("invalid-claim-or-scope");
  }
  return { drafts, drops };
}

export function parseDocs(text: string, candidates: readonly Candidate[], paths: readonly string[]) {
  const parsed = docReply.safeParse(replyJson(text));
  const drafts: Draft[] = [], drops: Record<string, number> = {};
  const drop = (reason: string) => { drops[reason] = (drops[reason] ?? 0) + 1; };
  if (!parsed.success) { drop("envelope"); return { drafts, drops }; }
  for (const value of parsed.data.rules) {
    const data = doc.safeParse(value);
    if (!data.success) { drop("format"); continue; }
    const { text, kind, source, scope } = data.data;
    const candidate = candidates.find(item => item.path === source && findQuote(item.text, data.data.quote, false));
    if (!candidate) { drop("quote-not-found"); continue; }
    const quote = findQuote(candidate.text, data.data.quote, false)!;
    if (hasSecret(quote)) { drop("secret"); continue; }
    const draft = toDraft(text, kind, scopeFor(scope, paths), [candidate], [{ id: candidate.id, quote }], [], "docs", false);
    if (draft) drafts.push(draft);
    else drop("invalid-claim-or-scope");
  }
  return { drafts, drops };
}
