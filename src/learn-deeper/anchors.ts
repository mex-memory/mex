import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { buildIndex } from "../file-index/build.js";
import { globToRegExp } from "../file-index/glob.js";
import { observeProposalChecks, type GateContext, type Proposal, type ProposedCheck } from "../knowledge/gate.js";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import { checkPatterns, keptPatterns, type PatternCandidate, type WhenPattern } from "../knowledge/pattern-check.js";
import { anchorRequired } from "../knowledge/producers.js";
import { shortHash } from "../record/project.js";
import { anchorEvidence, codeSymbolFile, declaredCommands, MAX_SCOPE_FILES, scopePattern } from "./anchor-evidence.js";
import { object, type ForgeClient } from "./forge.js";
import type { PinnedTree } from "./git.js";
import { sourceDigest, type LearningSource, type Repository, type ReviewSource } from "./source.js";

const MAX_PATTERN_AREA = 64;
const MAX_HUNK_BYTES = 16 << 10;
const MAX_REVIEW_LINES = 16;

export interface QuotedSource { source: LearningSource; quote: string; }
export interface AnchorDraft {
  proposal: Proposal;
  citations: QuotedSource[];
  scope: string[];
  when: WhenPattern[];
}
export interface ReviewLines { objected: string; anchor: string; }
export type ReadReviewLines = (source: ReviewSource) => Promise<ReviewLines | undefined>;
export type CheckContext = Pick<GateContext, "checkTree" | "checkIndex">;
export const ANCHOR_KINDS = ["code-scope", "symbol", "command", "when", "repo-wide"] as const;
export type AnchorKind = typeof ANCHOR_KINDS[number];
export type AnchorResult = (Proposal & { anchorKinds: AnchorKind[] }) | "no-anchor" | "check-target" | "check-verification";

/** Bound and verify the exact inline comment that supplied the evidence. */
export async function githubReviewLines(client: ForgeClient, repo: Repository, source: ReviewSource): Promise<ReviewLines | undefined> {
  const id = /^github:discussion_r:([1-9]\d{0,21})$/u.exec(source.id)?.[1];
  if (!id || repo.host !== "github.com" || !source.writer || !source.path || source.topLevel) return undefined;
  const comment = object((await client.get(`/repos/${repo.slug}/pulls/comments/${id}`, true))?.value);
  if (comment?.html_url !== source.link || comment.path !== source.path
    || typeof comment.body !== "string" || sourceDigest(comment.body) !== source.hash
    || comment.subject_type === "file") return undefined;
  return extractReviewLines(comment.diff_hunk, comment.side, comment.original_start_line ?? comment.start_line,
    comment.original_line ?? comment.line, comment.start_side);
}

/** Read the review side of a GitHub hunk using the comment's original line coordinates. */
export function extractReviewLines(hunk: unknown, side: unknown, first: unknown, last: unknown, firstSide?: unknown): ReviewLines | undefined {
  if (typeof hunk !== "string" || Buffer.byteLength(hunk) > MAX_HUNK_BYTES || hasSecret(hunk)
    || /\0|<\s*\/?\s*private\b/iu.test(hunk) || stripHidden(hunk) !== hunk
    || (side !== "LEFT" && side !== "RIGHT") || (firstSide != null && firstSide !== side)) return undefined;
  const end = typeof last === "number" && Number.isSafeInteger(last) ? last : 0;
  const start = first == null ? end : typeof first === "number" && Number.isSafeInteger(first) ? first : 0;
  if (start < 1 || end < start || end - start >= MAX_REVIEW_LINES) return undefined;
  const [header, ...body] = hunk.replace(/\r\n/gu, "\n").trimEnd().split("\n");
  const ranges = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(header!);
  if (!ranges) return undefined;
  let line = Number(ranges[side === "LEFT" ? 1 : 2]);
  if (!Number.isSafeInteger(line)) return undefined;
  const objected: string[] = [], anchor: string[] = [];
  for (const raw of body) {
    if (raw === "\\ No newline at end of file") continue;
    const prefix = raw[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") return undefined;
    if (prefix === (side === "LEFT" ? "+" : "-")) continue;
    const code = raw.slice(1);
    objected.push(code);
    if (line >= start && line <= end) anchor.push(code);
    line++;
  }
  return anchor.length !== end - start + 1 || !anchor.join("").trim() ? undefined
    : { objected: objected.join("\n"), anchor: anchor.join("\n") };
}

type SymbolCheck = Extract<ProposedCheck, { kind: "symbol" }>;
type CommandCheck = Extract<ProposedCheck, { kind: "command" }>;
type CheckRequest = Parameters<typeof observeProposalChecks>[1];
const MAX_SYMBOL_LOOKUPS = 24;
const MAX_SYMBOL_FILES = 8;

function patternArea(tree: PinnedTree, scope: readonly string[]): string[] {
  const matches = scope.map(globToRegExp);
  const files: string[] = [];
  for (const path of tree.paths()) {
    if (matches.some(match => match.test(path))) files.push(path);
    if (files.length > MAX_PATTERN_AREA) break;
  }
  return files;
}

async function planAnchors(draft: AnchorDraft, tree: PinnedTree, lookups: Map<string, string[]>) {
  const evidence = anchorEvidence(draft, tree);
  const supplied = draft.proposal.checks ?? [];
  const codeFiles = [...new Set(evidence.scopes.flatMap(scope => scope.files))];
  const symbols = [];
  for (const { name, quoted } of evidence.symbols) {
    const leaf = name.split(".").at(-1)!;
    if (!lookups.has(leaf) && lookups.size < MAX_SYMBOL_LOOKUPS) {
      lookups.set(leaf, (await tree.filesMentioning(leaf)).filter(codeSymbolFile));
    }
    const found = lookups.get(leaf) ?? [];
    // An often-used name needs a file identified by the evidence.
    const possible = found.length <= MAX_SYMBOL_FILES ? found : [];
    const paths = [...new Set([...codeFiles.filter(codeSymbolFile), ...possible])].slice(0, MAX_SCOPE_FILES);
    const checks = paths.map((file): SymbolCheck => {
      const target = { file, symbol: name };
      const stated = supplied.find((check): check is SymbolCheck => check.kind === "symbol" && isDeepStrictEqual(check.target, target));
      return stated ?? { kind: "symbol", role: "supporting", target };
    });
    if (checks.length) symbols.push({ checks, quoted });
  }
  const suggested = [...new Set(draft.scope)].map(scopePattern).filter(pattern => pattern !== undefined);
  const files = [...codeFiles, ...evidence.docs, ...supplied.flatMap(check => "file" in check.target ? [check.target.file!] : [])];
  const when = draft.when.filter((item, i) => draft.when.findIndex(other => isDeepStrictEqual(other, item)) === i);
  let area: string[] = [];
  if (when.length && draft.citations.some(({ source }) => source.kind === "review" && source.writer && !source.topLevel && source.path)) {
    const eligible = [...evidence.quotedPaths, ...symbols.flatMap(symbol => symbol.quoted ? symbol.checks.map(check => check.target.file) : [])];
    const scopes = [...evidence.scopes.map(scope => scope.glob), ...suggested.filter(item => eligible.some(path => item.match.test(path))).map(item => item.glob)];
    if (scopes.length) area = patternArea(tree, scopes);
  }
  return { ...draft, evidence, symbols, supplied, suggested, files, when, area };
}

type AnchorPlan = Awaited<ReturnType<typeof planAnchors>>;

function verified<T extends SymbolCheck | CommandCheck>(checks: T[], request: CheckRequest): T[] {
  const seen = observeProposalChecks(checks, request);
  if (!seen || seen.length !== checks.length) return [];
  return checks.filter((wanted, i) => {
    const item = seen[i]!;
    return !("reason" in item) && item.check.kind === wanted.kind && item.check.role === wanted.role
      && isDeepStrictEqual(item.check.target, wanted.target)
      && (item.check.kind !== "command" || item.check.saw.exists);
  });
}

function commandChecks(plan: AnchorPlan, declared: ReturnType<typeof declaredCommands>): CommandCheck[] {
  const commands = declared.flatMap(({ check, script }) => {
    const { file, run } = check.target;
    const supplied = plan.supplied.find((item): item is CommandCheck => item.kind === "command" && isDeepStrictEqual(item.target, check.target));
    const named = plan.evidence.supports(run) || (file === "package.json" && script !== undefined
      && ([script + " script", "\x60" + script + "\x60 script", "script \x60" + script + "\x60"].some(plan.evidence.supports)
        || (supplied && plan.evidence.cites(script))));
    if (!named) return [];
    // For a bare script-name mention, keep one canonical spelling. Explicit
    // commands and a verified writer's matching check take precedence.
    if (supplied || plan.evidence.supports(run) || run.includes(" run ")) return [supplied ?? check];
    return [];
  });
  return commands.slice(0, MAX_SCOPE_FILES);
}

/**
 * Scope only from code the evidence names: cited paths and globs and verified symbol files. A command
 * check's manifest (`package.json`, a Makefile) is not the code a rule governs, so it never becomes scope.
 */
function codeScope(plan: AnchorPlan, staged: ReadonlySet<string>, checks: Array<SymbolCheck | CommandCheck>,
  quotedSymbolFiles: string[]): { scope: string[]; fromPaths: boolean } {
  const supported = [...plan.evidence.quotedPaths, ...quotedSymbolFiles].filter(path => staged.has(path));
  const suggestions = plan.suggested.filter(item => supported.some(path => item.match.test(path)));
  const fromPaths = suggestions.length > 0 || plan.evidence.scopes.some(item => item.files.some(path => staged.has(path)));
  const scopes = plan.evidence.scopes.filter(item => item.files.some(path => staged.has(path) && !suggestions.some(model => model.match.test(path))));
  const targets = checks.flatMap(check => check.kind === "symbol" ? [check.target.file] : [])
    .filter(file => !suggestions.some(item => item.match.test(file)));
  return { scope: [...new Set([...suggestions.map(item => item.glob), ...scopes.map(item => item.glob), ...targets])].slice(0, MAX_SCOPE_FILES), fromPaths };
}

async function verifiedPatterns(plan: AnchorPlan, scope: string[], tree: PinnedTree, staged: ReadonlySet<string>,
  readReview: ReadReviewLines | undefined, cached: Map<string, Promise<ReviewLines | undefined>>, checkOptions: CheckContext & { projectPath: string }): Promise<WhenPattern[]> {
  if (!readReview || !plan.when.length || !plan.area.length) return [];
  const area = patternArea(tree, scope);
  if (!area.length || area.length > MAX_PATTERN_AREA || area.some(path => !staged.has(path))) return [];
  const when: WhenPattern[] = [];
  for (const { source } of plan.citations) {
    if (when.length === plan.when.length) break;
    if (source.kind !== "review" || !source.writer || source.topLevel || !source.path || !area.includes(source.path)) continue;
    const request = cached.get(source.id) ?? readReview(source).catch(() => undefined);
    cached.set(source.id, request);
    const lines = await request;
    const fixed = lines && await tree.read(source.path);
    if (!lines || fixed === undefined) continue;
    const candidates: PatternCandidate[] = plan.when.filter(item => !when.some(kept => isDeepStrictEqual(kept, item)))
      .map(item => ({ ...item, ...lines, fixed }));
    const verdicts = checkPatterns(candidates, scope, checkOptions);
    // An omitted file could make a common pattern look rare.
    when.push(...keptPatterns(candidates, verdicts?.map(verdict => ({
      ...verdict, keep: verdict.keep && verdict.files === area.length,
    })) ?? null));
  }
  return when;
}

/** A teammate's doc or review rule with no code anchor is repo-wide: start brief and recall, like a person's note. */
export function repoWideAllowed(proposal: Proposal): boolean {
  return !anchorRequired(proposal.producer, proposal.kind, proposal.evidenceClass ?? "");
}

/** Stage verified inputs once, then keep the same tree alive for the gate's observations. */
export async function withVerifiedAnchors<T>(drafts: readonly AnchorDraft[], tree: PinnedTree, home: string, jobId: string,
  readReview: ReadReviewLines | undefined,
  run: (results: AnchorResult[], context: CheckContext, unreadRules: readonly string[]) => Promise<T>): Promise<T> {
  if (!drafts.length) return run([], {}, []);
  const lookups = new Map<string, string[]>();
  const plans: AnchorPlan[] = [];
  for (const draft of drafts) plans.push(await planAnchors(draft, tree, lookups));
  const areas = plans.flatMap(plan => plan.area.length <= MAX_PATTERN_AREA ? plan.area : []);
  const symbolFiles = plans.flatMap(plan => plan.symbols.flatMap(symbol => symbol.checks.map(check => check.target.file)));
  return tree.withCheckTree(home, jobId, [...plans.flatMap(plan => plan.files), ...symbolFiles, ...areas], async (checkTree, staged, unreadRules) => {
    const recordDirectory = join(checkTree, ".mex");
    const projectId = "f-" + shortHash(checkTree);
    const checkIndex = { projectId, recordDirectory };
    const checkOptions = { projectPath: checkTree, checkTree, checkIndex };
    const request = { checkout: checkTree, project_id: projectId, record_directory: recordDirectory, mex_home: recordDirectory };
    const needsIndex = plans.some(plan => plan.symbols.length || (readReview && plan.area.length && plan.area.length <= MAX_PATTERN_AREA));
    if (needsIndex) await buildIndex({ root: checkTree, projectId, recordDirectory, workers: 0 });
    const declared = declaredCommands(checkTree);
    const cached = new Map<string, Promise<ReviewLines | undefined>>();
    const results: AnchorResult[] = [];
    for (const plan of plans) {
      const supporting = plan.supplied.filter(check => check.kind !== "symbol" && check.kind !== "command");
      if (supporting.some(check => "file" in check.target && !staged.has(check.target.file!))) {
        results.push("check-target"); continue;
      }
      const declaredSymbols = verified(plan.symbols.flatMap(symbol => symbol.checks.filter(check => staged.has(check.target.file))), request);
      const checks: Array<SymbolCheck | CommandCheck> = [];
      const quotedSymbolFiles: string[] = [];
      for (const { checks: choices, quoted } of plan.symbols) {
        const matches = choices.filter(check => declaredSymbols.includes(check));
        const nearby = matches.filter(check => plan.evidence.quotedPaths.has(check.target.file));
        const found = nearby.length === 1 ? nearby[0] : matches.length === 1 ? matches[0] : undefined;
        if (!found) continue;
        checks.push(found);
        if (quoted) quotedSymbolFiles.push(found.target.file);
      }
      checks.push(...verified(commandChecks(plan, declared), request));
      const { scope, fromPaths } = codeScope(plan, staged, checks, quotedSymbolFiles);
      const anchorKinds: AnchorKind[] = [];
      if (fromPaths) anchorKinds.push("code-scope");
      if (checks.some(check => check.kind === "symbol")) anchorKinds.push("symbol");
      if (checks.some(check => check.kind === "command")) anchorKinds.push("command");
      const when = scope.length ? await verifiedPatterns(plan, scope, tree, staged, readReview, cached, checkOptions) : [];
      if (when.length) anchorKinds.push("when");
      if (!scope.length) {
        // No doc-scope fallback: a scope on the cited doc fires only when that doc is read.
        const commandAnchored = checks.some(check => check.kind === "command") && ["recipe", "procedure"].includes(plan.proposal.kind);
        // A symbol or command the writer named but the pinned tree doesn't declare is a wrong claim, not a repo-wide one.
        const unverified = plan.supplied.some(check => (check.kind === "symbol" || check.kind === "command")
          && !checks.some(kept => kept.kind === check.kind && isDeepStrictEqual(kept.target, check.target)));
        if (!commandAnchored && (unverified || !repoWideAllowed(plan.proposal))) {
          results.push(unverified ? "check-verification" : "no-anchor");
          continue;
        }
        scope.push("**");
        // A command anchors a recipe or procedure at its command moment; anything else here is repo-wide.
        if (!commandAnchored) anchorKinds.push("repo-wide");
      }
      results.push({ ...plan.proposal, anchors: { scope, ...(when.length ? { when } : {}) }, checks: [...supporting, ...checks], anchorKinds });
    }
    return run(results, { checkTree, ...(needsIndex ? { checkIndex } : {}) }, unreadRules);
  });
}
