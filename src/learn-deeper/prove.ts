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
 * - History replay, at $0: later commits on the default branch that added the anti-pattern anyway are
 *   counted; a lesson the team didn't follow loses its pattern (one PR) or starts unticked (2+ PRs).
 * - Scopes, symbols and the fix range are checked against today's tree and the evidence.
 * A pattern that fails stays out: the entry is still useful as prose, and a weak pattern is never shipped.
 */
import { globToRegExp } from "../file-index/glob.js";
import { checkPatterns, type PatternCandidate, type PatternVerdict } from "../knowledge/pattern-check.js";
import type { GateContext } from "../knowledge/gate.js";
import { writerMembers, type Cluster, type Triaged } from "./cluster.js";
import { command, type PinnedTree } from "./git.js";
import type { Candidate } from "./harvest/types.js";
import { evidencePairs, type EvidencePair, type WriterEntry } from "./write.js";

export const PROOF_LIMITS = {
  /** Later commits that added an anti-pattern before a lesson counts as not followed. */
  historyAdds: 2,
  historyCommits: 300,
  historyBytes: 4 << 20,
  /** Lines of a fix snippet. */
  fixLines: 10,
  /** Files read at HEAD when looking for the fix's identifying literal. */
  fixFiles: 400,
  minLiteral: 4,
  /** Match the native request limit even when a cluster has several proof pairs. */
  nativeCandidates: 64,
} as const;

export type ProvenPattern = NonNullable<WriterEntry["when"]>[number] & {
  /** Indices into the cluster's evidence pairs the pattern was proven on. */
  pairs: number[];
  migration: boolean;
};
export interface ProvenFix { snippet: string; path: string; commit: string; lines: string }
export interface ProofResult {
  cluster: Cluster;
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
  /** Run the native matcher; tests pass a fake. */
  patterns?: typeof checkPatterns;
  /** Read the default branch's later history; tests pass a fake. */
  history?: (paths: readonly string[], since: string) => Promise<string | undefined>;
}

const squash = (text: string) => text.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();

/** Every text a member's quotes may come from: its prose, PR text and the code regions it carries. */
function sources(candidate: Candidate): string[] {
  const code = candidate.code;
  const reland = candidate.related?.reland;
  return [candidate.text, candidate.prText, code?.before?.text, code?.after?.text, code?.head?.text, reland?.before.text, reland?.after.text]
    .filter((text): text is string => !!text).map(squash);
}

function contrastive(text: string): boolean {
  return /\b(?:instead|we decided|decided against|won't|will not|not going to|rather than|ruled out|rejected|reverted because|we don't|we do not)\b/iu.test(text);
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

function literalCandidates(snippet: string, before: string): string[] {
  const found: string[] = [];
  const add = (literal: string) => {
    if (literal.length >= PROOF_LIMITS.minLiteral && !before.includes(literal) && !found.includes(literal)) found.push(literal);
  };
  for (const match of snippet.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/gu)) add(`${match[1]}${match[2]}${match[1]}`);
  for (const match of snippet.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/gu)) {
    const name = match[1]!;
    if (!/^(?:if|for|while|switch|return|function|catch|typeof|await|new|super|print)$/u.test(name)) add(`${name}(`);
  }
  return found;
}

/** True when the literal is in scope today; undefined when the scope was too large to read in full. */
async function presentInScope(tree: PinnedTree, scope: readonly string[], literal: string): Promise<boolean | undefined> {
  const patterns = scope.map(glob => { try { return globToRegExp(glob); } catch { return undefined; } }).filter(Boolean) as RegExp[];
  let read = 0;
  for (const path of tree.paths()) {
    if (!patterns.some(pattern => pattern.test(path))) continue;
    if (++read > PROOF_LIMITS.fixFiles) return undefined;
    if ((await tree.read(path))?.includes(literal)) return true;
  }
  return false;
}

const MANIFESTS = ["**/package.json", "**/go.mod", "**/requirements*.txt", "**/pyproject.toml", "**/Cargo.toml", "**/Gemfile", "**/pom.xml", "**/build.gradle*"];

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
export async function proveEntry(draft: WriterEntry, cluster: Cluster, context: ProofContext): Promise<ProofResult> {
  const failures: string[] = [];
  const members = new Map(cluster.members.map((member: Triaged) => [member.candidate.id, member.candidate]));
  const shown = writerMembers(cluster);
  const pairs = evidencePairs([...shown, ...cluster.members.filter(member => !shown.includes(member))]);
  const result: ProofResult = { cluster, draft, pairs, claim: draft.claim, reasons: [], quotes: [], scope: [], when: [], historyAdds: 0,
    notAlwaysFollowed: false, alternatives: [], failures };
  const drop = (why: string) => ({ ...result, dropped: why });

  // Clause provenance: quotes must be found verbatim (whitespace aside) in their own member.
  const supported = draft.clauses.map(clause => {
    const quotes = clause.quotes.filter(({ id, quote }) => {
      const candidate = members.get(id);
      const needle = squash(quote);
      return !!candidate && needle.length >= 4 && sources(candidate).some(text => text.includes(needle));
    });
    if (quotes.length < clause.quotes.length) failures.push(`clause "${clause.text.slice(0, 80)}": ${clause.quotes.length - quotes.length} quote(s) not found in the cited evidence`);
    return { clause, quotes };
  });
  const claimText = squash(draft.claim);
  const claimClauses = supported.filter(({ clause }) => {
    const text = squash(clause.text).replace(/[.!?,;:]$/u, "");
    return text.length > 0 && claimText.includes(text);
  });
  const covered = words(claimClauses.map(item => item.clause.text).join(" "));
  if (!claimClauses.length || claimClauses.some(item => !item.quotes.length) || [...words(draft.claim)].some(word => !covered.has(word))) {
    failures.push("the claim isn't supported by a verbatim quote");
    return drop("the claim isn't supported by a verbatim quote");
  }
  result.quotes = supported.flatMap(item => item.quotes);
  // Rebuild the reason from verified source clauses so a model-only explanation cannot reach delivery.
  result.reasons = supported.filter(item => !claimClauses.includes(item) && item.quotes.length && overlap(item.clause.text, draft.claim) < 0.9)
    .map(item => item.clause.text);

  // Post-filters: a restated PR title or commit subject adds nothing.
  for (const candidate of members.values()) {
    if (candidate.title && overlap(candidate.title, draft.claim) >= 0.9 && words(draft.claim).size <= words(candidate.title).size + 2) {
      return drop("it restates a PR title");
    }
  }
  // "Ruled out" and issue lessons need contrastive wording from a maintainer and a resolvable anchor.
  const ruledOut = draft.route === "ruled-out" || [...members.values()].every(candidate => candidate.kind === "issue" || candidate.kind === "closed-pr");
  if (ruledOut && ![...members.values()].some(candidate => candidate.reviewers.length > 0 && contrastive(`${candidate.text} ${candidate.prText ?? ""}`))) {
    return drop("a ruled-out lesson needs a maintainer's contrastive reason");
  }

  // Scope: today's files only. Process rules are repo-wide once their words confirm it.
  if (draft.route === "process-rule" && processConfirmed({ claim: result.claim, why: result.reasons.join(" ") })) result.scope = ["**"];
  else {
    if (draft.route === "process-rule") failures.push("routed as scoped prose: its words don't read as a process rule");
    const valid = draft.scope.filter(glob => glob !== "**" && !glob.startsWith("/") && !glob.includes("..") && scopeMatches(context.tree, glob));
    if (valid.length < draft.scope.filter(glob => glob !== "**").length) failures.push("some scope globs match no file today");
    const changed = [...members.values()].flatMap(candidate => candidate.path ? [candidate.path] : candidate.changedPaths ?? []);
    const fallback = commonFolder(changed.filter(path => context.tree.has(path)));
    const doc = [...members.values()].find(candidate => (candidate.kind === "doc" || candidate.kind === "adr") && candidate.path && context.tree.has(candidate.path))?.path;
    result.scope = valid.length ? valid : fallback ? [fallback] : doc ? [doc] : [];
    if (!result.scope.length) return drop("nothing today for it to govern");
  }

  if (draft.symbol) {
    const text = await context.tree.read(draft.symbol.file);
    const name = draft.symbol.name.split(".").at(-1)!;
    if (text && new RegExp(`\\b${name.replace(/[$]/gu, "\\$")}\\b`, "u").test(text)) result.symbol = draft.symbol;
    else failures.push(`symbol ${draft.symbol.name} isn't in ${draft.symbol.file} today`);
  }

  // Patterns: the contrast test on every pair, the writer's own examples, and the area at HEAD.
  const codeRoutes = new Set(["code-rule", "ruled-out", "pitfall"]);
  if (draft.when.length && !codeRoutes.has(draft.route)) failures.push(`a ${draft.route} carries no edit pattern`);
  const wanted = codeRoutes.has(draft.route) ? draft.when : [];
  if (wanted.length && !pairs.length) failures.push("no before/after code to prove a pattern on");
  if (wanted.length && pairs.length && result.scope[0] !== "**") {
    const run = context.patterns ?? checkPatterns;
    const candidates: PatternCandidate[] = [];
    const owner: Array<{ pattern: number; pair: number | "example"; probe?: true }> = [];
    const proofPairs = pairs;
    for (const [i, item] of wanted.entries()) {
      for (const [p, pair] of proofPairs.entries()) {
        candidates.push({ ...item, objected: pair.before.text, fixed: pair.after.text, ...(pair.anchor ? { anchor: pair.anchor } : {}) });
        owner.push({ pattern: i, pair: p });
        // The contrast check stops at the first miss, so a pattern that misses this pair's reviewed code
        // was never tested on its fixed code. A probe asks only "does it occur here?" on the other side.
        candidates.push({ type: "anti", match: item.match, pattern: item.pattern, objected: item.type === "required" ? pair.before.text : pair.after.text, fixed: "" });
        owner.push({ pattern: i, pair: p, probe: true });
      }
      if (draft.examples?.flag && draft.examples.ok) {
        candidates.push({ ...item, objected: item.type === "required" ? draft.examples.ok : draft.examples.flag,
          fixed: item.type === "required" ? draft.examples.flag : draft.examples.ok });
        owner.push({ pattern: i, pair: "example" });
      }
    }
    const verdicts: Array<PatternVerdict | undefined> = [];
    for (let i = 0; i < candidates.length; i += PROOF_LIMITS.nativeCandidates) {
      const batch = candidates.slice(i, i + PROOF_LIMITS.nativeCandidates);
      const outcomes = run(batch, result.scope, context.check);
      verdicts.push(...batch.map((_, at) => outcomes?.[at]));
    }
    if (!verdicts.some(Boolean)) failures.push("the pattern check couldn't run");
    for (const [i, item] of wanted.entries()) {
      const mine = owner.flatMap((o, k) => o.pattern === i ? [{ ...o, verdict: verdicts[k] }] : []);
      const real = mine.filter(o => o.pair !== "example" && !o.probe);
      const occurs = (reason: string | undefined) => reason !== undefined && !/doesn't match the code the reviewer objected to|doesn't compile/u.test(reason);
      const counter = real.find(o => /still matches the fixed code|already had it/u.test(o.verdict?.reason ?? ""))
        ?? mine.find(o => o.probe && occurs(o.verdict?.reason));
      const example = mine.find(o => o.pair === "example");
      const exampleCounter = example && /still matches the fixed code|already had it/u.test(example.verdict?.reason ?? "");
      const common = real.filter(o => /^already in \d+ of/u.test(o.verdict?.reason ?? ""));
      const proven = real.filter(o => o.verdict?.keep || /^already in \d+ of/u.test(o.verdict?.reason ?? ""));
      const label = `${item.type} ${JSON.stringify(item.pattern)}`;
      if (!mine.some(item => item.verdict)) continue;
      if (counter) {
        failures.push(item.type === "required" ? `${label} is already in the reviewed code of pair ${counter.pair}` : `${label} matches the fixed code of pair ${counter.pair}`);
        continue;
      }
      if (exampleCounter) { failures.push(`${label} matches its own "ok" example`); continue; }
      if (!example || !(example.verdict?.keep || /^already in \d+ of/u.test(example.verdict?.reason ?? ""))) {
        failures.push(`${label} does not separate its flag and ok examples`);
        continue;
      }
      if (proven.length !== real.length) {
        failures.push(`${label} isn't proven on every pair: ${[...new Set(real.map(o => o.verdict?.reason).filter(Boolean))].join("; ")}`);
        continue;
      }
      const migration = common.length > 0;
      if (migration && cluster.support < 2) { failures.push(`${label} is already common in its scope today: ${common[0]!.verdict!.reason}; narrow the scope`); continue; }
      result.when.push({ ...item, pairs: proven.map(o => o.pair as number).slice(0, 3), migration });
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
  if (!result.when.some(item => item.type !== "required")) result.when = [];

  // The fix: a verbatim slice of the after code, and the literal it relies on, present today.
  if (draft.route === "code-rule" || draft.fix) {
    const fix = fixFrom(draft, pairs);
    if (typeof fix === "string") { if (draft.fix || result.when.length) failures.push(fix); }
    else {
      result.fix = fix;
      const before = pairs.map(pair => pair.before.text).join("\n");
      for (const literal of literalCandidates(fix.snippet, before)) {
        if (await presentInScope(context.tree, result.scope, literal) === true) { result.fixLiteral = literal; break; }
      }
    }
  }
  if (draft.route === "code-rule" && result.when.length && !result.fixLiteral) {
    failures.push("the fix has no identifying literal in scope today");
    result.when = [];
  }
  // Trial: a lesson the repo's linter already has a rule for becomes "enable rule X", unless it's already enabled.
  if (draft.lint) {
    const config = await context.tree.read(draft.lint.config);
    if (config === undefined) failures.push(`the linter config ${draft.lint.config} isn't in the repo`);
    else if (config.includes(draft.lint.rule)) return drop(`the linter config already names ${draft.lint.rule}`);
    else result.lint = draft.lint;
  }
  // Trial: alternatives a decision beat. A rejected option still in use today isn't ruled out: the team may have changed course.
  if (draft.alternatives?.length && (draft.route === "decision" || draft.route === "ruled-out")) {
    for (const alternative of draft.alternatives) {
      result.alternatives.push({ option: alternative.option, reason: alternative.reason });
      const rejected = alternative.rejected;
      if (!rejected || rejected.match !== "literal" || rejected.pattern.length < PROOF_LIMITS.minLiteral) continue;
      const scopes = result.scope[0] === "**" ? ["**"] : [...result.scope, ...MANIFESTS];
      const present = await presentInScope(context.tree, scopes, rejected.pattern);
      if (present !== false) {
        failures.push(present ? `the alternative ${alternative.option} is in use today, so it isn't ruled out` : `couldn't confirm ${alternative.option} is unused today`);
        continue;
      }
      if (!result.when.some(item => item.type === "rejected" && item.pattern === rejected.pattern)) {
        result.when.push({ type: "rejected", match: "literal", pattern: rejected.pattern, pairs: [], migration: false });
      }
    }
  }
  return result;
}
