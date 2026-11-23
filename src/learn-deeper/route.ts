/**
 * Route a proven lesson into one producer-gate proposal: its kind, scope, triggers, fix, kept quote,
 * label, status, and the checks that keep it true (DESIGN.md 4.1-4.2):
 *
 * - a proven code rule: the before/after fixture it was proven on (complete), the presence of the
 *   literal its fix relies on (complete), the anti-pattern's count today (supporting, may only fall),
 *   scope presence (complete), and the cited review comments (supporting, re-fetched weekly);
 * - a doc or ADR lesson: its quoted passage, relocated rather than hashed whole (complete when the doc
 *   is the only evidence);
 * - a time-bound decision: its version limit (complete);
 * - every learned entry has at least one check.
 */
import { createHash } from "node:crypto";
import { slashPath } from "../file-index/glob.js";
import { hasSecret } from "../knowledge/gates.js";
import { KNOWLEDGE_LIMITS } from "../knowledge/entry.js";
import type { Proposal, ProposedCheck } from "../knowledge/gate.js";
import type { Cluster } from "./cluster.js";
import type { Candidate, Region } from "./harvest/types.js";
import type { ProofResult, ProvenPattern } from "./prove.js";
import { commonFolder } from "./prove.js";
import type { WriterModel } from "./entries.js";

export const ROUTE_LIMITS = { fixtureLines: 40, fixtureBytes: 12 << 10, sourceChecks: 6, quoteWords: 25, quoteContext: 32 } as const;

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** A region cut to at most `lines` lines around its middle, with its hash and line numbers renewed. */
export function trimRegion(region: Region, lines: number = ROUTE_LIMITS.fixtureLines, focus?: string): Region {
  const all = region.text.split("\n");
  if (all.length <= lines) return region;
  let centre = Math.floor(all.length / 2);
  if (focus) {
    const at = all.findIndex(line => line.includes(focus.split("\n")[0]!.trim()));
    if (at >= 0) centre = at;
  }
  const start = Math.max(0, Math.min(all.length - lines, centre - Math.floor(lines / 2)));
  const text = all.slice(start, start + lines).join("\n");
  return { ...region, start: region.start + start, end: region.start + start + lines - 1, text, hash: sha(text) };
}

/** The scope glob a single check uses: the one glob, or the common folder of several. */
export function checkGlob(scope: readonly string[]): string | undefined {
  const paths = scope.map(slashPath);
  if (paths.includes("**")) return undefined;
  if (paths.length === 1) return paths[0];
  return commonFolder(paths.map(glob => glob.replace(/\/\*\*.*$/u, "/x").replace(/\*.*$/u, "x"))) ?? undefined;
}

function primary(cluster: Cluster): Candidate {
  return cluster.members[0]!.candidate;
}

/** A pull request link without its fragment: the provenance a teammate can open. */
function pullLink(candidate: Candidate): string | undefined {
  return /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/pull\/\d+/u.exec(candidate.link)?.[0];
}

/** At most 25 words of a supporting quote, from prose rather than code, with no secret. Personal only (D9). */
export function keptQuote(proof: ProofResult): { quote: string; text: string } | undefined {
  const members = new Map(proof.cluster.members.map(member => [member.candidate.id, member.candidate]));
  for (const { id, quote } of proof.quotes) {
    const candidate = members.get(id);
    if (!candidate) continue;
    // One spacing on both sides: a quote may run over a line break, and is kept on one line.
    const prose = [candidate.text, candidate.prText].map(text => text?.replace(/\s+/gu, " ").trim())
      .find(text => text?.includes(quote.replace(/\s+/gu, " ").trim()));
    if (!prose) continue;
    const words = quote.trim().split(/\s+/u);
    const cut = words.slice(0, ROUTE_LIMITS.quoteWords).join(" ");
    if (cut && !hasSecret(cut) && prose.includes(cut)) return { quote: cut, text: prose };
  }
  return undefined;
}

function label(cluster: Cluster): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (cluster.source === "docs") {
    const path = primary(cluster).path ?? "the docs";
    return `Learned from ${path}`.slice(0, 80);
  }
  if (cluster.source === "history") return `Learned from ${plural(cluster.support, "past fix")}`;
  const people = cluster.reviewers ? `, ${plural(cluster.reviewers, "maintainer")}` : "";
  return `Learned from ${plural(Math.max(1, cluster.pulls.length), "PR")}${people}`;
}

function quoteCheck(proof: ProofResult, docs: Candidate[], complete: boolean): ProposedCheck | undefined {
  for (const { id, quote } of proof.quotes) {
    const doc = docs.find(candidate => candidate.id === id);
    if (!doc?.path) continue;
    const at = doc.text.indexOf(quote);
    if (at < 0) continue;
    const width = ROUTE_LIMITS.quoteContext;
    return { kind: "quote", role: complete ? "complete" : "supporting", target: {
      file: doc.path, exact: quote, prefix: doc.text.slice(Math.max(0, at - width), at), suffix: doc.text.slice(at + quote.length, at + quote.length + width),
      ...(doc.document?.headings.length ? { heading: doc.document.headings.at(-1)! } : {}),
    } } as ProposedCheck;
  }
  return undefined;
}

export interface Routed { proposal: Proposal; sources: Candidate[]; status: "active" | "proposed"; proven: boolean }

/** Active when the evidence or a fixture supports it. A waiting rule stays proposed until a person ticks it. */
export function learnedStatus(waiting: boolean | undefined, corroborated: boolean, proven: boolean, notAlwaysFollowed: boolean): "active" | "proposed" {
  if (waiting) return "proposed";
  return (corroborated || proven) && !notAlwaysFollowed ? "active" : "proposed";
}

/** Build the gate proposal for one proven lesson, or say why there is none. */
export function routeEntry(proof: ProofResult, plan: { host: string; slug: string }, model: WriterModel): Routed | { dropped: string } {
  if (proof.dropped) return { dropped: proof.dropped };
  const { cluster, draft } = proof;
  const members = cluster.members.map(member => member.candidate);
  const checks: ProposedCheck[] = [];
  const glob = checkGlob(proof.scope);
  const paired = proof.when.filter(item => item.pairs.length);
  const alternativesOnly = proof.when.filter(item => !item.pairs.length);
  // One fixture per pattern, holding only the pairs that pattern was proven on: the evaluator requires every pair
  // in a fixture to satisfy every trigger it proves, and a pattern need not match every member's code. A pattern
  // whose fixture can't be stored (no single scope, or over the entry's size budget) isn't kept: nothing could
  // recheck it.
  const stored: ProvenPattern[] = [];
  const fixtures: ProposedCheck[] = [];
  let bytes = 0;
  if (glob) for (const item of paired) {
    const pairs = item.pairs.slice(0, 3).flatMap(at => {
      const pair = proof.pairs[at]!;
      const before = trimRegion(pair.before, ROUTE_LIMITS.fixtureLines, pair.anchor);
      const after = trimRegion(pair.after, ROUTE_LIMITS.fixtureLines);
      const size = Buffer.byteLength(before.text) + Buffer.byteLength(after.text);
      if (bytes + size > ROUTE_LIMITS.fixtureBytes) return [];
      bytes += size;
      return [{ path: slashPath(pair.after.path), commit: pair.after.commit,
        before: { start: before.start, end: before.end, text: before.text, hash: before.hash },
        after: { start: after.start, end: after.end, text: after.text, hash: after.hash } }];
    });
    if (!pairs.length) continue;
    // `proves` indexes the entry's final `when`, which lists the stored patterns first.
    fixtures.push({ kind: "fixture", role: "complete", target: { pairs, proves: [stored.length] }, saw: { ok: true } } as ProposedCheck);
    stored.push(item);
  }
  const proven = stored.length > 0;
  const when = [...stored, ...alternativesOnly];

  if (proven && glob) {
    checks.push(...fixtures);
    if (proof.fixLiteral) {
      checks.push({ kind: "pattern", role: "complete", target: { scope: glob, pattern: proof.fixLiteral, match: "literal", expect: "present" } } as ProposedCheck);
    }
    for (const item of stored) {
      if (item.match !== "literal") continue;
      // Anti counts may only rise into a failure. A required form needs its own count so a migration can be measured.
      if (item.type === "anti") {
        checks.push({ kind: "pattern", role: "supporting", target: { scope: glob, pattern: item.pattern, match: "literal", expect: "at-most" } } as ProposedCheck);
      } else if (item.type === "required") {
        checks.push({ kind: "pattern", role: "supporting", target: { scope: glob, pattern: item.pattern, match: "literal", expect: "present" } } as ProposedCheck);
      }
    }
  }
  for (const scope of proof.scope) checks.push({ kind: "scope", role: "complete", target: { glob: slashPath(scope) } } as ProposedCheck);
  const reviews = members.filter(candidate => candidate.link.startsWith("https://github.com/") && pullLink(candidate));
  for (const candidate of [...new Map(reviews.map(candidate => [`${candidate.link}\n${candidate.hash}`, candidate])).values()].slice(0, ROUTE_LIMITS.sourceChecks)) {
    checks.push({ kind: "source", role: "supporting", target: { url: candidate.link }, saw: { hash: candidate.hash } } as ProposedCheck);
  }
  const docs = members.filter(candidate => candidate.kind === "doc" || candidate.kind === "adr");
  const quoted = docs.length ? quoteCheck(proof, docs, cluster.source === "docs") : undefined;
  if (quoted) checks.push(quoted);
  if (proof.symbol) checks.push({ kind: "symbol", role: "supporting", target: { file: proof.symbol.file, symbol: proof.symbol.name } } as ProposedCheck);
  if (draft.until) checks.push({ kind: "until", role: "complete", target: draft.until } as ProposedCheck);
  // Trial: "enable rule X". Its check says the config doesn't name the rule yet; once the team enables it the linter
  // enforces the lesson, the check fails and the suggestion is withheld.
  if (proof.lint && !proven) {
    checks.push({ kind: "pattern", role: "complete", target: { scope: proof.lint.config, pattern: proof.lint.rule, match: "literal", expect: "exact" }, saw: { count: 0 } } as ProposedCheck);
  }
  if (!checks.length) return { dropped: "no check could hold it" };

  const first = primary(cluster);
  const ref = cluster.source === "docs" ? first.path ?? first.link : pullLink(reviews[0] ?? first) ?? first.link;
  const sourceType = cluster.source === "docs" ? "docs" : "review";
  const kept = keptQuote(proof);
  const lint = proof.lint && !proven ? [`This repo's linter can enforce it: enable \`${proof.lint.rule}\` in \`${proof.lint.config}\`.`] : [];
  const alternatives = proof.alternatives.map(item => `Considered and ruled out: ${item.option} (${item.reason}).`);
  // R6: a pattern still common at HEAD is a migration in progress. Say so, or the agent sees the old code and copies it.
  const migration = stored.some(item => item.migration) ? ["Older code here still does this; don't add more."] : [];
  const text = [proof.claim, ...proof.reasons, ...migration, ...lint, ...alternatives].join(" ").slice(0, 1000);
  const fixKinds = new Set(["rule", "pitfall", "decision"]);
  // R19: repeated support from one reviewer is that person's habit until the code proves it, a doc agrees, or a
  // person ticks it, so it waits for the tick rather than reaching sessions on support alone.
  const corroborated = cluster.decision === "write" && (cluster.source !== "review" || cluster.reviewers >= 2 || docs.length > 0);
  const status = learnedStatus(cluster.waiting, corroborated, proven, proof.notAlwaysFollowed);
  const key = JSON.stringify([plan.host, plan.slug.toLowerCase(), "lesson", cluster.key]);
  const proposal: Proposal = {
    producer: "learn-deeper", ...(cluster.earlier ? { id: cluster.earlier } : { key }),
    kind: draft.kind as Proposal["kind"], text, oneLine: proof.claim.slice(0, KNOWLEDGE_LIMITS.oneLineCharacters),
    ...(draft.aliases.length ? { aliases: draft.aliases } : {}),
    ...(proof.fix && fixKinds.has(draft.kind) ? { fix: proof.fix } : {}),
    source: { type: sourceType, ref, ...(kept ? { quote: kept.quote, text: kept.text } : {}) },
    evidenceClass: sourceType, evidence: members.map(candidate => candidate.id).slice(0, 32),
    anchors: { scope: proof.scope, ...(when.length ? { when: when.map(({ type, match, pattern }) => ({ type, match, pattern })) } : {}) },
    checks, model, label: `${label(cluster)}${migration.length ? " · migration in progress" : ""}`.slice(0, 80), status,
  };
  return { proposal, sources: members, status, proven };
}
