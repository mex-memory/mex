import { hasSecret, stripHidden } from "../../knowledge/gates.js";
import { repoPath } from "../git.js";
import type { Reviewers } from "../reviewers.js";
import { sourceDigest } from "../source.js";
import type { Candidate } from "./types.js";

export const TEXT_BYTES = 4096;
export const PR_BYTES = 1536;
const privateMarker = /<\s*\/?\s*private\b/iu;
const guideline = /(?:https?:\/\/[^\s)>\]]+|\]\([^\s)]+\))/giu;
const generalising = /\b(?:always|never|we don['’]t|in this repo(?:sitory)?|instead use|conventions?|prefer\b[^\n.!?]{1,100}\bover)\b/iu;

export class Gaps {
  readonly messages = new Set<string>();
  private privateText = 0;
  private privateRegions = 0;

  withheld(region: boolean): void {
    if (region) this.privateRegions++;
    else this.privateText++;
  }

  list(): string[] {
    return [...this.messages,
      ...(this.privateText ? [`Privacy checks withheld ${this.privateText} source texts.`] : []),
      ...(this.privateRegions ? [`Privacy checks withheld ${this.privateRegions} code regions or hunks.`] : [])];
  }
}

export function safeRaw(raw: string): string | undefined {
  const clean = stripHidden(raw);
  if (privateMarker.test(raw) || privateMarker.test(clean) || hasSecret(raw) || hasSecret(clean)) return undefined;
  return clean;
}

export function safePath(path: unknown): path is string {
  return repoPath(path) && safeRaw(path) === path;
}

export function excerpt(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = max;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function cleanText(raw: string, gaps: Gaps, reviewers: Reviewers, max = TEXT_BYTES): string | undefined {
  if (!raw.trim()) return undefined;
  const clean = safeRaw(raw);
  if (clean === undefined) { gaps.withheld(false); return undefined; }
  const redacted = reviewers.redact(clean, "all").trim();
  if (hasSecret(redacted)) { gaps.withheld(false); return undefined; }
  return excerpt(redacted, max).trim() || undefined;
}

export function reviewerKey(slug: string, login: string): string {
  return sourceDigest(`reviewer\n${slug.toLowerCase()}\n${login.toLowerCase()}`);
}

export function newCandidate(source: Omit<Candidate, "weights" | "signal">,
  weights: Partial<Candidate["weights"]> = {}): Candidate {
  const guidelineLink = [...source.text.matchAll(guideline)].some(([link]) =>
    /(?:^|[./#_(-])(?:contributing|docs?|style[-_]?guide|wiki|adrs?|decisions)(?:[./#_?)-]|$)/iu.test(link));
  const flags = { actedOn: false, familiar: false, guidelineLink, generalising: generalising.test(source.text),
    smallPr: false, hotUnknown: false, ...weights };
  return { ...source, weights: flags, signal: flags.guidelineLink || (flags.actedOn && flags.familiar)
    || (flags.generalising && source.reviewers.length > 0) ? "strong" : "weak" };
}

export function rankCandidates(a: Candidate, b: Candidate): number {
  return Number(b.weights.hotUnknown) - Number(a.weights.hotUnknown)
    || Number(b.signal === "strong") - Number(a.signal === "strong")
    || Number(b.weights.actedOn) - Number(a.weights.actedOn)
    || Number(b.weights.familiar) - Number(a.weights.familiar)
    || Number(b.weights.smallPr) - Number(a.weights.smallPr);
}
