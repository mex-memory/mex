/**
 * Clustering across the whole review window, with no model and no embeddings.
 *
 * Each cluster is led by its strongest member. Candidates are visited strongest first, and each joins
 * the first cluster whose leader it matches, or leads a new one. Matching only the leader (not any
 * member) keeps lessons from chaining together through intermediate items, so a cluster's support
 * (its distinct PRs) counts one lesson, not a neighbourhood of related ones.
 *
 * Two items match when they share a distinctive code identifier in the same package (or a long
 * identifier anywhere), or when their lesson drafts share most of their content words and their
 * triage category. Earlier learned entries are matched the same way, so a repeated lesson adds
 * support to the entry that already holds it instead of becoming a duplicate.
 */
import { createHash } from "node:crypto";
import type { LessonSupport } from "./coverage.js";
import type { Candidate, CandidateKind } from "./harvest/types.js";
import type { TriageCategory, TriageResult } from "./triage.js";

export interface Triaged { candidate: Candidate; triage: TriageResult }
export interface EarlierLearned { id: string; text: string; scope: readonly string[]; patterns: readonly string[]; support?: LessonSupport }
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
  /** Word links: Jaccard similarity of the lesson drafts' content words, and the fewest shared words. */
  wordJaccard: 0.5,
  minSharedWords: 3,
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
  "code", "file", "files", "change", "changes"]);

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
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
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

interface Profile { item: Triaged; identifiers: Set<string>; words: Set<string>; area: string }

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): { score: number; shared: number } {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const union = a.size + b.size - shared;
  return { score: union ? shared / union : 0, shared };
}

function matches(leader: Profile, other: Profile, common: ReadonlySet<string>): boolean {
  for (const id of other.identifiers) {
    if (!leader.identifiers.has(id) || common.has(id)) continue;
    if (id.length >= CLUSTER_LIMITS.longIdentifier || (leader.area !== "" && leader.area === other.area)) return true;
  }
  if (leader.item.triage.category !== other.item.triage.category) return false;
  const { score, shared } = jaccard(leader.words, other.words);
  return score >= CLUSTER_LIMITS.wordJaccard && shared >= CLUSTER_LIMITS.minSharedWords;
}

export interface ClusterOptions { packageOf?: (path: string | undefined) => string; earlier?: readonly EarlierLearned[] }

/** Group kept triage results into clusters, decide which are written (D1), and match earlier entries. */
export function clusterLessons(items: readonly Triaged[], options: ClusterOptions = {}): Cluster[] {
  const packageOf = options.packageOf ?? defaultPackageOf;
  const kept = items.filter(item => item.triage.keep).sort(rank);
  const profiles = kept.map((item): Profile => ({ item, identifiers: new Set(identifiersOf(item)),
    words: lessonWords(item.triage.lesson), area: packageOf(item.candidate.path ?? item.candidate.changedPaths?.[0]) }));
  // An identifier most of the run mentions (the framework's own name, a common helper) links nothing.
  const frequency = new Map<string, number>();
  for (const profile of profiles) for (const id of profile.identifiers) frequency.set(id, (frequency.get(id) ?? 0) + 1);
  const common = new Set([...frequency].filter(([, n]) => profiles.length >= 5 && n > CLUSTER_LIMITS.commonShare * profiles.length).map(([id]) => id));
  const groups: Array<{ leader: Profile; members: Profile[] }> = [];
  for (const profile of profiles) {
    const home = groups.find(group => matches(group.leader, profile, common));
    if (home) home.members.push(profile);
    else groups.push({ leader: profile, members: [profile] });
  }
  return groups.map(group => summarize(group.leader, group.members, options.earlier ?? [], common, packageOf));
}

function summarize(leader: Profile, members: Profile[], earlier: readonly EarlierLearned[], common: ReadonlySet<string>,
  packageOf: (path: string | undefined) => string): Cluster {
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
  const category = [...categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  const leaderProfile: Profile = { ...leader, identifiers: identifiers.size ? identifiers : leader.identifiers };
  const earlierMatch = earlier.find(entry => {
    const profile: Profile = { item: leader.item, area: packageOf(entry.scope.find(glob => !glob.includes("*")) ?? entry.scope[0]),
      words: lessonWords(entry.text), identifiers: new Set([...entry.patterns, ...entry.text.matchAll(IDENTIFIER)].map(token =>
        (typeof token === "string" ? token : token[0]).toLowerCase()).filter(id => id.length >= CLUSTER_LIMITS.minIdentifier)) };
    return matches(leaderProfile, profile, common) || matches(profile, leaderProfile, common);
  });
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
    key: createHash("sha256").update(ids[0]!).digest("hex").slice(0, 24),
    members: members.map(member => member.item), pulls: [...pulls].sort((a, b) => a - b), commits: [...commits].sort(),
    reviewers: reviewers.size, reviewerKeys: [...reviewers].sort(), support, strong, source, category, files: [...files].sort(), identifiers: [...identifiers].sort(),
    ...(earlierMatch ? { earlier: earlierMatch.id } : {}), decision, why,
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
