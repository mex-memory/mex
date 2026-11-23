/**
 * Prove: nothing a writer says is kept on its word.
 *
 * - Every clause must quote its evidence verbatim; a clause that doesn't is removed, and an entry whose
 *   claim isn't supported is dropped.
 * - A `when:` pattern is kept only if the native matcher (the one delivery uses) finds it in the code a
 *   reviewer objected to in at least one before/after pair, in no fixed code at all, not in the writer's
 *   own "ok" example, and not already common in its area at HEAD. One counter-example is enough to reject.
 *   A team lesson seen in 2+ PRs keeps a pattern that is common at HEAD, labelled as a migration in
 *   progress: the speed bump fires only on edits that add an occurrence.
 *   A pattern that is only one common English word, with no identifier in it, is not evidence.
 * - History replay, at $0: later commits on the default branch that added the anti-pattern anyway are
 *   counted; a lesson the team didn't follow loses its pattern (one PR) or starts unticked (2+ PRs).
 * - Scopes, symbols and the fix range are checked against today's tree and the evidence.
 * A pattern that fails stays out: the entry is still useful as prose, and a weak pattern is never shipped.
 */
import { globToRegExp } from "../file-index/glob.js";
import { checkPatterns, type PatternCandidate } from "../knowledge/pattern-check.js";
import type { GateContext } from "../knowledge/gate.js";
import { sanitizeText } from "../knowledge/gates.js";
import { references, type References } from "../knowledge/references.js";
import { backedBy, writerMembers, type Cluster, type Triaged } from "./cluster.js";
import { command, type PatternStage, type PinnedTree } from "./git.js";
import { contrastive, safePath } from "./harvest/evidence.js";
import type { Candidate } from "./harvest/types.js";
import { polarityMismatch, squash, unclippedQuote } from "./lesson-text.js";
import { evidencePairs, type EvidencePair, type WriterEntry } from "./write.js";

export const PROOF_LIMITS = {
  /** Later commits that added an anti-pattern before a lesson counts as not followed. */
  historyAdds: 2,
  historyCommits: 300,
  historyBytes: 4 << 20,
  /** Lines of a fix snippet. */
  fixLines: 10,
} as const;

export type ProvenPattern = NonNullable<WriterEntry["when"]>[number] & {
  /** Indices into the cluster's evidence pairs the pattern was proven on. */
  pairs: number[];
  migration: boolean;
};
export interface ProvenFix { snippet: string; path: string; commit: string; lines: string }
export interface ProofResult {
  /** Only the members whose quotes back the claim: the rule's support, label and sources come from these. */
  cluster: Cluster;
  /** Members that back nothing the rule claims: they may hold a lesson of their own. */
  unbacked: Triaged[];
  draft: WriterEntry;
  pairs: EvidencePair[];
  /** The claim, and the clauses of the reason the evidence supports. */
  claim: string;
  reasons: string[];
  /** Quotes that survived, by clause, for the kept quote and the review list. */
  quotes: Array<{ id: string; quote: string }>;
  scope: string[];
  when: ProvenPattern[];
  symbol?: { file: string; name: string };
  fix?: ProvenFix;
  /** The literal the fix introduced, present in scope today: the fix target (R3). */
  fixLiteral?: string;
  /** Added occurrences of the anti-pattern in later commits (R18). */
  historyAdds: number;
  notAlwaysFollowed: boolean;
  /** Trial: a lesson an existing linter rule enforces, proposed as "enable rule X". */
  lint?: { config: string; rule: string };
  /** The options a decision beat, each with why it lost (trial: decision alternatives). */
  alternatives: Array<{ option: string; reason: string }>;
  /** Why parts were removed; sent back in the one repair turn. */
  failures: string[];
  dropped?: string;
}

export interface ProofContext {
  tree: PinnedTree;
  /** A staged copy of the pinned tree with a file index, for the native matcher's area check. */
  check: Pick<GateContext, "checkTree" | "checkIndex"> & { projectPath: string };
  patternStage?: PatternStage;
  /** Run the native matcher; tests pass a fake. */
  patterns?: typeof checkPatterns;
  /** Read the default branch's later history; tests pass a fake. */
  history?: (paths: readonly string[], since: string) => Promise<string | undefined>;
}

/** Every text a member's quotes may come from: its prose, PR text and the code regions it carries. */
function sources(candidate: Candidate): string[] {
  const code = candidate.code;
  const reland = candidate.related?.reland;
  return [candidate.text, candidate.prText, code?.before?.text, code?.after?.text, code?.head?.text, reland?.before.text, reland?.after.text]
    .filter((text): text is string => !!text).map(squash);
}

type Citation = WriterEntry["clauses"][number]["quotes"][number];

export interface ProofJudgment {
  supportingQuotes: ReadonlySet<Citation>;
  sameEarlier: boolean;
}

/** Only a verbatim, complete quote with compatible explicit polarity can be judged. */
export function quoteChecks(draft: WriterEntry, cluster: Cluster) {
  const byId = new Map(cluster.members.map(({ candidate }) => [candidate.id, sources(candidate)]));
  return draft.clauses.map(clause => ({
    clause,
    citations: clause.quotes.map(citation => {
      const quote = squash(citation.quote);
      const cited = quote.length >= 4 ? (byId.get(citation.id) ?? []).filter(text => text.includes(quote)) : [];
      const eligible = !polarityMismatch(clause.text, quote) && cited.some(text => unclippedQuote(quote, text));
      return { citation, found: cited.length > 0, question: eligible ? { clause: clause.text, quote } : undefined };
    }),
  }));
}

const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/u).filter(word => word.length > 2));
function overlap(a: string, b: string): number {
  const x = words(a), y = words(b);
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return x.size && y.size ? shared / Math.min(x.size, y.size) : 0;
}

function scopeMatches(tree: PinnedTree, glob: string): boolean {
  let pattern: RegExp;
  try { pattern = globToRegExp(glob); } catch { return false; }
  for (const path of tree.paths()) if (pattern.test(path)) return true;
  return false;
}

export function patternScopeCoverage(tree: Pick<PinnedTree, "paths">, scope: readonly string[], stage?: PatternStage) {
  const globs = scope.map(globToRegExp);
  let files = 0;
  const unread: string[] = [];
  for (const path of tree.paths()) {
    if (!globs.some(glob => glob.test(path)) || stage?.binary.has(path)) continue;
    files++;
    if (stage && !stage.readable.has(path)) unread.push(path);
  }
  return { files, unread };
}

function unreadScopeFailure(unread: readonly string[]): string {
  // Keep the repair input bounded and never copy a withheld path into it.
  const examples = unread.filter(safePath).slice(0, 8);
  const remaining = unread.length - examples.length;
  const list = [...examples.map(path => JSON.stringify(path)), ...(remaining ? [`${remaining} other`] : [])];
  return `HEAD scope is unknown. Could not read ${unread.length} scoped ${unread.length === 1 ? "file" : "files"} (${list.join(", ")}). Narrow the scope around unread files or remove the pattern.`;
}

/** The common folder of some paths, as a glob ("packages/api/**"), or undefined at the root. */
export function commonFolder(paths: readonly string[]): string | undefined {
  const folders = paths.map(path => path.split("/").slice(0, -1));
  if (!folders.length || folders.some(parts => !parts.length)) return undefined;
  const common: string[] = [];
  for (let i = 0; folders.every(parts => parts[i] !== undefined && parts[i] === folders[0]![i]); i++) common.push(folders[0]![i]!);
  return common.length ? `${common.join("/")}/**` : undefined;
}

const PROCESS_WORDS = /\b(?:git|branch(?:es)?|commit(?: message)?s?|pull request|PR (?:title|description|text|body)|changelog|release(?: notes)?|version(?:ing| bump)?|tag|squash|rebase|merge|before pushing|push|CI|pipeline|sign[- ]off|DCO|semantic|conventional)\b/iu;

/** A process rule's label is confirmed by its words; otherwise it is routed as scoped prose. */
export function processConfirmed(entry: Pick<WriterEntry, "claim" | "why">): boolean {
  return PROCESS_WORDS.test(`${entry.claim} ${entry.why}`);
}

function fixMarkers(snippet: string, before: string): string[] {
  const old = new Set(before.split("\n").map(line => line.trim()));
  const lines = [...new Set(snippet.split("\n").map(line => line.trim()))]
    .filter(line => line.length >= 4 && line.length <= 512 && /[A-Za-z_$][\w$]{2}/u.test(line));
  // Keep enough of the fixed line to identify it even when another caller
  // of the same API remains. A deletion can use its surviving context.
  const added = lines.filter(line => !old.has(line));
  return added.length ? added : lines;
}

/** The speed bump stops rules on anti and decisions on rejected. */
export function stoppingType(draft: Pick<WriterEntry, "kind" | "route">): "anti" | "rejected" | undefined {
  if (draft.route === "code-rule" && draft.kind === "rule") return "anti";
  if ((draft.route === "ruled-out" || draft.route === "decision") && draft.kind === "decision") return "rejected";
  return undefined;
}

function fixFrom(draft: WriterEntry, pairs: readonly EvidencePair[]): ProvenFix | string {
  if (!draft.fix) return "no fix range given";
  const pair = pairs[draft.fix.pair];
  if (!pair) return `fix pair ${draft.fix.pair} doesn't exist`;
  const { start, end } = draft.fix;
  const region = pair.after;
  if (start < region.start || end > region.end || end < start || end - start >= PROOF_LIMITS.fixLines) {
    return `fix lines ${start}-${end} are outside the after code (${region.start}-${region.end}) or longer than ${PROOF_LIMITS.fixLines} lines`;
  }
  const lines = region.text.split("\n").slice(start - region.start, end - region.start + 1);
  const snippet = lines.join("\n");
  if (!snippet.trim()) return "the fix range is blank";
  if (snippet.length > 800) return "the fix range is longer than 800 characters";
  return { snippet, path: region.path, commit: region.commit, lines: `${start}-${end}` };
}

/** Git pathspecs for scope globs; "**" means the whole tree. */
function pathspecs(scope: readonly string[]): string[] {
  return scope.includes("**") ? ["."] : scope.map(glob => `:(glob)${glob}`);
}

/** Count later commits whose added lines contain a literal, from `git log -p -U0` output. */
export function addedOccurrences(log: string, literal: string): number {
  let count = 0, inCommit = false, found = false;
  for (const line of log.split("\n")) {
    if (line.startsWith("\u0000commit ")) {
      if (found) count++;
      inCommit = true; found = false;
      continue;
    }
    if (inCommit && !found && line.startsWith("+") && !line.startsWith("+++") && line.includes(literal)) found = true;
  }
  return count + (found ? 1 : 0);
}

export function gitHistory(tree: PinnedTree) {
  return (paths: readonly string[], since: string) => command(tree.root, "git", ["log", "--no-color", "--no-ext-diff", "--no-textconv",
    `--max-count=${PROOF_LIMITS.historyCommits}`, `--since=${since}`, "--format=%x00commit %H", "-p", "-U0", tree.head, "--", ...paths],
  undefined, PROOF_LIMITS.historyBytes, 20_000);
}

/** Prove one writer entry against its cluster's evidence and today's tree. */
export async function proveEntry(draft: WriterEntry, cluster: Cluster, context: ProofContext, judgment?: ProofJudgment): Promise<ProofResult> {
  const failures: string[] = [];
  const members = new Map(cluster.members.map((member: Triaged) => [member.candidate.id, member.candidate]));
  const shown = writerMembers(cluster);
  const pairs = evidencePairs([...shown, ...cluster.members.filter(member => !shown.includes(member))]);
  const result: ProofResult = { cluster, unbacked: [], draft, pairs, claim: draft.claim, reasons: [], quotes: [], scope: [], when: [], historyAdds: 0,
    notAlwaysFollowed: false, alternatives: [], failures };
  const drop = (why: string) => ({ ...result, dropped: why });

  const supported = quoteChecks(draft, cluster).map(({ clause, citations }) => {
    const quotes = citations.filter(({ citation, question }) => question && judgment?.supportingQuotes.has(citation))
      .map(({ citation }) => citation);
    const missing = citations.filter(({ found }) => !found).length;
    const label = `clause "${clause.text.slice(0, 80)}"`;
    if (missing) failures.push(`${label}: ${missing} quote(s) not found in the cited evidence`);
    const unsupported = citations.length - quotes.length - missing;
    if (unsupported) failures.push(`${label}: ${unsupported} quote(s) don't support it`);
    return { clause, quotes };
  });
  let unquoted = squash(draft.claim);
  const claimClauses: typeof supported = [];
  for (const item of supported) {
    if (!unquoted) break;
    const { clause } = item;
    const text = squash(clause.text).replace(/[.!?,;:]$/u, "");
    if (!text || !unquoted.startsWith(text) || !/^[\s.!?,;:]?$/u.test(unquoted[text.length] ?? "")) break;
    claimClauses.push(item);
    unquoted = unquoted.slice(text.length).replace(/^[\s.!?,;:]+/u, "");
  }
  // A PR must independently support the whole instruction before it adds support.
  const backing = new Set([...members.keys()].filter(id => claimClauses.every(item => item.quotes.some(quote => quote.id === id))));
  if (!claimClauses.length || unquoted || !backing.size) {
    failures.push("the claim isn't supported by a verbatim quote");
    return drop("the claim isn't supported by a verbatim quote");
  }
  result.quotes = claimClauses.flatMap(item => item.quotes.filter(quote => backing.has(quote.id)));
  result.unbacked = cluster.members.filter(member => !backing.has(member.candidate.id));
  cluster = backedBy(cluster, backing, judgment?.sameEarlier === true);
  result.cluster = cluster;
  if (cluster.decision === "drop") return drop("one pull request without a strong signal backs the claim");
  // Rebuild the reason from verified source clauses so a model-only explanation cannot reach delivery.
  const reasons = supported.filter(item => !claimClauses.includes(item) && item.quotes.some(quote => backing.has(quote.id)) &&
    overlap(item.clause.text, draft.claim) < 0.9);
  result.reasons = reasons.map(item => item.clause.text);
  result.quotes.push(...reasons.flatMap(item => item.quotes.filter(quote => backing.has(quote.id))));

  // Post-filters: a restated PR title or commit subject adds nothing.
  for (const candidate of members.values()) {
    if (candidate.title && overlap(candidate.title, draft.claim) >= 0.9 && words(draft.claim).size <= words(candidate.title).size + 2) {
      return drop("it restates a PR title");
    }
  }
  // "Ruled out" and issue lessons need contrastive wording from a maintainer and a resolvable anchor.
  const cited = cluster.members.map(member => member.candidate);
  const ruledOut = draft.route === "ruled-out" || cited.every(candidate => candidate.kind === "issue" || candidate.kind === "closed-pr");
  if (ruledOut && !cited.some(candidate => candidate.reviewers.length > 0 && contrastive(`${candidate.text} ${candidate.prText ?? ""}`))) {
    return drop("a ruled-out lesson needs a maintainer's contrastive reason");
  }

  // Scope: today's files only. Process rules are repo-wide once their words confirm it.
  if (draft.route === "process-rule" && processConfirmed({ claim: result.claim, why: result.reasons.join(" ") })) result.scope = ["**"];
  else {
    if (draft.route === "process-rule") failures.push("routed as scoped prose: its words don't read as a process rule");
    const valid = draft.scope.filter(glob => glob !== "**" && !glob.startsWith("/") && !glob.includes("..") && scopeMatches(context.tree, glob));
    if (valid.length < draft.scope.filter(glob => glob !== "**").length) failures.push("some scope globs match no file today");
    const changed = [...new Set(cited.flatMap(candidate => candidate.path ? [candidate.path] : candidate.changedPaths ?? []))]
      .filter(path => safePath(path) && context.tree.has(path));
    const folder = commonFolder(changed);
    result.scope = [...new Set(valid.length ? valid : folder ? [folder] : changed.slice(0, 12))];
    if (!result.scope.length) return drop("nothing today for it to govern");
  }

  if (draft.symbol) {
    const text = await context.tree.read(draft.symbol.file);
    const name = draft.symbol.name.split(".").at(-1)!;
    if (text && new RegExp(`\\b${name.replace(/[$]/gu, "\\$")}\\b`, "u").test(text)) result.symbol = draft.symbol;
    else failures.push(`symbol ${draft.symbol.name} isn't in ${draft.symbol.file} today`);
  }

  // Patterns: the contrast test on every pair, the writer's own examples, and the area at HEAD.
  const stop = stoppingType(draft);
  const wanted = draft.when.filter(item => item.type === stop || stop && item.type === "required");
  if (wanted.length !== draft.when.length) failures.push("some patterns cannot stop edits for this entry kind");
  const proofPairs = pairs.map((pair, at) => ({ pair, at })).filter(({ pair }) => backing.has(pair.member));
  const coverage = wanted.some(item => item.type === stop) && context.check.checkTree && context.check.checkIndex
    ? patternScopeCoverage(context.tree, result.scope, context.patternStage) : undefined;
  if (coverage?.unread.length) failures.push(unreadScopeFailure(coverage.unread));
  const run = context.patterns ?? checkPatterns;
  if (wanted.some(item => item.type === stop) && !coverage?.unread.length && result.scope[0] !== "**") {
    const scope = result.scope.map(globToRegExp);
    const example = draft.examples;
    const inScope = proofPairs.length > 0 && proofPairs.every(({ pair }) => scope.some(glob => glob.test(pair.after.path)));
    const exactScope = result.scope.every(glob => !/[*?\[\]{}]/u.test(glob));
    const tested = wanted.flatMap(item => {
      const label = item.type + " " + JSON.stringify(item.pattern);
      if (!inScope) {
        failures.push(label + " needs reviewed code inside its edit scope");
        return [];
      }
      if (item.type === stop && item.match === "structural" && !exactScope) {
        failures.push(label + " needs exact files so its count can be checked again");
        return [];
      }
      if (!example?.flag || !example.ok) {
        failures.push(label + " needs a flag and an ok example");
        return [];
      }
      const candidates: PatternCandidate[] = proofPairs.map(({ pair }) => ({
        ...item, objected: pair.before.text, fixed: pair.after.text, ...(pair.anchor ? { anchor: pair.anchor } : {}),
      }));
      candidates.push({ ...item, objected: example.flag, fixed: example.ok });
      return [{ item, label, candidates }];
    });
    // Each request reads the whole scope once.
    const outcomes = tested.length ? run(tested.flatMap(test => test.candidates), result.scope, context.check) : undefined;
    const stride = proofPairs.length + 1;
    for (const [i, { item, label }] of tested.entries()) {
      const contrast = outcomes?.slice(i * stride, i * stride + stride - 1);
      const sample = outcomes?.[i * stride + stride - 1];
      if (!sample || !contrast || contrast.length !== proofPairs.length) {
        failures.push("the pattern check couldn't run");
        continue;
      }
      if (!(sample.keep || sample.common)) {
        failures.push(label + (sample.reason.includes("still matches") ? ' matches its own "ok" example' : " does not separate its flag and ok examples"));
        continue;
      }
      const miss = contrast.findIndex(verdict => !verdict.keep && !verdict.common);
      if (miss >= 0) {
        const reason = contrast[miss]!.reason;
        failures.push(label + (reason.includes("still matches") ? " matches the fixed code of pair " : " failed contrast on pair ") + proofPairs[miss]!.at + ". " + reason);
        continue;
      }
      if (item.type !== "required" && coverage && contrast.some(verdict => verdict.files !== coverage.files)) {
        failures.push(label + " could not be checked in all " + coverage.files + " scoped files at HEAD. Narrow the scope.");
        continue;
      }
      const common = contrast.find(verdict => verdict.common);
      if (common && cluster.support < 2) {
        failures.push(label + " is " + common.reason + ". Narrow the scope or remove this pattern.");
        continue;
      }
      const fixPair = draft.fix?.pair;
      const ordered = proofPairs.map(({ at }) => at);
      if (fixPair !== undefined && ordered.includes(fixPair)) {
        ordered.splice(ordered.indexOf(fixPair), 1);
        ordered.unshift(fixPair);
      }
      result.when.push({ ...item, pairs: ordered.slice(0, 3), migration: common !== undefined });
    }
  }

  // History replay: did later commits add the anti-pattern anyway?
  const replayed = result.when.filter(item => item.type !== "required" && item.match === "literal");
  if (replayed.length) {
    const since = cluster.members.map(member => member.candidate.at).sort().at(-1)!;
    const log = await (context.history ?? gitHistory(context.tree))(pathspecs(result.scope), since);
    if (log !== undefined) {
      result.historyAdds = Math.max(...replayed.map(item => addedOccurrences(log, item.pattern)));
      if (result.historyAdds > PROOF_LIMITS.historyAdds) {
        if (cluster.support < 2) {
          failures.push(`later commits added the anti-pattern ${result.historyAdds} times: the team doesn't hold to it`);
          result.when = result.when.filter(item => item.type === "required");
        } else result.notAlwaysFollowed = true;
      }
    }
  }
  if (!result.when.some(item => item.type === stop)) result.when = [];

  // A stop needs a fix the next edit can still use. Pin its own file,
  // rather than searching a package for another use of the same API.
  if (result.when.length) {
    const pair = draft.fix && pairs[draft.fix.pair];
    const fix = pair && !backing.has(pair.member)
      ? "the fix comes from evidence that doesn't back the claim" : fixFrom(draft, pairs);
    if (typeof fix === "string") failures.push(fix);
    else if (pair) {
      const head = await context.tree.read(fix.path);
      if (head !== undefined) {
        for (const pattern of fixMarkers(fix.snippet, pair.before.text)) {
          if (!head.includes(pattern)) continue;
          const target = { type: "required", match: "literal", pattern, objected: "", fixed: head } as const;
          if (run([target], [], context.check)?.[0]?.keep) {
            result.fix = fix;
            result.fixLiteral = pattern;
            break;
          }
        }
      }
    }
    if (result.when.length && (!result.fixLiteral || !result.when.some(item => item.type === stop && item.pairs.includes(draft.fix?.pair ?? -1)))) {
      failures.push("the fix needs a target in its reviewed file today and a pair that proves the stop");
      result.when = [];
    }
  }
  // Trial: a lesson the repo's linter already has a rule for becomes "enable rule X", unless it's already enabled.
  if (draft.lint) {
    const config = await context.tree.read(draft.lint.config);
    if (config === undefined) failures.push(`the linter config ${draft.lint.config} isn't in the repo`);
    else if (config.includes(draft.lint.rule)) return drop(`the linter config already names ${draft.lint.rule}`);
    else result.lint = draft.lint;
  }
  // An untested alternative may explain a decision. Only an ordinary
  // rejected pattern with a contrasting code pair can stop edits.
  for (const alternative of draft.alternatives ?? []) {
    if ((draft.route === "decision" || draft.route === "ruled-out") &&
        cited.some(candidate => [candidate.text, candidate.prText ?? ""].some(source =>
          squash(source).toLowerCase().split(/[.!?;](?=\s|$)/u).some(statement =>
            /\b(?:ruled out|decided against|rejected)\b/u.test(statement) &&
            statement.includes(squash(alternative.option).toLowerCase()) &&
            statement.includes(squash(alternative.reason).toLowerCase()))))) {
      result.alternatives.push({ option: alternative.option, reason: alternative.reason });
    }
  }
  // The gate saves no learned text it would have to change. Found here, the repair turn can still say it plainly.
  const refs = referencesOf(context);
  const links = new Set([...refs.links, ...[...members.values()].map(candidate => candidate.link)]);
  const said = [result.claim, ...result.reasons, ...result.alternatives.flatMap(item => [item.option, item.reason])];
  if (said.some(text => sanitizeText(text, { ...refs, links }) !== text)) {
    failures.push("the text has a link, or a command this repository doesn't have; say it in plain words");
  }
  return result;
}

const referenceCache = new WeakMap<ProofContext, References>();
function referencesOf(context: ProofContext): References {
  let refs = referenceCache.get(context);
  // The repository the gate will read. The staged copy is a partial tree the
  // pattern check deletes as soon as the proof returns, so it is the wrong place
  // to look up this repo's scripts and links.
  if (!refs) referenceCache.set(context, refs = references(context.tree.root));
  return refs;
}
