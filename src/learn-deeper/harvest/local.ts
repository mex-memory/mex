import { isTestFile } from "../../file-index/classify.js";
import { command, PinnedTree } from "../git.js";
import { Reviewers } from "../reviewers.js";
import { sourceDigest, validAt } from "../source.js";
import { docKind, documentCandidates, documentPathKind } from "./documents.js";
import { cleanText, newCandidate, safePath, safeRaw, type Gaps } from "./evidence.js";
import { commitRegions, oid, type RegionReader } from "./regions.js";
import type { Candidate, HarvestOptions, HarvestPlan, HarvestPoint, HarvestSource } from "./types.js";

const MAX_COMMITS = 2000; // The same local history horizon as the code-facts miner.
const MAX_LOG = 16 << 20;
const cause = /\b(?:regression\s+(?:from|in|since)|caused\s+by|broken\s+by)\b/iu;
const revertSubject = /^Revert\s+"(.+)"(?:\s+\(#\d+\))?$/iu;
const revertsCommit = /^\s*This reverts commit ([a-f\d]{7,64})(?:[.,\s]|$)/imu;
// Conventional reverts name what they undo: "revert: <subject>", "revert(scope): <subject>",
// or the PR itself, as in "fix(context): revert PR #4707 (#4757)".
const conventionalRevert = /^revert(?:\([^)]*\))?!?:\s*(.+)$/iu;
const revertsPull = /\brevert(?:s|ed|ing)?\b[:\s]+(?:the\s+)?(?:(?:PR|pull\s+request)\s*)?#([1-9]\d*)\b/iu;

function revertedSubject(subject: string): string | undefined {
  return revertSubject.exec(subject)?.[1] ?? conventionalRevert.exec(subject)?.[1];
}

/** Pull requests a revert in the window undid and nothing re-landed. Their review threads are not what the code holds. */
export function revertedPulls(inventory: Pick<HarvestPlan["inventory"], "revertLinks">): Set<number> {
  return new Set(Object.values(inventory.revertLinks ?? {}).flatMap(link => link.pull !== undefined && !link.reland ? [link.pull] : []));
}
const codeExtension = /\.(?:[cm]?[jt]sx?|pyi?|rs|go|rb|php|java|kt|kts|cs|fs|vb|swift|scala|c|cc|cpp|cxx|h|hh|hpp|m|mm|lua|exs?|erl|hrl|clj[cs]?|cljs|dart|vue|svelte|zig|sol|r|sh|bash|sql|css|scss|less|html|htm|pl|pm|ps1|ml|mli|hs|groovy)$/iu;

interface Commit { id: string; at: string; parent?: string; subject: string; body: string; paths: string[]; }
type LocalSource = keyof HarvestPlan["inventory"]["local"];

async function bodyRevertTarget(root: string, record: Commit): Promise<string | undefined> {
  const target = revertsCommit.exec(record.body)?.[1]?.toLowerCase();
  if (!target || !record.parent) return undefined;
  // Check the branch as it stood before the revert, even when the object is
  // present on a side branch or the original precedes the inventory window.
  const ancestor = await command(root, "git", ["merge-base", "--is-ancestor", target, record.parent]);
  return ancestor === undefined ? undefined : target;
}

export function productionPath(path: string): boolean {
  return safePath(path) && codeExtension.test(path) && !isTestFile(path)
    && !/(?:^|\/)(?:\.[^/]+|docs?|examples?|fixtures?|testdata|mocks?|benchmarks?|vendor|node_modules|config|configs|scripts|build|dist|generated|__generated__)\//iu.test(path)
    && !/(?:^|\/)(?:[^/]+[._-](?:config|conf|test|spec|mock|gen|generated|min)|(?:config|setup|conftest)|test_[^/]+)\.[^/]+$|_(?:test|gen)\.go$|\.pb\.go$/iu.test(path);
}

export function pullNumber(subject: string, body = ""): number | undefined {
  const digits = /\(#([1-9]\d*)\)\s*$/u.exec(subject)?.[1]
    ?? /^Merge pull request #([1-9]\d*)\b/u.exec(subject)?.[1]
    ?? /^Pull-Request: #([1-9]\d*)\s*$/imu.exec(body)?.[1];
  const number = Number(digits);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function subjectKey(text: string): string {
  return text.replace(/\s+\(#\d+\)\s*$/u, "").replace(/^re[ -]?land(?:ing)?\b[\s:!(-]*/iu, "")
    .replace(/^["']|["')]+$/gu, "").trim().toLowerCase();
}

function parseLog(raw: string): Commit[] {
  return raw.split(/\0(?=(?:[a-f0-9]{40}|[a-f0-9]{64})\0\d+\0)/u).flatMap(row => {
    const [id, time, parents, subject, body, firstPath, ...paths] = row.split("\0");
    if (!id || !oid.test(id) || !time || !subject || body === undefined) return [];
    const date = new Date(Number(time) * 1000);
    if (!Number.isFinite(date.getTime())) return [];
    return [{ id, at: date.toISOString(), parent: parents?.split(" ")[0], subject, body,
      paths: [(firstPath ?? "").replace(/^\n/u, ""), ...paths].filter(safePath) }];
  });
}

async function history(options: HarvestOptions, head: string, gaps: Gaps): Promise<Commit[]> {
  const raw = await command(options.checkout, "git", ["log", "--first-parent", "--diff-merges=first-parent",
    "--name-only", "--no-renames", "-z", "--format=%x00%H%x00%ct%x00%P%x00%s%x00%b",
    "--since-as-filter=" + options.since, "--until=" + options.until, "-n", String(MAX_COMMITS + 1), head, "--"], undefined, MAX_LOG, 15_000);
  if (raw === undefined) { gaps.messages.add("Local history could not be read within the work limit."); return []; }
  const records = parseLog(raw);
  if (records.length > MAX_COMMITS) gaps.messages.add(`Local history was limited to the newest ${MAX_COMMITS} commits.`);
  return records.slice(0, MAX_COMMITS).filter(record => validAt(record.at, options.since, options.until));
}

export async function localInventory(options: HarvestOptions, defaultHead: string, tree: PinnedTree, gaps: Gaps):
Promise<Omit<HarvestPlan["inventory"], "bands">> {
  const commits = await history(options, defaultHead, gaps);
  const headHistory = tree.head === defaultHead ? commits : await history(options, tree.head, gaps);
  const local: Record<LocalSource, HarvestPoint[]> = { revert: [], cause: [], adr: [], doc: [] };
  const revertLinks: HarvestPlan["inventory"]["revertLinks"] = {};
  const bySubject = new Map<string, string>();
  const byPull = new Map<number, string>();
  const subjectsById = new Map(commits.map(commit => [commit.id, commit.subject]));
  const commitsById = new Map(commits.map(commit => [commit.id, commit]));
  const paths = new Map<string, { count: number; at: string }>();
  for (const commit of [...commits].reverse()) {
    const subject = revertedSubject(commit.subject);
    const named = Number(revertsPull.exec(commit.subject)?.[1] ?? NaN);
    const target = await bodyRevertTarget(options.checkout, commit);
    if (subject || target || Number.isSafeInteger(named)) {
      local.revert.push({ id: commit.id, at: commit.at });
      const original = target ?? (subject && bySubject.get(subjectKey(subject))) ?? (Number.isSafeInteger(named) ? byPull.get(named) : undefined);
      const found = original ? commitsById.get(original) : undefined;
      const pull = found ? pullNumber(found.subject, found.body) : Number.isSafeInteger(named) ? named : undefined;
      revertLinks[commit.id] = { original: original || undefined, ...(pull !== undefined ? { pull } : {}) };
    } else {
      rememberSubject(commit, bySubject);
      const pull = pullNumber(commit.subject, commit.body);
      if (pull !== undefined) byPull.set(pull, commit.id);
      if (cause.test(commit.subject + "\n" + commit.body) && commit.paths.some(productionPath)) {
        local.cause.push({ id: commit.id, at: commit.at });
      }
    }
  }
  bySubject.clear();
  for (const commit of commits) {
    const link = revertLinks[commit.id];
    if (link) {
      const original = link.original;
      const subject = revertedSubject(commit.subject)
        ?? (original ? subjectsById.get(original) : undefined);
      const reland = subject && bySubject.get(subjectKey(subject));
      if (reland) link.reland = reland;
    } else rememberSubject(commit, bySubject);
  }
  for (const commit of headHistory) for (const path of new Set(commit.paths)) {
    const seen = paths.get(path);
    if (!seen) paths.set(path, { count: 1, at: commit.at });
    else seen.count++;
  }
  const checkHeadings: HarvestPoint[] = [];
  for (const [path, meta] of paths) {
    const kind = tree.has(path) && documentPathKind(path);
    const point = { id: path, at: meta.at };
    if (kind === "heading") checkHeadings.push(point);
    else if (kind) local[kind].push(point);
  }
  // Only ambiguous paths need a blob read. Bound the number of Git processes in flight.
  for (let offset = 0; offset < checkHeadings.length; offset += 8) {
    const batch = checkHeadings.slice(offset, offset + 8);
    const kinds = await Promise.all(batch.map(async ({ id }) => docKind(id, await tree.read(id))));
    for (const [i, kind] of kinds.entries()) if (kind) local[kind].push(batch[i]!);
  }
  const hotPaths = [...paths].filter(([path, meta]) => meta.count >= 2 && productionPath(path) && tree.has(path))
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], "en")).slice(0, 128).map(([path]) => path);
  return { local, hotPaths, revertLinks };
}

function rememberSubject(commit: Commit, subjects: Map<string, string>): void {
  const key = subjectKey(commit.subject);
  if (key) subjects.set(key, commit.id);
  if (/^Merge pull request #\d+\b/u.test(commit.subject)) {
    const mergedSubject = commit.body.trim().split("\n")[0];
    if (mergedSubject) subjects.set(subjectKey(mergedSubject), commit.id);
  }
}

async function commitAt(root: string, revision: string): Promise<Commit | undefined> {
  if (!/^[a-f0-9]{7,64}$/u.test(revision)) return undefined;
  const data = await command(root, "git", ["show", "-s", "--format=%x00%H%x00%ct%x00%P%x00%s%x00%b%x00", revision, "--"], undefined, 256 << 10);
  return parseLog(data ?? "")[0];
}

async function changedPaths(root: string, commit: Commit): Promise<string[]> {
  if (!commit.parent) return [];
  const data = await command(root, "git", ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", commit.parent, commit.id, "--"],
    undefined, 256 << 10);
  return (data ?? "").split("\0").filter(productionPath);
}

export interface RevertEvidence { record: Commit; original?: Commit; reland?: Commit; reason: string; pulls: number[]; reasonPulls: number[]; }

export async function readRevert(plan: HarvestPlan, point: HarvestPoint): Promise<RevertEvidence | undefined> {
  const record = await commitAt(plan.checkout, point.id);
  if (!record) return undefined;
  const subject = revertedSubject(record.subject);
  const target = await bodyRevertTarget(plan.checkout, record);
  const link = plan.inventory.revertLinks[point.id];
  if (!subject && !target && !link?.original) return undefined;
  const mentioned = revertsCommit.exec(record.body)?.[1]?.toLowerCase();
  const originalId = target ?? (link?.original !== mentioned ? link?.original : undefined);
  const original = originalId ? await commitAt(plan.checkout, originalId) : undefined;
  const attempted = original ? pullNumber(original.subject, original.body) : pullNumber(subject ?? "");
  const revertPull = pullNumber(record.subject, record.body);
  const relandId = link?.reland;
  const reland = relandId ? await commitAt(plan.checkout, relandId) : undefined;
  const relandPull = reland && pullNumber(reland.subject, reland.body);
  const reasonPulls = [...new Set([revertPull, attempted].filter((pull): pull is number => pull !== undefined))];
  const pulls = relandPull && !reasonPulls.includes(relandPull) ? [...reasonPulls, relandPull] : reasonPulls;
  const reason = record.body.replace(/^\s*This reverts commit [a-f\d]{7,64}(?:, reversing\r?\nchanges made to [a-f\d]{7,64})?[^\n]*(?:\n|$)/gimu, "").trim();
  return { record, original, reland, reason, pulls, reasonPulls };
}

export async function localCandidates(plan: HarvestPlan, source: HarvestSource, point: HarvestPoint, tree: PinnedTree,
  reader: RegionReader, gaps: Gaps, reviewers: Reviewers, revert?: RevertEvidence, discussion?: {
    raw: string; reviewers: string[]; nodeIds: string[]; commentHashes: Record<string, string>;
  }): Promise<Candidate[]> {
  if (source === "adr" || source === "doc") {
    const body = await tree.read(point.id);
    if (body === undefined) { gaps.messages.add("Some contributor documents were missing or exceeded the read limit."); return []; }
    return documentCandidates(point, source, body, reviewers, gaps);
  }
  if (source === "cause") {
    const record = await commitAt(plan.checkout, point.id);
    if (!record?.parent) return [];
    const raw = record.subject + (record.body.trim() ? "\n\n" + record.body.trim() : "");
    const text = cleanText(raw, gaps, reviewers);
    if (!text) return [];
    const paths = await changedPaths(plan.checkout, record);
    if (!paths.length) return [];
    for (const path of paths.slice(0, 2)) {
      const code = await commitRegions(reader, path, record.parent, record.id, gaps);
      if (!code.before && !code.after) continue;
      return [newCandidate({ id: `git:cause:${point.id}`, kind: "cause-commit", link: `https://github.com/${plan.source.slug}/commit/${point.id}`,
        hash: sourceDigest(raw), at: point.at, path, text, nodeIds: [], reviewers: [], code, changedPaths: paths.slice(0, 12) })];
    }
    gaps.messages.add("Some cause-naming commits had no readable production code region.");
    return [newCandidate({ id: `git:cause:${point.id}`, kind: "cause-commit", link: `https://github.com/${plan.source.slug}/commit/${point.id}`,
      hash: sourceDigest(raw), at: point.at, text, nodeIds: [], reviewers: [], changedPaths: paths.slice(0, 12) })];
  }
  if (source !== "revert" || !revert) return [];
  const { record, original, reland, reason, pulls } = revert;
  if (safeRaw(record.subject + "\n" + record.body) === undefined) { gaps.withheld(false); return []; }
  const raw = reason || discussion?.raw || record.subject;
  const text = cleanText(raw, gaps, reviewers);
  if (!text) return [];
  if (!reason && !discussion) gaps.messages.add("Some reverts had no recorded reason.");
  const paths = await changedPaths(plan.checkout, record);
  const path = paths[0];
  const code = path && record.parent ? await commitRegions(reader, path, record.parent, record.id, gaps) : undefined;
  const related: NonNullable<Candidate["related"]> = { pulls, commits: [original?.id, reland?.id].filter((id): id is string => !!id) };
  if (original && reland) {
    const originalPaths = new Set(await changedPaths(plan.checkout, original));
    const shared = (await changedPaths(plan.checkout, reland)).filter(path => originalPaths.has(path));
    for (const path of shared.slice(0, 2)) {
      const { before, after } = await commitRegions(reader, path, original.id, reland.id, gaps);
      if (before && after) { related.reland = { before, after }; break; }
    }
    if (!related.reland) gaps.messages.add("Some re-lands had no readable contrast on a common path.");
  }
  return [newCandidate({ id: `git:revert:${point.id}`, kind: "revert", link: `https://github.com/${plan.source.slug}/commit/${point.id}`, at: point.at,
    hash: sourceDigest(raw), text, related, path, code: code?.before || code?.after ? code : undefined, changedPaths: paths.slice(0, 12),
    ...(!reason && discussion
      ? { nodeIds: discussion.nodeIds, reviewers: discussion.reviewers, commentHashes: discussion.commentHashes }
      : { nodeIds: [], reviewers: [] }) })];
}
