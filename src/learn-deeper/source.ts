import { createHash } from "node:crypto";
import { firstSecretOffset, hasSecret, stripHidden } from "../knowledge/gates.js";
import type { Reviewers } from "./reviewers.js";

export type Forge = "github.com" | "gitlab.com";
export interface Repository { host: Forge; slug: string; }

export interface ReviewSource {
  id: string;
  link: string;
  hash: string;
  kind: "review";
  text: string;
  at: string;
  pull: number;
  writer: boolean;
  topLevel: boolean;
  outdated: boolean;
  path?: string;
  changedPaths?: readonly string[];
}

export interface DocSource {
  id: string;
  link: string;
  hash: string;
  kind: "docs";
  text: string;
  path: string;
  coverage: "full" | "partial";
  at?: string;
}

export interface ContextSource { kind: "context"; id: string; link: string; hash: string; text: string; }
export interface SessionSource extends Omit<ContextSource, "kind"> { kind: "person"; at: string; session: string; }
export type LearningSource = ReviewSource | DocSource | ContextSource | SessionSource;
export interface SourceWindow { since: string; until: string; }

export function sourceBands({ since, until }: SourceWindow): SourceWindow[] {
  const from = Date.parse(since), to = Date.parse(until);
  const count = Math.min(6, to - from + 1);
  return Array.from({ length: count }, (_, i) => ({
    since: new Date(from + Math.floor((to - from) * i / count)).toISOString(),
    until: new Date(from + Math.floor((to - from) * (i + 1) / count)).toISOString(),
  })).reverse();
}

/** Visit all time bands before the second item in any one band. */
export function spreadPulls<T extends { number: number }>(bands: readonly T[][], limit: number): T[] {
  const seen = new Set<number>(), selected: T[] = [];
  for (let i = 0; i < Math.max(0, ...bands.map(band => band.length)); i++) {
    for (const band of bands) {
      const item = band[i];
      if (!item || seen.has(item.number)) continue;
      seen.add(item.number); selected.push(item);
      if (selected.length === limit) return selected;
    }
  }
  return selected;
}

export function repository(host: string, path: string): Repository | undefined {
  if (host !== "github.com" && host !== "gitlab.com") return undefined;
  const slug = path.replace(/^\//u, "").replace(/\/$/u, "").replace(/\.git$/u, "");
  const parts = slug.split("/");
  if (slug.length > 220 || parts.length < 2 || (host === "github.com" && parts.length !== 2)
    || parts.some(part => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(part))) return undefined;
  return { host, slug };
}

export function repositoryFromRemote(remote: string): Repository | undefined {
  const scp = /^git@([^:/]+):([^\s]+)$/u.exec(remote);
  if (scp) return repository(scp[1].toLowerCase(), scp[2]);
  try {
    const url = new URL(remote);
    const supported = (url.protocol === "https:" && !url.username) || (url.protocol === "ssh:" && url.username === "git");
    if (!supported || url.password || url.port || url.search || url.hash) return undefined;
    return repository(url.hostname, url.pathname);
  } catch { return undefined; }
}

export function sourceDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

const MAX_SOURCE_BYTES = 4096;
const PRIVATE = /<\s*\/?\s*private\b/iu;

function safeSourceText(raw: string): string | undefined {
  if (hasSecret(raw) || PRIVATE.test(raw)) return undefined;
  const text = stripHidden(raw);
  if (hasSecret(text) || PRIVATE.test(text)) return undefined;
  return text;
}

/** Check privacy and recognize code in the complete input before cutting an excerpt. */
function sourceExcerpt(raw: string, reviewers?: Reviewers, mode: "all" | "mentions-only" = "all"): Pick<DocSource, "text" | "coverage"> | undefined {
  const safe = safeSourceText(raw);
  if (safe === undefined) return undefined;
  const text = (reviewers ? reviewers.redact(safe, mode) : safe).trim();
  if (!text) return undefined;
  if (Buffer.byteLength(text) <= MAX_SOURCE_BYTES) return { text, coverage: "full" };
  const bytes = Buffer.from(text);
  let end = MAX_SOURCE_BYTES;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), coverage: "partial" };
}

export function cleanSourceText(raw: string, reviewers?: Reviewers): string | undefined {
  return sourceExcerpt(raw, reviewers)?.text;
}

export const DOC_PRIVACY_REASONS = ["private-marker", "possible-secret"] as const;
export interface DocumentPrivacy {
  status: "excerpt" | "skipped";
  reason: typeof DOC_PRIVACY_REASONS[number];
}
type DocExcerpt = Pick<DocSource, "text" | "coverage">;

export function documentExcerpt(raw: string, reviewers: Reviewers): { excerpt?: DocExcerpt; privacy?: DocumentPrivacy } {
  const clean = stripHidden(raw);
  if (PRIVATE.test(raw) || PRIVATE.test(clean)) return { privacy: { status: "skipped", reason: "private-marker" } };
  const rawSecret = firstSecretOffset(raw);
  const cleanSecret = firstSecretOffset(clean);
  if (rawSecret === undefined && cleanSecret === undefined) return { excerpt: sourceExcerpt(clean, reviewers, "mentions-only") };

  // End at a full line before the earliest finding, including findings
  // revealed by hidden-character removal. The suffix can contain additional
  // credential lines (for example the body of a private key).
  const secret = Math.min(rawSecret === undefined ? Infinity : stripHidden(raw.slice(0, rawSecret)).length, cleanSecret ?? Infinity);
  const end = secret === 0 ? 0 : clean.lastIndexOf("\n", secret - 1) + 1;
  const excerpt = end ? sourceExcerpt(clean.slice(0, end), reviewers, "mentions-only") : undefined;
  return excerpt && /[\p{L}\p{N}]/u.test(excerpt.text) && !hasSecret(excerpt.text)
    ? { excerpt: { ...excerpt, coverage: "partial" }, privacy: { status: "excerpt", reason: "possible-secret" } }
    : { privacy: { status: "skipped", reason: "possible-secret" } };
}

export function reviewRelevance(text: string): string | undefined {
  const remaining = text.replace(/^\s*`{3,}suggestion[^\n]*\n[\s\S]*?^\s*`{3,}\s*$/gimu, "").trim();
  if (!remaining || (/\?\s*$/u.test(remaining) && remaining.length < 120 && !/[.!]\s+\S/u.test(remaining))) return undefined;
  if (/^(?:lgtm|looks good(?: to me)?|approved|thanks(?: so much)?|thank you)[.!]*$/iu.test(remaining)) return undefined;
  return remaining;
}

export function validAt(value: string, since: string, until: string): boolean {
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= Date.parse(since) && at <= Date.parse(until);
}

export const REVIEW_LIMIT = 24;
export const BACKFILL_REVIEW_LIMIT = 32;

export function prioritizeReviews(reviews: readonly ReviewSource[], preferred: readonly string[]): ReviewSource[] {
  const near = (path?: string) => !!path && preferred.some(dir => path.startsWith(dir + "/"));
  const order = (a: ReviewSource, b: ReviewSource) => Number(b.writer) - Number(a.writer)
    || Number(b.topLevel) - Number(a.topLevel) || Number(b.outdated) - Number(a.outdated)
    || Number(near(b.path)) - Number(near(a.path));
  // A stable sort keeps the caller's pull order inside each priority tier.
  return [...reviews].sort(order);
}

export function reviewSource(raw: string, fields: Omit<ReviewSource, "kind" | "hash" | "text">, gaps: Set<string>): ReviewSource | undefined {
  if (!raw.trim()) return undefined;
  const clean = safeSourceText(raw);
  if (!clean) { gaps.add("Some source text was withheld by privacy checks."); return undefined; }
  const text = reviewRelevance(clean);
  return text ? { ...fields, kind: "review", hash: sourceDigest(raw), text } : undefined;
}

export function redactReviews(reviews: readonly ReviewSource[], reviewers: Reviewers, gaps: Set<string>,
  preferred: readonly string[], preferDistinctPulls = false): ReviewSource[] {
  const distinct = [...new Map(reviews.map(review => [review.id, review])).values()];
  const limit = preferDistinctPulls ? BACKFILL_REVIEW_LIMIT : REVIEW_LIMIT;
  if (distinct.length > limit) gaps.add("Some reviews exceeded the batch limit.");
  const ordered = prioritizeReviews(distinct, preferred);
  const selected = new Map<string, ReviewSource>();
  if (preferDistinctPulls) {
    const represented = new Set<number>();
    for (const review of ordered) {
      if (selected.size >= limit || !review.writer || represented.has(review.pull)) continue;
      selected.set(review.id, review);
      represented.add(review.pull);
    }
  }
  for (const review of ordered) {
    if (selected.size >= limit) break;
    selected.set(review.id, review);
  }
  return [...selected.values()].flatMap(review => {
    const text = cleanSourceText(review.text, reviewers);
    return text ? [{ ...review, text }] : [];
  });
}
