/** Candidate signals nominate comparisons. Only identical drafts or a same verdict join a leader. */
import { createHash } from "node:crypto";
import { globToRegExp } from "../file-index/glob.js";
import { squash } from "./lesson-text.js";
import type { LessonPair, MeaningQuestion, MeaningVerdict } from "./meaning.js";
import type { LessonSupport } from "./coverage.js";
import type { Candidate, CandidateKind } from "./harvest/types.js";
import type { TriageCategory, TriageResult } from "./triage.js";

export interface Triaged { candidate: Candidate; triage: TriageResult }
export interface EarlierLearned {
  id: string;
  text: string;
  /** The rule in one line; its reasons would blur the match. */
  claim?: string;
  scope: readonly string[];
  patterns: readonly string[];
  support?: LessonSupport;
  refused?: boolean;
}
export type ClusterSource = "review" | "docs" | "history";
export type ClusterDecision = "write" | "propose" | "drop";
export interface Cluster {
  key: string;
  members: Triaged[];
  pulls: number[];
  commits: string[];
  reviewers: number;
  reviewerKeys?: string[];
  /** Distinct PRs, plus distinct commits for history items that have no PR. */
  support: number;
  strong: boolean;
  source: ClusterSource;
  category: TriageCategory;
  files: string[];
  identifiers: string[];
  earlier?: string;
  earlierClaim?: string;
  relatedRefusals?: string[];
  /** The support the earlier entry already has, from its own evidence. */
  prior?: LessonSupport;
  decision: ClusterDecision;
  /** Why the decision was made, for the receipt. */
  why: string;
}

/** Thresholds, tuned on the lesson table in cluster.test.ts. */
export const CLUSTER_LIMITS = {
  /** Shortest identifier that can link two items. */
  minIdentifier: 4,
  /** An identifier at least this long links items in different packages too. */
  longIdentifier: 10,
  /** An identifier found in more than this share of the run's items is too common to link them. */
  commonShare: 0.3,
  /** Members sent to the writer per cluster; support still counts all of them. */
  writerMembers: 4,
} as const;

const CODE_KEYWORDS = new Set(["const", "let", "var", "function", "return", "import", "export", "default", "from", "async",
  "await", "this", "null", "undefined", "true", "false", "string", "number", "boolean", "object", "typeof", "instanceof",
  "class", "extends", "implements", "interface", "type", "public", "private", "protected", "static", "readonly", "new",
  "else", "elif", "while", "for", "break", "continue", "switch", "case", "throw", "catch", "finally", "yield", "self",
  "def", "lambda", "pass", "none", "func", "package", "struct", "chan", "defer", "range", "void", "enum", "char", "int",
  "bool", "float", "double", "long", "short", "unsigned", "include", "require", "module", "exports", "props", "value",
  "data", "result", "error", "args", "params", "options", "config", "item", "items", "index", "length", "name", "test",
  "expect", "describe", "should", "then", "when", "with", "that", "into", "have", "here", "there", "also", "only", "just"]);
const STOP_WORDS = new Set(["the", "and", "for", "not", "use", "using", "used", "with", "from", "into", "this", "that",
  "these", "those", "should", "must", "always", "never", "instead", "rather", "than", "when", "where", "which", "what",
  "make", "makes", "sure", "keep", "avoid", "prefer", "don't", "dont", "does", "doesn't", "are", "is", "was", "be", "been",
  "it", "its", "of", "to", "in", "on", "at", "by", "or", "an", "a", "as", "so", "if", "we", "our", "you", "your", "can",
  "code", "file", "files", "change", "changes", "every", "each", "all", "any"]);

const IDENTIFIER = /[@A-Za-z_$][\w$-]*(?:[./][@A-Za-z_$][\w$-]*)*/gu;

/** Identifiers that read as code: from the commented lines and from backticked or code-shaped lesson words. */
export function identifiersOf(item: Triaged): string[] {
  const found = new Set<string>();
  const keep = (token: string) => {
    if (token.length >= CLUSTER_LIMITS.minIdentifier && !CODE_KEYWORDS.has(token.toLowerCase()) && /[A-Za-z]/u.test(token)) {
      found.add(token.toLowerCase());
    }
  };
  // A dotted call (db.users.findOne) links by its whole chain and by each part, so a lesson that
  // names only findOne still meets it. A scoped package or path stays whole: its parts mean little.
  const add = (token: string) => {
    const clean = token.replace(/^[./]+|[./]+$/gu, "");
    keep(clean);
    if (clean.includes(".") && !clean.includes("/") && !clean.startsWith("@")) for (const part of clean.split(".")) keep(part);
  };
  for (const token of (item.candidate.code?.anchor ?? "").matchAll(IDENTIFIER)) add(token[0]);
  const lesson = item.triage.lesson;
  for (const span of lesson.matchAll(/`([^`]+)`/gu)) for (const token of span[1]!.matchAll(IDENTIFIER)) add(token[0]);
  // Unquoted code-shaped words: camelCase, snake_case, dotted, scoped packages, paths.
  for (const token of lesson.matchAll(IDENTIFIER)) {
    if (/[a-z][A-Z]|_|[./@]/u.test(token[0])) add(token[0]);
  }
  return [...found].sort();
}

function stem(word: string): string {
  let out = word;
  if (word.length > 5 && word.endsWith("ing")) out = word.slice(0, -3);
  else if (word.length > 4 && word.endsWith("ed")) out = word.slice(0, -2);
  else if (word.length > 4 && word.endsWith("es")) out = word.slice(0, -2);
  else if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) out = word.slice(0, -1);
  return out.length > 3 && out.endsWith("e") ? out.slice(0, -1) : out;
}

/** Content words of a lesson draft, lower-cased and lightly stemmed. */
export function lessonWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/u)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    words.add(stem(raw));
  }
  return words;
}

/** The package an item belongs to: a workspace folder when the path has one, else its top folder. */
export function defaultPackageOf(path: string | undefined): string {
  if (!path) return "";
  const parts = path.split("/");
  if (parts.length > 2 && /^(?:packages|apps|libs|services|crates|modules|plugins|extensions|internal|cmd|pkg)$/u.test(parts[0]!)) {
    return parts.slice(0, 2).join("/");
  }
  return parts.length > 1 ? parts[0]! : "";
}

const SOURCE_OF: Record<CandidateKind, ClusterSource> = {
  "review-thread": "review", "pr-text": "review", "closed-pr": "review", issue: "review",
  revert: "history", "cause-commit": "history", adr: "docs", doc: "docs",
};

function rank(a: Triaged, b: Triaged): number {
  const score = (item: Triaged) => (item.candidate.signal === "strong" ? 4 : 0) + (item.candidate.weights.actedOn ? 2 : 0)
    + (item.candidate.weights.familiar ? 1 : 0);
  return score(b) - score(a) || b.candidate.at.localeCompare(a.candidate.at) || a.candidate.id.localeCompare(b.candidate.id);
}

interface Profile {
  item: Triaged;
  identifiers: Set<string>;
  words: Set<string>;
  files: Set<string>;
  area: string;
}

function ownProfile(item: Triaged, packageOf: typeof defaultPackageOf, claim = item.triage.lesson): Profile {
  const files = new Set(item.candidate.path ? [item.candidate.path] : item.candidate.changedPaths ?? []);
  const identifiers = new Set(identifiersOf({ ...item, triage: { ...item.triage, lesson: claim } }));
  return { item, identifiers, words: lessonWords(claim), files, area: packageOf(files.values().next().value) };
}

function intersects<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function sharedWords(a: Profile, b: Pick<Profile, "words">, common: ReadonlySet<string>): boolean {
  let shared = 0;
  for (const word of a.words) {
    if (b.words.has(word) && (++shared >= 2 || word.length >= 4 && !common.has(word))) return true;
  }
  return false;
}

function nominate(a: Profile, b: Profile, commonIds: ReadonlySet<string>, commonWords: ReadonlySet<string>): boolean {
  return intersects(a.files, b.files) || sharedWords(a, b, commonWords) ||
    [...a.identifiers].some(id => b.identifiers.has(id) && !commonIds.has(id)
      && (id.length >= CLUSTER_LIMITS.longIdentifier || (a.area !== "" && a.area === b.area)));
}

function commonTerms(profiles: readonly Profile[], field: "identifiers" | "words"): Set<string> {
  if (profiles.length < 5) return new Set();
  const frequency = new Map<string, number>();
  for (const profile of profiles) for (const term of profile[field]) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  return new Set([...frequency].filter(([, n]) => n > CLUSTER_LIMITS.commonShare * profiles.length).map(([term]) => term));
}

export const earlierClaim = (entry: Pick<EarlierLearned, "claim" | "text">): string =>
  entry.claim ?? entry.text.trim().split(/\r?\n/u, 1)[0]!.slice(0, 160);

function profileEarlier(entry: EarlierLearned) {
  const claim = earlierClaim(entry);
  const identifiers = new Set([...entry.patterns, claim].flatMap(text =>
    [...text.matchAll(IDENTIFIER)].map(([id]) => id.toLowerCase()).filter(id => id.length >= CLUSTER_LIMITS.minIdentifier)));
  const scopes = entry.scope.flatMap(glob => {
    if (glob === "**" || glob === "**/*") return [];
    try { return [globToRegExp(glob)]; } catch { return []; }
  });
  return { claim, identifiers, scopes, words: lessonWords(claim) };
}

function nominateEarlier(profile: Profile, earlier: ReturnType<typeof profileEarlier>): boolean {
  return squash(profile.item.triage.lesson) === squash(earlier.claim)
    || [...profile.files].some(file => earlier.scopes.some(glob => glob.test(file)))
    || intersects(profile.identifiers, earlier.identifiers) || sharedWords(profile, earlier, new Set());
}

/** Find earlier notes worth comparing with a written claim. Each note still needs a verdict. */
export function earlierCandidates(cluster: Pick<Cluster, "members">, claim: string, earlier: readonly EarlierLearned[]): EarlierLearned[] {
  const profiles = cluster.members.map(item => ownProfile(item, defaultPackageOf, claim));
  return earlier.filter(entry => {
    const profile = profileEarlier(entry);
    return profiles.some(member => nominateEarlier(member, profile));
  });
}

export function earlierPair(lesson: string, entry: EarlierLearned, claim?: string): LessonPair {
  return { left: { lesson, ...(claim ? { claim } : {}) }, right: { lesson: earlierClaim(entry) } };
}

interface ClusterOptions { packageOf?: typeof defaultPackageOf; earlier?: readonly EarlierLearned[] }

/** Plan comparisons before choosing leaders so every nominated pair can share a bounded model call. */
export function planClusters(items: readonly Triaged[], options: ClusterOptions = {}) {
  const packageOf = options.packageOf ?? defaultPackageOf;
  const profiles = items.filter(item => item.triage.keep).sort(rank).map(item => ownProfile(item, packageOf));
  const commonIds = commonTerms(profiles, "identifiers");
  const commonWords = commonTerms(profiles, "words");
  const earlier = (options.earlier ?? []).map(entry => ({ entry, profile: profileEarlier(entry) }));
  const questions: MeaningQuestion[] = [];
  const questionIndex = new Map<string, number>();
  const ask = (pair: LessonPair): number => {
    const key = JSON.stringify(pair);
    const existing = questionIndex.get(key);
    if (existing !== undefined) return existing;
    const index = questions.length;
    questions.push({ lesson: pair });
    questionIndex.set(key, index);
    return index;
  };
  const comparisons = profiles.map((profile, i) => {
    const own = new Map<Profile, number | "same">();
    const lesson = profile.item.triage.lesson;
    for (let j = 0; j < i; j++) {
      const other = profiles[j]!;
      if (profile.item.triage.category !== other.item.triage.category) continue;
      const previous = other.item.triage.lesson;
      if (lesson === previous) own.set(other, "same");
      else if (nominate(profile, other, commonIds, commonWords)) {
        own.set(other, ask({ left: { lesson: previous }, right: { lesson } }));
      }
    }
    const prior = earlier.flatMap(({ entry, profile: old }) =>
      nominateEarlier(profile, old) ? [{ entry, index: ask(earlierPair(lesson, entry)) }] : []);
    return { profile, own, prior };
  });

  function resolve(verdicts: ReadonlyArray<MeaningVerdict | undefined> = []): Cluster[] {
    type Comparison = typeof comparisons[number];
    const groups: Array<{ leader: Comparison; members: Comparison[] }> = [];
    for (const comparison of comparisons) {
      const home = groups.find(({ leader }) => {
        const match = comparison.own.get(leader.profile);
        return match === "same" || (match !== undefined && verdicts[match] === "same");
      });
      if (home) home.members.push(comparison);
      else groups.push({ leader: comparison, members: [comparison] });
    }
    return groups.map(({ leader, members }) => {
      const refused = members.flatMap(member => member.prior).filter(({ entry }) => entry.refused);
      const match = refused.find(({ index }) => verdicts[index] === "same") ??
        leader.prior.find(({ index }) => verdicts[index] === "same");
      const related = [...new Set(refused.filter(({ index }) => verdicts[index] === "related").map(({ entry }) => entry.id))];
      const cluster = total(members.map(({ profile: { item, identifiers } }) => ({ item, identifiers })), match?.entry);
      return related.length ? { ...cluster, relatedRefusals: related } : cluster;
    });
  }

  return { questions, resolve };
}

/** Count only members that independently back the claim. The entry keeps its cluster key. */
export function backedBy(cluster: Cluster, ids: ReadonlySet<string>, keepEarlier: boolean): Cluster {
  const members = cluster.members.filter(member => ids.has(member.candidate.id));
  const earlier = keepEarlier && cluster.earlier && cluster.earlierClaim
    ? { id: cluster.earlier, claim: cluster.earlierClaim, text: cluster.earlierClaim, support: cluster.prior } : undefined;
  if (members.length === cluster.members.length && !!earlier === !!cluster.earlier) return cluster;
  const backed = total(members.map(item => ({ item, identifiers: new Set(identifiersOf(item)) })), earlier);
  return { ...backed, key: cluster.key };
}

function total(members: ReadonlyArray<{ item: Triaged; identifiers: ReadonlySet<string> }>, earlierMatch?: Pick<EarlierLearned, "id" | "text" | "claim" | "support">): Cluster {
  const pulls = new Set<number>(), commits = new Set<string>(), reviewers = new Set<string>();
  const files = new Set<string>(), identifiers = new Set<string>();
  const sources = new Set<ClusterSource>();
  const categories = new Map<TriageCategory, number>();
  for (const { item, identifiers: ids } of members) {
    const candidate = item.candidate;
    sources.add(SOURCE_OF[candidate.kind]);
    if (candidate.pull) pulls.add(candidate.pull);
    for (const pull of candidate.related?.pulls ?? []) pulls.add(pull);
    if (!candidate.pull && SOURCE_OF[candidate.kind] === "history") {
      const sha = /^git:(?:revert|cause):([a-f0-9]{7,64})$/u.exec(candidate.id)?.[1];
      if (sha) commits.add(sha);
    }
    for (const reviewer of candidate.reviewers) reviewers.add(reviewer);
    if (candidate.path) files.add(candidate.path);
    for (const id of ids) identifiers.add(id);
    categories.set(item.triage.category, (categories.get(item.triage.category) ?? 0) + 1);
  }
  const strong = members.some(member => member.item.candidate.signal === "strong");
  const source: ClusterSource = sources.has("review") ? "review" : sources.has("history") ? "history" : "docs";
  const category = [...categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "one-off";
  for (const pull of earlierMatch?.support?.pulls ?? []) pulls.add(pull);
  for (const commit of earlierMatch?.support?.commits ?? []) commits.add(commit);
  for (const reviewer of earlierMatch?.support?.reviewers ?? []) reviewers.add(reviewer);
  const support = pulls.size + commits.size;
  const docs = source === "docs";
  const corroborated = sources.size > 1 && sources.has("docs");
  const decision: ClusterDecision = docs || support >= 2 || corroborated ? "write" : strong ? "propose" : "drop";
  const why = docs ? "written policy" : corroborated ? "a doc and a review agree" : support >= 2 ? `${support} PRs or commits`
    : strong ? "one PR with a strong signal" : "one PR, no strong signal";
  const ids = members.map(member => member.item.candidate.id).sort();
  return {
    key: createHash("sha256").update(ids[0] ?? "").digest("hex").slice(0, 24),
    members: members.map(member => member.item), pulls: [...pulls].sort((a, b) => a - b), commits: [...commits].sort(),
    reviewers: reviewers.size, reviewerKeys: [...reviewers].sort(), support, strong, source, category, files: [...files].sort(), identifiers: [...identifiers].sort(),
    ...(earlierMatch ? { earlier: earlierMatch.id, earlierClaim: earlierClaim(earlierMatch),
      ...(earlierMatch.support ? { prior: earlierMatch.support } : {}) } : {}), decision, why,
  };
}

/** The members the writer sees: the strongest first, one per PR where possible. */
export function writerMembers(cluster: Cluster): Triaged[] {
  const seen = new Set<number | string>();
  const picked: Triaged[] = [];
  for (const member of cluster.members) {
    const unit = member.candidate.pull ?? member.candidate.id;
    if (seen.has(unit)) continue;
    seen.add(unit);
    picked.push(member);
    if (picked.length === CLUSTER_LIMITS.writerMembers) return picked;
  }
  for (const member of cluster.members) {
    if (picked.length === CLUSTER_LIMITS.writerMembers) break;
    if (!picked.includes(member)) picked.push(member);
  }
  return picked;
}

/**
 * Docs are at most a quarter of a run's written entries unless the repo has no review history.
 * Returns the clusters to write, with the docs beyond the quota turned into drops.
 */
export function applyDocQuota(clusters: readonly Cluster[], share = 0.25, hasReviewHistory = false): Cluster[] {
  const written = clusters.filter(cluster => cluster.decision !== "drop");
  const nonDocs = written.filter(cluster => cluster.source !== "docs").length;
  if (nonDocs === 0 && !hasReviewHistory && !clusters.some(cluster => cluster.source === "review")) return [...clusters];
  const allowed = Math.floor((share * nonDocs) / (1 - share));
  let docs = 0;
  return clusters.map(cluster => {
    if (cluster.source !== "docs" || cluster.decision === "drop") return cluster;
    docs++;
    return docs <= allowed ? cluster : { ...cluster, decision: "drop" as const, why: "over the docs quota" };
  });
}
